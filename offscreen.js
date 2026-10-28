// Reelkeep job runner. Lives in an offscreen document so long downloads and
// ffmpeg.wasm keep running after the popup closes.

import { FFmpeg } from './vendor/ffmpeg/index.js';
import { plan } from './lib/streams.js';
import { parseMedia, sequenceIv } from './lib/hls.js';

const CONCURRENCY = 6;
const RETRIES = 3;
const MAX_REMUX_BYTES = 1.6 * 1024 * 1024 * 1024; // ffmpeg.wasm memory ceiling, with headroom

const running = new Map(); // jobId -> {abort, stop}
const blobs = new Map();   // jobId -> objectURL

const send = (type, data) => chrome.runtime.sendMessage({ type, ...data }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.target !== 'offscreen') return false;
  if (msg.type === 'run') { reply({ accepted: true }); if (!running.has(msg.job.id)) run(msg.job); return false; }
  else if (msg.type === 'cancel') running.get(msg.jobId)?.abort.abort();
  else if (msg.type === 'stop') { const r = running.get(msg.jobId); if (r) r.stop = true; }
  else if (msg.type === 'release') {
    const u = blobs.get(msg.jobId);
    if (u) { setTimeout(() => URL.revokeObjectURL(u), 5000); blobs.delete(msg.jobId); }
  }
  return false;
});

class Cancelled extends Error {}

function progressReporter(jobId) {
  let last = 0, pending = null, timer = null;
  const flush = () => { timer = null; if (pending) { send('progress', { jobId, patch: pending }); pending = null; last = Date.now(); } };
  return (patch, force = false) => {
    pending = { ...(pending || {}), ...patch };
    if (force || Date.now() - last > 400) flush();
    else if (!timer) timer = setTimeout(flush, 400);
  };
}

// ---------- network ----------
async function fetchWithRetry(url, { range, signal, asText = false, onChunk } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (signal?.aborted) throw new Cancelled();
    try {
      const headers = {};
      if (range) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
      const r = await fetch(url, { credentials: 'include', headers, signal, cache: 'no-store' });
      if (!r.ok) {
        const err = new Error(`HTTP ${r.status} for ${shortUrl(url)}`);
        if (r.status === 401 || r.status === 403 || r.status === 404 || r.status === 410) { err.fatal = true; }
        throw err;
      }
      if (asText) return await r.text();
      if (!onChunk || !r.body) return new Uint8Array(await r.arrayBuffer());
      // Streamed read with progress (big single files)
      const reader = r.body.getReader();
      const parts = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value); size += value.length; onChunk(size, Number(r.headers.get('content-length')) || 0);
      }
      return concat(parts, size);
    } catch (e) {
      if (signal?.aborted || e.name === 'AbortError') throw new Cancelled();
      lastErr = e;
      if (e.fatal && attempt >= 1) break;
      await sleep(500 * 2 ** attempt, signal);
    }
  }
  throw lastErr;
}

const fetchText = (url) => fetchWithRetry(url, { asText: true });

function shortUrl(u) { try { const x = new URL(u); return x.host + x.pathname.slice(-40); } catch { return u; } }
function sleep(ms, signal) {
  return new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Cancelled()); }, { once: true });
  });
}
function concat(parts, size) {
  if (size === undefined) size = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(size); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------- AES-128 (clear-key HLS, not DRM) ----------
const keyCache = new Map();
async function decryptSegment(data, key, seq, signal) {
  let k = keyCache.get(key.uri);
  if (!k) {
    const raw = await fetchWithRetry(key.uri, { signal });
    if (raw.length !== 16) throw new Error('Unexpected AES key length');
    k = await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
    keyCache.set(key.uri, k);
  }
  const iv = key.iv || sequenceIv(seq);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, k, data));
}

