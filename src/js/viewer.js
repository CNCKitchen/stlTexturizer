import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineSegments2 }  from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial }   from 'three/addons/lines/LineMaterial.js';

let renderer, camera, scene, controls, meshGroup, ambientLight, dirLight1, dirLight2, grid;
let currentMesh = null;
let axesGroup = null;
let dimensionGroup = null;
let wireframeLines = null;   // LineSegments overlay, or null when hidden
let wireframeVisible = false;
let exclusionMesh = null;    // flat orange overlay for user-excluded faces
let hoverMesh = null;        // semi-transparent yellow bucket-fill preview

// Build a labelled coordinate axes indicator scaled to `size`.
// X = red, Y = green, Z = blue (up).
function buildAxesIndicator(size) {
  const group = new THREE.Group();

  const addAxis = (dir, hex, label) => {
    const r = size;
    // Shaft
    const pts = [new THREE.Vector3(0, 0, 0), dir.clone().multiplyScalar(r * 0.78)];
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity: 0.9 }),
    );
    group.add(line);

    // Cone arrowhead
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(r * 0.07, r * 0.22, 8),
      new THREE.MeshBasicMaterial({ color: hex }),
    );
    cone.position.copy(dir.clone().multiplyScalar(r * 0.89));
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    group.add(cone);

    // Text sprite label
    const c   = document.createElement('canvas');
    c.width   = c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = `#${hex.toString(16).padStart(6, '0')}`;
    ctx.font      = 'bold 48px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 32, 32);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c) }),
    );
    sprite.position.copy(dir.clone().multiplyScalar(r * 1.18));
    sprite.scale.set(r * 0.32, r * 0.32, 1);
    group.add(sprite);
  };

  addAxis(new THREE.Vector3(1, 0, 0), 0xff3333, 'X');
  addAxis(new THREE.Vector3(0, 1, 0), 0x33dd55, 'Y');
  addAxis(new THREE.Vector3(0, 0, 1), 0x4488ff, 'Z');

  return group;
}

// Create a canvas-texture sprite label for a dimension annotation.
// Flat ground-plane label — no billboard, no background, lies directly on the bed.
function buildDimensionLabel(text, hex, worldW, worldH) {
  const c   = document.createElement('canvas');
  c.width   = 256;
  c.height  = 64;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 256, 64);
  ctx.fillStyle = `#${hex.toString(16).padStart(6, '0')}`;
  ctx.font      = 'bold 36px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 32);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(worldW, worldH),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, side: THREE.DoubleSide }),
  );
  return mesh;
}

// Build X/Y dimension-line annotations lying flat on the ground plane.
function buildDimensions(box, groundZ, scale) {
  const group = new THREE.Group();
  const fmt   = v => v.toFixed(2);
  const pad   = scale * 0.18;
  const tick  = scale * 0.08;
  const lblW  = scale * 0.50;
  const lblH  = scale * 0.12;
  const zOff  = 0.02; // tiny lift to avoid z-fighting with the grid

  const addLine = (pts, hex) => {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity: 0.75 }),
    );
    group.add(line);
  };

  const addTick = (centre, dir, hex) => {
    addLine([
      centre.clone().addScaledVector(dir, -tick * 0.5),
      centre.clone().addScaledVector(dir,  tick * 0.5),
    ], hex);
  };

  // X dimension — line along the front edge of the model
  {
    const hex = 0xff3333;
    const y   = box.min.y - pad;
    addLine([new THREE.Vector3(box.min.x, y, groundZ), new THREE.Vector3(box.max.x, y, groundZ)], hex);
    addTick(new THREE.Vector3(box.min.x, y, groundZ), new THREE.Vector3(0, 1, 0), hex);
    addTick(new THREE.Vector3(box.max.x, y, groundZ), new THREE.Vector3(0, 1, 0), hex);
    const lbl = buildDimensionLabel(`X: ${fmt(box.max.x - box.min.x)}`, hex, lblW, lblH);
    lbl.position.set((box.min.x + box.max.x) / 2, y - lblH * 0.7, groundZ + zOff);
    group.add(lbl);
  }

  // Y dimension — line along the right edge of the model
  {
    const hex = 0x33dd55;
    const x   = box.max.x + pad;
    addLine([new THREE.Vector3(x, box.min.y, groundZ), new THREE.Vector3(x, box.max.y, groundZ)], hex);
    addTick(new THREE.Vector3(x, box.min.y, groundZ), new THREE.Vector3(1, 0, 0), hex);
    addTick(new THREE.Vector3(x, box.max.y, groundZ), new THREE.Vector3(1, 0, 0), hex);
    const lbl = buildDimensionLabel(`Y: ${fmt(box.max.y - box.min.y)}`, hex, lblW, lblH);
    lbl.position.set(x + lblH * 0.7, (box.min.y + box.max.y) / 2, groundZ + zOff);
    lbl.rotation.z = Math.PI / 2;
    group.add(lbl);
  }

  return group;
}

