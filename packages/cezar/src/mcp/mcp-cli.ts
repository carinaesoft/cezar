/**
 * `cez mcp` — an MCP server on stdio for agents that run OUTSIDE cezar (Claude Code, Codex,
 * OpenCode…), so they can list, start, follow and cancel runs of a running cockpit (#1109).
 *
 * It is a client of the cockpit's `/api/v1`, like `cez task`: run state lives only in the cockpit
 * process, so this never opens a store of its own. The cockpit is `--url`, else `CEZ_API_URL`,
 * else found by probing `GET /api/v1/health` on the ports the cockpit picks from (4321–4370).
 * Discovery is lazy and repeated after a connection error: the MCP handshake always succeeds,
 * a missing cockpit is a readable tool error, and a cockpit restarted on another port is found
 * again on the next call.
 *
 * stdout carries JSON-RPC and nothing else; every diagnostic goes to stderr.
 */
import { parseArgs } from 'node:util';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import type { McpServerFactory } from '@modelcontextprotocol/server';
import { createApiClient, isConnectionError, type CezarFetch } from './api.ts';
import { buildMcpServer, type Cockpit } from './tools.ts';

export const DEFAULT_PORTS = { first: 4321, last: 4370 } as const;
/** Same bound as `cez runs`: a stalled cockpit or proxy must not hang an agent's tool call. */
const REQUEST_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 800;

const USAGE = `cez mcp — MCP server (stdio) for a running cezar cockpit

  cez mcp [--url <http://127.0.0.1:4321>] [--project <id>] [--header "Name: value"]… [--read-only]

  --url        cockpit to talk to (default: $CEZ_API_URL, else the cockpit found on 127.0.0.1:4321-4370)
  --project    default project for tools that take one (default: $CEZ_PROJECT_ID, else the project
               holding the current directory, else the cockpit's boot project)
  --header     extra HTTP header for a cockpit behind a proxy (Basic auth, Cloudflare Access); repeatable
  --read-only  register only the read tools (no start_run / cancel_run)

  Claude Code:  claude mcp add cezar -- npx -y cezar-run mcp`;

export interface McpCliEnv {
  CEZ_API_URL?: string;
  CEZ_PROJECT_ID?: string;
  CEZ_TASK_ID?: string;
}

export interface McpCliIo {
  fetch: CezarFetch;
  log: (line: string) => void;
  error: (line: string) => void;
  cwd: string;
  /** Starts the stdio transport — injected so the CLI parsing is testable without a real stdin. */
  serve: (factory: McpServerFactory) => Promise<void>;
}

export class NoCockpitError extends Error {
  override name = 'NoCockpitError';
}

/** `"Name: value"` → `[name, value]`; the header name is whatever precedes the first colon. */
export function parseHeader(raw: string): [string, string] {
  const colon = raw.indexOf(':');
  if (colon <= 0) throw new Error(`--header must look like "Name: value", got "${raw}"`);
  return [raw.slice(0, colon).trim(), raw.slice(colon + 1).trim()];
}

