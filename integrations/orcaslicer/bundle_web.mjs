// Compile BumpMesh's local modules for the HTML surface of Orca's Pages API.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const [source, esbuildModule] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const esbuild = require(esbuildModule || 'esbuild');
const cdn = 'https://cdn.jsdelivr.net/npm/';
const plugin = {
  name: 'orca-page-resources',
  setup(build) {
    build.onResolve({ filter: /^(three(?:\/.*)?|fflate)$/ }, ({ path: specifier }) => ({
      path: specifier === 'three' ? `${cdn}three@0.170.0/build/three.module.js`
        : specifier === 'fflate' ? `${cdn}fflate@0.8.2/esm/browser.js`
        : `${cdn}three@0.170.0/examples/jsm/${specifier.slice('three/addons/'.length)}`,
      external: true,
    }));
    build.onResolve({ filter: /^https:\/\// }, args => ({ path: args.path, external: true }));
    build.onLoad({ filter: /\.js(?:\?.*)?$/ }, async args => {
      const filename = args.path.split('?')[0];
      let contents = await fs.readFile(filename, 'utf8');
      contents = contents.replaceAll('new URLSearchParams(window.location.search)',
        'new URLSearchParams(globalThis.__ORCA_QUERY || window.location.search)');
      contents = contents.replace(/new URL\('\.\/(exportWorker|stepWorker|previewWorker)\.js', import\.meta\.url\)/g,
        (_, name) => `globalThis.__BUMPMESH_WORKERS[${JSON.stringify(name)}]`);
      if (path.basename(filename) === 'presetTextures.js') {
        contents = contents.replace(/'(textures\/[^']+)'/g,
          (_, asset) => `globalThis.__BUMPMESH_ASSETS[${JSON.stringify(asset)}]`);
      }
      return { contents, loader: 'js', resolveDir: path.dirname(filename) };
    });
  },
};

const compile = async name => {
  const result = await esbuild.build({
    entryPoints: [path.join(source, 'js', `${name}.js`)], bundle: true,
    write: false, format: 'esm', platform: 'browser', target: 'es2022',
    minify: true, legalComments: 'inline', plugins: [plugin], logLevel: 'warning',
  });
  return result.outputFiles[0].text;
};
const [main, exportWorker, stepWorker, previewWorker] = await Promise.all(
  ['main', 'exportWorker', 'stepWorker', 'previewWorker'].map(compile));
process.stdout.write(JSON.stringify({ main, workers: { exportWorker, stepWorker, previewWorker } }));
