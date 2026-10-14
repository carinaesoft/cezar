import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { RunStore } from '../runs/store.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { createApp } from '../server/server.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApiClient } from './api.ts';
import { buildMcpServer, startRunInputSchema } from './tools.ts';

/**
 * The tools against the REAL router (#1109): every route a tool names must exist under the spelling
 * it uses, and what `start_run`'s `inputSchema` accepts must be what `POST /runs` accepts. The
 * manager is a capturing stub — what is pinned is the HTTP boundary, not the engine.
 */
describe('cez mcp tools over the real /api/v1 router', () => {
  let repoRoot: string;
  let home: string;
  let store: RunStore;
  let app: Hono;
  let started: Array<{ workflow: string; input: Record<string, unknown> }>;
  let cancelled: string[];
  let requests: string[];
  let mcp: Client;
  const saved = { dryRun: process.env.CEZ_DRY_RUN, home: process.env.CEZ_HOME };

  beforeEach(async () => {
    process.env.CEZ_DRY_RUN = '1';
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-mcp-home-'));
    process.env.CEZ_HOME = home;
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-mcp-repo-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    started = [];
    cancelled = [];
    requests = [];
    const manager = {
      startRun: (workflow: { name: string }, input: { task: string } & Record<string, unknown>) => {
        started.push({ workflow: workflow.name, input });
        return store.createRun({ title: input.task, workflow: workflow.name, task: input.task, steps: [] });
      },
      cancel: (id: string) => {
        cancelled.push(id);
        return true;
      },
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test' });
    const api = createApiClient({
      baseUrl: 'http://127.0.0.1:4321',
      fetch: (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push(url);
        return apiRequest(app, url, init);
      },
    });
    const server = buildMcpServer({ cockpit: async () => ({ api, defaultProjectId: 'default' }), version: '0.0.0-test', pollIntervalMs: 10 });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    mcp = new Client({ name: 'test', version: '0.0.0' });
    await mcp.connect(clientSide);
  });

  afterEach(async () => {
    await mcp.close();
    store.flush();
    for (const dir of [repoRoot, home]) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [['CEZ_DRY_RUN', saved.dryRun], ['CEZ_HOME', saved.home]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const call = (name: string, args: Record<string, unknown> = {}) => mcp.callTool({ name, arguments: args });
  const text = (result: { content?: unknown }) => (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('');

  it('start_run → get_run_status → wait_for_runs → cancel_run against the routes', async () => {
    const body = { workflow: 'quick-task', task: 'Fix the bug', runner: 'claude', autonomous: true, worktree: false };
    expect(startRunInputSchema.safeParse(body).success).toBe(true);
    const created = await call('start_run', body);
    expect(created.isError, text(created)).toBeFalsy();
    const run = created.structuredContent as { id: string; status: string; workflow: string };
    expect(run.workflow).toBe('quick-task');
    expect(started).toEqual([
      { workflow: 'quick-task', input: expect.objectContaining({ task: 'Fix the bug', runner: 'claude', autonomous: true, worktree: false }) },
    ]);

    const status = await call('get_run_status', { runId: run.id });
    expect(status.structuredContent).toMatchObject({ id: run.id, status: run.status });

    store.updateRun(run.id, { status: 'review' });
    const waited = await call('wait_for_runs', { runIds: [run.id], timeoutSeconds: 5 });
    expect(waited.structuredContent).toMatchObject({ runs: [{ id: run.id, status: 'review' }], timedOut: false });

    const full = await call('get_run', { runId: run.id });
    expect(full.structuredContent).toMatchObject({ id: run.id, task: 'Fix the bug', status: 'review' });

    const cancel = await call('cancel_run', { runId: run.id });
    expect(cancel.structuredContent).toEqual({ cancelled: true });
    expect(cancelled).toEqual([run.id]);
  });

  it('an unknown workflow is the route\'s 404, as a tool error', async () => {
    const result = await call('start_run', { workflow: 'no-such-workflow', task: 'x' });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('cezar refused: 404: unknown workflow: no-such-workflow');
    expect(started).toEqual([]);
  });

  it('an unknown run is a 404 from every run tool', async () => {
    for (const name of ['get_run', 'get_run_status', 'list_run_events', 'cancel_run']) {
      const result = await call(name, { runId: 'nope' });
      expect(result.isError, name).toBe(true);
      // the real index does not list it either: no project has it
      expect(text(result), name).toBe('cezar refused: 404: not found — no project of this cockpit has a run nope — check the id (list_runs)');
    }
  });

  it('the read tools reach their routes and answer in their output schema', async () => {
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    store.appendEvent(run.id, { type: 'text', text: 'hello' });
    for (const [name, args] of [
      ['list_projects', {}],
      ['list_workflows', {}],
      ['list_runs', {}],
      ['list_run_events', { runId: run.id }],
      ['list_run_events', { runId: run.id, afterSeq: 0 }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError, `${name}: ${text(result)}`).toBeFalsy();
    }
    const workflows = (await call('list_workflows')).structuredContent as { workflows: Array<{ name: string }> };
    expect(workflows.workflows.map((w) => w.name)).toContain('quick-task');
    // The index reads the project REGISTRY, which this unregistered temp repo is not in.
    expect((await call('list_runs')).structuredContent).toMatchObject({ runs: [], total: 0 });
    const events = (await call('list_run_events', { runId: run.id })).structuredContent as { events: Array<{ type: string }> };
    expect(events.events.map((e) => e.type)).toContain('text');
  });

  it('list_run_events with afterSeq reads forward in one /history request', async () => {
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    store.appendEvent(run.id, { type: 'turn.started', turnId: 't1' });
    for (let i = 0; i < 400; i += 1) store.appendEvent(run.id, { type: 'note', message: `n${i}` });
    requests.length = 0;
    const result = await call('list_run_events', { runId: run.id, afterSeq: 50, maxEvents: 500 });
    const body = result.structuredContent as { events: Array<{ seq: number }>; nextAfterSeq?: number; gap?: boolean };
    expect(requests.filter((u) => u.includes('/history'))).toEqual([expect.stringMatching(/\/history\?afterSeq=50$/)]);
    expect(body.events[0]?.seq).toBe(51);
    expect(body.events.every((e, i, all) => e.seq > 50 && (i === 0 || e.seq > all[i - 1]!.seq))).toBe(true);
    expect(body.gap).toBeUndefined();
    expect(body.nextAfterSeq).toBe(body.events.at(-1)?.seq);
  });
});
