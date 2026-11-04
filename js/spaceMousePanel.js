/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * spaceMousePanel.js — the footer's SpaceMouse button and panel: speed and
 * reversed axes for the puck (viewer.js setSpaceMouseTuning). The browser
 * reads the puck directly, so the 3Dconnexion driver's own speed and reversed
 * axes never reach BumpMesh; these replace them. Same settings as ScanRuler.
 *
 * The button only shows once a SpaceMouse has connected in this browser, and
 * keeps showing on later visits before the puck is touched (the browser only
 * reports a puck after it has been touched on the page). Everything is kept
 * in localStorage: it belongs to the user's hardware, not to a project.
 */

import { SPACE_MOUSE_AXES, setSpaceMouseTuning, spaceMouseName, watchSpaceMouse } from './viewer.js';
import { t } from './i18n.js';

const SPEED_KEY = 'stlt-spacemouse-speed';
const REVERSE_KEY = 'stlt-spacemouse-reverse';
const SEEN_KEY = 'stlt-spacemouse-seen';
const SPEED_MIN = 0.25, SPEED_MAX = 2;

const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };

/** A stored speed, or 1 when there is none. */
function speedOf(value) {
  const n = Number(value);
  if (value === null || value === '' || !Number.isFinite(n)) return 1;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, n));
}

/** Stored reversed axes (comma-separated); anything unknown is dropped. */
function reverseOf(value) {
  const named = new Set((value ?? '').split(','));
  return SPACE_MOUSE_AXES.filter((a) => named.has(a));
}

export function initSpaceMousePanel() {
  const wrap = document.getElementById('spacemouse-wrap');
  const btn = document.getElementById('spacemouse-btn');
  const panel = document.getElementById('spacemouse-panel');
  const speedInput = document.getElementById('spacemouse-speed');
  const speedOut = document.getElementById('spacemouse-speed-val');
  const status = document.getElementById('spacemouse-status');
  const axisBtns = panel.querySelectorAll('[data-sm-axis]');
  if (!wrap || !btn || !panel) return;

  let speed = speedOf(read(SPEED_KEY));
  let reversed = reverseOf(read(REVERSE_KEY));

  const apply = () => {
    setSpaceMouseTuning({ speed, reversed });
    speedInput.value = String(speed);
    speedOut.textContent = `${speed.toFixed(2)}×`;
    for (const b of axisBtns) b.setAttribute('aria-pressed', reversed.includes(b.dataset.smAxis) ? 'true' : 'false');
  };

  const showStatus = () => {
    const name = spaceMouseName();
    // Chrome appends "(Vendor: 256f Product: c635)"; the name reads better without it.
    status.textContent = name
      ? t('ui.spaceMouseConnected', { name: name.replace(/\s*\(.*\)$/, '') })
      : t('ui.spaceMouseNotConnected');
  };

  const showButton = () => {
    if (spaceMouseName()) write(SEEN_KEY, '1');
    wrap.classList.toggle('hidden', !(spaceMouseName() || read(SEEN_KEY) === '1'));
    showStatus();
  };

  const setOpen = (open) => {
    panel.classList.toggle('hidden', !open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) showStatus();
  };

  btn.addEventListener('click', () => setOpen(panel.classList.contains('hidden')));
  document.addEventListener('pointerdown', (e) => {
    if (!panel.classList.contains('hidden') && !wrap.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.classList.contains('hidden')) { setOpen(false); btn.focus(); }
  });

  speedInput.addEventListener('input', () => {
    speed = speedOf(speedInput.value);
    write(SPEED_KEY, String(speed));
    apply();
  });
  for (const b of axisBtns) {
    b.addEventListener('click', () => {
      const a = b.dataset.smAxis;
      reversed = reversed.includes(a) ? reversed.filter((x) => x !== a) : [...reversed, a];
      write(REVERSE_KEY, reversed.join(','));
      apply();
    });
  }

  // The status line carries the device name, so it is redrawn on a language
  // switch rather than through data-i18n.
  new MutationObserver(showStatus).observe(document.documentElement, { attributes: true, attributeFilter: ['data-lang'] });
  watchSpaceMouse(showButton);

  apply();
  showButton();
}
