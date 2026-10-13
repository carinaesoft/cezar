import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runHistoryPageSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/** `GET /runs/:id/history?afterSeq=` (#1109): a forward read from a seq a client kept. */
describe('GET /runs/:id/history?afterSeq', () => {
  let repoRoot: string;
  let home: string;
  let store: RunStore;
  let app: Hono;
  let runId: string;
  const saved = { dryRun: process.env.CEZ_DRY_RUN, home: process.env.CEZ_HOME };

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1';
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-history-home-'));
    process.env.CEZ_HOME = home;
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-history-repo-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
    runId = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] }).id;
    store.appendEvent(runId, { type: 'turn.started', turnId: 't1' });
    for (let i = 0; i < 250; i += 1) store.appendEvent(runId, { type: 'note', message: `n${i}` });
  });

  afterEach(() => {
    store.flush();
    for (const dir of [repoRoot, home]) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [['CEZ_DRY_RUN', saved.dryRun], ['CEZ_HOME', saved.home]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const get = async (query: string) => {
    const res = await apiRequest(app, `http://127.0.0.1:4321/api/v1/runs/${runId}/history${query}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const seqs = (body: Record<string, unknown>) => (body.events as Array<{ seq: number }>).map((e) => e.seq);

  it('reads forward from afterSeq: at the start, in the middle, past the end', async () => {
    const all = (await get('')).body;
    const tip = all.asOfSeq as number;

    const start = await get('?afterSeq=0');
    expect(start.status).toBe(200);
    expect(runHistoryPageSchema.parse(start.body)).toMatchObject({ afterSeq: 0, itemCount: 100, hasOlder: false });
    expect(seqs(start.body)[0]).toBe(1);
    expect(start.body.newerCursor).toBeTypeOf('string');

    const mid = tip - 120;
    const middle = await get(`?afterSeq=${mid}`);
    expect(seqs(middle.body)[0]).toBe(mid + 1);
    expect(seqs(middle.body).every((seq) => seq > mid)).toBe(true);
    expect(middle.body).toMatchObject({ afterSeq: mid, itemCount: 100, hasOlder: true });
    // continue from the last seq returned until the tip: every event once
    const read = [...seqs(middle.body)];
    let next = await get(`?afterSeq=${read.at(-1)}`);
    read.push(...seqs(next.body));
    expect(next.body.newerCursor).toBeUndefined();
    expect(read).toEqual(Array.from({ length: 120 }, (_, i) => mid + 1 + i));

    next = await get(`?afterSeq=${tip}`);
    expect(next.status).toBe(200);
    expect(next.body).toMatchObject({ events: [], itemCount: 0, afterSeq: tip, asOfSeq: tip });
    expect((await get(`?afterSeq=${tip + 1000}`)).body).toMatchObject({ events: [], afterSeq: tip + 1000 });
  });

  it('refuses afterSeq together with a cursor, negative, or not a number — 400 {error}', async () => {
    const cursor = (await get('')).body.olderCursor as string;
    const both = await get(`?afterSeq=5&cursor=${encodeURIComponent(cursor)}`);
    expect(both.status).toBe(400);
    expect(both.body.error).toMatch(/afterSeq.*either cursor or afterSeq, not both/);
    for (const bad of ['-1', 'abc', '1.5']) {
      const res = await get(`?afterSeq=${bad}`);
      expect(res.status, bad).toBe(400);
      expect(res.body.error, bad).toMatch(/afterSeq/);
    }
  });

  it('the project-scoped alias answers the same', async () => {
    const plain = await get('?afterSeq=10');
    const res = await apiRequest(app, `http://127.0.0.1:4321/api/v1/p/default/runs/${runId}/history?afterSeq=10`);
    expect(await res.json()).toEqual(plain.body);
  });
});
