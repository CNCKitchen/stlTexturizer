# Publishing to Orca Cloud Plugin Hub

This integration is intended to be published and maintained by CNC Kitchen.
Do not publish it from a third-party Orca Cloud account without the project
owner's decision.

## Build the upload kit

From this directory run:

```powershell
python build_package.py
```

The command validates plugin metadata and runtime versions, runs a clean wheel
build and creates:

```text
dist/plugin-hub-0.1.0/
  bumpmesh-0.1.0-py3-none-any.whl
  BumpMesh.png
  description.md
  CHANGELOG.md
  LICENSE
  package-metadata.json
  SHA256SUMS
```

## Orca Cloud fields

| Field | Value |
|---|---|
| Plugin file | `bumpmesh-0.1.0-py3-none-any.whl` |
| Plugin image | `BumpMesh.png` |
| Name | `BumpMesh` |
| Description | Contents of `description.md` |
| Version | `0.1.0` |
| Type | Plugin Page, when that type is available in Orca Cloud |
| Compatible OrcaSlicer version | First tested build containing Plugin Pages |
| Changelog | The matching version section from `CHANGELOG.md` |
| Suggested tags | `modeling`, `textures`, `utility` |

The wheel is pure Python and uses the supported universal `any` filename suffix.
The image is a PNG under the Plugin Hub 2 MB limit.

## Release order

1. Test the wheel on the exact compatible OrcaSlicer build.
2. Create or update the listing as private.
3. Install it through Orca Cloud in a clean OrcaSlicer data directory.
4. Verify page creation, model transfer, restart and disable/re-enable lifecycle.
5. Make the listing public only after the complete check passes.

The Plugin Pages API is currently a draft. Do not claim compatibility with a
stable OrcaSlicer release until the capability is included there.
