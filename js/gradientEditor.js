/**
 * gradientEditor.js — N-stop gradient editor widget (Unit D).
 *
 * `class GradientEditor` provides:
 *   .mount(containerEl)
 *   .setStops([{pos: 0..1, color: '#RRGGBB'}, ...])
 *   .getStops() → array (deep copy)
 *   .onChange(cb)        cb(stops) fires whenever stops mutate
 *
 * Interaction model:
 *   - Click empty area on bar      → add stop (with interpolated color)
 *   - Click stop                   → select it
 *   - Drag stop horizontally       → move stop, resort by position, emit change
 *   - Drag stop vertically beyond
 *     a threshold                  → remove stop (≥2 enforced)
 *   - Right-click a stop           → remove stop (≥2 enforced)
 *   - Selected stop's color edited
 *     via the adjacent native
 *     <input type="color">         → emit change
 *
 * Self-contained: zero global state, pointer events scoped to the container.
 *
 * Also exports `wireColorSectionVisibility()` — a small helper that toggles
 * the per-source sub-section visibility via a `data-source` attribute on the
 * #color-section container. This is the only side-channel by which Unit D's
 * UI controls visibility without main.js edits — main.js's wireColorPaintUI
 * already mirrors `settings.colorAutoSource` into the radio buttons; we just
 * propagate that into a CSS-driven attribute on the section.
 */

const REMOVE_DRAG_THRESHOLD_PX = 32;       // vertical drag distance to remove a stop
const STOP_HANDLE_SIZE_PX     = 16;
const BAR_HEIGHT_PX           = 24;

function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

function parseHex(hex) {
  // Accept '#rgb', '#rrggbb'; return [r, g, b] in 0..255.
  if (typeof hex !== 'string') return [0, 0, 0];
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (h.length !== 6) return [0, 0, 0];
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(r, g, b) {
  const c = (n) => {
    const v = Math.max(0, Math.min(255, Math.round(n))).toString(16);
    return v.length === 1 ? '0' + v : v;
  };
  return '#' + c(r) + c(g) + c(b);
}

function lerpColor(a, b, t) {
  const ca = parseHex(a), cb = parseHex(b);
  return toHex(
    ca[0] + (cb[0] - ca[0]) * t,
    ca[1] + (cb[1] - ca[1]) * t,
    ca[2] + (cb[2] - ca[2]) * t,
  );
}

/** Sample the gradient at position p ∈ [0,1] from a sorted stops array. */
function sampleAt(stops, p) {
  if (!stops.length) return '#000000';
  if (p <= stops[0].pos) return stops[0].color;
  if (p >= stops[stops.length - 1].pos) return stops[stops.length - 1].color;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    if (p >= a.pos && p <= b.pos) {
      const span = b.pos - a.pos;
      const t = span > 1e-9 ? (p - a.pos) / span : 0;
      return lerpColor(a.color, b.color, t);
    }
  }
  return stops[stops.length - 1].color;
}

/**
 * Defensive normalization: clamp positions, enforce ≥2 stops, sort by position.
 * Returns a NEW array; never mutates input.
 */
function normalizeStops(input) {
  let stops = Array.isArray(input)
    ? input
        .filter(s => s && typeof s === 'object')
        .map(s => ({
          pos:   clamp01(typeof s.pos === 'number' ? s.pos : 0),
          color: (typeof s.color === 'string' ? s.color : '#888888'),
          // `lockedToBase` ties this stop's color to the user's base-color
          // setting. The editor displays it with a lock indicator and skips
          // color-input edits for it. Stored on the stop so it persists
          // through .bumpmesh / undo / sessionStorage round-trips.
          lockedToBase: !!s.lockedToBase,
        }))
    : [];
  // Ensure ≥2 stops; pad with sensible defaults at endpoints.
  if (stops.length === 0) {
    stops = [
      { pos: 0, color: '#222222', lockedToBase: false },
      { pos: 1, color: '#dddddd', lockedToBase: false },
    ];
  } else if (stops.length === 1) {
    const only = stops[0];
    if (only.pos < 1) stops.push({ pos: 1, color: only.color, lockedToBase: false });
    else stops.unshift({ pos: 0, color: only.color, lockedToBase: false });
  }
  stops.sort((a, b) => a.pos - b.pos);
  return stops;
}

