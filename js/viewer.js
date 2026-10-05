/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineSegments2 }  from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial }   from 'three/addons/lines/LineMaterial.js';
import { SectionController } from './section.js';

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
let _diagEdges = null;       // LineSegments2 for open/non-manifold edges
let _diagFaces = [];         // Array of THREE.Mesh overlays for face highlights
let _turntable = null;       // { last, onStop } while the camera auto-orbits the model
let _section = null;         // SectionController (section.js): clipping plane + cap + gizmo
let _sectionToolLock = false; // a pick tool owns left clicks: the section handles step aside

// Shared by every material that belongs to the model (mesh, wireframe, mask and
// diagnostic overlays): empty = no cut, [plane] while the section view is on.
// three.js swaps shader programs by itself when the plane count changes.
const _clipPlanes = [];
function _clip(material) {
  if (material) material.clippingPlanes = _clipPlanes;
  return material;
}

const _TURNTABLE_RAD_PER_S = (2 * Math.PI) / 24;   // one revolution every 24 s
const _Z_AXIS = new THREE.Vector3(0, 0, 1);

// Turntable pitch clamp: keep the view direction at least this far (radians)
// away from ±world Z. At the pole itself the up direction is ambiguous and
// lookAt() flips, which is what used to make the view jump — stopping just
// short of it makes the pole unreachable, so no flip can ever occur.
const _POLAR_EPS = 0.01;

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
    // depthWrite OFF + renderOrder above the wireframe overlay (3): label
    // quads must not stamp their rectangle into the depth buffer, or they
    // punch line-free holes into the wireframe drawn after them. Rendered
    // last, the transparent label background lets the wireframe shine
    // through while the glyph stays readable on top.
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }),
    );
    sprite.renderOrder = 4;
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
  // depthWrite OFF + renderOrder above the wireframe overlay (3) — same
  // reasoning as the axis label sprites: a depth-writing transparent quad
  // drawn before the wireframe punches a line-free hole into it.
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(worldW, worldH),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, side: THREE.DoubleSide, depthWrite: false }),
  );
  mesh.renderOrder = 4;
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
  // 'high-performance' asks hybrid-GPU laptops for the discrete GPU (#75).
  // stencil: the section view's filled cut face (off by default since r163).
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, stencil: true, powerPreference: 'high-performance' });
  renderer.localClippingEnabled = true;
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
  // Same pole clamp for OrbitControls' own rotation (fallback before a model
  // is loaded) as for the custom pivot orbit below.
  controls.minPolarAngle = _POLAR_EPS;
  controls.maxPolarAngle = Math.PI - _POLAR_EPS;

  // Raycast-based orbit pivot: when a drag starts on the model, orbit
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

  // Surface point under the given client coords, else the last pivot, else null.
  function _pickPivot(clientX, clientY) {
    if (!currentMesh) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width)  *  2 - 1,
      ((clientY - rect.top)  / rect.height) * -2 + 1,
    );
    _orbitRaycaster.setFromCamera(ndc, camera);
    const { hits, onCap } = _sectionHits(_orbitRaycaster.intersectObject(currentMesh), _orbitRaycaster.ray);
    if (onCap) _lastKnownPivot = _orbitRaycaster.ray.intersectPlane(_section.plane, new THREE.Vector3()) ?? _lastKnownPivot;
    else if (hits.length) _lastKnownPivot = hits[0].point.clone();
    return _lastKnownPivot ? _lastKnownPivot.clone() : null;
  }

  function _beginOrbit(pivot, clientX, clientY) {
    _customPivot = pivot;
    _lastPointer = { x: clientX, y: clientY };
    controls.enableRotate = false;   // we'll rotate manually

    // Show marker, sized as ~1.5 % of the visible frustum height
    _pivotMarker.position.copy(_customPivot);
    const markerScale = _isPerspective
      ? _customPivot.distanceTo(camera.position) * Math.tan(THREE.MathUtils.degToRad(perspCamera.fov / 2)) * 0.015
      : (orthoCamera.top / orthoCamera.zoom) * 0.015;
    _pivotMarker.scale.setScalar(markerScale);
    _pivotMarker.visible = true;
    _needsRender = true;
  }

  // Orbit camera and target around _customPivot for a pointer move to (clientX, clientY).
  function _orbitTo(clientX, clientY) {
    const dx = clientX - _lastPointer.x;
    const dy = clientY - _lastPointer.y;
    _lastPointer = { x: clientX, y: clientY };
    if (dx === 0 && dy === 0) return;

    const rotSpeed = 0.005;

    // Build a pure quaternion rotation: horizontal around world Z,
    // vertical around camera's right axis (clamped turntable).
    camera.updateMatrixWorld();
    _tmpV2.setFromMatrixColumn(camera.matrixWorld, 0).normalize(); // camera right

    // Clamp the pitch so the view direction stops just short of ±world Z.
    // Pitching by `a` around the (horizontal) right axis changes the view
    // direction's angle from +Z from alpha to alpha - a, so limit `a` to
    // whatever keeps that angle inside [eps, PI - eps].
    camera.getWorldDirection(_tmpV1);
    const alpha = Math.acos(THREE.MathUtils.clamp(_tmpV1.z, -1, 1));
    const pitch = alpha - THREE.MathUtils.clamp(
      alpha + dy * rotSpeed, _POLAR_EPS, Math.PI - _POLAR_EPS);

    _tmpQ1.setFromAxisAngle(_tmpV1.set(0, 0, 1), -dx * rotSpeed); // yaw
    _tmpQ2.setFromAxisAngle(_tmpV2, pitch);                       // pitch
    _tmpQ1.premultiply(_tmpQ2);

    // Rotate camera position around the pivot
    _tmpV3.copy(camera.position).sub(_customPivot);
    _tmpV3.applyQuaternion(_tmpQ1);
    camera.position.copy(_customPivot).add(_tmpV3);

    // Rotate orbit target around the same pivot so OrbitControls stays in sync
    _tmpV4.copy(controls.target).sub(_customPivot);
    _tmpV4.applyQuaternion(_tmpQ1);
    controls.target.copy(_customPivot).add(_tmpV4);

    // Rotate camera orientation directly — with the pitch clamped away from
    // the poles this stays consistent with lookAt(target) in controls.update()
    camera.quaternion.premultiply(_tmpQ1);
    camera.updateMatrixWorld();
    _needsRender = true;
  }

  function _endOrbit() {
    _customPivot  = null;
    _lastPointer  = null;
    controls.enableRotate = true;
    // Re-orthonormalize against float drift; a no-op visually since the
    // pitch clamp guarantees we are never at/over a pole.
    camera.up.set(0, 0, 1);
    camera.lookAt(controls.target);
    _pivotMarker.visible = false;
    _needsRender = true;
  }

  // Mouse / pen: left-drag orbits from the moment of the press.
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || e.button !== 0 || !controls.enabled) return;
    const pivot = _pickPivot(e.clientX, e.clientY);
    if (!pivot) return; // no pivot available yet, fall back to OrbitControls default
    _beginOrbit(pivot, e.clientX, e.clientY);
  });

  document.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' || !_customPivot || !controls.enabled) return;
    _orbitTo(e.clientX, e.clientY);
  });

  document.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch' && _customPivot) _endOrbit();
  });

  // ── Touch: one finger orbits, two fingers pan + pinch-zoom ──────────────
  // All touch input is handled here on pointer events; OrbitControls' own
  // touch handling is switched off so the two can't fight over the camera.
  // A gesture only engages once the fingers have moved _TOUCH_SLOP px, so a
  // resting or tapping finger never nudges the view, and fingers still down
  // after a pinch stay inert until all are lifted (they never lift at exactly
  // the same time, and the straggler would otherwise spin the part).
  controls.touches = { ONE: null, TWO: null };
  const _TOUCH_SLOP = 10;        // CSS px
  const _touchPts = new Map();   // pointerId -> { x, y } client coords, in touch order
  let _touchMode  = null;        // null | 'pending' | 'orbit' | 'pinch' | 'idle'
  let _touchStart = null;        // { x, y } where the one-finger gesture began
  let _pinch      = null;        // { dist, x, y, live } of the first two fingers

  // Separation and midpoint of the first two fingers down.
  const _pinchFrame = () => {
    const [a, b] = _touchPts.values();
    return { dist: Math.hypot(b.x - a.x, b.y - a.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  // Pan so the world point under the previous finger midpoint follows it,
  // then zoom by the change in finger separation about the new midpoint.
  function _touchPanZoom(prev, cur) {
    const rect = renderer.domElement.getBoundingClientRect();
    const prevNdcX =  ((prev.x - rect.left) / rect.width)  * 2 - 1;
    const prevNdcY = -((prev.y - rect.top)  / rect.height) * 2 + 1;
    const curNdcX  =  ((cur.x - rect.left) / rect.width)  * 2 - 1;
    const curNdcY  = -((cur.y - rect.top)  / rect.height) * 2 + 1;

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

    const factor = cur.dist / prev.dist;
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

    controls.update();
    _needsRender = true;
  }

  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || !controls.enabled) return;
    if (e.isPrimary) {   // first finger of a new gesture: drop anything stale
      if (_touchMode === 'orbit') _endOrbit();
      _touchPts.clear();
    }
    _touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (_touchPts.size === 1) {
      _touchMode  = 'pending';
      _touchStart = { x: e.clientX, y: e.clientY };
    } else if (_touchPts.size === 2) {
      if (_touchMode === 'orbit') _endOrbit();
      _touchMode = 'pinch';
      _pinch = { ..._pinchFrame(), live: false };
    }
  });

  document.addEventListener('pointermove', (e) => {
    const pt = _touchPts.get(e.pointerId);
    if (!pt) return;
    pt.x = e.clientX;
    pt.y = e.clientY;
    if (!controls.enabled) return;

    if (_touchMode === 'pending') {
      if (Math.hypot(pt.x - _touchStart.x, pt.y - _touchStart.y) < _TOUCH_SLOP) return;
      // Pivot on the surface where the finger landed, not where it has slid
      // to. Orbiting starts from here, so the slop isn't replayed as a jump.
      _beginOrbit(_pickPivot(_touchStart.x, _touchStart.y) ?? controls.target.clone(), pt.x, pt.y);
      if (!currentMesh) _pivotMarker.visible = false;
      _touchMode = 'orbit';
    } else if (_touchMode === 'orbit') {
      _orbitTo(pt.x, pt.y);
    } else if (_touchMode === 'pinch') {
      const cur = _pinchFrame();
      if (!_pinch.live &&
          Math.hypot(cur.x - _pinch.x, cur.y - _pinch.y) < _TOUCH_SLOP &&
          Math.abs(cur.dist - _pinch.dist) < _TOUCH_SLOP) return;
      if (_pinch.live) _touchPanZoom(_pinch, cur);
      _pinch = { ...cur, live: true };
    }
  });

  const _touchEnd = (e) => {
    if (!_touchPts.delete(e.pointerId)) return;
    if (_touchMode === 'orbit') _endOrbit();
    _touchMode = _touchPts.size ? 'idle' : null;
  };
  document.addEventListener('pointerup', _touchEnd);
  document.addEventListener('pointercancel', _touchEnd);

  // touch-action: none keeps most browsers from page-zooming on a pinch over
  // the canvas; this covers the ones that still try.
  const _blockMultiTouch = (e) => { if (e.touches.length > 1) e.preventDefault(); };
  renderer.domElement.addEventListener('touchstart', _blockMultiTouch, { passive: false });
  renderer.domElement.addEventListener('touchmove',  _blockMultiTouch, { passive: false });

  // Cursor-centric zoom: zoom toward the mouse pointer instead of screen centre
  renderer.domElement.addEventListener('wheel', (e) => {
    e.preventDefault();
    // The 3Dconnexion driver can emulate wheel events while the puck is pushed;
    // zooming toward the idle cursor on top of the puck's own motion makes the
    // view jump. Never true without a SpaceMouse (the timestamp stays 0).
    if (performance.now() - _spaceMouse.lastActive < 100) return;
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

  // Rotation gizmo interaction
  _initGizmoInteraction();

  _section = new SectionController({
    scene,
    camera: () => camera,
    domElement: renderer.domElement,
    requestRender,
    onDraggingChanged: (dragging) => { controls.enabled = !dragging; },
    bounds: () => {
      if (!currentMesh) return null;
      const geo = currentMesh.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const box = geo.boundingBox;
      return { center: box.getCenter(new THREE.Vector3()), diag: box.getSize(new THREE.Vector3()).length() };
    },
  });
  // A mouse press on a hovered plane handle belongs to the gizmo: switch the
  // orbit off before OrbitControls and the custom pivot orbit see the event
  // (capture runs first at the target). Touch has no hover; there the drag
  // start disables the controls before the touch slop lets an orbit begin.
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button === 0 && _section.busy()) controls.enabled = false;
  }, { capture: true });

  // Any direct manipulation of the view hands control back to the user.
  const stopTurntable = () => {
    if (!_turntable) return;
    const { onStop } = _turntable;
    _turntable = null;
    onStop?.();
  };
  renderer.domElement.addEventListener('pointerdown', stopTurntable);
  renderer.domElement.addEventListener('wheel', stopTurntable, { passive: true });

  _initSpaceMouse(stopTurntable);

  // Render loop
  (function animate() {
    requestAnimationFrame(animate);
    if (_turntable) _stepTurntable();
    if (_spaceMouse.index !== -1) _stepSpaceMouse();
    controls.update();
    if (_needsRender) {
      _needsRender = false;
      renderer.render(scene, camera);
    }
  })();
}

