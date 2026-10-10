// New tab page: read-later list + recently closed tabs + synced device tabs.
// No network calls. All data is local (chrome.storage) or from the browser's
// own session/sync state.

const STORE_KEY = 'readLater';
const DISMISSED_KEY = 'dismissedSessions';
const PINNED_KEY = 'pinnedSites';
const BACKGROUND_KEY = 'background';
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
    devices = await chrome.sessions.getDevices({ maxResults: 25 });
  } catch { /* sync unavailable */ }
  // A device is { deviceName, sessions } - not { deviceName, tabs }. Each foreign
  // session is a window, and the open tabs hang off session.window.tabs (the
  // device-level `tabs` this lane used to read never existed, so it filtered
  // every device away and always drew the empty state). Same shape as
  // chrome.sessions.getRecentlyClosed().
  const perDevice = [];
  for (const device of devices || []) {
    const tabs = [];
    const seen = new Set();
    for (const session of device.sessions || []) {
      const when = (session.lastModified || 0) * 1000;
      const candidates = session.tab ? [session.tab] : (session.window && session.window.tabs) || [];
      for (const tab of candidates) {
        if (!isWebUrl(tab.url) || seen.has(tab.url)) continue;
        seen.add(tab.url);
        tabs.push({ url: tab.url, title: tab.title, when });
      }
    }
    if (tabs.length) perDevice.push({ name: device.deviceName || 'Unknown device', tabs });
  }
  if (!perDevice.length) {
    ul.appendChild(emptyRow('No open tabs from other devices yet. Needs Browser Sync with “Open tabs” turned on for both devices, and the tabs left open there.'));
    return;
  }
  const hidden = renderDevices.hidden || (renderDevices.hidden = new Set());
  for (const device of perDevice) {
    const tabs = device.tabs.filter((t) => !hidden.has(device.name + '|' + t.url));
    if (!tabs.length) continue;
    const name = document.createElement('li');
    name.className = 'device-name';
    name.textContent = device.name;
    ul.appendChild(name);
    for (const t of tabs.slice(0, 15)) {
      const key = device.name + '|' + t.url;
      ul.appendChild(itemRow({
        url: t.url,
        title: t.title,
        metaHtml: `${t.when ? escapeHtml(ageString(t.when)) + ' · ' : ''}${escapeHtml(domainOf(t.url))}`,
        onDismiss: async () => { hidden.add(key); },
      }));
    }
  }
  if (!ul.children.length) {
    ul.appendChild(emptyRow('Every tab from your other devices has been dismissed.'));
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
  // Images are draggable by default, which would make the favicon the drag
  // source (the ghost becomes just the icon, and the drag carries the image
  // URL). Keep the tile itself as the thing being dragged.
  img.draggable = false;
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
  // Read everything the reorder needs before the first await. The browser fires
  // `dragend` as soon as the drop is dispatched, and that handler clears
  // dragUrl - so reading it after an await finds null, `from` becomes -1, and
  // the reorder silently does nothing.
  const source = dragUrl;
  const li = e.target.closest('.pin-tile');
  const target = li ? li.dataset.url : null;
  clearDropMarks();
  if (!source || !target || target === source) return;
  const sites = await getPinned();
  const from = sites.findIndex((s) => s.url === source);
  const to = sites.findIndex((s) => s.url === target);
  if (from < 0 || to < 0) return;
  const [moved] = sites.splice(from, 1);
  // The marker is drawn to the left of the hovered tile, so the item belongs at
  // that index - but removing the dragged item already shifted everything after
  // it down by one.
  sites.splice(from < to ? to - 1 : to, 0, moved);
  await savePinned(sites);
  await renderPinned();
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

// --- background -------------------------------------------------------------

// Dark enough that the dim tile labels and hints stay readable on top.
const BG_PRESETS = [
  { id: 'midnight', label: 'Midnight', css: 'radial-gradient(1100px 620px at 18% -10%, #1d2c4d 0%, #16181d 62%)' },
  { id: 'ember', label: 'Ember', css: 'radial-gradient(1000px 640px at 82% 4%, #3c2029 0%, #16181d 66%)' },
  { id: 'forest', label: 'Forest', css: 'radial-gradient(1000px 640px at 12% 8%, #16302b 0%, #16181d 66%)' },
  { id: 'dusk', label: 'Dusk', css: 'linear-gradient(160deg, #241b33 0%, #16181d 55%, #10202c 100%)' },
  { id: 'graphite', label: 'Graphite', css: 'linear-gradient(180deg, #232830 0%, #16181d 72%)' },
];
// A photo behind the tiles needs a scrim; the presets are already this dark.
// Kept heavy enough that the dim tile labels stay readable over a loud photo.
const BG_SCRIM = 'linear-gradient(rgba(22, 24, 29, .8), rgba(22, 24, 29, .91))';
const BG_MAX_SIDE = 1920;
// Base64 length cap, comfortably inside the ~10 MB chrome.storage.local quota.
const BG_MAX_CHARS = 2400000;

async function getBackground() {
  const data = await chrome.storage.local.get(BACKGROUND_KEY);
  return data[BACKGROUND_KEY] || null;
}

function backgroundCss(setting) {
  if (!setting) return '';
  if (setting.kind === 'preset') {
    const preset = BG_PRESETS.find((p) => p.id === setting.id);
    return preset ? preset.css : '';
  }
  if (setting.kind === 'image' && typeof setting.data === 'string') {
    return `${BG_SCRIM}, url(${JSON.stringify(setting.data)})`;
  }
  return '';
}

function applyBackground(setting) {
  const css = backgroundCss(setting);
  const style = document.body.style;
  style.backgroundImage = css;
  style.backgroundSize = css ? 'cover' : '';
  style.backgroundPosition = css ? 'center' : '';
  style.backgroundRepeat = css ? 'no-repeat' : '';
  style.backgroundAttachment = css ? 'fixed' : '';
  for (const btn of $('#bg-swatches').querySelectorAll('button')) {
    btn.setAttribute('aria-pressed', String(Boolean(css) && setting.kind === 'preset' && setting.id === btn.dataset.id));
  }
}

let bgStatusTimer = 0;
function setBgStatus(text) {
  $('#bg-status').textContent = text;
  clearTimeout(bgStatusTimer);
  if (text) bgStatusTimer = setTimeout(() => { $('#bg-status').textContent = ''; }, 8000);
}

function renderSwatches() {
  const box = $('#bg-swatches');
  for (const preset of BG_PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bg-swatch';
    btn.dataset.id = preset.id;
    btn.title = preset.label;
    btn.setAttribute('aria-label', preset.label);
    btn.setAttribute('aria-pressed', 'false');
    btn.style.backgroundImage = preset.css;
    btn.addEventListener('click', async () => {
      const setting = { kind: 'preset', id: preset.id };
      await chrome.storage.local.set({ [BACKGROUND_KEY]: setting });
      applyBackground(setting);
      setBgStatus('');
    });
    box.appendChild(btn);
  }
}

// Downscale and re-encode in the page: the stored copy has to fit in
// chrome.storage.local, so a full-resolution photo is not an option.
async function imageBackground(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  const scale = Math.min(1, BG_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();
  let quality = 0.85;
  let data = canvas.toDataURL('image/jpeg', quality);
  while (data.length > BG_MAX_CHARS && quality > 0.45) {
    quality -= 0.1;
    data = canvas.toDataURL('image/jpeg', quality);
  }
  if (data.length > BG_MAX_CHARS) return null;
  return { kind: 'image', data, name: file.name.slice(0, 120), w, h };
}

$('#bg-open').addEventListener('click', () => {
  const panel = $('#bg-panel');
  panel.hidden = !panel.hidden;
  $('#bg-open').setAttribute('aria-expanded', String(!panel.hidden));
});

$('#bg-file').addEventListener('change', async (e) => {
  const input = e.target;
  const file = input.files && input.files[0];
  input.value = '';                             // so the same file can be picked twice
  if (!file) return;
  setBgStatus('Reading image…');
  const setting = await imageBackground(file);
  if (!setting) {
    setBgStatus('Not an image this browser can read, or too large to keep locally.');
    return;
  }
  try {
    await chrome.storage.local.set({ [BACKGROUND_KEY]: setting });
  } catch {
    setBgStatus('Could not store that image locally — try a smaller one.');
    return;
  }
  applyBackground(setting);
  setBgStatus(`Using ${setting.name} (${setting.w}×${setting.h}).`);
});

$('#bg-reset').addEventListener('click', async () => {
  await chrome.storage.local.remove(BACKGROUND_KEY);
  applyBackground(null);
  setBgStatus('Background reset.');
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
  renderSwatches();
  await Promise.all([renderPinned(), renderSaved(), renderClosed(), renderDevices(), getBackground().then(applyBackground)]);
})();