// ---------- segment downloads ----------
/** Download a list of jobs ({url, byteRange, key, seq}) in order with limited parallelism. */
async function downloadSegments(list, signal, onSegment) {
  const results = new Array(list.length);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const i = next++;
      const s = list[i];
      let data = await fetchWithRetry(s.url, { range: s.byteRange, signal });
      if (s.key && s.key.method === 'AES-128') data = await decryptSegment(data, s.key, s.seq, signal);
      results[i] = data;
      onSegment(data.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
  return results;
}

/** Turn a planned track into an ordered list of byte jobs. Init segments are included inline. */
async function trackJobs(track) {
  if (track.type === 'segments') {
    const jobs = [];
    if (track.init) jobs.push({ url: track.init, byteRange: track.initRange });
    for (const s of track.segments) jobs.push({ url: s.url, byteRange: s.byteRange || null });
    return { jobs, duration: track.segments.reduce((t, s) => t + (s.duration || 0), 0) };
  }
  if (track.type === 'hls') {
    const media = parseMedia(await fetchText(track.url), track.url);
    if (media.protected) throw new Error('This stream is DRM-protected and cannot be saved.');
    return { jobs: hlsJobs(media.segments, new Set()), duration: media.duration };
  }
  throw new Error('Unknown track type');
}

/** HLS segments → byte jobs, inserting each new init map (EXT-X-MAP) once. */
function hlsJobs(segments, seenMaps) {
  const jobs = [];
  for (const s of segments) {
    if (s.map && !seenMaps.has(s.map.url + JSON.stringify(s.map.byteRange))) {
      seenMaps.add(s.map.url + JSON.stringify(s.map.byteRange));
      jobs.push({ url: s.map.url, byteRange: s.map.byteRange, key: null, seq: s.seq });
    }
    jobs.push({ url: s.url, byteRange: s.byteRange, key: s.key && !s.key.drm ? s.key : null, seq: s.seq });
  }
  return jobs;
}

// ---------- container sniffing ----------
function sniffExt(data) {
  if (!data || data.length < 12) return 'bin';
  if (data[0] === 0x47 && (data.length < 189 || data[188] === 0x47)) return 'ts';
  const box = String.fromCharCode(data[4], data[5], data[6], data[7]);
  if (['ftyp', 'styp', 'moov', 'moof', 'sidx', 'free', 'mdat'].includes(box)) return 'mp4';
  if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) return 'webm';
  if (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) return 'mp3'; // ID3 (also packed AAC; ffmpeg probes)
  if (data[0] === 0xff && (data[1] & 0xf6) === 0xf0) return 'aac';
  if (data[0] === 0xff && (data[1] & 0xe0) === 0xe0) return 'mp3';
  if (String.fromCharCode(...data.slice(0, 4)) === 'OggS') return 'ogg';
  if (String.fromCharCode(...data.slice(0, 4)) === 'fLaC') return 'flac';
  if (String.fromCharCode(...data.slice(0, 3)) === 'FLV') return 'flv';
  return 'bin';
}

const MIME = { mp4: 'video/mp4', m4a: 'audio/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mp3: 'audio/mpeg', ts: 'video/mp2t', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac', mov: 'video/quicktime' };

// ---------- ffmpeg ----------
async function withFFmpeg(fn, onProgress) {
  const ffmpeg = new FFmpeg();
  const log = [];
  ffmpeg.on('log', ({ message }) => { log.push(message); if (log.length > 60) log.shift(); });
  ffmpeg.on('progress', ({ progress }) => { if (progress >= 0 && progress <= 1) onProgress(progress); });
  const base = chrome.runtime.getURL('vendor/ffmpeg/');
  await ffmpeg.load({ coreURL: base + 'ffmpeg-core.js', wasmURL: base + 'ffmpeg-core.wasm', classWorkerURL: base + 'worker.js' });
  try { return await fn(ffmpeg, log); } finally { ffmpeg.terminate(); }
}

async function runFF(ffmpeg, log, args) {
  const code = await ffmpeg.exec(args);
  if (code !== 0) {
    const tail = log.filter((l) => /error|invalid|could not|unsupported|not found/i.test(l)).slice(-2).join(' / ');
    const e = new Error(`ffmpeg failed (${code})${tail ? ': ' + tail : ''}`);
    throw e;
  }
}

/**
 * inputs: [{role, data}] → {data, ext}
 * format: mp4 | mkv | mp3 | m4a | original
 */
