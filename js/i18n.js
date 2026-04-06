// ── Translations ──────────────────────────────────────────────────────────────
// All UI strings in one place. Use {placeholder} syntax for dynamic values.

export const TRANSLATIONS = {
  en: {
    'lang.name': 'English',
    // Theme toggle
    'theme.dark': 'Dark Theme',
    'theme.light': 'Light Theme',
    'theme.toggleTitle': 'Toggle light / dark mode',
    'theme.toggleAriaLabel': 'Toggle light/dark mode',

    // Drop zone
    'dropHint.text': 'Drop an <strong>.stl</strong>, <strong>.obj</strong> or <strong>.3mf</strong> file here<br/>or <label for="stl-file-input" class="link-label">click to browse</label>',

    // Viewport footer
    'ui.wireframe': 'Wireframe',
    'ui.controlsHint': 'Left drag: orbit \u00a0·\u00a0 Right drag: pan \u00a0·\u00a0 Scroll: zoom',
    'ui.meshInfo': '{n} triangles · {mb} MB · {sx} × {sy} × {sz} mm',

    // Load model button
    'ui.loadStl': 'Load Model\u2026',

    // Displacement map section
    'sections.displacementMap': 'Displacement Map',
    'ui.uploadCustomMap': 'Upload custom map',
    'ui.noMapSelected': 'No map selected',

    // Projection section
    'sections.projection': 'Projection',
    'labels.mode': 'Mode',
    'projection.triplanar': 'Triplanar',
    'projection.cubic': 'Cubic (Box)',
    'projection.cylindrical': 'Cylindrical',
    'projection.spherical': 'Spherical',
    'projection.planarXY': 'Planar XY',
    'projection.planarXZ': 'Planar XZ',
    'projection.planarYZ': 'Planar YZ',

    // Transform section
    'sections.transform': 'Transform',
    'labels.scaleU': 'Scale U',
    'labels.scaleV': 'Scale V',
    'labels.offsetU': 'Offset U',
    'labels.offsetV': 'Offset V',
    'labels.rotation': 'Rotation',
    'tooltips.proportionalScaling': 'Proportional scaling (U = V)',
    'tooltips.proportionalScalingAria': 'Proportional scaling (U = V)',

    // Displacement section
    'sections.displacement': 'Texture Depth',
    'labels.amplitude': 'Amplitude',

    // Seam blend
    'labels.seamBlend': 'Seam Blend \u24d8',
    'tooltips.seamBlend': 'Softens the hard seam where projection faces meet. Effective for Cubic and Cylindrical modes.',
    'labels.transitionSmoothing': 'Transition Smoothing \u24d8',
    'tooltips.transitionSmoothing': 'Width of the blending zone near seam edges. Lower values keep transitions tight to the seam; higher values blend a wider band.',
    'labels.textureSmoothing': 'Texture Smoothing \u24d8',
    'tooltips.textureSmoothing': 'Applies a Gaussian blur to the displacement map. Higher values produce softer, more gradual surface detail. 0 = off.',
    'labels.capAngle': 'Cap Angle \u24d8',
    'tooltips.capAngle': 'Angle (in degrees) from vertical at which the top/bottom cap projection kicks in. Smaller values limit cap projection to nearly flat faces.',

    // Mask angles section
    'sections.maskAngles': 'Mask Angles \u24d8',
    'tooltips.maskAngles': '0° = no masking. Surfaces within this angle of horizontal will not be textured.',
    'labels.bottomFaces': 'Bottom faces',
    'tooltips.bottomFaces': 'Suppress texture on downward-facing surfaces within this angle of horizontal',
    'labels.topFaces': 'Top faces',
    'tooltips.topFaces': 'Suppress texture on upward-facing surfaces within this angle of horizontal',

    // Surface masking section
    'sections.surfaceMasking': 'Surface Masking \u24d8',
    'sections.surfaceSelection': 'Surface Selection',
    'tooltips.surfaceMasking': 'Mask surfaces to control which areas receive displacement.',
    'tooltips.surfaceSelection': 'Selected surfaces appear green and will be the only ones to receive displacement during export.',
    'excl.modeExclude': 'Exclude',
    'excl.modeExcludeTitle': 'Exclude mode: painted surfaces will not receive texture displacement',
    'excl.modeIncludeOnly': 'Include Only',
    'excl.modeIncludeOnlyTitle': 'Include Only mode: only painted surfaces will receive texture displacement',
    'excl.toolBrush': 'Brush',
    'excl.toolBrushTitle': 'Brush: paint triangles to exclude',
    'excl.toolFill': 'Fill',
    'excl.toolFillTitle': 'Bucket fill: flood-fill surface up to a threshold angle',
    'excl.shiftHint': 'Hold Shift to erase',
    'labels.type': 'Type',
    'brushType.single': 'Single',
    'brushType.circle': 'Circle',
    'labels.size': 'Size',
    'labels.maxAngle': 'Max angle',
    'tooltips.maxAngle': 'Maximum dihedral angle between adjacent triangles for the fill to cross',
    'ui.clearAll': 'Clear All',
    'excl.initExcluded': '0 faces masked',
    'excl.faceExcluded': '{n} face masked',
    'excl.facesExcluded': '{n} faces masked',
    'excl.faceSelected': '{n} face selected',
    'excl.facesSelected': '{n} faces selected',
    'excl.hintExclude': 'Masked surfaces appear orange and will not receive displacement during export.',
    'excl.hintInclude': 'Selected surfaces appear green and will be the only ones to receive displacement during export.',

    // Precision masking
    'precision.label': 'Precision (Beta) \u24d8',
    'precision.labelTitle': 'Subdivide mesh in the background so the brush selects at finer granularity',
    'precision.outdated': '\u26a0 Outdated',
    'precision.refreshTitle': 'Re-subdivide mesh to match current brush size',
    'precision.triCount': '{n} \u25b3',
    'precision.refining': 'Refining\u2026',
    'precision.warningBody': 'Estimated ~{n} triangles. This may slow down your browser. Continue?',

    // Boundary falloff
    'labels.boundaryFalloff':          'Boundary Falloff \u24d8',
    'tooltips.boundaryFalloff':        'Gradually reduces displacement to zero near masked boundaries, preventing triangle overlap where textured and non-textured regions meet.',

    // Symmetric displacement
    'labels.symmetricDisplacement': 'Symmetric displacement \u24d8',
    'tooltips.symmetricDisplacement': 'When on, 50% grey = no displacement; white pushes out, black pushes in. Keeps part volume roughly constant.',

    // Displacement preview
    'labels.displacementPreview': '3D Preview \u24d8',
    'tooltips.displacementPreview': 'Subdivides the mesh and displaces vertices in real-time so you can judge the actual depth. GPU-intensive on complex models.',

    // Place on face
    'ui.placeOnFace': 'Place on Face',
    'ui.placeOnFaceTitle': 'Click a face to orient it downward onto the print bed',
    'progress.subdividingPreview': 'Preparing preview\u2026',

    // Amplitude overlap warning
    'warnings.amplitudeOverlap': '\u26a0 Amplitude exceeds 10% of the smallest model dimension \u2014 geometry overlaps may occur in the exported STL.',

    // Export section
    'sections.export': 'Export \u24d8',
    'tooltips.export': 'Smaller edge length = finer displacement detail. Output is then decimated to the triangle limit.',
    'labels.resolution': 'Resolution',
    'tooltips.resolution': 'Edges longer than this value will be split during export',
    'labels.outputTriangles': 'Output Triangles',
    'tooltips.outputTriangles': 'Mesh is fully subdivided first, then decimated down to this count',
    'warnings.safetyCapHit': '\u26a0 20M-triangle safety cap hit during subdivision \u2014 result may still be coarser than requested edge length.',
    'ui.exportStl': 'Export STL',

    // Export progress stages
    'progress.subdividing': 'Subdividing mesh\u2026',
    'progress.refining': 'Refining: {cur} triangles, longest edge {edge}',
    'progress.applyingDisplacement': 'Applying displacement to {n} triangles\u2026',
    'progress.displacingVertices': 'Displacing vertices\u2026',
    'progress.decimatingTo': 'Simplifying {from} \u2192 {to} triangles\u2026',
    'progress.decimating': 'Simplifying: {cur} \u2192 {to} triangles',
    'progress.writingStl': 'Writing STL\u2026',
    'progress.done': 'Done!',
    'progress.processing': 'Processing\u2026',

    // License popup
    'license.btn':    'License & Terms',
    'license.title':  'License & Terms',
    'license.item1':  'Free to use for any purpose, including <strong>commercial work</strong> (e.g., texturing STLs for clients or products).',
    'license.item2':  'Attribution is <strong>appreciated</strong> but <strong>not required</strong> when using this tool as-is.',
    'license.item3':  'Support this tool? Shop at <a href="https://geni.us/CNCStoreTexture" target="_blank" rel="noopener">CNCKitchen.STORE</a> or donate on <a href="https://www.paypal.me/CNCKitchen" target="_blank" rel="noopener">PayPal</a>.',
    'license.item4':  'This tool is provided <strong>as-is</strong> with <strong>no warranty</strong> of any kind. Use at your own risk.',
    'license.item5':  '<strong>No support</strong> is provided. The author is under no obligation to fix bugs, answer questions, or update this tool. That said, bug reports and feature requests are always welcome at <a href="mailto:texturizer@cnckitchen.com">texturizer@cnckitchen.com</a>.',
    'license.item6':  'The author shall not be held <strong>liable</strong> for any damages, data loss, or issues arising from the use of this tool.',
    'license.item7':  'Want to license or embed this tool for your own business or website? Contact us at <a href="mailto:contact@cnckitchen.com">contact@cnckitchen.com</a>.',
    'license.item8':  'Source code available on <a href="https://github.com/CNCKitchen/stlTexturizer" target="_blank" rel="noopener">GitHub</a>.',

    // Imprint & Privacy
    'imprint.btn': 'Imprint & Privacy',
    'imprint.title': 'Imprint & Privacy Policy',
    'imprint.sectionImprint': 'Imprint (Impressum)',
    'imprint.info': 'CNC Kitchen<br>Stefan Hermann<br>Bahnhofstr. 2<br>88145 Hergatz<br>Germany',
    'imprint.contact': 'Email: <a href="mailto:contact@cnckitchen.com">contact@cnckitchen.com</a><br>Phone: +49 175 2011824<br><em>The phone number is for legal/business inquiries only \u2014 not for support.</em>',
    'imprint.odr': 'EU Online Dispute Resolution platform: <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noopener">https://ec.europa.eu/consumers/odr</a>',
    'imprint.sectionPrivacy': 'Privacy Policy (Datenschutzerkl\u00e4rung)',
    'imprint.privacyIntro': '<strong>Responsible party</strong> (Verantwortlicher gem. Art. 4 Abs. 7 DSGVO): Stefan Hermann, Bahnhofstr. 2, 88145 Hergatz, Germany.',
    'imprint.privacyHosting': 'This website is hosted on <strong>GitHub Pages</strong> (GitHub Inc. / Microsoft Corp., 88 Colin P Kelly Jr St, San Francisco, CA 94107, USA). When you visit this site, GitHub may process your IP address in server logs. Legal basis: Art. 6(1)(f) DSGVO (legitimate interest in providing the website). See <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" target="_blank" rel="noopener">GitHub\u2019s Privacy Statement</a>.',
    'imprint.privacyLocal': 'This tool stores user preferences (language, theme) in your browser\u2019s <strong>localStorage</strong>. This data never leaves your device and is not transmitted to any server.',
    'imprint.privacyNoCookies': 'This website does <strong>not</strong> use cookies, analytics, or any tracking technologies.',
    'imprint.privacyExternal': 'This site contains links to external websites (e.g., CNCKitchen.STORE, PayPal). These sites have their own privacy policies, over which we have no control.',
    'imprint.privacyRights': 'Under the GDPR you have the right to <strong>access, rectification, erasure, restriction of processing, data portability</strong>, and the right to <strong>lodge a complaint</strong> with a supervisory authority.',

    // Sponsor modal
    'sponsor.title': 'Thanks for using BumpMesh by CNC Kitchen!',
    'sponsor.body': 'This tool is provided <strong>completely free</strong> by CNC Kitchen.<br>While your STL is being processed, why not check out the store that helps us keep making cool stuff for you?',
    'sponsor.visitStore': '\uD83D\uDED2 Visit CNCKitchen.STORE',
    'sponsor.donate': '\uD83D\uDC99 Donate on PayPal',
    'sponsor.dontShow': "Don\u2019t show this again",
    'sponsor.closeAndContinue': 'Close &amp; Continue',

    // Store CTA
    'cta.store': 'Support this tool? Shop at <a href="https://geni.us/CNCStoreTexture" target="_blank" rel="noopener noreferrer">CNCKitchen.STORE</a> or donate on <a href="https://www.paypal.me/CNCKitchen" target="_blank" rel="noopener noreferrer">PayPal</a>',
    'cta.storeDismiss': 'Dismiss',

    // Alerts
    'alerts.loadFailed': 'Could not load model: {msg}',
    'alerts.exportFailed': 'Export failed: {msg}',
  },

  de: {
    'lang.name': 'Deutsch',
    // Theme toggle
    'theme.dark': 'Dunkles Design',
    'theme.light': 'Helles Design',
    'theme.toggleTitle': 'Hell/Dunkel-Modus wechseln',
    'theme.toggleAriaLabel': 'Hell/Dunkel-Modus wechseln',

    // Drop zone
    'dropHint.text': '<strong>.stl</strong>-, <strong>.obj</strong>- oder <strong>.3mf</strong>-Datei hier ablegen<br/>oder <label for="stl-file-input" class="link-label">zum Durchsuchen klicken</label>',

    // Viewport footer
    'ui.wireframe': 'Drahtgitter',
    'ui.controlsHint': 'Linke Maustaste: Drehen \u00a0·\u00a0 Rechte Maustaste: Verschieben \u00a0·\u00a0 Mausrad: Zoomen',
    'ui.meshInfo': '{n} Dreiecke · {mb} MB · {sx} × {sy} × {sz} mm',

    // Load model button
    'ui.loadStl': 'Modell laden\u2026',

    // Displacement map section
    'sections.displacementMap': 'Textur',
    'ui.uploadCustomMap': 'Eigene Textur hochladen',
    'ui.noMapSelected': 'Keine Textur ausgew\u00e4hlt',

    // Projection section
    'sections.projection': 'Projektion',
    'labels.mode': 'Modus',
    'projection.triplanar': 'Triplanar',
    'projection.cubic': 'Kubisch (Box)',
    'projection.cylindrical': 'Zylindrisch',
    'projection.spherical': 'Sph\u00e4risch',
    'projection.planarXY': 'Planar XY',
    'projection.planarXZ': 'Planar XZ',
    'projection.planarYZ': 'Planar YZ',

    // Transform section
    'sections.transform': 'Transformation',
    'labels.scaleU': 'Skalierung U',
    'labels.scaleV': 'Skalierung V',
    'labels.offsetU': 'Versatz U',
    'labels.offsetV': 'Versatz V',
    'labels.rotation': 'Rotation',
    'tooltips.proportionalScaling': 'Proportionale Skalierung (U = V)',
    'tooltips.proportionalScalingAria': 'Proportionale Skalierung (U = V)',

    // Displacement section
    'sections.displacement': 'Texturtiefe',
    'labels.amplitude': 'Amplitude',

    // Seam blend
    'labels.seamBlend': 'Nahtglättung \u24d8',
    'tooltips.seamBlend': 'Glättet den scharfen Übergang zwischen Projektionsflächen. Wirksam für Kubische und Zylindrische Modi.',
    'labels.transitionSmoothing': 'Übergangsglättung \u24d8',
    'tooltips.transitionSmoothing': 'Breite der Übergangszone an Nahtkanten. Niedrige Werte halten den Übergang nah an der Naht; höhere Werte glätten einen breiteren Bereich.',
    'labels.textureSmoothing': 'Texturglättung \u24d8',
    'tooltips.textureSmoothing': 'Wendet einen Gaußschen Weichzeichner auf die Verschiebungskarte an. Höhere Werte erzeugen weichere, fließendere Oberflächendetails. 0 = aus.',
    'labels.capAngle': 'Übergangswinkel \u24d8',
    'tooltips.capAngle': 'Winkel (in Grad) ab dem die Deckel-/Bodenprojektion einsetzt. Kleinere Werte beschränken die Deckelprojektion auf nahezu flache Flächen.',

    // Winkelmaskierung
    'sections.maskAngles': 'Winkel maskieren \u24d8',
    'tooltips.maskAngles': '0° = keine Maskierung. Fl\u00e4chen innerhalb dieses Winkels zur Horizontalen werden nicht texturiert.',
    'labels.bottomFaces': 'Unterseiten',
    'tooltips.bottomFaces': 'Textur auf nach unten gerichteten Fl\u00e4chen innerhalb dieses Winkels zur Horizontalen unterdr\u00fccken',
    'labels.topFaces': 'Oberseiten',
    'tooltips.topFaces': 'Textur auf nach oben gerichteten Fl\u00e4chen innerhalb dieses Winkels zur Horizontalen unterdr\u00fccken',

    // Surface masking section
    'sections.surfaceMasking': 'Fl\u00e4chenmaskierung \u24d8',
    'sections.surfaceSelection': 'Fl\u00e4chenauswahl',
    'tooltips.surfaceMasking': 'Fl\u00e4chen maskieren, um zu steuern, welche Bereiche Verschiebung erhalten.',
    'tooltips.surfaceSelection': 'Ausgew\u00e4hlte Fl\u00e4chen erscheinen gr\u00fcn und sind die einzigen, die beim Export eine Verschiebung erhalten.',
    'excl.modeExclude': 'Ausschlie\u00dfen',
    'excl.modeExcludeTitle': 'Ausschlussmodus: bemalte Fl\u00e4chen erhalten keine Texturverschiebung',
    'excl.modeIncludeOnly': 'Nur einschlie\u00dfen',
    'excl.modeIncludeOnlyTitle': 'Nur-einschlie\u00dfen-Modus: nur bemalte Fl\u00e4chen erhalten Texturverschiebung',
    'excl.toolBrush': 'Pinsel',
    'excl.toolBrushTitle': 'Pinsel: Dreiecke zum Ausschlie\u00dfen einf\u00e4rben',
    'excl.toolFill': 'F\u00fcllen',
    'excl.toolFillTitle': 'F\u00fcllen: Fl\u00e4che bis zu einem Winkel fluten',
    'excl.shiftHint': 'Shift gedr\u00fcckt halten zum Radieren',
    'labels.type': 'Typ',
    'brushType.single': 'Einzeln',
    'brushType.circle': 'Kreis',
    'labels.size': 'Gr\u00f6\u00dfe',
    'labels.maxAngle': 'Max. Winkel',
    'tooltips.maxAngle': 'Maximaler Di\u00e4dralwinkel zwischen angrenzenden Dreiecken f\u00fcr die F\u00fcllung',
    'ui.clearAll': 'Alles l\u00f6schen',
    'excl.initExcluded': '0 Fl\u00e4chen maskiert',
    'excl.faceExcluded': '{n} Fl\u00e4che maskiert',
    'excl.facesExcluded': '{n} Fl\u00e4chen maskiert',
    'excl.faceSelected': '{n} Fl\u00e4che ausgew\u00e4hlt',
    'excl.facesSelected': '{n} Fl\u00e4chen ausgew\u00e4hlt',
    'excl.hintExclude': 'Maskierte Fl\u00e4chen erscheinen orange und erhalten beim Export keine Verschiebung.',
    'excl.hintInclude': 'Ausgew\u00e4hlte Fl\u00e4chen erscheinen gr\u00fcn und sind die einzigen, die beim Export eine Verschiebung erhalten.',

    // Precision masking
    'precision.label': 'Pr\u00e4zision (Beta) \u24d8',
    'precision.labelTitle': 'Netz im Hintergrund unterteilen, damit der Pinsel feiner ausw\u00e4hlen kann',
    'precision.outdated': '\u26a0 Veraltet',
    'precision.refreshTitle': 'Netz erneut unterteilen, um zur aktuellen Pinselgr\u00f6\u00dfe zu passen',
    'precision.triCount': '{n} \u25b3',
    'precision.refining': 'Wird verfeinert\u2026',
    'precision.warningBody': 'Gesch\u00e4tzt ~{n} Dreiecke. Dies kann den Browser verlangsamen. Fortfahren?',

    // Boundary falloff
    'labels.boundaryFalloff':          'Rand\u00fcbergang \u24d8',
    'tooltips.boundaryFalloff':        'Reduziert die Verschiebung schrittweise auf Null nahe maskierter Grenzen, um Dreiecks\u00fcberschneidungen an \u00dcberg\u00e4ngen zu vermeiden.',

    // Symmetric displacement
    'labels.symmetricDisplacement': 'Symmetrische Verschiebung \u24d8',
    'tooltips.symmetricDisplacement': 'Wenn aktiv: 50% Grau = keine Verschiebung; Weiß nach außen, Schwarz nach innen. H\u00e4lt das Volumen des Teils in etwa konstant.',

    // Displacement preview
    'labels.displacementPreview': '3D-Vorschau \u24d8',
    'tooltips.displacementPreview': 'Unterteilt das Netz und verschiebt Punkte in Echtzeit, damit die tats\u00e4chliche Tiefe sichtbar wird. GPU-intensiv bei komplexen Modellen.',

    // Auf Fl\u00e4che platzieren
    'ui.placeOnFace': 'Auf Fl\u00e4che platzieren',
    'ui.placeOnFaceTitle': 'Klicken Sie auf eine Fl\u00e4che, um sie nach unten auf das Druckbett auszurichten',
    'progress.subdividingPreview': 'Vorschau wird vorbereitet\u2026',

    // Amplitude overlap warning
    'warnings.amplitudeOverlap': '\u26a0 Amplitude \u00fcberschreitet 10% der kleinsten Modellabmessung \u2014 beim Export k\u00f6nnen Geometrie\u00fcberschneidungen auftreten.',

    // Export section
    'sections.export': 'Export \u24d8',
    'tooltips.export': 'Kleinere Kantenl\u00e4nge = mehr Texturdetails. Die Ausgabe wird dann auf das Dreieckslimit vereinfacht.',
    'labels.resolution': 'Aufl\u00f6sung',
    'tooltips.resolution': 'Kanten l\u00e4nger als dieser Wert werden beim Export unterteilt',
    'labels.outputTriangles': 'Max Dreiecke',
    'tooltips.outputTriangles': 'Das Netz wird zuerst vollst\u00e4ndig unterteilt, dann auf diese Anzahl dezimiert',
    'warnings.safetyCapHit': '\u26a0 20-Mio.-Dreiecke-Sicherheitsgrenze bei der Unterteilung erreicht \u2014 Ergebnis kann gr\u00f6ber als gew\u00fcnschte Kantenl\u00e4nge sein.',
    'ui.exportStl': 'STL exportieren',

    // Export progress stages
    'progress.subdividing': 'Netz wird verfeinert\u2026',
    'progress.refining': 'Verfeinern: {cur} Dreiecke, l\u00e4ngste Kante {edge}',
    'progress.applyingDisplacement': 'Textur auf {n} Dreiecke anwenden\u2026',
    'progress.displacingVertices': 'Punkte werden verschoben\u2026',
    'progress.decimatingTo': '{from} \u2192 {to} Dreiecke vereinfachen\u2026',
    'progress.decimating': 'Vereinfachen: {cur} \u2192 {to} Dreiecke',
    'progress.writingStl': 'STL schreiben\u2026',
    'progress.done': 'Fertig!',
    'progress.processing': 'Verarbeitung\u2026',

    // License popup
    'license.btn':    'Lizenz & Nutzung',
    'license.title':  'Lizenz & Nutzungsbedingungen',
    'license.item1':  'Kostenlos nutzbar f\u00fcr jeden Zweck, auch f\u00fcr <strong>kommerzielle Arbeit</strong> (z.B. Texturierung von STLs f\u00fcr Kunden oder Produkte).',
    'license.item2':  'Namensnennung wird <strong>gesch\u00e4tzt</strong>, ist aber bei der Nutzung dieses Tools <strong>nicht erforderlich</strong>.',
    'license.item3':  'Dieses Tool unterst\u00fctzen? Shoppe bei <a href="https://geni.us/CNCStoreTexture" target="_blank" rel="noopener">CNCKitchen.STORE</a> oder spende via <a href="https://www.paypal.me/CNCKitchen" target="_blank" rel="noopener">PayPal</a>.',
    'license.item4':  'Dieses Tool wird <strong>ohne jegliche Gew\u00e4hrleistung</strong> bereitgestellt. Nutzung auf <strong>eigene Gefahr</strong>.',
    'license.item5':  'Es wird <strong>kein Support</strong> geleistet. Der Autor ist nicht verpflichtet, Fehler zu beheben, Fragen zu beantworten oder das Tool zu aktualisieren. Fehlerberichte und Funktionswünsche sind aber jederzeit willkommen unter <a href="mailto:texturizer@cnckitchen.com">texturizer@cnckitchen.com</a>.',
    'license.item6':  'Der Autor haftet nicht f\u00fcr <strong>Sch\u00e4den</strong>, Datenverlust oder Probleme, die durch die Nutzung dieses Tools entstehen.',
    'license.item7':  'Sie m\u00f6chten dieses Tool f\u00fcr Ihr eigenes Unternehmen oder Ihre Website lizenzieren oder einbinden? Kontaktieren Sie uns unter <a href="mailto:contact@cnckitchen.com">contact@cnckitchen.com</a>.',
    'license.item8':  'Quellcode verf\u00fcgbar auf <a href="https://github.com/CNCKitchen/stlTexturizer" target="_blank" rel="noopener">GitHub</a>.',

    // Impressum & Datenschutz
    'imprint.btn': 'Impressum & Datenschutz',
    'imprint.title': 'Impressum & Datenschutzerkl\u00e4rung',
    'imprint.sectionImprint': 'Impressum',
    'imprint.info': 'CNC Kitchen<br>Stefan Hermann<br>Bahnhofstr. 2<br>88145 Hergatz<br>Deutschland',
    'imprint.contact': 'E-Mail: <a href="mailto:contact@cnckitchen.com">contact@cnckitchen.com</a><br>Telefon: +49 175 2011824<br><em>Die Telefonnummer ist ausschlie\u00dflich f\u00fcr rechtliche/gesch\u00e4ftliche Anfragen \u2014 nicht f\u00fcr Support.</em>',
    'imprint.odr': 'Plattform der EU-Kommission zur Online-Streitbeilegung: <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noopener">https://ec.europa.eu/consumers/odr</a>',
    'imprint.sectionPrivacy': 'Datenschutzerkl\u00e4rung',
    'imprint.privacyIntro': '<strong>Verantwortlicher</strong> gem. Art. 4 Abs. 7 DSGVO: Stefan Hermann, Bahnhofstr. 2, 88145 Hergatz, Deutschland.',
    'imprint.privacyHosting': 'Diese Website wird auf <strong>GitHub Pages</strong> (GitHub Inc. / Microsoft Corp., 88 Colin P Kelly Jr St, San Francisco, CA 94107, USA) gehostet. Beim Besuch dieser Seite kann GitHub Ihre IP-Adresse in Server-Logs verarbeiten. Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an der Bereitstellung der Website). Siehe <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" target="_blank" rel="noopener">Datenschutzerkl\u00e4rung von GitHub</a>.',
    'imprint.privacyLocal': 'Dieses Tool speichert Nutzereinstellungen (Sprache, Theme) im <strong>localStorage</strong> Ihres Browsers. Diese Daten verlassen Ihr Ger\u00e4t nicht und werden nicht an einen Server \u00fcbertragen.',
    'imprint.privacyNoCookies': 'Diese Website verwendet <strong>keine</strong> Cookies, Analyse-Tools oder sonstige Tracking-Technologien.',
    'imprint.privacyExternal': 'Diese Seite enth\u00e4lt Links zu externen Websites (z.B. CNCKitchen.STORE, PayPal). F\u00fcr deren Datenschutzrichtlinien \u00fcbernehmen wir keine Verantwortung.',
    'imprint.privacyRights': 'Nach der DSGVO haben Sie das Recht auf <strong>Auskunft, Berichtigung, L\u00f6schung, Einschr\u00e4nkung der Verarbeitung, Daten\u00fcbertragbarkeit</strong> sowie das Recht auf <strong>Beschwerde bei einer Aufsichtsbeh\u00f6rde</strong>.',

    // Sponsor modal
    'sponsor.title': 'Danke für die Nutzung von BumpMesh by CNC Kitchen!',
    'sponsor.body': 'Dieses Tool wird von CNC Kitchen <strong>komplett kostenlos</strong> bereitgestellt.<br>Während dein STL verarbeitet wird, schau doch mal im Shop vorbei, der uns hilft, coole Sachen für dich zu machen!',
    'sponsor.visitStore': '\uD83D\uDED2 CNCKitchen.STORE besuchen',
    'sponsor.donate': '\uD83D\uDC99 Via PayPal spenden',
    'sponsor.dontShow': 'Nicht mehr anzeigen',
    'sponsor.closeAndContinue': 'Schlie\u00dfen &amp; Weiter',

    // Store CTA
    'cta.store': 'Dieses Tool unterst\u00fctzen? Shoppe bei <a href="https://geni.us/CNCStoreTexture" target="_blank" rel="noopener noreferrer">CNCKitchen.STORE</a> oder spende via <a href="https://www.paypal.me/CNCKitchen" target="_blank" rel="noopener noreferrer">PayPal</a>',
    'cta.storeDismiss': 'Ausblenden',

    // Alerts
    'alerts.loadFailed': 'Modell konnte nicht geladen werden: {msg}',
    'alerts.exportFailed': 'Export fehlgeschlagen: {msg}',
  },

  it: {
    'lang.name': 'Italiano',
    // Theme toggle
    'theme.dark': 'Tema Scuro',
    'theme.light': 'Tema Chiaro',
    'theme.toggleTitle': 'Attiva/disattiva modalità chiara/scura',
    'theme.toggleAriaLabel': 'Attiva/disattiva modalità chiara/scura',

    // Drop zone
    'dropHint.text': 'Trascina qui un file <strong>.stl</strong>, <strong>.obj</strong> o <strong>.3mf</strong><br/>o <label for="stl-file-input" class="link-label">clicca per sfogliare</label>',

    // Viewport footer
    'ui.wireframe': 'Wireframe',
    'ui.controlsHint': 'Trascina a sx: orbita \u00a0·\u00a0 Trascina a dx: sposta \u00a0·\u00a0 Scorri: zoom',
    'ui.meshInfo': '{n} triangoli · {mb} MB · {sx} × {sy} × {sz} mm',

    // Load model button
    'ui.loadStl': 'Carica Modello\u2026',

    // Displacement map section
    'sections.displacementMap': 'Mappa di Deformazione',
    'ui.uploadCustomMap': 'Carica mappa personalizzata',
    'ui.noMapSelected': 'Nessuna mappa selezionata',

    // Projection section
    'sections.projection': 'Proiezione',
    'labels.mode': 'Modalità',
    'projection.triplanar': 'Triplanare',
    'projection.cubic': 'Cubica (Box)',
    'projection.cylindrical': 'Cilindrica',
    'projection.spherical': 'Sferica',
    'projection.planarXY': 'Planare XY',
    'projection.planarXZ': 'Planare XZ',
    'projection.planarYZ': 'Planare YZ',

    // Transform section
    'sections.transform': 'Trasformazioni',
    'labels.scaleU': 'Scala U',
    'labels.scaleV': 'Scala V',
    'labels.offsetU': 'Offset U',
    'labels.offsetV': 'Offset V',
    'labels.rotation': 'Rotazione',
    'tooltips.proportionalScaling': 'Scala proporzionale (U = V)',
    'tooltips.proportionalScalingAria': 'Scala proporzionale (U = V)',

    // Displacement section
    'sections.displacement': 'Profondità Texture',
    'labels.amplitude': 'Ampiezza',

    // Seam blend
    'labels.seamBlend': 'Unione dei bordi \u24d8',
    'tooltips.seamBlend': 'Attenua il bordo netto dove si incontrano le facce della proiezione. Efficace per le modalità Cubica e Cilindrica.',
    'labels.transitionSmoothing': 'Smoothing di transizione \u24d8',
    'tooltips.transitionSmoothing': 'Larghezza della zona di fusione vicino ai bordi della giuntura. Valori più bassi mantengono le transizioni aderenti alla giuntura; valori più alti sfumano una fascia più ampia.',
    'labels.textureSmoothing': 'Smoothing della texture \u24d8',
    'tooltips.textureSmoothing': 'Applica una sfocatura gaussiana alla mappa di deformazione. Valori più alti producono dettagli superficiali più morbidi e graduali. 0 = disattivato.',
    'labels.capAngle': 'Angolo di copertura \u24d8',
    'tooltips.capAngle': 'Angolo (in gradi) rispetto alla verticale al quale entra in gioco la proiezione della copertura superiore/inferiore. Valori più piccoli limitano la proiezione della copertura a facce quasi piatte.',

    // Mask angles section
    'sections.maskAngles': 'Angoli di mascheramento \u24d8',
    'tooltips.maskAngles': '0° = nessuna mascheratura. Le superfici comprese in questo angolo rispetto all\'orizzontale non saranno texturizzate.',
    'labels.bottomFaces': 'Facce inferiori',
    'tooltips.bottomFaces': 'Elimina la texture sulle superfici rivolte verso il basso entro questo angolo rispetto all\'orizzontale',
    'labels.topFaces': 'Facce superiori',
    'tooltips.topFaces': 'Elimina la texture sulle superfici rivolte verso l\'alto entro questo angolo rispetto all\'orizzontale',

    // Surface masking section
    'sections.surfaceMasking': 'Mascheramento delle superfici \u24d8',
    'sections.surfaceSelection': 'Selezione delle superfici',
    'tooltips.surfaceMasking': 'Mascherare le superfici per controllare quali aree subiscono la deformazione.',
    'tooltips.surfaceSelection': 'Le superfici selezionate appaiono in verde e saranno le uniche a subire la deformazione durante l\'esportazione.',
    'excl.modeExclude': 'Escludi',
    'excl.modeExcludeTitle': 'Modalità Escludi: le superfici dipinte non subiranno la deformazione della texture',
    'excl.modeIncludeOnly': 'Includi solo',
    'excl.modeIncludeOnlyTitle': 'Modalità Includi solo: solo le superfici dipinte subiranno la deformazione della texture',
    'excl.toolBrush': 'Pennello',
    'excl.toolBrushTitle': 'Pennello: dipingi i triangoli da escludere',
    'excl.toolFill': 'Riempimento',
    'excl.toolFillTitle': 'Riempimento a secchiello: riempi la superficie fino a un angolo di soglia',
    'excl.shiftHint': 'Tieni premuto Shift per cancellare',
    'labels.type': 'Tipo',
    'brushType.single': 'Singolo',
    'brushType.circle': 'Cerchio',
    'labels.size': 'Dimensione',
    'labels.maxAngle': 'Angolo massimo',
    'tooltips.maxAngle': 'Angolo diedro massimo tra triangoli adiacenti che il riempimento può attraversare',
    'ui.clearAll': 'Cancella tutto',
    'excl.initExcluded': '0 facce mascherate',
    'excl.faceExcluded': '{n} facce mascherate',
    'excl.facesExcluded': '{n} facce mascherate',
    'excl.faceSelected': '{n} faccia selezionata',
    'excl.facesSelected': '{n} facce selezionate',
    'excl.hintExclude': 'Le superfici mascherate appaiono in arancione e non riceveranno deformazione durante l\'esportazione',
    'excl.hintInclude': 'Le superfici selezionate appaiono verdi e saranno le uniche a ricevere la deformazione durante l\'esportazione.',

    // Precision masking
    'precision.label': 'Precisione (Beta) \u24d8',
    'precision.labelTitle': 'Suddividi la mesh in background in modo che il pennello selezioni con una granularità più fine',
    'precision.outdated': '\u26a0 Obsoleto',
    'precision.refreshTitle': 'Risuddividi la mesh per adattarla alle dimensioni attuali del pennello',
    'precision.triCount': '{n} \u25b3',
    'precision.refining': 'Raffinamento\u2026',
    'precision.warningBody': 'Stima ~{n} triangoli. Ciò potrebbe rallentare il browser. Continuare?',

    // Boundary falloff
    'labels.boundaryFalloff':          'Sfumatura bordo \u24d8',
    'tooltips.boundaryFalloff':        'Riduce gradualmente la deformazione a zero vicino ai bordi mascherati, impedendo sovrapposizioni di triangoli tra zone con e senza texture.',

    // Symmetric displacement
    'labels.symmetricDisplacement': 'Deformazione simmetrica \u24d8',
    'tooltips.symmetricDisplacement': 'Quando è attivo, il grigio al 50% = nessuna deformazione; il bianco spinge verso l\'esterno, il nero spinge verso l\'interno. Mantiene il volume della parte approssimativamente costante.',

    // Displacement preview
    'labels.displacementPreview': 'Anteprima 3D \u24d8',
    'tooltips.displacementPreview': 'Suddivide la mesh e sposta i vertici in tempo reale in modo da poter valutare la profondità effettiva. Richiede un uso intensivo della GPU su modelli complessi.',

    // Place on face
    'ui.placeOnFace': 'Posiziona su una faccia',
    'ui.placeOnFaceTitle': 'Clicca su una faccia per orientarla verso il basso sul piano di stampa',
    'progress.subdividingPreview': 'Preparazione dell\'anteprima...',

    // Amplitude overlap warning
    'warnings.amplitudeOverlap': '\u26a0 L\'ampiezza supera il 10% della dimensione più piccola del modello \u2014 potrebbero verificarsi sovrapposizioni geometriche nel file STL esportato.',


    // Export section
    'sections.export': 'Esporta \u24d8',
    'tooltips.export': 'Lunghezza del bordo più piccola = dettagli della deformazione più precisi. L\'output viene quindi ridotto al limite di triangoli.',
    'labels.resolution': 'Risoluzione',
    'tooltips.resolution': 'I bordi più lunghi di questo valore verranno suddivisi durante l\'esportazione',
    'labels.outputTriangles': 'Triangoli in uscita',
    'tooltips.outputTriangles': 'La mesh viene prima suddivisa completamente, poi decimata fino a questo numero',
    'warnings.safetyCapHit': '\u26a0 Limite di sicurezza di 20 milioni di triangoli raggiunto durante la suddivisione \u2014 il risultato potrebbe comunque essere più grossolano della lunghezza del bordo richiesta.',
    'ui.exportStl': 'Esporta STL',

    // Export progress stages
    'progress.subdividing': 'Suddivisione della mesh\u2026',
    'progress.refining': 'Raffinamento: {cur} triangoli, spigolo più lungo {edge}',
    'progress.applyingDisplacement': 'Applicazione dello spostamento a {n} triangoli\u2026',
    'progress.displacingVertices': 'Spostamento dei vertici\u2026',
    'progress.decimatingTo': 'Semplificazione da {from} \u2192 {to} triangoli\u2026',
    'progress.decimating': 'Semplificazione: {cur} \u2192 {to} triangoli',
    'progress.writingStl': 'Scrittura STL\u2026',
    'progress.done': 'Fatto!',
    'progress.processing': 'Elaborazione\u2026',

    // License popup
    'license.btn': 'Licenza e condizioni',
    'license.title': 'Licenza e condizioni',
    'license.item1': 'Utilizzo gratuito per qualsiasi scopo, compresi <strong>lavori commerciali</strong> (ad es. la creazione di texture per file STL destinati a clienti o prodotti).',
    'license.item2': 'L\'attribuzione è <strong>gradita</strong> ma <strong>non richiesta</strong> quando si utilizza questo strumento così com\'è.',
    'license.item3': 'Vuoi sostenere questo strumento? Acquista su <a href="https://geni.us/CNCStoreTexture" target="_blank" rel="noopener">CNCKitchen.STORE</a> o fai una donazione su <a href="https://www.paypal.me/CNCKitchen" target="_blank" rel="noopener">PayPal</a>.',
    'license.item4': 'Questo strumento viene fornito <strong>così com\'è</strong> senza <strong>alcuna garanzia</strong> di alcun tipo. L\'utilizzo è a proprio rischio.',
    'license.item5': '<strong>Non viene fornita alcuna assistenza</strong>. L\'autore non ha alcun obbligo di correggere bug, rispondere a domande o aggiornare questo strumento. Detto questo, segnalazioni di bug e richieste di funzionalità sono sempre ben accette all\'indirizzo <a href="mailto:texturizer@cnckitchen.com">texturizer@cnckitchen.com</a>.',
    'license.item6': 'L\'autore non potrà essere ritenuto <strong>responsabile</strong> per eventuali danni, perdita di dati o problemi derivanti dall\'uso di questo strumento.',
    'license.item7': 'Vuoi ottenere una licenza o incorporare questo strumento per la tua attività o il tuo sito web? Contattaci all\'indirizzo <a href="mailto:contact@cnckitchen.com">contact@cnckitchen.com</a>.',
    'license.item8': 'Codice sorgente disponibile su <a href="https://github.com/CNCKitchen/stlTexturizer" target="_blank" rel="noopener">GitHub</a>.',

    // Imprint & Privacy
    'imprint.btn': 'Note legali e privacy',
    'imprint.title': 'Note legali e informativa sulla privacy',
    'imprint.sectionImprint': 'Note legali (Impressum)',
    'imprint.info': 'CNC Kitchen<br>Stefan Hermann<br>Bahnhofstr. 2<br>88145 Hergatz<br>Germania',
    'imprint.contact': 'E-mail: <a href="mailto:contact@cnckitchen.com">contact@cnckitchen.com</a><br>Telefono: +49 175 2011824<br><em>Il numero di telefono è riservato esclusivamente a richieste legali/commerciali \u2014 non per l\'assistenza. </em>',
    'imprint.odr': 'Piattaforma UE per la risoluzione delle controversie online: <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noopener">https://ec.europa.eu/consumers/odr</a>',
    'imprint.sectionPrivacy': 'Informativa sulla privacy (Datenschutzerklärung)',
    'imprint.privacyIntro': '<strong>Titolare del trattamento</strong> (Verantwortlicher gem. Art. 4 Abs. 7 DSGVO): Stefan Hermann, Bahnhofstr. 2, 88145 Hergatz, Germania.',
    'imprint.privacyHosting': 'Questo sito web è ospitato su <strong>GitHub Pages</strong> (GitHub Inc. / Microsoft Corp., 88 Colin P Kelly Jr St, San Francisco, CA 94107, USA). Quando visiti questo sito, GitHub potrebbe elaborare il tuo indirizzo IP nei log del server. Base giuridica: Art. 6(1)(f) GDPR (interesse legittimo alla fornitura del sito web). Vedi <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" target="_blank" rel="noopener">Informativa sulla privacy di GitHub</a>.',
    'imprint.privacyLocal': 'Questo strumento memorizza le preferenze dell\'utente (lingua, tema) nel <strong>localStorage</strong> del tuo browser. Questi dati non lasciano mai il tuo dispositivo e non vengono trasmessi a nessun server.',
    'imprint.privacyNoCookies': 'Questo sito web <strong>non</strong> utilizza cookie, strumenti di analisi o tecnologie di tracciamento.',
    'imprint.privacyExternal': 'Questo sito contiene link a siti web esterni (ad es. CNCKitchen.STORE, PayPal). Questi siti hanno le proprie politiche sulla privacy, sulle quali non abbiamo alcun controllo.',
    'imprint.privacyRights': 'Ai sensi del GDPR hai il diritto di <strong>accesso, rettifica, cancellazione, limitazione del trattamento, portabilità dei dati</strong> e il diritto di <strong>presentare un reclamo</strong> presso un\'autorità di controllo.',

    // Sponsor modal
    'sponsor.title': 'Grazie per aver scelto BumpMesh di CNC Kitchen!',
    'sponsor.body': 'Questo strumento è offerto <strong>completamente gratis</strong> da CNC Kitchen.<br>Mentre il tuo file STL viene elaborato, perché non dai un\'occhiata al negozio che ci aiuta a continuare a creare cose fantastiche per te?',
    'sponsor.visitStore': '\uD83D\uDED2 Visita CNCKitchen.STORE',
    'sponsor.donate': '\uD83D\uDC99 Dona su PayPal',
    'sponsor.dontShow': 'Non mostrare più questo messaggio',
    'sponsor.closeAndContinue': 'Chiudi e continua',

    // Store CTA
    'cta.store': 'Vuoi sostenere questo strumento? Acquista su <a href="https://geni.us/CNCStoreTexture" target="_blank" rel="noopener noreferrer">CNCKitchen.STORE</a> o dona su <a href="https://www.paypal.me/CNCKitchen" target="_blank" rel="noopener noreferrer">PayPal</a>',
    'cta.storeDismiss': 'Chiudi',

    // Alerts
    'alerts.loadFailed': 'Caricamento del modello fallito: {msg}',
    'alerts.exportFailed': 'Esportazione fallita: {msg}',
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
  }
  else {
    const lang = navigator.language.split('-')[0];
    if (TRANSLATIONS[lang]) {
      _currentLang = lang;
    }
    else {
      _currentLang = 'en';
    }
  }
  document.documentElement.setAttribute('data-lang', _currentLang);
  document.documentElement.setAttribute('lang', _currentLang);
  applyTranslations();
}
