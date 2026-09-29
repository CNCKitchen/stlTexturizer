/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

const EMPTY = new Uint8Array(0);

/** Compress entries incrementally, retaining only compressed output chunks. */
export async function zipChunks(entries, shouldAbort = () => false) {
  const output = [];
  let failure, finished = false;
  const zip = new Zip((error, data, final) => {
    if (error) failure = error;
    else output.push(data);
    if (final) finished = true;
  });
  const check = () => {
    if (shouldAbort()) throw new Error('Aborted');
    if (failure) throw failure;
  };

  try {
    for (const [name, chunks] of entries) {
      check();
      let stream;
      try { stream = new CompressionStream('deflate-raw'); }
      catch { /* Older browsers keep the existing fflate DEFLATE encoder. */ }
      if (!stream) {
        const file = new ZipDeflate(name, { level: 6 });
        zip.add(file);
        for (const chunk of chunks) { check(); file.push(chunk, false); }
        check();
        file.push(EMPTY, true);
        check();
        continue;
      }

      // ZipPassThrough computes CRC and uncompressed size from source bytes.
      // Only its compression hook is replaced; fflate owns the ZIP headers.
      const file = new ZipPassThrough(name);
      file.compression = 8;
      const writer = stream.writable.getWriter();
      const reader = stream.readable.getReader();
      let pending, stopped = false;
      file.process = (chunk, final) => {
        pending = final ? writer.close() : writer.write(chunk);
      };
      zip.add(file);
      try {
        await Promise.all([
          (async () => {
            for (const chunk of chunks) {
              check();
              file.push(chunk, false);
              await pending; // Backpressure bounds uncompressed input memory.
            }
            check();
            file.push(EMPTY, true);
            await pending;
          })(),
          (async () => {
            while (true) {
              const { value, done } = await reader.read();
              if (stopped) return;
              check();
              file.ondata(null, done ? EMPTY : value, done);
              if (done) return;
            }
          })(),
        ]);
      } catch (error) {
        stopped = true;
        await Promise.allSettled([reader.cancel(error), writer.abort(error)]);
        throw error;
      } finally {
        reader.releaseLock();
        writer.releaseLock();
      }
    }
    check();
    zip.end();
    check();
    if (!finished) throw new Error('Incomplete ZIP archive');
    return new Blob(output, { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' });
  } catch (error) {
    zip.terminate();
    throw error;
  }
}
