import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';

const exporter = new STLExporter();

/**
 * Export a BufferGeometry as a binary STL file download.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {string} [filename]
 */
export function exportSTL(geometry, filename = 'textured.stl') {
  // Geometry is already in the original Z-up orientation (the loader never rotates it;
  // the viewer uses a Z-up camera instead). Export as-is so slicers receive the correct pose.
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  const result = exporter.parse(mesh, { binary: true });

  // result is an ArrayBuffer in binary mode
  const blob = new Blob([result], { type: 'application/octet-stream' });
  const url  = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // Revoke after a short delay so the download has time to start
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
