import { z } from 'zod';
import { defineTool } from '../lib/defineTool.mjs';
import { runPlaceOnBed } from '../lib/pipeline.mjs';

const tool = defineTool({
  name: 'bumpmesh_place_on_bed',
  title: 'Place a mesh on the print bed',
  description:
    'Reorient a mesh so a chosen face sits flat on the print bed (Z=0). `face: "auto"` picks ' +
    'the largest flat facet (best print stability); `"lowest"` keeps whichever face is already ' +
    'closest to the bed; a numeric triangle index orients that specific face down.',
  inputShape: {
    input: z.string().min(1).describe('Path to the source mesh file (.stl, .obj, or .3mf).'),
    output: z.string().min(1).describe('Path to write the reoriented mesh to.'),
    face: z
      .union([z.enum(['auto', 'lowest']), z.number().int().nonnegative()])
      .default('auto')
      .describe('"auto" (largest flat face), "lowest" (already-lowest face), or a 0-based triangle index.'),
  },
  annotations: {
    title: 'Place a mesh on the print bed',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  run: (params) => runPlaceOnBed(params),
});

export const { name, config, handler } = tool;
