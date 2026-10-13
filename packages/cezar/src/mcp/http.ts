/**
 * SPIKE — Streamable HTTP endpoint `/api/v1/mcp`, opt-in with `CEZ_MCP=1`.
 *
 * Built only to check real MCP clients against the HTTP transport; not the shape to ship. What a
 * real version still needs: a BACKWARD_COMPATIBILITY.md §2 entry, `mcp` in `capabilities`, the
 * Origin rule for every method on this path, `.env.example` + docs/reference.md.
 *
 * The endpoint sits under `/api/*`, so the cockpit's own Host/Origin guard runs before it. It is
 * registered as a plain (unchained) route: the body is JSON-RPC, not a contract shape, and chaining
 * it would make `AppType` depend on the tools that are typed BY `AppType`.
 *
 * Tools reach the API in-process through `app.request` — the same handlers, validators and
 * project scoping as over the wire, with no socket and no second copy of run state.
 */
import type { Hono } from 'hono';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { createApiClient } from './api.ts';

export const MCP_PATH = '/api/v1/mcp';

export function mcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_MCP === '1';
}

/** Mount `POST /api/v1/mcp`. The SDK (and the tool module) load on the first request, so a cockpit with the flag on pays nothing at boot. */
export function mountMcp(app: Hono, options: { version: string; defaultProjectId?: string }): void {
  let handler: Promise<McpHttpHandler> | undefined;
  const load = async (): Promise<McpHttpHandler> => {
    const [{ createMcpHandler }, { buildMcpServer }] = await Promise.all([
      import('@modelcontextprotocol/server'),
      import('./tools.ts'),
    ]);
    const client = createApiClient({
      baseUrl: 'http://127.0.0.1',
      // In-process: the loopback Host is what the origin guard expects of a local caller.
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('host', '127.0.0.1');
        return app.request(input instanceof Request ? input.url : String(input), { ...init, headers });
      },
    });
    const api = async () => client;
    const debug = process.env.CEZ_MCP_DEBUG === '1';
    return createMcpHandler((ctx) => {
      if (debug) {
        const h = ctx.requestInfo?.headers;
        console.error(`[mcp-http] era=${ctx.era} version=${h?.get('mcp-protocol-version') ?? '-'} method=${h?.get('mcp-method') ?? '-'} ua=${h?.get('user-agent') ?? '-'}`);
      }
      return buildMcpServer({ api, defaultProjectId: options.defaultProjectId ?? 'default', version: options.version });
    });
  };
  app.on(['POST', 'GET', 'DELETE'], MCP_PATH, async (c) => {
    handler ??= load();
    return (await handler).fetch(c.req.raw);
  });
}
