# BumpMesh for OrcaSlicer

This experimental plugin embeds [BumpMesh](https://bumpmesh.com/) in an
OrcaSlicer plugin page and transfers printable model-part geometry from the
current Orca project into BumpMesh. The regular BumpMesh website is unchanged
unless it is opened by the plugin with the explicit integration parameters.

## Requirements

- OrcaSlicer with the Plugin Pages capability from
  [OrcaSlicer/OrcaSlicer#14992](https://github.com/OrcaSlicer/OrcaSlicer/pull/14992),
  or an older plugin-enabled build with `orca.host.ui.create_window()` for the
  window fallback;
- internet access to `https://bumpmesh.com`;
- NumPy, installed automatically from the wheel dependency metadata.

## Current workflow

1. Open the **BumpMesh** tab in OrcaSlicer.
2. If the project changed after the tab opened, click **Refresh**.
3. Select a printable Orca object and click **Load from OrcaSlicer**.
4. Apply and preview the displacement texture in BumpMesh.
5. Export STL or 3MF from BumpMesh.
6. Import the exported file into OrcaSlicer.

The final import is intentionally manual. The current Orca plugin API exposes
model meshes as immutable snapshots and has no supported hook for replacing or
adding model geometry. G-code post-processing runs after slicing and therefore
cannot provide this missing geometry round-trip.

The JSON page bridge also has no binary attachment channel. To keep OrcaSlicer
responsive, automatic input transfer is limited to one million triangles. For
larger objects, export the source model from OrcaSlicer and load it using
BumpMesh's normal file picker.

Objects containing negative volumes also require manual export. The read-only
host API exposes the component meshes but does not expose OrcaSlicer's resolved
boolean result, so silently dropping the negative geometry would produce the
wrong model.

## Build

```powershell
cd integrations/orcaslicer
python build_package.py
```

The command creates a versioned `dist/plugin-hub-*/` upload kit containing the
wheel, plugin image, listing description, changelog, metadata and checksums.
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

The Plugin Pages API is still a draft upstream feature. Keep the window
fallback until Pages is merged and available in the minimum supported
OrcaSlicer release.
