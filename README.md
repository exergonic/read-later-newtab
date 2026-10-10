# Read Later New Tab

A minimal Brave/Chrome extension that replaces the new tab page with your
pinned sites and your read-later list. No accounts, no cloud, no analytics.

## What it does

Four rows on every new tab.

**1. Pinned tiles.** A grid of site icons, the way Brave's own new tab works.
Click a tile to open it, ✕ (on hover) to unpin it, drag a tile to reorder it —
the order persists. Add a site with **Add site** below the grid, or right-click
any page → **Pin to new tab tiles**. Icons come from Chrome's own favicon
cache; see *Privacy* for what that means.

**2. Read later.** Pages you save yourself. Right-click any page or link →
**Save page to read later**, press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>
(<kbd>⌘</kbd><kbd>⇧</kbd><kbd>E</kbd> on Mac), or paste a URL into the box. Click
a title to open it, ✕ to dismiss. Items older than 7 days get a gentle "still
interested?" nudge. Saving from any page raises a short system notification
showing the site's name and favicon, so you get confirmation without having to
open the new tab.

**3. Recently closed.** Closed tabs land here automatically, so you can close
freely instead of hoarding tabs. ↺ reopens the tab, ✕ dismisses it. Dismisses
persist across new tabs.

**4. From your other devices.** Tabs open on your synced devices (e.g. your
phone) show up here, via Brave Sync. On mobile, just leave the tab open; it
appears on your desktop new tab page. Requires Brave Sync with tab syncing on.
**Note:** dismisses in this lane are not persisted — they reset when you open a
new tab.

## Install

1. Open `brave://extensions` (or `chrome://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open a new tab — that's it.

If you edit any file after that, click **Reload** on the extension card, or the
change will not take effect.

Optional: set the keyboard shortcut at `brave://extensions/shortcuts`. It
defaults to Ctrl+Shift+E / ⌘⇧E, chosen because Ctrl+Shift+S and ⌘⇧S are both
already taken by screenshots. Confirm it on that page — Brave's own shortcuts
cannot be enumerated from a manifest, so if Ctrl+Shift+E collides on your setup,
assign your own there. **Warning:** editing `suggested_key` in `manifest.json`
with an unaccepted combination (e.g. `Alt+Command+S`) makes the manifest
invalid and the extension silently stops loading.

## Privacy

- Storage is `chrome.storage.local` — on your disk, nowhere else.
- **The extension itself makes no network requests.** There is no analytics, no
  tracking, and no third-party favicon service.
- **Favicons are resolved by Chrome, not by this extension.** Tiles use the
  browser's built-in `_favicon/` endpoint, which serves from Chrome's own icon
  cache. The extension makes no request of its own. Two honest caveats: Chrome
  may fetch an icon from the site if it does not already have it cached (exactly
  as it does for any tab you visit), and Chrome shows a generic globe for sites
  it has no icon for.
- "From your other devices" reads tabs Brave Sync already syncs; nothing new
  leaves your machine because of this extension.
- Permissions requested and why: `storage` (your lists), `tabs` (read the
  current page's URL and title when you pin or save it), `contextMenus` (the
  right-click entries), `sessions` (Recently closed + synced device tabs),
  `favicon` (site icons in the tile grid and in the save notification),
  `notifications` (the "added to Read Later" confirmation).

## Files

- `manifest.json` — MV3 manifest, new-tab override, context menus, shortcut,
  permissions.
- `background.js` — service worker: context-menu entries + shortcut → storage.
- `newtab.html` / `newtab.css` / `newtab.js` — the new tab page.

## Known rough edges

- The save notification is a `chrome.notifications` basic notification, so the
  browser will auto-dismiss it after a few seconds and Windows may group or
  suppress it under Focus Assist. Chrome rejects `data:` URLs for a
  notification's `iconUrl`, so it uses the `_favicon/` endpoint instead. Because
  Chrome ties the OS toast identity to the notification id, each save uses a
  fresh id (and clears the previous notification); a fixed id would pop only
  once, then update the entry already in the notification center silently.
- Dismisses in the "other devices" lane do not persist.
- `MAX_ITEMS` (200) is duplicated in `background.js` and `newtab.js`; the two
  caps could drift apart if one is edited.
- A tile's label is derived from the page title or hostname and clipped to 28
  characters, so long titles are abbreviated.