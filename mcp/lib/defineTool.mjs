/**
 * defineTool.mjs — DRY factory for MCP tools.
 *
 * Every tool shares the same contract:
 *   - inputs validated against a STRICT zod object (unknown/misspelled params
 *     are rejected with an actionable message, never silently dropped),
 *   - the success payload wrapped in the MCP { content, structuredContent }
 *     envelope,
 *   - thrown errors converted to { isError:true, content:[...] }.
 *
 * Strictness is enforced in two places that must agree:
 *   1. `config.inputSchema` is the strict ZodObject itself, so the MCP SDK
 *      rejects unknown keys at the protocol layer (McpError InvalidParams)
 *      before the handler runs, and still emits a full JSON-Schema listing
 *      (with all `.describe()` text) for clients.
 *   2. `handler` re-validates against the same strict schema, so calling the
 *      handler DIRECTLY (as the tests do, bypassing the SDK) yields identical
 *      unknown-key rejection.
 */

import { z } from 'zod';

function errorResult(message) {
  return { isError: true, content: [{ type: 'text', text: `Error: ${message}` }] };
}

function formatZodError(error, allowedKeys) {
  const issues = error.issues || [];
  const unknown = issues.find((i) => i.code === 'unrecognized_keys');
  if (unknown) {
    return (
      `unknown parameter${unknown.keys.length > 1 ? 's' : ''}: ${unknown.keys.join(', ')}. ` +
      `Allowed parameters: ${allowedKeys.join(', ')}.`
    );
  }
  return issues
    .map((i) => `${i.path.length ? i.path.join('.') : '(input)'}: ${i.message}`)
    .join('; ');
}

/**
 * @param {object} def
 * @param {string} def.name                  snake_case tool name (bumpmesh_*)
 * @param {string} def.title                 human-readable title
 * @param {string} def.description           tool description for the model
 * @param {object} [def.inputShape]          zod raw shape ({ key: z.string()... })
 * @param {object} def.annotations           MCP tool annotations
 * @param {(params:object)=>Promise<object>|object} def.run
 *        Business logic. Receives validated params; returns the plain output
 *        object (wrapped into the envelope) or throws an Error (→ isError).
 * @returns {{name, config, handler}}
 */
export function defineTool({ name, title, description, inputShape = {}, annotations, run }) {
  const schema = z.object(inputShape).strict();
  const allowedKeys = Object.keys(inputShape);

  async function handler(args = {}) {
    const parsed = schema.safeParse(args ?? {});
    if (!parsed.success) {
      return errorResult(formatZodError(parsed.error, allowedKeys));
    }
    try {
      const out = await run(parsed.data);
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
    } catch (err) {
      return errorResult(err.message);
    }
  }

  return {
    name,
    config: {
      title,
      description,
      inputSchema: schema,
      annotations,
    },
    handler,
  };
}