export class GradientEditor {
  constructor() {
    this._stops = normalizeStops([]);
    this._onChange = null;
    this._onSelect = null;         // callback for selection changes (stop-props panel)
    this._mountEl = null;
    this._barEl = null;
    this._stopsLayerEl = null;
    this._selectedIdx = 0;
    this._dragState = null;        // { idx, startX, startY, startPos, removed }
    this._suppressEmit = false;

    // Bound handlers for cleanup-friendly attachment.
    this._onBarPointerDown = this._onBarPointerDown.bind(this);
    this._onWindowPointerMove = this._onWindowPointerMove.bind(this);
    this._onWindowPointerUp = this._onWindowPointerUp.bind(this);
  }

  mount(containerEl) {
    if (!containerEl) return;
    this._mountEl = containerEl;
    containerEl.classList.add('gradient-editor');
    containerEl.innerHTML = '';

    // Bar + handles. The selected stop's color/position/lock are now edited
    // in a separate properties panel owned by the orchestrator (main.js),
    // not in a floating color input.
    const barWrap = document.createElement('div');
    barWrap.className = 'gradient-bar-wrap';

    const bar = document.createElement('div');
    bar.className = 'gradient-bar';
    bar.style.height = BAR_HEIGHT_PX + 'px';
    bar.addEventListener('pointerdown', this._onBarPointerDown);
    // Suppress browser default contextmenu on the bar (right-click → remove).
    bar.addEventListener('contextmenu', (ev) => ev.preventDefault());

    const stopsLayer = document.createElement('div');
    stopsLayer.className = 'gradient-stops-layer';

    barWrap.appendChild(bar);
    barWrap.appendChild(stopsLayer);
    containerEl.appendChild(barWrap);

    this._barEl = bar;
    this._stopsLayerEl = stopsLayer;

    this._render();
    this._notifySelect();
  }

  setStops(stops) {
    this._stops = normalizeStops(stops);
    if (this._selectedIdx >= this._stops.length) this._selectedIdx = 0;
    this._render();
    this._notifySelect();
    // setStops is "external apply"; do NOT emit change to avoid feedback loops.
  }

  // ─── Public API used by the stop-properties panel (main.js) ────────────

  /** Returns the currently-selected stop index, or -1 if none. */
  getSelectedIdx() {
    return (this._selectedIdx >= 0 && this._selectedIdx < this._stops.length)
      ? this._selectedIdx : -1;
  }

  /** Returns a deep copy of the currently-selected stop, or null. */
  getSelectedStop() {
    const i = this.getSelectedIdx();
    if (i < 0) return null;
    const s = this._stops[i];
    return { pos: s.pos, color: s.color, lockedToBase: !!s.lockedToBase };
  }

  /** Set selectedIdx, clamped. Emits select but not change. */
  setSelectedIdx(idx) {
    if (!Number.isInteger(idx)) return;
    const next = Math.max(0, Math.min(idx, this._stops.length - 1));
    if (next === this._selectedIdx) return;
    this._selectedIdx = next;
    this._render();
    this._notifySelect();
  }

  /** Edit the selected stop's color. Auto-unlocks if it was locked. */
  setSelectedColor(hex) {
    const i = this.getSelectedIdx();
    if (i < 0 || typeof hex !== 'string') return;
    const s = this._stops[i];
    if (s.color === hex && !s.lockedToBase) return;
    if (s.lockedToBase) s.lockedToBase = false;
    s.color = hex;
    this._render();
    this._notifySelect();
    this._emitChange();
  }

  /** Edit the selected stop's position (0..1). Resorts and updates index. */
  setSelectedPos(pos) {
    const i = this.getSelectedIdx();
    if (i < 0 || typeof pos !== 'number' || !Number.isFinite(pos)) return;
    const s = this._stops[i];
    const np = clamp01(pos);
    if (s.pos === np) return;
    s.pos = np;
    const ref = s;
    this._stops.sort((a, b) => a.pos - b.pos);
    this._selectedIdx = this._stops.indexOf(ref);
    if (this._selectedIdx < 0) this._selectedIdx = 0;
    this._render();
    this._notifySelect();
    this._emitChange();
  }

  /** Toggle / set the selected stop's lockedToBase. When locking, color snaps to base. */
  setSelectedLocked(locked) {
    const i = this.getSelectedIdx();
    if (i < 0) return;
    const s = this._stops[i];
    const next = !!locked;
    if (s.lockedToBase === next) return;
    s.lockedToBase = next;
    if (next && typeof this._baseColor === 'string') s.color = this._baseColor;
    this._render();
    this._notifySelect();
    this._emitChange();
  }

  /** Remove the currently-selected stop. Refuses if it would leave < 2 stops. */
  removeSelected() {
    this._removeStopAt(this._selectedIdx);
  }

