import { z } from 'zod';
import { defineTool } from '../lib/defineTool.mjs';
import { inspectMeshAt } from '../lib/pipeline.mjs';

const tool = defineTool({
  name: 'bumpmesh_inspect_mesh',
  title: 'Inspect a mesh',
  description:
    'Load an STL/OBJ/3MF file and report its triangle count, bounding box, surface area, ' +
    'and basic watertightness (open edges, shell count) without modifying it.',
  inputShape: {
    path: z.string().min(1).describe('Path to the mesh file (.stl, .obj, or .3mf).'),
  },
  annotations: {
    title: 'Inspect a mesh',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  run: (params) => inspectMeshAt(params.path),
});

export const { name, config, handler } = tool;
