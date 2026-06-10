chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ── Dev live-reload ───────────────────────────────────────────────────────────
// Polls the watch.js reload server (port 35729) and reloads the extension when
// the token changes. Only active during development (server must be running).

let _reloadToken = null;
async function checkReload() {
  try {
    const res = await fetch('http://127.0.0.1:35729', { signal: AbortSignal.timeout(800) });
    const { token } = await res.json();
    if (_reloadToken === null) { _reloadToken = token; return; }
    if (token !== _reloadToken) { _reloadToken = token; chrome.runtime.reload(); }
  } catch {}
}
setInterval(checkReload, 2000);

// ── Context menu ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id:       'ask-axion',
    title:    'Ask Axion: "%s"',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id:       'ask-axion-page',
    title:    'Ask Axion about this page',
    contexts: ['page'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const text = info.selectionText || '';
  chrome.storage.session.set({ prefillText: text });
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

// ── Screenshot ────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'screenshot') {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab) { sendResponse({ dataUrl: null }); return; }
      chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (dataUrl) => {
        void chrome.runtime.lastError;
        sendResponse({ dataUrl: dataUrl || null });
      });
    });
    return true;
  }
});
