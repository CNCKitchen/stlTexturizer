#!/usr/bin/env node
/**
 * server.mjs — BumpMesh MCP server entry point (stdio transport).
 *
 * Exposes the real BumpMesh headless mesh-texturizing pipeline (js/*.js,
 * imported directly so this server never drifts from upstream) as MCP tools.
 *
 * IMPORTANT: stdio is the transport, so stdout is reserved for the MCP
 * protocol. All diagnostic/log output MUST go to stderr — never console.log.
 */

import './lib/bootstrap.mjs'; // installs globalThis.DOMParser before any js/ module runs

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import * as listTextures from './tools/listTextures.mjs';
import * as inspectMesh from './tools/inspectMesh.mjs';
import * as texturize from './tools/texturize.mjs';
import * as subdivide from './tools/subdivide.mjs';
import * as decimate from './tools/decimate.mjs';
import * as validateMesh from './tools/validateMesh.mjs';
import * as placeOnBed from './tools/placeOnBed.mjs';

const TOOLS = [listTextures, inspectMesh, texturize, subdivide, decimate, validateMesh, placeOnBed];

const server = new McpServer(
  { name: 'bumpmesh-mcp-server', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

for (const tool of TOOLS) {
  server.registerTool(tool.name, tool.config, tool.handler);
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[bumpmesh-mcp] server started (stdio), tools:', TOOLS.map((t) => t.name).join(', '));
}

main().catch((err) => {
  console.error('[bumpmesh-mcp] fatal error:', err);
  process.exit(1);
});
