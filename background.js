// Reelkeep service worker: detection, badge, jobs, downloads, library.

import {
  DEFAULT_SETTINGS, classify, sizeFromHeaders, headerValue, mediaKey, isExcludedHost, isBlocked,
  sanitizeFilename, joinDownloadPath, uid, hostOf,
} from './lib/util.js';
import { isMasterPlaylist, parseMaster, parseMedia } from './lib/hls.js';

// ---------- settings ----------
let settings = { ...DEFAULT_SETTINGS };
const settingsReady = chrome.storage.local.get('settings').then((r) => { settings = { ...DEFAULT_SETTINGS, ...(r.settings || {}) }; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    refreshAllBadges();
  }
});

// ---------- serialised state updates ----------
let queue = Promise.resolve();
function serial(fn) {
  const p = queue.then(fn);
  queue = p.catch((e) => console.warn('[reelkeep]', e));
  return p;
}

const mediaKeyFor = (tabId) => `media:${tabId}`;
async function getTabMedia(tabId) {
  const k = mediaKeyFor(tabId);
  return (await chrome.storage.session.get(k))[k] || [];
}
async function setTabMedia(tabId, items) {
  await chrome.storage.session.set({ [mediaKeyFor(tabId)]: items });
  updateBadge(tabId, items);
}

async function getJobs() { return (await chrome.storage.session.get('jobs')).jobs || {}; }
async function patchJob(jobId, patch) {
  return serial(async () => {
    const jobs = await getJobs();
    if (!jobs[jobId]) return null;
    jobs[jobId] = { ...jobs[jobId], ...patch, updatedAt: Date.now() };
    await chrome.storage.session.set({ jobs });
    return jobs[jobId];
  });
}

// ---------- badge ----------
function updateBadge(tabId, items) {
  const n = items.filter((i) => !i.hidden).length;
  const text = n ? (settings.badgeStyle === 'dot' ? '●' : String(n > 99 ? '99+' : n)) : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#0f9d77' }).catch(() => {});
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' }).catch(() => {});
}
async function refreshAllBadges() {
  const all = await chrome.storage.session.get(null);
  for (const [k, v] of Object.entries(all)) if (k.startsWith('media:')) updateBadge(Number(k.slice(6)), v);
}

// ---------- detection ----------
const EXT_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
const MANIFEST_TYPES = new Set(['hls', 'dash']);

chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId >= 0 && d.type === 'main_frame') serial(() => setTabMedia(d.tabId, []));
}, { urls: ['<all_urls>'], types: ['main_frame'] });

chrome.tabs.onRemoved.addListener((tabId) => {
  serial(() => chrome.storage.session.remove(mediaKeyFor(tabId)));
});

chrome.webRequest.onHeadersReceived.addListener(
  (d) => { onResponse(d).catch((e) => console.warn('[reelkeep]', e)); },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'main_frame', 'sub_frame'] },
  ['responseHeaders'],
);


/** Requests made by a page's service worker carry tabId -1. Attribute them to the tab that owns that origin. */
async function tabForInitiator(initiator) {
  if (!initiator || initiator.startsWith(EXT_ORIGIN) || !/^https?:/.test(initiator)) return null;
  const tabs = await chrome.tabs.query({});
  const same = tabs.filter((t) => { try { return new URL(t.url).origin === initiator; } catch { return false; } });
  return same.find((t) => t.active) || same[0] || null;
}

async function onResponse(d) {
  if (d.statusCode >= 400 || d.method !== 'GET') return;
  if (!/^https?:/i.test(d.url) || isExcludedHost(d.url)) return;
  const ct = headerValue(d.responseHeaders, 'content-type');
  const c = classify(d.url, ct, d.type);
  if (!c) return;
  let tab = null;
  if (d.tabId >= 0) { try { tab = await chrome.tabs.get(d.tabId); } catch { return; } }
  else tab = await tabForInitiator(d.initiator || d.originUrl || d.documentUrl);
  if (!tab || (tab.url || '').startsWith(EXT_ORIGIN) || (d.originUrl || '').startsWith(EXT_ORIGIN)) return;
  await addMedia(tab, { url: d.url, ct, c, size: sizeFromHeaders(d.responseHeaders), pageUrl: tab.url || d.initiator || '' });
}