/** Yaw the camera (and orbit target) around the vertical axis through the model centre, so the
 *  model spins in place on screen however the view was panned or zoomed. */
function _stepTurntable() {
  const now = performance.now();
  const dt = Math.min((now - _turntable.last) / 1000, 0.1);   // no jump after a background tab
  _turntable.last = now;
  if (!currentMesh || dt <= 0) return;

  const geo = currentMesh.geometry;
  if (!geo.boundingSphere) geo.computeBoundingSphere();
  const pivot = _tmpV4.copy(geo.boundingSphere.center).applyMatrix4(currentMesh.matrixWorld);

  _tmpQ1.setFromAxisAngle(_Z_AXIS, dt * _TURNTABLE_RAD_PER_S);
  camera.position.sub(pivot).applyQuaternion(_tmpQ1).add(pivot);
  controls.target.sub(pivot).applyQuaternion(_tmpQ1).add(pivot);
  camera.quaternion.premultiply(_tmpQ1);
  _needsRender = true;
}

// ── 3Dconnexion SpaceMouse ───────────────────────────────────────────────────
// Read through the Gamepad API (no driver bridge or permission prompt needed).
// Nothing is polled until the browser reports a matching device, which it only
// does after the puck or a button has been touched on this page, so the render
// loop costs ordinary users a single integer comparison.
const _spaceMouse = {
  index: -1,          // navigator.getGamepads() slot, -1 = none connected
  lastActive: 0,      // performance.now() of the last frame with puck input
  lastStep: 0,        // performance.now() of the previous _stepSpaceMouse()
  onInput: null,      // called on puck input (stops the turntable)
};
const _SM_DEADZONE = 0.08;
const _SM_ROT_RAD_PER_S = 2.4;   // at full deflection
const _SM_PAN_PER_S = 1.2;       // view heights per second at full deflection
const _SM_ZOOM_PER_S = 2.5;      // e-folds of zoom per second at full deflection

