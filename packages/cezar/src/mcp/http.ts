/**
 * `/api/v1/mcp` — the `cez mcp` tool set served by the cockpit itself over Streamable HTTP
 * (#1109, stage 2), opt-in with `CEZ_MCP=1` (every tool) or `CEZ_MCP=read-only`.
 *
 * Unchained on purpose: the body is JSON-RPC, not a contract shape, and chaining the route would
 * make `AppType` depend on the tools that are typed BY `AppType`. Tools reach the API in-process
 * through `app.request` — the same handlers, validators and project scoping as over the wire.
 * The SDK and the tool module load on the first request; with the flag off nothing here runs.
 */
import type { Hono } from 'hono';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { createApiClient, readJson, type CezarClient, type CezarFetch } from './api.ts';
import type { McpMode } from './mode.ts';
import { describeProjectChoice, type Cockpit } from './tools.ts';

export const MCP_PATH = '/api/v1/mcp';

/**
 * The cockpit a tool call targets. There is no cwd to pick a project by: reads default to the
 * boot project, and `start_run` without a `projectId` goes ahead only when the cockpit serves that
 * one project — otherwise it refuses, naming the projects to choose from.
 */
export async function inProcessCockpit(api: CezarClient): Promise<Cockpit> {
  try {
    const { projects, bootProject } = await readJson(await api.api.v1.projects.$get());
    const only = projects.length === 1 && projects[0]!.id === bootProject;
    if (only) return { api, defaultProjectId: bootProject };
    return {
      api,
      defaultProjectId: bootProject,
      projectUnknown: `this cockpit serves ${describeProjectChoice(projects)} — pass projectId to say which one the run belongs to`,
    };
  } catch (error) {
    return {
      api,
      defaultProjectId: 'default',
      projectUnknown: `could not read this cockpit's project list (${(error as Error).message}) — pass projectId (list_projects)`,
    };
  }
}

/** A fetch that hands the request to `app` in-process. A `Request` keeps its method, headers and
 *  body; a loopback Host is what the origin guard expects of a local caller (no Origin is sent). */
export function inProcessFetch(app: Pick<Hono, 'request'>): CezarFetch {
  return async (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.set('host', '127.0.0.1');
    return app.request(new Request(input, { ...init, headers }));
  };
}

/** Mount `/api/v1/mcp` (POST; GET and DELETE answer the SDK's 405 in stateless mode). */
export function mountMcp(app: Hono, options: { mode: Exclude<McpMode, 'off'>; version: string }): void {
  let handler: Promise<McpHttpHandler> | undefined;
  const load = async (): Promise<McpHttpHandler> => {
    const [{ createMcpHandler }, { buildMcpServer }] = await Promise.all([
      import('@modelcontextprotocol/server'),
      import('./tools.ts'),
    ]);
    const api = createApiClient({ baseUrl: 'http://127.0.0.1', fetch: inProcessFetch(app) });
    const tools = { cockpit: () => inProcessCockpit(api), version: options.version, readOnly: options.mode === 'read-only' };
    return createMcpHandler(() => buildMcpServer(tools));
  };
  app.on(['POST', 'GET', 'DELETE'], MCP_PATH, async (c) => {
    handler ??= load().catch((error: unknown) => {
      handler = undefined;
      throw error;
    });
    let mcp: McpHttpHandler;
    try {
      mcp = await handler;
    } catch (error) {
      console.error(`[mcp] could not load the MCP server: ${(error as Error).message}`);
      return c.json({ error: 'the MCP server could not be loaded — see the cockpit log' }, 503);
    }
    return mcp.fetch(c.req.raw);
  });
}
