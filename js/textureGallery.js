/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Texture gallery: the always-visible favourites grid in the panel (4 wide, one row per 4 favourites)
// and the full-catalogue modal where users browse by category, search, pick a texture and star
// their own favourites. Favourites persist in localStorage by preset name.

import { IMAGE_PRESETS, PRESET_CATEGORIES, DEFAULT_FAVOURITES } from './presetTextures.js';
import { t } from './i18n.js';

const FAV_KEY = 'bumpmesh-favourites';
const CREDIT_BADGE = { hero: 'HP', cc0: 'CC0' };

function loadFavourites() {
  try {
    const raw = JSON.parse(localStorage.getItem(FAV_KEY));
    if (Array.isArray(raw)) {
      const known = raw.filter(n => typeof n === 'string' && IMAGE_PRESETS.some(p => p.name === n));
      return [...new Set(known)];
    }
  } catch { /* private mode or malformed value: fall back to defaults */ }
  return DEFAULT_FAVOURITES.slice();
}

function saveFavourites(favs) {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch { /* private mode */ }
}

/** A clickable thumbnail for preset `idx`. Carries data-preset-idx so active/loading state can be
 *  mirrored on every copy (panel + gallery). */
function makeSwatch(idx, onSelect) {
  const p = IMAGE_PRESETS[idx];
  const el = document.createElement('div');
  el.className = 'preset-swatch preset-loading';
  el.dataset.presetIdx = String(idx);
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.title = p.name;

  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.draggable = false;
  const loaded = () => el.classList.remove('preset-loading');
  img.addEventListener('load', loaded, { once: true });
  img.addEventListener('error', loaded, { once: true });
  img.src = p.thumb;
  el.appendChild(img);

  el.addEventListener('click', () => onSelect(idx));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(idx); }
  });
  return el;
}

/**
 * Wire the favourites grid, the gallery button and the gallery modal.
 * @param {{ onSelect: (idx: number) => void }} opts  called when the user picks a preset
 */
