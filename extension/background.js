// Burnout for Gmail: service worker.
// - on install or update: injects Burnout into Gmail tabs that were already open (no
//   reload needed); on install, opens the settings page;
// - clicking the Burnout icon (or the Alt+J shortcut) opens the side panel;
// - clicking "Reply with Burnout" in Gmail opens the panel and asks for the reply right away.

function panelOnIconClick() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  panelOnIconClick();
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
  // a new version (loaded from any folder: the manifest key keeps the ID and the data): the panel says so once.
  // The round arrow on the same version also fires 'update', so only a version change counts.
  const version = chrome.runtime.getManifest().version;
  if (details.reason === 'update' && details.previousVersion && details.previousVersion !== version) {
    chrome.storage.local.set({ updatedTo: version }).catch(() => {});
  }
  try {
    const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
    for (const tab of tabs) {
      chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] }).catch(() => {});
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
    }
  } catch (e) {
    // no Gmail tab open: nothing to do
  }
});

chrome.runtime.onStartup.addListener(panelOnIconClick);

// only Burnout's own button, inside Gmail (web pages can't message Burnout at all: there is no
// externally_connectable in the manifest)
const fromGmail = (sender) => !!sender.tab && sender.id === chrome.runtime.id && String(sender.url || '').startsWith('https://mail.google.com/');

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'jm:openPanel' && fromGmail(sender)) {
    const tabId = sender.tab.id;
    // first thing in the listener: Chrome only opens the panel in direct response to the user's click
    chrome.sidePanel.open({ tabId }).catch(() => {
      chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {});
    });
    // the panel (already open or opening now) sees this and writes the reply for this thread
    if (msg.write && typeof msg.threadId === 'string' && /^[0-9a-f]{12,20}$/i.test(msg.threadId) && chrome.storage.session) {
      chrome.storage.session.set({ autoWrite: { tabId, threadId: msg.threadId, at: Date.now() } }).catch(() => {});
    }
  }
  return false;
});