async function produce(inputs, format, report) {
  const total = inputs.reduce((s, i) => s + i.data.length, 0);
  const exts = inputs.map((i) => sniffExt(i.data));
  const single = inputs.length === 1;

  // No processing needed.
  if (single && (format === 'original' || (format === exts[0] && ['mp4', 'mkv', 'mp3', 'webm'].includes(format)))) {
    return { data: inputs[0].data, ext: exts[0] === 'bin' ? 'mp4' : exts[0] };
  }
  if (total > MAX_REMUX_BYTES) {
    if (single) return { data: inputs[0].data, ext: exts[0] === 'bin' ? 'ts' : exts[0], note: 'Too large to convert in the browser; saved as downloaded.' };
    throw new Error('This video is too large to merge in the browser (over 1.6 GB). Pick a lower quality.');
  }

  report({ phase: format === 'mp3' ? 'Converting to MP3' : 'Merging', progress: 0.9, eta: null, speed: 0 }, true);
  return withFFmpeg(async (ffmpeg, log) => {
    const names = [];
    for (let i = 0; i < inputs.length; i++) {
      const name = `in${i}.${exts[i] === 'bin' ? 'dat' : exts[i]}`;
      await ffmpeg.writeFile(name, inputs[i].data);
      inputs[i].data = null; // transferred to the worker
      names.push(name);
    }
    const inArgs = names.flatMap((n) => ['-i', n]);
    const videoIdx = inputs.findIndex((i) => i.role === 'video' || i.role === 'muxed');
    const audioIdx = inputs.findIndex((i) => i.role === 'audio');
    let maps = [];
    if (inputs.length > 1) {
      if (videoIdx >= 0) maps.push('-map', `${videoIdx}:v:0`);
      if (audioIdx >= 0) maps.push('-map', `${audioIdx}:a:0`);
    }

    const tryOut = async (out, args) => {
      try { await runFF(ffmpeg, log, [...inArgs, ...maps, ...args, '-y', out]); return true; } catch (e) { try { await ffmpeg.deleteFile(out); } catch {} ; throw e; }
    };

    let out;
    if (format === 'mp3') {
      out = 'out.mp3';
      if (inputs.length > 1) maps = ['-map', `${audioIdx >= 0 ? audioIdx : 0}:a:0`];
      await tryOut(out, ['-vn', '-c:a', 'libmp3lame', '-q:a', '2']);
    } else if (format === 'm4a') {
      out = 'out.m4a';
      if (inputs.length > 1) maps = ['-map', `${audioIdx >= 0 ? audioIdx : 0}:a:0`];
      try { await tryOut(out, ['-vn', '-c:a', 'copy']); }
      catch { await tryOut(out, ['-vn', '-c:a', 'aac', '-b:a', '192k']); }
    } else if (format === 'mkv') {
      out = 'out.mkv';
      await tryOut(out, ['-c', 'copy']);
    } else {
      // mp4 (and "original" for split audio/video)
      out = 'out.mp4';
      try { await tryOut(out, ['-c', 'copy', '-movflags', '+faststart']); }
      catch {
        // Codecs MP4 can't hold (rare): fall back to MKV rather than re-encoding.
        out = 'out.mkv';
        await tryOut(out, ['-c', 'copy']);
      }
    }
    const data = await ffmpeg.readFile(out);
    return { data, ext: out.split('.').pop() };
  }, (p) => report({ progress: 0.9 + 0.09 * p }));
}

