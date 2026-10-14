import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { RunStore } from '../runs/store.ts';
import { createApp } from '../server/server.ts';
import type { RunManager } from '../workflows/run.ts';
import { inProcessFetch, MCP_PATH } from './http.ts';
import { mcpMode } from './mode.ts';

/**
 * `/api/v1/mcp` (#1109, stage 2): the real app, a real SDK client over Streamable HTTP, the
 * request handed to `app.request` instead of a socket. What is pinned is the opt-in, the guard
 * on every method of the path, the project rule without a cwd, and `wait_for_runs` keeping its
 * own deadline over HTTP.
 */
const URL_ = 'http://127.0.0.1:4321';
const READ_TOOLS = ['get_pr_status', 'get_run', 'get_run_status', 'list_models', 'list_projects', 'list_run_events', 'list_runs', 'list_workflows', 'wait_for_runs'];

describe('/api/v1/mcp', () => {
  const saved = { mcp: process.env.CEZ_MCP, dryRun: process.env.CEZ_DRY_RUN, home: process.env.CEZ_HOME };
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
    for (const [key, value] of [['CEZ_MCP', saved.mcp], ['CEZ_DRY_RUN', saved.dryRun], ['CEZ_HOME', saved.home]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function boot(mode: string | undefined) {
    if (mode === undefined) delete process.env.CEZ_MCP;
    else process.env.CEZ_MCP = mode;
    process.env.CEZ_DRY_RUN = '1';
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-mcp-http-home-'));
    process.env.CEZ_HOME = home;
    const repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-mcp-http-repo-'));
    const store = RunStore.open(join(repoRoot, '.ai/cezar'));
    const cancelled: string[] = [];
    const manager = {
      startRun: (workflow: { name: string }, input: { task: string }) =>
        store.createRun({ title: input.task, workflow: workflow.name, task: input.task, steps: [] }),
      cancel: (id: string) => {
        cancelled.push(id);
        return true;
      },
    } as unknown as RunManager;
    const app = createApp({ repoRoot, store, manager, version: '0.0.0-test' });
    cleanup.push(() => {
      store.flush();
      for (const dir of [repoRoot, home]) rmSync(dir, { recursive: true, force: true });
    });
    /** A request as a non-browser MCP client sends it: loopback Host, no Origin. */
    const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
      if (!headers.has('host')) headers.set('host', '127.0.0.1:4321');
      return app.request(new Request(input, { ...init, headers }));
    };
    const connect = async (era: 'legacy' | 'auto') => {
      const client = new Client({ name: 'http-test', version: '0' }, { versionNegotiation: { mode: era } });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${URL_}${MCP_PATH}`), { fetch: request }));
      cleanup.push(() => client.close());
      return client;
    };
    return { app, store, cancelled, request, connect };
  }

  const text = (result: { content?: unknown }) => (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('');
  const health = async (request: ReturnType<typeof boot>['request']) =>
    ((await (await request(`${URL_}/api/v1/health`)).json()) as { capabilities: { mcp: string } }).capabilities.mcp;

  it.each([
    [undefined, 'off'],
    ['1', 'full'],
    ['read-only', 'read-only'],
    ['true', 'off'],
    ['0', 'off'],
    ['READ-ONLY', 'off'],
    ['', 'off'],
  ])('CEZ_MCP=%s is %s', (value, mode) => {
    expect(mcpMode(value === undefined ? {} : { CEZ_MCP: value })).toBe(mode);
  });

  it('off: the route does not exist, and /health says so', async () => {
    const { app, request } = boot(undefined);
    expect(app.routes.some((r) => r.path === MCP_PATH)).toBe(false);
    for (const method of ['POST', 'GET', 'DELETE']) {
      const res = await request(`${URL_}${MCP_PATH}`, { method, ...(method === 'POST' ? { body: '{}', headers: { 'content-type': 'application/json' } } : {}) });
      expect(res.status, method).toBe(404);
    }
    expect(await health(request)).toBe('off');
  });

  it.each([
    ['2025 (initialize: Codex, OpenCode)', 'legacy' as const, /^2025-/],
    ['2026-07-28 (Claude Code)', 'auto' as const, /^2026-07-28$/],
  ])('full: serves the %s era with every tool, in-process', async (_, era, version) => {
    const { request, connect, cancelled } = boot('1');
    expect(await health(request)).toBe('full');
    const client = await connect(era);
    expect(client.getNegotiatedProtocolVersion()).toMatch(version);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS, 'cancel_run', 'start_run'].sort());

    const projects = await client.callTool({ name: 'list_projects', arguments: {} });
    expect(projects.isError, text(projects)).toBeFalsy();
    const { projects: list, bootProject } = projects.structuredContent as { projects: Array<{ id: string }>; bootProject: string };
    expect(list.map((p) => p.id)).toEqual([bootProject]);

    // One project: start_run needs no projectId.
    const started = await client.callTool({ name: 'start_run', arguments: { workflow: 'quick-task', task: 'hello' } });
    expect(started.isError, text(started)).toBeFalsy();
    const run = started.structuredContent as { id: string; projectId: string };
    expect(run.projectId).toBe(bootProject);
    const status = await client.callTool({ name: 'get_run_status', arguments: { runId: run.id, projectId: bootProject } });
    expect(status.structuredContent).toMatchObject({ id: run.id });
    const cancel = await client.callTool({ name: 'cancel_run', arguments: { runId: run.id } });
    expect(cancel.structuredContent).toEqual({ cancelled: true });
    expect(cancelled).toEqual([run.id]);
  });

  it('read-only: the write tools are not registered at all', async () => {
    const { request, connect } = boot('read-only');
    expect(await health(request)).toBe('read-only');
    for (const era of ['legacy', 'auto'] as const) {
      const client = await connect(era);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort(), era).toEqual(READ_TOOLS);
      await expect(client.callTool({ name: 'start_run', arguments: { workflow: 'quick-task', task: 'x' } })).rejects.toThrow(/start_run not found/);
    }
  });

  it('start_run without projectId refuses when the cockpit serves several projects, naming them', async () => {
    const { request, connect } = boot('1');
    const other = mkdtempSync(join(realpathSync(tmpdir()), 'cez-mcp-http-other-'));
    cleanup.push(() => rmSync(other, { recursive: true, force: true }));
    const added = await request(`${URL_}/api/v1/projects`, { method: 'POST', body: JSON.stringify({ root: other }), headers: { 'content-type': 'application/json' } });
    expect(added.status, await added.clone().text()).toBeLessThan(300);
    const client = await connect('auto');
    const result = await client.callTool({ name: 'start_run', arguments: { workflow: 'quick-task', task: 'hello' } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^this cockpit serves \d+ projects? \(.+\) — pass projectId/);
    // reads still go to the boot project
    const runs = await client.callTool({ name: 'list_workflows', arguments: {} });
    expect(runs.isError, text(runs)).toBeFalsy();
  });

  it('the in-process fetch keeps a Request\'s method, headers and body', async () => {
    const echo = new Hono().all('/echo', async (c) =>
      c.json({ method: c.req.method, host: c.req.header('host'), name: c.req.header('x-name'), body: await c.req.text() }),
    );
    const fetchIn = inProcessFetch(echo);
    const asRequest = await fetchIn(
      new Request('http://127.0.0.1/echo', { method: 'POST', headers: { 'x-name': 'req', host: 'evil.example' }, body: '{"a":1}' }),
    );
    expect(await asRequest.json()).toEqual({ method: 'POST', host: '127.0.0.1', name: 'req', body: '{"a":1}' });
    // init wins over the Request, as in fetch()
    const overridden = await fetchIn(new Request('http://127.0.0.1/echo', { method: 'POST', headers: { 'x-name': 'req' }, body: 'x' }), {
      method: 'PUT',
      headers: { 'x-name': 'init' },
      body: 'y',
    });
    expect(await overridden.json()).toEqual({ method: 'PUT', host: '127.0.0.1', name: 'init', body: 'y' });
    const asString = await fetchIn('http://127.0.0.1/echo', { method: 'DELETE' });
    expect(await asString.json()).toMatchObject({ method: 'DELETE', host: '127.0.0.1', body: '' });
  });

  describe('the origin guard covers every method on this path', () => {
    const initialize = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '0' } },
    });
    const send = (request: ReturnType<typeof boot>['request'], method: string, headers: Record<string, string>) =>
      request(`${URL_}${MCP_PATH}`, {
        method,
        headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers },
        ...(method === 'POST' ? { body: initialize } : {}),
      });

    it.each(['POST', 'GET', 'DELETE'])('%s: foreign Origin, foreign Host and Sec-Fetch-Site: cross-site are 403', async (method) => {
      const { request } = boot('1');
      expect((await send(request, method, { origin: 'https://evil.example' })).status).toBe(403);
      expect((await send(request, method, { origin: 'http://127.0.0.1:3000' })).status).toBe(403);
      expect((await send(request, method, { host: 'evil.example' })).status).toBe(403);
      expect((await send(request, method, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    });

    it.each([
      ['POST', 200],
      ['GET', 405],
      ['DELETE', 405],
    ])('%s: no Origin or a same-origin one reaches the SDK (%i)', async (method, status) => {
      const { request } = boot('1');
      expect((await send(request, method, {})).status).toBe(status);
      expect((await send(request, method, { origin: URL_, 'sec-fetch-site': 'same-origin' })).status).toBe(status);
    });

    it('leaves every other route as it was: a cross-origin GET still reads', async () => {
      const { request } = boot('1');
      expect((await request(`${URL_}/api/v1/projects`, { headers: { origin: 'https://evil.example' } })).status).toBe(200);
      expect((await request(`${URL_}/api/v1/projects`, { method: 'POST', headers: { origin: 'https://evil.example' } })).status).toBe(403);
    });
  });

  describe('wait_for_runs over HTTP', () => {
    it.each(['legacy', 'auto'] as const)('%s: a 2 s timeout returns after about 2 s', async (era) => {
      const { store, connect } = boot('1');
      const run = store.createRun({ title: 'slow', workflow: 'quick-task', task: 'slow', steps: [] });
      store.updateRun(run.id, { status: 'running' });
      const client = await connect(era);
      const t0 = Date.now();
      const result = await client.callTool({ name: 'wait_for_runs', arguments: { runIds: [run.id], timeoutSeconds: 2 } });
      const elapsed = Date.now() - t0;
      expect(result.structuredContent).toMatchObject({ runs: [{ id: run.id, status: 'running' }], timedOut: true });
      expect(elapsed).toBeGreaterThanOrEqual(1_900);
      expect(elapsed).toBeLessThan(3_500);
    });

    it('the client cancelling the call ends the wait on the cockpit too', async () => {
      const { store, connect } = boot('1');
      const run = store.createRun({ title: 'slow', workflow: 'quick-task', task: 'slow', steps: [] });
      store.updateRun(run.id, { status: 'running' });
      const client = await connect('auto');
      const polls = vi.spyOn(store, 'getRun');
      const abort = new AbortController();
      const t0 = Date.now();
      setTimeout(() => abort.abort(), 300);
      await expect(
        client.callTool({ name: 'wait_for_runs', arguments: { runIds: [run.id], timeoutSeconds: 30 } }, { signal: abort.signal }),
      ).rejects.toThrow();
      expect(Date.now() - t0).toBeLessThan(1_500);
      const after = polls.mock.calls.length;
      await new Promise((r) => setTimeout(r, 4_500));
      expect(polls.mock.calls.length).toBe(after);
    }, 15_000);
  });
});
