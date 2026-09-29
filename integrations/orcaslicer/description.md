# BumpMesh for OrcaSlicer

Add physical surface textures to your 3D prints with
[BumpMesh by CNC Kitchen](https://github.com/CNCKitchen/stlTexturizer), directly
inside OrcaSlicer. Texture is applied to the mesh itself, so the exported model
contains the surface detail for slicing and printing.

- Load a printable object from the current OrcaSlicer project, or open an STL,
  OBJ, 3MF or STEP file.
- Browse the texture gallery beside the model or use your own displacement image.
- Adjust texture size, depth, rotation, inversion and projection, with a 3D preview.
- Mask flat surfaces or paint areas that should remain untextured.
- Export the textured model as STL or 3MF. On Windows, use **Return to
  OrcaSlicer** to request import as a new object while retaining the original.
- Start in OrcaSlicer's language and light or dark theme, and switch languages
  within BumpMesh.

Model processing takes place locally in the embedded browser. Models and
texture images are not uploaded to a processing service. The matching BumpMesh
application is included in the plugin package.

**Requirements:** An OrcaSlicer build with Plugin Pages and internet access to
`cdn.jsdelivr.net` for JavaScript libraries. Direct return is Windows-only;
other platforms use file export and manual import. Returned geometry does not
carry over OrcaSlicer paint, modifiers or object settings.

**Development status:** Experimental. The Windows load-and-return workflow has
been tested in OrcaSlicer. Compatibility with other builds may vary.

BumpMesh is created by Stefan Hermann / CNC Kitchen and distributed under
AGPL-3.0. [Website](https://bumpmesh.com/) ·
[Source code](https://github.com/CNCKitchen/stlTexturizer)
