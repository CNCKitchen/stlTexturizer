/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Texture gallery: the always-visible favourites grid in the panel (4 wide, one row per 4 favourites)
// and the full-catalogue side panel where users browse by category, search, try textures on the
// model and star their own favourites. The side panel is non-modal and stays open while picks apply
// live (#132). Favourites and the turntable choice persist in localStorage. Uploaded maps are kept in
// a local library (js/customTextures.js) and listed under "Your textures", where they can be starred,
// downloaded again and deleted; the browser may evict that library at any time.

import { IMAGE_PRESETS, PRESET_CATEGORIES, DEFAULT_FAVOURITES } from './presetTextures.js';
import { listCustomTextures, saveCustomTexture, deleteCustomTexture, clearCustomTextures,
         downloadCustomTexture } from './customTextures.js';
import { t } from './i18n.js';

const FAV_KEY = 'bumpmesh-favourites';
const TURNTABLE_KEY = 'bumpmesh-gallery-turntable';
const CREDIT_BADGE = { hero: 'HP', cc0: 'CC0' };
const KEY_APPLY_DELAY_MS = 150;   // arrow-key browsing applies once the key rests, not per repeat
// Presets are keyed by name, the user's own textures by this prefix + library id. The key is also
// the favourites entry, so favourites saved before custom textures existed load unchanged.
const CUSTOM_PREFIX = 'custom:';
const CUSTOM_CATEGORY = { id: 'custom', label: 'gallery.catCustom' };

const ICON_DOWNLOAD = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';
const ICON_DELETE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
const ICON_UPLOAD = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12l7-7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

const isCustomKey = (key) => key.startsWith(CUSTOM_PREFIX);

/** Everything the gallery shows is an item: { key, name, thumb, category, credit?, idx | custom }. */
const PRESET_ITEMS = IMAGE_PRESETS.map((p, idx) => ({
  key: p.name, name: p.name, thumb: p.thumb, category: p.category, credit: p.credit, idx,
}));

function formatBytes(n) {
  return n < 1e6 ? `${Math.max(1, Math.round(n / 1e3))} KB` : `${(n / 1e6).toFixed(1)} MB`;
}

/** The turntable spins by default; switching it off sticks, and reduced-motion users start with it off. */
function turntableWanted() {
  let pref = null;
  try { pref = localStorage.getItem(TURNTABLE_KEY); } catch { /* private mode */ }
  if (pref != null) return pref === '1';
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function loadFavourites() {
  try {
    const raw = JSON.parse(localStorage.getItem(FAV_KEY));
    if (Array.isArray(raw)) {
      // Custom entries are checked against the library once it has loaded (see refreshCustoms).
      const known = raw.filter(k => typeof k === 'string' &&
        (isCustomKey(k) || IMAGE_PRESETS.some(p => p.name === k)));
      return [...new Set(known)];
    }
  } catch { /* private mode or malformed value: fall back to defaults */ }
  return DEFAULT_FAVOURITES.slice();
}

function saveFavourites(favs) {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch { /* private mode */ }
}

/** A clickable thumbnail for `item`. Carries data-key so active/loading state can be mirrored on
 *  every copy (panel + gallery). */
function makeSwatch(item, onPick) {
  const el = document.createElement('div');
  el.className = 'preset-swatch preset-loading';
  el.dataset.key = item.key;
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.title = item.title || item.name;

  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.draggable = false;
  const loaded = () => el.classList.remove('preset-loading');
  img.addEventListener('load', loaded, { once: true });
  img.addEventListener('error', loaded, { once: true });
  img.src = item.thumb;
  el.appendChild(img);

  el.addEventListener('click', () => onPick(item.key));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(item.key); }
  });
  return el;
}

/**
 * Wire the favourites grid, the gallery button and the gallery side panel.
 * @param {{ onSelect: (idx: number) => void,
 *           onSelectCustom: (id: string) => void,
 *           setTurntable: (on: boolean, onStop?: () => void) => void }} opts
 *   onSelect / onSelectCustom are called when the user picks a preset / one of their own textures;
 *   setTurntable spins the main viewport (onStop fires when the user takes over the view).
 */