/** Shared by network detection and the in-page detector. */
async function addMedia(tab, { url, ct = '', c, size = 0, pageUrl }) {
  await settingsReady;
  pageUrl = tab.url || pageUrl || '';
  if (isExcludedHost(url) || isExcludedHost(pageUrl) || isBlocked(pageUrl, settings.blocklist)) return;
  const key = mediaKey(url);
  if ((await getTabMedia(tab.id)).some((i) => i.key === key)) return; // cheap early exit before any fetch

  // Extra info for manifests: master vs media, children, DRM. Best effort, never blocks for long.
  let info = {};
  if (c.kind === 'hls') info = await inspectHls(url, pageUrl);

  await serial(async () => {
    const items = await getTabMedia(tab.id);
    if (items.some((i) => i.key === key)) return;
    if (c.kind === 'file') {
      const hasManifest = items.some((i) => MANIFEST_TYPES.has(i.kind));
      if (!c.fromPlayer) {
        // XHR-fetched media is usually a stream segment; only keep big files on pages without a manifest.
        if (hasManifest || c.mediaType !== 'video' || size < 5 * 1024 * 1024) return;
      }
      if (size && size < settings.minSizeKB * 1024) return;
    }
    if (c.kind === 'hls') {
      // A media playlist that belongs to a master we already have is not a separate video.
      if (items.some((i) => i.children && i.children.includes(key))) return;
    }
    const item = {
      id: uid(), key, kind: c.kind, mediaType: c.mediaType || 'video', url,
      title: tab.title || hostOf(pageUrl), pageUrl, size, contentType: ct, detectedAt: Date.now(),
      ...info,
    };
    let next = items;
    if (item.children) next = items.filter((i) => !item.children.includes(i.key));
    if (MANIFEST_TYPES.has(item.kind)) {
      // Drop XHR-only "files" seen before the manifest arrived; they were segments.
      next = next.filter((i) => !(i.kind === 'file' && i.viaXhr));
    }
    if (c.kind === 'file' && !c.fromPlayer) item.viaXhr = true;
    await setTabMedia(tab.id, [...next, item]);
  });
}

async function inspectHls(url, pageUrl) {
  try {
    const text = await withPageHeaders(pageUrl, () => fetchText(url));
    if (isMasterPlaylist(text)) {
      const m = parseMaster(text, url);
      const children = [...m.variants.map((v) => mediaKey(v.url)), ...Object.values(m.audio).flat().filter((a) => a.url).map((a) => mediaKey(a.url))];
      const top = m.variants[0];
      return { children, protected: m.protected, quality: top && top.height ? `${top.height}p` : '' };
    }
    const media = parseMedia(text, url);
    return { protected: media.protected, live: media.live, duration: media.duration };
  } catch {
    return {};
  }
}

