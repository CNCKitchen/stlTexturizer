/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const PROTOCOL_VERSION = 1;
const PLUGIN_SOURCE = 'orcaslicer-bumpmesh-plugin';
const APP_SOURCE = 'bumpmesh';
const MAX_MODEL_BYTES = 50_000_084;

function integrationEnabled() {
  const params = new URLSearchParams(window.location.search);
  return params.get('orcaslicer') === '1' && window.parent !== window;
}

function postToPlugin(data, transfer = []) {
  window.parent.postMessage({
    source: APP_SOURCE,
    protocol: PROTOCOL_VERSION,
    ...data,
  }, '*', transfer);
}

function createIntegrationControls(t) {
  const loadRow = document.querySelector('.load-stl-row');
  if (!loadRow) return null;

  const row = document.createElement('div');
  row.id = 'orca-integration-row';
  row.className = 'orca-integration-row';

  const select = document.createElement('select');
  select.id = 'orca-object-select';
  select.disabled = true;
  select.dataset.i18nAriaLabel = 'orca.loadFromOrca';
  select.setAttribute('aria-label', t('orca.loadFromOrca'));

  const refreshButton = document.createElement('button');
  refreshButton.id = 'orca-refresh-btn';
  refreshButton.className = 'upload-btn';
  refreshButton.type = 'button';
  refreshButton.dataset.i18n = 'orca.refreshObjects';
  refreshButton.textContent = t('orca.refreshObjects');

  const loadButton = document.createElement('button');
  loadButton.id = 'orca-load-btn';
  loadButton.className = 'upload-btn';
  loadButton.type = 'button';
  loadButton.disabled = true;
  loadButton.dataset.i18n = 'orca.loadFromOrca';
  loadButton.textContent = t('orca.loadFromOrca');

  const status = document.createElement('span');
  status.id = 'orca-integration-status';
  status.className = 'orca-integration-status';
  status.setAttribute('aria-live', 'polite');

  row.append(select, refreshButton, loadButton, status);
  loadRow.insertAdjacentElement('afterend', row);
  return { select, refreshButton, loadButton, status };
}

/**
 * Enable the optional OrcaSlicer parent-frame integration.
 *
 * The normal website is unchanged unless it is embedded with
 * `?orcaslicer=1`. The parent can provide an STL only after the user selects
 * an Orca object and clicks the explicit load button. Export remains the
 * ordinary BumpMesh download flow because the current Orca plugin API has no
 * supported model replacement/import hook.
 */
export function initOrcaIntegration({ loadModelFile, t, applyHostTheme }) {
  if (!integrationEnabled()) return false;

  const controls = createIntegrationControls(t);
  if (!controls) return false;
  const { select, refreshButton, loadButton, status } = controls;

  let loading = false;
  let refreshing = false;

  document.body.classList.add('orca-embedded');
  const attributionLink = document.querySelector('.logo a');
  if (attributionLink) {
    attributionLink.removeAttribute('href');
    attributionLink.removeAttribute('target');
    attributionLink.removeAttribute('rel');
    attributionLink.setAttribute('aria-disabled', 'true');
    attributionLink.setAttribute('tabindex', '-1');
  }

  const setStatus = (text, isError = false) => {
    status.textContent = text || '';
    status.classList.toggle('error', isError);
  };

  const firstAvailableOption = () =>
    Array.from(select.options).find(option => !option.disabled) || null;

  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link) return;
    const url = new URL(link.href, window.location.href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    setStatus(t('orca.externalLinksUnavailable'));
  }, true);

  const setObjects = (objects) => {
    refreshing = false;
    refreshButton.disabled = false;
    select.replaceChildren();
    for (const object of objects) {
      const option = document.createElement('option');
      option.value = String(object.id);
      option.textContent = object.name || t('orca.objectFallback', { id: object.id });
      if (object.disabledReasonCode === 'negative-volumes') {
        option.disabled = true;
        option.textContent += ` — ${t('orca.negativeVolumes')}`;
      }
      select.appendChild(option);
    }

    // WebView2 may propagate a disabled <select> into the CSS :disabled state
    // of its child options. Inspect each option's own flag so a list refreshed
    // after an empty state can become enabled again.
    const firstAvailable = firstAvailableOption();
    if (firstAvailable) firstAvailable.selected = true;
    select.title = firstAvailable ? firstAvailable.textContent : '';
    const available = Boolean(firstAvailable);
    select.disabled = !available;
    loadButton.disabled = !available || loading;
    setStatus(available ? '' : t('orca.noObjects'));
  };

  window.addEventListener('message', async (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.source !== PLUGIN_SOURCE || message.protocol !== PROTOCOL_VERSION) return;

    if (message.type === 'host-theme') {
      if ((message.theme === 'light' || message.theme === 'dark') &&
          typeof applyHostTheme === 'function') {
        applyHostTheme(message.theme);
      }
      return;
    }

    if (message.type === 'objects') {
      setObjects(Array.isArray(message.objects) ? message.objects : []);
      return;
    }

    if (message.type === 'transfer-start') {
      loading = true;
      loadButton.disabled = true;
      setStatus(t('orca.receivingModel'));
      return;
    }

    if (message.type === 'transfer-error') {
      loading = false;
      refreshing = false;
      refreshButton.disabled = false;
      loadButton.disabled = !firstAvailableOption();
      setStatus(message.message || t('orca.transferFailed'), true);
      return;
    }

    if (message.type !== 'load-model' || !(message.buffer instanceof ArrayBuffer)) return;
    if (message.buffer.byteLength > MAX_MODEL_BYTES) {
      loading = false;
      loadButton.disabled = !firstAvailableOption();
      setStatus(t('orca.transferFailed'), true);
      postToPlugin({ type: 'model-load-error', message: 'Transferred model exceeds the size limit.' });
      return;
    }

    try {
      setStatus(t('orca.loadingModel'));
      const filename = message.name && /\.stl$/i.test(message.name)
        ? message.name
        : `${message.name || 'orca-model'}.stl`;
      await loadModelFile(new File([message.buffer], filename, {
        type: 'model/stl',
      }));
      setStatus(t('orca.modelLoaded'));
      postToPlugin({ type: 'model-loaded', objectId: message.objectId });
    } catch (error) {
      const detail = error && error.message ? error.message : String(error);
      setStatus(t('orca.loadFailed', { msg: detail }), true);
      postToPlugin({ type: 'model-load-error', message: detail });
    } finally {
      loading = false;
      loadButton.disabled = !firstAvailableOption();
    }
  });

  loadButton.addEventListener('click', () => {
    if (!select.value || loading) return;
    loading = true;
    loadButton.disabled = true;
    setStatus(t('orca.preparingModel'));
    postToPlugin({ type: 'request-model', objectId: Number(select.value) });
  });

  refreshButton.addEventListener('click', () => {
    if (refreshing || loading) return;
    refreshing = true;
    refreshButton.disabled = true;
    setStatus(t('orca.refreshingObjects'));
    postToPlugin({ type: 'refresh-objects' });
  });

  postToPlugin({ type: 'ready' });
  return true;
}
