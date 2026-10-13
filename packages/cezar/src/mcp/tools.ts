/**
 * The `cez mcp` tool set (#1109).
 *
 * Every tool is a thin call to an existing `/api/v1` route, never to `RunManager`/`RunStore`
 * directly: the cockpit process is the single writer of run state, and the route handlers own
 * the policy (workflow lookup, provider gates, capability checks, project scoping).
 *
 * Every tool states all four hints explicitly — the test next to this file fails on one that
 * leaves a hint to the client's default. `readOnly: true` is a hard filter: write tools are not
 * registered at all, not merely annotated.
 *
 * Output: each tool's `outputSchema` is cut from the contract's response schema, and the answer
 * is PARSED through it, so `structuredContent` can never drift from what `tools/list` advertised.
 * Run statuses are widened to strings (as `cez runs` does): a cockpit newer than this CLI may add
 * one, and that must not turn every answer into a validation error.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult, ServerContext, ToolAnnotations } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  apiRunSchema,
  cancelResponseSchema,
  createRunInputBaseSchema,
  githubRefStatusDataSchema,
  modelDiscoveryRunnerSchema,
  projectListEntrySchema,
  projectsResponseSchema,
  REFERENCE_STATUS_MAX,
  runHistoryCursorSchema,
  runHistoryEventSchema,
  runHistoryPageSchema,
  runIdParamSchema,
  runIndexEntrySchema,
  runnerModelCatalogResponseSchema,
  runsIndexResponseSchema,
  runStatusSchema,
  workflowDefSchema,
  workflowLoadIssueSchema,
} from '@open-mercato/cezar-contract';
import { CezarApiError, isConnectionError, readJson, type CezarClient } from './api.ts';

/** A reachable cockpit: its client, and the project a tool call targets when it names none. */
export interface Cockpit {
  api: CezarClient;
  defaultProjectId: string;
}

export interface McpToolsOptions {
  /** Resolves the cockpit lazily — stdio discovers it on first use, not at spawn. */
  cockpit: () => Promise<Cockpit>;
  version: string;
  /** Register only the read-only tools. */
  readOnly?: boolean;
  /** `wait_for_runs` poll interval; tests shorten it. */
  pollIntervalMs?: number;
}

/** Statuses at which a run stops needing nobody: finished, or parked on the user. */
const SETTLED = new Set(['done', 'failed', 'cancelled', 'waiting', 'review']);
/** Codex cuts a tool call at 60 s by default; stay under it with room for the round trip. */
export const WAIT_MAX_SECONDS = 45;
export const WAIT_DEFAULT_SECONDS = 40;
export const WAIT_POLL_MS = 2_000;
/** `GET /models` may ask a vendor CLI first, bounded at 15 s server-side — past the 10 s default. */
const MODELS_TIMEOUT_MS = 30_000;
/** Without `afterSeq` on `/history`, catching up walks back at most this many pages (100 items each). */
export const EVENTS_MAX_WALK_PAGES = 5;

// ---- inputs ----------------------------------------------------------------------------------

const projectIdArg = z
  .string()
  .min(1)
  .max(128)
  .optional()
  .describe('Project id from list_projects. Omit for the default project.');
const runIdArg = runIdParamSchema.shape.id.describe('Run id (from list_runs or start_run).');
const runArgs = z.object({ projectId: projectIdArg, runId: runIdArg });

/** `start_run` posts exactly this to `POST /runs` — a named workflow only (no inline steps, no
 *  variants, no attachments), with every bound the route itself enforces. */
export const startRunInputSchema = createRunInputBaseSchema
  .pick({ task: true, model: true, runner: true, agentProfile: true, worktree: true, autonomous: true })
  .extend({
    projectId: projectIdArg,
    workflow: createRunInputBaseSchema.shape.workflow.unwrap().describe('Workflow name from list_workflows (e.g. "quick-task").'),
    task: createRunInputBaseSchema.shape.task.describe('What the agent should do — the prompt.'),
  });