export function initViewer(canvas) {
  // Renderer
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111114);

  // Grid helper — in XY plane (Z-up)
  grid = new THREE.GridHelper(200, 40, 0x333340, 0x2a2a34);
  grid.rotation.x = Math.PI / 2;  // rotate to XY plane for Z-up
  grid.position.z = 0;
  scene.add(grid);

  // Camera — orthographic (parallel projection), Z-up
  camera = new THREE.OrthographicCamera(-150, 150, 150, -150, -10000, 10000);
  camera.up.set(0, 0, 1);
  camera.position.set(120, -200, 100);
  camera.lookAt(0, 0, 0);

  // Lights
  ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambientLight);

  dirLight1 = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight1.position.set(80, 120, 60);
  dirLight1.castShadow = true;
  dirLight1.shadow.mapSize.set(1024, 1024);
  scene.add(dirLight1);

  dirLight2 = new THREE.DirectionalLight(0x8899ff, 0.4);
  dirLight2.position.set(-60, -20, -80);
  scene.add(dirLight2);

  // Group to hold the mesh
  meshGroup = new THREE.Group();
  scene.add(meshGroup);

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = true;
  controls.enableZoom = false; // we handle zoom ourselves for cursor-centric behaviour

  // Raycast-based orbit pivot: when left-drag starts on the model, orbit
  // around the surface point under the cursor instead of the default target.
  // We disable OrbitControls' own rotation and handle it manually so that
  // neither the camera view nor the target "snaps" to the clicked point.
  const _orbitRaycaster = new THREE.Raycaster();
  let _customPivot     = null;   // active pivot for the current drag
  let _lastKnownPivot  = null;   // persists between drags as fallback
  let _lastPointer     = null;

  // Small red sphere shown at the orbit centre during a drag
  const _pivotMarker = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 10),
    new THREE.MeshBasicMaterial({ color: 0xff2222, depthTest: false }),
  );
  _pivotMarker.renderOrder = 10;
  _pivotMarker.visible = false;
  scene.add(_pivotMarker);

  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !controls.enabled) return;
    if (!currentMesh) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width)  *  2 - 1,
      ((e.clientY - rect.top)  / rect.height) * -2 + 1,
    );
    _orbitRaycaster.setFromCamera(ndc, camera);
    const hits = _orbitRaycaster.intersectObject(currentMesh);
    if (hits.length) {
      _customPivot = hits[0].point.clone();
      _lastKnownPivot = _customPivot.clone();
    } else if (_lastKnownPivot) {
      _customPivot = _lastKnownPivot.clone();
    } else {
      return; // no pivot available yet, fall back to OrbitControls default
    }
    _lastPointer = { x: e.clientX, y: e.clientY };
    controls.enableRotate = false;   // we'll rotate manually

    // Show marker, sized as ~1.5 % of the visible frustum height
    _pivotMarker.position.copy(_customPivot);
    const markerScale = (camera.top / camera.zoom) * 0.015;
    _pivotMarker.scale.setScalar(markerScale);
    _pivotMarker.visible = true;
  });

  document.addEventListener('pointermove', (e) => {
    if (!_customPivot || !_lastPointer || !controls.enabled) return;
    const dx = e.clientX - _lastPointer.x;
    const dy = e.clientY - _lastPointer.y;
    _lastPointer = { x: e.clientX, y: e.clientY };
    if (dx === 0 && dy === 0) return;

    const rotSpeed = 0.005;
    // Horizontal: rotate around world Z (up)
    const qH = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1), -dx * rotSpeed);
    // Vertical: rotate around camera's local X (right vector)
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const qV = new THREE.Quaternion().setFromAxisAngle(right, -dy * rotSpeed);
    const qTotal = new THREE.Quaternion().multiplyQuaternions(qV, qH);

    // Rotate camera position around the pivot
    const camOff = camera.position.clone().sub(_customPivot);
    camOff.applyQuaternion(qTotal);
    camera.position.copy(_customPivot).add(camOff);

    // Rotate orbit target around the same pivot so OrbitControls stays in sync
    const tgtOff = controls.target.clone().sub(_customPivot);
    tgtOff.applyQuaternion(qTotal);
    controls.target.copy(_customPivot).add(tgtOff);

    camera.lookAt(controls.target);
  });

  document.addEventListener('pointerup', () => {
    if (_customPivot) {
      _customPivot  = null;
      _lastPointer  = null;
      controls.enableRotate = true;
      _pivotMarker.visible = false;
    }
  });

  // Pinch-to-zoom + two-finger pan for touch devices
  let _pinchDist = null;
  let _pinchMid  = null;  // { x, y } client coords of two-finger midpoint

  renderer.domElement.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const t0 = e.touches[0], t1 = e.touches[1];
      _pinchDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      _pinchMid  = { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 };
      controls.enabled = false;  // suppress OrbitControls during two-finger gesture
      e.preventDefault();
    }
  }, { passive: false });

  renderer.domElement.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || _pinchDist === null) return;
    e.preventDefault();
    const t0 = e.touches[0], t1 = e.touches[1];
    const rect = renderer.domElement.getBoundingClientRect();

    const newDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    const midX    = (t0.clientX + t1.clientX) / 2;
    const midY    = (t0.clientY + t1.clientY) / 2;

    // ── Pan: shift camera so the world point under the old midpoint
    //         is now under the new midpoint ──────────────────────────
    const prevNdcX =  ((_pinchMid.x - rect.left) / rect.width)  * 2 - 1;
    const prevNdcY = -((_pinchMid.y - rect.top)  / rect.height) * 2 + 1;
    const curNdcX  =  ((midX - rect.left) / rect.width)  * 2 - 1;
    const curNdcY  = -((midY - rect.top)  / rect.height) * 2 + 1;

    const prevWorld = new THREE.Vector3(prevNdcX, prevNdcY, 0).unproject(camera);
    const curWorld  = new THREE.Vector3(curNdcX,  curNdcY,  0).unproject(camera);
    const panDelta  = prevWorld.sub(curWorld);
    camera.position.add(panDelta);
    controls.target.add(panDelta);

    // ── Zoom: zoom toward the current midpoint ────────────────────────
    const factor = newDist / _pinchDist;
    const before = new THREE.Vector3(curNdcX, curNdcY, 0).unproject(camera);
    camera.zoom = Math.max(0.05, Math.min(200, camera.zoom * factor));
    camera.updateProjectionMatrix();
    const after = new THREE.Vector3(curNdcX, curNdcY, 0).unproject(camera);

    const zoomDelta = before.clone().sub(after);
    camera.position.add(zoomDelta);
    controls.target.add(zoomDelta);

    _pinchDist = newDist;
    _pinchMid  = { x: midX, y: midY };
    controls.update();
  }, { passive: false });

  renderer.domElement.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) {
      _pinchDist = null;
      _pinchMid  = null;
      controls.enabled = true;
    }
  });

  // Cursor-centric zoom: zoom toward the mouse pointer instead of screen centre
  renderer.domElement.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = renderer.domElement.getBoundingClientRect();
    const ndcX =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
    const ndcY = -((e.clientY - rect.top)  / rect.height) * 2 + 1;

    // World position under cursor before zoom
    const before = new THREE.Vector3(ndcX, ndcY, 0).unproject(camera);

    // Apply zoom
    const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
    camera.zoom = Math.max(0.05, Math.min(200, camera.zoom * factor));
    camera.updateProjectionMatrix();

    // World position under cursor after zoom
    const after = new THREE.Vector3(ndcX, ndcY, 0).unproject(camera);

    // Shift camera + target so the world point stays under the cursor
    const delta = before.clone().sub(after);
    camera.position.add(delta);
    controls.target.add(delta);
    controls.update();
  }, { passive: false });

  // Resize observer
  const resizeObserver = new ResizeObserver(() => onResize());
  resizeObserver.observe(canvas.parentElement);
  onResize();

  // Render loop
  (function animate() {
    requestAnimationFrame(animate);
    controls.update();

    renderer.render(scene, camera);
  })();
}

