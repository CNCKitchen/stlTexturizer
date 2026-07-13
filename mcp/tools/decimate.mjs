import { z } from 'zod';
import { defineTool } from '../lib/defineTool.mjs';
import { runDecimate } from '../lib/pipeline.mjs';

const tool = defineTool({
  name: 'bumpmesh_decimate',
  title: 'Decimate a mesh',
  description:
    'Reduce a mesh to (approximately) a target triangle count using quadric-error-metric ' +
    '(QEM) decimation with hole/spike/non-manifold safety guards — the same decimator ' +
    'bumpmesh_texturize uses after displacement.',
  inputShape: {
    input: z.string().min(1).describe('Path to the source mesh file (.stl, .obj, or .3mf).'),
    output: z.string().min(1).describe('Path to write the decimated mesh to.'),
    targetTriangles: z.number().int().positive().describe('Desired output triangle count.'),
  },
  annotations: {
    title: 'Decimate a mesh',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  run: (params) => runDecimate(params),
});

export const { name, config, handler } = tool;
