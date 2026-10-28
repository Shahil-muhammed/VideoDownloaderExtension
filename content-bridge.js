// Isolated-world bridge: forwards what the in-page detector finds to the extension.
(() => {
  if (window.__reelkeepBridge) return;
  window.__reelkeepBridge = true;
  const TAG = '__reelkeep__';
  const sent = new Set();
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== true) return;
    const { url, kind, mediaType } = e.data;
    if (typeof url !== 'string' || url.length > 4096 || sent.has(kind + url)) return;
    sent.add(kind + url);
    chrome.runtime.sendMessage({ type: 'found', url, kind, mediaType }).catch(() => {});
  });
  // Popup opened: rescan <video>/<audio> elements in every frame.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'rescan') window.postMessage({ [TAG + 'scan']: true }, '*');
    return false;
  });
})();
