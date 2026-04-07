import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineSegments2 }  from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial }   from 'three/addons/lines/LineMaterial.js';

// Pre-allocated temp objects for hot-path event handlers (avoid GC pressure)
const _tmpQ1 = new THREE.Quaternion();
const _tmpQ2 = new THREE.Quaternion();
const _tmpV1 = new THREE.Vector3();
const _tmpV2 = new THREE.Vector3();
const _tmpV3 = new THREE.Vector3();
const _tmpV4 = new THREE.Vector3();

let renderer, orthoCamera, perspCamera, camera, scene, controls, meshGroup, ambientLight, dirLight1, dirLight2, grid;
let _isPerspective = false;
let currentMesh = null;
let axesGroup = null;
let dimensionGroup = null;
let wireframeLines = null;   // LineSegments overlay, or null when hidden
let wireframeVisible = false;
let exclusionMesh = null;    // flat orange overlay for user-excluded faces
let hoverMesh = null;        // semi-transparent yellow bucket-fill preview
let _exclMaterial = null;
let _hoverMaterial = null;
let _needsRender = true;

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
  renderer.shadowMap.enabled = false;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111114);

  // Grid helper — in XY plane (Z-up)
  grid = new THREE.GridHelper(200, 40, 0x333340, 0x2a2a34);
  grid.rotation.x = Math.PI / 2;  // rotate to XY plane for Z-up
  grid.position.z = 0;
  scene.add(grid);

  // Camera — orthographic (parallel projection), Z-up (default)
  orthoCamera = new THREE.OrthographicCamera(-150, 150, 150, -150, -10000, 10000);
  orthoCamera.up.set(0, 0, 1);
  orthoCamera.position.set(120, -200, 100);
  orthoCamera.lookAt(0, 0, 0);

  // Camera — perspective, Z-up
  perspCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 20000);
  perspCamera.up.set(0, 0, 1);
  perspCamera.position.copy(orthoCamera.position);
  perspCamera.lookAt(0, 0, 0);

  camera = orthoCamera;

  // Lights
  ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambientLight);

  dirLight1 = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight1.position.set(80, 120, 60);
  dirLight1.castShadow = false;
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
    const markerScale = _isPerspective
      ? _customPivot.distanceTo(camera.position) * Math.tan(THREE.MathUtils.degToRad(perspCamera.fov / 2)) * 0.015
      : (orthoCamera.top / orthoCamera.zoom) * 0.015;
    _pivotMarker.scale.setScalar(markerScale);
    _pivotMarker.visible = true;
    _needsRender = true;
  });

  document.addEventListener('pointermove', (e) => {
    if (!_customPivot || !_lastPointer || !controls.enabled) return;
    const dx = e.clientX - _lastPointer.x;
    const dy = e.clientY - _lastPointer.y;
    _lastPointer = { x: e.clientX, y: e.clientY };
    if (dx === 0 && dy === 0) return;

    const rotSpeed = 0.005;

    // Build a pure quaternion rotation: horizontal around world Z,
    // vertical around camera's right axis.  No polar clamping — the
    // camera can orbit freely over the poles.
    camera.updateMatrixWorld();
    _tmpV2.setFromMatrixColumn(camera.matrixWorld, 0).normalize(); // camera right

    _tmpQ1.setFromAxisAngle(_tmpV1.set(0, 0, 1), -dx * rotSpeed);   // yaw
    _tmpQ2.setFromAxisAngle(_tmpV2, -dy * rotSpeed);                  // pitch
    _tmpQ1.premultiply(_tmpQ2);

    // Rotate camera position around the pivot
    _tmpV3.copy(camera.position).sub(_customPivot);
    _tmpV3.applyQuaternion(_tmpQ1);
    camera.position.copy(_customPivot).add(_tmpV3);

    // Rotate orbit target around the same pivot so OrbitControls stays in sync
    _tmpV4.copy(controls.target).sub(_customPivot);
    _tmpV4.applyQuaternion(_tmpQ1);
    controls.target.copy(_customPivot).add(_tmpV4);

    // Rotate camera orientation directly — avoids lookAt pole singularity
    camera.quaternion.premultiply(_tmpQ1);
    camera.updateMatrixWorld();
    _needsRender = true;
  });

  document.addEventListener('pointerup', () => {
    if (_customPivot) {
      _customPivot  = null;
      _lastPointer  = null;
      controls.enableRotate = true;
      // Re-sync up vector for OrbitControls
      camera.up.set(0, 0, 1);
      camera.lookAt(controls.target);
      _pivotMarker.visible = false;
      _needsRender = true;
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

    if (_isPerspective) {
      // Pan on the plane through controls.target perpendicular to the view direction
      const camDir = _tmpV1.copy(controls.target).sub(camera.position).normalize();
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, controls.target);
      const ray1 = new THREE.Ray();
      const ray2 = new THREE.Ray();
      _tmpV2.set(prevNdcX, prevNdcY, 0.5).unproject(camera);
      ray1.set(camera.position, _tmpV2.sub(camera.position).normalize());
      _tmpV3.set(curNdcX, curNdcY, 0.5).unproject(camera);
      ray2.set(camera.position, _tmpV3.sub(camera.position).normalize());
      const p1 = new THREE.Vector3(), p2 = new THREE.Vector3();
      if (ray1.intersectPlane(plane, p1) && ray2.intersectPlane(plane, p2)) {
        _tmpV4.subVectors(p1, p2);
        camera.position.add(_tmpV4);
        controls.target.add(_tmpV4);
      }
    } else {
      _tmpV1.set(prevNdcX, prevNdcY, 0).unproject(camera);
      _tmpV2.set(curNdcX,  curNdcY,  0).unproject(camera);
      _tmpV1.sub(_tmpV2); // panDelta
      camera.position.add(_tmpV1);
      controls.target.add(_tmpV1);
    }

    // ── Zoom: zoom toward the current midpoint ────────────────────────
    const factor = newDist / _pinchDist;
    if (_isPerspective) {
      _tmpV3.set(curNdcX, curNdcY, 0.5).unproject(camera);
      _tmpV3.sub(camera.position).normalize();
      const dist = camera.position.distanceTo(controls.target);
      const dolly = dist * (1 - 1 / factor);
      camera.position.addScaledVector(_tmpV3, dolly);
      controls.target.addScaledVector(_tmpV3, dolly);
    } else {
      _tmpV3.set(curNdcX, curNdcY, 0).unproject(camera);
      camera.zoom = Math.max(0.05, Math.min(200, camera.zoom * factor));
      camera.updateProjectionMatrix();
      _tmpV4.set(curNdcX, curNdcY, 0).unproject(camera);
      _tmpV3.sub(_tmpV4); // zoomDelta
      camera.position.add(_tmpV3);
      controls.target.add(_tmpV3);
    }

    _pinchDist = newDist;
    _pinchMid  = { x: midX, y: midY };
    controls.update();
    _needsRender = true;
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

    if (_isPerspective) {
      // Perspective: dolly camera toward/away from point under cursor
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      _tmpV1.set(ndcX, ndcY, 0.5).unproject(camera);
      _tmpV1.sub(camera.position).normalize();
      const dist = camera.position.distanceTo(controls.target);
      const dolly = dist * (1 - 1 / factor);
      camera.position.addScaledVector(_tmpV1, dolly);
      controls.target.addScaledVector(_tmpV1, dolly);
      controls.update();
    } else {
      // Orthographic: cursor-centric zoom via frustum zoom
      _tmpV1.set(ndcX, ndcY, 0).unproject(camera);
      const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
      camera.zoom = Math.max(0.05, Math.min(200, camera.zoom * factor));
      camera.updateProjectionMatrix();
      _tmpV2.set(ndcX, ndcY, 0).unproject(camera);
      _tmpV1.sub(_tmpV2);
      camera.position.add(_tmpV1);
      controls.target.add(_tmpV1);
      controls.update();
    }
  }, { passive: false });

  // Resize observer
  const resizeObserver = new ResizeObserver(() => onResize());
  resizeObserver.observe(canvas.parentElement);
  onResize();

  // Damping needs controls.update() every frame; re-render only when needed
  controls.addEventListener('change', () => { _needsRender = true; });

  // Render loop
  (function animate() {
    requestAnimationFrame(animate);
    controls.update();
    if (_needsRender) {
      _needsRender = false;
      renderer.render(scene, camera);
    }
  })();
}

