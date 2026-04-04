# STL Texturizer

**Live demo:** https://cnckitchen.github.io/stlTexturizer/

A browser-based tool for applying surface displacement textures to 3D meshes — no installation required.

Load an STL, OBJ, or 3MF file, pick a texture, tune the parameters, and export a new displaced STL ready for slicing.

## Local development

```sh
docker compose up --build
```

## Production build

```sh
TARGET=executor docker compose up --build
```

## Usage

Navigate the page: <http://localhost:3000>

## Features

### Textures

- **18 built-in seamless textures** — basket, brick, bubble, carbon fiber, crystal, dots, grip surface, hexagons, knitting, knurling, leather, leather 2, noise, voronoi, weave (×3 variants), wood
- **Custom textures** — upload your own image as a displacement map

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

## Project Structure

```
index.html            # Main entry point
style.css             # Styles (light / dark theme)
textures/             # Built-in JPG displacement map images (18 textures)
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

## Dependencies

Loaded via CDN — no build step needed:

- [Three.js](https://threejs.org/) v0.170.0 (including STLLoader, OBJLoader, OrbitControls, etc.)
- [fflate](https://github.com/101arrowz/fflate) v0.8.2 — ZIP decompression for .3mf files

## License

MIT — see [LICENSE](LICENSE).
