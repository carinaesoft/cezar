import { afterEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createApiClient, type CezarFetch } from './api.ts';
import { buildMcpServer, WAIT_MAX_SECONDS } from './tools.ts';

/** The MCP tool set over a stubbed cockpit: what is pinned is the route each tool calls, how it
 *  shapes the answer, and the annotations a client decides auto-approval from. */

type Reply = { status?: number; body?: unknown; sse?: string[] };
type Routes = Record<string, Reply | ((url: URL, init?: RequestInit) => Reply)>;

function stubFetch(routes: Routes, calls: Array<{ method: string; url: URL; body?: unknown }> = []): CezarFetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    const reply = typeof route === 'function' ? route(url, init) : route;
    if (reply.sse) {
      const frames = reply.sse;
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
          // like the real stream: never ends on its own, only when the caller disconnects
          signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function connect(routes: Routes, opts: { readOnly?: boolean; calls?: Array<{ method: string; url: URL; body?: unknown }> } = {}) {
  const client = createApiClient({ baseUrl: 'http://127.0.0.1:4321', fetch: stubFetch(routes, opts.calls) });
  const server = buildMcpServer({ api: async () => client, defaultProjectId: 'default', version: '0.0.0-test', ...(opts.readOnly ? { readOnly: true } : {}) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await mcp.connect(clientSide);
  clients.push(mcp);
  return mcp;
}

const textOf = (result: { content?: unknown }) =>
  ((result.content as Array<{ type: string; text?: string }> | undefined) ?? []).map((c) => c.text ?? '').join('');

describe('cezar MCP tools', () => {
  it('every tool states readOnlyHint explicitly, and every writing tool states destructiveHint', async () => {
    const mcp = await connect({});
    const { tools } = await mcp.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(11);
    for (const tool of tools) {
      expect(typeof tool.annotations?.readOnlyHint, `${tool.name}.readOnlyHint`).toBe('boolean');
      if (tool.annotations?.readOnlyHint === false) {
        expect(typeof tool.annotations.destructiveHint, `${tool.name}.destructiveHint`).toBe('boolean');
      }
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(byName.cancel_run?.destructiveHint).toBe(true);
    expect(byName.start_run?.readOnlyHint).toBe(false);
    expect(byName.list_runs?.readOnlyHint).toBe(true);
  });

  it('read-only mode does not register the write tools at all', async () => {
    const mcp = await connect({}, { readOnly: true });
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('start_run');
    expect(names).not.toContain('cancel_run');
    expect(names.every((n) => ['list_projects', 'list_workflows', 'list_models', 'list_runs', 'get_run', 'get_run_status', 'list_run_events', 'wait_for_runs', 'get_pr_status'].includes(n))).toBe(true);
  });

  it('list_projects reads the workspace registry', async () => {
    const mcp = await connect({
      'GET /api/v1/projects': {
        body: { bootProject: 'p1', projectsDir: '/x', projects: [{ id: 'p1', name: 'app', root: '/r/app', status: 'ok', branch: 'main', addedAt: '', lastOpenedAt: '', source: 'local' }] },
      },
    });
    const result = await mcp.callTool({ name: 'list_projects', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      bootProject: 'p1',
      projects: [{ id: 'p1', name: 'app', root: '/r/app', status: 'ok', branch: 'main' }],
    });
  });

  it('list_runs filters the cross-project index and caps the rows', async () => {
    const run = (id: string, projectId: string, status: string, createdAt: string, archived = false) => ({
      id, projectId, status, createdAt, archived, title: `t-${id}`, workflow: 'quick-task',
    });
    const mcp = await connect({
      'GET /api/v1/workspace/runs-index': {
        body: {
          runs: [run('a', 'p1', 'done', '2026-09-01'), run('b', 'p1', 'running', '2026-09-03'), run('c', 'p2', 'running', '2026-09-02'), run('d', 'p1', 'running', '2026-09-04', true)],
          truncated: [],
          referenceStatuses: {},
        },
      },
    });
    const result = await mcp.callTool({ name: 'list_runs', arguments: { status: ['running'], limit: 1 } });
    const body = result.structuredContent as { runs: Array<{ id: string }>; total: number; more?: number };
    expect(body.runs.map((r) => r.id)).toEqual(['b']);
    expect(body.total).toBe(2);
    expect(body.more).toBe(1);
  });

  it('project-scoped tools hit the /p/:projectId spelling, defaulting to the configured project', async () => {
    const calls: Array<{ method: string; url: URL }> = [];
    const mcp = await connect(
      {
        'GET /api/v1/p/default/runs/r1': { body: { id: 'r1', status: 'running', title: 'x', task: 'long task', steps: [] } },
        'GET /api/v1/p/other/runs/r1': { body: { id: 'r1', status: 'done', title: 'x', steps: [] } },
      },
      { calls },
    );
    const a = await mcp.callTool({ name: 'get_run_status', arguments: { runId: 'r1' } });
    const b = await mcp.callTool({ name: 'get_run_status', arguments: { runId: 'r1', projectId: 'other' } });
    expect(a.structuredContent).toEqual({ id: 'r1', status: 'running', title: 'x' });
    expect((b.structuredContent as { status: string }).status).toBe('done');
    expect(calls.map((c) => c.url.pathname)).toEqual(['/api/v1/p/default/runs/r1', '/api/v1/p/other/runs/r1']);
  });

  it('a refusal from the cockpit is a readable tool error, not a protocol error', async () => {
    const mcp = await connect({});
    const result = await mcp.callTool({ name: 'get_run', arguments: { runId: 'missing' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('cezar refused: 404: not found');
  });

  it('an unreachable cockpit is a readable tool error', async () => {
    const server = buildMcpServer({
      api: async () => {
        throw new Error('no cezar cockpit found on 127.0.0.1:4321-4370');
      },
      defaultProjectId: 'default',
      version: '0',
    });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const mcp = new Client({ name: 't', version: '0' });
    await mcp.connect(c);
    clients.push(mcp);
    const result = await mcp.callTool({ name: 'list_projects', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('no cezar cockpit found');
  });

  it('start_run posts a workflow run and answers with the compact record', async () => {
    const calls: Array<{ method: string; url: URL; body?: unknown }> = [];
    const mcp = await connect(
      { 'POST /api/v1/p/default/runs': { status: 201, body: { id: 'r9', status: 'queued', title: 'Fix', workflow: 'quick-task', steps: [], task: 'Fix it' } } },
      { calls },
    );
    const result = await mcp.callTool({ name: 'start_run', arguments: { workflow: 'quick-task', task: 'Fix it', runner: 'codex' } });
    expect(result.structuredContent).toEqual({ id: 'r9', status: 'queued', title: 'Fix', workflow: 'quick-task' });
    expect(calls[0]?.body).toEqual({ workflow: 'quick-task', task: 'Fix it', runner: 'codex' });
  });

  it('start_run validates its input before anything reaches the cockpit', async () => {
    const calls: Array<{ method: string; url: URL }> = [];
    const mcp = await connect({}, { calls });
    const result = await mcp.callTool({ name: 'start_run', arguments: { workflow: 'quick-task', task: '' } });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('wait_for_runs returns as soon as a run settles, reading the SSE run frames', async () => {
    const frame = (status: string) => `event: run\ndata: ${JSON.stringify({ id: 'r1', status })}\n\n`;
    const mcp = await connect({
      'GET /api/v1/p/default/runs/r1/events': { sse: [': hi\n\n', frame('running'), 'event: ping\ndata: \n\n', frame('review')] },
      'GET /api/v1/p/default/runs/r2/events': { sse: [frame('running')] },
    });
    const started = Date.now();
    const result = await mcp.callTool({ name: 'wait_for_runs', arguments: { runIds: ['r1', 'r2'], timeoutSeconds: 10 } });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.structuredContent).toEqual({
      runs: [
        { id: 'r1', status: 'review' },
        { id: 'r2', status: 'running' },
      ],
      timedOut: false,
    });
  });

  it('wait_for_runs gives up at its timeout and says so', async () => {
    const mcp = await connect({
      'GET /api/v1/p/default/runs/r1/events': { sse: [`event: run\ndata: ${JSON.stringify({ status: 'running' })}\n\n`] },
    });
    const result = await mcp.callTool({ name: 'wait_for_runs', arguments: { runIds: ['r1'], timeoutSeconds: 1 } });
    expect(result.structuredContent).toEqual({ runs: [{ id: 'r1', status: 'running' }], timedOut: true });
  });

  it('wait_for_runs refuses a timeout past the client-safe ceiling', async () => {
    const mcp = await connect({});
    const result = await mcp.callTool({ name: 'wait_for_runs', arguments: { runIds: ['r1'], timeoutSeconds: WAIT_MAX_SECONDS + 1 } });
    expect(result.isError).toBe(true);
  });

  it('serves the 2026-07-28 era over Streamable HTTP from the same factory', async () => {
    const client = createApiClient({
      baseUrl: 'http://127.0.0.1:4321',
      fetch: stubFetch({ 'GET /api/v1/projects': { body: { bootProject: 'p', projectsDir: '/', projects: [] } } }),
    });
    const handler = createMcpHandler(() => buildMcpServer({ api: async () => client, defaultProjectId: 'default', version: '0' }));
    const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:4321/api/v1/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    const mcp = new Client({ name: 't', version: '0' }, { versionNegotiation: { mode: 'auto' } });
    await mcp.connect(transport);
    clients.push(mcp);
    expect(mcp.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    const result = await mcp.callTool({ name: 'list_projects', arguments: {} });
    expect(result.structuredContent).toEqual({ bootProject: 'p', projects: [] });
    await handler.close();
  });
});