function onResize() {
  const el = renderer.domElement.parentElement;
  const w = el.clientWidth;
  const h = el.clientHeight;
  renderer.setSize(w, h, false);
  const aspect = w / h;
  // Update both cameras so switching stays seamless
  const halfH = orthoCamera.top;
  orthoCamera.left   = -halfH * aspect;
  orthoCamera.right  =  halfH * aspect;
  orthoCamera.updateProjectionMatrix();
  perspCamera.aspect = aspect;
  perspCamera.updateProjectionMatrix();
  // LineMaterial needs the actual pixel resolution to compute linewidth correctly
  if (wireframeLines) {
    wireframeLines.material.resolution.set(
      w * renderer.getPixelRatio(),
      h * renderer.getPixelRatio(),
    );
  }
  requestRender();
}

function disposeGroup(group) {
  group.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) {
        obj.material.forEach(m => { if (m.map) m.map.dispose(); m.dispose(); });
      } else {
        if (obj.material.map) obj.material.map.dispose();
        obj.material.dispose();
      }
    }
  });
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
  if (axesGroup) { disposeGroup(axesGroup); scene.remove(axesGroup); }
  const axisSize = sphere.radius * 0.30;
  axesGroup = buildAxesIndicator(axisSize);
  // Offset from the bounding box corner by ~1 axis-length so it doesn't overlap the mesh
  const axisPad = axisSize * 1.8;
  axesGroup.position.set(box.min.x - axisPad, box.min.y - axisPad, groundZ);
  scene.add(axesGroup);

  // Bounding-box dimension annotations on the ground plane
  if (dimensionGroup) { disposeGroup(dimensionGroup); scene.remove(dimensionGroup); }
  dimensionGroup = buildDimensions(box, groundZ, sphere.radius);
  scene.add(dimensionGroup);
  requestRender();
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
  requestRender();
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
  requestRender();
}