function onResize() {
  const el = renderer.domElement.parentElement;
  const w = el.clientWidth;
  const h = el.clientHeight;
  renderer.setSize(w, h, false);
  // Orthographic: keep the frustum half-height, update left/right for new aspect
  const aspect = w / h;
  const halfH = camera.top;
  camera.left   = -halfH * aspect;
  camera.right  =  halfH * aspect;
  camera.updateProjectionMatrix();
  // LineMaterial needs the actual pixel resolution to compute linewidth correctly
  if (wireframeLines) {
    wireframeLines.material.resolution.set(
      w * renderer.getPixelRatio(),
      h * renderer.getPixelRatio(),
    );
  }
}

/**
 * Replace the mesh in the scene with new geometry.
 * @param {THREE.BufferGeometry} geometry
 * @param {THREE.Material} [material] – if omitted, a default material is used
 */
export function loadGeometry(geometry, material) {
  // Clear previous mesh
  while (meshGroup.children.length) {
    const old = meshGroup.children[0];
    old.geometry.dispose();
    if (old.material && old.material.dispose) old.material.dispose();
    meshGroup.remove(old);
  }

  const mat = material || new THREE.MeshStandardMaterial({
    color: 0xaaaacc,
    roughness: 0.6,
    metalness: 0.1,
    side: THREE.DoubleSide,
  });

  if (!geometry.attributes.normal) geometry.computeVertexNormals();

  currentMesh = new THREE.Mesh(geometry, mat);
  currentMesh.castShadow = true;
  currentMesh.receiveShadow = true;
  meshGroup.add(currentMesh);

  // Rebuild wireframe overlay to match the new geometry
  // (old overlay is already gone because meshGroup was cleared above)
  wireframeLines = null;
  if (wireframeVisible) _buildWireframe(geometry);

  // Position grid at mesh bottom (Z-up: move grid along Z)
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const groundZ = box.min.z - 0.01;
  grid.position.z = groundZ;

  // Fit camera
  const sphere = new THREE.Sphere();
  geometry.computeBoundingSphere();
  sphere.copy(geometry.boundingSphere);
  fitCamera(sphere);

  // Place coordinate axes away from the part corner
  if (axesGroup) scene.remove(axesGroup);
  const axisSize = sphere.radius * 0.30;
  axesGroup = buildAxesIndicator(axisSize);
  // Offset from the bounding box corner by ~1 axis-length so it doesn't overlap the mesh
  const axisPad = axisSize * 1.8;
  axesGroup.position.set(box.min.x - axisPad, box.min.y - axisPad, groundZ);
  scene.add(axesGroup);

  // Bounding-box dimension annotations on the ground plane
  if (dimensionGroup) scene.remove(dimensionGroup);
  dimensionGroup = buildDimensions(box, groundZ, sphere.radius);
  scene.add(dimensionGroup);
}

