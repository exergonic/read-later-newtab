// New tab page: read-later list + recently closed tabs + synced device tabs.
// No network calls. All data is local (chrome.storage) or from the browser's
// own session/sync state.

const STORE_KEY = 'readLater';
const DISMISSED_KEY = 'dismissedSessions';
const PINNED_KEY = 'pinnedSites';
const MAX_ITEMS = 200;
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const $ = (sel) => document.querySelector(sel);

function isWebUrl(url) {
  return /^https?:\/\//i.test(url || '');
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function ageString(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  return d + 'd ago';
}

async function getList() {
  const data = await chrome.storage.local.get(STORE_KEY);
  return Array.isArray(data[STORE_KEY]) ? data[STORE_KEY] : [];
}

// Lenient with pasted URLs that are missing the scheme. Returns null if the
// text can't be read as an http(s) URL.
function normalizeUrl(raw) {
  const url = (raw || '').trim();
  if (/^https?:\/\//i.test(url)) return url;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(url)) return 'https://' + url;
  return null;
}

async function addItem(url, title) {
  url = normalizeUrl(url);
  if (!url) return false;
  const list = await getList();
  if (list.some((item) => item.url === url)) return false;
  list.unshift({ url, title: (title || url).trim().slice(0, 200) || url, savedAt: Date.now() });
  await chrome.storage.local.set({ [STORE_KEY]: list.slice(0, MAX_ITEMS) });
  return true;
}

async function removeItem(url) {
  const list = await getList();
  await chrome.storage.local.set({ [STORE_KEY]: list.filter((item) => item.url !== url) });
}

async function getDismissed() {
  const data = await chrome.storage.local.get(DISMISSED_KEY);
  return new Set(Array.isArray(data[DISMISSED_KEY]) ? data[DISMISSED_KEY] : []);
}

async function dismissSession(sessionId) {
  const dismissed = await getDismissed();
  dismissed.add(sessionId);
  await chrome.storage.local.set({ [DISMISSED_KEY]: [...dismissed].slice(-500) });
}

function openUrl(url) {
  chrome.tabs.create({ url });
}

// --- rendering ---------------------------------------------------------------

function itemRow({ url, title, metaHtml, onDismiss, onReopen }) {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.className = 'item-link';
  a.href = url;
  a.textContent = title || url;
  a.title = url;
  a.addEventListener('click', (e) => {
    e.preventDefault();
    openUrl(url);
  });
  const meta = document.createElement('span');
  meta.className = 'item-meta';
  meta.innerHTML = metaHtml;
  const actions = document.createElement('span');
  actions.className = 'item-actions';
  if (onReopen) {
    const reopen = document.createElement('button');
    reopen.textContent = '↺';
    reopen.title = 'Reopen tab';
    reopen.addEventListener('click', onReopen);
    actions.appendChild(reopen);
  }
  const dismiss = document.createElement('button');
  dismiss.textContent = '✕';
  dismiss.title = 'Remove';
  dismiss.addEventListener('click', async () => {
    await onDismiss();
    li.remove();
  });
  actions.appendChild(dismiss);
  li.append(a, meta, actions);
  return li;
}

function emptyRow(text) {
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = text;
  return li;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function renderSaved() {
  const list = await getList();
  const ul = $('#saved-items');
  ul.innerHTML = '';
  $('#saved-count').textContent = list.length ? `(${list.length})` : '';
  if (!list.length) {
    ul.appendChild(emptyRow('Nothing saved yet. Right-click any page → “Save page to read later”.'));
    return;
  }
  for (const item of list) {
    const stale = Date.now() - item.savedAt > STALE_AFTER_MS;
    const metaHtml = stale
      ? `<span class="stale-age">${escapeHtml(ageString(item.savedAt))} — still interested?</span> · ${escapeHtml(domainOf(item.url))}`
      : `${escapeHtml(ageString(item.savedAt))} · ${escapeHtml(domainOf(item.url))}`;
    const li = itemRow({
      url: item.url,
      title: item.title,
      metaHtml,
      onDismiss: () => removeItem(item.url),
    });
    if (stale) li.classList.add('stale');
    ul.appendChild(li);
  }
}

async function renderClosed() {
  const ul = $('#closed-items');
  ul.innerHTML = '';
  let sessions = [];
  try {
    sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
  } catch { /* sessions unavailable */ }
  const dismissed = await getDismissed();
  const tabs = [];
  for (const s of sessions) {
    if (s.tab && isWebUrl(s.tab.url) && !dismissed.has(s.tab.sessionId)) {
      tabs.push({ url: s.tab.url, title: s.tab.title, sessionId: s.tab.sessionId, when: (s.lastModified || 0) * 1000 });
    } else if (s.window && Array.isArray(s.window.tabs)) {
      for (const t of s.window.tabs) {
        if (isWebUrl(t.url) && !dismissed.has(t.sessionId)) {
          tabs.push({ url: t.url, title: t.title, sessionId: t.sessionId, when: (s.lastModified || 0) * 1000 });
        }
      }
    }
  }
  if (!tabs.length) {
    ul.appendChild(emptyRow('No recently closed tabs.'));
    return;
  }
  for (const t of tabs.slice(0, 20)) {
    ul.appendChild(itemRow({
      url: t.url,
      title: t.title,
      metaHtml: `${t.when ? escapeHtml(ageString(t.when)) + ' · ' : ''}${escapeHtml(domainOf(t.url))}`,
      onDismiss: () => dismissSession(t.sessionId),
      onReopen: async () => {
        try { await chrome.sessions.restore(t.sessionId); } catch { openUrl(t.url); }
      },
    }));
  }
}

async function renderDevices() {
  const ul = $('#device-items');
  ul.innerHTML = '';
  let devices = [];
  try {
    devices = await chrome.sessions.getDevices();
  } catch { /* sync unavailable */ }
  devices = (devices || []).filter((d) => Array.isArray(d.tabs) && d.tabs.length);
  if (!devices.length) {
    ul.appendChild(emptyRow('No synced devices with open tabs. Turn on Brave Sync (with tab sync) to see your phone’s tabs here.'));
    return;
  }
  const hidden = renderDevices.hidden || (renderDevices.hidden = new Set());
  for (const d of devices) {
    const tabs = d.tabs.filter((t) => isWebUrl(t.url) && !hidden.has(d.deviceName + '|' + t.url));
    if (!tabs.length) continue;
    const name = document.createElement('li');
    name.className = 'device-name';
    name.textContent = d.deviceName || 'Unknown device';
    ul.appendChild(name);
    for (const t of tabs.slice(0, 15)) {
      const key = d.deviceName + '|' + t.url;
      ul.appendChild(itemRow({
        url: t.url,
        title: t.title,
        metaHtml: escapeHtml(domainOf(t.url)),
        onDismiss: async () => { hidden.add(key); },
      }));
    }
  }
  if (!ul.children.length) {
    ul.appendChild(emptyRow('No synced devices with open tabs.'));
  }
}

// --- pinned tile grid -------------------------------------------------------

async function getPinned() {
  const data = await chrome.storage.local.get(PINNED_KEY);
  return Array.isArray(data[PINNED_KEY]) ? data[PINNED_KEY] : [];
}

async function savePinned(sites) {
  await chrome.storage.local.set({ [PINNED_KEY]: sites });
}

// Chrome resolves the icon from its own favicon cache, so the extension itself
// still makes no network request. Relative path works on extension pages.
// Chrome 105+ requires the camelCase `pageUrl` parameter.
function faviconUrl(url) {
  return `/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`;
}

function pinLabel(site) {
  const host = domainOf(site.url);
  if (site.title && site.title !== site.url) {
    // Trim a page title down to something tile-sized.
    const t = site.title.replace(/\s+[|–—-]\s+.*$/, '').trim();
    if (t) return t.slice(0, 28);
  }
  return host;
}

function pinTile(site) {
  const li = document.createElement('li');
  li.className = 'pin-tile';
  li.draggable = true;
  li.dataset.url = site.url;
  li.title = site.title || site.url;

  const box = document.createElement('span');
  box.className = 'pin-box';
  const img = document.createElement('img');
  img.src = faviconUrl(site.url);
  img.alt = '';
  img.loading = 'lazy';
  // Chrome returns a generic globe when it has no icon; that still opens fine.
  img.addEventListener('error', () => { img.remove(); }, { once: true });
  box.appendChild(img);

  const label = document.createElement('span');
  label.className = 'pin-label';
  label.textContent = pinLabel(site);

  const remove = document.createElement('button');
  remove.className = 'pin-remove';
  remove.textContent = '✕';
  remove.title = 'Unpin';
  remove.addEventListener('click', async (e) => {
    e.stopPropagation();
    const sites = await getPinned();
    await savePinned(sites.filter((s) => s.url !== site.url));
    renderPinned();
  });

  li.append(remove, box, label);
  li.addEventListener('click', () => openUrl(site.url));
  return li;
}

async function renderPinned() {
  const sites = await getPinned();
  const grid = $('#pin-grid');
  grid.innerHTML = '';
  for (const site of sites) grid.appendChild(pinTile(site));
  $('#pin-hint').hidden = sites.length > 0;
}

// --- drag to reorder --------------------------------------------------------

let dragUrl = null;
const grid = $('#pin-grid');

function clearDropMarks() {
  for (const el of grid.querySelectorAll('.drop-before')) el.classList.remove('drop-before');
}

grid.addEventListener('dragstart', (e) => {
  const li = e.target.closest('.pin-tile');
  if (!li) return;
  dragUrl = li.dataset.url;
  li.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragUrl);
});

grid.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  clearDropMarks();
  const li = e.target.closest('.pin-tile');
  if (li && li.dataset.url !== dragUrl) li.classList.add('drop-before');
});