/**
 * Get the grid object so callers can adjust position.
 */
export function getGrid() { return grid; }

function fitCamera(sphere) {
  const sz = renderer.getSize(new THREE.Vector2());
  const aspect = sz.x / sz.y;
  const halfH = sphere.radius * 1.4;

  // Orthographic frustum
  orthoCamera.left   = -halfH * aspect;
  orthoCamera.right  =  halfH * aspect;
  orthoCamera.top    =  halfH;
  orthoCamera.bottom = -halfH;
  orthoCamera.near   = -sphere.radius * 200;
  orthoCamera.far    =  sphere.radius * 200;
  orthoCamera.zoom   = 1;
  orthoCamera.updateProjectionMatrix();

  // Perspective frustum
  perspCamera.aspect = aspect;
  perspCamera.near   = sphere.radius * 0.01;
  perspCamera.far    = sphere.radius * 400;
  perspCamera.updateProjectionMatrix();

  // Isometric-ish view from front-right-above in Z-up space
  const dir = new THREE.Vector3(0.6, -1.2, 0.8).normalize();
  controls.target.copy(sphere.center);

  // Ortho: position doesn't affect rendered size, just direction
  orthoCamera.position.copy(sphere.center).addScaledVector(dir, halfH * 4);
  orthoCamera.up.set(0, 0, 1);
  orthoCamera.lookAt(sphere.center);

  // Perspective: place far enough so the sphere fills the view
  const fovRad = THREE.MathUtils.degToRad(perspCamera.fov / 2);
  const perspDist = halfH / Math.tan(fovRad);
  perspCamera.position.copy(sphere.center).addScaledVector(dir, perspDist);
  perspCamera.up.set(0, 0, 1);
  perspCamera.lookAt(sphere.center);

  controls.update();
}

export function requestRender() { _needsRender = true; }

export function getRenderer()  { return renderer; }
export function getCamera()    { return camera; }
export function getScene()     { return scene; }
export function getControls()  { return controls; }
export function getCurrentMesh() { return currentMesh; }

/**
 * Switch between orthographic and perspective projection.
 * Syncs position, target and up so the view doesn't jump.
 * @param {boolean} perspective – true for perspective, false for orthographic
 */
export function setProjection(perspective) {
  if (perspective === _isPerspective) return;
  _isPerspective = perspective;
  const oldCam = camera;
  const newCam = perspective ? perspCamera : orthoCamera;

  // Copy spatial state so the view doesn't jump
  newCam.position.copy(oldCam.position);
  newCam.up.copy(oldCam.up);
  newCam.quaternion.copy(oldCam.quaternion);

  if (perspective) {
    // Estimate a reasonable distance if ortho camera was at an arbitrary depth
    // Use the ortho frustum half-height divided by tan(fov/2) as reference dist
    const halfH = orthoCamera.top / orthoCamera.zoom;
    const fovRad = THREE.MathUtils.degToRad(perspCamera.fov / 2);
    const dist = halfH / Math.tan(fovRad);
    const dir = new THREE.Vector3().subVectors(oldCam.position, controls.target).normalize();
    newCam.position.copy(controls.target).addScaledVector(dir, dist);
  }

  camera = newCam;
  controls.object = camera;
  const sz = renderer.getSize(new THREE.Vector2());
  const aspect = sz.x / sz.y;
  if (perspective) {
    perspCamera.aspect = aspect;
  } else {
    const halfH = orthoCamera.top;
    orthoCamera.left  = -halfH * aspect;
    orthoCamera.right =  halfH * aspect;
    orthoCamera.zoom  = 1;
  }
  camera.updateProjectionMatrix();
  controls.update();
  requestRender();
}

export function setSceneBackground(hexColor) {
  if (scene) scene.background = new THREE.Color(hexColor);
  requestRender();
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
  requestRender();
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
    exclusionMesh = null;
  }
  if (!overlayGeo || overlayGeo.attributes.position.count === 0) { requestRender(); return; }
  if (!_exclMaterial) {
    _exclMaterial = new THREE.MeshLambertMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: opacity < 1.0,
      opacity,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
  } else {
    _exclMaterial.color.set(color);
    _exclMaterial.opacity = opacity;
    _exclMaterial.transparent = opacity < 1.0;
  }
  exclusionMesh = new THREE.Mesh(overlayGeo, _exclMaterial);
  exclusionMesh.renderOrder = 1;
  scene.add(exclusionMesh);
  requestRender();
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
    hoverMesh = null;
  }
  if (!overlayGeo || overlayGeo.attributes.position.count === 0) { requestRender(); return; }
  if (!_hoverMaterial) {
    _hoverMaterial = new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.45,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
  } else {
    _hoverMaterial.color.set(color);
  }
  hoverMesh = new THREE.Mesh(overlayGeo, _hoverMaterial);
  hoverMesh.renderOrder = 2;
  scene.add(hoverMesh);
  requestRender();
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
  requestRender();
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