  /** Restore a sensible 2-stop greyscale default. */
  resetToDefault() {
    this._stops = normalizeStops([
      { pos: 0, color: '#222222' },
      { pos: 1, color: '#dddddd' },
    ]);
    this._selectedIdx = 0;
    this._render();
    this._notifySelect();
    this._emitChange();
  }

  /** Register a selection callback (called whenever the selected stop changes). */
  onSelect(cb) { this._onSelect = typeof cb === 'function' ? cb : null; }

  getStops() {
    return this._stops.map(s => ({
      pos: s.pos,
      color: s.color,
      lockedToBase: !!s.lockedToBase,
    }));
  }

  onChange(cb) {
    this._onChange = typeof cb === 'function' ? cb : null;
  }

  /**
   * Set the base color used by stops with `lockedToBase: true`. Called by the
   * orchestrator (main.js) whenever the user changes the base-color picker.
   * Updates locked stops in-place and re-renders. Emits a change event iff
   * any locked stop's color actually moved.
   */
  setBaseColor(hex) {
    if (typeof hex !== 'string') return;
    this._baseColor = hex;
    let mutated = false;
    for (const s of this._stops) {
      if (s.lockedToBase && s.color !== hex) {
        s.color = hex;
        mutated = true;
      }
    }
    this._render();
    if (mutated) this._emitChange();
  }

  // ─── Internal: rendering ───────────────────────────────────────────────

