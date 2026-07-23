import { z } from 'zod';
import { defineTool } from '../lib/defineTool.mjs';
import { validateMeshAt } from '../lib/pipeline.mjs';

const tool = defineTool({
  name: 'bumpmesh_validate_mesh',
  title: 'Validate a mesh',
  description:
    'Run mesh-quality diagnostics on an STL/OBJ/3MF file: open edges, non-manifold edges, ' +
    'disconnected shells, and degenerate (zero-area) slivers. Use before/after texturizing ' +
    'to confirm the output is watertight and print-ready.',
  inputShape: {
    path: z.string().min(1).describe('Path to the mesh file (.stl, .obj, or .3mf).'),
  },
  annotations: {
    title: 'Validate a mesh',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  run: (params) => validateMeshAt(params.path),
});

export const { name, config, handler } = tool;
