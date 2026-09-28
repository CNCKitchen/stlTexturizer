/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Resizable right-hand sidebar. The settings panel and the texture gallery (which takes its place
// while open) share one width, --sidebar-w on <main>, so opening the gallery never shifts the
// viewport. Drag the handle on the sidebar's left edge, or focus it and use ←/→; double-click
// restores the default. CSS clamps the width; the clamped value is what gets saved.

const WIDTH_KEY = 'bumpmesh-sidebar-width';
const STEP_PX = 20;

export function initSidebarResize() {
  const handle = document.getElementById('sidebar-resize');
  const main = handle.parentElement;

  // The handle is a zero-width flex item right before whichever panel is showing.
  const currentWidth = () => main.getBoundingClientRect().right - handle.getBoundingClientRect().left;

  function setWidth(px) {
    if (px == null) main.style.removeProperty('--sidebar-w');
    else main.style.setProperty('--sidebar-w', `${Math.round(px)}px`);
  }

  function save() {
    const w = Math.round(currentWidth());
    setWidth(w);
    try { localStorage.setItem(WIDTH_KEY, String(w)); } catch { /* private mode */ }
  }

  function reset() {
    setWidth(null);
    try { localStorage.removeItem(WIDTH_KEY); } catch { /* private mode */ }
  }

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const right = main.getBoundingClientRect().right;
    const move = (ev) => setWidth(right - ev.clientX);
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.classList.remove('dragging');
      document.body.classList.remove('sidebar-resizing');
      save();
    };
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('sidebar-resizing');
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });

  handle.addEventListener('keydown', (e) => {
    // The handle sits on the sidebar's left edge, so moving it left widens the sidebar.
    const dir = e.key === 'ArrowLeft' ? 1 : e.key === 'ArrowRight' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    setWidth(currentWidth() + dir * STEP_PX);
    save();
  });

  handle.addEventListener('dblclick', reset);

  let saved = null;
  try { saved = Number(localStorage.getItem(WIDTH_KEY)); } catch { /* private mode */ }
  if (saved > 0) setWidth(saved);
}
