/**
 * The MCP tool set — one definition, served over stdio (`cezar mcp`) and, behind `CEZ_MCP=1`,
 * over Streamable HTTP at `/api/v1/mcp`.
 *
 * Every tool is a thin call to an existing `/api/v1` route, never to `RunManager`/`RunStore`
 * directly: the cockpit process is the single writer of run state, and the route handlers own
 * the policy (workflow lookup, provider gates, capability checks, project scoping). Reaching past
 * them would mean copying that policy here.
 *
 * Every tool declares `readOnlyHint` explicitly (and `destructiveHint` where it writes) — the test
 * next to this file fails on a tool that leaves either to the client's default. `readOnly: true`
 * is a hard filter: write tools are not registered at all, not merely annotated.
 */
import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult, ServerContext, ToolAnnotations } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  createRunInputBaseSchema,
  modelDiscoveryRunnerSchema,
  runIdParamSchema,
  runHistoryCursorSchema,
  runStatusSchema,
} from '@open-mercato/cezar-contract';
import { CezarApiError, readJson, readSse, type CezarClient } from './api.ts';

export interface McpToolsOptions {
  /** Resolves the client lazily — stdio discovers the cockpit on first use, not at spawn. */
  api: () => Promise<CezarClient>;
  /** Project a tool call targets when it names none (`CEZ_PROJECT_ID`, else the boot project). */
  defaultProjectId: string;
  version: string;
  /** Register only the read-only tools. */
  readOnly?: boolean;
}

/** Statuses at which a run stops needing nobody: finished, or parked on the user. */
const SETTLED = new Set(['done', 'failed', 'cancelled', 'waiting', 'review']);
/** Codex cuts a tool call at 60 s by default; stay under it with room for the round trip. */
export const WAIT_MAX_SECONDS = 45;

const projectIdArg = z
  .string()
  .min(1)
  .max(128)
  .optional()
  .describe('Project id from list_projects. Omit for the default project.');
const runIdArg = runIdParamSchema.shape.id.describe('Run id (from list_runs or start_run).');

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

type Json = Record<string, unknown>;

function ok(data: Json): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** One readable line for the model, whatever went wrong on the way to the cockpit. */
export function describeError(error: unknown): string {
  if (error instanceof CezarApiError) return `cezar refused: ${error.message}`;
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'cezar did not answer in time';
    if (error.message === 'fetch failed') return `cannot reach the cezar cockpit${cause}`;
    return error.message + cause;
  }
  return String(error);
}

