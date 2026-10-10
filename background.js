// Service worker: context menus + keyboard shortcut -> read-later list.
// No network calls. Everything stays on this machine.

const STORE_KEY = 'readLater';
const PINNED_KEY = 'pinnedSites';
const MAX_ITEMS = 200;

async function getList() {
  const data = await chrome.storage.local.get(STORE_KEY);
  return Array.isArray(data[STORE_KEY]) ? data[STORE_KEY] : [];
}

async function saveList(list) {
  await chrome.storage.local.set({ [STORE_KEY]: list.slice(0, MAX_ITEMS) });
}

function isWebUrl(url) {
  return /^https?:\/\//i.test(url || '');
}

// Lenient with pasted URLs missing the scheme (mirrors newtab.js).
function normalizeUrl(raw) {
  const url = (raw || '').trim();
  if (/^https?:\/\//i.test(url)) return url;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(url)) return 'https://' + url;
  return null;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

async function pinItem(rawUrl, title) {
  const url = normalizeUrl(rawUrl);
  if (!url) return false;
  const data = await chrome.storage.local.get(PINNED_KEY);
  const sites = Array.isArray(data[PINNED_KEY]) ? data[PINNED_KEY] : [];
  if (sites.some((s) => s.url === url)) return false; // already pinned
  sites.push({ url, title: (title || hostOf(url)).trim().slice(0, 200) || url });
  await chrome.storage.local.set({ [PINNED_KEY]: sites });
  return true;
}

// Chrome refuses data: URLs for notification icons ("Unable to download all
// specified images"), and silently drops a basic notification with no iconUrl
// at all - so the favicon endpoint is both required and the nicer option.
function noteIcon(url) {
  return `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(url)}&size=64`;
}

function notifySaved(url, title) {
  const name = (title || '').replace(/\s+[|–—-]\s+.*$/, '').trim().slice(0, 80);
  return chrome.notifications
    .create('read-later-saved', {
      type: 'basic',
      iconUrl: noteIcon(url),
      title: name || 'Page saved',
      message: 'Added to your Read Later list.',
      contextMessage: 'Read Later New Tab',
      priority: 0,
    })
    .catch(() => {}); // notifications can fail if the OS denies them; never block the save
}

async function addItem(url, title) {
  if (!isWebUrl(url)) return false;
  const list = await getList();
  if (list.some((item) => item.url === url)) return false; // already saved
  list.unshift({ url, title: (title || url || '').trim().slice(0, 200) || url, savedAt: Date.now() });
  await saveList(list);
  notifySaved(url, title);
  return true;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'save-page',
    title: 'Save page to read later',
    contexts: ['page'],
  });
  chrome.contextMenus.create({
    id: 'save-link',
    title: 'Save link to read later',
    contexts: ['link'],
  });
  chrome.contextMenus.create({
    id: 'pin-page',
    title: 'Pin to new tab tiles',
    contexts: ['page'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'save-page' && tab) {
    await addItem(tab.url, tab.title);
  } else if (info.menuItemId === 'save-link') {
    const text = (info.linkText || '').trim().slice(0, 140);
    await addItem(info.linkUrl, text || info.linkUrl);
  } else if (info.menuItemId === 'pin-page' && tab) {
    await pinItem(tab.url, tab.title);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'save-to-read-later') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) await addItem(tab.url, tab.title);
});
