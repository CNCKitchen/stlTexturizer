/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from 'fs';
import { unzlibSync } from 'fflate';
import * as THREE from 'three';
import { subdivide } from './js/subdivision.js';
import { regularizeMesh } from './js/regularize.js';
import { applyDisplacement } from './js/displacement.js';
import { decimate } from './js/decimation.js';
import { resolveTJunctions, countAreaSlivers, countEdgeDefects } from './js/meshRepair.js';

const settings = {
  mappingMode: 5, scaleU: 0.3, scaleV: 0.3, amplitude: 0.5, textureHeight: 0.5,
  invertDisplacement: false, offsetU: 0, offsetV: 0, rotation: 0,
  refineLength: 0.2, maxTriangles: 2_000_000, lockScale: true,
  bottomAngleLimit: 5, topAngleLimit: 0, mappingBlend: 1, seamBandWidth: 0.5,
  textureSmoothing: 0, blendNormalSmoothing: 32, capAngle: 20, boundaryFalloff: 0,
  symmetricDisplacement: false, noDownwardZ: false, smoothBottom: true,
  harvestFlatFaces: true, harvestTol: 0.005, snapSeamlessWrap: true,
  cylinderCenterX: null, cylinderCenterY: null, cylinderRadius: null,
  regularizeEnabled: true, regularizeAspectThreshold: 5, regularizeSlack: 3.0,
  regularizeAggressiveSlack: 8.0, regularizeExtremeAspect: 8,
  regularizeNormalDeg: 15, regularizeAggressiveNormalDeg: 25, regularizeSecondPassMul: 1.1,
};
const _regOpts = () => ({ aspectThreshold: settings.regularizeAspectThreshold, slack: settings.regularizeSlack, aggressiveSlack: settings.regularizeAggressiveSlack, extremeSliverAspect: settings.regularizeExtremeAspect, maxNormalDeltaCos: Math.cos(settings.regularizeNormalDeg*Math.PI/180), aggressiveNormalDeltaCos: Math.cos(settings.regularizeAggressiveNormalDeg*Math.PI/180) });

function decodePNG(path){
  const d=readFileSync(path);let p=8;const idat=[];let w,h,ct,bd;
  while(p<d.length){const len=d.readUInt32BE(p);const type=d.toString('ascii',p+4,p+8);const s=p+8;
    if(type==='IHDR'){w=d.readUInt32BE(s);h=d.readUInt32BE(s+4);bd=d[s+8];ct=d[s+9];}
    else if(type==='IDAT')idat.push(d.subarray(s,s+len)); else if(type==='IEND')break; p=s+len+4;}
  const ch=ct===0?1:ct===2?3:ct===4?2:ct===6?4:null;
  const raw=unzlibSync(Buffer.concat(idat));const stride=w*ch;const out=new Uint8ClampedArray(w*h*4);
  const cur=new Uint8Array(stride),prev=new Uint8Array(stride);let rp=0;
  const pa=(a,b,c)=>{const pp=a+b-c,pA=Math.abs(pp-a),pB=Math.abs(pp-b),pC=Math.abs(pp-c);return pA<=pB&&pA<=pC?a:pB<=pC?b:c;};
  for(let y=0;y<h;y++){const f=raw[rp++];for(let x=0;x<stride;x++){const rw=raw[rp++];const A=x>=ch?cur[x-ch]:0;const B=prev[x];const C=x>=ch?prev[x-ch]:0;let v;switch(f){case 0:v=rw;break;case 1:v=rw+A;break;case 2:v=rw+B;break;case 3:v=rw+((A+B)>>1);break;case 4:v=rw+pa(A,B,C);break;}cur[x]=v&255;}
    for(let x=0;x<w;x++){const si=x*ch,di=(y*w+x)*4;let r,g,b,al;if(ch===1){r=g=b=cur[si];al=255;}else if(ch===2){r=g=b=cur[si];al=cur[si+1];}else if(ch===3){r=cur[si];g=cur[si+1];b=cur[si+2];al=255;}else{r=cur[si];g=cur[si+1];b=cur[si+2];al=cur[si+3];}out[di]=r;out[di+1]=g;out[di+2]=b;out[di+3]=al;}
    prev.set(cur);}
  return {data:out,width:w,height:h};
}
function snapBottom(g,bz,tol=0.1){const pa=g.attributes.position.array;for(let i=0;i<pa.length;i+=9){if(Math.abs(pa[i+2]-bz)<=tol)pa[i+2]=bz;if(Math.abs(pa[i+5]-bz)<=tol)pa[i+5]=bz;if(Math.abs(pa[i+8]-bz)<=tol)pa[i+8]=bz;}}
function openAfterImport(g,Q=1e4){const p=g.attributes.position.array,n=p.length/9;const vm=new Map(),id=new Int32Array(n*3);for(let i=0;i<n*3;i++){const k=`${Math.round(p[i*3]*Q)},${Math.round(p[i*3+1]*Q)},${Math.round(p[i*3+2]*Q)}`;let v=vm.get(k);if(v===undefined){v=vm.size;vm.set(k,v);}id[i]=v;}const ec=new Map();for(let t=0;t<n;t++){const b=t*9;const ux=p[b+3]-p[b],uy=p[b+4]-p[b+1],uz=p[b+5]-p[b+2];const vx=p[b+6]-p[b],vy=p[b+7]-p[b+1],vz=p[b+8]-p[b+2];const a2=(uy*vz-uz*vy)**2+(uz*vx-ux*vz)**2+(ux*vy-uy*vx)**2;if(a2<1e-24)continue;const A=id[t*3],B=id[t*3+1],C=id[t*3+2];if(A===B||B===C||A===C)continue;const tr=[A,B,C];for(let e=0;e<3;e++){const x=tr[e],y=tr[(e+1)%3];const k=x<y?x*4294967296+y:y*4294967296+x;ec.set(k,(ec.get(k)||0)+1);}}let open=0,nm=0;for(const c of ec.values()){if(c===1)open++;else if(c>2)nm++;}return{open,nm};}

