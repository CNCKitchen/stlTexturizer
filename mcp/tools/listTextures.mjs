import { defineTool } from '../lib/defineTool.mjs';
import { listTextures } from '../lib/textures.mjs';

const tool = defineTool({
  name: 'bumpmesh_list_textures',
  title: 'List built-in textures',
  description:
    'List the 24 built-in displacement-map texture presets bundled with BumpMesh, ' +
    'each with a category, a short description, and its recommended default UV scale. ' +
    'Use a returned `name` as the `texture` parameter of bumpmesh_texturize.',
  inputShape: {},
  annotations: {
    title: 'List built-in textures',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  run: () => {
    const textures = listTextures();
    return { textures, count: textures.length };
  },
});

export const { name, config, handler } = tool;
