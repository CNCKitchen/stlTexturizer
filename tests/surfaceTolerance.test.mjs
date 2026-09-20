/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshBVH } from 'three-mesh-bvh';
import { withinSurfaceTolerance } from '../js/surfaceTolerance.js';

const triangle=z=>new Float32Array([0,0,z,1,0,z,0,1,z]);
const bounded=(a,b,t=.005)=>withinSurfaceTolerance(a,b,t,performance.now()+1000,MeshBVH);

test('surface acceptance covers both interiors and disconnected components',()=>{
  assert.ok(bounded(triangle(0),triangle(.004)));
  assert.equal(bounded(triangle(0),triangle(.006)),false);
  assert.equal(bounded(new Float32Array([...triangle(0),...triangle(1)]),triangle(0)),false);
  const corners=new Float32Array([0,0,0,.1,0,0,0,.1,0,1,0,0,.9,0,0,.9,.1,0,0,1,0,0,.9,0,.1,.9,0]);
  assert.equal(bounded(triangle(0),corners),false);
  assert.equal(bounded(triangle(0),triangle(2**-12),2**-12-2**-65),false);
});

test('retriangulation keeps complete coverage through reused subdivision storage',()=>{
  const a=new Float32Array([0,0,0,100,0,0,80,1,0,0,0,0,80,1,0,0,1,0]);
  const b=new Float32Array([0,0,0,100,0,0,0,1,0,100,0,0,80,1,0,0,1,0]);
  assert.ok(bounded(a,b,1e-6));
  assert.equal(bounded(new Float32Array([...a,...triangle(2)]),new Float32Array([...b,...triangle(2.006)])),false);
});
