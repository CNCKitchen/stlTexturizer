# PWA updates

When you change files that the service worker caches (`index.html`, `style.css`, `js/*`, icons, manifest, etc.):

1. Open `sw.js`
2. Bump `CACHE_VERSION` (e.g. `bumpmesh-v1` → `bumpmesh-v2`)
3. If you added or renamed cached files, update the `PRECACHE` list in `sw.js`
4. Commit, push, and deploy

Users pick up the update on their next visit. The new service worker installs, replaces the old cache, and serves fresh files.