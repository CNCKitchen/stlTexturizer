// ── Translations ──────────────────────────────────────────────────────────────
// All UI strings in one place. Use {placeholder} syntax for dynamic values.

export const TRANSLATIONS = {
  en: {
    // Theme toggle
    'theme.dark':              'Dark Theme',
    'theme.light':             'Light Theme',
    'theme.toggleTitle':       'Toggle light / dark mode',
    'theme.toggleAriaLabel':   'Toggle light/dark mode',

    // Drop zone
    'dropHint.text': 'Drop an <strong>.stl</strong> file here<br/>or <label for="stl-file-input" class="link-label">click to browse</label>',

    // Viewport footer
    'ui.wireframe':      'Wireframe',
    'ui.controlsHint':   'Left drag: orbit \u00a0·\u00a0 Right drag: pan \u00a0·\u00a0 Scroll: zoom',
    'ui.meshInfo':       '{n} triangles · {mb} MB · {sx} × {sy} × {sz} mm',

    // Load STL button
    'ui.loadStl':        'Load STL\u2026',

    // Displacement map section
    'sections.displacementMap': 'Displacement Map',
    'ui.uploadCustomMap':  'Upload custom map',
    'ui.noMapSelected':    'No map selected',

    // Projection section
    'sections.projection':   'Projection',
    'labels.mode':           'Mode',
    'projection.triplanar':  'Triplanar',
    'projection.cubic':      'Cubic (Box)',
    'projection.cylindrical':'Cylindrical',
    'projection.spherical':  'Spherical',
    'projection.planarXY':   'Planar XY',
    'projection.planarXZ':   'Planar XZ',
    'projection.planarYZ':   'Planar YZ',

    // Transform section
    'sections.transform':    'Transform',
    'labels.scaleU':         'Scale U',
    'labels.scaleV':         'Scale V',
    'labels.offsetU':        'Offset U',
    'labels.offsetV':        'Offset V',
    'labels.rotation':       'Rotation',
    'tooltips.proportionalScaling':      'Proportional scaling (U = V)',
    'tooltips.proportionalScalingAria':  'Proportional scaling (U = V)',

    // Displacement section
    'sections.displacement': 'Texture Depth',
    'labels.amplitude':      'Amplitude',

    // Seam blend
    'labels.seamBlend':              'Seam Blend \u24d8',
    'tooltips.seamBlend':            'Softens the hard seam where projection faces meet. Effective for Cubic and Cylindrical modes.',

    // Mask angles section
    'sections.maskAngles':           'Mask Angles \u24d8',
    'tooltips.maskAngles':           '0° = no masking. Surfaces within this angle of horizontal will not be textured.',
    'labels.bottomFaces':            'Bottom faces',
    'tooltips.bottomFaces':          'Suppress texture on downward-facing surfaces within this angle of horizontal',
    'labels.topFaces':               'Top faces',
    'tooltips.topFaces':             'Suppress texture on upward-facing surfaces within this angle of horizontal',

    // Surface masking section
    'sections.surfaceMasking':       'Surface Masking \u24d8',
    'sections.surfaceSelection':     'Surface Selection',
    'tooltips.surfaceMasking':       'Mask surfaces to control which areas receive displacement.',
    'tooltips.surfaceSelection':     'Selected surfaces appear green and will be the only ones to receive displacement during export.',
    'excl.modeExclude':              'Exclude',
    'excl.modeExcludeTitle':         'Exclude mode: painted surfaces will not receive texture displacement',
    'excl.modeIncludeOnly':          'Include Only',
    'excl.modeIncludeOnlyTitle':     'Include Only mode: only painted surfaces will receive texture displacement',
    'excl.toolBrush':                'Brush',
    'excl.toolBrushTitle':           'Brush: paint triangles to exclude',
    'excl.toolFill':                 'Fill',
    'excl.toolFillTitle':            'Bucket fill: flood-fill surface up to a threshold angle',
    'excl.shiftHint':                'Hold Shift to erase',
    'labels.type':                   'Type',
    'brushType.single':              'Single',
    'brushType.circle':              'Circle',
    'labels.size':                   'Size',
    'labels.maxAngle':               'Max angle',
    'tooltips.maxAngle':             'Maximum dihedral angle between adjacent triangles for the fill to cross',
    'ui.clearAll':                   'Clear All',
    'excl.initExcluded':             '0 faces masked',
    'excl.faceExcluded':             '{n} face masked',
    'excl.facesExcluded':            '{n} faces masked',
    'excl.faceSelected':             '{n} face selected',
    'excl.facesSelected':            '{n} faces selected',
    'excl.hintExclude':              'Masked surfaces appear orange and will not receive displacement during export.',
    'excl.hintInclude':              'Selected surfaces appear green and will be the only ones to receive displacement during export.',

    // Boundary falloff
    'labels.boundaryFalloff':          'Boundary Falloff \u24d8',
    'tooltips.boundaryFalloff':        'Gradually reduces displacement to zero near masked boundaries, preventing triangle overlap where textured and non-textured regions meet.',

    // Symmetric displacement
    'labels.symmetricDisplacement':  'Symmetric displacement \u24d8',
    'tooltips.symmetricDisplacement':'When on, 50% grey = no displacement; white pushes out, black pushes in. Keeps part volume roughly constant.',

    // Displacement preview
    'labels.displacementPreview':    '3D Preview \u24d8',
    'tooltips.displacementPreview':  'Subdivides the mesh and displaces vertices in real-time so you can judge the actual depth. GPU-intensive on complex models.',

    // Place on face
    'ui.placeOnFace':                'Place on Face',
    'ui.placeOnFaceTitle':           'Click a face to orient it downward onto the print bed',
    'progress.subdividingPreview':   'Preparing preview\u2026',

    // Amplitude overlap warning
    'warnings.amplitudeOverlap':     '\u26a0 Amplitude exceeds 10% of the smallest model dimension \u2014 geometry overlaps may occur in the exported STL.',

    // Export section
    'sections.export':               'Export \u24d8',
    'tooltips.export':               'Smaller edge length = finer displacement detail. Output is then decimated to the triangle limit.',
    'labels.resolution':             'Resolution',
    'tooltips.resolution':           'Edges longer than this value will be split during export',
    'labels.outputTriangles':        'Output Triangles',
    'tooltips.outputTriangles':      'Mesh is fully subdivided first, then decimated down to this count',
    'warnings.safetyCapHit':         '\u26a0 10M-triangle safety cap hit during subdivision \u2014 result may still be coarser than requested edge length.',
    'ui.exportStl':                  'Export STL',

    // Export progress stages
    'progress.subdividing':          'Subdividing mesh\u2026',
    'progress.applyingDisplacement': 'Applying displacement to {n} triangles\u2026',
    'progress.displacingVertices':   'Displacing vertices\u2026',
    'progress.decimatingTo':         'Simplifying {from} \u2192 {to} triangles\u2026',
    'progress.decimating':           'Simplifying: {cur} \u2192 {to} triangles',
    'progress.writingStl':           'Writing STL\u2026',
    'progress.done':                 'Done!',
    'progress.processing':           'Processing\u2026',

    // License popup
    'license.btn':    'License & Terms',
    'license.title':  'License & Terms',
    'license.item1':  'Free to use for any purpose, including <strong>commercial work</strong> (e.g., texturing STLs for clients or products).',
    'license.item2':  'Attribution is <strong>appreciated</strong> but <strong>not required</strong> when using this tool as-is.',
    'license.item3':  'Want to support this tool and our work? Check out our <a href="https://geni.us/CNCStoreTexture" target="_blank" rel="noopener">online store</a>!',

    // Sponsor modal
    'sponsor.title':           'Thanks for using CNC Kitchen STL Texturizer!',
    'sponsor.body':            'This tool is provided <strong>completely free</strong> by CNC Kitchen.<br>While your STL is being processed, why not check out the store that helps us keep making cool stuff for you?',
    'sponsor.visitStore':      '\uD83D\uDED2 Visit CNCKitchen.STORE',
    'sponsor.dontShow':        "Don\u2019t show this again",
    'sponsor.closeAndContinue':'Close &amp; Continue',

    // Store CTA
    'cta.store':         '\uD83D\uDED2 Enjoying this free tool? Support us & shop at CNCKitchen.STORE!',
    'cta.storeDismiss':  'Dismiss',

    // Alerts
    'alerts.loadFailed':   'Could not load STL: {msg}',
    'alerts.exportFailed': 'Export failed: {msg}',
  },

  de: {
    // Theme toggle
    'theme.dark':              'Dunkles Design',
    'theme.light':             'Helles Design',
    'theme.toggleTitle':       'Hell/Dunkel-Modus wechseln',
    'theme.toggleAriaLabel':   'Hell/Dunkel-Modus wechseln',

    // Drop zone
    'dropHint.text': '<strong>.stl</strong>-Datei hier ablegen<br/>oder <label for="stl-file-input" class="link-label">zum Durchsuchen klicken</label>',

    // Viewport footer
    'ui.wireframe':      'Drahtgitter',
    'ui.controlsHint':   'Linke Maustaste: Drehen \u00a0·\u00a0 Rechte Maustaste: Verschieben \u00a0·\u00a0 Mausrad: Zoomen',
    'ui.meshInfo':       '{n} Dreiecke · {mb} MB · {sx} × {sy} × {sz} mm',

    // Load STL button
    'ui.loadStl':        'STL laden\u2026',

    // Displacement map section
    'sections.displacementMap': 'Textur',
    'ui.uploadCustomMap':  'Eigene Textur hochladen',
    'ui.noMapSelected':    'Keine Textur ausgew\u00e4hlt',

    // Projection section
    'sections.projection':   'Projektion',
    'labels.mode':           'Modus',
    'projection.triplanar':  'Triplanar',
    'projection.cubic':      'Kubisch (Box)',
    'projection.cylindrical':'Zylindrisch',
    'projection.spherical':  'Sph\u00e4risch',
    'projection.planarXY':   'Planar XY',
    'projection.planarXZ':   'Planar XZ',
    'projection.planarYZ':   'Planar YZ',

    // Transform section
    'sections.transform':    'Transformation',
    'labels.scaleU':         'Skalierung U',
    'labels.scaleV':         'Skalierung V',
    'labels.offsetU':        'Versatz U',
    'labels.offsetV':        'Versatz V',
    'labels.rotation':       'Rotation',
    'tooltips.proportionalScaling':      'Proportionale Skalierung (U = V)',
    'tooltips.proportionalScalingAria':  'Proportionale Skalierung (U = V)',

    // Displacement section
    'sections.displacement': 'Texturtiefe',
    'labels.amplitude':      'Amplitude',

    // Seam blend
    'labels.seamBlend':              'Nahtglättung \u24d8',
    'tooltips.seamBlend':            'Glättet den scharfen Übergang zwischen Projektionsflächen. Wirksam für Kubische und Zylindrische Modi.',

    // Winkelmaskierung
    'sections.maskAngles':           'Winkel maskieren \u24d8',
    'tooltips.maskAngles':           '0° = keine Maskierung. Fl\u00e4chen innerhalb dieses Winkels zur Horizontalen werden nicht texturiert.',
    'labels.bottomFaces':            'Unterseiten',
    'tooltips.bottomFaces':          'Textur auf nach unten gerichteten Fl\u00e4chen innerhalb dieses Winkels zur Horizontalen unterdr\u00fccken',
    'labels.topFaces':               'Oberseiten',
    'tooltips.topFaces':             'Textur auf nach oben gerichteten Fl\u00e4chen innerhalb dieses Winkels zur Horizontalen unterdr\u00fccken',

    // Surface masking section
    'sections.surfaceMasking':       'Fl\u00e4chenmaskierung \u24d8',
    'sections.surfaceSelection':     'Fl\u00e4chenauswahl',
    'tooltips.surfaceMasking':       'Fl\u00e4chen maskieren, um zu steuern, welche Bereiche Verschiebung erhalten.',
    'tooltips.surfaceSelection':     'Ausgew\u00e4hlte Fl\u00e4chen erscheinen gr\u00fcn und sind die einzigen, die beim Export eine Verschiebung erhalten.',
    'excl.modeExclude':              'Ausschlie\u00dfen',
    'excl.modeExcludeTitle':         'Ausschlussmodus: bemalte Fl\u00e4chen erhalten keine Texturverschiebung',
    'excl.modeIncludeOnly':          'Nur einschlie\u00dfen',
    'excl.modeIncludeOnlyTitle':     'Nur-einschlie\u00dfen-Modus: nur bemalte Fl\u00e4chen erhalten Texturverschiebung',
    'excl.toolBrush':                'Pinsel',
    'excl.toolBrushTitle':           'Pinsel: Dreiecke zum Ausschlie\u00dfen einf\u00e4rben',
    'excl.toolFill':                 'F\u00fcllen',
    'excl.toolFillTitle':            'F\u00fcllen: Fl\u00e4che bis zu einem Winkel fluten',
    'excl.shiftHint':                'Shift gedr\u00fcckt halten zum Radieren',
    'labels.type':                   'Typ',
    'brushType.single':              'Einzeln',
    'brushType.circle':              'Kreis',
    'labels.size':                   'Gr\u00f6\u00dfe',
    'labels.maxAngle':               'Max. Winkel',
    'tooltips.maxAngle':             'Maximaler Di\u00e4dralwinkel zwischen angrenzenden Dreiecken f\u00fcr die F\u00fcllung',
    'ui.clearAll':                   'Alles l\u00f6schen',
    'excl.initExcluded':             '0 Fl\u00e4chen maskiert',
    'excl.faceExcluded':             '{n} Fl\u00e4che maskiert',
    'excl.facesExcluded':            '{n} Fl\u00e4chen maskiert',
    'excl.faceSelected':             '{n} Fl\u00e4che ausgew\u00e4hlt',
    'excl.facesSelected':            '{n} Fl\u00e4chen ausgew\u00e4hlt',
    'excl.hintExclude':              'Maskierte Fl\u00e4chen erscheinen orange und erhalten beim Export keine Verschiebung.',
    'excl.hintInclude':              'Ausgew\u00e4hlte Fl\u00e4chen erscheinen gr\u00fcn und sind die einzigen, die beim Export eine Verschiebung erhalten.',

    // Boundary falloff
    'labels.boundaryFalloff':          'Rand\u00fcbergang \u24d8',
    'tooltips.boundaryFalloff':        'Reduziert die Verschiebung schrittweise auf Null nahe maskierter Grenzen, um Dreiecks\u00fcberschneidungen an \u00dcberg\u00e4ngen zu vermeiden.',

    // Symmetric displacement
    'labels.symmetricDisplacement':  'Symmetrische Verschiebung \u24d8',
    'tooltips.symmetricDisplacement':'Wenn aktiv: 50% Grau = keine Verschiebung; Weiß nach außen, Schwarz nach innen. H\u00e4lt das Volumen des Teils in etwa konstant.',

    // Displacement preview
    'labels.displacementPreview':    '3D-Vorschau \u24d8',
    'tooltips.displacementPreview':  'Unterteilt das Netz und verschiebt Punkte in Echtzeit, damit die tats\u00e4chliche Tiefe sichtbar wird. GPU-intensiv bei komplexen Modellen.',

    // Auf Fl\u00e4che platzieren
    'ui.placeOnFace':                'Auf Fl\u00e4che platzieren',
    'ui.placeOnFaceTitle':           'Klicken Sie auf eine Fl\u00e4che, um sie nach unten auf das Druckbett auszurichten',
    'progress.subdividingPreview':   'Vorschau wird vorbereitet\u2026',

    // Amplitude overlap warning
    'warnings.amplitudeOverlap':     '\u26a0 Amplitude \u00fcberschreitet 10% der kleinsten Modellabmessung \u2014 beim Export k\u00f6nnen Geometrie\u00fcberschneidungen auftreten.',

    // Export section
    'sections.export':               'Export \u24d8',
    'tooltips.export':               'Kleinere Kantenl\u00e4nge = mehr Texturdetails. Die Ausgabe wird dann auf das Dreieckslimit vereinfacht.',
    'labels.resolution':             'Aufl\u00f6sung',
    'tooltips.resolution':           'Kanten l\u00e4nger als dieser Wert werden beim Export unterteilt',
    'labels.outputTriangles':        'Max Dreiecke',
    'tooltips.outputTriangles':      'Das Netz wird zuerst vollst\u00e4ndig unterteilt, dann auf diese Anzahl dezimiert',
    'warnings.safetyCapHit':         '\u26a0 10-Mio.-Dreiecke-Sicherheitsgrenze bei der Unterteilung erreicht \u2014 Ergebnis kann gr\u00f6ber als gew\u00fcnschte Kantenl\u00e4nge sein.',
    'ui.exportStl':                  'STL exportieren',

    // Export progress stages
    'progress.subdividing':          'Netz wird verfeinert\u2026',
    'progress.applyingDisplacement': 'Textur auf {n} Dreiecke anwenden\u2026',
    'progress.displacingVertices':   'Punkte werden verschoben\u2026',
    'progress.decimatingTo':         '{from} \u2192 {to} Dreiecke vereinfachen\u2026',
    'progress.decimating':           'Vereinfachen: {cur} \u2192 {to} Dreiecke',
    'progress.writingStl':           'STL schreiben\u2026',
    'progress.done':                 'Fertig!',
    'progress.processing':           'Verarbeitung\u2026',

    // License popup
    'license.btn':    'Lizenz & Nutzung',
    'license.title':  'Lizenz & Nutzungsbedingungen',
    'license.item1':  'Kostenlos nutzbar f\u00fcr jeden Zweck, auch f\u00fcr <strong>kommerzielle Arbeit</strong> (z.B. Texturierung von STLs f\u00fcr Kunden oder Produkte).',
    'license.item2':  'Namensnennung wird <strong>gesch\u00e4tzt</strong>, ist aber bei der Nutzung dieses Tools <strong>nicht erforderlich</strong>.',
    'license.item3':  'M\u00f6chtest du dieses Tool und unsere Arbeit unterst\u00fctzen? Schau in unserem <a href="https://geni.us/CNCStoreTexture" target="_blank" rel="noopener">Online-Shop</a> vorbei!',

    // Sponsor modal
    'sponsor.title':           'Danke f\u00fcr die Nutzung des CNC Kitchen STL Texturizers!',
    'sponsor.body':            'Dieses Tool wird von CNC Kitchen <strong>komplett kostenlos</strong> bereitgestellt.<br>W\u00e4hrend dein STL verarbeitet wird, schau doch mal im Shop vorbei, der uns hilft, coole Sachen f\u00fcr dich zu machen!',
    'sponsor.visitStore':      '\uD83D\uDED2 CNCKitchen.STORE besuchen',
    'sponsor.dontShow':        'Nicht mehr anzeigen',
    'sponsor.closeAndContinue':'Schlie\u00dfen &amp; Weiter',

    // Store CTA
    'cta.store':            '\uD83D\uDED2 Dieses Tool ist kostenlos - schau deshalb mal bei CNCKitchen.STORE vorbei!',
    'cta.storeDismiss':    'Ausblenden',

    // Alerts
    'alerts.loadFailed':   'STL konnte nicht geladen werden: {msg}',
    'alerts.exportFailed': 'Export fehlgeschlagen: {msg}',
  },
};