const _isSpaceMouse = (gp) => !!gp && /3dconnexion|spacemouse|space ?navigator|space ?pilot|space ?explorer|vendor: (256f|046d) product: c6/i.test(gp.id);

function _initSpaceMouse(onInput) {
  if (!('getGamepads' in navigator)) return;
  _spaceMouse.onInput = onInput;
  const attach = (gp) => {
    if (_spaceMouse.index !== -1 || !_isSpaceMouse(gp)) return;
    _spaceMouse.index = gp.index;
    _spaceMouse.lastStep = performance.now();
    console.info(`SpaceMouse connected: ${gp.id}`);
  };
  window.addEventListener('gamepadconnected', (e) => attach(e.gamepad));
  for (const gp of navigator.getGamepads()) attach(gp);   // already exposed to this page
  window.addEventListener('gamepaddisconnected', (e) => {
    if (e.gamepad.index === _spaceMouse.index) _spaceMouse.index = -1;
  });
}

// Remap |v| in [deadzone, 1] to [0, 1] so motion starts smoothly.
function _smAxis(v = 0) {
  const a = Math.abs(v);
  return a < _SM_DEADZONE ? 0 : Math.sign(v) * Math.min(1, (a - _SM_DEADZONE) / (1 - _SM_DEADZONE));
}

