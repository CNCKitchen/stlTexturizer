# Publishing to Orca Cloud Plugin Hub

This integration is intended to be published and maintained by CNC Kitchen.
Do not publish it from a third-party Orca Cloud account without the project
owner's decision.

## Build the upload kit

From this directory run:

```powershell
python build_package.py
```

The command validates plugin metadata and runtime versions, builds the wheel and creates:

```text
dist/release-0.1.2/
  wheels/bumpmesh-0.1.2-py3-none-any.whl
  bumpmesh-0.1.2/
    bumpmesh_plugin.py
    BumpMesh.png
    description.md
    CHANGELOG.md
    LICENSE
    package-metadata.json
    SHA256SUMS
  RELEASE_NOTES.md
  SHA256SUMS
```

## Orca Cloud fields

| Field | Value |
|---|---|
| Plugin file | `bumpmesh-0.1.2-py3-none-any.whl` |
| Plugin image | `BumpMesh.png` |
| Name | `BumpMesh` |
| Description | Contents of `description.md` |
| Version | `0.1.2` |
| Type | Plugin Page, when that type is available in Orca Cloud |
| Tested OrcaSlicer build | Windows 2.5.0-dev build 824b216f, plugin 0.1.2 |
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

Plugin Pages is merged upstream. Record the exact tested build; do not infer
runtime acceptance from packaging checks. The matching web application is bundled in the wheel; validate its asset hash
as well as the Python module. No deployment to bumpmesh.com is required.

The 0.1.2 candidate is unpublished and passed the owner's startup and model
round-trip check on 2026-09-30. The accepted wheel SHA-256 is
`930883fd1f840b079d55ef20b5f6f8a741c4fa033e15b3c3cde6e979277a0f1f`.
The installed runtime was verified against this package. Rebuilding creates a
new artifact that requires its own acceptance. Publication remains a separate
decision and requires CNC Kitchen's agreement.
