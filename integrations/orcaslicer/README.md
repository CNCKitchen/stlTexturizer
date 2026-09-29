# BumpMesh for OrcaSlicer

This experimental plugin embeds [BumpMesh](https://bumpmesh.com/) in an
OrcaSlicer plugin page and can transfer model-part geometry from the current
Orca project into BumpMesh.

## Requirements

- OrcaSlicer with the Plugin Pages capability merged in
  [OrcaSlicer/OrcaSlicer#14992](https://github.com/OrcaSlicer/OrcaSlicer/pull/14992),
  or an older plugin-enabled build with `orca.host.ui.create_window()` for the
  window fallback;
- internet access to `https://cdn.jsdelivr.net`;
- NumPy, installed automatically from the wheel dependency metadata.

## Current workflow

1. Open the **BumpMesh** tab in OrcaSlicer.
2. If the project changed after the tab opened, click **Refresh**.
3. Select a printable Orca object and click **Load from OrcaSlicer**.
4. Apply and preview the displacement texture in BumpMesh.
5. On Windows, click **Return to OrcaSlicer** to generate the textured STL and send it back.
6. Switch to **Prepare** and check the new object. The source object is preserved.

On other platforms, export STL or 3MF and import the file manually.

The return action uses OrcaSlicer's existing Windows single-instance file-open
channel, targeted to the current process. The Python model API remains read-only;
this adds a new object, not an in-place replacement, and does not preserve source
paint, modifiers, object settings or instance placement on the new object.
A sent request is not proof of import: check the Prepare tab before retrying.
Return transfers are limited to 500 MB (10 million triangles), validated as binary
STL and stored in the plugin's `bumpmesh-output` directory. Files are retained if
opening fails. Incomplete transfers remain as `.stl.part` files.

The wheel includes the matching BumpMesh 1.3.7 web application. It is delivered
through Orca's page message bridge and rendered inside the WebView. Startup
creates no listener, extracts no ZIP and writes no files. Returned STL files
use `orca.host.plugin.storage()`; the plugin does not change Python's bytecode
settings or the host's permission policy.
Install `dist/release-0.1.2/wheels/bumpmesh-0.1.2-py3-none-any.whl` through
OrcaSlicer's plugin installer. JavaScript libraries still load from jsDelivr.

The JSON page bridge also has no binary attachment channel. To keep OrcaSlicer
responsive, automatic input transfer is limited to one million triangles. For
larger objects, export the source model from OrcaSlicer and load it using
BumpMesh's normal file picker.

Objects containing negative volumes also require manual export. The read-only
host API exposes the component meshes but does not expose OrcaSlicer's resolved
boolean result, so silently dropping the negative geometry would produce the
wrong model.

## Build

Web packaging uses Node.js and esbuild 0.25.11 at build time only. They are not
plugin runtime dependencies. The bundler preserves the upstream pinned CDN
library versions and includes local modules, workers, translations and textures.

```powershell
python bundle_web.py /path/to/reviewed/stlTexturizer --esbuild /path/to/node_modules/esbuild
python build_package.py
```

The command creates `dist/release-<version>/`: the wheel in `wheels/`, the
staged package in `bumpmesh-<version>/`, plus `RELEASE_NOTES.md` and `SHA256SUMS`.
The staged package includes the image, listing description and changelog.
Install the resulting wheel using OrcaSlicer's local plugin installer.

See [PUBLISHING.md](PUBLISHING.md) for the exact Orca Cloud fields and release
checklist. The prepared listing text lives in [description.md](description.md),
and release notes live in [CHANGELOG.md](CHANGELOG.md).

To test unmerged BumpMesh bridge changes, serve the repository on a loopback
address and start OrcaSlicer with `BUMPMESH_ORCASLICER_DEV_URL` set, for
example:

```powershell
$env:BUMPMESH_ORCASLICER_DEV_URL = "http://127.0.0.1:8000/"
```

For safety, the override accepts loopback HTTP(S) URLs only.

## Development status

Plugin Pages is merged upstream. The window fallback remains for older hosts.
Plugin 0.1.2 was tested in OrcaSlicer 2.5.0-dev build 824b216f on Windows:
activation, loading geometry from OrcaSlicer and returning the textured model.
The package loading change resolves the long enable pause reported with 0.1.1.