/** Apply one frame of SpaceMouse input: pan (X/Z), zoom (Y push/pull) and a
 *  Z-up turntable orbit around the orbit target (tilt / spin). Roll is ignored
 *  since the viewer always keeps world Z up. */
function _stepSpaceMouse() {
  const now = performance.now();
  const dt = Math.min((now - _spaceMouse.lastStep) / 1000, 0.1);
  _spaceMouse.lastStep = now;

  const gp = navigator.getGamepads()[_spaceMouse.index];
  if (!gp || !gp.connected || !controls.enabled || dt <= 0) return;

  const ax = gp.axes;
  const tx = _smAxis(ax[0]), ty = _smAxis(ax[1]), tz = _smAxis(ax[2]);
  const rx = _smAxis(ax[3]), rz = _smAxis(ax[5]);
  if (!tx && !ty && !tz && !rx && !rz) return;

  _spaceMouse.lastActive = now;
  _spaceMouse.onInput?.();

  const target = controls.target;
  camera.updateMatrixWorld();

  // Pan in the screen plane, scaled to what is visible so speed feels the
  // same at any zoom level. Directions match the 3Dconnexion viewer.
  if (tx || tz) {
    const viewH = _isPerspective
      ? 2 * camera.position.distanceTo(target) * Math.tan(THREE.MathUtils.degToRad(perspCamera.fov / 2))
      : (orthoCamera.top - orthoCamera.bottom) / orthoCamera.zoom;
    const step = viewH * _SM_PAN_PER_S * dt;
    _tmpV1.setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(tx * step);
    _tmpV2.setFromMatrixColumn(camera.matrixWorld, 1).multiplyScalar(tz * step);
    _tmpV1.add(_tmpV2);
    camera.position.add(_tmpV1);
    target.add(_tmpV1);
  }

  // Push the puck forward (away from you) to zoom in.
  if (ty) {
    const factor = Math.exp(-ty * _SM_ZOOM_PER_S * dt);   // < 1 when pushing forward
    if (_isPerspective) {
      _tmpV1.copy(camera.position).sub(target).multiplyScalar(factor);
      camera.position.copy(target).add(_tmpV1);
    } else {
      camera.zoom = Math.max(0.05, Math.min(200, camera.zoom / factor));
      camera.updateProjectionMatrix();
    }
  }

  // Tilt around the camera's right axis (clamped short of the poles like the
  // mouse orbit), spin around world Z.
  if (rx || rz) {
    _tmpV2.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    camera.getWorldDirection(_tmpV1);
    const alpha = Math.acos(THREE.MathUtils.clamp(_tmpV1.z, -1, 1));
    const pitch = alpha - THREE.MathUtils.clamp(
      alpha - rx * _SM_ROT_RAD_PER_S * dt, _POLAR_EPS, Math.PI - _POLAR_EPS);

    _tmpQ1.setFromAxisAngle(_Z_AXIS, rz * _SM_ROT_RAD_PER_S * dt);
    _tmpQ2.setFromAxisAngle(_tmpV2, pitch);
    _tmpQ1.premultiply(_tmpQ2);

    camera.position.sub(target).applyQuaternion(_tmpQ1).add(target);
    camera.quaternion.premultiply(_tmpQ1);
  }

  camera.updateMatrixWorld();
  _needsRender = true;
}

