import { zipSync, strToU8 } from 'fflate';

function triggerDownload(buffer, filename, mime = 'application/octet-stream') {
  const blob = new Blob([buffer], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href=url; a.download=filename; a.style.display='none';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ── STL exporter ─────────────────────────────────────────────────────────────

export function exportSTL(geometry, filename = 'textured.stl') {
  const posArr = geometry.attributes.position.array;
  const norArr = geometry.attributes.normal ? geometry.attributes.normal.array : null;
  const triCount = (posArr.length / 9) | 0;
  const buffer = new ArrayBuffer(84 + 50 * triCount);
  const bytes  = new Uint8Array(buffer);
  const view   = new DataView(buffer);
  view.setUint32(80, triCount, true);
  const posSrc = new Uint8Array(posArr.buffer, posArr.byteOffset, posArr.byteLength);
  const norSrc = norArr ? new Uint8Array(norArr.buffer, norArr.byteOffset, norArr.byteLength) : null;
  for (let i=0; i<triCount; i++) {
    const dst=84+i*50, srcOff=i*36;
    if (norSrc) {
      bytes.set(norSrc.subarray(srcOff, srcOff+12), dst);
    } else {
      const b=i*9;
      const ux=posArr[b+3]-posArr[b], uy=posArr[b+4]-posArr[b+1], uz=posArr[b+5]-posArr[b+2];
      const vx=posArr[b+6]-posArr[b], vy=posArr[b+7]-posArr[b+1], vz=posArr[b+8]-posArr[b+2];
      const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
      const len=Math.sqrt(nx*nx+ny*ny+nz*nz)||1;
      view.setFloat32(dst,   nx/len, true);
      view.setFloat32(dst+4, ny/len, true);
      view.setFloat32(dst+8, nz/len, true);
    }
    bytes.set(posSrc.subarray(srcOff, srcOff+36), dst+12);
  }
  triggerDownload(buffer, filename);
}

// ── 3MF body metadata ─────────────────────────────────────────────────────────

let _3mfBodies       = null;
let _3mfCenterOffset = null;

export function set3mfBodies(bodies, centerOffset) {
  _3mfBodies       = (bodies && bodies.length > 0) ? bodies : null;
  _3mfCenterOffset = centerOffset || null;
}

export function clear3mfBodies() {
  _3mfBodies       = null;
  _3mfCenterOffset = null;
}

export function get3mfBodies() {
  return _3mfBodies;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt4(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '0';
  let s = n.toFixed(4);
  if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/"/g,'&quot;')
    .replace(/'/g,'&apos;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function makeEmitter() {
  const enc=new TextEncoder(), chunks=[];
  let total=0, pending='';
  const FLUSH=1<<20;
  const flush=()=>{ if(!pending)return; const b=enc.encode(pending); chunks.push(b); total+=b.length; pending=''; };
  const emit=(s)=>{ pending+=s; if(pending.length>=FLUSH)flush(); };
  const finish=()=>{ flush(); const out=new Uint8Array(total); let off=0; for(const b of chunks){out.set(b,off);off+=b.length;} return out; };
  return {emit,finish};
}

function emitObjectXml(emitter, geometry, objectId, name) {
  const { emit } = emitter;
  const posArr   = geometry.attributes.position.array;
  const triCount = (posArr.length / 9) | 0;
  if (triCount === 0) return;

  const indexMap = new Map();
  const xyz      = [];
  const triIdx   = new Uint32Array(triCount * 3);

  for (let i=0; i<triCount; i++) {
    for (let j=0; j<3; j++) {
      const b=i*9+j*3;
      const x=posArr[b], y=posArr[b+1], z=posArr[b+2];
      if (!isFinite(x)||!isFinite(y)||!isFinite(z))
        throw new Error(`Non-finite vertex in body ${objectId} tri ${i} vert ${j}: (${x},${y},${z})`);
      const key=x.toFixed(4)+','+y.toFixed(4)+','+z.toFixed(4);
      let idx=indexMap.get(key);
      if (idx===undefined) { idx=xyz.length/3; xyz.push(x,y,z); indexMap.set(key,idx); }
      triIdx[i*3+j]=idx;
    }
  }

  const vertCount=xyz.length/3;
  const namePart=name ? ` name="${escapeXml(name)}"` : '';
  emit(`<object id="${objectId}"${namePart} type="model">\n<mesh>\n<vertices>\n`);
  for (let i=0;i<vertCount;i++) {
    const b=i*3;
    emit('<vertex x="'+fmt4(xyz[b])+'" y="'+fmt4(xyz[b+1])+'" z="'+fmt4(xyz[b+2])+'"/>\n');
  }
  emit('</vertices>\n<triangles>\n');
  for (let i=0;i<triCount;i++) {
    const b=i*3;
    emit('<triangle v1="'+triIdx[b]+'" v2="'+triIdx[b+1]+'" v3="'+triIdx[b+2]+'"/>\n');
  }
  emit('</triangles>\n</mesh>\n</object>\n');
}

function buildTransformAttr(matrix, centerOffset) {
  if (!matrix || !matrix.isMatrix4 || !matrix.elements || matrix.elements.length < 16) return null;
  const e=matrix.elements;
  const m00=e[0],m10=e[1],m20=e[2];
  const m01=e[4],m11=e[5],m21=e[6];
  const m02=e[8],m12=e[9],m22=e[10];
  let tx=e[12],ty=e[13],tz=e[14];
  if (centerOffset) {
    tx+=isFinite(centerOffset.x)?centerOffset.x:0;
    ty+=isFinite(centerOffset.y)?centerOffset.y:0;
    tz+=isFinite(centerOffset.z)?centerOffset.z:0;
  }
  const eps=1e-5;
  if (Math.abs(m00-1)<eps&&Math.abs(m10)<eps&&Math.abs(m20)<eps&&
      Math.abs(m01)<eps&&Math.abs(m11-1)<eps&&Math.abs(m21)<eps&&
      Math.abs(m02)<eps&&Math.abs(m12)<eps&&Math.abs(m22-1)<eps&&
      Math.abs(tx)<eps&&Math.abs(ty)<eps&&Math.abs(tz)<eps) return null;
  return [m00,m01,m02,m10,m11,m12,m20,m21,m22,tx,ty,tz]
    .map(v=>parseFloat((isFinite(v)?v:0).toFixed(6))).join(' ');
}

// ── Core 3MF byte builder (no download) ──────────────────────────────────────
// Used by both export3MF (adds download) and project save (_bodiesToRaw3MF).

export function build3MFBytes(bodyResultsOrGeometry) {
  const emitter = makeEmitter();
  const { emit, finish } = emitter;

  emit(
    '<?xml version="1.0" encoding="UTF-8"?>\n'+
    '<model unit="millimeter" xml:lang="en-US" '+
    'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n'+
    '<resources>\n'
  );

  const isMultiBody = Array.isArray(bodyResultsOrGeometry) && bodyResultsOrGeometry.length > 0;

  if (isMultiBody) {
    const bodyResults = bodyResultsOrGeometry;
    const nonEmpty = bodyResults.filter(b => (b.geometry.attributes.position.array.length/9|0) > 0);
    for (let i=0; i<nonEmpty.length; i++) {
      emitObjectXml(emitter, nonEmpty[i].geometry, i+1, nonEmpty[i].name||'');
    }
    emit('</resources>\n<build>\n');
    for (let i=0; i<nonEmpty.length; i++) {
      const txAttr = buildTransformAttr(nonEmpty[i].matrix, _3mfCenterOffset);
      emit(txAttr
        ? `<item objectid="${i+1}" transform="${txAttr}"/>\n`
        : `<item objectid="${i+1}"/>\n`);
    }
    emit('</build>\n</model>\n');
  } else {
    const geometry = bodyResultsOrGeometry;
    const name   = (_3mfBodies && _3mfBodies.length===1) ? (_3mfBodies[0].name||'') : '';
    const matrix = (_3mfBodies && _3mfBodies.length===1) ? _3mfBodies[0].matrix : null;
    emitObjectXml(emitter, geometry, 1, name);
    emit('</resources>\n<build>\n');
    const txAttr = buildTransformAttr(matrix, _3mfCenterOffset);
    emit(txAttr ? `<item objectid="1" transform="${txAttr}"/>\n` : '<item objectid="1"/>\n');
    emit('</build>\n</model>\n');
  }

  const modelBytes = finish();

  const contentTypesXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n'+
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'+
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'+
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n'+
    '</Types>\n';
  const relsXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n'+
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'+
    '<Relationship Id="rel-1" Target="/3D/3dmodel.model" '+
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n'+
    '</Relationships>\n';

  return zipSync({
    '[Content_Types].xml': strToU8(contentTypesXml),
    '_rels/.rels':         strToU8(relsXml),
    '3D/3dmodel.model':    modelBytes,
  }, { level:6 });
}

// ── Public 3MF exporter (builds bytes then triggers download) ─────────────────

export function export3MF(bodyResultsOrGeometry, filename = 'textured.3mf') {
  const zipped = build3MFBytes(bodyResultsOrGeometry);
  triggerDownload(zipped, filename, 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml');
}