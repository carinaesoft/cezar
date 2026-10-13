import { afterEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createApiClient, type CezarFetch } from './api.ts';
import { buildMcpServer, EVENTS_MAX_WALK_PAGES, WAIT_MAX_SECONDS, type Cockpit } from './tools.ts';

/** The `cez mcp` tool set over a stubbed cockpit (#1109): what is pinned is the route each tool
 *  calls, how it shapes the answer, and the annotations a client decides auto-approval from.
 *  `tools.routes.test.ts` runs the same tools against the real router. */

type Reply = { status?: number; body?: unknown };
type Call = { method: string; url: URL; body?: unknown };
type Routes = Record<string, Reply | ((url: URL, init?: RequestInit) => Reply | Promise<Reply>)>;

function stubFetch(routes: Routes, calls: Call[] = []): CezarFetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    if (init?.signal?.aborted) throw init.signal.reason;
    const reply = typeof route === 'function' ? await route(url, init) : route;
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

interface ConnectOptions {
  readOnly?: boolean;
  calls?: Call[];
  cockpit?: () => Promise<Cockpit>;
  pollIntervalMs?: number;
}

async function connect(routes: Routes, opts: ConnectOptions = {}) {
  const api = createApiClient({ baseUrl: 'http://127.0.0.1:4321', fetch: stubFetch(routes, opts.calls) });
  const server = buildMcpServer({
    cockpit: opts.cockpit ?? (async () => ({ api, defaultProjectId: 'default' })),
    version: '0.0.0-test',
    pollIntervalMs: opts.pollIntervalMs ?? 20,
    ...(opts.readOnly ? { readOnly: true } : {}),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await mcp.connect(clientSide);
  clients.push(mcp);
  return mcp;
}

const textOf = (result: { content?: unknown }) =>
  ((result.content as Array<{ type: string; text?: string }> | undefined) ?? []).map((c) => c.text ?? '').join('');

const run = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  status,
  title: `t-${id}`,
  workflow: 'quick-task',
  task: 'do it',
  createdAt: '2026-10-13T10:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
  ...extra,
});

const ALL_TOOLS = [
  'list_projects',
  'list_workflows',
  'list_models',
  'list_runs',
  'get_run',
  'get_run_status',
  'list_run_events',
  'wait_for_runs',
  'get_pr_status',
  'start_run',
  'cancel_run',
];
const WRITE_TOOLS = ['start_run', 'cancel_run'];

describe('cez mcp tools: registration', () => {
  it('registers the eleven tools, each stating all four hints and an object output schema', async () => {
    const mcp = await connect({});
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...ALL_TOOLS].sort());
    for (const tool of tools) {
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
        expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe('boolean');
      }
      expect(tool.outputSchema?.type, `${tool.name}.outputSchema`).toBe('object');
      expect(tool.name).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    for (const name of WRITE_TOOLS) expect(byName[name]?.readOnlyHint, name).toBe(false);
    for (const name of ALL_TOOLS.filter((n) => !WRITE_TOOLS.includes(n))) expect(byName[name]?.readOnlyHint, name).toBe(true);
    expect(byName.cancel_run?.destructiveHint).toBe(true);
    expect(byName.start_run?.destructiveHint).toBe(false);
    expect(byName.start_run?.idempotentHint).toBe(false);
  });

  it('read-only mode does not register the write tools at all', async () => {
    const mcp = await connect({}, { readOnly: true });
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    expect(names.sort()).toEqual(ALL_TOOLS.filter((n) => !WRITE_TOOLS.includes(n)).sort());
    await expect(mcp.callTool({ name: 'start_run', arguments: { workflow: 'quick-task', task: 'x' } })).rejects.toThrow(
      /Tool start_run not found/,
    );
  });

  it('argument names are camelCase, like the contract', async () => {
    const mcp = await connect({});
    for (const tool of (await mcp.listTools()).tools) {
      for (const key of Object.keys(tool.inputSchema.properties ?? {})) expect(key, `${tool.name}.${key}`).toMatch(/^[a-z][a-zA-Z]*$/);
    }
  });
});