grid.addEventListener('dragleave', (e) => {
  if (!grid.contains(e.relatedTarget)) clearDropMarks();
});

grid.addEventListener('drop', async (e) => {
  e.preventDefault();
  clearDropMarks();
  const li = e.target.closest('.pin-tile');
  if (!li || !dragUrl || li.dataset.url === dragUrl) return;
  const sites = await getPinned();
  const from = sites.findIndex((s) => s.url === dragUrl);
  const to = sites.findIndex((s) => s.url === li.dataset.url);
  if (from < 0 || to < 0) return;
  const [moved] = sites.splice(from, 1);
  sites.splice(to, 0, moved);
  await savePinned(sites);
  renderPinned();
});

grid.addEventListener('dragend', () => {
  dragUrl = null;
  clearDropMarks();
  for (const el of grid.querySelectorAll('.dragging')) el.classList.remove('dragging');
});

function showPinForm(show) {
  $('#pin-form').hidden = !show;
  $('#pin-add').hidden = show;
  if (show) $('#pin-input').focus();
  else $('#pin-input').value = '';
}

$('#pin-add').addEventListener('click', () => showPinForm(true));
$('#pin-cancel').addEventListener('click', () => showPinForm(false));

$('#pin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#pin-input');
  const url = normalizeUrl(input.value);
  if (!url) {
    input.placeholder = 'That is not a URL — try https://…';
    return;
  }
  const sites = await getPinned();
  if (!sites.some((s) => s.url === url)) {
    sites.push({ url, title: domainOf(url) || url });
    await savePinned(sites);
  }
  showPinForm(false);
  await renderPinned();
});

// --- init --------------------------------------------------------------------

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#add-url');
  const ok = await addItem(input.value, input.value);
  input.value = '';
  input.placeholder = ok ? 'Saved ✓ — paste another…' : 'Paste a URL…';
  setTimeout(() => { input.placeholder = 'Paste a URL…'; }, 2000);
  await renderSaved();
});

(async function init() {
  await Promise.all([renderPinned(), renderSaved(), renderClosed(), renderDevices()]);
})();
