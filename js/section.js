/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Section view, ported from meshStep's section rig: one clipping plane cuts the
// model open and a stencil-buffer cap (the three.js clipping_stencil technique)
// fills the cut, so the part reads as a solid and the inner walls of holes and
// cavities show whether they get textured. The plane is posed with a combined
// gizmo — a proxy Object3D carrying a translucent quad, one TransformControls
// that translates along the plane normal, and one that rotates about the two
// in-plane axes (spinning about the normal is a no-op and stays hidden).

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

const PLANE_COLOR = 0x7c6aff; // UI accent

// Cut face: light neutral with diagonal accent hatching — the CAD convention for
// "cut material", and never mistakable for the teal texture or the orange / grey
// mask tints of the preview. Lines stay ~1 px wide at any zoom and fade out
// before they would merge.
const capVertexShader = /* glsl */`
  varying vec2 vPlane;
  void main() {
    vPlane = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const capFragmentShader = /* glsl */`
  uniform vec3  capColor;
  uniform vec3  hatchColor;
  uniform float hatchSpacing;
  varying vec2  vPlane;
  void main() {
    float t  = (vPlane.x + vPlane.y) / hatchSpacing;
    float fw = max(fwidth(t), 1e-6);
    float d  = abs(fract(t) - 0.5);                 // 0 on a line centre
    float line = 1.0 - smoothstep(0.6 * fw, 1.6 * fw, d);
    line *= 1.0 - smoothstep(0.12, 0.3, fw);        // too dense to read → plain fill
    gl_FragColor = vec4(mix(capColor, hatchColor, line * 0.55), 1.0);
  }
`;

// Colourless stencil counters: only the clipping discard matters.
const stencilFragmentShader = /* glsl */`
  #include <clipping_planes_pars_fragment>
  void main() {
    #include <clipping_planes_fragment>
    gl_FragColor = vec4(0.0);
  }