async function fetchText(url) {
  const r = await fetch(url, { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// ---------- browser differences ----------
// Chrome: service worker + offscreen document + declarativeNetRequest.
// Firefox: event page + a pinned "Reelkeep downloads" tab as the runner + blocking webRequest.
const IS_FIREFOX = typeof chrome.offscreen === 'undefined';
const RUNNER_URL = chrome.runtime.getURL('offscreen.html');

// ---------- Referer/Origin for our own requests ----------
// Many CDNs only serve media to requests that look like they come from the page.
let ruleSeq = 0;
const ffReferers = new Map(); // Firefox: id -> pageUrl (newest wins)
async function addHeaderRule(pageUrl) {
  if (!/^https?:/i.test(pageUrl || '')) return null;
  const { ruleSeq: stored = 0 } = await chrome.storage.session.get('ruleSeq');
  ruleSeq = Math.max(ruleSeq, stored) + 1;
  await chrome.storage.session.set({ ruleSeq });
  const id = 1000 + (ruleSeq % 100000);
  if (IS_FIREFOX) { ffReferers.delete(id); ffReferers.set(id, pageUrl); saveReferers(); return id; }
  const origin = new URL(pageUrl).origin;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [{
      id, priority: ruleSeq,
      action: { type: 'modifyHeaders', requestHeaders: [
        { header: 'referer', operation: 'set', value: pageUrl },
        { header: 'origin', operation: 'set', value: origin },
      ] },
      condition: { initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest', 'media', 'other'] },
    }],
  });
  return id;
}
async function removeHeaderRule(id) {
  if (!id) return;
  if (IS_FIREFOX) { ffReferers.delete(id); saveReferers(); return; }
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
}
async function withPageHeaders(pageUrl, fn) {
  const id = await addHeaderRule(pageUrl).catch(() => null);
  try { return await fn(); } finally { await removeHeaderRule(id); }
}
// The Firefox event page can be unloaded between messages; keep the referer list in session storage.
function saveReferers() { chrome.storage.session.set({ ffReferers: [...ffReferers] }).catch(() => {}); }
if (IS_FIREFOX) chrome.storage.session.get('ffReferers').then((r) => { for (const [k, v] of r.ffReferers || []) if (!ffReferers.has(k)) ffReferers.set(k, v); });
if (IS_FIREFOX) {
  chrome.webRequest.onBeforeSendHeaders.addListener((d) => {
    const from = d.originUrl || d.documentUrl || '';
    if (!from.startsWith(EXT_ORIGIN) || !ffReferers.size) return {};
    const pageUrl = [...ffReferers.values()].pop();
    const headers = (d.requestHeaders || []).filter((h) => !/^(referer|origin)$/i.test(h.name));
    headers.push({ name: 'Referer', value: pageUrl });
    if (d.type === 'xmlhttprequest') headers.push({ name: 'Origin', value: new URL(pageUrl).origin });
    return { requestHeaders: headers };
  }, { urls: ['<all_urls>'] }, ['blocking', 'requestHeaders']);
}

// ---------- job runner host ----------
let creatingRunner = null;
async function runnerTabs() {
  return (await chrome.tabs.query({})).filter((t) => (t.url || t.pendingUrl || '').startsWith(RUNNER_URL));
}
async function ensureRunner() {
  if (creatingRunner) return creatingRunner;
  creatingRunner = (async () => {
    if (IS_FIREFOX) {
      if ((await runnerTabs()).length) return;
      await chrome.tabs.create({ url: RUNNER_URL, active: false, pinned: true });
    } else {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (ctx.length) return;
      await chrome.offscreen.createDocument({
        url: 'offscreen.html', reasons: ['WORKERS', 'BLOBS'],
        justification: 'Download stream segments and merge them into one file with ffmpeg.wasm',
      });
    }
  })().finally(() => { creatingRunner = null; });
  return creatingRunner;
}
// Close the runner (and free its memory) only after it has been idle for a while,
// so a job started right after another finishes never races a closing document.
let idleTimer = null;
function closeOffscreenIfIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const jobs = await getJobs();
    const busy = Object.values(jobs).some((j) => ['queued', 'running', 'saving'].includes(j.status));
    if (busy || creatingRunner) return;
    if (IS_FIREFOX) {
      for (const t of await runnerTabs()) await chrome.tabs.remove(t.id).catch(() => {});
    } else {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (ctx.length) await chrome.offscreen.closeDocument().catch(() => {});
    }
  }, IS_FIREFOX ? 20 * 1000 : 90 * 1000);
}
/** Hand a job to the runner; keep trying while it loads. */
async function runInOffscreen(job) {
  clearTimeout(idleTimer);
  for (let attempt = 0; attempt < 40; attempt++) {
    await ensureRunner();
    const r = await chrome.runtime.sendMessage({ type: 'run', job, target: 'offscreen' }).catch(() => null);
    if (r && r.accepted) return;
    await new Promise((res) => setTimeout(res, 250));
  }
  await failJob(job.id, 'The download engine did not start. Try again.');
}
function toOffscreen(msg) {
  return chrome.runtime.sendMessage({ ...msg, target: 'offscreen' }).catch(() => {});
}
// Firefox: if the user closes the downloads tab, the jobs in it stop.
if (IS_FIREFOX) {
  chrome.tabs.onRemoved.addListener(async () => {
    if ((await runnerTabs()).length) return;
    const jobs = await getJobs();
    for (const j of Object.values(jobs)) {
      if (j.status === 'running' || j.status === 'queued') await failJob(j.id, 'The Reelkeep downloads tab was closed. Start the download again and keep that tab open.');
    }
  });
}