/**
 * Start or stop the turntable. `onStop` fires once when the user grabs, pans or zooms the view,
 * which ends the spin; it does not fire for setTurntable(false).
 * @param {boolean} on
 * @param {() => void} [onStop]
 */
export function setTurntable(on, onStop = null) {
  _turntable = on ? { last: performance.now(), onStop } : null;
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

  currentMesh = new THREE.Mesh(geometry, _clip(mat));
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

  // New model or pose: the section plane re-centres through it.
  _section.setTarget(currentMesh);
  _section.refit();
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
  currentMesh.material = _clip(material || new THREE.MeshStandardMaterial({
    color: 0xaaaacc,
    roughness: 0.6,
    metalness: 0.1,
    side: THREE.DoubleSide,
  }));
  _section.setTarget(currentMesh);
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
  _section.setTarget(currentMesh);
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

/**
 * True when WebGL runs on a CPU rasteriser (SwiftShader, WARP, llvmpipe):
 * hardware acceleration off, GPU blocklisted, or the GPU process crashed —
 * the viewer then crawls at a few fps (#75). failIfMajorPerformanceCaveat is
 * the reliable signal; the renderer string is a fallback and may be masked
 * by privacy settings (Brave).
 */
export function isSoftwareRendering() {
  try {
    const probe = document.createElement('canvas');
    const hw = probe.getContext('webgl2', { failIfMajorPerformanceCaveat: true })
            || probe.getContext('webgl',  { failIfMajorPerformanceCaveat: true });
    if (!hw) return true;
    hw.getExtension('WEBGL_lose_context')?.loseContext();
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    return /swiftshader|llvmpipe|softpipe|basic render|\bwarp\b/i.test(name);
  } catch {
    return false;
  }
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
  _section?.setCamera(camera);
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
    _exclMaterial = _clip(new THREE.MeshLambertMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: opacity < 1.0,
      opacity,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }));
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
    _hoverMaterial = _clip(new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.45,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }));
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

  wireframeLines = new LineSegments2(lsGeo, _clip(lsMat));
  wireframeLines.renderOrder = 3;  // draw after base mesh (0), overlays (1-2)
  // Add to meshGroup so it's automatically removed when a new model is loaded
  meshGroup.add(wireframeLines);
}

