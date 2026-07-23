/**
 * bootstrap.mjs — headless polyfills that MUST be installed before any
 * ../../js/*.js module is used at runtime.
 *
 * js/stlLoader.js `parse3MF()` constructs `new DOMParser()` (a browser global)
 * to parse 3MF's XML. Node has no DOMParser, so without this shim every .3mf
 * input would throw "DOMParser is not defined". We install the pure-JS
 * @xmldom/xmldom implementation onto globalThis. This is import-side-effect
 * only — importing this module first (see lib/pipeline.mjs and server.mjs)
 * guarantees the global is set before parse3MF ever runs.
 *
 * We deliberately do NOT modify js/ (the upstream browser code stays as-is);
 * the shim lives entirely in the MCP layer.
 */

import { DOMParser } from '@xmldom/xmldom';

if (typeof globalThis.DOMParser === 'undefined') {
  globalThis.DOMParser = DOMParser;
}