/**
 * Update only the material on the current mesh.
 * @param {THREE.Material} material
 */
export function setMeshMaterial(material) {
  if (!currentMesh) return;
  if (currentMesh.material && currentMesh.material.dispose) {
    currentMesh.material.dispose();
  }
  currentMesh.material = material || new THREE.MeshStandardMaterial({
    color: 0xaaaacc,
    roughness: 0.6,
    metalness: 0.1,
    side: THREE.DoubleSide,
  });
}

/**
 * Swap only the geometry on the current mesh, keeping material and camera.
 * Rebuilds wireframe if visible.  Does NOT reset camera or grid.
 * The caller is responsible for disposing old geometry if needed.
 * @param {THREE.BufferGeometry} geometry
 */
export function setMeshGeometry(geometry) {
  if (!currentMesh) return;
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  currentMesh.geometry = geometry;
  // Rebuild wireframe overlay to match the new geometry
  if (wireframeLines) {
    meshGroup.remove(wireframeLines);
    wireframeLines.geometry.dispose();
    wireframeLines.material.dispose();
    wireframeLines = null;
  }
  if (wireframeVisible) _buildWireframe(geometry);
}

/**
 * Get the grid object so callers can adjust position.
 */
export function getGrid() { return grid; }

function fitCamera(sphere) {
  const sz = renderer.getSize(new THREE.Vector2());
  const aspect = sz.x / sz.y;
  const halfH = sphere.radius * 1.4;

  camera.left   = -halfH * aspect;
  camera.right  =  halfH * aspect;
  camera.top    =  halfH;
  camera.bottom = -halfH;
  camera.near   = -sphere.radius * 200;
  camera.far    =  sphere.radius * 200;
  camera.zoom   = 1;
  camera.updateProjectionMatrix();

  // Isometric-ish view from front-right-above in Z-up space
  const dir = new THREE.Vector3(0.6, -1.2, 0.8).normalize();
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).addScaledVector(dir, halfH * 4);
  camera.up.set(0, 0, 1);
  camera.lookAt(sphere.center);
  controls.update();
}