export interface DiscoveredCockpit {
  url: string;
  /** The registered project holding `cwd`, when the cockpit has one. */
  projectId?: string;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The deepest registered root that contains `cwd` (a repo nested in another wins). */
async function projectHolding(fetchImpl: CezarFetch, url: string, cwd: string, headers?: Record<string, string>) {
  try {
    const res = await fetchImpl(`${url}/api/v1/projects`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), ...(headers ? { headers } : {}) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { projects?: Array<{ id?: unknown; root?: unknown }> };
    const roots = (body.projects ?? []).flatMap((p) =>
      typeof p.id === 'string' && typeof p.root === 'string' && (cwd === p.root || cwd.startsWith(p.root.endsWith(sep) ? p.root : `${p.root}${sep}`))
        ? [{ id: p.id, root: p.root }]
        : [],
    );
    return roots.sort((a, b) => b.root.length - a.root.length)[0]?.id;
  } catch {
    return undefined;
  }
}

/**
 * Probe every port the cockpit may have picked, in parallel, and keep the ones answering like a
 * cockpit (`version` + `capabilities`). One cockpit is the answer. With several, the one with a
 * project holding `cwd` is; when none does, guessing would send writes to whichever cockpit owns
 * the lowest port (#1000), so the user is asked to choose with `--url`.
 */
export async function discoverCockpit(fetchImpl: CezarFetch, cwd: string, headers?: Record<string, string>): Promise<DiscoveredCockpit> {
  const ports: number[] = [];
  for (let p = DEFAULT_PORTS.first; p <= DEFAULT_PORTS.last; p += 1) ports.push(p);
  const probes = await Promise.all(
    ports.map(async (port): Promise<string | null> => {
      const url = `http://127.0.0.1:${port}`;
      try {
        const res = await fetchImpl(`${url}/api/v1/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!res.ok) return null;
        const body = (await res.json()) as { version?: unknown; capabilities?: unknown };
        return typeof body.version === 'string' && body.capabilities && typeof body.capabilities === 'object' ? url : null;
      } catch {
        return null;
      }
    }),
  );
  const found = probes.filter((url): url is string => url !== null);
  if (found.length === 0) {
    throw new NoCockpitError(
      `no cezar cockpit found on 127.0.0.1:${DEFAULT_PORTS.first}-${DEFAULT_PORTS.last} — start one with \`npx cezar-run\` in your repo, or pass --url / set CEZ_API_URL`,
    );
  }
  const here = canonical(cwd);
  const matches = await Promise.all(found.map(async (url) => ({ url, projectId: await projectHolding(fetchImpl, url, here, headers) })));
  const mine = matches.filter((m) => m.projectId !== undefined);
  if (mine.length >= 1) return mine[0]!;
  if (found.length === 1) return { url: found[0]! };
  throw new NoCockpitError(
    `several cezar cockpits are running (${found.join(', ')}) and none serves ${here} — pass --url or set CEZ_API_URL to choose one`,
  );
}

export interface CockpitResolverOptions {
  fetch: CezarFetch;
  cwd: string;
  explicitUrl?: string;
  projectId?: string;
  headers?: Record<string, string>;
  /** Inside a cezar task an absent `CEZ_API_URL` means the cockpit withheld it (cockpit-address.ts). */
  insideTask?: boolean;
}

/**
 * The address, found once and kept until a request cannot reach it — then dropped, so the next
 * call discovers again instead of talking to a dead port forever.
 */
export function createCockpitResolver(options: CockpitResolverOptions): () => Promise<Cockpit> {
  let current: Cockpit | undefined;
  const fetchWithDeadline: CezarFetch = async (input, init) => {
    try {
      return await options.fetch(input, init?.signal ? init : { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      if (isConnectionError(error)) current = undefined;
      throw error;
    }
  };
  return async () => {
    if (current) return current;
    let target: DiscoveredCockpit;
    if (options.explicitUrl) target = { url: options.explicitUrl };
    else if (options.insideTask) {
      throw new NoCockpitError(
        'CEZ_API_URL is not set inside this cezar task, so the cockpit withheld its address — pass --url only if you were told to; otherwise stop and report',
      );
    } else target = await discoverCockpit(options.fetch, options.cwd, options.headers);
    current = {
      api: createApiClient({ baseUrl: target.url, fetch: fetchWithDeadline, ...(options.headers ? { headers: options.headers } : {}) }),
      defaultProjectId: options.projectId ?? target.projectId ?? 'default',
    };
    return current;
  };
}

function readOwnVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface StdioStreams {
  stdin: Readable;
  stdout: Writable;
  /** Called once the client has closed stdin (or on SIGINT/SIGTERM). Default: exit 0. */
  onClose: () => void;
}

/** Serve over stdio with the SDK's defaults, which answer both protocol eras: a 2025 client's
 *  `initialize` and a 2026-07-28 client's stateless opening. Never `legacy: 'reject'`. */
export async function serveOnStdio(factory: McpServerFactory, streams?: StdioStreams): Promise<void> {
  const { serveStdio, StdioServerTransport } = await import('@modelcontextprotocol/server/stdio');
  const stdin = streams?.stdin ?? process.stdin;
  const onClose = streams?.onClose ?? (() => process.exit(0));
  const handle = serveStdio(factory, {
    ...(streams ? { transport: new StdioServerTransport(streams.stdin, streams.stdout) } : {}),
    onerror: (error) => console.error(`cez mcp: ${error.message}`),
  });
  // The transport closes itself when the client closes our stdin; leave then, so a keep-alive
  // socket to the cockpit can't hold an orphaned process open.
  let left = false;
  const leave = () => {
    if (left) return;
    left = true;
    void handle.close().finally(onClose);
  };
  stdin.once('end', leave);
  stdin.once('close', leave);
  if (!streams) {
    process.once('SIGINT', leave);
    process.once('SIGTERM', leave);
  }
}

export async function runMcpCommand(
  args: string[],
  env: McpCliEnv = process.env,
  io: McpCliIo = { fetch, log: console.error, error: console.error, cwd: process.cwd(), serve: (factory) => serveOnStdio(factory) },
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        url: { type: 'string' },
        project: { type: 'string' },
        header: { type: 'string', multiple: true },
        'read-only': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (error) {
    io.error(`cez mcp: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    io.log(USAGE);
    return 0;
  }
  let headers: Record<string, string> | undefined;
  try {
    headers = values.header?.length ? Object.fromEntries(values.header.map(parseHeader)) : undefined;
  } catch (error) {
    io.error(`cez mcp: ${(error as Error).message}`);
    return 2;
  }
  const explicitUrl = (values.url ?? env.CEZ_API_URL)?.replace(/\/+$/, '') || undefined;
  if (explicitUrl && !/^https?:\/\//.test(explicitUrl)) {
    io.error(`cez mcp: --url / CEZ_API_URL must be an http(s) URL, got "${explicitUrl}"`);
    return 2;
  }
  const projectId = values.project ?? env.CEZ_PROJECT_ID;
  const cockpit = createCockpitResolver({
    fetch: io.fetch,
    cwd: io.cwd,
    ...(explicitUrl ? { explicitUrl } : {}),
    ...(projectId ? { projectId } : {}),
    ...(headers ? { headers } : {}),
    insideTask: Boolean(env.CEZ_TASK_ID),
  });
  const options = { cockpit, version: readOwnVersion(), readOnly: values['read-only'] };
  await io.serve(() => buildMcpServer(options));
  return 0;
}