// ---------- jobs ----------
async function run(job) {
  const ctl = { abort: new AbortController(), stop: false };
  running.set(job.id, ctl);
  const report = progressReporter(job.id);
  const signal = ctl.abort.signal;
  try {
    report({ status: 'running', phase: 'Reading stream' }, true);
    const audioOnly = job.format === 'mp3' || job.format === 'm4a';
    const p = await plan(job.item, job.qualityId, audioOnly, fetchText);

    let inputs;
    if (p.live) inputs = await recordLive(p.tracks, ctl, report);
    else inputs = await downloadAll(p.tracks, signal, report);
    if (signal.aborted) throw new Cancelled();

    const result = await produce(inputs, job.format, report);
    if (signal.aborted) throw new Cancelled();
    const blob = new Blob([result.data], { type: MIME[result.ext] || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    blobs.set(job.id, url);
    report({ progress: 1, phase: 'Saving', note: result.note || '' }, true);
    await send('output', { jobId: job.id, blobUrl: url, ext: result.ext, size: blob.size, record: p.live });
  } catch (e) {
    if (e instanceof Cancelled || signal.aborted) return;
    console.error(e);
    await send('failed', { jobId: job.id, error: e.message || String(e) });
  } finally {
    running.delete(job.id);
  }
}

/** Smoothed speed and time-left estimate. */
function etaMeter() {
  const start = Date.now();
  let speed = 0, lastT = start, lastB = 0;
  return (bytes, fractionDone) => {
    const now = Date.now();
    const dt = (now - lastT) / 1000;
    if (dt >= 0.5) {
      const inst = (bytes - lastB) / dt;
      speed = speed ? speed * 0.7 + inst * 0.3 : inst;
      lastT = now; lastB = bytes;
    }
    const elapsed = (now - start) / 1000;
    let eta = null;
    if (fractionDone > 0.01 && elapsed > 1.5) {
      // Blend the byte-rate estimate with the plain "fraction done over time" one.
      const byTime = elapsed * (1 - fractionDone) / fractionDone;
      const totalGuess = bytes / fractionDone;
      const byRate = speed > 0 ? (totalGuess - bytes) / speed : byTime;
      eta = Math.max(0, Math.round((byTime + byRate) / 2));
    }
    return { speed: Math.round(speed), eta, etaAt: now };
  };
}

async function downloadAll(tracks, signal, report) {
  const meter = etaMeter();
  // Single progressive file: stream it with byte progress.
  if (tracks.length === 1 && tracks[0].type === 'file') {
    report({ phase: 'Downloading' }, true);
    const data = await fetchWithRetry(tracks[0].url, {
      signal, onChunk: (got, total) => report({ bytes: got, progress: total ? 0.9 * got / total : 0, total, ...meter(got, total ? got / total : 0) }),
    });
    return [{ role: tracks[0].role, data }];
  }
  const planned = [];
  for (const t of tracks) planned.push({ role: t.role, ...(await trackJobs(t)) });
  const totalSegs = planned.reduce((s, t) => s + t.jobs.length, 0);
  if (!totalSegs) throw new Error('The playlist has no segments.');
  let done = 0, bytes = 0;
  report({ phase: `Downloading ${totalSegs} segments`, duration: planned[0].duration }, true);
  const inputs = [];
  for (const t of planned) {
    const parts = await downloadSegments(t.jobs, signal, (n) => {
      done++; bytes += n;
      report({ progress: 0.9 * done / totalSegs, bytes, segments: `${done}/${totalSegs}`, ...meter(bytes, done / totalSegs) });
    });
    inputs.push({ role: t.role, data: concat(parts) });
  }
  return inputs;
}

/** Record live HLS until stopped or the stream ends. */
async function recordLive(tracks, ctl, report) {
  const signal = ctl.abort.signal;
  const state = tracks.map((t) => ({ role: t.role, url: t.url, parts: [], seen: new Set(), maps: new Set(), lastSeq: -1, ended: false }));
  let bytes = 0, seconds = 0, idle = 0;
  const started = Date.now();
  report({ status: 'running', phase: 'Recording', live: true, recording: true, progress: 0 }, true);
  while (!ctl.stop && !signal.aborted) {
    let target = 4, gotNew = false;
    for (const s of state) {
      if (s.ended) continue;
      const media = parseMedia(await fetchText(s.url), s.url);
      if (media.protected) throw new Error('This stream is DRM-protected and cannot be saved.');
      target = media.targetDuration || target;
      const fresh = media.segments.filter((x) => x.seq > s.lastSeq && !s.seen.has(x.seq));
      if (fresh.length) {
        gotNew = true;
        const jobs = hlsJobs(fresh, s.maps);
        const parts = await downloadSegments(jobs, signal, (n) => { bytes += n; });
        s.parts.push(...parts);
        for (const x of fresh) { s.seen.add(x.seq); s.lastSeq = Math.max(s.lastSeq, x.seq); if (s.role !== 'audio') seconds += x.duration; }
      }
      if (media.endList) s.ended = true;
    }
    if (state.every((s) => s.role === 'audio') && gotNew) seconds = (Date.now() - started) / 1000;
    report({ phase: 'Recording', bytes, recorded: seconds, recordStartedAt: started });
    if (state.every((s) => s.ended)) break;
    idle = gotNew ? 0 : idle + 1;
    if (idle > 20) break; // stream stalled for ~20 polls: treat as ended
    if (bytes > MAX_REMUX_BYTES) { report({ note: 'Stopped at the 1.6 GB browser limit.' }, true); break; }
    await sleep(Math.max(1000, (target * 1000) / 2), signal).catch(() => {});
  }
  if (signal.aborted) throw new Cancelled();
  report({ recording: false, phase: 'Finishing recording', progress: 0.9 }, true);
  const inputs = state.filter((s) => s.parts.length).map((s) => ({ role: s.role, data: concat(s.parts) }));
  if (!inputs.length) throw new Error('Nothing was recorded.');
  return inputs;
}