`;

export class SectionController {
  /**
   * @param {object} host
   * @param {THREE.Scene} host.scene
   * @param {() => THREE.Camera} host.camera
   * @param {HTMLElement} host.domElement
   * @param {() => void} host.requestRender
   * @param {(dragging: boolean) => void} host.onDraggingChanged  gate the orbit controls
   * @param {() => ({ center: THREE.Vector3, diag: number } | null)} host.bounds  current model
   */
  constructor(host) {
    this.host = host;
    /** The clipping plane (three.js convention: kept side is n·p + c ≥ 0).
     *  Mutated in place, so materials holding it in clippingPlanes track it. */
    this.plane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);

    this._proxy = new THREE.Object3D();   // pose carrier: local +Z is the plane normal
    this._translate = null;
    this._rotate = null;
    this._quad = null;
    this._quadDisposables = [];

    // Stencil cap: two colourless copies of the model count back / front faces
    // of the clipped solid into the stencil buffer, then a plane-aligned quad
    // fills where the count is non-zero.
    this._back = null;
    this._front = null;
    this._cap = null;
    this._stencilSrc = null;   // material the stencil passes were derived from

    this._on = false;
    this._suppressed = false;  // handles hidden (rotate mode, click tools) — the cut stays
    this._target = null;       // the model mesh being cut
  }

  get enabled() { return this._on; }

  /** A handle is being dragged. */
  get dragging() {
    return !!(this._translate?.dragging || this._rotate?.dragging);
  }

  /** A handle is hovered or dragged — orbiting and painting must yield so
   *  grabbing the arrow doesn't also spin the camera or paint the surface. */
  busy() {
    const t = this._translate, r = this._rotate;
    return this._handlesLive() && !!t && !!r &&
      (t.dragging || r.dragging || t.axis !== null || r.axis !== null);
  }

  /** True when `point` lies on the cut-away side of an active section. */
  clips(point) {
    return this._on && this.plane.distanceToPoint(point) < -1e-6;
  }

  setEnabled(on) {
    if (this._on === on) return;
    this._on = on;
    if (on && this._target) this._ensure();
    this._updateVisibility();
  }

  /** Hide the handles while another tool owns the mouse — the cut stays. */
  setSuppressed(v) {
    this._suppressed = v;
    this._updateVisibility();
  }

  /** The viewer swapped persp/ortho — TransformControls raycast the camera. */
  setCamera(camera) {
    if (this._translate) this._translate.camera = camera;
    if (this._rotate) this._rotate.camera = camera;
  }

  /** The model mesh changed (new geometry or material): the stencil passes
   *  draw its geometry with its vertex shader, so a displaced preview gets a
   *  cap that follows the displaced surface. */
  setTarget(mesh) {
    this._target = mesh;
    if (this._on && mesh) this._ensure();
    if (!this._back) return;
    if (mesh) {
      this._back.geometry = this._front.geometry = mesh.geometry;
      if (mesh.material !== this._stencilSrc) this._buildStencilMaterials(mesh.material);
    }
    this._updateVisibility();
  }

  /** A new model (or pose) arrived: re-centre the plane through it, refit the quad. */
  refit() {
    if (!this._translate) return;
    const b = this.host.bounds();
    if (b) this._proxy.position.copy(b.center);
    this._buildQuad();
    this._sync();
  }

  flip() {
    if (!this._translate) return;
    this._proxy.rotateX(Math.PI); // local +Z (= plane normal) flips
    this._sync();
  }

  /** Snap the plane perpendicular to a world axis, the cut opening toward the camera. */
  setAxis(axis) {
    if (!this._translate) return;
    this._proxy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this._normalTowardCut(axis));
    this._sync();
  }

  _handlesLive() { return this._on && !this._suppressed && !!this._target; }

  /** Axis-aligned normal SIGNED so the camera sits on the clipped side — the
   *  cut always opens toward the viewer instead of hiding on the far side. No
   *  `axis`: the dominant axis of the view direction (plane on activation). */
  _normalTowardCut(axis) {
    const b = this.host.bounds();
    const dir = (b ? b.center.clone() : new THREE.Vector3()).sub(this.host.camera().position);
    const ax = Math.abs(dir.x), ay = Math.abs(dir.y), az = Math.abs(dir.z);
    const a = axis ?? (ax >= ay && ax >= az ? 'x' : ay >= az ? 'y' : 'z');
    const n = new THREE.Vector3(a === 'x' ? 1 : 0, a === 'y' ? 1 : 0, a === 'z' ? 1 : 0);
    if (n.dot(dir) < 0) n.negate();
    return n;
  }

  /** Hover arbitration between the two overlapping TransformControls: the
   *  rotation rings pass right through the arrow-tip region, so aiming at the
   *  arrow routinely started a rotate. The arrow wins — while it is hovered the
   *  rotate control is disabled so its pointerdown is a no-op. Registered after
   *  the controls' own listeners, so both hover states are fresh here. */
  _arbitrateHover = (e) => {
    const t = this._translate, r = this._rotate;
    if (!t || !r || t.dragging || r.dragging) return;
    const wantRotate = this._handlesLive() && t.axis === null;
    if (r.enabled !== wantRotate) {
      r.enabled = wantRotate;
      if (!wantRotate) {
        r.axis = null; // drop the ring highlight under the arrow
      } else if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
        // Disabled, it skipped this very move — catch its hover up, or busy()
        // would miss a ring the pointer slid onto straight off the arrow.
        const rect = this.host.domElement.getBoundingClientRect();
        r.pointerHover({
          x: (e.clientX - rect.left) / rect.width * 2 - 1,
          y: -(e.clientY - rect.top) / rect.height * 2 + 1,
          button: e.button,
        });
      }
      this.host.requestRender();
    }
  };

  /** Lazily create the proxy, controls, quad and cap on first use. */
  _ensure() {
    if (this._translate) return;
    const b = this.host.bounds();
    this._proxy.position.copy(b ? b.center : new THREE.Vector3());
    this._proxy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this._normalTowardCut());
    this.host.scene.add(this._proxy);

    const make = (mode, size, tune) => {
      const tc = new TransformControls(this.host.camera(), this.host.domElement);
      tc.setMode(mode);
      tc.setSpace('local');
      tc.setSize(size);
      tune(tc);
      tc.addEventListener('dragging-changed', (e) => this.host.onDraggingChanged(!!e.value));
      tc.addEventListener('objectChange', () => this._sync());
      tc.addEventListener('change', () => this.host.requestRender()); // hover highlight
      tc.attach(this._proxy);
      this.host.scene.add(tc.getHelper());
      return tc;
    };
    // The plane cuts everything, so tangential motion is meaningless — only
    // the normal arrow translates; two rings tilt.
    this._translate = make('translate', 0.75, (tc) => { tc.showX = false; tc.showY = false; });
    this._rotate    = make('rotate', 1.05, (tc) => { tc.showZ = false; });
    this.host.domElement.addEventListener('pointermove', this._arbitrateHover);

    this._buildCap();
    this._buildQuad();
    this._sync();
  }

  /** (Re)build the translucent plane rectangle — a child of the proxy, so it
   *  always sits centred on the gizmo. */
  _buildQuad() {
    if (this._quad) {
      this._proxy.remove(this._quad);
      for (const d of this._quadDisposables) d.dispose();
      this._quadDisposables = [];
    }
    const s = (this.host.bounds()?.diag ?? 100) * 1.15;
    const quadGeo = new THREE.PlaneGeometry(s, s);
    const quadMat = new THREE.MeshBasicMaterial({
      color: PLANE_COLOR, transparent: true, opacity: 0.08,
      side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
    });
    const edgeGeo = new THREE.EdgesGeometry(quadGeo);
    const edgeMat = new THREE.LineBasicMaterial({
      color: PLANE_COLOR, transparent: true, opacity: 0.7, toneMapped: false,
    });
    this._quadDisposables.push(quadGeo, quadMat, edgeGeo, edgeMat);
    const group = new THREE.Group();
    group.add(new THREE.Mesh(quadGeo, quadMat));
    group.add(new THREE.LineSegments(edgeGeo, edgeMat));
    this._quad = group;
    this._proxy.add(group);
    if (this._cap) {
      // The cap quad only needs to outreach the model — the stencil trims it.
      // Hatch pitch ~1/60 of the model, in the unit quad's local units.
      const capSize = s * 4;
      this._cap.scale.setScalar(capSize);
      this._cap.material.uniforms.hatchSpacing.value = s / 60 / capSize;
    }
  }

  _buildCap() {
    this._back  = new THREE.Mesh(this._target.geometry);
    this._front = new THREE.Mesh(this._target.geometry);
    this._buildStencilMaterials(this._target.material);
    // Counters, then the cap: after the model (0), before the mask overlays (1+).
    this._back.renderOrder = this._front.renderOrder = 0.5;

    const capMat = new THREE.ShaderMaterial({
      vertexShader: capVertexShader,
      fragmentShader: capFragmentShader,
      uniforms: {
        capColor:     { value: new THREE.Color(0.80, 0.80, 0.84) },
        hatchColor:   { value: new THREE.Color(0.42, 0.36, 0.86) },
        hatchSpacing: { value: 1 },
      },
      // The cut is looked at from the REMOVED side — the quad backfaces the
      // viewer there, so it must render double-sided or it culls away.
      side: THREE.DoubleSide,
      stencilWrite: true,
      stencilRef: 0,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp,
      stencilZFail: THREE.ReplaceStencilOp,
      stencilZPass: THREE.ReplaceStencilOp,
    });
    this._cap = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), capMat);
    this._cap.renderOrder = 0.6;
    this._cap.onAfterRender = (renderer) => renderer.clearStencil();
    this.host.scene.add(this._back, this._front, this._cap);
  }

  /** Stencil counters drawn with the model's own vertex stage (shared uniforms,
   *  so they track every preview setting), back faces incrementing and front
   *  faces decrementing: non-zero exactly where the ray is inside the solid at
   *  the plane. Depth-test off — every layer along the ray counts. */
  _buildStencilMaterials(src) {
    this._back?.material?.dispose?.();
    this._front?.material?.dispose?.();
    this._stencilSrc = src;
    const make = (side, op) => {
      const m = src && src.isShaderMaterial
        ? new THREE.ShaderMaterial({
            vertexShader: src.vertexShader,
            fragmentShader: stencilFragmentShader,
            uniforms: src.uniforms,
            defines: { ...src.defines },
            clipping: true,
          })
        : new THREE.MeshBasicMaterial();
      m.side = side;
      m.depthWrite = false;
      m.depthTest = false;
      m.colorWrite = false;
      m.stencilWrite = true;
      m.stencilFunc = THREE.AlwaysStencilFunc;
      m.stencilFail = m.stencilZFail = m.stencilZPass = op;
      m.clippingPlanes = [this.plane];
      return m;
    };
    this._back.material  = make(THREE.BackSide,  THREE.IncrementWrapStencilOp);
    this._front.material = make(THREE.FrontSide, THREE.DecrementWrapStencilOp);
  }

  /** Re-derive the plane from the proxy pose and keep the cap on it. Fired on
   *  every handle drag (objectChange) and programmatic move. */
  _sync() {
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(this._proxy.quaternion);
    this.plane.setFromNormalAndCoplanarPoint(n, this._proxy.position);
    if (this._cap) {
      this._cap.position.copy(this._proxy.position);
      this._cap.quaternion.copy(this._proxy.quaternion);
    }
    this.host.requestRender();
  }

  _updateVisibility() {
    const live = this._handlesLive();
    this._proxy.visible = live;
    for (const tc of [this._translate, this._rotate]) {
      if (!tc) continue;
      if (!live) {
        // Disabled, it would never see the pointerup: end a drag in flight
        // (dragging-changed hands the orbit controls back).
        tc.dragging = false;
        tc.axis = null;
      }
      tc.enabled = live;
      tc.getHelper().visible = live;
    }
    const caps = this._on && !!this._target;
    for (const o of [this._back, this._front, this._cap]) if (o) o.visible = caps;
    this.host.requestRender();
  }
}
