# BumpMesh for OrcaSlicer

Open [BumpMesh by CNC Kitchen](https://bumpmesh.com/) as a full-size page inside
OrcaSlicer and transfer printable geometry from the current project directly
into the BumpMesh texturing workspace.

- Select an OrcaSlicer model and load it into BumpMesh without first exporting a
  source file.
- Apply, preview and tune BumpMesh displacement textures using its complete
  WebGL interface.
- Follow OrcaSlicer's interface language and initial light or dark appearance.
- Keep model processing inside the embedded BumpMesh browser application; the
  model is not uploaded to an external processing service.

After processing, export STL or 3MF from BumpMesh and import the result into
OrcaSlicer. Automatic return to the build plate is not yet available because
the current OrcaSlicer plugin API exposes model geometry as read-only snapshots.

**Requirements:** An OrcaSlicer build containing the Plugin Pages API and an
internet connection to `bumpmesh.com`.

**Development status:** Experimental integration for the draft Plugin Pages
API. Publish compatibility only for an OrcaSlicer build on which the complete
workflow has been tested.