// ── State ─────────────────────────────────────────────────────────────────────

let _currentLang = 'en';

// ── Core API ──────────────────────────────────────────────────────────────────

/**
 * Look up a translation key in the current language, falling back to English.
 * Replace {placeholder} tokens with values from `params`.
 */
export function t(key, params = {}) {
  const lang = TRANSLATIONS[_currentLang] || TRANSLATIONS.en;
  let str = lang[key] ?? TRANSLATIONS.en[key] ?? key;
  for (const [k, v] of Object.entries(params)) {
    str = str.replaceAll(`{${k}}`, v);
  }
  return str;
}

export function getLang() {
  return _currentLang;
}

export function setLang(lang) {
  if (!TRANSLATIONS[lang]) return;
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
  // innerHTML (safe: all values are hardcoded in this file, not user input)
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
 * Detect language from localStorage or browser preference and apply.
 * Call once on startup before first render.
 */
export function initLang() {
  const saved = localStorage.getItem('stlt-lang');
  if (saved && TRANSLATIONS[saved]) {
    _currentLang = saved;
  } else if (navigator.language && navigator.language.toLowerCase().startsWith('de')) {
    _currentLang = 'de';
  } else {
    _currentLang = 'en';
  }
  document.documentElement.setAttribute('data-lang', _currentLang);
  document.documentElement.setAttribute('lang', _currentLang);
  applyTranslations();
}
