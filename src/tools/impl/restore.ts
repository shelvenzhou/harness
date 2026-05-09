import { z } from 'zod';

import type { Tool } from '../tool.js';

/**
 * `restore` — rehydrate an elided event by handle.
 *
 * The actual rehydration is performed by the context projection layer;
 * here the tool's job is just to emit a tool_result whose payload carries
 * the handle. The AgentRunner then instructs the projection layer to
 * inline the handle's full body on the next sampling.
 *
 * Because this is a runtime-level signal rather than pure data, the
 * handleRegistry lookup + projection override is wired in commit 8 /
 * commit 9; phase 1 ships the schema and a no-op payload.
 */

const RestoreArgs = z.object({
  handle: z.string().describe('Handle id returned in an `elided` block.'),
});

export const restoreTool: Tool<
  typeof RestoreArgs,
  {
    handle: string;
    pinned: boolean;
    note?: string;
  }
> = {
  name: 'restore',
  concurrency: 'safe',
  description: [
    'Rehydrate an elided event by handle. Returns `{handle,pinned}`; when pinned is true, the next sampling will include the full body.',
    "Good for: 'I elided that web_fetch result, I actually need the body now.'",
    'Bad for: \'Pull everything back just in case.\' Unknown handles return `ok:false` with `error.kind:"unknown_handle"`.',
  ].join(' '),
  schema: RestoreArgs,
  async execute(args) {
    return {
      ok: true,
      output: {
        handle: args.handle,
        pinned: true,
        note: 'context projection will inline this handle on the next sampling',
      },
    };
  },
};
