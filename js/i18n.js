// ── Language registry ─────────────────────────────────────────────────────────
// Only display names live here; full strings are lazy-loaded per language.

export const TRANSLATIONS = {
  en: { 'lang.name': 'English' },
  de: { 'lang.name': 'Deutsch' },
  it: { 'lang.name': 'Italiano' },
  es: { 'lang.name': 'Español (beta)' },
  pt: { 'lang.name': 'Português (beta)' },
  fr: { 'lang.name': 'Français' },
  ja: { 'lang.name': '日本語 (beta)' },
};

// ── Module state ──────────────────────────────────────────────────────────────

let _currentLang = 'en';
const _cache = {};

async function _loadLang(lang) {
  if (_cache[lang]) {
    return;
  }

  const { default: strings } = await import(`./i18n/${lang}.js`);

  _cache[lang] = strings;
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

export async function setLang(lang) {
  if (!TRANSLATIONS[lang]) {
    return;
  }

  await Promise.all([_loadLang('en'), _loadLang(lang)]);

  _currentLang = lang;
  localStorage.setItem('stlt-lang', lang);
  document.documentElement.setAttribute('data-lang', lang);
  document.documentElement.setAttribute('lang', lang);

  applyTranslations();
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

  await Promise.all([_loadLang('en'), _loadLang(_currentLang)]);

  applyTranslations();
}
