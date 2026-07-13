# BumpMesh MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes BumpMesh's headless
mesh-texturizing pipeline — adaptive subdivision, UV-projected displacement,
QEM decimation, and watertight repair — as tools an AI agent can call directly
on STL/OBJ/3MF files. No browser, no GPU, no upload: it imports `../js/*.js`
straight off disk, so it can never drift from the app it ships next to.

## Install

This repo is an npm **workspace**: `mcp/` is a workspace of the root package.
Run a single install **at the repo root** — it installs and hoists both the
MCP server's dependencies and the `three`/`fflate` that the shared `js/*.js`
modules import:

```bash
cd /path/to/stlTexturizer   # repo root, NOT mcp/
npm install
```

Requires Node.js 20+. (One install at the root is all that's needed — do not
run a separate `npm install` inside `mcp/`.)

## Run

```bash
node mcp/server.mjs          # from the repo root
```

The server speaks MCP over stdio. All logging goes to **stderr** (stdout is
reserved for the protocol).

## Client configuration

### Claude Desktop / Claude Code

Add to your MCP client config (e.g. `claude_desktop_config.json`, or via
`claude mcp add` for Claude Code):

```json
{
  "mcpServers": {
    "bumpmesh": {
      "command": "node",
      "args": ["/absolute/path/to/stlTexturizer/mcp/server.mjs"]
    }
  }
}
```

Use an absolute path to `server.mjs` — relative paths are resolved against the
client's own working directory, not this repo.

## Tools

| Tool | Purpose |
|---|---|
| `bumpmesh_list_textures` | List the 24 built-in texture presets (name, category, description, default UV scale). |
| `bumpmesh_inspect_mesh` | Triangle count, bounding box, surface area, watertightness, shell count. |
| `bumpmesh_texturize` | Apply a displacement texture to a mesh: subdivide → displace → decimate → repair. Writes STL or 3MF. |
| `bumpmesh_subdivide` | Adaptively subdivide a mesh to a target edge length. |
| `bumpmesh_decimate` | QEM-decimate a mesh to a target triangle count. |
| `bumpmesh_validate_mesh` | Open edges, non-manifold edges, shells, degenerate slivers. |
| `bumpmesh_place_on_bed` | Reorient a mesh so a chosen face sits flat on Z=0. |

All file-writing tools write to a temp path and rename on success, so a
failed run never leaves a partial output file. Paths are otherwise
unrestricted (this is a local, single-user tool).

### Note on `amplitude`

`bumpmesh_texturize`'s `amplitude` parameter is in **millimeters** (it maps
directly onto the app's "amplitude"/"texture height" slider, which ranges
0–2mm in the UI), not a 0..1 fraction — the pipeline adds it straight to
vertex positions. Negative values invert the bump direction. When
`|amplitude|` exceeds 10% of the model's smallest bounding-box dimension, the
response includes an `overlapWarning` (mirrors the app's own amplitude
warning).

### Strict inputs & texture source

Tool inputs are validated against a **strict** schema: an unknown or
misspelled parameter is rejected with a message naming the bad key and listing
the allowed parameters (never silently dropped) — both at the MCP protocol
layer and when a handler is called directly. `bumpmesh_texturize` requires
**exactly one** texture source: either `texture` (a preset name/filename, or a
literal image path) **or** `customImagePath` (an explicit image path). Supplying
both, or neither, is a clear error.

## Run the tests

```bash
npm test --workspace mcp    # from the repo root
# or:  cd mcp && npm test
```

Runs Node's built-in test runner (`node --test`) against `test/*.test.mjs`.
Tests generate a small binary-STL cube fixture in-memory (no bundled test
assets) and round-trip it through `bumpmesh_texturize` with a real built-in
preset, asserting the output re-parses, is watertight, and its STL byte
length matches `84 + 50 * triangleCount`. Coverage also includes a `.3mf`
write/read round-trip (via the headless DOMParser shim) and strict-input /
texture-source-validation cases.

## How it works

```
input file
  -> parseModelBuffer(arrayBuffer, ext)      js/stlLoader.js   (THREE loader + cleanup + bounds)
  -> decode texture -> {data,width,height}   mcp/lib/imageData.mjs, mcp/lib/textures.mjs
  -> buildSettings(params)                   mcp/lib/settings.mjs
  -> runExportPipeline({...})                js/exportPipeline.js  (unchanged upstream pipeline)
  -> buildSTLBytes / build3MFBytes           js/exporter.js
  -> write to a temp path, then rename       mcp/lib/pipeline.mjs
```

`js/stlLoader.js` `parse3MF()` uses the browser `DOMParser` global; Node has
none, so `mcp/lib/bootstrap.mjs` installs the pure-JS `@xmldom/xmldom`
implementation onto `globalThis` before any `js/` module runs. This keeps
`.3mf` input working headlessly without modifying `js/`.

Two small, behavior-preserving refactors were made upstream in `../js/` to
make this possible headlessly (both keep every existing browser call site
and its signature unchanged):

- **`js/exporter.js`** — extracted `buildSTLBytes(geometry): Uint8Array` and
  `build3MFBytes(geometry): Uint8Array` as pure byte-builders. `exportSTL`/
  `export3MF` now call the builder, then do the same Blob/`<a download>`
  browser download as before.
- **`js/stlLoader.js`** — extracted `parseModelBuffer(arrayBuffer, ext):
  {geometry, bounds, nanCount, degenerateCount, originOffset}`. `loadSTLFile`/
  `loadOBJFile`/`load3MFFile` now call it after `FileReader` yields the
  `ArrayBuffer` (OBJ's `FileReader` mode changed from `readAsText` to
  `readAsArrayBuffer`, decoding to the same UTF-8 string internally — an
  equivalent, not observably different, code path for real OBJ files).

## Why there's a root `package.json`

`js/threeCompat.js` resolves the bare specifier `three` (and `js/*.js`
resolves `fflate`) via Node's normal `node_modules` upward search starting at
`js/`'s own directory. The committed **root** `package.json` declares those
deps and an npm **workspace** for `mcp/`, so a single `npm install` at the
root installs everything and hoists it to the root `node_modules` — where both
`js/*.js` (three/fflate) and `mcp/server.mjs` (its own deps, resolved by
walking up from `mcp/`) can see it. The same root install also makes the
repo's pre-existing `bench-*.mjs` / `diag-*.mjs` scripts reproducible. The
browser app itself needs none of this — it loads `three` from the CDN import
map in `index.html` and has no build step.
