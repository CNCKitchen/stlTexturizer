# stlTexturizer — Personal Fork Changes
## Context Transfer Document

**Branch:** `claude/add-map-storage-GEzcR`
**Base repo:** `ubergeekseven/stlTexturizer` (fork of `CNCKitchen/stlTexturizer`)
**Purpose:** Convert a publicly-hosted static web tool into a personal, self-hosted application with persistent storage and session recovery.

---

## What This Is

BumpMesh / stlTexturizer is a browser-based tool that lets you apply displacement maps (bump/height maps) to STL/OBJ/3MF models before 3D printing. Originally a 100% static site (HTML + ES modules + Three.js) served by nginx with zero backend. All file handling was done in-browser; nothing persisted past a tab close.

---

## Goals / What Was Built

1. **Map library** — Any displacement map image you upload is saved to the server and shown as a persistent thumbnail grid under "My Maps". Build a library over time without re-uploading.
2. **Model library** — Any STL/OBJ/3MF model you upload is saved to the server and shown in a "My Models" list. Recall previous models without re-uploading.
3. **Session persistence** — Work in progress (loaded model + active map + all settings + face mask) is auto-saved to the server every 3 seconds. On next page load a banner offers to restore. Works cross-device since it's server-side.
4. **GitHub link** — Updated from the original `CNCKitchen/stlTexturizer` repo to `ubergeekseven/stltexturizer`.
5. **Docker fix** — The original `compose.yaml` had `context: ./app` pointing to a non-existent directory, breaking all builds. Fixed to `context: .`.

---

## Architecture Change

**Before:** nginx:alpine → serves static files only, no persistence

**After:** node:22-alpine → Express.js serves static files AND provides REST API. All uploaded files stored in `/data/` which is a Docker volume mounted to `./data` on the host.

```
Host ./data/
├── maps/            ← uploaded displacement map image files
├── models/          ← uploaded STL/OBJ/3MF model files
├── maps.json        ← manifest: [{id, name, filename, size, uploadedAt}]
├── models.json      ← manifest: [{id, name, filename, ext, size, uploadedAt}]
└── session.json     ← current session state
```

---

## Files Changed

### New Files
| File | Purpose |
|------|---------|
| `server/server.js` | Express app — static serving + all API routes |
| `server/package.json` | Dependencies: express, multer, uuid |
| `server/package-lock.json` | Lockfile |

### Modified Files
| File | What Changed |
|------|-------------|
| `Dockerfile` | Replaced `nginx:alpine` with `node:22-alpine`; runs Express server |
| `compose.yaml` | Fixed broken `context: ./app` → `context: .`; added `./data:/data` volume; port `8083:3000` |
| `.dockerignore` | Added `node_modules`, `server/node_modules`, `data/` exclusions; removed stale `!nginx.conf` |
| `.gitignore` | Added `!server/package.json` and `!server/package-lock.json` exceptions (root `.gitignore` had a global `package.json` rule that was blocking these from being committed) |
| `index.html` | Added session restore banner, "My Maps" library section, "My Models" library section; updated GitHub link |
| `js/presetTextures.js` | Added `fetchServerMaps`, `uploadMapToServer`, `deleteServerMap`, `loadServerMapAsTexture` API helpers |
| `js/main.js` | Wired up all library/session features (see detail below) |
| `style.css` | Added styles for library sections, model list, session banner |

---

## API Endpoints (`server/server.js`)

```
GET    /api/maps              → list all saved maps [{id, name, size, uploadedAt}]
POST   /api/maps              → upload map image (multipart/form-data, field: 'file')
DELETE /api/maps/:id          → delete a map
GET    /api/maps/:id/file     → stream the map image file

GET    /api/models            → list all saved models
POST   /api/models            → upload model file (multipart/form-data, field: 'file')
DELETE /api/models/:id        → delete a model
GET    /api/models/:id/file   → stream the model file

GET    /api/session           → get saved session JSON (204 if none)
PUT    /api/session           → save session JSON (body: application/json)
DELETE /api/session           → clear saved session
```

File size limits: maps 50 MB, models 500 MB. Files are stored with UUID filenames in `/data/maps/` and `/data/models/`. Manifests at `/data/maps.json` and `/data/models.json`.

---

## Frontend Changes (`js/main.js`)

### New module-level variables
```js
let activeMapServerId   = null;  // id of active server map, null if preset/none
let activeModelServerId = null;  // id of active server model, null if none
```

### New import from `presetTextures.js`
```js
import { ..., fetchServerMaps, uploadMapToServer, deleteServerMap, loadServerMapAsTexture }
  from './presetTextures.js';
```

### Extended: texture upload handler (around line 1268)
After `loadCustomTexture(file)` succeeds, calls `uploadMapToServer(file)` in background, sets `activeMapServerId`, calls `refreshMyMaps()`.

### New: `_saveModelToServer(file)` function
Called from the end of `handleModelFile()` — posts the model file to `/api/models`, sets `activeModelServerId`, calls `refreshMyModels()`.

