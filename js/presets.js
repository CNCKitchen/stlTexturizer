/**
 * presets.js — Save / load named settings presets.
 *
 * Exports a single `initPresets(deps)` function. Call it once after the main
 * UI is wired. All state read/write goes through the two callbacks so this
 * module stays decoupled from the rest of main.js.
 *
 * deps:
 *   getState()         → plain object snapshot of all current settings
 *   applyState(snap)   → restore settings from a snapshot object
 *   t(key)             → i18n helper
 */

const STORAGE_KEY = 'bumpmesh_presets_v1';

function loadFromStorage() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
  catch { return {}; }
}

function saveToStorage(presets) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

export function initPresets({ getState, applyState, t }) {

  // ── Build section HTML ────────────────────────────────────────────────────

  const section = document.getElementById('presets-section');
  section.innerHTML = `
    <h2 data-i18n="sections.presets" data-i18n-title="tooltips.presets"
      title="Save your current settings as a named preset for reuse. Presets are stored in your browser and can be exported as JSON for backup or sharing.">Presets ⓘ</h2>
    <div class="preset-save-row">
      <input
        type="text"
        id="preset-name-input"
        class="preset-name-input"
        autocomplete="off"
        maxlength="64"
      />
      <button id="preset-save-btn" class="preset-action-btn preset-save-btn"
        data-i18n="presets.save" data-i18n-title="presets.saveTitle"
        title="Save current settings as a preset">Save</button>
    </div>
    <div id="preset-list" class="preset-list"></div>
    <div class="preset-io-row">
      <button id="preset-export-btn" class="preset-action-btn"
        data-i18n="presets.export" data-i18n-title="presets.exportTitle"
        title="Export all presets as a JSON file">Export JSON</button>
      <label class="preset-action-btn preset-import-label"
        data-i18n="presets.import" data-i18n-title="presets.importTitle"
        title="Import presets from a JSON file">Import JSON
        <input type="file" id="preset-import-input" accept=".json" hidden />
      </label>
    </div>
  `;

  // ── Element refs ─────────────────────────────────────────────────────────

  const nameInput    = document.getElementById('preset-name-input');
  const saveBtn      = document.getElementById('preset-save-btn');
  const listEl       = document.getElementById('preset-list');
  const exportBtn    = document.getElementById('preset-export-btn');
  const importInput  = document.getElementById('preset-import-input');

  // Apply translated text that can't be set via data-i18n attributes
  nameInput.placeholder = t('presets.namePlaceholder');

  // ── Render preset list ────────────────────────────────────────────────────

  function render() {
    const presets = loadFromStorage();
    const names = Object.keys(presets);
    listEl.innerHTML = '';

    if (names.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'preset-empty-hint';
      hint.setAttribute('data-i18n', 'presets.empty');
      hint.textContent = t('presets.empty');
      listEl.appendChild(hint);
      return;
    }

    for (const name of names) {
      const row = document.createElement('div');
      row.className = 'preset-row';

      const label = document.createElement('span');
      label.className = 'preset-row-name';
      label.textContent = name;
      label.title = name;

      const loadBtn = document.createElement('button');
      loadBtn.className = 'preset-action-btn preset-load-btn';
      loadBtn.textContent = t('presets.load');
      loadBtn.setAttribute('data-i18n', 'presets.load');
      loadBtn.addEventListener('click', () => applyState(presets[name]));

      const delBtn = document.createElement('button');
      delBtn.className = 'preset-action-btn preset-delete-btn';
      delBtn.textContent = '✕';
      delBtn.title = t('presets.deleteTitle');
      delBtn.setAttribute('aria-label', t('presets.deleteTitle'));
      delBtn.addEventListener('click', () => {
        const all = loadFromStorage();
        delete all[name];
        saveToStorage(all);
        render();
      });

      row.appendChild(label);
      row.appendChild(loadBtn);
      row.appendChild(delBtn);
      listEl.appendChild(row);
    }
  }

  // ── Save ─────────────────────────────────────────────────────────────────

  function savePreset() {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    const all = loadFromStorage();
    all[name] = getState();
    saveToStorage(all);
    nameInput.value = '';
    render();
  }

  saveBtn.addEventListener('click', savePreset);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') savePreset();
  });

  // ── Export ────────────────────────────────────────────────────────────────

  exportBtn.addEventListener('click', () => {
    const json = JSON.stringify(loadFromStorage(), null, 2);
    const a = document.createElement('a');
    a.href = 'data:application/json,' + encodeURIComponent(json);
    a.download = 'bumpmesh-presets.json';
    a.click();
  });

  // ── Import ────────────────────────────────────────────────────────────────

  importInput.addEventListener('change', function () {
    const file = this.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const imported = JSON.parse(e.target.result);
        if (typeof imported !== 'object' || Array.isArray(imported) || imported === null)
          throw new Error('not an object');
        const merged = { ...loadFromStorage(), ...imported };
        saveToStorage(merged);
        render();
      } catch {
        alert(t('presets.importError'));
      }
      this.value = '';
    };
    reader.readAsText(file);
  });

  // ── Initial render ────────────────────────────────────────────────────────

  render();
}
