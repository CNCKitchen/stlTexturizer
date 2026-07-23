import { z } from 'zod';
import { defineTool } from '../lib/defineTool.mjs';
import { runSubdivide } from '../lib/pipeline.mjs';

const tool = defineTool({
  name: 'bumpmesh_subdivide',
  title: 'Subdivide a mesh',
  description:
    'Adaptively subdivide a mesh so every edge is at most `refineLength` long — the same ' +
    'pre-pass bumpmesh_texturize runs before displacement. Useful on its own to prep a mesh ' +
    'for later fine detail work.',
  inputShape: {
    input: z.string().min(1).describe('Path to the source mesh file (.stl, .obj, or .3mf).'),
    output: z.string().min(1).describe('Path to write the subdivided mesh to.'),
    refineLength: z.number().positive().default(1.0).describe('Maximum edge length in millimeters after subdivision.'),
  },
  annotations: {
    title: 'Subdivide a mesh',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  run: (params) => runSubdivide(params),
});

export const { name, config, handler } = tool;