// ── Diagnostic overlays ──────────────────────────────────────────────────────

/**
 * Clear all diagnostic overlays (edges + face highlights).
 */
export function clearDiagOverlays() {
  if (_diagEdges) {
    scene.remove(_diagEdges);
    _diagEdges.geometry.dispose();
    _diagEdges.material.dispose();
    _diagEdges = null;
  }
  for (const m of _diagFaces) {
    scene.remove(m);
    m.geometry.dispose();
    m.material.dispose();
  }
  _diagFaces = [];
  requestRender();
}

/**
 * Show coloured line segments for problem edges.
 *
 * @param {Float32Array} positions  – pairs of 3D points (6 floats per edge)
 * @param {number}       color      – hex colour
 */
export function setDiagEdges(positions, color = 0xff0000) {
  // Remove previous edge overlay only
  if (_diagEdges) {
    scene.remove(_diagEdges);
    _diagEdges.geometry.dispose();
    _diagEdges.material.dispose();
    _diagEdges = null;
  }
  if (!positions || positions.length === 0) { requestRender(); return; }

  const lsGeo = new LineSegmentsGeometry();
  lsGeo.setPositions(positions);

  const lsMat = new LineMaterial({
    color,
    linewidth: 3,
    depthTest: false,
    resolution: new THREE.Vector2(
      renderer.domElement.width  * renderer.getPixelRatio(),
      renderer.domElement.height * renderer.getPixelRatio(),
    ),
  });

  _diagEdges = new LineSegments2(lsGeo, _clip(lsMat));
  _diagEdges.renderOrder = 4;
  scene.add(_diagEdges);
  requestRender();
}

/**
 * Show a coloured face overlay for a set of triangles.
 *
 * @param {THREE.BufferGeometry} overlayGeo  – non-indexed geometry of selected faces
 * @param {number}               color       – hex colour
 * @param {number}               [opacity=0.6]
 */
