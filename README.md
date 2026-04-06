# BumpMesh by CNC Kitchen

**Live:** https://bumpmesh.com  
**GitHub:** https://github.com/CNCKitchen/stlTexturizer

A browser-based tool for applying surface displacement textures to 3D meshes — no installation required.

Load an STL, OBJ, or 3MF file, pick a texture, tune the parameters, and export a new displaced STL ready for slicing.

## Features

### Textures
- **24 built-in seamless textures** — basket, brick, bubble, carbon fiber, crystal, dots, grid, grip surface, hexagon, hexagons, isogrid, knitting, knurling, leather 2, noise, stripes (×2 variants), voronoi, weave (×3 variants), wood (×3 variants)
- **Custom textures** — upload one or multiple images as displacement maps; they appear in the grid alongside the built-in presets for easy switching
- **Community texture repos** — add GitHub repositories as texture sources (see [Custom Texture Repos](#custom-texture-repos) below)
- **Texture smoothing** — configurable blur to soften the displacement map before applying

### Projection Modes
- **Triplanar** (default) — blends three planar projections based on surface normals; best for complex shapes
- **Cubic (Box)** — projects from 6 box faces with edge-seam blending and smart axis dominance
- **Cylindrical** — wraps texture around a cylindrical axis with configurable cap angle
- **Spherical** — maps texture spherically around the object
- **Planar XY / XZ / YZ** — flat axis-aligned projections

### UV & Transform Controls
- **Scale U/V** — independent or locked scaling (0.05–10×, logarithmic)
- **Offset U/V** — position the texture on each axis
- **Rotation** — rotate texture before projection
- **Seam Blend Strength** — softens hard edges where Cubic/Cylindrical projection faces meet
- **Seam Band Width** — controls blending zone width at seam edges
- **Cap Angle** (Cylindrical) — threshold for switching to top/bottom cap projection

### Displacement
- **Amplitude** — scales displacement depth from 0 % to 100 %
- **Symmetric displacement** — 50 % grey stays neutral, white pushes out, black pushes in (preserves volume)
- **3D displacement preview** — real-time GPU-accelerated preview toggle showing actual vertex displacement
- **Amplitude overlap warning** — alerts when depth exceeds 10 % of the smallest model dimension

### Surface Masking
- **Angle masking** — suppress texture on near-horizontal top and/or bottom faces (0°–90° threshold each)
- **Face exclusion / inclusion painting** — paint individual faces to exclude (orange) or exclusively include (green) them
  - Brush tool — single-triangle click or adjustable-radius circle brush
  - Bucket fill — flood-fills adjacent faces up to a configurable dihedral-angle threshold
  - Erase — hold Shift to undo painted faces
  - Clear all — reset masking

### Mesh Processing
- **Adaptive subdivision** — subdivides edges until they are ≤ a target length; respects sharp creases (>30° dihedral)
- **QEM decimation** — simplifies the result to a target triangle count using Quadric Error Metrics with boundary protection, link-condition checks, normal-flip rejection, and crease preservation
- **Safety cap** — hard limit of 10 M triangles during subdivision to prevent out-of-memory

### 3D Viewer
- **Orbit / pan / zoom** controls
- **Wireframe toggle** — visualise mesh topology
- **Mesh info** — live triangle count, file size, bounding-box dimensions
- **Grid & axes indicator** — X = red, Y = green, Z = blue
- **Place on Face** — click a face to orient it downward onto the print bed

### File Support
- **.STL** — binary and ASCII
- **.OBJ** — via Three.js OBJLoader
- **.3MF** — ZIP-based format (via fflate decompression)

### Export
- Downloads a **binary STL** with displacement baked in
- Progress reporting through subdivision → displacement → decimation → writing stages
- Configurable edge-length threshold and output triangle limit

### Other
- **Light / Dark theme** — respects OS preference, persisted per browser
- **Multilingual** — English and German UI with auto-detection

## Usage

1. Open `index.html` in a modern browser (Chrome, Edge, Firefox, Safari).
2. Drop a model onto the viewport or click **Load STL…** (supports STL, OBJ, 3MF).
3. Select a texture preset from the sidebar (or upload a custom image).
4. Choose a projection mode and adjust UV scale, offset, rotation, and amplitude.
5. Optionally mask or exclude surfaces with the angle sliders or paint tools.
6. Click **Export STL** to download the displaced mesh.

> **Note:** All processing runs entirely in the browser — no data is uploaded to any server.

## Custom Texture Repos

You can load displacement maps from public GitHub repositories directly into BumpMesh. This lets the community share texture packs without bundling them into the app.

### How it works

1. Click **Add texture repo** in the Displacement Map section.
2. Enter a GitHub repository in `owner/repo` format (e.g. `myuser/my-textures`) or paste a full GitHub URL.
3. The textures are fetched and added to the grid. You can switch between them just like built-in presets.
4. To remove a repo, open the modal again and click the **x** next to the repo name. This removes all its textures from the grid.

Added repos are session-only — they are not persisted and will be gone after a page reload.

### Repository structure

A texture repo must have a `textures/` folder at the root containing the image files:

```
my-textures/
  textures/
    pattern1.jpg
    pattern2.png
    ...
```

### Supported image formats

jpg, jpeg, png, webp, bmp, gif, svg, tiff, avif, ico

### Disclaimer

Loading textures from third-party repositories is **at your own risk**. BumpMesh fetches images directly from GitHub — only add repos you trust. The authors of BumpMesh are not responsible for content provided by third-party repositories.

## Project Structure

```
index.html            # Main entry point
style.css             # Styles (light / dark theme)
logo.png              # Favicon & header logo
CNAME                 # Custom domain (bumpmesh.com)
textures/             # Built-in JPG/PNG displacement map images (24 textures)
js/
  main.js             # App bootstrap & UI wiring
  viewer.js           # Three.js scene / camera / controls
  stlLoader.js        # Binary & ASCII STL parser
  presetTextures.js   # Built-in texture presets + custom upload
  previewMaterial.js  # Three.js material for live & displacement preview
  mapping.js          # UV projection logic (7 modes)
  displacement.js     # Vertex displacement baking
  subdivision.js      # Adaptive mesh subdivision
  decimation.js       # QEM mesh decimation
  exclusion.js        # Face exclusion / inclusion painting
  exporter.js         # Binary STL export
  i18n.js             # Translations (EN / DE)
```

## Run Locally

All processing runs entirely in the browser — no backend or build step is needed. You just need a local HTTP server because browsers block ES module imports and texture loading from `file://` URLs.

```bash
# Clone the repository
git clone https://github.com/CNCKitchen/stlTexturizer.git
cd stlTexturizer
```

Then start any static file server from the project root. Pick whichever you have installed:

**Python (3.x)**
```bash
python -m http.server 8000
```

**Python (2.x)**
```bash
python -m SimpleHTTPServer 8000
```

**Node.js (npx, no install needed)**
```bash
npx serve .
```

**PHP**
```bash
php -S localhost:8000
```

Open http://localhost:8000 in your browser and you're ready to go.

> **Tip:** Any static server will work — the app has no server-side dependencies.

## Dependencies

Loaded via CDN — no build step needed:

- [Three.js](https://threejs.org/) v0.170.0 (including STLLoader, OBJLoader, OrbitControls, etc.)
- [fflate](https://github.com/101arrowz/fflate) v0.8.2 — ZIP decompression for .3mf files

## License

MIT — see [LICENSE](LICENSE).
