import { z } from 'zod';
import { defineTool } from '../lib/defineTool.mjs';
import { runTexturize } from '../lib/pipeline.mjs';
import { validTextureNames } from '../lib/textures.mjs';

const PROJECTIONS = ['triplanar', 'cubic', 'cylindrical', 'spherical', 'planar_xy', 'planar_xz', 'planar_yz'];

const tool = defineTool({
  name: 'bumpmesh_texturize',
  title: 'Texturize a mesh',
  description:
    'Apply a displacement texture to an STL/OBJ/3MF mesh: adaptive subdivision, UV-projected ' +
    'bump displacement, decimation back to a triangle budget, and a watertight repair pass. ' +
    'Writes the textured mesh to `output` as STL or 3MF. Provide EXACTLY ONE texture source: ' +
    'either `texture` (a built-in preset name — see bumpmesh_list_textures — or an image path) ' +
    'OR `customImagePath` (an explicit PNG/JPG path).',
  inputShape: {
    input: z.string().min(1).describe('Path to the source mesh file (.stl, .obj, or .3mf).'),
    output: z.string().min(1).describe('Path to write the textured mesh to.'),
    texture: z
      .string()
      .min(1)
      .optional()
      .describe(
        `Built-in preset name (case-insensitive) or an image file path. ` +
          `Presets: ${validTextureNames().join(', ')}. ` +
          `Provide this OR customImagePath, not both.`
      ),
    customImagePath: z
      .string()
      .min(1)
      .optional()
      .describe('Explicit path to a custom PNG/JPG displacement image. Provide this OR texture, not both.'),
    projection: z.enum(PROJECTIONS).default('triplanar').describe('UV projection mode.'),
    scaleU: z.number().positive().default(0.5).describe('Texture tiling scale along U.'),
    scaleV: z.number().positive().default(0.5).describe('Texture tiling scale along V.'),
    offsetU: z.number().default(0).describe('Texture UV offset along U (0..1).'),
    offsetV: z.number().default(0).describe('Texture UV offset along V (0..1).'),
    rotation: z.number().default(0).describe('Texture rotation in degrees.'),
    amplitude: z
      .number()
      .default(0.5)
      .describe(
        'Displacement height in millimeters (matches the app\'s "amplitude"/"texture height" ' +
          'slider, mm — NOT a 0..1 fraction). Negative inverts the bump direction.'
      ),
    symmetric: z
      .boolean()
      .default(false)
      .describe('Center displacement around the original surface (bumps in and out) instead of purely outward.'),
    maskTopAngle: z
      .number()
      .min(0)
      .default(0)
      .describe('Degrees from horizontal; upward-facing faces within this angle are excluded from displacement.'),
    maskBottomAngle: z
      .number()
      .min(0)
      .default(5)
      .describe('Degrees from horizontal; downward (bed-facing) faces within this angle are excluded from displacement.'),
    refineLength: z
      .number()
      .positive()
      .default(1.0)
      .describe('Target subdivided edge length in millimeters (smaller = finer texture detail, more triangles).'),
    decimateTo: z
      .number()
      .int()
      .positive()
      .default(750000)
      .describe('Target triangle count for post-displacement decimation.'),
    textureSmoothing: z
      .number()
      .min(0)
      .default(0)
      .describe('Blur radius (px) applied to the displacement map before sampling. 0 = off.'),
    format: z
      .enum(['stl', '3mf'])
      .optional()
      .describe('Output format; inferred from the `output` file extension when omitted.'),
  },
  annotations: {
    title: 'Texturize a mesh',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  run: (params) => runTexturize(params),
});

export const { name, config, handler } = tool;