/** Collapse long string values so one tool-call result or event can't flood the model's context. */
function clip(value: unknown, max: number): unknown {
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}… [${value.length - max} more chars]` : value;
  if (Array.isArray(value)) return value.map((v) => clip(v, max));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v, max)]));
  }
  return value;
}

export function buildMcpServer(options: McpToolsOptions): McpServer {
  const server = new McpServer(
    { name: 'cezar', title: 'Cezar', version: options.version },
    {
      instructions:
        'Cezar runs AI agent tasks ("runs") in git worktrees. Start with list_projects / list_runs. ' +
        'start_run returns immediately with a run id; follow it with wait_for_runs (bounded, call again) ' +
        'or get_run_status. Runs parked at "waiting" or "review" need a human in the cockpit.',
    },
  );
  const pid = (projectId: string | undefined) => ({ projectId: projectId ?? options.defaultProjectId });
  const call = async (fn: (api: CezarClient) => Promise<Json>): Promise<CallToolResult> => {
    try {
      return ok(await fn(await options.api()));
    } catch (error) {
      return fail(describeError(error));
    }
  };

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'Projects (repositories) this cezar cockpit serves, with their ids, roots and current branch.',
      annotations: READ,
    },
    () =>
      call(async (api) => {
        const body = await readJson(await api.api.v1.projects.$get());
        return {
          bootProject: body.bootProject,
          projects: body.projects.map((p) => ({ id: p.id, name: p.name, root: p.root, status: p.status, branch: p.branch })),
        };
      }),
  );

  server.registerTool(
    'list_workflows',
    {
      title: 'List workflows',
      description: 'Workflows a run can be started with (start_run.workflow), with their steps.',
      inputSchema: z.object({ projectId: projectIdArg }),
      annotations: READ,
    },
    ({ projectId }) =>
      call(async (api) => {
        const body = await readJson(await api.api.v1.p[':projectId'].workflows.$get({ param: pid(projectId) }));
        return {
          workflows: body.workflows.map((w) => ({
            name: w.name,
            description: w.description,
            source: w.source,
            steps: w.steps.map((s) => s.name ?? s.skill ?? s.id),
          })),
          ...(body.issues.length ? { issues: body.issues } : {}),
        };
      }),
  );

  server.registerTool(
    'list_models',
    {
      title: 'List models',
      description: 'Models the given agent runner can use on this host (start_run.model).',
      inputSchema: z.object({ runner: modelDiscoveryRunnerSchema.describe('Agent runner.') }),
      annotations: READ,
    },
    ({ runner }) => call(async (api) => ({ ...(await readJson(await api.api.v1.models.$get({ query: { runner } }))) })),
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
      annotations: READ,
    },
    ({ projectId, status, includeArchived, limit }) =>
      call(async (api) => {
        const body = await readJson(await api.api.v1.workspace['runs-index'].$get());
        const wanted = status ? new Set<string>(status) : undefined;
        const rows = body.runs
          .filter((r) => (projectId ? r.projectId === projectId : true))
          .filter((r) => (wanted ? wanted.has(r.status) : true))
          .filter((r) => (includeArchived ? true : !r.archived))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const max = limit ?? 20;
        return {
          runs: rows.slice(0, max).map((r) => ({
            projectId: r.projectId,
            id: r.id,
            title: r.titleSummary ?? r.title,
            status: r.status,
            activity: r.activity,
            workflow: r.workflow,
            branch: r.branch,
            createdAt: r.createdAt,
            finishedAt: r.finishedAt,
          })),
          total: rows.length,
          ...(rows.length > max ? { more: rows.length - max } : {}),
        };
      }),
  );

  server.registerTool(
    'get_run',
    {
      title: 'Get run',
      description: 'The full run record: task, steps, branch, PR, usage. Long text fields are clipped.',
      inputSchema: z.object({ projectId: projectIdArg, runId: runIdArg }),
      annotations: READ,
    },
    ({ projectId, runId }) =>
      call(async (api) => {
        const run = await readJson(await api.api.v1.p[':projectId'].runs[':id'].$get({ param: { ...pid(projectId), id: runId } }));
        return clip(run, 2_000) as Json;
      }),
  );

  server.registerTool(
    'get_run_status',
    {
      title: 'Get run status',
      description: 'Compact status of one run — cheap to poll.',
      inputSchema: z.object({ projectId: projectIdArg, runId: runIdArg }),
      annotations: READ,
    },
    ({ projectId, runId }) =>
      call(async (api) => {
        const run = await readJson(await api.api.v1.p[':projectId'].runs[':id'].$get({ param: { ...pid(projectId), id: runId } }));
        return statusOf(run as unknown as Json);
      }),
  );

  server.registerTool(
    'list_run_events',
    {
      title: 'List run events',
      description:
        'Transcript events of a run, newest page first (up to 100 items). Pass olderCursor from the previous ' +
        'answer to page back; pass afterSeq to keep only events newer than one you have seen.',
      inputSchema: z.object({
        projectId: projectIdArg,
        runId: runIdArg,
        cursor: runHistoryCursorSchema.optional().describe('olderCursor from a previous call.'),
        afterSeq: z.number().int().nonnegative().optional().describe('Only events with seq greater than this.'),
        maxChars: z.number().int().min(100).max(20_000).optional().describe('Clip each text field to this (default 1000).'),
      }),
      annotations: READ,
    },
    ({ projectId, runId, cursor, afterSeq, maxChars }) =>
      call(async (api) => {
        const page = await readJson(
          await api.api.v1.p[':projectId'].runs[':id'].history.$get({
            param: { ...pid(projectId), id: runId },
            query: cursor ? { cursor } : {},
          }),
        );
        const events = page.events.filter((e) => (afterSeq === undefined ? true : e.seq > afterSeq));
        return {
          events: events.map((e) => clip(e, maxChars ?? 1_000)),
          asOfSeq: page.asOfSeq,
          ...(page.hasOlder && page.olderCursor ? { olderCursor: page.olderCursor } : {}),
        };
      }),
  );

  server.registerTool(
    'wait_for_runs',
    {
      title: 'Wait for runs',
      description:
        `Block until runs settle (done, failed, cancelled, or parked at waiting/review) or the timeout ` +
        `(max ${WAIT_MAX_SECONDS} s) passes. mode "any" returns at the first settled run, "all" when every one has. ` +
        'On timedOut: true, just call again.',
      inputSchema: z.object({
        projectId: projectIdArg,
        runIds: z.array(runIdArg).min(1).max(20),
        mode: z.enum(['any', 'all']).optional().describe('Default "any".'),
        timeoutSeconds: z.number().int().min(1).max(WAIT_MAX_SECONDS).optional().describe(`Default ${WAIT_MAX_SECONDS - 5}.`),
      }),
      annotations: READ,
    },
    ({ projectId, runIds, mode, timeoutSeconds }, ctx) =>
      call((api) => waitForRuns(api, ctx, { projectId: pid(projectId).projectId, runIds, mode: mode ?? 'any', timeoutMs: (timeoutSeconds ?? WAIT_MAX_SECONDS - 5) * 1000 })),
  );

  server.registerTool(
    'get_pr_status',
    {
      title: 'Get PR status',
      description: 'Status (open/merged/closed, checks, review) of pull requests and issues in a project\'s forge.',
      inputSchema: z.object({
        projectId: projectIdArg,
        prs: z.array(z.number().int().positive()).max(20).optional(),
        issues: z.array(z.number().int().positive()).max(20).optional(),
      }),
      annotations: { ...READ, openWorldHint: true },
    },
    ({ projectId, prs, issues }) =>
      call(async (api) => {
        if (!prs?.length && !issues?.length) throw new Error('name at least one pr or issue number');
        const query = {
          ...(prs?.length ? { prs: prs.join(',') } : {}),
          ...(issues?.length ? { issues: issues.join(',') } : {}),
        };
        return { ...(await readJson(await api.api.v1.p[':projectId'].github['ref-status'].$get({ param: pid(projectId), query }))) };
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
      inputSchema: createRunInputBaseSchema
        .pick({ task: true, model: true, runner: true, agentProfile: true, worktree: true, autonomous: true })
        .extend({
          projectId: projectIdArg,
          workflow: z.string().min(1).max(200).describe('Workflow name from list_workflows.'),
        }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ projectId, ...body }) =>
      call(async (api) => {
        const created = (await readJson(await api.api.v1.p[':projectId'].runs.$post({ param: pid(projectId), json: body }))) as unknown as Json;
        return statusOf(created);
      }),
  );

  server.registerTool(
    'cancel_run',
    {
      title: 'Cancel run',
      description: 'Stop a queued or running run. Its agent is killed; the worktree is kept.',
      inputSchema: z.object({ projectId: projectIdArg, runId: runIdArg }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ projectId, runId }) =>
      call(async (api) => ({
        ...(await readJson(await api.api.v1.p[':projectId'].runs[':id'].cancel.$post({ param: { ...pid(projectId), id: runId } }))),
      })),
  );

  return server;
}

/** The fields an orchestrating agent needs to decide its next step, without the transcript. */
function statusOf(run: Json): Json {
  const pick = ['id', 'title', 'titleSummary', 'status', 'activity', 'workflow', 'branch', 'createdAt', 'startedAt', 'finishedAt', 'autoResumeAt', 'currentStepId', 'error', 'pullRequestUrl', 'prNumber', 'costUsd'];
  return Object.fromEntries(pick.filter((k) => run[k] !== undefined).map((k) => [k, clip(run[k], 500)]));
}

interface WaitInput {
  projectId: string;
  runIds: string[];
  mode: 'any' | 'all';
  timeoutMs: number;
}

/**
 * Follow each run's SSE stream until the wanted runs settle. `afterSeq` past any real seq skips
 * the transcript replay, so the first `run` frame is the current record and later ones are
 * changes — no polling, and a run that is already settled answers at once.
 */
async function waitForRuns(api: CezarClient, ctx: ServerContext, input: WaitInput): Promise<Json> {
  const statuses = new Map<string, string>();
  const abort = new AbortController();
  const onClientAbort = () => abort.abort();
  ctx.mcpReq.signal.addEventListener('abort', onClientAbort, { once: true });
  const timer = setTimeout(() => abort.abort(), input.timeoutMs);
  const progressToken = ctx.mcpReq._meta?.progressToken;
  let progress = 0;
  const settled = () => [...statuses.values()].filter((s) => SETTLED.has(s)).length;
  const done = () => (input.mode === 'any' ? settled() > 0 : settled() === input.runIds.length);

  const follow = async (runId: string) => {
    const res = await api.api.v1.p[':projectId'].runs[':id'].events.$get(
      { param: { projectId: input.projectId, id: runId }, query: { afterSeq: String(Number.MAX_SAFE_INTEGER) } },
      { init: { signal: abort.signal } },
    );
    if (!res.ok || !res.body) {
      await readJson(res);
      return;
    }
    for await (const frame of readSse(res.body)) {
      if (frame.event !== 'run') continue;
      const status = (JSON.parse(frame.data) as { status?: string }).status ?? 'unknown';
      if (statuses.get(runId) === status) continue;
      statuses.set(runId, status);
      if (progressToken !== undefined) {
        progress += 1;
        await ctx.mcpReq
          .notify({ method: 'notifications/progress', params: { progressToken, progress, message: `${runId}: ${status}` } })
          .catch(() => {});
      }
      if (done()) abort.abort();
      if (SETTLED.has(status)) return;
    }
  };

  try {
    const results = await Promise.allSettled(input.runIds.map(follow));
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected' && !abort.signal.aborted);
    if (failure) throw failure.reason;
    const refused = results.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected' && r.reason instanceof CezarApiError,
    );
    if (refused) throw refused.reason;
  } finally {
    clearTimeout(timer);
    ctx.mcpReq.signal.removeEventListener('abort', onClientAbort);
  }
  return {
    runs: input.runIds.map((id) => ({ id, status: statuses.get(id) ?? 'unknown' })),
    timedOut: !done(),
  };
}