### New: `_autoSaveSession()` function
3-second debounced function. Calls `PUT /api/session` with:
```json
{
  "version": 1,
  "...PERSISTED_KEYS settings...",
  "activeModelServerId": "uuid-or-null",
  "activeMapServerId": "uuid-or-null",
  "mask": { "selectionMode": bool, "excluded": [...indices] },
  "timestamp": "ISO8601"
}
```
Triggered by the same settings panel `input`/`change` events as `_autoSaveSettings`, plus `lockScaleBtn` click.

### New: Session restore IIFE
Runs on page load. Calls `GET /api/session`. If a session exists and is less than 30 days old, shows the restore banner. On "Restore": loads the model from `/api/models/:id/file`, applies settings via existing `applySettingsSnapshot()`, loads the map from `/api/maps/:id/file` via `loadServerMapAsTexture()`, restores the mask via existing `_restoreMask()`. On "Dismiss": calls `DELETE /api/session`.

### New: `refreshMyMaps()` / `_loadServerMap(entry)`
Fetches `/api/maps`, builds a 6-column thumbnail grid matching the style of the preset grid. Each tile has a `×` delete button visible on hover. Clicking a tile loads it as the active map using `loadServerMapAsTexture()`.

### New: `refreshMyModels()`
Fetches `/api/models`, builds a list (newest first). Each row: name, date, Load button, `×` delete button. Load button fetches the file and calls `handleModelFile()`.

---

## HTML Changes (`index.html`)

### Session restore banner (top of settings panel)
```html
<div id="session-restore-banner" style="display:none">
  <span class="restore-msg">Restore previous session?</span>
  <button class="restore-yes" id="session-restore-yes">Restore</button>
  <button class="restore-no" id="session-restore-no">Dismiss</button>
</div>
```

### My Maps section (inside Displacement Map panel, replaces standalone upload button)
```html
<div class="library-header">
  <span>My Maps</span>
  <label class="upload-btn" for="texture-file-input">Upload</label>
</div>
<div id="my-maps-grid" class="my-maps-grid"><!-- populated by JS --></div>
<input type="file" id="texture-file-input" accept="image/*" hidden />
```

### My Models section (inside Load STL panel)
```html
<div class="library-header"><span>My Models</span></div>
<div id="my-models-list" class="model-list"><!-- populated by JS --></div>
```

---

## Deployment

```bash
# First time or after any change
cd /opt/stacks/stltexturizer
git pull origin claude/add-map-storage-GEzcR
docker compose down
docker compose up --build --no-cache

# Verify files are inside the container
docker exec stltexturizer ls /app/js/
# Should show: viewer.js, stlLoader.js, main.js, etc.

# View logs
docker logs stltexturizer
```

The `./data/` directory is created automatically by the server on first start. It persists as a bind mount — deleting the container does not delete your library or session.

---

## Known Issues / Current Status

- **404s for `viewer.js`, `stlLoader.js` etc.** — Root cause: the original `compose.yaml` had `context: ./app` (non-existent directory), so an old cached nginx image with an incomplete file set was running. Fix: `docker compose down && docker compose up --build --no-cache`. After the clean rebuild the Node.js server correctly serves all files from `/app/`.
- **`server/package.json` was not committed** — The root `.gitignore` had a global `package.json` exclusion. Fixed by adding `!server/package.json` and `!server/package-lock.json` exceptions to `.gitignore`. Both files are now committed.
- **Cloudflare Rocket Loader** — If using Cloudflare, disable Rocket Loader (Speed → Optimization → Rocket Loader → Off). It rewrites script tags and can interfere with ES module import chains. Email Obfuscation can also be disabled as it's not needed for a personal tool.
- **Authentik not yet configured** — The app is exposed through Cloudflare but not yet behind Authentik authentication.

---

## Reused Existing Functions

These existing functions in `js/main.js` were reused without modification:

| Function | Location | Used for |
|----------|----------|----------|
| `loadCustomTexture(file)` | `presetTextures.js:114` | Loading server maps as textures |
| `handleModelFile(file)` | `main.js:~2834` | Loading models from library |
| `applySettingsSnapshot(snap)` | `main.js:5012` | Session restore |
| `getSettingsSnapshot()` | `main.js:4991` | Session save |
| `_collectCurrentMask()` | `main.js:5357` | Serializing face mask for session |
| `_restoreMask(mask)` | `main.js:5375` | Restoring face mask on session restore |
| `PERSISTED_KEYS` | `main.js:4977` | Settings keys included in session payload |
| `_showCustomMapThumb()` | `main.js` | Showing the active map thumbnail |

---

## Commit History (this branch)

```
d20c767  Fix Docker build: exclude node_modules from context, simplify Dockerfile
5d4e899  Fix missing server/package.json by adding gitignore exception
5ea73b9  Add persistent map/model library and session restore via Node.js backend
```
