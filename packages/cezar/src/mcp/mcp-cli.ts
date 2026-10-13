/**
 * `cezar mcp` — an MCP server on stdio for agents that run OUTSIDE cezar (Claude Code, Codex,
 * OpenCode…), so they can list, start, follow and cancel runs of a running cockpit.
 *
 * It is a client of the cockpit's `/api/v1`, like `cez task`: run state lives only in the cockpit
 * process, so this never opens a store of its own. The cockpit is found without configuration —
 * `--url`, else `CEZ_API_URL` (set for every agent cezar itself spawns), else a probe of
 * `GET /api/v1/health` on the ports the cockpit picks from (4321–4370). Discovery is lazy: the MCP
 * handshake always succeeds and a missing cockpit is a readable tool error, so a client does not
 * mark the server broken just because the cockpit was started second.
 *
 * stdout carries JSON-RPC and nothing else; every diagnostic goes to stderr.
 */
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServerFactory } from '@modelcontextprotocol/server';
import { createApiClient, type CezarClient, type CezarFetch } from './api.ts';
import { buildMcpServer } from './tools.ts';

export const DEFAULT_PORTS = { first: 4321, last: 4370 } as const;

const USAGE = `cezar mcp — MCP server (stdio) for a running cezar cockpit

  cezar mcp [--url <http://127.0.0.1:4321>] [--project <id>] [--header "Name: value"]… [--read-only]

  --url        cockpit to talk to (default: $CEZ_API_URL, else the first cockpit found on 127.0.0.1:4321-4370)
  --project    default project for tools that take one (default: $CEZ_PROJECT_ID, else the boot project)
  --header     extra HTTP header for a cockpit behind a proxy (Basic auth, Cloudflare Access); repeatable
  --read-only  register only the read tools (no start_run / cancel_run)

  Claude Code:  claude mcp add cezar -- npx -y @open-mercato/cezar mcp`;

export interface McpCliEnv {
  CEZ_API_URL?: string;
  CEZ_PROJECT_ID?: string;
}

export interface McpCliIo {
  fetch: CezarFetch;
  log: (line: string) => void;
  error: (line: string) => void;
  /** Starts the stdio transport — injected so the CLI parsing is testable without a real stdin. */
  serve: (server: McpServerFactory) => Promise<void>;
}

export class NoCockpitError extends Error {}

/** `"Name: value"` → `[name, value]`; the header name is whatever precedes the first colon. */
export function parseHeader(raw: string): [string, string] {
  const colon = raw.indexOf(':');
  if (colon <= 0) throw new Error(`--header must look like "Name: value", got "${raw}"`);
  return [raw.slice(0, colon).trim(), raw.slice(colon + 1).trim()];
}

interface HealthProbe {
  url: string;
  repoRoot?: string;
}

/**
 * Probe every port the cockpit may have picked, in parallel, and keep the ones answering like a
 * cockpit (`version` + `capabilities`). With several, prefer the one whose repo contains `cwd` —
 * the cockpit the user most likely means — else the lowest port.
 */
export async function discoverCockpit(fetchImpl: CezarFetch, cwd: string, timeoutMs = 800): Promise<string> {
  const ports: number[] = [];
  for (let p = DEFAULT_PORTS.first; p <= DEFAULT_PORTS.last; p += 1) ports.push(p);
  const probes = await Promise.all(
    ports.map(async (port): Promise<HealthProbe | null> => {
      const url = `http://127.0.0.1:${port}`;
      try {
        const res = await fetchImpl(`${url}/api/v1/health`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return null;
        const body = (await res.json()) as { version?: unknown; capabilities?: unknown; repoRoot?: unknown };
        if (typeof body.version !== 'string' || !body.capabilities) return null;
        return { url, ...(typeof body.repoRoot === 'string' ? { repoRoot: body.repoRoot } : {}) };
      } catch {
        return null;
      }
    }),
  );
  const found = probes.filter((p): p is HealthProbe => p !== null);
  if (found.length === 0) {
    throw new NoCockpitError(
      `no cezar cockpit found on 127.0.0.1:${DEFAULT_PORTS.first}-${DEFAULT_PORTS.last} — start one with \`npx @open-mercato/cezar\` in your repo, or pass --url / set CEZ_API_URL`,
    );
  }
  const here = resolve(cwd);
  const mine = found.find((p) => p.repoRoot && (here === p.repoRoot || here.startsWith(`${p.repoRoot}/`)));
  return (mine ?? found[0]!).url;
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

async function serveOnStdio(factory: McpServerFactory): Promise<void> {
  const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
  const handle = serveStdio(factory, { onerror: (error) => console.error(`cezar mcp: ${error.message}`) });
  // The transport closes itself when the client closes our stdin; leave then, so a keep-alive
  // socket to the cockpit can't hold an orphaned process open.
  const leave = () => void handle.close().finally(() => process.exit(0));
  process.stdin.once('end', leave);
  process.once('SIGINT', leave);
  process.once('SIGTERM', leave);
}

export async function runMcpCommand(
  args: string[],
  env: McpCliEnv = process.env,
  io: McpCliIo = { fetch, log: console.error, error: console.error, serve: serveOnStdio },
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
    io.error(`cezar mcp: ${(error as Error).message}\n\n${USAGE}`);
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
    io.error(`cezar mcp: ${(error as Error).message}`);
    return 2;
  }

  const explicit = (values.url ?? env.CEZ_API_URL)?.replace(/\/+$/, '');
  let client: CezarClient | undefined;
  const api = async (): Promise<CezarClient> => {
    if (client) return client;
    const baseUrl = explicit ?? (await discoverCockpit(io.fetch, process.cwd()));
    client = createApiClient({ baseUrl, fetch: io.fetch, ...(headers ? { headers } : {}) });
    return client;
  };
  const options = {
    api,
    defaultProjectId: values.project ?? env.CEZ_PROJECT_ID ?? 'default',
    version: readOwnVersion(),
    readOnly: values['read-only'],
  };
  const debug = process.env.CEZ_MCP_DEBUG === '1';
  await io.serve((ctx) => {
    if (debug) io.error(`cezar mcp: ${ctx.era} era`);
    return buildMcpServer(options);
  });
  return 0;
}