  _render() {
    if (!this._barEl || !this._stopsLayerEl) return;
    // Build the CSS background gradient.
    const sortedCopy = this._stops.slice().sort((a, b) => a.pos - b.pos);
    const css = sortedCopy
      .map(s => `${s.color} ${(s.pos * 100).toFixed(2)}%`)
      .join(', ');
    this._barEl.style.background = `linear-gradient(to right, ${css})`;

    // Stops layer: clear and rebuild.
    this._stopsLayerEl.innerHTML = '';
    for (let i = 0; i < this._stops.length; i++) {
      const stop = this._stops[i];
      const handle = document.createElement('div');
      handle.className = 'gradient-stop-handle';
      if (i === this._selectedIdx) handle.classList.add('selected');
      if (stop.lockedToBase) handle.classList.add('locked-to-base');
      handle.style.left = (stop.pos * 100) + '%';
      handle.style.width = STOP_HANDLE_SIZE_PX + 'px';
      handle.style.height = STOP_HANDLE_SIZE_PX + 'px';
      handle.style.background = stop.color;
      handle.dataset.idx = String(i);
      handle.title = stop.lockedToBase
        ? `${(stop.pos * 100).toFixed(0)}% — locked to base color (${stop.color}). Alt-click to unlock.`
        : `${(stop.pos * 100).toFixed(0)}% — ${stop.color}. Alt-click to lock to base color.`;
      handle.addEventListener('pointerdown', (ev) => this._onStopPointerDown(ev, i));
      handle.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        this._removeStopAt(i);
      });
      this._stopsLayerEl.appendChild(handle);
    }

  }

  _notifySelect() {
    if (typeof this._onSelect === 'function') {
      try { this._onSelect(this.getSelectedStop(), this.getSelectedIdx()); }
      catch (err) { console.warn('GradientEditor onSelect threw:', err); }
    }
  }

  _emitChange() {
    if (this._suppressEmit) return;
    if (typeof this._onChange === 'function') {
      try { this._onChange(this.getStops()); }
      catch (err) { console.warn('GradientEditor onChange threw:', err); }
    }
  }

  // ─── Internal: pointer interaction ─────────────────────────────────────

  _xToPos(clientX) {
    const rect = this._barEl.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return clamp01((clientX - rect.left) / rect.width);
  }

  _onBarPointerDown(ev) {
    // Only main button. Right-click on empty bar is a no-op.
    if (ev.button !== 0) return;
    // If the actual click landed on a handle, the handle's own listener will
    // run first; we still get this event because handles are on a sibling
    // layer. Ignore if the event came from a handle.
    if (ev.target && ev.target.classList && ev.target.classList.contains('gradient-stop-handle')) return;
    ev.preventDefault();
    const pos = this._xToPos(ev.clientX);
    const color = sampleAt(this._stops.slice().sort((a, b) => a.pos - b.pos), pos);
    this._stops.push({ pos, color });
    this._stops.sort((a, b) => a.pos - b.pos);
    this._selectedIdx = this._stops.findIndex(s => s.pos === pos && s.color === color);
    if (this._selectedIdx < 0) this._selectedIdx = 0;
    this._render();
    this._notifySelect();
    this._emitChange();
  }

  _onStopPointerDown(ev, idx) {
    if (ev.button === 2) {
      // Right-click handled by contextmenu listener.
      return;
    }
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();

    // Alt-click toggles "locked to base color" for this stop. When locking,
    // the stop's color snaps to the current base color immediately.
    if (ev.altKey) {
      const s = this._stops[idx];
      if (!s) return;
      s.lockedToBase = !s.lockedToBase;
      if (s.lockedToBase && typeof this._baseColor === 'string') {
        s.color = this._baseColor;
      }
      this._selectedIdx = idx;
      this._render();
      this._notifySelect();
      this._emitChange();
      return;
    }

    this._selectedIdx = idx;
    this._render();
    this._notifySelect();
    // Begin drag.
    this._dragState = {
      idx,
      startX: ev.clientX,
      startY: ev.clientY,
      startPos: this._stops[idx].pos,
      removed: false,
      moved: false,
    };
    window.addEventListener('pointermove', this._onWindowPointerMove);
    window.addEventListener('pointerup', this._onWindowPointerUp);
  }

  _onWindowPointerMove(ev) {
    const ds = this._dragState;
    if (!ds) return;
    ev.preventDefault();
    const dy = ev.clientY - ds.startY;
    if (Math.abs(dy) > REMOVE_DRAG_THRESHOLD_PX) {
      // Mark visually as "about to remove" — semi-transparent.
      const handles = this._stopsLayerEl.querySelectorAll('.gradient-stop-handle');
      const h = handles[ds.idx];
      if (h) h.classList.add('drag-remove');
      ds.removed = true;
      return;
    }
    // Restore visuals if the user dragged back into the keep zone.
    if (ds.removed) {
      const handles = this._stopsLayerEl.querySelectorAll('.gradient-stop-handle');
      const h = handles[ds.idx];
      if (h) h.classList.remove('drag-remove');
      ds.removed = false;
    }
    // Update position horizontally (in-place; resort on commit).
    const newPos = this._xToPos(ev.clientX);
    const stop = this._stops[ds.idx];
    if (stop && stop.pos !== newPos) {
      stop.pos = newPos;
      ds.moved = true;
      this._render();
      this._emitChange();
    }
  }

  _onWindowPointerUp(ev) {
    const ds = this._dragState;
    if (!ds) return;
    window.removeEventListener('pointermove', this._onWindowPointerMove);
    window.removeEventListener('pointerup', this._onWindowPointerUp);
    this._dragState = null;
    if (ds.removed) {
      this._removeStopAt(ds.idx);
      return;
    }
    // Commit final sort + selection by reference.
    const ref = this._stops[ds.idx];
    this._stops.sort((a, b) => a.pos - b.pos);
    this._selectedIdx = this._stops.indexOf(ref);
    if (this._selectedIdx < 0) this._selectedIdx = 0;
    this._render();
    this._notifySelect();
    if (ds.moved) this._emitChange();
  }

  _removeStopAt(idx) {
    if (this._stops.length <= 2) {
      // Reject — re-render to drop the drag-remove visual.
      this._render();
      return;
    }
    this._stops.splice(idx, 1);
    if (this._selectedIdx >= this._stops.length) this._selectedIdx = this._stops.length - 1;
    if (this._selectedIdx < 0) this._selectedIdx = 0;
    this._render();
    this._notifySelect();
    this._emitChange();
  }
}

/**
 * Wire CSS-driven sub-section visibility for #color-section based on the
 * checked auto-source radio. Idempotent: safe to call once on DOMContentLoaded.
 */
export function wireColorSectionVisibility() {
  const section = document.getElementById('color-section');
  if (!section) return;
  const radios = document.querySelectorAll('input[name="color-auto-source"]');
  if (!radios.length) return;
  const sync = () => {
    const checked = Array.from(radios).find(r => r.checked);
    section.dataset.source = checked ? checked.value : 'none';
  };
  radios.forEach(r => r.addEventListener('change', sync));
  sync();
}

// Auto-wire when DOM is ready. The orchestrator's wireColorPaintUI doesn't
// touch the section's data-source attribute, so we own this side-channel.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireColorSectionVisibility);
  } else {
    // Defer to the next tick so any sibling code initializing radio defaults
    // (e.g. main.js's wireColorPaintUI) has a chance to run first.
    Promise.resolve().then(wireColorSectionVisibility);
  }
}