// ---- outputs ---------------------------------------------------------------------------------

const projectsOutput = projectsResponseSchema.pick({ bootProject: true }).extend({
  projects: z.array(projectListEntrySchema.pick({ id: true, name: true, root: true, status: true, branch: true })),
});

const workflowsOutput = z.object({
  workflows: z.array(
    workflowDefSchema
      .pick({ name: true, description: true, source: true })
      .extend({ steps: z.array(z.string()).describe('Step names, in order.') }),
  ),
  issues: z.array(workflowLoadIssueSchema).optional(),
});

const runRowOutput = runIndexEntrySchema
  .pick({ projectId: true, id: true, workflow: true, branch: true, createdAt: true, finishedAt: true, costUsd: true })
  .extend({ title: z.string(), status: z.string(), activity: z.string().optional() });
const runsOutput = runsIndexResponseSchema.pick({ truncated: true }).extend({
  runs: z.array(runRowOutput),
  total: z.number().int(),
  more: z.number().int().optional(),
});

/** What an orchestrating agent needs to decide its next step, without the transcript. */
const runStatusOutput = apiRunSchema
  .pick({
    id: true,
    title: true,
    titleSummary: true,
    workflow: true,
    branch: true,
    createdAt: true,
    startedAt: true,
    finishedAt: true,
    autoResumeAt: true,
    awaitingAnswerSince: true,
    currentStepId: true,
    error: true,
    pullRequestUrl: true,
    prNumber: true,
    costUsd: true,
  })
  .extend({ status: z.string(), activity: z.string().optional() });
type RunStatusOutput = z.infer<typeof runStatusOutput>;

/** The whole record, long strings clipped; loose because the record grows with every release. */
const runOutput = apiRunSchema
  .pick({ id: true, title: true, workflow: true, task: true, createdAt: true })
  .extend({ status: z.string() })
  .loose();

const eventsOutput = runHistoryPageSchema.pick({ asOfSeq: true, olderCursor: true, newerCursor: true }).extend({
  events: z.array(runHistoryEventSchema).describe('Oldest first.'),
  gap: z
    .boolean()
    .optional()
    .describe('true: events between afterSeq and the first one returned were not read — page back with olderCursor.'),
});

const waitOutput = z.object({
  runs: z.array(runStatusOutput.partial().extend({ id: z.string(), status: z.string() })),
  timedOut: z.boolean().describe('true: nothing settled in time — call wait_for_runs again.'),
});

/** `/github/ref-status` answers a union; an MCP output schema must be one object, so it is the
 *  available branch with the unavailable branch's `reason` beside it. */
const [refStatusAvailable] = githubRefStatusDataSchema.options;
const prStatusOutput = refStatusAvailable
  .partial({ prs: true, issues: true })
  .extend({ available: z.boolean(), reason: z.string().optional() });

// ---- plumbing --------------------------------------------------------------------------------

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** One readable line for the model, whatever went wrong on the way to the cockpit. */
export function describeError(error: unknown): string {
  if (error instanceof CezarApiError) return `cezar refused: ${error.message}`;
  if (error instanceof z.ZodError) {
    const where = error.issues[0]?.path.join('.') || 'the answer';
    return `the cockpit answered in a shape this cez mcp does not recognize (at ${where}) — is it the same cezar version?`;
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'the cezar cockpit did not answer in time';
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
    if (isConnectionError(error)) return `cannot reach the cezar cockpit${cause}`;
    return error.message + cause;
  }
  return String(error);
}

/** Collapse long string values so one tool-call result or event can't flood the model's context. */
function clip<T>(value: T, max: number): T {
  if (typeof value === 'string') {
    return (value.length > max ? `${value.slice(0, max)}… [${value.length - max} more chars]` : value) as T;
  }
  if (Array.isArray(value)) return value.map((v: unknown) => clip(v, max)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v, max)])) as T;
  }
  return value;
}