export function getRenderer()  { return renderer; }
export function getCamera()    { return camera; }
export function getScene()     { return scene; }
export function getControls()  { return controls; }
export function getCurrentMesh() { return currentMesh; }

export function setSceneBackground(hexColor) {
  if (scene) scene.background = new THREE.Color(hexColor);
}

export function setViewerTheme(isLight) {
  if (!scene) return;
  scene.background = new THREE.Color(isLight ? 0xf0f0f5 : 0x111114);
  const savedZ = grid ? grid.position.z : 0;
  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
  }
  grid = new THREE.GridHelper(
    200, 40,
    isLight ? 0xb0b0c8 : 0x333340,
    isLight ? 0xd0d0e0 : 0x2a2a34
  );
  grid.rotation.x = Math.PI / 2;
  grid.position.z = savedZ;
  scene.add(grid);
}

/**
 * Replace (or clear) the flat orange exclusion overlay mesh.
 * overlayGeo must be a non-indexed BufferGeometry with a 'position' attribute,
 * or null / an empty geometry to clear the overlay.
 * The mesh lives directly in the scene so loadGeometry() (which clears
 * meshGroup) never accidentally removes it.
 *
 * @param {THREE.BufferGeometry|null} overlayGeo
 */
export function setExclusionOverlay(overlayGeo, color = 0xff6600, opacity = 1.0) {
  if (exclusionMesh) {
    scene.remove(exclusionMesh);
    exclusionMesh.geometry.dispose();
    exclusionMesh.material.dispose();
    exclusionMesh = null;
  }
  if (!overlayGeo || overlayGeo.attributes.position.count === 0) return;
  exclusionMesh = new THREE.Mesh(
    overlayGeo,
    new THREE.MeshLambertMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: opacity < 1.0,
      opacity,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  );
  exclusionMesh.renderOrder = 1;
  scene.add(exclusionMesh);
}

/**
 * Replace (or clear) the yellow hover-preview overlay shown before a bucket-fill
 * click is confirmed.  Pass null or an empty geometry to clear it.
 *
 * @param {THREE.BufferGeometry|null} overlayGeo
 */
export function setHoverPreview(overlayGeo, color = 0xffee00) {
  if (hoverMesh) {
    scene.remove(hoverMesh);
    hoverMesh.geometry.dispose();
    hoverMesh.material.dispose();
    hoverMesh = null;
  }
  if (!overlayGeo || overlayGeo.attributes.position.count === 0) return;
  hoverMesh = new THREE.Mesh(
    overlayGeo,
    new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.45,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  hoverMesh.renderOrder = 2;
  scene.add(hoverMesh);
}

/**
 * Show or hide the triangle-edge wireframe overlay.
 * @param {boolean} enabled
 */
export function setWireframe(enabled) {
  wireframeVisible = enabled;
  if (enabled) {
    if (!wireframeLines && currentMesh) _buildWireframe(currentMesh.geometry);
    if (wireframeLines) wireframeLines.visible = true;
  } else {
    if (wireframeLines) wireframeLines.visible = false;
  }
}

function _buildWireframe(geometry) {
  // Dispose any stale overlay
  if (wireframeLines) {
    if (wireframeLines.parent) wireframeLines.parent.remove(wireframeLines);
    wireframeLines.geometry.dispose();
    wireframeLines.material.dispose();
    wireframeLines = null;
  }

  // WireframeGeometry gives every triangle edge; EdgesGeometry skips edges
  // between near-coplanar faces so large flat STL regions lose their grid lines.
  const wireGeo = new THREE.WireframeGeometry(geometry);
  const lsGeo = new LineSegmentsGeometry();
  lsGeo.setPositions(wireGeo.attributes.position.array);
  wireGeo.dispose();

  const lsMat = new LineMaterial({
    color: 0xffffff,
    opacity: 0.65,
    transparent: true,
    linewidth: 1.2,
    depthTest: true,
    // Pull lines slightly in front so they beat the base mesh AND the
    // exclusion overlay (polygonOffsetFactor -1,-1) in the depth test.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    resolution: new THREE.Vector2(
      renderer.domElement.width  * renderer.getPixelRatio(),
      renderer.domElement.height * renderer.getPixelRatio(),
    ),
  });

  wireframeLines = new LineSegments2(lsGeo, lsMat);
  wireframeLines.renderOrder = 3;  // draw after base mesh (0), overlays (1-2)
  // Add to meshGroup so it's automatically removed when a new model is loaded
  meshGroup.add(wireframeLines);
}
