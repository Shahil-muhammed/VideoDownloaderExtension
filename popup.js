import { DEFAULT_SETTINGS, formatBytes, formatDuration, isBlocked } from './lib/util.js';
import { probe } from './lib/streams.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let settings = { ...DEFAULT_SETTINGS };
let tabId = null, tabUrl = '';
let jobs = {}, library = [];
const probes = new Map(); // itemId -> Promise<probe result>

// ---------- helpers ----------
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const sendMsg = (msg) => chrome.runtime.sendMessage(msg);

function applyTheme() {
  if (settings.theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', settings.theme);
}

function formatClock(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// ---------- tabs ----------
const TABS = ['media', 'jobs', 'library'];
function selectTab(name) {
  for (const t of TABS) {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
    $(`panel-${t}`).hidden = t !== name;
  }
}
for (const t of TABS) $(`tab-${t}`).addEventListener('click', () => selectTab(t));
document.querySelector('.tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const cur = TABS.findIndex((t) => $(`tab-${t}`).getAttribute('aria-selected') === 'true');
  const next = TABS[(cur + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
  selectTab(next); $(`tab-${next}`).focus();
});
$('openSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());

// ---------- media panel ----------
async function fetchTextWithPage(pageUrl) {
  return async (url) => {
    const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  };
}

function probeItem(item) {
  if (!probes.has(item.id)) {
    probes.set(item.id, (async () => {
      const { ruleId } = await sendMsg({ type: 'pageHeaders', pageUrl: item.pageUrl }).catch(() => ({}));
      try { return await probe(item, await fetchTextWithPage(item.pageUrl)); }
      finally { if (ruleId) sendMsg({ type: 'dropHeaders', ruleId }); }
    })());
  }
  return probes.get(item.id);
}

const FORMATS = [
  ['mp4', 'MP4'], ['mkv', 'MKV'], ['mp3', 'MP3 audio'], ['m4a', 'M4A audio'], ['original', 'As is'],
];

function renderMedia(items) {
  const list = $('mediaList');
  const blocked = isBlocked(tabUrl, settings.blocklist);
  const visible = items.filter((i) => !i.hidden);
  $('mediaCount').textContent = visible.length || '';
  $('mediaBlocked').hidden = !blocked || visible.length > 0;
  $('mediaEmpty').hidden = blocked || visible.length > 0;
  // Keep existing rows (their quality dropdowns) and only add new ones.
  const existing = new Set([...list.children].map((li) => li.dataset.id));
  const wanted = new Set(visible.map((i) => i.id));
  for (const li of [...list.children]) if (!wanted.has(li.dataset.id)) li.remove();
  for (const item of [...visible].reverse()) if (!existing.has(item.id)) list.append(mediaRow(item));
}

function mediaRow(item) {
  const kindLabel = item.kind === 'file' ? (item.mediaType === 'audio' ? 'Audio' : 'File') : item.kind.toUpperCase();
  const meta = el('div', { class: 'meta' },
    el('span', { class: 'tag', text: kindLabel }),
    item.size && item.kind === 'file' ? el('span', { text: formatBytes(item.size) }) : null,
  );
  const quality = el('select', { 'aria-label': 'Quality', disabled: true }, el('option', { text: 'Loading…' }));
  const format = el('select', { 'aria-label': 'Format' }, FORMATS.map(([v, l]) => el('option', { value: v, text: l, selected: v === settings.defaultFormat })));
  const go = el('button', { class: 'btn', text: 'Download', disabled: true });
  const msg = el('div', { class: 'msg', hidden: true });
  const li = el('li', { class: 'card', 'data-id': item.id },
    el('div', { class: 'title', title: item.title, text: item.title }), meta,
    el('div', { class: 'controls' }, quality, format, go), msg);

  const showMsg = (text, isError) => { msg.hidden = !text; msg.textContent = text || ''; msg.classList.toggle('error', !!isError); };

  probeItem(item).then((p) => {
    quality.replaceChildren(...p.qualities.map((q) => el('option', { value: q.id, text: q.label })));
    quality.disabled = p.qualities.length < 2;
    if (p.duration) meta.append(el('span', { text: formatDuration(p.duration) }));
    if (p.live) { meta.prepend(el('span', { class: 'tag live', text: 'Live' })); go.textContent = 'Record'; go.classList.add('live'); }
    if (p.protected) {
      meta.append(el('span', { class: 'tag warn', text: 'Protected' }));
      showMsg('This stream uses DRM protection, so it can’t be saved.', true);
      return;
    }
    if (p.note) showMsg(p.note);
    go.disabled = false;
  }).catch((e) => {
    quality.replaceChildren(el('option', { text: 'Unavailable' }));
    showMsg(`Couldn’t read this stream (${e.message}). Play the video and reopen this window.`, true);
    go.disabled = item.kind !== 'file';
    if (item.kind === 'file') go.disabled = false;
  });

  go.addEventListener('click', async () => {
    go.disabled = true;
    const qOpt = quality.selectedOptions[0];
    const res = await sendMsg({ type: 'start', tabId, itemId: item.id, qualityId: quality.value, qualityLabel: qOpt ? qOpt.textContent : '', format: format.value })
      .catch((e) => ({ ok: false, error: e.message }));
    go.disabled = false;
    if (!res.ok) { showMsg(res.error, true); return; }
    showMsg(go.classList.contains('live') ? 'Recording started. Stop it from the Downloads tab.' : 'Started. Follow it in the Downloads tab.');
    selectTab('jobs');
  });
  return li;
}

// ---------- jobs panel ----------
function jobRemaining(j) {
  if (j.eta == null || !j.etaAt) return null;
  return Math.max(0, j.eta - (Date.now() - j.etaAt) / 1000);
}

function renderJobs() {
  const list = Object.values(jobs).sort((a, b) => b.createdAt - a.createdAt);
  const active = list.filter((j) => ['queued', 'running', 'saving'].includes(j.status));
  $('jobsCount').textContent = active.length || '';
  $('jobsEmpty').hidden = list.length > 0;
  $('clearJobs').hidden = !list.some((j) => ['done', 'failed', 'cancelled'].includes(j.status));
  $('jobList').replaceChildren(...list.map(jobRow));
}

function jobRow(j) {
  const recording = j.recording && j.status === 'running';
  const finished = ['done', 'failed', 'cancelled'].includes(j.status);
  const pct = Math.round((j.progress || 0) * 100);
  const bar = el('div', { class: 'progress' + (recording || (j.status === 'running' && !j.progress) ? ' indeterminate' : '') + (j.status === 'failed' ? ' failed' : ''),
    role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': recording ? undefined : pct });
  const fill = el('span'); bar.append(fill);
  if (!recording) fill.style.width = `${j.status === 'done' ? 100 : pct}%`;

  let right = '';
  if (recording) {
    const since = j.recordStartedAt ? (Date.now() - j.recordStartedAt) / 1000 : (j.recorded || 0);
    right = `${formatClock(since)} recorded · ${formatBytes(j.bytes)}`;
  } else if (j.status === 'running' || j.status === 'queued') {
    const rem = jobRemaining(j);
    const parts = [];
    if (rem != null) parts.push(`${formatClock(rem)} left`);
    if (j.speed) parts.push(`${formatBytes(j.speed)}/s`);
    if (j.bytes) parts.push(formatBytes(j.bytes));
    right = parts.join(' · ') || (pct ? `${pct}%` : '');
  } else if (j.status === 'done') right = formatBytes(j.bytes);

  const phase = el('span', { class: 'phase' }, recording ? el('span', { class: 'rec-dot', 'aria-hidden': 'true' }) : null,
    j.status === 'failed' ? 'Failed' : j.status === 'cancelled' ? 'Cancelled' : (j.phase || j.status));

  const actions = el('div', { class: 'row-actions' });
  if (recording) actions.append(el('button', { class: 'btn live sm', text: 'Stop & save', onclick: () => sendMsg({ type: 'stop', jobId: j.id }) }));
  if (!finished) actions.append(el('button', { class: 'btn secondary sm', text: 'Cancel', onclick: () => sendMsg({ type: 'cancel', jobId: j.id }) }));
  if (j.status === 'done' && j.downloadId != null) {
    actions.append(
      el('button', { class: 'btn sm', text: 'Open', onclick: () => sendMsg({ type: 'open', downloadId: j.downloadId }) }),
      el('button', { class: 'btn secondary sm', text: 'Show in folder', onclick: () => sendMsg({ type: 'show', downloadId: j.downloadId }) }),
    );
  }
  const fmt = (j.format || '').toUpperCase();
  return el('li', { class: 'card', 'data-job': j.id },
    el('div', { class: 'title', title: j.item?.title, text: j.item?.title || 'Video' }),
    el('div', { class: 'meta' }, el('span', { class: 'tag', text: fmt }), j.qualityLabel ? el('span', { text: j.qualityLabel.split(' · ')[0] }) : null,
      j.status === 'done' ? el('span', { class: 'tag ok', text: 'Saved' }) : null),
    j.status === 'done' ? null : bar,
    el('div', { class: 'status-line' }, phase, el('span', { class: 'eta', text: right })),
    j.error ? el('div', { class: 'msg error', text: j.error }) : null,
    j.note ? el('div', { class: 'msg', text: j.note }) : null,
    actions.childElementCount ? actions : null,
  );
}

// Tick countdowns every second without waiting for the next progress update.
setInterval(() => {
  for (const li of $('jobList').children) {
    const j = jobs[li.dataset.job];
    if (!j) continue;
    const etaEl = li.querySelector('.eta');
    if (j.recording && j.status === 'running') {
      const since = j.recordStartedAt ? (Date.now() - j.recordStartedAt) / 1000 : (j.recorded || 0);
      etaEl.textContent = `${formatClock(since)} recorded · ${formatBytes(j.bytes)}`;
    } else if (j.status === 'running' && jobRemaining(j) != null) {
      const parts = [`${formatClock(jobRemaining(j))} left`];
      if (j.speed) parts.push(`${formatBytes(j.speed)}/s`);
      if (j.bytes) parts.push(formatBytes(j.bytes));
      etaEl.textContent = parts.join(' · ');
    }
  }
}, 1000);

$('clearJobs').addEventListener('click', () => sendMsg({ type: 'clearJobs' }));

// ---------- library panel ----------
function renderLibrary() {
  const q = $('librarySearch').value.trim().toLowerCase();
  const items = library.filter((x) => !q || (x.title || '').toLowerCase().includes(q) || (x.filename || '').toLowerCase().includes(q));
  $('libraryEmpty').hidden = library.length > 0;
  $('clearLibrary').hidden = library.length === 0;
  $('libraryList').replaceChildren(...items.map((x) => el('li', { class: 'card' },
    el('div', { class: 'title', title: x.filename, text: x.title }),
    el('div', { class: 'meta' },
      el('span', { class: 'tag', text: (x.format || '').toUpperCase() }),
      x.live ? el('span', { class: 'tag live', text: 'Recorded' }) : null,
      x.size ? el('span', { text: formatBytes(x.size) }) : null,
      el('span', { text: new Date(x.savedAt).toLocaleString() })),
    el('div', { class: 'row-actions' },
      el('button', { class: 'btn sm', text: 'Open', onclick: () => openSaved(x, 'open') }),
      el('button', { class: 'btn secondary sm', text: 'Show in folder', onclick: () => openSaved(x, 'show') }),
      x.pageUrl ? el('button', { class: 'btn ghost sm', text: 'Source page', onclick: () => chrome.tabs.create({ url: x.pageUrl }) }) : null,
      el('button', { class: 'btn ghost sm danger-text', text: 'Remove', 'aria-label': `Remove ${x.title} from library`, onclick: () => sendMsg({ type: 'removeLibrary', id: x.id }) }),
    ))));
}
async function openSaved(x, how) {
  const r = await sendMsg({ type: 'exists', downloadId: x.downloadId }).catch(() => ({}));
  if (!r.exists) { alert('That file was moved or deleted.'); return; }
  sendMsg({ type: how, downloadId: x.downloadId });
}
$('librarySearch').addEventListener('input', renderLibrary);
$('clearLibrary').addEventListener('click', () => { if (confirm('Remove every entry from the library? Your files stay on disk.')) sendMsg({ type: 'removeLibrary', all: true }); });

// ---------- site access + in-page detector ----------
// http/https only: '<all_urls>' also covers file:// URLs, which browsers keep switched off
// separately, so checking it reports "no access" even when every website is allowed.
const ALL_SITES = { origins: ['http://*/*', 'https://*/*'] };
async function checkSiteAccess() {
  // Firefox lets people withhold site access; without it nothing can be detected.
  const ok = await chrome.permissions.contains(ALL_SITES).catch(() => true);
  $('accessBanner').hidden = ok;
}
$('grantAccess').addEventListener('click', async () => {
  const granted = await chrome.permissions.request(ALL_SITES).catch(() => false);
  if (granted) { $('accessBanner').hidden = true; if (tabId >= 0) chrome.tabs.reload(tabId); }
});

/** Make sure the in-page detector runs in this tab (pages opened before install don't have it), then rescan. */
async function wakeDetector(id) {
  if (id == null || id < 0 || !/^https?:/i.test(tabUrl)) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, files: ['content-main.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, files: ['content-bridge.js'] });
  } catch { /* restricted page (store, settings) */ }
  chrome.tabs.sendMessage(id, { type: 'rescan' }).catch(() => {});
}

// ---------- boot ----------
async function init() {
  const s = await chrome.storage.local.get(['settings', 'library']);
  settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
  library = s.library || [];
  applyTheme();

  if (params.get('tabId')) {
    tabId = Number(params.get('tabId'));
    try { tabUrl = (await chrome.tabs.get(tabId)).url || ''; } catch {}
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id ?? -1; tabUrl = tab?.url || '';
  }
  checkSiteAccess();
  wakeDetector(tabId);
  const key = `media:${tabId}`;
  const sess = await chrome.storage.session.get([key, 'jobs']);
  jobs = sess.jobs || {};
  renderMedia(sess[key] || []);
  renderJobs();
  renderLibrary();
  if (params.get('panel')) selectTab(params.get('panel'));
  else if (!(sess[key] || []).length && Object.values(jobs).some((j) => ['queued', 'running', 'saving'].includes(j.status))) selectTab('jobs');

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session') {
      if (changes[key]) renderMedia(changes[key].newValue || []);
      if (changes.jobs) { jobs = changes.jobs.newValue || {}; renderJobs(); }
    } else if (area === 'local') {
      if (changes.library) { library = changes.library.newValue || []; renderLibrary(); }
      if (changes.settings) { settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) }; applyTheme(); }
    }
  });
}
init();