export function buildMcpServer(options: McpToolsOptions): McpServer {
  const server = new McpServer(
    { name: 'cezar', title: 'Cezar', version: options.version },
    {
      instructions:
        'Cezar runs AI agent tasks ("runs") in git worktrees. Start with list_projects / list_runs. ' +
        'start_run returns immediately with a run id; follow it with wait_for_runs (bounded — on timedOut, call it again) ' +
        'or get_run_status. Runs parked at "waiting" or "review" need a human in the cezar cockpit.',
    },
  );
  const projectOf = (c: Cockpit, projectId: string | undefined) => projectId ?? c.defaultProjectId;
  const pollMs = options.pollIntervalMs ?? WAIT_POLL_MS;

  /** Run one tool body against the cockpit. A read that could not reach it is tried once more:
   *  the resolver has dropped the address by then, so a cockpit restarted on another port is
   *  found again. A write is never retried — the first attempt may have landed. */
  const call = async (
    fn: (c: Cockpit) => Promise<Record<string, unknown>>,
    { retry }: { retry: boolean },
  ): Promise<CallToolResult> => {
    try {
      return ok(await fn(await options.cockpit()));
    } catch (error) {
      if (retry && isConnectionError(error)) {
        try {
          return ok(await fn(await options.cockpit()));
        } catch (again) {
          return fail(describeError(again));
        }
      }
      return fail(describeError(error));
    }
  };
  const read = (fn: (c: Cockpit) => Promise<Record<string, unknown>>) => call(fn, { retry: true });
  const write = (fn: (c: Cockpit) => Promise<Record<string, unknown>>) => call(fn, { retry: false });

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'Projects (repositories) this cezar cockpit serves, with their ids, roots and current branch.',
      outputSchema: projectsOutput,
      annotations: READ,
    },
    () => read(async ({ api }) => projectsOutput.parse(await readJson(await api.api.v1.projects.$get()))),
  );

  server.registerTool(
    'list_workflows',
    {
      title: 'List workflows',
      description: 'Workflows a run can be started with (start_run.workflow), with their steps.',
      inputSchema: z.object({ projectId: projectIdArg }),
      outputSchema: workflowsOutput,
      annotations: READ,
    },
    ({ projectId }) =>
      read(async (c) => {
        const body = await readJson(await c.api.api.v1.p[':projectId'].workflows.$get({ param: { projectId: projectOf(c, projectId) } }));
        return workflowsOutput.parse({
          workflows: body.workflows.map((w) => ({ ...w, steps: w.steps.map((s) => s.name ?? s.skill ?? s.id) })),
          ...(body.issues.length ? { issues: body.issues } : {}),
        });
      }),
  );

  server.registerTool(
    'list_models',
    {
      title: 'List models',
      description: 'Models the given agent runner can use on this host (start_run.model).',
      inputSchema: z.object({ runner: modelDiscoveryRunnerSchema.describe('Agent runner.') }),
      outputSchema: runnerModelCatalogResponseSchema,
      // Discovery asks the vendor's own CLI, which may ask the vendor.
      annotations: { ...READ, openWorldHint: true },
    },
    ({ runner }) =>
      read(async ({ api }) => {
        const init = { signal: AbortSignal.timeout(MODELS_TIMEOUT_MS) };
        return runnerModelCatalogResponseSchema.parse(await readJson(await api.api.v1.models.$get({ query: { runner } }, { init })));
      }),
  );

  server.registerTool(
    'list_runs',
    {
      title: 'List runs',
      description: 'Recent runs across all projects, newest first. Filter by project and status.',
      inputSchema: z.object({
        projectId: z.string().min(1).max(128).optional().describe('Only this project. Omit for all projects.'),
        status: z.array(runStatusSchema).max(7).optional().describe('Only runs in these statuses.'),
        includeArchived: z.boolean().optional().describe('Include archived runs (default false).'),
        limit: z.number().int().min(1).max(200).optional().describe('Max rows (default 20).'),
      }),
      outputSchema: runsOutput,
      annotations: READ,
    },
    ({ projectId, status, includeArchived, limit }) =>
      read(async ({ api }) => {
        const body = await readJson(await api.api.v1.workspace['runs-index'].$get());
        const wanted = status ? new Set<string>(status) : undefined;
        const rows = body.runs
          .filter((r) => (projectId ? r.projectId === projectId : true))
          .filter((r) => (wanted ? wanted.has(r.status) : true))
          .filter((r) => (includeArchived ? true : !r.archived))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const max = limit ?? 20;
        return runsOutput.parse({
          runs: rows.slice(0, max).map((r) => ({ ...r, title: r.titleSummary ?? r.title })),
          total: rows.length,
          ...(rows.length > max ? { more: rows.length - max } : {}),
          truncated: body.truncated,
        });
      }),
  );

  const getRun = async (c: Cockpit, projectId: string | undefined, runId: string, signal?: AbortSignal) =>
    readJson(
      await c.api.api.v1.p[':projectId'].runs[':id'].$get(
        { param: { projectId: projectOf(c, projectId), id: runId } },
        signal ? { init: { signal } } : undefined,
      ),
    );
  const statusOf = (run: unknown): RunStatusOutput => {
    const status = runStatusOutput.parse(run);
    return status.error === undefined ? status : { ...status, error: clip(status.error, 500) };
  };

  server.registerTool(
    'get_run',
    {
      title: 'Get run',
      description: 'The full run record: task, steps, branch, PR, usage. Long text fields are clipped.',
      inputSchema: runArgs,
      outputSchema: runOutput,
      annotations: READ,
    },
    ({ projectId, runId }) => read(async (c) => runOutput.parse(clip(await getRun(c, projectId, runId), 2_000))),
  );

  server.registerTool(
    'get_run_status',
    {
      title: 'Get run status',
      description: 'Compact status of one run — cheap to poll.',
      inputSchema: runArgs,
      outputSchema: runStatusOutput,
      annotations: READ,
    },
    ({ projectId, runId }) => read(async (c) => statusOf(await getRun(c, projectId, runId))),
  );

  server.registerTool(
    'list_run_events',
    {
      title: 'List run events',
      description:
        'Transcript events of a run, oldest first, one page (100 transcript items) at a time. Without arguments: the newest page. ' +
        'Remember asOfSeq and pass it back as afterSeq to read only what happened since; pass olderCursor / newerCursor ' +
        'from a previous answer to page. Cursors are short-lived — a seq is what to keep between calls.',
      inputSchema: runArgs.extend({
        cursor: runHistoryCursorSchema.optional().describe('olderCursor or newerCursor from a previous call.'),
        afterSeq: z.number().int().nonnegative().optional().describe('Only events with a seq greater than this.'),
        maxChars: z.number().int().min(100).max(20_000).optional().describe('Clip each text field to this (default 1000).'),
      }),
      outputSchema: eventsOutput,
      annotations: READ,
    },
    ({ projectId, runId, cursor, afterSeq, maxChars }) =>
      read(async (c) => {
        const param = { projectId: projectOf(c, projectId), id: runId };
        const page = async (at?: string) =>
          readJson(await c.api.api.v1.p[':projectId'].runs[':id'].history.$get({ param, query: at ? { cursor: at } : {} }));
        const first = await page(cursor);
        const bySeq = new Map(first.events.map((e) => [e.seq, e]));
        let olderCursor = first.hasOlder ? first.olderCursor : undefined;
        let coveredFrom = pageStart(first.events);
        // `/history` has no `afterSeq` yet (a separate PR, #1109): walk back from the tip, bounded,
        // until a page starts at or below `afterSeq`.
        if (afterSeq !== undefined && cursor === undefined) {
          for (let walked = 0; olderCursor && coveredFrom > afterSeq && walked < EVENTS_MAX_WALK_PAGES; walked += 1) {
            const older = await page(olderCursor);
            for (const e of older.events) bySeq.set(e.seq, e);
            coveredFrom = Math.min(coveredFrom, pageStart(older.events));
            olderCursor = older.hasOlder ? older.olderCursor : undefined;
          }
        }
        const reached = afterSeq === undefined || coveredFrom <= afterSeq || !olderCursor;
        const events = [...bySeq.values()]
          // With a gap, a page's leading turn opener sits below the read range — drop it, so
          // "between afterSeq and the first event" is exactly what is left unread.
          .filter((e) => (afterSeq === undefined ? true : e.seq > afterSeq && (reached || e.seq >= coveredFrom)))
          .sort((a, b) => a.seq - b.seq)
          .map((e) => clip(e, maxChars ?? 1_000));
        return eventsOutput.parse({
          events,
          asOfSeq: first.asOfSeq,
          ...(olderCursor && (afterSeq === undefined || !reached) ? { olderCursor } : {}),
          ...(first.newerCursor ? { newerCursor: first.newerCursor } : {}),
          ...(reached ? {} : { gap: true }),
        });
      }),
  );

  server.registerTool(
    'wait_for_runs',
    {
      title: 'Wait for runs',
      description:
        `Wait until runs settle (done, failed, cancelled, or parked at waiting/review) or the timeout ` +
        `(max ${WAIT_MAX_SECONDS} s) passes, then answer with their status. mode "any" returns at the first settled run, ` +
        '"all" when every one has. On timedOut: true, just call it again.',
      inputSchema: z.object({
        projectId: projectIdArg,
        runIds: z.array(runIdArg).min(1).max(20),
        mode: z.enum(['any', 'all']).optional().describe('Default "any".'),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(WAIT_MAX_SECONDS)
          .optional()
          .describe(`Default ${WAIT_DEFAULT_SECONDS}.`),
      }),
      outputSchema: waitOutput,
      annotations: READ,
    },
    // Not retried: a second wait would carry the call past the client's own tool timeout. The
    // dropped address is still re-discovered on the next call.
    ({ projectId, runIds, mode, timeoutSeconds }, ctx) =>
      call((c) =>
        waitForRuns(ctx, {
          runIds: [...new Set(runIds)],
          mode: mode ?? 'any',
          timeoutMs: (timeoutSeconds ?? WAIT_DEFAULT_SECONDS) * 1000,
          pollMs,
          fetchRun: async (id, signal) => statusOf(await getRun(c, projectId, id, signal)),
        }),
        { retry: false },
      ),
  );

  server.registerTool(
    'get_pr_status',
    {
      title: 'Get PR status',
      description: "Status (open/merged/closed, checks, review) of pull requests and issues in a project's GitHub repository.",
      inputSchema: z.object({
        projectId: projectIdArg,
        prs: z.array(z.number().int().positive()).max(REFERENCE_STATUS_MAX).optional(),
        issues: z.array(z.number().int().positive()).max(REFERENCE_STATUS_MAX).optional(),
      }),
      outputSchema: prStatusOutput,
      annotations: { ...READ, openWorldHint: true },
    },
    ({ projectId, prs, issues }) =>
      read(async (c) => {
        if (!prs?.length && !issues?.length) throw new Error('name at least one pr or issue number');
        const query = {
          ...(prs?.length ? { prs: prs.join(',') } : {}),
          ...(issues?.length ? { issues: issues.join(',') } : {}),
        };
        return prStatusOutput.parse(
          await readJson(await c.api.api.v1.p[':projectId'].github['ref-status'].$get({ param: { projectId: projectOf(c, projectId) }, query })),
        );
      }),
  );

  if (options.readOnly) return server;

  server.registerTool(
    'start_run',
    {
      title: 'Start run',
      description:
        'Start an agent run from a named workflow (list_workflows). Returns at once with the run id — ' +
        'the agent works in the background; follow it with wait_for_runs or get_run_status. Costs agent usage.',
      inputSchema: startRunInputSchema,
      outputSchema: runStatusOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ projectId, ...body }) =>
      write(async (c) =>
        statusOf(await readJson(await c.api.api.v1.p[':projectId'].runs.$post({ param: { projectId: projectOf(c, projectId) }, json: body }))),
      ),
  );

  server.registerTool(
    'cancel_run',
    {
      title: 'Cancel run',
      description: 'Stop a queued or running run. Its agent is killed; the worktree is kept. cancelled: false means it had already settled.',
      inputSchema: runArgs,
      outputSchema: cancelResponseSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ projectId, runId }) =>
      write(async (c) =>
        cancelResponseSchema.parse(
          await readJson(await c.api.api.v1.p[':projectId'].runs[':id'].cancel.$post({ param: { projectId: projectOf(c, projectId), id: runId } })),
        ),
      ),
  );

  return server;
}

