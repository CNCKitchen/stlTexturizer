// ── Language registry ─────────────────────────────────────────────────────────
// Only display names live here; full strings are lazy-loaded per language.

export const TRANSLATIONS = {
  de: { 'lang.name': 'Deutsch' },
  en: { 'lang.name': 'English' },
  es: { 'lang.name': 'Español (beta)' },
  fr: { 'lang.name': 'Français' },
  it: { 'lang.name': 'Italiano' },
  ja: { 'lang.name': '日本語 (beta)' },
  pt: { 'lang.name': 'Português (beta)' },
  ru: { 'lang.name': 'Русский' }
};

// ── Module state ──────────────────────────────────────────────────────────────

let _currentLang = 'en';
const _cache = {};

/**
 * Load a language file into the cache.
 * Returns true on success, false on failure.
 * Marks failed languages with an empty object so we don't retry on every call.
 */
async function _loadLang(lang) {
  if (_cache[lang]) {
    return true;
  }

  try {
    const { default: strings } = await import(`./i18n/${lang}.js`);
    _cache[lang] = strings;
    return true;
  } catch (err) {
    console.error(`[i18n] Failed to load language "${lang}":`, err);
    _cache[lang] = {};
    return false;
  }
}

// ── Core API ──────────────────────────────────────────────────────────────────

/**
 * Look up a translation key in the current language, falling back to English.
 * Replace {placeholder} tokens with values from `params`.
 */
export function t(key, params = {}) {
  const strings  = _cache[_currentLang] ?? _cache.en ?? {};
  const fallback = _cache.en ?? {};
  let str = strings[key] ?? fallback[key] ?? key;

  for (const [k, v] of Object.entries(params)) {
    str = str.replaceAll(`{${k}}`, v);
  }

  return str;
}

export function getLang() {
  return _currentLang;
}

/**
 * Switch the active language.
 * Returns true if the requested language loaded successfully, false if it fell
 * back to English due to a network/parse error.
 */
export async function setLang(lang) {
  if (!TRANSLATIONS[lang]) {
    return false;
  }

  const [, langOk] = await Promise.all([_loadLang('en'), _loadLang(lang)]);

  // If the requested lang failed, stay on current language rather than
  // switching to a blank/partial UI.
  if (!langOk) {
    return false;
  }

  _currentLang = lang;
  localStorage.setItem('stlt-lang', lang);
  document.documentElement.setAttribute('data-lang', lang);
  document.documentElement.setAttribute('lang', lang);

  applyTranslations();
  return true;
}

/**
 * Walk the DOM and apply translations to elements carrying data-i18n* attributes.
 */
export function applyTranslations() {
  // textContent
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });

  // innerHTML (safe: all values are hardcoded in translation files, not user input)
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });

  // title attribute
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });

  // aria-label attribute
  document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  });

  // <option> elements (textContent doesn't work via data-i18n on options in some browsers)
  document.querySelectorAll('option[data-i18n-opt]').forEach(opt => {
    opt.textContent = t(opt.dataset.i18nOpt);
  });
}

/**
 * Detect language from localStorage or the browser, load translation files,
 * and apply. Call once at startup.
 *
 * Returns { enFailed: boolean } — true when even the English base file could
 * not be loaded. The UI will still render but show raw translation keys instead
 * of text. The caller should surface a visible warning in this case.
 */
export async function initLang() {
  const saved   = localStorage.getItem('stlt-lang');
  const browser = navigator.language.split('-')[0];

  if (saved && TRANSLATIONS[saved]) {
    _currentLang = saved;
  } else if (TRANSLATIONS[browser]) {
    _currentLang = browser;
  } else {
    _currentLang = 'en';
  }

  // Set attributes before the async load so CSS/JS reading `lang` works immediately.
  document.documentElement.setAttribute('data-lang', _currentLang);
  document.documentElement.setAttribute('lang', _currentLang);

  const [enOk] = await Promise.all([_loadLang('en'), _loadLang(_currentLang)]);

  // If the selected language failed but English loaded, silently fall back.
  if (_currentLang !== 'en' && Object.keys(_cache[_currentLang] ?? {}).length === 0) {
    console.warn(`[i18n] Falling back to English — "${_currentLang}" failed to load`);
    _currentLang = 'en';
    document.documentElement.setAttribute('data-lang', 'en');
    document.documentElement.setAttribute('lang', 'en');
  }

  // Dev-time sanity check: warn about keys present in English but missing in
  // the active language so translators spot drift early.
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    const en  = _cache.en  ?? {};
    const cur = _cache[_currentLang] ?? {};
    const missing = Object.keys(en).filter(k => !(k in cur));
    if (_currentLang !== 'en' && missing.length) {
      console.warn(`[i18n] ${_currentLang}.js is missing ${missing.length} key(s) vs en.js:`, missing);
    }
  }

  applyTranslations();
  return { enFailed: !enOk };
}