export function initTextureGallery({ onSelect, onSelectCustom, setTurntable }) {
  const panelGrid  = document.getElementById('preset-grid');
  const openBtn    = document.getElementById('texture-gallery-btn');
  const openCount  = document.getElementById('texture-gallery-count');
  const panel      = document.getElementById('gallery-panel');
  const settings   = document.getElementById('settings-panel');
  const doneBtn    = document.getElementById('gallery-done');
  const spinBtn    = document.getElementById('gallery-turntable');
  const search     = document.getElementById('gallery-search');
  const chipsEl    = document.getElementById('gallery-chips');
  const favCountEl = document.getElementById('gallery-fav-count');
  const resetBtn   = document.getElementById('gallery-fav-reset');
  const body       = document.getElementById('gallery-body');

  let favourites = loadFavourites();
  let customs = [];              // library metadata, newest first
  let listOk = true;             // false while the browser won't let us read the library
  let saveOk = true;             // false after the browser refused to store an upload
  let activeKey = null;
  let pickedKey = null;          // last active preset that isn't a favourite; the panel shows it too
  let filter = 'all';            // 'all' | 'favourites' | 'custom' | category id
  let returnFocus = null;
  let settingsScroll = 0;        // the settings panel is display:none while open, which drops it
  let pendingKey = null;         // arrow-key pick waiting for the key to rest
  let pendingTimer = 0;
  let refreshSeq = 0;
  let customSig = null;          // what the last library listing looked like
  const loadingKeys = new Set();
  const items = new Map(PRESET_ITEMS.map(it => [it.key, it]));
  const tiles = new Map();       // key -> { tile, star }

  const isOpen = () => !panel.classList.contains('hidden');
  const shownFavourites = () => favourites.filter(k => items.has(k));
  const customKeys = () => customs.map(m => CUSTOM_PREFIX + m.id);

  function pick(key) {
    clearTimeout(pendingTimer);
    pendingKey = null;
    const item = items.get(key);
    if (!item) return;
    if (item.custom) onSelectCustom(item.custom.id);
    else onSelect(item.idx);
  }

  function pickSoon(key) {
    clearTimeout(pendingTimer);
    pendingKey = key;
    pendingTimer = setTimeout(() => pick(key), KEY_APPLY_DELAY_MS);
  }

  // ── Panel: favourites grid ──────────────────────────────────────────────
  function renderPanel() {
    panelGrid.innerHTML = '';
    const keys = shownFavourites();
    // A preset picked in the gallery gets a tile after the favourites, so the panel always shows
    // what is on the model. It stays until another non-favourite pick replaces it.
    if (pickedKey && !keys.includes(pickedKey)) keys.push(pickedKey);
    if (!keys.length) {
      const empty = document.createElement('p');
      empty.className = 'preset-grid-empty';
      empty.dataset.i18n = 'ui.noFavourites';
      empty.textContent = t('ui.noFavourites');
      panelGrid.appendChild(empty);
    }
    for (const key of keys) {
      const item = items.get(key);
      const sw = makeSwatch(item, pick);
      const label = document.createElement('span');
      label.className = 'preset-label';
      label.textContent = item.name;
      sw.appendChild(label);
      panelGrid.appendChild(sw);
    }
    syncState();
  }

  // ── Gallery side panel ──────────────────────────────────────────────────
  function toolButton(kind, icon, labelKey, name, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `gallery-tool gallery-tool-${kind}`;
    b.innerHTML = icon;
    b.title = t(labelKey);
    b.setAttribute('aria-label', `${t(labelKey)}: ${name}`);
    b.addEventListener('click', onClick);
    return b;
  }

  function buildTile(item) {
    const tile = document.createElement('div');
    tile.className = 'gallery-tile';

    const sw = makeSwatch(item, pick);
    if (item.credit) {
      const badge = document.createElement('span');
      badge.className = 'gallery-badge';
      badge.textContent = CREDIT_BADGE[item.credit];
      sw.appendChild(badge);
      sw.title = item.name + (item.credit === 'hero' ? ' · Hero Patterns (CC BY 4.0)' : ' · CC0');
    }

    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'gallery-star';
    star.addEventListener('click', () => toggleFavourite(item.key));

    const name = document.createElement('span');
    name.className = 'gallery-name';
    name.textContent = item.name;

    tile.append(sw, star, name);
    if (item.custom) {
      tile.append(
        toolButton('download', ICON_DOWNLOAD, 'gallery.downloadCustom', item.custom.name, () => downloadCustom(item.custom)),
        toolButton('delete', ICON_DELETE, 'gallery.deleteCustom', item.custom.name, () => deleteCustom(item.custom)),
      );
    }
    tiles.set(item.key, { tile, star });
    paintStar(item.key);
  }

  function paintStar(key) {
    const { star } = tiles.get(key);
    const on = favourites.includes(key);
    star.textContent = on ? '★' : '☆';
    star.setAttribute('aria-pressed', String(on));
    const label = t(on ? 'gallery.removeFavourite' : 'gallery.addFavourite');
    star.setAttribute('aria-label', `${label}: ${items.get(key).name}`);
    star.title = label;
  }

  function buildChips() {
    chipsEl.innerHTML = '';
    const defs = [{ id: 'all', label: 'gallery.catAll' }, { id: 'favourites', label: 'gallery.catFavourites' },
                  CUSTOM_CATEGORY, ...PRESET_CATEGORIES];
    for (const d of defs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'gallery-chip';
      b.dataset.filter = d.id;
      b.dataset.i18n = d.label;
      b.textContent = t(d.label);
      b.setAttribute('aria-pressed', String(d.id === filter));
      b.addEventListener('click', () => {
        filter = d.id;
        chipsEl.querySelectorAll('.gallery-chip').forEach(c => c.setAttribute('aria-pressed', String(c === b)));
        renderGallery();
      });
      chipsEl.appendChild(b);
    }
  }

  function grid(keys, container) {
    const g = document.createElement('div');
    g.className = 'gallery-grid';
    for (const key of keys) g.appendChild(tiles.get(key).tile);
    container.appendChild(g);
  }

  function section(titleKey, keys, container) {
    if (titleKey) {
      const h = document.createElement('h3');
      h.className = 'gallery-section-title';
      h.textContent = `${t(titleKey)} (${keys.length})`;
      container.appendChild(h);
    }
    grid(keys, container);
  }

  /** "Your textures": count, size and Delete all, the local-storage caveat, then the tiles. */
  function customSection(keys, container) {
    const head = document.createElement('div');
    head.className = 'gallery-section-head';
    const h = document.createElement('h3');
    h.className = 'gallery-section-title';
    const bytes = customs.reduce((sum, m) => sum + (m.size || 0), 0);
    h.textContent = `${t('gallery.customTitle')} (${customs.length})` + (customs.length ? ` · ${formatBytes(bytes)}` : '');
    head.appendChild(h);
    if (customs.length) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'gallery-link-btn gallery-danger-link';
      clear.textContent = t('gallery.deleteAllCustom');
      clear.addEventListener('click', deleteAllCustom);
      head.appendChild(clear);
    }
    container.appendChild(head);

    const stored = listOk && saveOk;
    const note = document.createElement('p');
    note.className = 'gallery-custom-note' + (stored ? '' : ' gallery-custom-note-warn');
    note.textContent = t(stored ? 'gallery.customNote' : 'gallery.customUnavailable');
    container.appendChild(note);

    if (keys.length) {
      grid(keys, container);
    } else if (!customs.length) {
      const empty = document.createElement('div');
      empty.className = 'gallery-custom-empty';
      const text = document.createElement('p');
      text.textContent = t('gallery.customEmpty');
      const upload = document.createElement('label');
      upload.className = 'upload-btn';
      upload.htmlFor = 'texture-file-input';
      upload.innerHTML = ICON_UPLOAD;
      const span = document.createElement('span');
      span.textContent = t('ui.uploadCustomMap');
      upload.appendChild(span);
      empty.append(text, upload);
      container.appendChild(empty);
    } else {
      container.appendChild(emptyNote('gallery.noResults'));
    }
  }

  function emptyNote(key) {
    const p = document.createElement('p');
    p.className = 'gallery-empty';
    p.textContent = t(key);
    return p;
  }

  function renderGallery() {
    const q = search.value.trim().toLowerCase();
    const catLabel = Object.fromEntries([...PRESET_CATEGORIES, CUSTOM_CATEGORY]
      .map(c => [c.id, t(c.label).toLowerCase()]));
    const matches = (key) => {
      const item = items.get(key);
      return !q || item.name.toLowerCase().includes(q) || catLabel[item.category].includes(q);
    };
    body.innerHTML = '';
    const frag = document.createDocumentFragment();
    if (filter === 'custom') {
      customSection(customKeys().filter(matches), frag);
    } else {
      let shown = 0;
      if (filter === 'all' && !q) {
        const own = customKeys();
        if (own.length) { customSection(own, frag); shown += own.length; }
        for (const c of PRESET_CATEGORIES) {
          const keys = PRESET_ITEMS.filter(it => it.category === c.id).map(it => it.key);
          if (keys.length) { section(c.label, keys, frag); shown += keys.length; }
        }
      } else {
        const pool = filter === 'favourites' ? shownFavourites()
          : filter === 'all' ? [...customKeys(), ...PRESET_ITEMS.map(it => it.key)]
          : PRESET_ITEMS.filter(it => it.category === filter).map(it => it.key);
        const keys = pool.filter(matches);
        if (keys.length) section(null, keys, frag);
        shown = keys.length;
      }
      if (!shown) frag.appendChild(emptyNote(filter === 'favourites' && !q ? 'ui.noFavourites' : 'gallery.noResults'));
    }
    body.appendChild(frag);
    syncState();
  }

  function updateCounts() {
    favCountEl.textContent = t('gallery.favCount', { n: shownFavourites().length });
    openCount.textContent = String(IMAGE_PRESETS.length + customs.length);
  }

  function toggleFavourite(key) {
    favourites = favourites.includes(key) ? favourites.filter(k => k !== key) : [...favourites, key];
    syncPicked();
    saveFavourites(favourites);
    paintStar(key);
    updateCounts();
    renderPanel();
    if (filter === 'favourites') renderGallery();
  }

  /** Starring the picked tile makes it a regular favourite. When the preset on the model is not a
   *  favourite (picked in the gallery, un-starred, favourites reset), it takes the picked tile. */
  function syncPicked() {
    if (pickedKey && favourites.includes(pickedKey)) pickedKey = null;
    if (activeKey && !isCustomKey(activeKey) && !favourites.includes(activeKey)) pickedKey = activeKey;
  }

  /** Mirror active + loading state onto every swatch copy. */
  function syncState() {
    document.querySelectorAll('.preset-swatch[data-key]').forEach(el => {
      el.classList.toggle('active', el.dataset.key === activeKey);
      el.classList.toggle('preset-loading-full', loadingKeys.has(el.dataset.key));
    });
  }

  function setLoadingKey(key, on) {
    if (on) loadingKeys.add(key); else loadingKeys.delete(key);
    syncState();
  }

  // ── Your textures (local library) ───────────────────────────────────────
  /** Replace the custom items and their tiles with the current library listing. */
  function rebuildCustomItems() {
    for (const key of [...items.keys()]) {
      if (isCustomKey(key)) { items.delete(key); tiles.delete(key); }
    }
    for (const m of customs) {
      const item = {
        key: CUSTOM_PREFIX + m.id,
        name: m.name.replace(/\.[a-z0-9]{1,8}$/i, '') || m.name,   // drop .png / .texture
        title: `${m.name} · ${formatBytes(m.size || 0)}`,
        thumb: m.thumb, category: CUSTOM_CATEGORY.id, custom: m,
      };
      items.set(item.key, item);
      buildTile(item);
    }
  }

  /** Re-read the library — the browser may have evicted it since — and redraw what depends on it. */
  async function refreshCustoms() {
    const seq = ++refreshSeq;
    let list = [], ok = true;
    try {
      list = await listCustomTextures();
    } catch (err) {
      console.warn('Custom texture storage unavailable:', err);
      ok = false;
    }
    if (seq !== refreshSeq) return;   // a newer refresh owns the result
    const sig = `${ok}|` + list.map(m => `${m.id}@${m.added}`).join(',');
    if (sig === customSig) return;    // unchanged: leave the open gallery (and its focus) alone
    customSig = sig;
    customs = list;
    listOk = ok;
    rebuildCustomItems();
    if (ok) {
      // Drop favourites whose texture was deleted or evicted.
      const kept = favourites.filter(k => !isCustomKey(k) || items.has(k));
      if (kept.length !== favourites.length) { favourites = kept; saveFavourites(favourites); }
    }
    updateCounts();
    renderPanel();
    if (isOpen()) renderGallery();
  }

  /** Keep an uploaded map in the library. Resolves to its id, or null if the browser refused. */
  async function rememberUpload(file, canvas) {
    try {
      const meta = await saveCustomTexture(file, canvas);
      saveOk = true;
      await refreshCustoms();
      return meta.id;
    } catch (err) {
      console.warn('Could not keep a local copy of the texture:', err);
      saveOk = false;
      if (isOpen()) renderGallery();
      return null;
    }
  }

  async function downloadCustom(meta) {
    if (await downloadCustomTexture(meta.id)) return;
    alert(t('alerts.customTextureMissing'));
    refreshCustoms();
  }

  async function deleteCustom(meta) {
    if (!confirm(t('gallery.confirmDeleteCustom', { name: meta.name }))) return;
    try { await deleteCustomTexture(meta.id); } catch (err) { console.warn('Could not delete custom texture:', err); }
    await refreshCustoms();
  }

  async function deleteAllCustom() {
    if (!confirm(t('gallery.confirmDeleteAllCustom', { n: customs.length }))) return;
    try { await clearCustomTextures(); } catch (err) { console.warn('Could not delete custom textures:', err); }
    await refreshCustoms();
  }

  /** The swatch an arrow key leads to from `from`: Left/Right follow reading order, Up/Down take the
   *  nearest row in that direction (across category sections) and the closest column in it. */
  function neighbour(from, key) {
    const all = [...body.querySelectorAll('.preset-swatch')];
    const i = all.indexOf(from);
    if (key === 'ArrowLeft') return all[i - 1];
    if (key === 'ArrowRight') return all[i + 1];
    const r = from.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    let best = null, bestGap = Infinity, bestDx = Infinity;
    for (const el of all) {
      const b = el.getBoundingClientRect();
      const gap = key === 'ArrowDown' ? b.top - r.bottom : r.top - b.bottom;
      if (gap < 0) continue;   // same row, or the wrong direction
      const dx = Math.abs(b.left + b.width / 2 - cx);
      if (gap < bestGap - 1 || (gap <= bestGap + 1 && dx < bestDx)) {
        best = el; bestGap = Math.min(gap, bestGap); bestDx = dx;
      }
    }
    return best;
  }

  function onBodyKey(e) {
    if (!e.key.startsWith('Arrow') || e.altKey || e.ctrlKey || e.metaKey) return;
    const from = e.target.closest?.('.preset-swatch');
    if (!from) return;
    e.preventDefault();
    const next = neighbour(from, e.key);
    if (!next) return;
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest' });
    pickSoon(next.dataset.key);
  }

  // ── Turntable ───────────────────────────────────────────────────────────
  function setSpin(on) {
    spinBtn.setAttribute('aria-pressed', String(on));
    setTurntable(on, () => spinBtn.setAttribute('aria-pressed', 'false'));
  }

  // ── Open / close ────────────────────────────────────────────────────────
  function openGallery() {
    if (isOpen()) return;
    returnFocus = document.activeElement;
    settingsScroll = settings.scrollTop;
    renderGallery();
    panel.parentElement.classList.add('gallery-open');
    panel.classList.remove('hidden');
    search.focus({ preventScroll: true });
    const active = body.querySelector('.preset-swatch.active');
    if (active) active.scrollIntoView({ block: 'center' });
    if (turntableWanted()) setSpin(true);
    refreshCustoms();
  }

  function closeGallery() {
    if (!isOpen()) return;
    if (pendingKey) pick(pendingKey);   // don't drop a pick the arrow keys just made
    setSpin(false);
    panel.classList.add('hidden');
    panel.parentElement.classList.remove('gallery-open');
    settings.scrollTop = settingsScroll;
    if (returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
  }

  // Non-modal, so Escape is heard document-wide — except inside a popup that sits above the gallery,
  // and in a search box that still has text (the browser clears it first).
  function onDocKey(e) {
    if (e.key !== 'Escape' || !isOpen()) return;
    if (e.target.closest?.('[aria-modal="true"]')) return;
    if (e.target === search && search.value) return;
    closeGallery();
  }

  // ── Wiring ──────────────────────────────────────────────────────────────
  PRESET_ITEMS.forEach(buildTile);
  buildChips();
  refreshText();
  renderPanel();
  refreshCustoms();

  openBtn.addEventListener('click', openGallery);
  doneBtn.addEventListener('click', closeGallery);
  document.addEventListener('keydown', onDocKey);
  body.addEventListener('keydown', onBodyKey);
  spinBtn.addEventListener('click', () => {
    const on = spinBtn.getAttribute('aria-pressed') !== 'true';
    try { localStorage.setItem(TURNTABLE_KEY, on ? '1' : '0'); } catch { /* private mode */ }
    setSpin(on);
  });
  search.addEventListener('input', renderGallery);
  // ArrowDown hops from the search box into the results, starting at the active texture.
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown') return;
    const target = body.querySelector('.preset-swatch.active') || body.querySelector('.preset-swatch');
    if (!target) return;
    e.preventDefault();
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest' });
  });
  resetBtn.addEventListener('click', () => {
    favourites = DEFAULT_FAVOURITES.slice();
    syncPicked();
    saveFavourites(favourites);
    tiles.forEach((_, key) => paintStar(key));
    updateCounts();
    renderPanel();
    renderGallery();
  });

  /** Re-render the strings that carry parameters or live outside data-i18n (call after setLang). */
  function refreshText() {
    search.placeholder = t('gallery.search');
    search.setAttribute('aria-label', t('gallery.search'));
    rebuildCustomItems();   // their tool buttons carry translated labels
    updateCounts();
    tiles.forEach((_, key) => paintStar(key));
    if (isOpen()) renderGallery();
  }

  return {
    /** Highlight preset `idx` (or none with -1, e.g. while a custom map is active). */
    markActive(idx) {
      activeKey = idx >= 0 ? IMAGE_PRESETS[idx].name : null;
      const before = pickedKey;
      syncPicked();
      if (pickedKey !== before) renderPanel(); else syncState();
    },
    /** Highlight the user's texture `id` from the library (none for a falsy id). */
    markActiveCustom(id) { activeKey = id ? CUSTOM_PREFIX + id : null; syncState(); },
    /** Show or clear the loading spinner on preset `idx`. */
    setLoading(idx, on) { setLoadingKey(IMAGE_PRESETS[idx].name, on); },
    /** Show or clear the loading spinner on the user's texture `id`. */
    setCustomLoading(id, on) { setLoadingKey(CUSTOM_PREFIX + id, on); },
    rememberUpload,
    refreshCustoms,
    refreshText,
  };
}