let geo = new THREE.BoxGeometry(50,50,50).toNonIndexed();
geo.computeVertexNormals();
geo.computeBoundingBox();
const bb=geo.boundingBox;
const bounds={min:bb.min.clone(),max:bb.max.clone(),size:new THREE.Vector3().subVectors(bb.max,bb.min),center:new THREE.Vector3().addVectors(bb.min,bb.max).multiplyScalar(0.5)};
const img=decodePNG('textures/dots.png');
console.log(`cube source tris=${geo.attributes.position.count/3}`);

let {geometry:sub}=await subdivide(geo, settings.refineLength, null, null);
console.log('after subdivide1 tris=',sub.attributes.position.count/3);
if(settings.regularizeEnabled){
  const reg=regularizeMesh(sub,new Int32Array(sub.attributes.position.count/3),settings.refineLength,_regOpts());
  sub.dispose();const ea=reg.geometry.attributes.excludeWeight;const w2=ea?ea.array:null;
  const {geometry:resub}=await subdivide(reg.geometry,settings.refineLength*settings.regularizeSecondPassMul,null,w2,{fast:false});
  reg.geometry.dispose();sub=resub;
}
let disp=applyDisplacement(sub,img,img.width,img.height,settings,bounds,null);sub.dispose();
console.log('after displace tris=',disp.attributes.position.count/3);
{const bz=bounds.min.z,pa=disp.attributes.position.array;for(let i=0;i<pa.length;i+=9){if(pa[i+2]<bz)pa[i+2]=bz;if(pa[i+5]<bz)pa[i+5]=bz;if(pa[i+8]<bz)pa[i+8]=bz;}}
snapBottom(disp,bounds.min.z);
let fin=await decimate(disp,settings.maxTriangles,null,settings.harvestFlatFaces,settings.harvestTol);
{const bz=bounds.min.z,pa=fin.attributes.position.array;for(let i=0;i<pa.length;i+=9){if(pa[i+2]<bz)pa[i+2]=bz;if(pa[i+5]<bz)pa[i+5]=bz;if(pa[i+8]<bz)pa[i+8]=bz;}}
snapBottom(fin,bounds.min.z);
console.log(`after decimate: tris=${fin.attributes.position.count/3} slivers=${countAreaSlivers(fin)} edgeDefects=`,countEdgeDefects(fin),' open-after-import=',openAfterImport(fin));
const rep=resolveTJunctions(fin);
console.log(`AFTER resolveTJunctions: tris=${rep.attributes.position.count/3} slivers=${countAreaSlivers(rep)} edgeDefects=`,countEdgeDefects(rep));
console.log('  >>> open/nm AFTER simulated importer cleanup:',JSON.stringify(openAfterImport(rep)));

// FAITHFUL export→import round-trip: round coords to toFixed(4) like export3MF,
// store float32 like the importer, then run the importer's degenerate removal.
const src=rep.attributes.position.array;
const rounded=new Float32Array(src.length);
for(let i=0;i<src.length;i++) rounded[i]=Math.fround(parseFloat(src[i].toFixed(4)));
const rg=new THREE.BufferGeometry(); rg.setAttribute('position',new THREE.BufferAttribute(rounded,3));
console.log(`  >>> AFTER export-round-trip (toFixed4+float32): slivers=${countAreaSlivers(rg)} open/nm-after-import=${JSON.stringify(openAfterImport(rg))}`);
