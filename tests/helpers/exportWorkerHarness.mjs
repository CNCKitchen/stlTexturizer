/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { parentPort } from 'node:worker_threads';
// Only adapt transport. The production worker and its real imports run intact.
globalThis.self = { postMessage: (message, transfers) => parentPort.postMessage(message, transfers) };
parentPort.on('message', data => self.onmessage({data}));
await import('../../js/exportWorker.js');
