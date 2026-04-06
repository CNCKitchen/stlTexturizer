/**
 * BumpMesh profile import/export (JSON) and browser-local named profiles.
 */

export const PROFILE_VERSION = 1;
export const PROFILE_SCHEMA = 'BumpMeshProfile';

const STORAGE_KEY = 'stlt-bumpmesh-profiles-v1';

export function loadProfilesMap() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return typeof o === 'object' && o !== null && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

export function saveProfilesMap(map) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

export function saveNamedProfile(name, profile) {
  const map = loadProfilesMap();
  map[name] = profile;
  saveProfilesMap(map);
}

export function deleteNamedProfile(name) {
  const map = loadProfilesMap();
  delete map[name];
  saveProfilesMap(map);
}

export function listProfileNames() {
  return Object.keys(loadProfilesMap()).sort((a, b) => a.localeCompare(b));
}

/** @param activeMapEntry - same shape as main.js `activeMapEntry` (preset or custom map) */
export function captureTexture(activeMapEntry) {
  if (!activeMapEntry) return { kind: 'none' };
  if (activeMapEntry.isCustom) {
    return {
      kind: 'custom',
      fileName: activeMapEntry.name || 'custom.png',
      dataUrl: activeMapEntry.fullCanvas.toDataURL('image/png'),
    };
  }
  return { kind: 'preset', name: activeMapEntry.name };
}

export function buildProfilePayload(settings, activeMapEntry, exclusionUi) {
  return {
    $schema: PROFILE_SCHEMA,
    version: PROFILE_VERSION,
    settings: { ...settings },
    texture: captureTexture(activeMapEntry),
    exclusionUi: { ...exclusionUi },
  };
}

export function validateProfile(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.$schema !== PROFILE_SCHEMA) return false;
  if (obj.version !== PROFILE_VERSION) return false;
  if (!obj.settings || typeof obj.settings !== 'object') return false;
  if (!obj.texture || typeof obj.texture !== 'object') return false;
  if (!obj.exclusionUi || typeof obj.exclusionUi !== 'object') return false;
  return true;
}