// ---------- jobs ----------
function extFromUrl(url, fallback) {
  try { const m = new URL(url).pathname.match(/\.([a-z0-9]{2,4})$/i); return m ? m[1].toLowerCase() : fallback; } catch { return fallback; }
}

async function startJob({ tabId, itemId, qualityId, qualityLabel, format }) {
  await settingsReady;
  const items = await getTabMedia(tabId);
  const item = items.find((i) => i.id === itemId);
  if (!item) throw new Error('That video is no longer on this tab. Reload the page.');
  if (item.protected) throw new Error('This stream is DRM-protected and cannot be saved.');
  const fmt = format || settings.defaultFormat;
  const quality = qualityLabel && !/^(Original|Source|Audio file)$/.test(qualityLabel) ? ` (${qualityLabel.split(' · ')[0]})` : '';
  const base = sanitizeFilename(item.title) + (fmt === 'mp3' || fmt === 'm4a' ? '' : quality);
  const job = {
    id: uid(), item, qualityId, qualityLabel: qualityLabel || '', format: fmt, baseName: base,
    status: 'queued', phase: 'Starting', progress: 0, bytes: 0, createdAt: Date.now(), updatedAt: Date.now(),
    record: false,
  };
  job.ruleId = await addHeaderRule(item.pageUrl).catch(() => null);
  await serial(async () => { const jobs = await getJobs(); jobs[job.id] = job; await chrome.storage.session.set({ jobs }); });

  // Plain file, no conversion: let Chrome download it natively (resumable, no memory limit).
  if (item.kind === 'file' && (fmt === 'original' || fmt === extFromUrl(item.url, ''))) {
    const ext = extFromUrl(item.url, item.mediaType === 'audio' ? 'mp3' : 'mp4');
    await saveDownload(job.id, item.url, `${base}.${ext}`);
    return job.id;
  }
  await runInOffscreen(job);
  return job.id;
}

async function saveDownload(jobId, url, filename) {
  await patchJob(jobId, { status: 'saving', phase: 'Saving', filename });
  try {
    const downloadId = await chrome.downloads.download({
      url, filename: joinDownloadPath(settings.subfolder, filename), saveAs: !!settings.saveAs, conflictAction: 'uniquify',
    });
    await patchJob(jobId, { downloadId });
    await serial(async () => {
      const { dlMap = {} } = await chrome.storage.session.get('dlMap');
      dlMap[downloadId] = jobId;
      await chrome.storage.session.set({ dlMap });
    });
    await finalizeDownload(downloadId); // in case it already finished
  } catch (e) {
    await failJob(jobId, e.message || String(e));
  }
}

async function failJob(jobId, error) {
  const job = await patchJob(jobId, { status: 'failed', phase: 'Failed', error });
  if (job) await removeHeaderRule(job.ruleId);
  toOffscreen({ type: 'release', jobId });
  closeOffscreenIfIdle();
}

// A blob download can finish before we've even recorded its id, so completion is
// handled in one place and checked both from the event and right after starting.
const finalized = new Set();
async function finalizeDownload(downloadId) {
  const { dlMap = {} } = await chrome.storage.session.get('dlMap');
  const jobId = dlMap[downloadId];
  if (!jobId) return;
  const [d] = await chrome.downloads.search({ id: downloadId });
  if (!d || d.state === 'in_progress') return;
  if (finalized.has(downloadId)) return;
  finalized.add(downloadId);
  if (d.state === 'complete') {
    const job = await patchJob(jobId, { status: 'done', phase: 'Saved', progress: 1, finalPath: d.filename || '', bytes: d.fileSize || d.totalBytes || 0, eta: null });
    if (job) {
      await removeHeaderRule(job.ruleId);
      await addToLibrary(job, d);
    }
  } else if (d.state === 'interrupted') {
    const job = (await getJobs())[jobId];
    if (job && job.status !== 'cancelled') await failJob(jobId, `Download interrupted${d.error ? ': ' + d.error : ''}`);
  }
  await serial(async () => {
    const { dlMap: m = {} } = await chrome.storage.session.get('dlMap');
    delete m[downloadId];
    await chrome.storage.session.set({ dlMap: m });
  });
  toOffscreen({ type: 'release', jobId });
  closeOffscreenIfIdle();
}

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state && delta.state.current !== 'in_progress') finalizeDownload(delta.id);
});

