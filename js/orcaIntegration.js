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
 * an Orca object and clicks the explicit load button. Returning a processed
 * STL is a separate action and adds an object through the host's file opener.
 */
export function initOrcaIntegration({ loadModelFile, exportModel, t, applyHostTheme }) {
  if (!integrationEnabled()) return false;

  const controls = createIntegrationControls(t);
  if (!controls) return false;
  const { select, refreshButton, loadButton, status } = controls;

  let loading = false;
  let refreshing = false;
  let returning = false;
  let canReturn = false;
  let maxReturnBytes = 0;
  let pendingReply = null;
  const exportButton = document.getElementById('export-btn');
  const returnButton = document.createElement('button');
  returnButton.id = 'orca-return-btn';
  returnButton.type = 'button';
  returnButton.className = 'export-btn';
  returnButton.dataset.i18n = 'orca.returnModel';
  returnButton.textContent = t('orca.returnModel');
  returnButton.disabled = true;
  exportButton?.insertAdjacentElement('afterend', returnButton);
  const returnStatus = document.createElement('div');
  returnStatus.id = 'orca-return-status';
  returnStatus.className = 'orca-integration-status';
  returnStatus.setAttribute('aria-live', 'polite');
  exportButton?.parentElement.insertAdjacentElement('afterend', returnStatus);
  const setReturnStatus = (text, isError = false) => {
    returnStatus.textContent = text;
    returnStatus.classList.toggle('error', isError);
  };
  const syncReturnButton = () => {
    returnButton.disabled = !canReturn || returning || loading || !exportButton ||
      exportButton.disabled || exportButton.classList.contains('busy');
  };
  if (exportButton) new MutationObserver(syncReturnButton).observe(exportButton, {
    attributes: true, attributeFilter: ['disabled', 'class'],
  });

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
      canReturn = message.canReturnModel === true;
      maxReturnBytes = Number.isSafeInteger(message.maxReturnBytes) ? message.maxReturnBytes : 0;
      returnButton.dataset.i18nTitle = canReturn ? 'orca.returnHint' : 'orca.returnUnavailable';
      returnButton.title = t(returnButton.dataset.i18nTitle);
      setObjects(Array.isArray(message.objects) ? message.objects : []);
      syncReturnButton();
      return;
    }

    if (message.type === 'return-ack' || message.type === 'return-sent' || message.type === 'return-error') {
      const reply = pendingReply;
      if (!reply || message.transferId !== reply.id) return;
      if (message.type !== 'return-error' &&
          (message.type !== reply.type || (reply.type === 'return-ack' && message.index !== reply.index))) return;
      pendingReply = null;
      clearTimeout(reply.timer);
      if (message.type === 'return-error') reply.reject(new Error(message.message || t('orca.transferFailed')));
      else reply.resolve();
      return;
    }

    if (message.type === 'transfer-start') {
      loading = true;
      syncReturnButton();
      loadButton.disabled = true;
      setStatus(t('orca.receivingModel'));
      return;
    }

    if (message.type === 'transfer-error') {
      loading = false;
      syncReturnButton();
      refreshing = false;
      refreshButton.disabled = false;
      loadButton.disabled = !firstAvailableOption();
      setStatus(message.message || t('orca.transferFailed'), true);
      return;
    }

    if (message.type !== 'load-model' || !(message.buffer instanceof ArrayBuffer)) return;
    if (message.buffer.byteLength > MAX_MODEL_BYTES) {
      loading = false;
      syncReturnButton();
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
      syncReturnButton();
      loadButton.disabled = !firstAvailableOption();
    }
  });

  loadButton.addEventListener('click', () => {
    if (!select.value || loading) return;
    loading = true;
    syncReturnButton();
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

  const exchange = (message, type, index) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingReply = null;
      reject(new Error(t('orca.returnTimeout')));
    }, 30000);
    pendingReply = { id: message.transferId, type, index, resolve, reject, timer };
    postToPlugin(message);
  });

  const sendModel = async (buffer, name) => {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > maxReturnBytes) {
      throw new Error(t('orca.returnTooLarge'));
    }
    const transferId = Array.from(crypto.getRandomValues(new Uint8Array(16)),
      value => value.toString(16).padStart(2, '0')).join('');
    try {
      setReturnStatus(t('orca.returnSending'));
      await exchange({ type: 'return-start', transferId, name, totalBytes: buffer.byteLength }, 'return-ack', -1);
      const bytes = new Uint8Array(buffer);
      const chunkSize = 256 * 1024;
      for (let start = 0, index = 0; start < bytes.length; start += chunkSize, index += 1) {
        let binary = '';
        const chunk = bytes.subarray(start, start + chunkSize);
        for (let offset = 0; offset < chunk.length; offset += 8192) {
          binary += String.fromCharCode(...chunk.subarray(offset, offset + 8192));
        }
        await exchange({ type: 'return-chunk', transferId, index, data: btoa(binary) }, 'return-ack', index);
      }
      await exchange({ type: 'return-done', transferId }, 'return-sent');
      setReturnStatus(t('orca.returnSent'));
    } catch (error) {
      postToPlugin({ type: 'return-cancel', transferId });
      setReturnStatus(error.message, true);
      throw error;
    }
  };

  returnButton.addEventListener('click', async () => {
    if (returnButton.disabled) return;
    returning = true;
    loadButton.disabled = true;
    refreshButton.disabled = true;
    syncReturnButton();
    try {
      await exportModel();
    } finally {
      returning = false;
      loadButton.disabled = loading || !firstAvailableOption();
      refreshButton.disabled = refreshing;
      syncReturnButton();
    }
  });

  postToPlugin({ type: 'ready' });
  return { sendModel, maxReturnBytes: () => maxReturnBytes };
}
