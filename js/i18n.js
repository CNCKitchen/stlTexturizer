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

    // Masking parent section
    'sections.masking': 'Masking',

    // Mask angles section
    'sections.maskAngles': 'By Angle \u24d8',
    'tooltips.maskAngles': '0° = no masking. Surfaces within this angle of horizontal will not be textured.',
    'labels.bottomFaces': 'Bottom faces',
    'tooltips.bottomFaces': 'Suppress texture on downward-facing surfaces within this angle of horizontal',
    'labels.topFaces': 'Top faces',
    'tooltips.topFaces': 'Suppress texture on upward-facing surfaces within this angle of horizontal',

    // Surface masking section
    'sections.surfaceMasking': 'By Surface \u24d8',
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
    'labels.boundaryFalloff':          'Smooth Mask \u24d8',
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

  es: {
    'lang.name': 'Español (beta)',
    // Theme toggle
    'theme.dark': 'Tema Oscuro',
    'theme.light': 'Tema Claro',
    'theme.toggleTitle': 'Alternar modo claro / oscuro',
    'theme.toggleAriaLabel': 'Alternar modo claro/oscuro',

    // Drop zone
    'dropHint.text': 'Arrastra aquí un archivo <strong>.stl</strong>, <strong>.obj</strong> o <strong>.3mf</strong><br/>o <label for="stl-file-input" class="link-label">haz clic para explorar</label>',

    // Viewport footer
    'ui.wireframe': 'Malla de alambre',
    'ui.controlsHint': 'Arrastrar izq.: orbitar \u00a0·\u00a0 Arrastrar der.: desplazar \u00a0·\u00a0 Rueda: zoom',
    'ui.meshInfo': '{n} triángulos · {mb} MB · {sx} × {sy} × {sz} mm',

    // Load model button
    'ui.loadStl': 'Cargar modelo\u2026',

    // Displacement map section
    'sections.displacementMap': 'Mapa de desplazamiento',
    'ui.uploadCustomMap': 'Subir mapa personalizado',
    'ui.noMapSelected': 'Ningún mapa seleccionado',

    // Projection section
    'sections.projection': 'Proyección',
    'labels.mode': 'Modo',
    'projection.triplanar': 'Triplanar',
    'projection.cubic': 'Cúbica (Caja)',
    'projection.cylindrical': 'Cilíndrica',
    'projection.spherical': 'Esférica',
    'projection.planarXY': 'Planar XY',
    'projection.planarXZ': 'Planar XZ',
    'projection.planarYZ': 'Planar YZ',

    // Transform section
    'sections.transform': 'Transformación',
    'labels.scaleU': 'Escala U',
    'labels.scaleV': 'Escala V',
    'labels.offsetU': 'Desplazamiento U',
    'labels.offsetV': 'Desplazamiento V',
    'labels.rotation': 'Rotación',
    'tooltips.proportionalScaling': 'Escalado proporcional (U = V)',
    'tooltips.proportionalScalingAria': 'Escalado proporcional (U = V)',

    // Displacement section
    'sections.displacement': 'Profundidad de textura',
    'labels.amplitude': 'Amplitud',

    // Seam blend
    'labels.seamBlend': 'Fusión de costuras \u24d8',
    'tooltips.seamBlend': 'Suaviza la costura donde se unen las caras de proyección. Efectivo para los modos Cúbico y Cilíndrico.',
    'labels.transitionSmoothing': 'Suavizado de transición \u24d8',
    'tooltips.transitionSmoothing': 'Ancho de la zona de fusión cerca de los bordes de la costura. Valores bajos mantienen las transiciones pegadas a la costura; valores altos difuminan una banda más amplia.',
    'labels.textureSmoothing': 'Suavizado de textura \u24d8',
    'tooltips.textureSmoothing': 'Aplica un desenfoque gaussiano al mapa de desplazamiento. Valores más altos producen detalles de superficie más suaves y graduales. 0 = desactivado.',
    'labels.capAngle': 'Ángulo de tapa \u24d8',
    'tooltips.capAngle': 'Ángulo (en grados) desde la vertical en el que se activa la proyección de tapa superior/inferior. Valores más pequeños limitan la proyección a caras casi planas.',

    // Masking parent section
    'sections.masking': 'Enmascaramiento',

    // Mask angles section
    'sections.maskAngles': 'Por ángulo \u24d8',
    'tooltips.maskAngles': '0° = sin enmascaramiento. Las superficies dentro de este ángulo respecto a la horizontal no serán texturizadas.',
    'labels.bottomFaces': 'Caras inferiores',
    'tooltips.bottomFaces': 'Eliminar textura en superficies orientadas hacia abajo dentro de este ángulo respecto a la horizontal',
    'labels.topFaces': 'Caras superiores',
    'tooltips.topFaces': 'Eliminar textura en superficies orientadas hacia arriba dentro de este ángulo respecto a la horizontal',

    // Surface masking section
    'sections.surfaceMasking': 'Por superficie \u24d8',
    'sections.surfaceSelection': 'Selección de superficies',
    'tooltips.surfaceMasking': 'Enmascarar superficies para controlar qué áreas reciben desplazamiento.',
    'tooltips.surfaceSelection': 'Las superficies seleccionadas aparecen en verde y serán las únicas en recibir desplazamiento durante la exportación.',
    'excl.modeExclude': 'Excluir',
    'excl.modeExcludeTitle': 'Modo Excluir: las superficies pintadas no recibirán desplazamiento de textura',
    'excl.modeIncludeOnly': 'Solo incluir',
    'excl.modeIncludeOnlyTitle': 'Modo Solo incluir: solo las superficies pintadas recibirán desplazamiento de textura',
    'excl.toolBrush': 'Pincel',
    'excl.toolBrushTitle': 'Pincel: pintar triángulos para excluir',
    'excl.toolFill': 'Relleno',
    'excl.toolFillTitle': 'Relleno: rellenar superficie hasta un ángulo umbral',
    'excl.shiftHint': 'Mantén Shift para borrar',
    'labels.type': 'Tipo',
    'brushType.single': 'Individual',
    'brushType.circle': 'Círculo',
    'labels.size': 'Tamaño',
    'labels.maxAngle': 'Ángulo máx.',
    'tooltips.maxAngle': 'Ángulo diedro máximo entre triángulos adyacentes que el relleno puede cruzar',
    'ui.clearAll': 'Borrar todo',
    'excl.initExcluded': '0 caras enmascaradas',
    'excl.faceExcluded': '{n} cara enmascarada',
    'excl.facesExcluded': '{n} caras enmascaradas',
    'excl.faceSelected': '{n} cara seleccionada',
    'excl.facesSelected': '{n} caras seleccionadas',
    'excl.hintExclude': 'Las superficies enmascaradas aparecen en naranja y no recibirán desplazamiento durante la exportación.',
    'excl.hintInclude': 'Las superficies seleccionadas aparecen en verde y serán las únicas en recibir desplazamiento durante la exportación.',

    // Precision masking
    'precision.label': 'Precisión (Beta) \u24d8',
    'precision.labelTitle': 'Subdivide la malla en segundo plano para que el pincel seleccione con mayor granularidad',
    'precision.outdated': '\u26a0 Desactualizado',
    'precision.refreshTitle': 'Resubdividir la malla para ajustarla al tamaño actual del pincel',
    'precision.triCount': '{n} \u25b3',
    'precision.refining': 'Refinando\u2026',
    'precision.warningBody': 'Estimados ~{n} triángulos. Esto puede ralentizar el navegador. ¿Continuar?',

    // Boundary falloff
    'labels.boundaryFalloff':          'Suavizar máscara \u24d8',
    'tooltips.boundaryFalloff':        'Reduce gradualmente el desplazamiento a cero cerca de los bordes enmascarados, evitando superposiciones de triángulos entre zonas texturizadas y no texturizadas.',

    // Symmetric displacement
    'labels.symmetricDisplacement': 'Desplazamiento simétrico \u24d8',
    'tooltips.symmetricDisplacement': 'Cuando está activado, el gris al 50% = sin desplazamiento; el blanco empuja hacia fuera, el negro empuja hacia dentro. Mantiene el volumen de la pieza aproximadamente constante.',

    // Displacement preview
    'labels.displacementPreview': 'Vista previa 3D \u24d8',
    'tooltips.displacementPreview': 'Subdivide la malla y desplaza los vértices en tiempo real para evaluar la profundidad real. Uso intensivo de GPU en modelos complejos.',

    // Place on face
    'ui.placeOnFace': 'Colocar en cara',
    'ui.placeOnFaceTitle': 'Haz clic en una cara para orientarla hacia abajo sobre la cama de impresión',
    'progress.subdividingPreview': 'Preparando vista previa\u2026',

    // Amplitude overlap warning
    'warnings.amplitudeOverlap': '\u26a0 La amplitud supera el 10% de la dimensión más pequeña del modelo \u2014 pueden ocurrir superposiciones de geometría en el STL exportado.',

    // Export section
    'sections.export': 'Exportar \u24d8',
    'tooltips.export': 'Menor longitud de arista = mayor detalle de desplazamiento. La salida se reduce al límite de triángulos.',
    'labels.resolution': 'Resolución',
    'tooltips.resolution': 'Las aristas más largas que este valor se subdividirán durante la exportación',
    'labels.outputTriangles': 'Triángulos de salida',
    'tooltips.outputTriangles': 'La malla se subdivide completamente primero y luego se reduce a esta cantidad',
    'warnings.safetyCapHit': '\u26a0 Se alcanzó el límite de seguridad de 20M de triángulos durante la subdivisión \u2014 el resultado puede ser más grueso que la longitud de arista solicitada.',
    'ui.exportStl': 'Exportar STL',

    // Export progress stages
    'progress.subdividing': 'Subdividiendo malla\u2026',
    'progress.refining': 'Refinando: {cur} triángulos, arista más larga {edge}',
    'progress.applyingDisplacement': 'Aplicando desplazamiento a {n} triángulos\u2026',
    'progress.displacingVertices': 'Desplazando vértices\u2026',
    'progress.decimatingTo': 'Simplificando {from} \u2192 {to} triángulos\u2026',
    'progress.decimating': 'Simplificando: {cur} \u2192 {to} triángulos',
    'progress.writingStl': 'Escribiendo STL\u2026',
    'progress.done': '¡Listo!',
    'progress.processing': 'Procesando\u2026',

    // License popup
    'license.btn':    'Licencia y condiciones',
    'license.title':  'Licencia y condiciones',
    'license.item1':  'Uso gratuito para cualquier propósito, incluyendo <strong>trabajo comercial</strong> (p. ej., texturizado de STLs para clientes o productos).',
    'license.item2':  'La atribución es <strong>apreciada</strong> pero <strong>no obligatoria</strong> al usar esta herramienta tal cual.',
    'license.item3':  '¿Quieres apoyar esta herramienta? Compra en <a href="https://geni.us/CNCStoreTexture" target="_blank" rel="noopener">CNCKitchen.STORE</a> o dona en <a href="https://www.paypal.me/CNCKitchen" target="_blank" rel="noopener">PayPal</a>.',
    'license.item4':  'Esta herramienta se proporciona <strong>tal cual</strong> sin <strong>ninguna garantía</strong> de ningún tipo. Úsala bajo tu propio riesgo.',
    'license.item5':  '<strong>No se proporciona soporte</strong>. El autor no tiene obligación de corregir errores, responder preguntas ni actualizar esta herramienta. Dicho esto, los informes de errores y solicitudes de funciones son siempre bienvenidos en <a href="mailto:texturizer@cnckitchen.com">texturizer@cnckitchen.com</a>.',
    'license.item6':  'El autor no será responsable de <strong>daños</strong>, pérdida de datos o problemas derivados del uso de esta herramienta.',
    'license.item7':  '¿Quieres licenciar o integrar esta herramienta para tu negocio o sitio web? Contáctanos en <a href="mailto:contact@cnckitchen.com">contact@cnckitchen.com</a>.',
    'license.item8':  'Código fuente disponible en <a href="https://github.com/CNCKitchen/stlTexturizer" target="_blank" rel="noopener">GitHub</a>.',

    // Imprint & Privacy
    'imprint.btn': 'Aviso legal y privacidad',
    'imprint.title': 'Aviso legal y política de privacidad',
    'imprint.sectionImprint': 'Aviso legal (Impressum)',
    'imprint.info': 'CNC Kitchen<br>Stefan Hermann<br>Bahnhofstr. 2<br>88145 Hergatz<br>Alemania',
    'imprint.contact': 'Correo: <a href="mailto:contact@cnckitchen.com">contact@cnckitchen.com</a><br>Teléfono: +49 175 2011824<br><em>El número de teléfono es exclusivamente para consultas legales/comerciales \u2014 no para soporte.</em>',
    'imprint.odr': 'Plataforma de resolución de litigios en línea de la UE: <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noopener">https://ec.europa.eu/consumers/odr</a>',
    'imprint.sectionPrivacy': 'Política de privacidad (Datenschutzerklärung)',
    'imprint.privacyIntro': '<strong>Responsable</strong> (Verantwortlicher gem. Art. 4 Abs. 7 DSGVO): Stefan Hermann, Bahnhofstr. 2, 88145 Hergatz, Alemania.',
    'imprint.privacyHosting': 'Este sitio web está alojado en <strong>GitHub Pages</strong> (GitHub Inc. / Microsoft Corp., 88 Colin P Kelly Jr St, San Francisco, CA 94107, EE.UU.). Al visitar este sitio, GitHub puede procesar tu dirección IP en los registros del servidor. Base legal: Art. 6(1)(f) RGPD (interés legítimo en proporcionar el sitio web). Ver <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" target="_blank" rel="noopener">Declaración de privacidad de GitHub</a>.',
    'imprint.privacyLocal': 'Esta herramienta almacena las preferencias del usuario (idioma, tema) en el <strong>localStorage</strong> de tu navegador. Estos datos nunca salen de tu dispositivo ni se transmiten a ningún servidor.',
    'imprint.privacyNoCookies': 'Este sitio web <strong>no</strong> utiliza cookies, herramientas de análisis ni tecnologías de rastreo.',
    'imprint.privacyExternal': 'Este sitio contiene enlaces a sitios web externos (p. ej., CNCKitchen.STORE, PayPal). Estos sitios tienen sus propias políticas de privacidad, sobre las cuales no tenemos control.',
    'imprint.privacyRights': 'Según el RGPD, tienes derecho a <strong>acceso, rectificación, supresión, limitación del tratamiento, portabilidad de datos</strong> y derecho a <strong>presentar una reclamación</strong> ante una autoridad de control.',

    // Sponsor modal
    'sponsor.title': '¡Gracias por usar BumpMesh de CNC Kitchen!',
    'sponsor.body': 'Esta herramienta es proporcionada <strong>completamente gratis</strong> por CNC Kitchen.<br>Mientras se procesa tu STL, ¿por qué no echas un vistazo a la tienda que nos ayuda a seguir creando cosas geniales para ti?',
    'sponsor.visitStore': '\uD83D\uDED2 Visitar CNCKitchen.STORE',
    'sponsor.donate': '\uD83D\uDC99 Donar en PayPal',
    'sponsor.dontShow': 'No mostrar de nuevo',
    'sponsor.closeAndContinue': 'Cerrar y continuar',

    // Store CTA
    'cta.store': '¿Quieres apoyar esta herramienta? Compra en <a href="https://geni.us/CNCStoreTexture" target="_blank" rel="noopener noreferrer">CNCKitchen.STORE</a> o dona en <a href="https://www.paypal.me/CNCKitchen" target="_blank" rel="noopener noreferrer">PayPal</a>',
    'cta.storeDismiss': 'Cerrar',

    // Alerts
    'alerts.loadFailed': 'No se pudo cargar el modelo: {msg}',
    'alerts.exportFailed': 'Error en la exportación: {msg}',
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

    // Masking parent section
    'sections.masking': 'Maskierung',

    // Winkelmaskierung
    'sections.maskAngles': 'Nach Winkel \u24d8',
    'tooltips.maskAngles': '0° = keine Maskierung. Fl\u00e4chen innerhalb dieses Winkels zur Horizontalen werden nicht texturiert.',
    'labels.bottomFaces': 'Unterseiten',
    'tooltips.bottomFaces': 'Textur auf nach unten gerichteten Fl\u00e4chen innerhalb dieses Winkels zur Horizontalen unterdr\u00fccken',
    'labels.topFaces': 'Oberseiten',
    'tooltips.topFaces': 'Textur auf nach oben gerichteten Fl\u00e4chen innerhalb dieses Winkels zur Horizontalen unterdr\u00fccken',

    // Surface masking section
    'sections.surfaceMasking': 'Nach Fläche \u24d8',
    'sections.surfaceSelection': 'Flächenauswahl',
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
    'labels.boundaryFalloff':          'Maske glätten \u24d8',
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

    // Masking parent section
    'sections.masking': 'Mascheramento',

    // Mask angles section
    'sections.maskAngles': 'Per angolo \u24d8',
    'tooltips.maskAngles': '0° = nessuna mascheratura. Le superfici comprese in questo angolo rispetto all\'orizzontale non saranno texturizzate.',
    'labels.bottomFaces': 'Facce inferiori',
    'tooltips.bottomFaces': 'Elimina la texture sulle superfici rivolte verso il basso entro questo angolo rispetto all\'orizzontale',
    'labels.topFaces': 'Facce superiori',
    'tooltips.topFaces': 'Elimina la texture sulle superfici rivolte verso l\'alto entro questo angolo rispetto all\'orizzontale',

    // Surface masking section
    'sections.surfaceMasking': 'Per superficie \u24d8',
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
    'labels.boundaryFalloff':          'Maschera liscia \u24d8',
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

  ja: {
    'lang.name': '日本語 (beta)',
    // Theme toggle
    'theme.dark': 'ダークテーマ',
    'theme.light': 'ライトテーマ',
    'theme.toggleTitle': 'ライト/ダークモードを切り替え',
    'theme.toggleAriaLabel': 'ライト/ダークモードを切り替え',

    // Drop zone
    'dropHint.text': '<strong>.stl</strong>、<strong>.obj</strong>、<strong>.3mf</strong> ファイルをここにドロップ<br/>または <label for="stl-file-input" class="link-label">クリックして参照</label>',

    // Viewport footer
    'ui.wireframe': 'ワイヤーフレーム',
    'ui.controlsHint': '左ドラッグ: 回転 \u00a0·\u00a0 右ドラッグ: パン \u00a0·\u00a0 スクロール: ズーム',
    'ui.meshInfo': '{n} 三角形 · {mb} MB · {sx} × {sy} × {sz} mm',

    // Load model button
    'ui.loadStl': 'モデルを読み込む\u2026',

    // Displacement map section
    'sections.displacementMap': 'ディスプレイスメントマップ',
    'ui.uploadCustomMap': 'カスタムマップをアップロード',
    'ui.noMapSelected': 'マップが選択されていません',

    // Projection section
    'sections.projection': '投影',
    'labels.mode': 'モード',
    'projection.triplanar': 'トライプラナー',
    'projection.cubic': 'キュービック (ボックス)',
    'projection.cylindrical': '円筒',
    'projection.spherical': '球面',
    'projection.planarXY': '平面 XY',
    'projection.planarXZ': '平面 XZ',
    'projection.planarYZ': '平面 YZ',

    // Transform section
    'sections.transform': '変換',
    'labels.scaleU': 'スケール U',
    'labels.scaleV': 'スケール V',
    'labels.offsetU': 'オフセット U',
    'labels.offsetV': 'オフセット V',
    'labels.rotation': '回転',
    'tooltips.proportionalScaling': '比例スケーリング (U = V)',
    'tooltips.proportionalScalingAria': '比例スケーリング (U = V)',

    // Displacement section
    'sections.displacement': 'テクスチャの深さ',
    'labels.amplitude': '振幅',

    // Seam blend
    'labels.seamBlend': 'シームブレンド \u24d8',
    'tooltips.seamBlend': '投影面が接する境界の硬い継ぎ目を滑らかにします。キュービックおよび円筒モードで効果的です。',
    'labels.transitionSmoothing': 'トランジションスムージング \u24d8',
    'tooltips.transitionSmoothing': '継ぎ目の端付近のブレンドゾーンの幅。低い値はトランジションを継ぎ目に近づけ、高い値はより広い帯域をブレンドします。',
    'labels.textureSmoothing': 'テクスチャスムージング \u24d8',
    'tooltips.textureSmoothing': 'ディスプレイスメントマップにガウシアンブラーを適用します。値が高いほど、より滑らかで緩やかな表面ディテールになります。0 = オフ。',
    'labels.capAngle': 'キャップ角度 \u24d8',
    'tooltips.capAngle': '上面/下面のキャップ投影が作動する垂直からの角度（度数）。小さい値はキャップ投影をほぼ平らな面に制限します。',

    // Masking parent section
    'sections.masking': 'マスキング',

    // Mask angles section
    'sections.maskAngles': '角度別 \u24d8',
    'tooltips.maskAngles': '0° = マスクなし。水平からこの角度内の面はテクスチャが適用されません。',
    'labels.bottomFaces': '底面',
    'tooltips.bottomFaces': '水平からこの角度内の下向きの面のテクスチャを抑制',
    'labels.topFaces': '上面',
    'tooltips.topFaces': '水平からこの角度内の上向きの面のテクスチャを抑制',

    // Surface masking section
    'sections.surfaceMasking': 'サーフェス別 \u24d8',
    'sections.surfaceSelection': 'サーフェス選択',
    'tooltips.surfaceMasking': 'サーフェスをマスクして、どの領域にディスプレイスメントを適用するかを制御します。',
    'tooltips.surfaceSelection': '選択されたサーフェスは緑色で表示され、エクスポート時にディスプレイスメントを受ける唯一の面になります。',
    'excl.modeExclude': '除外',
    'excl.modeExcludeTitle': '除外モード: 塗られたサーフェスはテクスチャディスプレイスメントを受けません',
    'excl.modeIncludeOnly': '選択のみ',
    'excl.modeIncludeOnlyTitle': '選択のみモード: 塗られたサーフェスのみがテクスチャディスプレイスメントを受けます',
    'excl.toolBrush': 'ブラシ',
    'excl.toolBrushTitle': 'ブラシ: 三角形を塗って除外',
    'excl.toolFill': '塗りつぶし',
    'excl.toolFillTitle': '塗りつぶし: 閾値角度までサーフェスをフラッドフィル',
    'excl.shiftHint': 'Shiftキーを押しながら消去',
    'labels.type': 'タイプ',
    'brushType.single': '単一',
    'brushType.circle': '円',
    'labels.size': 'サイズ',
    'labels.maxAngle': '最大角度',
    'tooltips.maxAngle': '塗りつぶしが越えることができる隣接三角形間の最大二面角',
    'ui.clearAll': 'すべてクリア',
    'excl.initExcluded': '0 面マスク済み',
    'excl.faceExcluded': '{n} 面マスク済み',
    'excl.facesExcluded': '{n} 面マスク済み',
    'excl.faceSelected': '{n} 面選択済み',
    'excl.facesSelected': '{n} 面選択済み',
    'excl.hintExclude': 'マスクされたサーフェスはオレンジ色で表示され、エクスポート時にディスプレイスメントを受けません。',
    'excl.hintInclude': '選択されたサーフェスは緑色で表示され、エクスポート時にディスプレイスメントを受ける唯一の面になります。',

    // Precision masking
    'precision.label': '精度 (ベータ) \u24d8',
    'precision.labelTitle': 'バックグラウンドでメッシュを細分化し、ブラシの選択精度を向上させます',
    'precision.outdated': '\u26a0 古い情報',
    'precision.refreshTitle': '現在のブラシサイズに合わせてメッシュを再細分化',
    'precision.triCount': '{n} \u25b3',
    'precision.refining': '精密化中\u2026',
    'precision.warningBody': '推定 ~{n} 三角形。ブラウザが遅くなる可能性があります。続行しますか？',

    // Boundary falloff
    'labels.boundaryFalloff':          'マスクを滑らかに \u24d8',
    'tooltips.boundaryFalloff':        'マスク境界付近でディスプレイスメントを徐々にゼロに減少させ、テクスチャ適用面と非適用面の間の三角形の重なりを防ぎます。',

    // Symmetric displacement
    'labels.symmetricDisplacement': '対称ディスプレイスメント \u24d8',
    'tooltips.symmetricDisplacement': 'オンの場合、50%グレー = 変位なし、白は外側に押し出し、黒は内側に押し込みます。部品の体積をほぼ一定に保ちます。',

    // Displacement preview
    'labels.displacementPreview': '3Dプレビュー \u24d8',
    'tooltips.displacementPreview': 'メッシュを細分化し、リアルタイムで頂点を変位させて実際の深さを確認できます。複雑なモデルではGPU負荷が高くなります。',

    // Place on face
    'ui.placeOnFace': '面に配置',
    'ui.placeOnFaceTitle': '面をクリックして印刷ベッドに向けて配置します',
    'progress.subdividingPreview': 'プレビューを準備中\u2026',

    // Amplitude overlap warning
    'warnings.amplitudeOverlap': '\u26a0 振幅がモデルの最小寸法の10%を超えています \u2014 エクスポートされたSTLでジオメトリの重なりが発生する可能性があります。',

    // Export section
    'sections.export': 'エクスポート \u24d8',
    'tooltips.export': 'エッジ長が短いほど = ディスプレイスメントの詳細度が高くなります。出力はその後三角形の上限まで削減されます。',
    'labels.resolution': '解像度',
    'tooltips.resolution': 'この値より長いエッジはエクスポート時に分割されます',
    'labels.outputTriangles': '出力三角形数',
    'tooltips.outputTriangles': 'メッシュはまず完全に細分化され、その後この数まで削減されます',
    'warnings.safetyCapHit': '\u26a0 細分化中に2000万三角形の安全制限に達しました \u2014 結果は要求されたエッジ長よりも粗くなる可能性があります。',
    'ui.exportStl': 'STLをエクスポート',

    // Export progress stages
    'progress.subdividing': 'メッシュを細分化中\u2026',
    'progress.refining': '精密化中: {cur} 三角形、最長エッジ {edge}',
    'progress.applyingDisplacement': '{n} 三角形にディスプレイスメントを適用中\u2026',
    'progress.displacingVertices': '頂点を変位中\u2026',
    'progress.decimatingTo': '{from} → {to} 三角形に簡略化中\u2026',
    'progress.decimating': '簡略化中: {cur} → {to} 三角形',
    'progress.writingStl': 'STLを書き出し中\u2026',
    'progress.done': '完了！',
    'progress.processing': '処理中\u2026',

    // License popup
    'license.btn':    'ライセンスと利用規約',
    'license.title':  'ライセンスと利用規約',
    'license.item1':  '<strong>商用利用</strong>を含む、あらゆる目的で無料で使用できます（例：クライアントや製品向けのSTLテクスチャリング）。',
    'license.item2':  'このツールをそのまま使用する場合、クレジット表記は<strong>歓迎</strong>されますが<strong>必須ではありません</strong>。',
    'license.item3':  'このツールを支援しませんか？ <a href="https://geni.us/CNCStoreTexture" target="_blank" rel="noopener">CNCKitchen.STORE</a>でお買い物、または<a href="https://www.paypal.me/CNCKitchen" target="_blank" rel="noopener">PayPal</a>で寄付できます。',
    'license.item4':  'このツールは<strong>現状のまま</strong>提供され、いかなる種類の<strong>保証もありません</strong>。自己責任でご利用ください。',
    'license.item5':  '<strong>サポートは提供されません</strong>。作者にはバグの修正、質問への回答、ツールの更新の義務はありません。ただし、バグ報告や機能リクエストは <a href="mailto:texturizer@cnckitchen.com">texturizer@cnckitchen.com</a> までいつでも歓迎します。',
    'license.item6':  '作者は、このツールの使用に起因する<strong>損害</strong>、データ損失、またはその他の問題について責任を負いません。',
    'license.item7':  'このツールをビジネスやウェブサイトにライセンスまたは組み込みたい場合は、<a href="mailto:contact@cnckitchen.com">contact@cnckitchen.com</a> までお問い合わせください。',
    'license.item8':  'ソースコードは <a href="https://github.com/CNCKitchen/stlTexturizer" target="_blank" rel="noopener">GitHub</a> で公開されています。',

    // Imprint & Privacy
    'imprint.btn': '特定商取引法に基づく表記とプライバシー',
    'imprint.title': '特定商取引法に基づく表記とプライバシーポリシー',
    'imprint.sectionImprint': '運営者情報 (Impressum)',
    'imprint.info': 'CNC Kitchen<br>Stefan Hermann<br>Bahnhofstr. 2<br>88145 Hergatz<br>ドイツ',
    'imprint.contact': 'メール: <a href="mailto:contact@cnckitchen.com">contact@cnckitchen.com</a><br>電話: +49 175 2011824<br><em>電話番号は法律/ビジネスに関するお問い合わせ専用です \u2014 サポートには対応しておりません。</em>',
    'imprint.odr': 'EU オンライン紛争解決プラットフォーム: <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noopener">https://ec.europa.eu/consumers/odr</a>',
    'imprint.sectionPrivacy': 'プライバシーポリシー (Datenschutzerklärung)',
    'imprint.privacyIntro': '<strong>責任者</strong> (Verantwortlicher gem. Art. 4 Abs. 7 DSGVO): Stefan Hermann, Bahnhofstr. 2, 88145 Hergatz, ドイツ。',
    'imprint.privacyHosting': 'このウェブサイトは <strong>GitHub Pages</strong>（GitHub Inc. / Microsoft Corp., 88 Colin P Kelly Jr St, San Francisco, CA 94107, USA）でホストされています。このサイトにアクセスすると、GitHubがサーバーログでIPアドレスを処理する場合があります。法的根拠: GDPR第6条(1)(f)（ウェブサイト提供の正当な利益）。<a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" target="_blank" rel="noopener">GitHubのプライバシーステートメント</a>を参照してください。',
    'imprint.privacyLocal': 'このツールはユーザーの設定（言語、テーマ）をブラウザの<strong>localStorage</strong>に保存します。このデータはデバイスの外に出ることはなく、サーバーに送信されることもありません。',
    'imprint.privacyNoCookies': 'このウェブサイトはCookie、分析ツール、トラッキング技術を<strong>一切使用しません</strong>。',
    'imprint.privacyExternal': 'このサイトには外部ウェブサイト（CNCKitchen.STORE、PayPalなど）へのリンクが含まれています。これらのサイトには独自のプライバシーポリシーがあり、当方では管理できません。',
    'imprint.privacyRights': 'GDPRに基づき、<strong>アクセス、訂正、削除、処理の制限、データポータビリティ</strong>の権利、および監督機関に<strong>苦情を申し立てる</strong>権利があります。',

    // Sponsor modal
    'sponsor.title': 'CNC Kitchen の BumpMesh をご利用いただきありがとうございます！',
    'sponsor.body': 'このツールは CNC Kitchen が<strong>完全無料</strong>で提供しています。<br>STLの処理中に、私たちがクールなものを作り続けるのを支えてくれるストアを覗いてみませんか？',
    'sponsor.visitStore': '\uD83D\uDED2 CNCKitchen.STORE を訪問',
    'sponsor.donate': '\uD83D\uDC99 PayPal で寄付',
    'sponsor.dontShow': '今後表示しない',
    'sponsor.closeAndContinue': '閉じて続行',

    // Store CTA
    'cta.store': 'このツールを支援しませんか？ <a href="https://geni.us/CNCStoreTexture" target="_blank" rel="noopener noreferrer">CNCKitchen.STORE</a>でお買い物、または<a href="https://www.paypal.me/CNCKitchen" target="_blank" rel="noopener noreferrer">PayPal</a>で寄付できます',
    'cta.storeDismiss': '閉じる',

    // Alerts
    'alerts.loadFailed': 'モデルを読み込めませんでした: {msg}',
    'alerts.exportFailed': 'エクスポートに失敗しました: {msg}',
  },
	
  pt: {
    'lang.name': 'Português (beta)',
    // Theme toggle
    'theme.dark': 'Tema Escuro',
    'theme.light': 'Tema Claro',
    'theme.toggleTitle': 'Alternar modo claro / escuro',
    'theme.toggleAriaLabel': 'Alternar modo claro/escuro',

    // Drop zone
    'dropHint.text': 'Arraste um arquivo <strong>.stl</strong>, <strong>.obj</strong> ou <strong>.3mf</strong> aqui<br/>ou <label for="stl-file-input" class="link-label">clique para procurar</label>',

    // Viewport footer
    'ui.wireframe': 'Wireframe',
    'ui.controlsHint': 'Arrastar esq.: orbitar \u00a0·\u00a0 Arrastar dir.: deslocar \u00a0·\u00a0 Roda: zoom',
    'ui.meshInfo': '{n} triângulos · {mb} MB · {sx} × {sy} × {sz} mm',

    // Load model button
    'ui.loadStl': 'Carregar modelo\u2026',

    // Displacement map section
    'sections.displacementMap': 'Mapa de deslocamento',
    'ui.uploadCustomMap': 'Enviar mapa personalizado',
    'ui.noMapSelected': 'Nenhum mapa selecionado',

    // Projection section
    'sections.projection': 'Projeção',
    'labels.mode': 'Modo',
    'projection.triplanar': 'Triplanar',
    'projection.cubic': 'Cúbica (Caixa)',
    'projection.cylindrical': 'Cilíndrica',
    'projection.spherical': 'Esférica',
    'projection.planarXY': 'Planar XY',
    'projection.planarXZ': 'Planar XZ',
    'projection.planarYZ': 'Planar YZ',

    // Transform section
    'sections.transform': 'Transformação',
    'labels.scaleU': 'Escala U',
    'labels.scaleV': 'Escala V',
    'labels.offsetU': 'Deslocamento U',
    'labels.offsetV': 'Deslocamento V',
    'labels.rotation': 'Rotação',
    'tooltips.proportionalScaling': 'Escala proporcional (U = V)',
    'tooltips.proportionalScalingAria': 'Escala proporcional (U = V)',

    // Displacement section
    'sections.displacement': 'Profundidade da textura',
    'labels.amplitude': 'Amplitude',

    // Seam blend
    'labels.seamBlend': 'Fusão de costuras \u24d8',
    'tooltips.seamBlend': 'Suaviza a costura onde as faces de projeção se encontram. Eficaz para os modos Cúbico e Cilíndrico.',
    'labels.transitionSmoothing': 'Suavização de transição \u24d8',
    'tooltips.transitionSmoothing': 'Largura da zona de fusão perto das bordas da costura. Valores baixos mantêm as transições próximas à costura; valores altos suavizam uma faixa mais larga.',
    'labels.textureSmoothing': 'Suavização de textura \u24d8',
    'tooltips.textureSmoothing': 'Aplica um desfoque gaussiano ao mapa de deslocamento. Valores mais altos produzem detalhes de superfície mais suaves e graduais. 0 = desativado.',
    'labels.capAngle': 'Ângulo de cobertura \u24d8',
    'tooltips.capAngle': 'Ângulo (em graus) a partir da vertical no qual a projeção de cobertura superior/inferior é ativada. Valores menores limitam a projeção a faces quase planas.',

    // Masking parent section
    'sections.masking': 'Mascaramento',

    // Mask angles section
    'sections.maskAngles': 'Por ângulo \u24d8',
    'tooltips.maskAngles': '0° = sem mascaramento. Superfícies dentro deste ângulo em relação à horizontal não serão texturizadas.',
    'labels.bottomFaces': 'Faces inferiores',
    'tooltips.bottomFaces': 'Suprimir textura em superfícies voltadas para baixo dentro deste ângulo em relação à horizontal',
    'labels.topFaces': 'Faces superiores',
    'tooltips.topFaces': 'Suprimir textura em superfícies voltadas para cima dentro deste ângulo em relação à horizontal',

    // Surface masking section
    'sections.surfaceMasking': 'Por superfície \u24d8',
    'sections.surfaceSelection': 'Seleção de superfícies',
    'tooltips.surfaceMasking': 'Mascarar superfícies para controlar quais áreas recebem deslocamento.',
    'tooltips.surfaceSelection': 'As superfícies selecionadas aparecem em verde e serão as únicas a receber deslocamento durante a exportação.',
    'excl.modeExclude': 'Excluir',
    'excl.modeExcludeTitle': 'Modo Excluir: superfícies pintadas não receberão deslocamento de textura',
    'excl.modeIncludeOnly': 'Incluir apenas',
    'excl.modeIncludeOnlyTitle': 'Modo Incluir apenas: somente superfícies pintadas receberão deslocamento de textura',
    'excl.toolBrush': 'Pincel',
    'excl.toolBrushTitle': 'Pincel: pintar triângulos para excluir',
    'excl.toolFill': 'Preenchimento',
    'excl.toolFillTitle': 'Preenchimento: preencher superfície até um ângulo limite',
    'excl.shiftHint': 'Segure Shift para apagar',
    'labels.type': 'Tipo',
    'brushType.single': 'Individual',
    'brushType.circle': 'Círculo',
    'labels.size': 'Tamanho',
    'labels.maxAngle': 'Ângulo máx.',
    'tooltips.maxAngle': 'Ângulo diedral máximo entre triângulos adjacentes que o preenchimento pode cruzar',
    'ui.clearAll': 'Limpar tudo',
    'excl.initExcluded': '0 faces mascaradas',
    'excl.faceExcluded': '{n} face mascarada',
    'excl.facesExcluded': '{n} faces mascaradas',
    'excl.faceSelected': '{n} face selecionada',
    'excl.facesSelected': '{n} faces selecionadas',
    'excl.hintExclude': 'Superfícies mascaradas aparecem em laranja e não receberão deslocamento durante a exportação.',
    'excl.hintInclude': 'Superfícies selecionadas aparecem em verde e serão as únicas a receber deslocamento durante a exportação.',

    // Precision masking
    'precision.label': 'Precisão (Beta) \u24d8',
    'precision.labelTitle': 'Subdivide a malha em segundo plano para que o pincel selecione com maior granularidade',
    'precision.outdated': '\u26a0 Desatualizado',
    'precision.refreshTitle': 'Resubdividir a malha para ajustar ao tamanho atual do pincel',
    'precision.triCount': '{n} \u25b3',
    'precision.refining': 'Refinando\u2026',
    'precision.warningBody': 'Estimados ~{n} triângulos. Isso pode deixar o navegador lento. Continuar?',

    // Boundary falloff
    'labels.boundaryFalloff':          'Suavizar máscara \u24d8',
    'tooltips.boundaryFalloff':        'Reduz gradualmente o deslocamento a zero perto das bordas mascaradas, evitando sobreposição de triângulos entre zonas texturizadas e não texturizadas.',

    // Symmetric displacement
    'labels.symmetricDisplacement': 'Deslocamento simétrico \u24d8',
    'tooltips.symmetricDisplacement': 'Quando ativado, cinza a 50% = sem deslocamento; branco empurra para fora, preto empurra para dentro. Mantém o volume da peça aproximadamente constante.',

    // Displacement preview
    'labels.displacementPreview': 'Pré-visualização 3D \u24d8',
    'tooltips.displacementPreview': 'Subdivide a malha e desloca os vértices em tempo real para avaliar a profundidade real. Uso intensivo de GPU em modelos complexos.',

    // Place on face
    'ui.placeOnFace': 'Posicionar na face',
    'ui.placeOnFaceTitle': 'Clique numa face para orientá-la para baixo sobre a mesa de impressão',
    'progress.subdividingPreview': 'Preparando pré-visualização\u2026',

    // Amplitude overlap warning
    'warnings.amplitudeOverlap': '\u26a0 A amplitude excede 10% da menor dimensão do modelo \u2014 podem ocorrer sobreposições de geometria no STL exportado.',

    // Export section
    'sections.export': 'Exportar \u24d8',
    'tooltips.export': 'Menor comprimento de aresta = maior detalhe de deslocamento. A saída é então reduzida ao limite de triângulos.',
    'labels.resolution': 'Resolução',
    'tooltips.resolution': 'Arestas maiores que este valor serão subdivididas durante a exportação',
    'labels.outputTriangles': 'Triângulos de saída',
    'tooltips.outputTriangles': 'A malha é totalmente subdividida primeiro e depois reduzida a esta quantidade',
    'warnings.safetyCapHit': '\u26a0 Limite de segurança de 20M de triângulos atingido durante a subdivisão \u2014 o resultado pode ser mais grosseiro que o comprimento de aresta solicitado.',
    'ui.exportStl': 'Exportar STL',

    // Export progress stages
    'progress.subdividing': 'Subdividindo malha\u2026',
    'progress.refining': 'Refinando: {cur} triângulos, aresta mais longa {edge}',
    'progress.applyingDisplacement': 'Aplicando deslocamento em {n} triângulos\u2026',
    'progress.displacingVertices': 'Deslocando vértices\u2026',
    'progress.decimatingTo': 'Simplificando {from} \u2192 {to} triângulos\u2026',
    'progress.decimating': 'Simplificando: {cur} \u2192 {to} triângulos',
    'progress.writingStl': 'Escrevendo STL\u2026',
    'progress.done': 'Pronto!',
    'progress.processing': 'Processando\u2026',

    // License popup
    'license.btn':    'Licença e termos',
    'license.title':  'Licença e termos',
    'license.item1':  'Uso gratuito para qualquer finalidade, incluindo <strong>trabalho comercial</strong> (p. ex., texturização de STLs para clientes ou produtos).',
    'license.item2':  'A atribuição é <strong>apreciada</strong> mas <strong>não obrigatória</strong> ao usar esta ferramenta como está.',
    'license.item3':  'Quer apoiar esta ferramenta? Compre na <a href="https://geni.us/CNCStoreTexture" target="_blank" rel="noopener">CNCKitchen.STORE</a> ou doe via <a href="https://www.paypal.me/CNCKitchen" target="_blank" rel="noopener">PayPal</a>.',
    'license.item4':  'Esta ferramenta é fornecida <strong>como está</strong> sem <strong>nenhuma garantia</strong> de qualquer tipo. Use por sua conta e risco.',
    'license.item5':  '<strong>Nenhum suporte</strong> é fornecido. O autor não tem obrigação de corrigir bugs, responder perguntas ou atualizar esta ferramenta. Dito isso, relatórios de bugs e pedidos de funcionalidades são sempre bem-vindos em <a href="mailto:texturizer@cnckitchen.com">texturizer@cnckitchen.com</a>.',
    'license.item6':  'O autor não será responsável por <strong>danos</strong>, perda de dados ou problemas decorrentes do uso desta ferramenta.',
    'license.item7':  'Quer licenciar ou incorporar esta ferramenta para o seu negócio ou site? Entre em contato em <a href="mailto:contact@cnckitchen.com">contact@cnckitchen.com</a>.',
    'license.item8':  'Código-fonte disponível no <a href="https://github.com/CNCKitchen/stlTexturizer" target="_blank" rel="noopener">GitHub</a>.',

    // Imprint & Privacy
    'imprint.btn': 'Aviso legal e privacidade',
    'imprint.title': 'Aviso legal e política de privacidade',
    'imprint.sectionImprint': 'Aviso legal (Impressum)',
    'imprint.info': 'CNC Kitchen<br>Stefan Hermann<br>Bahnhofstr. 2<br>88145 Hergatz<br>Alemanha',
    'imprint.contact': 'E-mail: <a href="mailto:contact@cnckitchen.com">contact@cnckitchen.com</a><br>Telefone: +49 175 2011824<br><em>O número de telefone é exclusivamente para consultas legais/comerciais \u2014 não para suporte.</em>',
    'imprint.odr': 'Plataforma de resolução de litígios online da UE: <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noopener">https://ec.europa.eu/consumers/odr</a>',
    'imprint.sectionPrivacy': 'Política de privacidade (Datenschutzerklärung)',
    'imprint.privacyIntro': '<strong>Responsável</strong> (Verantwortlicher gem. Art. 4 Abs. 7 DSGVO): Stefan Hermann, Bahnhofstr. 2, 88145 Hergatz, Alemanha.',
    'imprint.privacyHosting': 'Este site é hospedado no <strong>GitHub Pages</strong> (GitHub Inc. / Microsoft Corp., 88 Colin P Kelly Jr St, San Francisco, CA 94107, EUA). Ao visitar este site, o GitHub pode processar seu endereço IP nos logs do servidor. Base legal: Art. 6(1)(f) RGPD (interesse legítimo em fornecer o site). Veja a <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" target="_blank" rel="noopener">Declaração de privacidade do GitHub</a>.',
    'imprint.privacyLocal': 'Esta ferramenta armazena as preferências do usuário (idioma, tema) no <strong>localStorage</strong> do seu navegador. Esses dados nunca saem do seu dispositivo e não são transmitidos a nenhum servidor.',
    'imprint.privacyNoCookies': 'Este site <strong>não</strong> utiliza cookies, ferramentas de análise ou tecnologias de rastreamento.',
    'imprint.privacyExternal': 'Este site contém links para sites externos (p. ex., CNCKitchen.STORE, PayPal). Esses sites têm suas próprias políticas de privacidade, sobre as quais não temos controle.',
    'imprint.privacyRights': 'Nos termos do RGPD, você tem direito a <strong>acesso, retificação, eliminação, limitação do tratamento, portabilidade de dados</strong> e direito de <strong>apresentar uma reclamação</strong> junto a uma autoridade de supervisão.',

    // Sponsor modal
    'sponsor.title': 'Obrigado por usar o BumpMesh da CNC Kitchen!',
    'sponsor.body': 'Esta ferramenta é fornecida <strong>totalmente grátis</strong> pela CNC Kitchen.<br>Enquanto seu STL está sendo processado, que tal dar uma olhada na loja que nos ajuda a continuar criando coisas legais para você?',
    'sponsor.visitStore': '\uD83D\uDED2 Visitar CNCKitchen.STORE',
    'sponsor.donate': '\uD83D\uDC99 Doar via PayPal',
    'sponsor.dontShow': 'Não mostrar novamente',
    'sponsor.closeAndContinue': 'Fechar e continuar',

    // Store CTA
    'cta.store': 'Quer apoiar esta ferramenta? Compre na <a href="https://geni.us/CNCStoreTexture" target="_blank" rel="noopener noreferrer">CNCKitchen.STORE</a> ou doe via <a href="https://www.paypal.me/CNCKitchen" target="_blank" rel="noopener noreferrer">PayPal</a>',
    'cta.storeDismiss': 'Fechar',

    // Alerts
    'alerts.loadFailed': 'Não foi possível carregar o modelo: {msg}',
    'alerts.exportFailed': 'Falha na exportação: {msg}',
  },

	ru: {
    'lang.name': 'Русский',
    // Theme toggle
    'theme.dark': 'Тёмная тема',
    'theme.light': 'Светлая тема',
    'theme.toggleTitle': 'Переключить светлый / тёмный режим',
    'theme.toggleAriaLabel': 'Переключить светлый/тёмный режим',

    // Drop zone
    'dropHint.text': 'Перетащите файл <strong>.stl</strong>, <strong>.obj</strong> или <strong>.3mf</strong> сюда<br/>или <label for="stl-file-input" class="link-label">нажмите для выбора</label>',

    // Viewport footer
    'ui.wireframe': 'Каркас',
    'ui.controlsHint': 'ЛКМ + перетаскивание: вращение \u00a0·\u00a0 ПКМ + перетаскивание: панорамирование \u00a0·\u00a0 Колесо: масштаб',
    'ui.meshInfo': '{n} треугольников · {mb} МБ · {sx} × {sy} × {sz} мм',

    // Load model button
    'ui.loadStl': 'Загрузить модель\u2026',

    // Displacement map section
    'sections.displacementMap': 'Карта рельефа',
    'ui.uploadCustomMap': 'Загрузить свою карту',
    'ui.noMapSelected': 'Карта не выбрана',

    // Projection section
    'sections.projection': 'Проекция',
    'labels.mode': 'Режим',
    'projection.triplanar': 'Трипланарная',
    'projection.cubic': 'Кубическая (Box)',
    'projection.cylindrical': 'Цилиндрическая',
    'projection.spherical': 'Сферическая',
    'projection.planarXY': 'Плоская XY',
    'projection.planarXZ': 'Плоская XZ',
    'projection.planarYZ': 'Плоская YZ',

    // Transform section
    'sections.transform': 'Трансформация',
    'labels.scaleU': 'Масштаб U',
    'labels.scaleV': 'Масштаб V',
    'labels.offsetU': 'Смещение U',
    'labels.offsetV': 'Смещение V',
    'labels.rotation': 'Поворот',
    'tooltips.proportionalScaling': 'Пропорциональное масштабирование (U = V)',
    'tooltips.proportionalScalingAria': 'Пропорциональное масштабирование (U = V)',

    // Displacement section
    'sections.displacement': 'Глубина текстуры',
    'labels.amplitude': 'Амплитуда',

    // Seam blend
    'labels.seamBlend': 'Сглаживание шва \u24d8',
    'tooltips.seamBlend': 'Смягчает жёсткий шов в местах соединения граней проекции. Эффективно для режимов Cubic и Cylindrical.',
    'labels.transitionSmoothing': 'Сглаживание перехода \u24d8',
    'tooltips.transitionSmoothing': 'Ширина зоны смешивания возле краёв шва. Меньшие значения сохраняют переход ближе к шву; большие — расширяют область смешивания.',
    'labels.textureSmoothing': 'Сглаживание текстуры \u24d8',
    'tooltips.textureSmoothing': 'Применяет гауссово размытие к карте рельефа. Более высокие значения дают более мягкие и плавные детали поверхности. 0 = выкл.',
    'labels.capAngle': 'Угол крышки \u24d8',
    'tooltips.capAngle': 'Угол (в градусах) от вертикали, при котором начинает применяться проекция верхней/нижней крышки. Меньшие значения ограничивают проекцию почти плоскими поверхностями.',

    // Masking parent section
    'sections.masking': 'Маскирование',

    // Mask angles section
    'sections.maskAngles': 'По углу \u24d8',
    'tooltips.maskAngles': '0° = без маскирования. Поверхности в пределах этого угла от горизонтали не будут текстурироваться.',
    'labels.bottomFaces': 'Нижние грани',
    'tooltips.bottomFaces': 'Не применять текстуру к поверхностям, направленным вниз, в пределах этого угла от горизонтали',
    'labels.topFaces': 'Верхние грани',
    'tooltips.topFaces': 'Не применять текстуру к поверхностям, направленным вверх, в пределах этого угла от горизонтали',

    // Surface masking section
    'sections.surfaceMasking': 'По поверхности \u24d8',
    'sections.surfaceSelection': 'Выбор поверхности',
    'tooltips.surfaceMasking': 'Маскируйте поверхности, чтобы управлять тем, какие области будут получать рельеф.',
    'tooltips.surfaceSelection': 'Выбранные поверхности отображаются зелёным и будут единственными, на которые при экспорте будет применён рельеф.',
    'excl.modeExclude': 'Исключить',
    'excl.modeExcludeTitle': 'Режим исключения: окрашенные поверхности не будут получать рельеф',
    'excl.modeIncludeOnly': 'Только включённые',
    'excl.modeIncludeOnlyTitle': 'Режим только включённых: рельеф будет применяться только к окрашенным поверхностям',
    'excl.toolBrush': 'Кисть',
    'excl.toolBrushTitle': 'Кисть: закрашивать треугольники для исключения',
    'excl.toolFill': 'Заливка',
    'excl.toolFillTitle': 'Заливка: заполнение области по пороговому углу',
    'excl.shiftHint': 'Удерживайте Shift, чтобы стереть',
    'labels.type': 'Тип',
    'brushType.single': 'Одиночная',
    'brushType.circle': 'Круг',
    'labels.size': 'Размер',
    'labels.maxAngle': 'Макс. угол',
    'tooltips.maxAngle': 'Максимальный двугранный угол между соседними треугольниками, через который будет проходить заливка',
    'ui.clearAll': 'Очистить всё',
    'excl.initExcluded': '0 граней замаскировано',
    'excl.faceExcluded': '{n} грань замаскирована',
    'excl.facesExcluded': '{n} граней замаскировано',
    'excl.faceSelected': '{n} грань выбрана',
    'excl.facesSelected': '{n} граней выбрано',
    'excl.hintExclude': 'Замаскированные поверхности отображаются оранжевым и не будут получать рельеф при экспорте.',
    'excl.hintInclude': 'Выбранные поверхности отображаются зелёным и будут единственными, на которые при экспорте будет применён рельеф.',

    // Precision masking
    'precision.label': 'Точность (Beta) \u24d8',
    'precision.labelTitle': 'Подразделить сетку в фоновом режиме, чтобы кисть работала с более мелкой детализацией',
    'precision.outdated': '\u26a0 Устарело',
    'precision.refreshTitle': 'Повторно подразделить сетку в соответствии с текущим размером кисти',
    'precision.triCount': '{n} \u25b3',
    'precision.refining': 'Уточнение\u2026',
    'precision.warningBody': 'Оценочно ~{n} треугольников. Это может замедлить браузер. Продолжить?',

    // Boundary falloff
    'labels.boundaryFalloff': 'Плавная маска \u24d8',
    'tooltips.boundaryFalloff': 'Постепенно уменьшает рельеф до нуля у границ маски, предотвращая наложение треугольников в местах, где встречаются текстурированные и нетекстурированные области.',

    // Symmetric displacement
    'labels.symmetricDisplacement': 'Симметричный рельеф \u24d8',
    'tooltips.symmetricDisplacement': 'Если включено, 50% серого = без смещения; белый выталкивает наружу, чёрный вдавливает внутрь. Объём детали при этом остаётся примерно постоянным.',

    // Displacement preview
    'labels.displacementPreview': '3D-просмотр \u24d8',
    'tooltips.displacementPreview': 'Подразделяет сетку и смещает вершины в реальном времени, чтобы можно было оценить фактическую глубину. На сложных моделях сильно нагружает GPU.',

    // Place on face
    'ui.placeOnFace': 'Положить на грань',
    'ui.placeOnFaceTitle': 'Нажмите на грань, чтобы ориентировать её вниз на стол печати',
    'progress.subdividingPreview': 'Подготовка предпросмотра\u2026',

    // Amplitude overlap warning
    'warnings.amplitudeOverlap': '\u26a0 Амплитуда превышает 10% наименьшего размера модели — в экспортируемом STL возможны пересечения геометрии.',

    // Export section
    'sections.export': 'Экспорт \u24d8',
    'tooltips.export': 'Меньшая длина ребра = более детализированный рельеф. Затем результат упрощается до заданного лимита треугольников.',
    'labels.resolution': 'Разрешение',
    'tooltips.resolution': 'Рёбра длиннее этого значения будут разбиты при экспорте',
    'labels.outputTriangles': 'Треугольники на выходе',
    'tooltips.outputTriangles': 'Сетка сначала полностью подразделяется, затем упрощается до этого числа',
    'warnings.safetyCapHit': '\u26a0 Во время подразделения достигнут безопасный лимит в 20 млн треугольников — результат может оказаться грубее, чем заданная длина ребра.',
    'ui.exportStl': 'Экспорт STL',

    // Export progress stages
    'progress.subdividing': 'Подразделение сетки\u2026',
    'progress.refining': 'Уточнение: {cur} треугольников, самое длинное ребро {edge}',
    'progress.applyingDisplacement': 'Применение рельефа к {n} треугольникам\u2026',
    'progress.displacingVertices': 'Смещение вершин\u2026',
    'progress.decimatingTo': 'Упрощение {from} \u2192 {to} треугольников\u2026',
    'progress.decimating': 'Упрощение: {cur} \u2192 {to} треугольников',
    'progress.writingStl': 'Запись STL\u2026',
    'progress.done': 'Готово!',
    'progress.processing': 'Обработка\u2026',

    // License popup
    'license.btn': 'Лицензия и условия',
    'license.title': 'Лицензия и условия',
    'license.item1': 'Можно использовать бесплатно для любых целей, включая <strong>коммерческую работу</strong> (например, нанесение текстуры на STL для клиентов или продукции).',
    'license.item2': 'Указание авторства <strong>приветствуется</strong>, но <strong>не обязательно</strong> при использовании этого инструмента без изменений.',
    'license.item3': 'Поддержи проект! Покупайте в <a href="https://geni.us/CNCStoreTexture" target="_blank" rel="noopener">CNCKitchen.STORE</a> или пожертвуйте через <a href="https://www.paypal.me/CNCKitchen" target="_blank" rel="noopener">PayPal</a>.',
    'license.item4': 'Этот инструмент предоставляется <strong>как есть</strong>, <strong>без каких-либо гарантий</strong>. Используйте на свой страх и риск.',
    'license.item5': '<strong>Поддержка не предоставляется</strong>. Автор не обязан исправлять ошибки, отвечать на вопросы или обновлять этот инструмент. Тем не менее, сообщения об ошибках и пожелания к функционалу всегда приветствуются по адресу <a href="mailto:texturizer@cnckitchen.com">texturizer@cnckitchen.com</a>.',
    'license.item6': 'Автор не несёт <strong>ответственности</strong> за любой ущерб, потерю данных или проблемы, возникшие при использовании этого инструмента.',
    'license.item7': 'Хотите лицензировать этот инструмент или встроить его в свой бизнес или сайт? Свяжитесь с нами по адресу <a href="mailto:contact@cnckitchen.com">contact@cnckitchen.com</a>.',
    'license.item8': 'Исходный код доступен на <a href="https://github.com/CNCKitchen/stlTexturizer" target="_blank" rel="noopener">GitHub</a>.',

    // Imprint & Privacy
    'imprint.btn': 'Юридическая информация и конфиденциальность',
    'imprint.title': 'Юридическая информация и политика конфиденциальности',
    'imprint.sectionImprint': 'Юридическая информация (Impressum)',
    'imprint.info': 'CNC Kitchen<br>Stefan Hermann<br>Bahnhofstr. 2<br>88145 Hergatz<br>Germany',
    'imprint.contact': 'Email: <a href="mailto:contact@cnckitchen.com">contact@cnckitchen.com</a><br>Телефон: +49 175 2011824<br><em>Номер телефона предназначен только для юридических и деловых вопросов — не для поддержки.</em>',
    'imprint.odr': 'Платформа онлайн-разрешения споров ЕС: <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noopener">https://ec.europa.eu/consumers/odr</a>',
    'imprint.sectionPrivacy': 'Политика конфиденциальности (Datenschutzerklärung)',
    'imprint.privacyIntro': '<strong>Ответственное лицо</strong> (Verantwortlicher gem. Art. 4 Abs. 7 DSGVO): Stefan Hermann, Bahnhofstr. 2, 88145 Hergatz, Germany.',
    'imprint.privacyHosting': 'Этот сайт размещён на <strong>GitHub Pages</strong> (GitHub Inc. / Microsoft Corp., 88 Colin P Kelly Jr St, San Francisco, CA 94107, USA). При посещении сайта GitHub может обрабатывать ваш IP-адрес в серверных журналах. Правовое основание: Art. 6(1)(f) DSGVO (законный интерес в предоставлении сайта). См. <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" target="_blank" rel="noopener">Политику конфиденциальности GitHub</a>.',
    'imprint.privacyLocal': 'Этот инструмент сохраняет пользовательские настройки (язык, тема) в <strong>localStorage</strong> браузера. Эти данные никогда не покидают ваше устройство и не передаются на сервер.',
    'imprint.privacyNoCookies': 'Этот сайт <strong>не</strong> использует cookie, аналитику или какие-либо технологии отслеживания.',
    'imprint.privacyExternal': 'На сайте есть ссылки на внешние ресурсы (например, CNCKitchen.STORE, PayPal). У этих сайтов свои политики конфиденциальности, на которые мы не влияем.',
    'imprint.privacyRights': 'В соответствии с GDPR у вас есть право на <strong>доступ, исправление, удаление, ограничение обработки, переносимость данных</strong>, а также право <strong>подать жалобу</strong> в надзорный орган.',

    // Sponsor modal
    'sponsor.title': 'Спасибо, что используете BumpMesh от CNC Kitchen!',
    'sponsor.body': 'Этот инструмент предоставляется <strong>совершенно бесплатно</strong> компанией CNC Kitchen.<br>Пока ваш STL обрабатывается, загляните в магазин, который помогает нам и дальше делать для вас классные вещи.',
    'sponsor.visitStore': '\uD83D\uDED2 Перейти в CNCKitchen.STORE',
    'sponsor.donate': '\uD83D\uDC99 Пожертвовать через PayPal',
    'sponsor.dontShow': 'Больше не показывать',
    'sponsor.closeAndContinue': 'Закрыть и продолжить',

    // Store CTA
    'cta.store': 'Поддержи проект! Покупайте в <a href="https://geni.us/CNCStoreTexture" target="_blank" rel="noopener noreferrer">CNCKitchen.STORE</a> или пожертвуйте через <a href="https://www.paypal.me/CNCKitchen" target="_blank" rel="noopener noreferrer">PayPal</a>',
    'cta.storeDismiss': 'Закрыть',

    // Alerts
    'alerts.loadFailed': 'Не удалось загрузить модель: {msg}',
    'alerts.exportFailed': 'Экспорт не удался: {msg}',
  }
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
