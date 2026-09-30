# BumpMesh OrcaSlicer plugin — changelog

Newest first. The top entry is the text used for the corresponding Orca Cloud
Plugin Hub release.

## 0.1.2

- Fixed the long pause when enabling BumpMesh by reducing the time Python
  needs to load the bundled application.
- Preserved the BumpMesh 1.3.7 interface and the model transfer workflow
  tested in version 0.1.1.

## 0.1.1

- Updated the bundled application to BumpMesh 1.3.7, including the sidebar
  texture gallery, new textures, texture inversion and streaming 3MF export.
- Included the new background worker for the 3D displacement preview.
- Fixed startup permission requests caused by the embedded interface loader.
- Included the matching BumpMesh application in the installable package.
- Fixed language switching and corrupted labels in restricted embedded browsers.
- Restored background export and checked STL and 3MF output.
- Retained Windows model return, with the original object preserved. Final
  acceptance of this workflow in the target OrcaSlicer build is pending.
- Updated the Plugin Hub description and CNC Kitchen attribution.

## 0.1.0

- Load the bundled interface through the Pages message API, without a Python HTTP server or runtime ZIP extraction.
- Avoid the startup socket request and lazy cp437 bytecode writes outside plugin storage.

- Added a self-contained Python installer artifact, including the web runtime.
- Show startup failures in the page instead of leaving an empty tab.

- Bundled the matching BumpMesh web application so installation includes all integration controls.
- Fixed corrupted fallback labels and preserved language switching with WebView storage blocked.

- Added return of processed STL models to the current OrcaSlicer window on Windows, preserving the original object.
- Added bounded chunk transfers and validation before opening returned geometry.
- Updated the matching web integration to BumpMesh 1.3.1 and upstream export memory improvements.

- Added a full-size BumpMesh Plugin Page with the official BumpMesh icon.
- Added direct transfer of printable OrcaSlicer model geometry into BumpMesh.
- Preserved object and volume transforms, including mirrored geometry.
- Added OrcaSlicer language and initial theme integration.
- Made the embedded application tolerate unavailable persistent WebView storage.