describe('cez mcp tools: reads', () => {
  it('list_projects reads the workspace registry and keeps only the summary fields', async () => {
    const mcp = await connect({
      'GET /api/v1/projects': {
        body: {
          bootProject: 'p1',
          projectsDir: '/x',
          projects: [{ id: 'p1', name: 'app', root: '/r/app', status: 'ok', branch: 'main', addedAt: '', lastOpenedAt: '', source: 'local', tags: ['a'] }],
        },
      },
    });
    const result = await mcp.callTool({ name: 'list_projects', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      bootProject: 'p1',
      projects: [{ id: 'p1', name: 'app', root: '/r/app', status: 'ok', branch: 'main' }],
    });
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
  });

  it('list_workflows names each step', async () => {
    const mcp = await connect({
      'GET /api/v1/p/default/workflows': {
        body: {
          workflows: [{ name: 'quick-task', source: 'built-in', steps: [{ id: 'agent', name: 'Agent', prompt: '{{task}}' }, { id: 'c', skill: 'review' }] }],
          issues: [],
        },
      },
    });
    const result = await mcp.callTool({ name: 'list_workflows', arguments: {} });
    expect(result.structuredContent).toEqual({ workflows: [{ name: 'quick-task', source: 'built-in', steps: ['Agent', 'review'] }] });
  });

  it('list_runs filters the cross-project index and caps the rows', async () => {
    const row = (id: string, projectId: string, status: string, createdAt: string, archived = false) => ({
      id, projectId, status, createdAt, archived, title: `t-${id}`, workflow: 'quick-task',
    });
    const mcp = await connect({
      'GET /api/v1/workspace/runs-index': {
        body: {
          runs: [row('a', 'p1', 'done', '2026-09-01'), row('b', 'p1', 'running', '2026-09-03'), row('c', 'p2', 'running', '2026-09-02'), row('d', 'p1', 'running', '2026-09-04', true)],
          truncated: [],
          perProjectLimit: 200,
          referenceStatuses: {},
        },
      },
    });
    const result = await mcp.callTool({ name: 'list_runs', arguments: { status: ['running'], limit: 1 } });
    const body = result.structuredContent as { runs: Array<{ id: string }>; total: number; more?: number };
    expect(body.runs.map((r) => r.id)).toEqual(['b']);
    expect(body.total).toBe(2);
    expect(body.more).toBe(1);
    const p2 = await mcp.callTool({ name: 'list_runs', arguments: { projectId: 'p2' } });
    expect((p2.structuredContent as { runs: Array<{ id: string }> }).runs.map((r) => r.id)).toEqual(['c']);
  });

  it('project-scoped tools hit the /p/:projectId spelling, defaulting to the cockpit default project', async () => {
    const calls: Call[] = [];
    const mcp = await connect(
      {
        'GET /api/v1/p/default/runs/r1': { body: run('r1', 'running', { task: 'long task' }) },
        'GET /api/v1/p/other/runs/r1': { body: run('r1', 'done') },
      },
      { calls },
    );
    const a = await mcp.callTool({ name: 'get_run_status', arguments: { runId: 'r1' } });
    const b = await mcp.callTool({ name: 'get_run_status', arguments: { runId: 'r1', projectId: 'other' } });
    expect(a.structuredContent).toEqual({ id: 'r1', status: 'running', title: 't-r1', workflow: 'quick-task', createdAt: '2026-10-13T10:00:00.000Z' });
    expect((b.structuredContent as { status: string }).status).toBe('done');
    expect(calls.map((c) => c.url.pathname)).toEqual(['/api/v1/p/default/runs/r1', '/api/v1/p/other/runs/r1']);
  });

  it('get_run returns the record with long strings clipped and unknown keys kept', async () => {
    const mcp = await connect({ 'GET /api/v1/p/default/runs/r1': { body: run('r1', 'review', { task: 'x'.repeat(5_000), futureKey: 1 }) } });
    const result = await mcp.callTool({ name: 'get_run', arguments: { runId: 'r1' } });
    const body = result.structuredContent as { task: string; futureKey: number; status: string };
    expect(body.task.length).toBeLessThan(2_100);
    expect(body.task).toContain('more chars]');
    expect(body.futureKey).toBe(1);
  });

  it('a refusal from the cockpit is a readable tool error, not a protocol error', async () => {
    const mcp = await connect({});
    const result = await mcp.callTool({ name: 'get_run', arguments: { runId: 'missing' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('cezar refused: 404: not found');
  });

  it('an answer in an unknown shape is a readable tool error', async () => {
    const mcp = await connect({ 'GET /api/v1/projects': { body: { projects: 'nope' } } });
    const result = await mcp.callTool({ name: 'list_projects', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/shape this cez mcp does not recognize/);
  });

  it('an unreachable cockpit is a readable tool error, and a read is retried once after it', async () => {
    let attempts = 0;
    const mcp = await connect({}, {
      cockpit: async () => {
        attempts += 1;
        throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:4321') });
      },
    });
    const result = await mcp.callTool({ name: 'list_projects', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('cannot reach the cezar cockpit (connect ECONNREFUSED 127.0.0.1:4321)');
    expect(attempts).toBe(2);
  });

  it('a write is never retried after a connection error', async () => {
    let attempts = 0;
    const mcp = await connect({}, {
      cockpit: async () => {
        attempts += 1;
        throw new TypeError('fetch failed');
      },
    });
    const result = await mcp.callTool({ name: 'cancel_run', arguments: { runId: 'r1' } });
    expect(result.isError).toBe(true);
    expect(attempts).toBe(1);
  });

  it('get_pr_status sends the numbers comma-joined and degrades in the payload', async () => {
    const calls: Call[] = [];
    const mcp = await connect(
      { 'GET /api/v1/p/default/github/ref-status': { body: { available: false, reason: 'no gh', recheckAfterMs: null } } },
      { calls },
    );
    const result = await mcp.callTool({ name: 'get_pr_status', arguments: { prs: [1, 2], issues: [3] } });
    expect(result.structuredContent).toEqual({ available: false, reason: 'no gh', recheckAfterMs: null });
    expect(calls[0]?.url.search).toBe('?prs=1%2C2&issues=3');
    const empty = await mcp.callTool({ name: 'get_pr_status', arguments: {} });
    expect(empty.isError).toBe(true);
  });
});

describe('cez mcp tools: list_run_events', () => {
  const ev = (seq: number) => ({ seq, ts: '2026-10-13T10:00:00.000Z', type: 'text', text: `e${seq}` });
  const page = (from: number, to: number, olderCursor?: string) => ({
    events: Array.from({ length: to - from + 1 }, (_, i) => ev(from + i)),
    itemCount: to - from + 1,
    liveCursor: 'live',
    asOfSeq: 1_000,
    hasOlder: olderCursor !== undefined,
    ...(olderCursor ? { olderCursor } : {}),
  });

  it('without arguments returns the newest page, oldest first, with the cursor to page back', async () => {
    const mcp = await connect({ 'GET /api/v1/p/default/runs/r1/history': { body: page(901, 1_000, 'c1') } });
    const result = await mcp.callTool({ name: 'list_run_events', arguments: { runId: 'r1' } });
    const body = result.structuredContent as { events: Array<{ seq: number }>; olderCursor?: string; asOfSeq: number };
    expect(body.events[0]?.seq).toBe(901);
    expect(body.events.at(-1)?.seq).toBe(1_000);
    expect(body.olderCursor).toBe('c1');
    expect(body.asOfSeq).toBe(1_000);
  });

  it('afterSeq walks back from the tip until it is covered, and returns only newer events', async () => {
    const calls: Call[] = [];
    const pages: Record<string, ReturnType<typeof page>> = { tip: page(901, 1_000, 'c1'), c1: page(800, 901, 'c2'), c2: page(700, 800, 'c3') };
    const mcp = await connect(
      { 'GET /api/v1/p/default/runs/r1/history': (url) => ({ body: pages[url.searchParams.get('cursor') ?? 'tip'] }) },
      { calls },
    );
    const result = await mcp.callTool({ name: 'list_run_events', arguments: { runId: 'r1', afterSeq: 850 } });
    const body = result.structuredContent as { events: Array<{ seq: number }>; gap?: boolean; olderCursor?: string };
    expect(body.events.map((e) => e.seq)).toEqual(Array.from({ length: 150 }, (_, i) => 851 + i));
    expect(body.gap).toBeUndefined();
    expect(body.olderCursor).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('afterSeq too far back stops after a bounded walk and says there is a gap', async () => {
    const calls: Call[] = [];
    const mcp = await connect(
      {
        'GET /api/v1/p/default/runs/r1/history': (url) => {
          const n = Number(url.searchParams.get('cursor') ?? 0);
          const top = 10_000 - n * 100;
          return { body: page(top - 99, top, String(n + 1)) };
        },
      },
      { calls },
    );
    const result = await mcp.callTool({ name: 'list_run_events', arguments: { runId: 'r1', afterSeq: 5 } });
    const body = result.structuredContent as { events: Array<{ seq: number }>; gap?: boolean; olderCursor?: string };
    expect(calls).toHaveLength(1 + EVENTS_MAX_WALK_PAGES);
    expect(body.gap).toBe(true);
    expect(body.olderCursor).toBe(String(EVENTS_MAX_WALK_PAGES + 1));
    expect(body.events[0]?.seq).toBe(10_000 - (EVENTS_MAX_WALK_PAGES + 1) * 100 + 1);
  });

  it("a page's leading turn opener does not count as coverage, and seq gaps do not stop the walk", async () => {
    // As `/history` really pages a long turn: every page leads with the turn's opener (seq 6),
    // and ephemeral deltas leave every third seq out of the file.
    const opener = { seq: 6, ts: '2026-10-13T10:00:00.000Z', type: 'turn.started' };
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i).filter((s) => s % 3 !== 0).map(ev);
    const pages: Record<string, unknown> = {
      tip: { ...page(0, -1, 'c1'), events: [opener, ...range(202, 400)] },
      c1: { ...page(0, -1, 'c2'), events: [opener, ...range(102, 201)] },
      c2: { ...page(0, -1), events: [opener, ...range(7, 101)] },
    };
    const mcp = await connect({ 'GET /api/v1/p/default/runs/r1/history': (url) => ({ body: pages[url.searchParams.get('cursor') ?? 'tip'] }) });
    const result = await mcp.callTool({ name: 'list_run_events', arguments: { runId: 'r1', afterSeq: 100 } });
    const body = result.structuredContent as { events: Array<{ seq: number }>; gap?: boolean };
    expect(body.gap).toBeUndefined();
    expect(body.events[0]?.seq).toBe(101);
    expect(body.events.at(-1)?.seq).toBe(400);
    expect(body.events.map((e) => e.seq)).toEqual(range(101, 400).map((e) => e.seq));
  });

  it('a cursor is passed through to /history', async () => {
    const calls: Call[] = [];
    const mcp = await connect({ 'GET /api/v1/p/default/runs/r1/history': { body: page(1, 10) } }, { calls });
    await mcp.callTool({ name: 'list_run_events', arguments: { runId: 'r1', cursor: 'abc' } });
    expect(calls[0]?.url.searchParams.get('cursor')).toBe('abc');
  });
});

describe('cez mcp tools: start_run and cancel_run', () => {
  it('start_run posts a named-workflow body and answers with the compact record', async () => {
    const calls: Call[] = [];
    const mcp = await connect(
      { 'POST /api/v1/p/default/runs': { status: 201, body: run('r9', 'queued', { title: 'Fix', task: 'Fix it' }) } },
      { calls },
    );
    const result = await mcp.callTool({ name: 'start_run', arguments: { workflow: 'quick-task', task: 'Fix it', runner: 'codex' } });
    expect(result.structuredContent).toEqual({ id: 'r9', status: 'queued', title: 'Fix', workflow: 'quick-task', createdAt: '2026-10-13T10:00:00.000Z' });
    expect(calls[0]?.body).toEqual({ workflow: 'quick-task', task: 'Fix it', runner: 'codex' });
  });

  it.each([
    ['an empty task', { workflow: 'quick-task', task: '' }],
    ['no workflow', { task: 'x' }],
    ['inline steps', { task: 'x', steps: [{ id: 'a', prompt: 'p' }] }],
    ['an unknown runner', { workflow: 'quick-task', task: 'x', runner: 'gpt' }],
  ])('start_run refuses %s before anything reaches the cockpit', async (_, args) => {
    const calls: Call[] = [];
    const mcp = await connect({}, { calls });
    const result = await mcp.callTool({ name: 'start_run', arguments: args });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("start_run relays the route's refusal (unknown workflow)", async () => {
    const mcp = await connect({ 'POST /api/v1/p/default/runs': { status: 404, body: { error: 'unknown workflow: nope' } } });
    const result = await mcp.callTool({ name: 'start_run', arguments: { workflow: 'nope', task: 'x' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('cezar refused: 404: unknown workflow: nope');
  });

  it('cancel_run posts to the cancel route', async () => {
    const calls: Call[] = [];
    const mcp = await connect({ 'POST /api/v1/p/default/runs/r1/cancel': { body: { cancelled: true } } }, { calls });
    const result = await mcp.callTool({ name: 'cancel_run', arguments: { runId: 'r1' } });
    expect(result.structuredContent).toEqual({ cancelled: true });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(['POST /api/v1/p/default/runs/r1/cancel']);
  });
});

describe('cez mcp tools: wait_for_runs', () => {
  /** A run whose status follows `script`, one entry per poll, sticking at the last. */
  const scripted = (id: string, script: string[], polls: Record<string, number>) => () => {
    const n = polls[id] ?? 0;
    polls[id] = n + 1;
    return { body: run(id, script[Math.min(n, script.length - 1)]!) };
  };

  it('polls at once and returns as soon as one run settles (mode any)', async () => {
    const polls: Record<string, number> = {};
    const mcp = await connect({
      'GET /api/v1/p/default/runs/r1': scripted('r1', ['running', 'running', 'review'], polls),
      'GET /api/v1/p/default/runs/r2': scripted('r2', ['running'], polls),
    });
    const result = await mcp.callTool({ name: 'wait_for_runs', arguments: { runIds: ['r1', 'r2'], timeoutSeconds: 10 } });
    const body = result.structuredContent as { runs: Array<{ id: string; status: string }>; timedOut: boolean };
    expect(body.timedOut).toBe(false);
    expect(body.runs.map((r) => [r.id, r.status])).toEqual([
      ['r1', 'review'],
      ['r2', 'running'],
    ]);
    expect(polls).toEqual({ r1: 3, r2: 3 });
  });

  it('an already-settled run answers on the first poll', async () => {
    const polls: Record<string, number> = {};
    const mcp = await connect({ 'GET /api/v1/p/default/runs/r1': scripted('r1', ['done'], polls) });
    const result = await mcp.callTool({ name: 'wait_for_runs', arguments: { runIds: ['r1'] } });
    expect((result.structuredContent as { timedOut: boolean }).timedOut).toBe(false);
    expect(polls.r1).toBe(1);
  });

  it('mode all waits for every run', async () => {
    const polls: Record<string, number> = {};
    const mcp = await connect({
      'GET /api/v1/p/default/runs/r1': scripted('r1', ['done'], polls),
      'GET /api/v1/p/default/runs/r2': scripted('r2', ['running', 'running', 'running', 'failed'], polls),
    });
    const result = await mcp.callTool({ name: 'wait_for_runs', arguments: { runIds: ['r1', 'r2'], mode: 'all', timeoutSeconds: 10 } });
    const body = result.structuredContent as { runs: Array<{ status: string }>; timedOut: boolean };
    expect(body.runs.map((r) => r.status)).toEqual(['done', 'failed']);
    expect(polls.r2).toBe(4);
  });

  it('gives up at its timeout, says so, and stops polling', async () => {
    const polls: Record<string, number> = {};
    const mcp = await connect({ 'GET /api/v1/p/default/runs/r1': scripted('r1', ['running'], polls) }, { pollIntervalMs: 100 });
    const started = Date.now();
    const result = await mcp.callTool({ name: 'wait_for_runs', arguments: { runIds: ['r1'], timeoutSeconds: 1 } });
    const elapsed = Date.now() - started;
    expect(result.structuredContent).toMatchObject({ runs: [{ id: 'r1', status: 'running' }], timedOut: true });
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(3_000);
    const after = polls.r1;
    await new Promise((r) => setTimeout(r, 300));
    expect(polls.r1).toBe(after);
  });

  it('a cockpit that stalls mid-poll is cut off by the same timeout', async () => {
    const mcp = await connect({
      'GET /api/v1/p/default/runs/r1': (_url, init) =>
        new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
    });
    const started = Date.now();
    const result = await mcp.callTool({ name: 'wait_for_runs', arguments: { runIds: ['r1'], timeoutSeconds: 1 } });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.structuredContent).toEqual({ runs: [{ id: 'r1', status: 'unknown' }], timedOut: true });
  });

  it("stops polling when the client cancels the call", async () => {
    const polls: Record<string, number> = {};
    const mcp = await connect({ 'GET /api/v1/p/default/runs/r1': scripted('r1', ['running'], polls) }, { pollIntervalMs: 50 });
    const controller = new AbortController();
    const pending = mcp.callTool({ name: 'wait_for_runs', arguments: { runIds: ['r1'], timeoutSeconds: 30 } }, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();
    await expect(pending).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 100));
    const after = polls.r1;
    await new Promise((r) => setTimeout(r, 300));
    expect(polls.r1).toBe(after);
  });

  it('reports progress on every poll when the client asks for it', async () => {
    const polls: Record<string, number> = {};
    const mcp = await connect({ 'GET /api/v1/p/default/runs/r1': scripted('r1', ['queued', 'running', 'done'], polls) });
    const progress: Array<{ progress: number; message?: string }> = [];
    await mcp.callTool({ name: 'wait_for_runs', arguments: { runIds: ['r1'] } }, { onprogress: (p) => progress.push(p) });
    expect(progress.map((p) => p.progress)).toEqual([1, 2, 3]);
    expect(progress.map((p) => p.message)).toEqual(['r1: queued', 'r1: running', 'r1: done']);
  });

  it('an unknown run is a tool error, not a wait', async () => {
    const mcp = await connect({});
    const result = await mcp.callTool({ name: 'wait_for_runs', arguments: { runIds: ['nope'] } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('cezar refused: 404: not found');
  });

  it(`refuses a timeout past the client-safe ceiling of ${WAIT_MAX_SECONDS} s`, async () => {
    const mcp = await connect({});
    const result = await mcp.callTool({ name: 'wait_for_runs', arguments: { runIds: ['r1'], timeoutSeconds: WAIT_MAX_SECONDS + 1 } });
    expect(result.isError).toBe(true);
  });
});