export function addDiagFaces(overlayGeo, color, opacity = 0.6, xray = false) {
  if (!overlayGeo || overlayGeo.attributes.position.count === 0) return;
  const mat = new THREE.MeshBasicMaterial({
    color,
    side: THREE.DoubleSide,
    transparent: true,
    opacity,
    depthTest: !xray,
    polygonOffset: !xray,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const mesh = new THREE.Mesh(overlayGeo, _clip(mat));
  mesh.renderOrder = 1;
  _diagFaces.push(mesh);
  scene.add(mesh);
  requestRender();
}

// ── Section view ─────────────────────────────────────────────────────────────

/** Toggle the section view: clipping plane + filled cut face + plane gizmo. */
export function setSectionView(on) {
  _clipPlanes.length = 0;
  if (on) _clipPlanes.push(_section.plane);
  _section.setEnabled(on);
  requestRender();
}

/** Snap the section plane perpendicular to a world axis, the cut opening toward the camera. */
export function setSectionAxis(axis) { _section.setAxis(axis); }

/** Keep the other half. */
export function flipSection() { _section.flip(); }

/**
 * Hide the section handles while a click tool (masking, Place on Face) is
 * active; the cut stays. Seen along the plane normal (the default: the cut
 * opens toward the camera) the tilt rings project edge-on right across the
 * cut face, so they would swallow the clicks meant for the inner walls.
 */
export function setSectionHandlesLocked(on) {
  _sectionToolLock = on;
  _syncSectionHandles();
}

// The rotate gizmo also sits on the model centre, so it hides them too.
function _syncSectionHandles() {
  _section?.setSuppressed(_rotGizmoVisible || _sectionToolLock);
}

const _secNormalMatrix = new THREE.Matrix3();
const _secNormal = new THREE.Vector3();

/** True when the hit face points back along the ray (a front face). */
function _facesRay(hit, ray) {
  _secNormalMatrix.getNormalMatrix(hit.object.matrixWorld);
  return _secNormal.copy(hit.face.normal).applyMatrix3(_secNormalMatrix).dot(ray.direction) < 0;
}

/** Raycast hits as the section view shows them: `hits` drops the cut-away side,
 *  `onCap` is true when the ray meets the filled cut face before any surface. */
function _sectionHits(hits, ray) {
  if (!_section?.enabled) return { hits, onCap: false };
  const kept = hits.filter(h => !_section.clips(h.point));
  const first = kept[0];
  if (!first || _facesRay(first, ray)) return { hits: kept, onCap: false };
  // The first visible hit faces away: the ray is inside the solid there, and if
  // it crossed the plane on the way it entered through the cut, so the cap
  // hides everything behind. DoubleSide picking can report a back face of an
  // adjacent triangle marginally ahead of the intended front face (see
  // getFrontFaceHit in main.js), so a front face right behind it still wins.
  const tol = 1e-4 * (currentMesh?.geometry.boundingSphere?.radius ?? 1);
  if (kept.some(h => h.distance - first.distance <= tol && _facesRay(h, ray))) return { hits: kept, onCap: false };
  const t = ray.distanceToPlane(_section.plane);
  return { hits: kept, onCap: t !== null && t <= first.distance + tol };
}

/**
 * Filter model raycast hits (sorted, from `ray`) for tools that act on the
 * visible surface: with the section view on, hits on the cut-away side are
 * dropped and a ray landing on the cut face returns none, so painting reaches
 * the inner walls exposed by the cut but never surfaces hidden behind the cap.
 */
export function sectionVisibleHits(hits, ray) {
  const r = _sectionHits(hits, ray);
  return r.onCap ? [] : r.hits;
}

// ── Rotation Gizmo ───────────────────────────────────────────────────────────

let _rotGizmoGroup = null;   // THREE.Group holding the 3 rings
let _rotGizmoVisible = false;
let _rotGizmoDragging = null; // { axis: 'x'|'y'|'z', startAngle, startPointer }
let _rotGizmoCallback = null; // function(axis, deltaDegreesIncremental) called during drag
const _gizmoRaycaster = new THREE.Raycaster();
const GIZMO_COLORS = { x: 0xff3333, y: 0x33dd55, z: 0x4488ff };
const GIZMO_HOVER_COLORS = { x: 0xff8888, y: 0x88ff99, z: 0x88bbff };

function _buildRotGizmo() {
  if (_rotGizmoGroup) return;
  _rotGizmoGroup = new THREE.Group();
  _rotGizmoGroup.renderOrder = 100;

  const createRing = (axis, color) => {
    // Visible ring
    const geo = new THREE.TorusGeometry(1, 0.02, 12, 64);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    });
    const ring = new THREE.Mesh(geo, mat);
    ring.userData.gizmoAxis = axis;
    ring.userData.baseColor = color;

    // Invisible fat hitbox for easier picking
    const hitGeo = new THREE.TorusGeometry(1, 0.08, 8, 64);
    const hitMat = new THREE.MeshBasicMaterial({ visible: false });
    const hitRing = new THREE.Mesh(hitGeo, hitMat);
    hitRing.userData.gizmoAxis = axis;
    ring.add(hitRing);

    // Rotate ring into the correct plane
    if (axis === 'x') ring.rotation.y = Math.PI / 2;
    else if (axis === 'y') ring.rotation.x = Math.PI / 2;
    // z ring: default XY plane already correct
    _rotGizmoGroup.add(ring);
    return ring;
  };

  createRing('x', GIZMO_COLORS.x);
  createRing('y', GIZMO_COLORS.y);
  createRing('z', GIZMO_COLORS.z);

  scene.add(_rotGizmoGroup);
}

let _rotGizmoLockedScale = null; // fixed scale set once on show, not updated during drag

function _updateGizmoScale(lock = false) {
  if (!_rotGizmoGroup || !currentMesh) return;
  currentMesh.geometry.computeBoundingSphere();
  if (lock || _rotGizmoLockedScale === null) {
    _rotGizmoLockedScale = currentMesh.geometry.boundingSphere.radius * 0.65;
  }
  _rotGizmoGroup.scale.setScalar(_rotGizmoLockedScale);
  _rotGizmoGroup.position.copy(currentMesh.geometry.boundingSphere.center);
}

/**
 * Show/hide the rotation gizmo.
 * @param {boolean} visible
 * @param {function|null} onRotate - callback(axis, deltaDegrees) called during drag
 */
export function setRotationGizmo(visible, onRotate = null) {
  _rotGizmoVisible = visible;
  _rotGizmoCallback = onRotate;
  _syncSectionHandles();
  if (visible) {
    _buildRotGizmo();
    _rotGizmoLockedScale = null; // reset so it measures fresh
    _updateGizmoScale(true);
    _rotGizmoGroup.visible = true;
  } else {
    if (_rotGizmoGroup) _rotGizmoGroup.visible = false;
    _rotGizmoDragging = null;
    _rotGizmoLockedScale = null;
  }
  requestRender();
}

