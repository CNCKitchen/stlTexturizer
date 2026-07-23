/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Single source of truth for the application version, shown in the header and
// logged on startup. Keep in sync with package.json when cutting a release.
// Not to be confused with PROJECT_VERSION in main.js, which versions the
// .bumpmesh project file format independently.
export const APP_VERSION = '1.1.0';
