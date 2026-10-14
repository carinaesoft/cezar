/**
 * `CEZ_MCP` — whether the cockpit serves `/api/v1/mcp` (#1109, stage 2), and with which tools.
 * Strict like the other opt-ins: `1` and `read-only` are the only spellings that turn it on.
 * Kept apart from `http.ts` so `capabilities.ts` can read the mode without any MCP code.
 */
import type { Capabilities } from '@open-mercato/cezar-contract';

export type McpMode = Capabilities['mcp'];

export function mcpMode(env: NodeJS.ProcessEnv = process.env): McpMode {
  if (env.CEZ_MCP === '1') return 'full';
  if (env.CEZ_MCP === 'read-only') return 'read-only';
  return 'off';
}