/** Refresh gizmo size/position after geometry changes */
export function updateRotationGizmo() {
  if (_rotGizmoVisible && _rotGizmoGroup) {
    _updateGizmoScale();
    requestRender();
  }
}

/**
 * Returns true if the gizmo is currently being dragged
 * (so main.js can suppress other mouse handlers).
 */
export function isGizmoDragging() {
  return _rotGizmoDragging !== null || !!_section?.dragging;
}

// Hit-test the gizmo rings. Returns axis string or null.
function _pickGizmoRing(ndcX, ndcY) {
  if (!_rotGizmoGroup || !_rotGizmoVisible) return null;
  _gizmoRaycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
  // Recursive: true to also hit invisible fat hitbox children
  const hits = _gizmoRaycaster.intersectObjects(_rotGizmoGroup.children, true);
  if (hits.length > 0) return hits[0].object.userData.gizmoAxis;
  return null;
}

// Compute angle on the gizmo plane given screen position
function _gizmoPlaneAngle(ndcX, ndcY, axis) {
  // Project NDC onto the plane perpendicular to the axis through gizmo center
  const center = _rotGizmoGroup.position.clone();
  const normal = new THREE.Vector3();
  if (axis === 'x') normal.set(1, 0, 0);
  else if (axis === 'y') normal.set(0, 1, 0);
  else normal.set(0, 0, 1);

  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, center);
  const ray = new THREE.Ray();
  _gizmoRaycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
  ray.copy(_gizmoRaycaster.ray);

  const pt = new THREE.Vector3();
  if (!ray.intersectPlane(plane, pt)) return null;

  // Get angle in the ring's local 2D system
  const local = pt.sub(center);
  if (axis === 'x') return Math.atan2(local.z, local.y);
  if (axis === 'y') return Math.atan2(local.x, local.z);
  return Math.atan2(local.y, local.x); // z
}

// Attach gizmo interaction to the canvas (called once from initViewer)
function _initGizmoInteraction() {
  const canvas = renderer.domElement;
  let _hoveredAxis = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !_rotGizmoVisible) return;
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    const axis = _pickGizmoRing(ndcX, ndcY);
    if (!axis) return;

    e.stopPropagation();
    e.preventDefault();
    controls.enabled = false;

    const startAngle = _gizmoPlaneAngle(ndcX, ndcY, axis);
    _rotGizmoDragging = { axis, lastAngle: startAngle };
  }, { capture: true });

  document.addEventListener('pointermove', (e) => {
    if (!_rotGizmoVisible) return;
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    if (_rotGizmoDragging) {
      const angle = _gizmoPlaneAngle(ndcX, ndcY, _rotGizmoDragging.axis);
      if (angle !== null && _rotGizmoDragging.lastAngle !== null) {
        let delta = angle - _rotGizmoDragging.lastAngle;
        // Wrap delta to [-PI, PI]
        if (delta > Math.PI) delta -= 2 * Math.PI;
        if (delta < -Math.PI) delta += 2 * Math.PI;
        const degrees = THREE.MathUtils.radToDeg(delta);
        if (Math.abs(degrees) > 0.01 && _rotGizmoCallback) {
          _rotGizmoCallback(_rotGizmoDragging.axis, degrees);
        }
        _rotGizmoDragging.lastAngle = angle;
      }
      return;
    }

    // Hover highlight
    const axis = _pickGizmoRing(ndcX, ndcY);
    if (axis !== _hoveredAxis) {
      // Reset previous
      if (_hoveredAxis && _rotGizmoGroup) {
        _rotGizmoGroup.children.forEach(r => {
          if (r.userData.gizmoAxis === _hoveredAxis) {
            r.material.color.set(r.userData.baseColor);
          }
        });
      }
      _hoveredAxis = axis;
      if (axis && _rotGizmoGroup) {
        _rotGizmoGroup.children.forEach(r => {
          if (r.userData.gizmoAxis === axis) {
            r.material.color.set(GIZMO_HOVER_COLORS[axis]);
          }
        });
        canvas.style.cursor = 'grab';
      } else {
        canvas.style.cursor = '';
      }
      requestRender();
    }
  });

  document.addEventListener('pointerup', () => {
    if (_rotGizmoDragging) {
      _rotGizmoDragging = null;
      controls.enabled = true;
      requestRender();
    }
  });
}
