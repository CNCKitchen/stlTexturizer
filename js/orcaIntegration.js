/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const PROTOCOL_VERSION = 1;
const PLUGIN_SOURCE = 'orcaslicer-bumpmesh-plugin';
const APP_SOURCE = 'bumpmesh';

function diagnosticsEnabled() {
  return new URLSearchParams(window.location.search).get('orcaslicerDebug') === '1';
}

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

  const debug = diagnosticsEnabled();
  const diagnostic = (event, details = {}) => {
    if (!debug) return;
    postToPlugin({ type: 'diagnostic', event, details });
  };

  const row = document.getElementById('orca-integration-row');
  const select = document.getElementById('orca-object-select');
  const refreshButton = document.getElementById('orca-refresh-btn');
  const loadButton = document.getElementById('orca-load-btn');
  const status = document.getElementById('orca-integration-status');

  if (!row || !select || !refreshButton || !loadButton || !status) return false;

  let loading = false;
  let refreshing = false;

  diagnostic('integration-init', {
    language: document.documentElement.lang,
    hasFileApi: typeof File === 'function',
  });

  window.addEventListener('error', (event) => {
    diagnostic('window-error', {
      message: event.message || 'Unknown JavaScript error',
      source: event.filename ? new URL(event.filename, window.location.href).pathname : '',
      line: event.lineno || 0,
      column: event.colno || 0,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    diagnostic('unhandled-rejection', {
      message: reason && reason.message ? reason.message : String(reason),
    });
  });

  const describeControl = (target) => {
    const control = target instanceof Element
      ? target.closest('button, label, a, input, select')
      : null;
    if (!control) return null;
    return {
      tag: control.tagName.toLowerCase(),
      id: control.id || '',
      for: control.getAttribute('for') || '',
      disabled: Boolean(control.disabled),
      text: (control.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
    };
  };
  document.addEventListener('pointerdown', (event) => {
    const control = describeControl(event.target);
    if (control) diagnostic('control-pointerdown', control);
  }, true);
  document.addEventListener('click', (event) => {
    const control = describeControl(event.target);
    if (control) diagnostic('control-click', control);
  }, true);

  for (const inputId of ['stl-file-input', 'texture-file-input']) {
    const input = document.getElementById(inputId);
    if (!input) {
      diagnostic('file-input-missing', { id: inputId });
      continue;
    }
    input.addEventListener('change', () => {
      diagnostic('file-input-change', {
        id: inputId,
        fileCount: input.files ? input.files.length : 0,
      });
    });
    input.addEventListener('cancel', () => {
      diagnostic('file-input-cancel', { id: inputId });
    });
  }

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

  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link) return;
    const url = new URL(link.href, window.location.href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    setStatus(t('orca.externalLinksUnavailable'));
    diagnostic('external-link-blocked', { url: url.toString() });
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
    const firstAvailable = Array.from(select.options).find(option => !option.disabled) || null;
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
      diagnostic('objects-received', {
        count: Array.isArray(message.objects) ? message.objects.length : 0,
      });
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
      loadButton.disabled = select.options.length === 0;
      setStatus(message.message || t('orca.transferFailed'), true);
      return;
    }

    if (message.type !== 'load-model' || !(message.buffer instanceof ArrayBuffer)) return;

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
      loadButton.disabled = select.options.length === 0;
    }
  });

  loadButton.addEventListener('click', () => {
    diagnostic('load-from-orca-click', {
      objectId: select.value || '',
      disabled: loadButton.disabled,
      loading,
    });
    if (!select.value || loading) return;
    loading = true;
    loadButton.disabled = true;
    setStatus(t('orca.preparingModel'));
    postToPlugin({ type: 'request-model', objectId: Number(select.value) });
  });

  refreshButton.addEventListener('click', () => {
    diagnostic('refresh-click', { refreshing, loading });
    if (refreshing || loading) return;
    refreshing = true;
    refreshButton.disabled = true;
    setStatus(t('orca.refreshingObjects'));
    postToPlugin({ type: 'refresh-objects' });
  });

  row.classList.remove('hidden');
  postToPlugin({ type: 'ready' });
  return true;
}