export function initTextureGallery({ onSelect }) {
  const panelGrid  = document.getElementById('preset-grid');
  const openBtn    = document.getElementById('texture-gallery-btn');
  const openCount  = document.getElementById('texture-gallery-count');
  const overlay    = document.getElementById('gallery-overlay');
  const closeBtn   = document.getElementById('gallery-close');
  const search     = document.getElementById('gallery-search');
  const chipsEl    = document.getElementById('gallery-chips');
  const favCountEl = document.getElementById('gallery-fav-count');
  const resetBtn   = document.getElementById('gallery-fav-reset');
  const body       = document.getElementById('gallery-body');

  let favourites = loadFavourites();
  let activeIdx = -1;
  let filter = 'all';            // 'all' | 'favourites' | category id
  let returnFocus = null;
  const loadingIdx = new Set();
  const tiles = new Map();       // idx -> { tile, star }

  const idxOf = (name) => IMAGE_PRESETS.findIndex(p => p.name === name);
  const isFav = (idx) => favourites.includes(IMAGE_PRESETS[idx].name);

  // ── Panel: favourites grid ──────────────────────────────────────────────
  function renderPanel() {
    panelGrid.innerHTML = '';
    const idxs = favourites.map(idxOf).filter(i => i >= 0);
    if (!idxs.length) {
      const empty = document.createElement('p');
      empty.className = 'preset-grid-empty';
      empty.dataset.i18n = 'ui.noFavourites';
      empty.textContent = t('ui.noFavourites');
      panelGrid.appendChild(empty);
    }
    for (const idx of idxs) {
      const sw = makeSwatch(idx, onSelect);
      const label = document.createElement('span');
      label.className = 'preset-label';
      label.textContent = IMAGE_PRESETS[idx].name;
      sw.appendChild(label);
      panelGrid.appendChild(sw);
    }
    syncState();
  }

  // ── Gallery modal ───────────────────────────────────────────────────────
  function buildTile(idx) {
    const p = IMAGE_PRESETS[idx];
    const tile = document.createElement('div');
    tile.className = 'gallery-tile';

    const sw = makeSwatch(idx, (i) => { onSelect(i); closeGallery(); });
    if (p.credit) {
      const badge = document.createElement('span');
      badge.className = 'gallery-badge';
      badge.textContent = CREDIT_BADGE[p.credit];
      sw.appendChild(badge);
      sw.title = p.name + (p.credit === 'hero' ? ' · Hero Patterns (CC BY 4.0)' : ' · CC0');
    }

    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'gallery-star';
    star.addEventListener('click', () => toggleFavourite(idx));

    const name = document.createElement('span');
    name.className = 'gallery-name';
    name.textContent = p.name;

    tile.append(sw, star, name);
    tiles.set(idx, { tile, star });
    return tile;
  }

  function paintStar(idx) {
    const { star } = tiles.get(idx);
    const on = isFav(idx);
    star.textContent = on ? '★' : '☆';
    star.setAttribute('aria-pressed', String(on));
    const label = t(on ? 'gallery.removeFavourite' : 'gallery.addFavourite');
    star.setAttribute('aria-label', `${label}: ${IMAGE_PRESETS[idx].name}`);
    star.title = label;
  }

  function buildChips() {
    chipsEl.innerHTML = '';
    const defs = [{ id: 'all', label: 'gallery.catAll' }, { id: 'favourites', label: 'gallery.catFavourites' },
                  ...PRESET_CATEGORIES];
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

  function section(titleKey, idxs, container) {
    if (titleKey) {
      const h = document.createElement('h3');
      h.className = 'gallery-section-title';
      h.textContent = `${t(titleKey)} (${idxs.length})`;
      container.appendChild(h);
    }
    const grid = document.createElement('div');
    grid.className = 'gallery-grid';
    for (const idx of idxs) grid.appendChild(tiles.get(idx).tile);
    container.appendChild(grid);
  }

  function renderGallery() {
    const q = search.value.trim().toLowerCase();
    const catLabel = Object.fromEntries(PRESET_CATEGORIES.map(c => [c.id, t(c.label).toLowerCase()]));
    const matches = (idx) => {
      const p = IMAGE_PRESETS[idx];
      return !q || p.name.toLowerCase().includes(q) || catLabel[p.category].includes(q);
    };
    body.innerHTML = '';
    const frag = document.createDocumentFragment();
    let shown = 0;
    if (filter === 'all' && !q) {
      for (const c of PRESET_CATEGORIES) {
        const idxs = IMAGE_PRESETS.map((p, i) => (p.category === c.id ? i : -1)).filter(i => i >= 0);
        if (idxs.length) { section(c.label, idxs, frag); shown += idxs.length; }
      }
    } else {
      const pool = filter === 'favourites' ? favourites.map(idxOf).filter(i => i >= 0)
        : IMAGE_PRESETS.map((p, i) => i).filter(i => filter === 'all' || IMAGE_PRESETS[i].category === filter);
      const idxs = pool.filter(matches);
      if (idxs.length) section(null, idxs, frag);
      shown = idxs.length;
    }
    if (!shown) {
      const empty = document.createElement('p');
      empty.className = 'gallery-empty';
      empty.textContent = t(filter === 'favourites' && !q ? 'ui.noFavourites' : 'gallery.noResults');
      frag.appendChild(empty);
    }
    body.appendChild(frag);
    syncState();
  }

  function updateCounts() {
    favCountEl.textContent = t('gallery.favCount', { n: favourites.length });
    openCount.textContent = String(IMAGE_PRESETS.length);
  }

  function toggleFavourite(idx) {
    const name = IMAGE_PRESETS[idx].name;
    favourites = isFav(idx) ? favourites.filter(n => n !== name) : [...favourites, name];
    saveFavourites(favourites);
    paintStar(idx);
    updateCounts();
    renderPanel();
    if (filter === 'favourites') renderGallery();
  }

  /** Mirror active + loading state onto every swatch copy. */
  function syncState() {
    document.querySelectorAll('.preset-swatch[data-preset-idx]').forEach(el => {
      const i = Number(el.dataset.presetIdx);
      el.classList.toggle('active', i === activeIdx);
      el.classList.toggle('preset-loading-full', loadingIdx.has(i));
    });
  }

  // Focus stays inside the dialog; the tile set changes with filters, so the focusable list is
  // recomputed on every Tab rather than captured once.
  function onDialogKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeGallery(); return; }
    if (e.key !== 'Tab') return;
    const f = [...overlay.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])')]
      .filter(el => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function openGallery() {
    returnFocus = document.activeElement;
    renderGallery();
    overlay.classList.remove('hidden');
    overlay.addEventListener('keydown', onDialogKey);
    search.focus();
    const active = body.querySelector('.preset-swatch.active');
    if (active) active.scrollIntoView({ block: 'center' });
  }

  function closeGallery() {
    if (overlay.classList.contains('hidden')) return;
    overlay.classList.add('hidden');
    overlay.removeEventListener('keydown', onDialogKey);
    if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
  }

  // ── Wiring ──────────────────────────────────────────────────────────────
  IMAGE_PRESETS.forEach((p, idx) => { buildTile(idx); paintStar(idx); });
  buildChips();
  refreshText();
  renderPanel();

  openBtn.addEventListener('click', openGallery);
  closeBtn.addEventListener('click', closeGallery);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeGallery(); });
  search.addEventListener('input', renderGallery);
  resetBtn.addEventListener('click', () => {
    favourites = DEFAULT_FAVOURITES.slice();
    saveFavourites(favourites);
    tiles.forEach((_, idx) => paintStar(idx));
    updateCounts();
    renderPanel();
    renderGallery();
  });

  /** Re-render the strings that carry parameters or live outside data-i18n (call after setLang). */
  function refreshText() {
    search.placeholder = t('gallery.search');
    search.setAttribute('aria-label', t('gallery.search'));
    updateCounts();
    tiles.forEach((_, idx) => paintStar(idx));
    if (!overlay.classList.contains('hidden')) renderGallery();
  }

  return {
    /** Highlight preset `idx` (or none with -1, e.g. while a custom map is active). */
    markActive(idx) { activeIdx = idx; syncState(); },
    /** Show or clear the loading spinner on preset `idx`. */
    setLoading(idx, on) { if (on) loadingIdx.add(idx); else loadingIdx.delete(idx); syncState(); },
    refreshText,
  };
}
