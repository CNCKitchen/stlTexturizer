/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { THREE } from './threeCompat.js';
import { decimate } from './decimation.js';
import { countAreaSlivers } from './meshRepair.js';
import { indexExactPositions } from './exactGeometry.js';
import { QuantizedPointMap } from './meshIndex.js';
import { withinSurfaceTolerance } from './surfaceTolerance.js';

// Optional acceleration: a failed download must not break ordinary exports.
const acceleration=import('three-mesh-bvh')
  .catch(()=>import('https://esm.sh/three-mesh-bvh@0.9.1?deps=three@0.170.0'))
  .then(module=>module.MeshBVH).catch(()=>null);

function inspect(positions,mask=null) {
  const {vertices,indices}=indexExactPositions(positions),n=vertices.length/3;
  if(mask&&(mask.length!==positions.length/9||mask.some(v=>v>1)))throw Error('Invalid face locks');
  const locks=mask?mask.slice():new Uint8Array(positions.length/9),bad=new Uint8Array(n);
  const edges=new Map(),parents=Int32Array.from({length:n},(_,i)=>i);
  const root=i=>{while(parents[i]!==i){parents[i]=parents[parents[i]];i=parents[i];}return i;};
  for(let f=0;f<indices.length;f+=3)for(let k=0;k<3;k++) {
    const a=indices[f+k],b=indices[f+(k+1)%3],key=a<b?`${a},${b}`:`${b},${a}`;
    if(a===b)bad[a]=1;
    let edge=edges.get(key);
    if(!edge)edges.set(key,edge={a,b,count:0,winding:0});
    edge.count++;edge.winding+=a<b?1:-1;parents[root(a)]=root(b);
  }
  let open=0,nonManifold=0,inconsistent=0;
  for(const e of edges.values()) {
    if(e.count!==2||e.winding!==0)bad[e.a]=bad[e.b]=1;
    if(e.count===1)open++;if(e.count>2)nonManifold++;
    if(e.count===2&&e.winding!==0)inconsistent++;
  }
  for(let f=0;f<locks.length;f++)if(bad[indices[f*3]]||bad[indices[f*3+1]]||bad[indices[f*3+2]])locks[f]=1;
  return {locks,signature:[open,nonManifold,inconsistent,n-edges.size+positions.length/9,new Set(parents.map((_,i)=>root(i))).size].join(',')};
}

function protectedEqual(before,mask,after,afterMask) {
  if(!afterMask)return false;
  const a=new Uint32Array(before.buffer,before.byteOffset,before.length);
  const b=new Uint32Array(after.buffer,after.byteOffset,after.length);
  let j=0;
  for(let i=0;i<mask.length;i++)if(mask[i]) {
    while(j<afterMask.length&&!afterMask[j])j++;
    if(j===afterMask.length)return false;
    for(let k=0;k<9;k++)if(a[i*9+k]!==b[j*9+k])return false;
    j++;
  }
  return !afterMask.subarray(j).some(Boolean);
}

// Mirror the existing 3MF writer's welding and decimal output. Track the
// Float32 approximation error so the bound also covers the serialized surface.
function exportSurface(positions,format) {
  if(format!=='3mf')return {positions,error:0};
  const map=new QuantizedPointMap(1e4,Math.min(positions.length/3,1<<20));
  const out=new Float32Array(positions.length);let error=0;
  for(let i=0;i<positions.length;i+=3) {
    const first=map.getOrSet(positions[i],positions[i+1],positions[i+2],i);
    if(first!==i){out.set(out.subarray(first,first+3),i);continue;}
    let squared=0;
    for(let k=0;k<3;k++) {
      const value=Number(positions[i+k].toFixed(4));out[i+k]=value;
      squared+=(Math.abs(out[i+k]-value)+Math.abs(value)*Number.EPSILON)**2;
    }
    error=Math.max(error,Math.sqrt(squared));
  }
  return {positions:out,error:error*(1+8*Number.EPSILON)+Number.MIN_VALUE};
}

/** Optimize only a finished, posed export. Rejected candidates retain input buffers. */
export async function refineExportMesh(input,shouldAbort=()=>false,deadline=performance.now()+5000) {
  const before=input.positions.length/9;
  const unchanged=()=>({...input,refinement:{before,after:before}});
  if(shouldAbort())return null;
  if(performance.now()>=deadline)return unchanged();
  const MeshBVH=await new Promise(resolve=>{
    const timer=setTimeout(()=>resolve(null),Math.min(5000,deadline-performance.now()));
    acceleration.then(value=>{clearTimeout(timer);resolve(value);});
  });
  if(shouldAbort())return null;
  if(!MeshBVH||performance.now()>=deadline)return unchanged();
  const original=inspect(input.positions,input.lockedFaces);
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(input.positions,3));
  let candidate;
  try {
    const outputCoordinate=input.format==='3mf'
      ? value=>Math.fround(Number(Math.fround(value).toFixed(4))) : Math.fround;
    candidate=await decimate(geometry,before,null,true,.005,original.locks,outputCoordinate,deadline);
    if(shouldAbort())return null;
    const positions=candidate.attributes.position.array,mask=candidate.userData.lockedFaces;
    if(positions.length>=input.positions.length||performance.now()>=deadline)return unchanged();
    if(!protectedEqual(input.positions,original.locks,positions,mask))return unchanged();
    const a=exportSurface(input.positions,input.format),b=exportSurface(positions,input.format);
    geometry.setAttribute('position',new THREE.BufferAttribute(a.positions,3));
    candidate.setAttribute('position',new THREE.BufferAttribute(b.positions,3));
    if(countAreaSlivers(candidate)!==countAreaSlivers(geometry))return unchanged();
    if(inspect(a.positions).signature!==inspect(b.positions).signature)return unchanged();
    if(!protectedEqual(a.positions,original.locks,b.positions,mask))return unchanged();
    const tolerance=.005-a.error-b.error;
    if(!(tolerance>0)||!withinSurfaceTolerance(a.positions,b.positions,tolerance,deadline,MeshBVH))return unchanged();
    return {positions,normals:null,refinement:{before,after:positions.length/9}};
  } catch(error) {
    console.warn('[stlTexturizer] Export optimization skipped:',error);
    return unchanged();
  } finally {geometry.dispose();candidate?.dispose();}
}