async function addToLibrary(job, d) {
  await serial(async () => {
    const { library = [] } = await chrome.storage.local.get('library');
    library.unshift({
      id: job.id, title: job.item.title, pageUrl: job.item.pageUrl, format: job.format, quality: job.qualityLabel,
      filename: d?.filename || job.filename, downloadId: job.downloadId, size: d?.fileSize || d?.totalBytes || job.bytes || 0,
      savedAt: Date.now(), live: !!job.record,
    });
    await chrome.storage.local.set({ library: library.slice(0, 500) });
  });
}

// ---------- messages ----------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.target === 'offscreen') return false;
  handle(msg, sender).then((r) => reply({ ok: true, ...r }), (e) => reply({ ok: false, error: e.message || String(e) }));
  return true;
});

async function handle(msg, sender) {
  switch (msg.type) {
    // from the in-page detector (content scripts)
    case 'found': {
      if (!sender?.tab || !/^https?:/i.test(msg.url || '')) return {};
      const kind = msg.kind === 'hls' || msg.kind === 'dash' ? msg.kind : 'file';
      const c = kind === 'file' ? { kind, mediaType: msg.mediaType === 'audio' ? 'audio' : 'video', fromPlayer: true } : { kind };
      await addMedia(sender.tab, { url: msg.url, c, pageUrl: sender.tab.url });
      return {};
    }
    // from popup
    case 'start': return { jobId: await startJob(msg) };
    case 'cancel': {
      const job = (await getJobs())[msg.jobId];
      if (!job) return {};
      if (job.downloadId != null && job.status === 'saving') await chrome.downloads.cancel(job.downloadId).catch(() => {});
      await patchJob(msg.jobId, { status: 'cancelled', phase: 'Cancelled' });
      await removeHeaderRule(job.ruleId);
      toOffscreen({ type: 'cancel', jobId: msg.jobId });
      setTimeout(closeOffscreenIfIdle, 1000);
      return {};
    }
    case 'stop': toOffscreen({ type: 'stop', jobId: msg.jobId }); return {};
    case 'clearJobs': {
      await serial(async () => {
        const jobs = await getJobs();
        for (const [id, j] of Object.entries(jobs)) if (['done', 'failed', 'cancelled'].includes(j.status)) delete jobs[id];
        await chrome.storage.session.set({ jobs });
      });
      return {};
    }
    case 'open': await chrome.downloads.open(msg.downloadId); return {};
    case 'show': chrome.downloads.show(msg.downloadId); return {};
    case 'exists': {
      const [d] = await chrome.downloads.search({ id: msg.downloadId });
      return { exists: !!(d && d.exists !== false && d.state === 'complete') };
    }
    case 'removeLibrary': {
      await serial(async () => {
        const { library = [] } = await chrome.storage.local.get('library');
        await chrome.storage.local.set({ library: msg.all ? [] : library.filter((x) => x.id !== msg.id) });
      });
      return {};
    }
    case 'pageHeaders': {
      // popup asks for referer headers while it probes qualities
      const id = await addHeaderRule(msg.pageUrl).catch(() => null);
      return { ruleId: id };
    }
    case 'dropHeaders': await removeHeaderRule(msg.ruleId); return {};

    // from offscreen
    case 'progress': await patchJob(msg.jobId, msg.patch); return {};
    case 'output': {
      const job = (await getJobs())[msg.jobId];
      if (!job || job.status === 'cancelled') { toOffscreen({ type: 'release', jobId: msg.jobId }); return {}; }
      await patchJob(msg.jobId, { bytes: msg.size, record: !!msg.record });
      await saveDownload(msg.jobId, msg.blobUrl, `${job.baseName}.${msg.ext}`);
      return {};
    }
    case 'failed': await failJob(msg.jobId, msg.error); return {};
    default: return {};
  }
}

// Clean up stale session rules if the browser restarted mid-job.
chrome.runtime.onStartup.addListener(async () => {
  if (IS_FIREFOX) return;
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  if (rules.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map((r) => r.id) });
});