/**
 * Where a `/history` page's own range begins. A page leads with the opener of the turn it starts
 * in (`pageEventSlice`, event-history.ts), which can sit far below the rest of the page; counting
 * from it would claim events that were never read. Seqs have gaps (ephemeral deltas), so the
 * range cannot be inferred from contiguity either. When the page's first item IS a turn opener,
 * this under-claims by one event — costing at most one extra page, never a missed one.
 */
function pageStart(events: ReadonlyArray<{ seq: number; type: string }>): number {
  const [head, next] = events;
  if (!head) return Number.POSITIVE_INFINITY;
  return next && (head.type === 'user-message' || head.type === 'turn.started') ? next.seq : head.seq;
}

interface WaitInput {
  runIds: string[];
  mode: 'any' | 'all';
  timeoutMs: number;
  pollMs: number;
  fetchRun: (runId: string, signal: AbortSignal) => Promise<RunStatusOutput>;
}

/**
 * Poll `GET /runs/:id` — at once, then every `pollMs` — until `mode` is satisfied or the timeout
 * passes (#1109). Polling, not the SSE stream: nothing is held open on the cockpit side, and one
 * `AbortController` ends the wait whichever comes first, the timeout or the client's cancel.
 */
async function waitForRuns(ctx: ServerContext, input: WaitInput): Promise<z.infer<typeof waitOutput>> {
  const latest = new Map<string, RunStatusOutput>();
  const abort = new AbortController();
  const clientSignal = ctx.mcpReq.signal;
  const onClientAbort = () => abort.abort(clientSignal.reason);
  if (clientSignal.aborted) abort.abort(clientSignal.reason);
  else clientSignal.addEventListener('abort', onClientAbort, { once: true });
  const timer = setTimeout(() => abort.abort(new DOMException('wait_for_runs timed out', 'TimeoutError')), input.timeoutMs);
  const progressToken = ctx.mcpReq._meta?.progressToken;
  const settledCount = () => input.runIds.filter((id) => SETTLED.has(latest.get(id)?.status ?? '')).length;
  const satisfied = () => (input.mode === 'any' ? settledCount() > 0 : settledCount() === input.runIds.length);

  try {
    for (let poll = 1; ; poll += 1) {
      const runs = await Promise.all(input.runIds.map((id) => input.fetchRun(id, abort.signal)));
      for (const run of runs) latest.set(run.id, run);
      if (progressToken !== undefined) {
        const message = runs.map((r) => `${r.id}: ${r.status}`).join(', ');
        await ctx.mcpReq
          .notify({ method: 'notifications/progress', params: { progressToken, progress: poll, message } })
          .catch(() => {});
      }
      if (satisfied()) break;
      await sleep(input.pollMs, undefined, { signal: abort.signal });
    }
  } catch (error) {
    // Our own abort (timeout or the client's cancel) ends the wait with what is known; anything
    // else — a 404, an unreachable cockpit — is the tool's error.
    if (!abort.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
    clientSignal.removeEventListener('abort', onClientAbort);
  }
  return {
    runs: input.runIds.map((id) => latest.get(id) ?? { id, status: 'unknown' }),
    timedOut: !satisfied(),
  };
}
