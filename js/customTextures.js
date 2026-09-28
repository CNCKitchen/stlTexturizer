/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Local library of the user's uploaded displacement maps ("Your textures" in the gallery). Files live
// in IndexedDB, in this browser only, and the browser may evict them at any time — every call can
// fail or come back empty, and callers treat the library as a convenience, never as the source of
// truth. The original file is kept byte for byte so it can be downloaded again.

const DB_NAME    = 'bumpmesh-custom-textures';
const DB_VERSION = 1;
const META  = 'meta';    // { id, name, type, size, added, thumb (data URL) }, keyPath id
const FILES = 'files';   // id -> the uploaded File, kept apart so listing never touches the big blobs
const THUMB_SIZE = 256;

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      // Throws in some sandboxed / private contexts; inside the executor that just rejects.
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Site data cleared or another tab upgrading: drop this handle, the next call reopens.
        db.onversionchange = () => { db.close(); dbPromise = null; };
        db.onclose = () => { dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

/** Run `fn(tx, setResult)` in one transaction over both stores; resolves once it commits. */
async function transact(mode, fn, retry = true) {
  const db = await openDb();
  let tx;
  try {
    tx = db.transaction([META, FILES], mode);
  } catch (err) {
    // The connection was closed under us (e.g. site data cleared while the page is open): reopen once.
    dbPromise = null;
    if (retry) return transact(mode, fn, false);
    throw err;
  }
  return new Promise((resolve, reject) => {
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    fn(tx, (v) => { result = v; });
  });
}

/** A square, centre-cropped preview of the decoded map, small enough to keep in the listing. */
function makeThumb(canvas) {
  const s = Math.min(canvas.width, canvas.height);
  const size = Math.min(THUMB_SIZE, s);
  const thumb = document.createElement('canvas');
  thumb.width = thumb.height = size;
  const ctx = thumb.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, (canvas.width - s) / 2, (canvas.height - s) / 2, s, s, 0, 0, size, size);
  return thumb.toDataURL('image/webp', 0.85);   // browsers without WebP encoding fall back to PNG
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** Every stored texture's metadata, newest first. Rejects when storage is unavailable. */
export function listCustomTextures() {
  return transact('readonly', (tx, done) => {
    const req = tx.objectStore(META).getAll();
    req.onsuccess = () => done(req.result.sort((a, b) => b.added - a.added));
  });
}

/**
 * Keep `file` (as uploaded) with a thumbnail of its decoded `canvas`. Re-uploading a file with the
 * same name and size replaces the stored copy instead of adding a duplicate. Resolves to the metadata.
 */
export async function saveCustomTexture(file, canvas) {
  const thumb = makeThumb(canvas);
  return transact('readwrite', (tx, done) => {
    const metaStore = tx.objectStore(META);
    const req = metaStore.getAll();
    req.onsuccess = () => {
      const dup = req.result.find(m => m.name === file.name && m.size === file.size);
      const meta = { id: dup ? dup.id : newId(), name: file.name, type: file.type, size: file.size,
                     added: Date.now(), thumb };
      metaStore.put(meta);
      tx.objectStore(FILES).put(file, meta.id);
      done(meta);
    };
  });
}

/** The stored original as a File, or null if it's gone (evicted, deleted, storage unavailable). */
export async function getCustomTextureFile(id) {
  let found;
  try {
    found = await transact('readonly', (tx, done) => {
      const metaReq = tx.objectStore(META).get(id);
      const fileReq = tx.objectStore(FILES).get(id);
      fileReq.onsuccess = () => done({ meta: metaReq.result, blob: fileReq.result });
    });
  } catch (err) {
    console.warn('Custom texture storage unavailable:', err);
    return null;
  }
  if (!found.meta || !(found.blob instanceof Blob)) {
    // Half a record can't be used — drop the rest so the gallery stops listing it.
    if (found.meta) deleteCustomTexture(id).catch(() => {});
    return null;
  }
  return new File([found.blob], found.meta.name, { type: found.meta.type || found.blob.type });
}

/** Hand the stored original back as a download. Resolves false if it's no longer stored. */
export async function downloadCustomTexture(id) {
  const file = await getCustomTextureFile(id);
  if (!file) return false;
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

export function deleteCustomTexture(id) {
  return transact('readwrite', (tx) => {
    tx.objectStore(META).delete(id);
    tx.objectStore(FILES).delete(id);
  });
}

export function clearCustomTextures() {
  return transact('readwrite', (tx) => {
    tx.objectStore(META).clear();
    tx.objectStore(FILES).clear();
  });
}
