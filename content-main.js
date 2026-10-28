// Runs in the page itself (MAIN world) so it sees what the player sees:
// playlists recognised by their content (#EXTM3U / <MPD>) whatever their URL
// or content type, requests served by the page's service worker or cache, and
// <video>/<audio> sources. Reports URLs only; never changes a response.
(() => {
  if (window.__reelkeepHooked) return;
  Object.defineProperty(window, '__reelkeepHooked', { value: true });

  const TAG = '__reelkeep__';
  const seen = new Set();
  const SKIP = /\.(ts|m4s|m4v|aac|jpe?g|png|gif|webp|avif|svg|ico|js|mjs|css|woff2?|ttf|vtt|srt|json|html?)(\?|#|$)/i;

  function report(url, kind, mediaType) {
    try { url = new URL(url, location.href).href; } catch { return; }
    if (!/^https?:/i.test(url)) return;
    const k = kind + ' ' + url;
    if (seen.has(k)) return;
    seen.add(k);
    window.postMessage({ [TAG]: true, url, kind, mediaType }, '*');
  }

  function sniff(url, head) {
    if (!head) return;
    const t = head.replace(/^﻿/, '').trimStart();
    if (t.startsWith('#EXTM3U')) report(url, 'hls');
    else if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<MPD[\s>]/i.test(t)) report(url, 'dash');
  }

  const decoder = () => new TextDecoder('utf-8', { fatal: false });
  const worthPeeking = (url, ct) => {
    if (!url || SKIP.test(url)) return false;
    ct = (ct || '').toLowerCase();
    if (/^(video|audio|image|font)\//.test(ct) || ct.includes('javascript') || ct.includes('json') || ct.includes('html') || ct.includes('css')) return false;
    return true;
  };

  // ---- fetch ----
  const origFetch = window.fetch;
  if (origFetch) {
    const wrapped = function (...args) {
      const p = origFetch.apply(this, args);
      p.then((res) => {
        try {
          if (!res || !res.ok || !worthPeeking(res.url, res.headers.get('content-type'))) return;
          // Read only the first chunk of a clone; the page's own body is untouched.
          const reader = res.clone().body?.getReader();
          if (!reader) return;
          reader.read().then(({ value }) => {
            reader.cancel().catch(() => {});
            if (value) sniff(res.url, decoder().decode(value.slice(0, 2048)));
          }).catch(() => {});
        } catch { /* never break the page */ }
      }, () => {});
      return p;
    };
    try { Object.defineProperty(wrapped, 'name', { value: 'fetch' }); } catch {}
    wrapped.toString = () => origFetch.toString();
    window.fetch = wrapped;
  }

  // ---- XMLHttpRequest ----
  const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHR) {
    const origSend = XHR.send;
    XHR.send = function (...args) {
      try {
        this.addEventListener('load', () => {
          try {
            const url = this.responseURL;
            if (this.status >= 400 || !worthPeeking(url, this.getResponseHeader('content-type'))) return;
            const rt = this.responseType;
            if (rt === '' || rt === 'text') sniff(url, String(this.responseText || '').slice(0, 2048));
            else if (rt === 'arraybuffer' && this.response) sniff(url, decoder().decode(new Uint8Array(this.response, 0, Math.min(2048, this.response.byteLength))));
          } catch { /* ignore */ }
        });
      } catch { /* ignore */ }
      return origSend.apply(this, args);
    };
  }

  // ---- <video> / <audio> ----
  function scanElement(el) {
    if (!el || !el.tagName) return;
    const tag = el.tagName.toLowerCase();
    const mediaType = tag === 'audio' ? 'audio' : 'video';
    const srcs = [el.currentSrc, el.src];
    if (tag === 'video' || tag === 'audio') for (const s of el.querySelectorAll('source')) srcs.push(s.src);
    for (const s of srcs) {
      if (!s || !/^https?:/i.test(s)) continue; // blob: players are caught through their playlists
      if (/\.m3u8(\?|#|$)/i.test(s)) report(s, 'hls');
      else if (/\.mpd(\?|#|$)/i.test(s)) report(s, 'dash');
      else report(s, 'file', mediaType);
    }
  }
  const onMediaEvent = (e) => scanElement(e.target);
  for (const ev of ['loadstart', 'loadedmetadata', 'play', 'playing']) document.addEventListener(ev, onMediaEvent, true);
  const scanAll = () => document.querySelectorAll('video, audio').forEach(scanElement);
  document.addEventListener('DOMContentLoaded', scanAll, { once: true });
  window.addEventListener('load', scanAll, { once: true });
  // The popup asks for a fresh scan when it opens.
  window.addEventListener('message', (e) => { if (e.source === window && e.data && e.data[TAG + 'scan']) scanAll(); });
})();
