/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Collapsible right-hand sidebar. The tab on the sidebar's left edge hides whichever panel is showing
// (settings or the texture gallery) to give the viewport the room, and brings it back. On portrait
// phones the sidebar sits below the viewport and the tab is a bar across its top.

export function initSidebarToggle() {
  const toggle = document.getElementById('sidebar-toggle');
  const main = toggle.parentElement;

  toggle.addEventListener('click', () => {
    const collapsed = main.classList.toggle('sidebar-collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
  });
}
