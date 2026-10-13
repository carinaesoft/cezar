import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport, ReadBuffer, serializeMessage, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client';
import type { McpServerFactory } from '@modelcontextprotocol/server';
import { longDeadline, type CezarFetch as CezarFetchLike } from './api.ts';
import {
  createCockpitResolver,
  discoverCockpit,
  parseHeader,
  runMcpCommand,
  serveOnStdio,
  type McpCliIo,
} from './mcp-cli.ts';

/** `cez mcp` flags, cockpit discovery and the stdio transport (#1109). The tool set has its own
 *  tests (`tools.test.ts`, `tools.routes.test.ts`). */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const health = (repoRoot = 'x') => json({ version: '0.15.0', capabilities: {}, repoRoot });

type Project = { id: string; root: string };

/**
 * A fetch answering like cockpits on the given ports. Like real cockpits on one machine they share
 * ONE project registry (`~/.cezar`); what differs is the project each was booted in. A port may
 * instead carry its own registry, as a cockpit with its own `CEZ_HOME` does.
 */
function cockpits(
  shared: Project[],
  bootByPort: Record<number, string | { boot: string; registry: Project[] }>,
  probed: string[] = [],
) {
  return async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    probed.push(url.href);
    const entry = bootByPort[Number(url.port)];
    if (entry === undefined) throw new TypeError('fetch failed');
    const { boot, registry } = typeof entry === 'string' ? { boot: entry, registry: shared } : entry;
    if (url.pathname === '/api/v1/health') return health();
    if (url.pathname === '/api/v1/projects') return json({ bootProject: boot, projectsDir: '/', projects: registry });
    return json({ error: 'not found' }, 404);
  };
}

const REGISTRY: Project[] = [
  { id: 'other', root: '/work/other' },
  { id: 'mono', root: '/work/mono' },
  { id: 'pkg', root: '/work/mono/packages/pkg' },
];

describe('cockpit discovery', () => {
  it('probes 4321–4370 and takes the only cockpit, whatever it serves', async () => {
    const probed: string[] = [];
    expect(await discoverCockpit(cockpits([{ id: 'a', root: '/work/a' }], { 4330: 'a' }, probed), '/elsewhere')).toEqual({ url: 'http://127.0.0.1:4330', bootProject: 'a' });
    expect(probed).toContain('http://127.0.0.1:4321/api/v1/health');
    expect(probed).toContain('http://127.0.0.1:4370/api/v1/health');
    expect(probed).not.toContain('http://127.0.0.1:4371/api/v1/health');
  });

  it('with several cockpits on one shared registry, takes the one booted deepest around the cwd', async () => {
    // Every cockpit "has" every project; only the boot project tells them apart.
    const fetchImpl = cockpits(REGISTRY, { 4321: 'other', 4322: 'mono', 4323: 'pkg' });
    expect(await discoverCockpit(fetchImpl, '/work/mono/packages/pkg/src')).toEqual({ url: 'http://127.0.0.1:4323', projectId: 'pkg', bootProject: 'pkg' });
    expect(await discoverCockpit(fetchImpl, '/work/mono/docs')).toEqual({ url: 'http://127.0.0.1:4322', projectId: 'mono', bootProject: 'mono' });
    expect(await discoverCockpit(fetchImpl, '/work/other')).toEqual({ url: 'http://127.0.0.1:4321', projectId: 'other', bootProject: 'other' });
    // a sibling whose name merely starts the same is not inside the root
    await expect(discoverCockpit(fetchImpl, '/work/monorepo')).rejects.toThrow(/several cezar cockpits.*none was started in \/work\/monorepo.*--url/);
  });

  it('a project no cockpit was booted in is ambiguous, not the lowest port', async () => {
    const fetchImpl = cockpits(REGISTRY, { 4321: 'other', 4322: 'pkg' });
    await expect(discoverCockpit(fetchImpl, '/work/mono/docs')).rejects.toThrow(/several cezar cockpits.*--url/);
  });

  it('two cockpits booted in the same project are ambiguous', async () => {
    const fetchImpl = cockpits(REGISTRY, { 4321: 'mono', 4345: 'mono' });
    await expect(discoverCockpit(fetchImpl, '/work/mono')).rejects.toThrow(
      /http:\/\/127\.0\.0\.1:4321 and http:\/\/127\.0\.0\.1:4345 were all started in \/work\/mono — pass --url/,
    );
  });

  it('cockpits with separate registries: the only one holding the cwd', async () => {
    const fetchImpl = cockpits([], {
      4321: { boot: 'x', registry: [{ id: 'x', root: '/work/x' }] },
      4322: { boot: 'y', registry: [{ id: 'y', root: '/work/y' }, { id: 'z', root: '/work/z' }] },
    });
    expect(await discoverCockpit(fetchImpl, '/work/z/src')).toEqual({ url: 'http://127.0.0.1:4322', projectId: 'z', bootProject: 'y' });
  });

  it('a cockpit booted in an unregistered root is matched by its /health repoRoot', async () => {
    const fetchImpl = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.port !== '4321' && url.port !== '4322') throw new TypeError('fetch failed');
      if (url.pathname === '/api/v1/health') return health(url.port === '4322' ? '/work/wt' : '/work/other');
      return json({ bootProject: url.port === '4322' ? 'wt' : 'other', projectsDir: '/', projects: [{ id: 'other', root: '/work/other' }] });
    };
    expect(await discoverCockpit(fetchImpl, '/work/wt/src')).toEqual({ url: 'http://127.0.0.1:4322', bootProject: 'wt' });
  });

  it('ignores a port that answers but is not a cockpit', async () => {
    const fetchImpl = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.port === '4321') return new Response('<html>', { status: 200 });
      if (url.port === '4325') return url.pathname.endsWith('/health') ? health() : json({ projects: [] });
      throw new TypeError('fetch failed');
    };
    expect(await discoverCockpit(fetchImpl, '/')).toEqual({ url: 'http://127.0.0.1:4325' });
  });

  it('a port that is slow on the first probe gets a second, longer one — and nothing waits when all answer', async () => {
    const base = cockpits(REGISTRY, { 4321: 'other', 4345: 'mono' });
    let healthProbes = 0;
    const slow: CezarFetchLike = async (input, init) => {
      const url = new URL(String(input));
      if (url.port === '4345' && url.pathname === '/api/v1/health' && (healthProbes += 1) === 1) {
        // misses the first deadline, answers well inside the second
        await new Promise((r) => setTimeout(r, 1_200));
        if (init?.signal?.aborted) throw init.signal.reason;
      }
      return base(input);
    };
    const result = await discoverCockpit(slow, '/work/mono');
    expect(result).toEqual({ url: 'http://127.0.0.1:4345', projectId: 'mono', bootProject: 'mono' });
    expect(healthProbes).toBe(2);
    const started = Date.now();
    await discoverCockpit(base, '/work/mono');
    expect(Date.now() - started).toBeLessThan(500);
  }, 15_000);

  it('a port that stalls on both probes is named, and the choice is marked incomplete', async () => {
    const base = cockpits(REGISTRY, { 4321: 'other', 4345: 'mono' });
    const stall: CezarFetchLike = (input, init) =>
      new URL(String(input)).port === '4345'
        ? new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
        : base(input);
    const result = await discoverCockpit(stall, '/work/mono');
    expect(result.url).toBe('http://127.0.0.1:4321');
    expect(result.incomplete).toEqual([expect.stringMatching(/^127\.0\.0\.1:4345 accepted a connection but did not answer/)]);
    // nothing else answering: the error names the stalled port instead of "no cockpit"
    const onlyStalled: CezarFetchLike = (input, init) =>
      new URL(String(input)).port === '4345' ? stall(input, init) : Promise.reject(new TypeError('fetch failed'));
    await expect(discoverCockpit(onlyStalled, '/work/mono')).rejects.toThrow(/no cezar cockpit answered.*127\.0\.0\.1:4345 accepted a connection/);
  }, 15_000);

  it('with nothing listening, says how to fix it', async () => {
    await expect(discoverCockpit(cockpits([], {}), '/')).rejects.toThrow(/no cezar cockpit found on 127\.0\.0\.1:4321-4370.*--url/);
  });
});

describe('cockpit resolver', () => {
  it('discovers again after a connection error — a cockpit restarted on another port is found', async () => {
    const ports: Record<number, string> = { 4321: 'p' };
    const requested: string[] = [];
    const resolve = createCockpitResolver({ fetch: cockpits([{ id: 'p', root: '/r' }], ports, requested), cwd: '/r' });
    const first = await resolve();
    expect(first.defaultProjectId).toBe('p');
    expect(await resolve()).toBe(first);
    expect((await first.api.api.v1.projects.$get()).status).toBe(200);

    delete ports[4321];
    ports[4340] = 'p';
    await expect(first.api.api.v1.projects.$get()).rejects.toThrow('fetch failed');
    const second = await resolve();
    expect(second).not.toBe(first);
    expect((await second.api.api.v1.projects.$get()).status).toBe(200);
    expect(requested.at(-1)).toBe('http://127.0.0.1:4340/api/v1/projects');
  });

  it('two concurrent first calls share one discovery', async () => {
    const probed: string[] = [];
    const resolve = createCockpitResolver({ fetch: cockpits([{ id: 'p', root: '/r' }], { 4321: 'p' }, probed), cwd: '/r' });
    const [a, b] = await Promise.all([resolve(), resolve()]);
    expect(a).toBe(b);
    expect(probed.filter((u) => u === 'http://127.0.0.1:4321/api/v1/health')).toHaveLength(1);
  });

  it('a failed discovery is not kept: the next call tries again', async () => {
    const ports: Record<number, string> = {};
    const resolve = createCockpitResolver({ fetch: cockpits([{ id: 'p', root: '/r' }], ports), cwd: '/r' });
    await expect(resolve()).rejects.toThrow(/no cezar cockpit found/);
    ports[4321] = 'p';
    expect((await resolve()).defaultProjectId).toBe('p');
  });

  it('an explicit URL is never probed for, and still serves the project holding the cwd', async () => {
    const probed: string[] = [];
    const fetchImpl = cockpits(REGISTRY, { 4999: 'other' }, probed);
    const resolve = createCockpitResolver({ fetch: fetchImpl, cwd: '/work/mono/packages/pkg', explicitUrl: 'http://127.0.0.1:4999' });
    expect((await resolve()).defaultProjectId).toBe('pkg');
    expect(probed).toEqual(['http://127.0.0.1:4999/api/v1/projects']);
    // no project holds the cwd: the boot project, by its id
    const outside = createCockpitResolver({ fetch: fetchImpl, cwd: '/tmp/elsewhere', explicitUrl: 'http://127.0.0.1:4999' });
    expect(await outside()).toMatchObject({ defaultProjectId: 'other' });
    expect((await outside()).projectUnknown).toBeUndefined();
  });

  it('an unreadable registry is not kept, and leaves the project unknown instead of guessing the boot project', async () => {
    // re-QA of #1109: a 503 on the first /projects pinned the session to the boot project.
    let projectsCalls = 0;
    const warnings: string[] = [];
    const base = cockpits(REGISTRY, { 4999: 'other' });
    const resolve = createCockpitResolver({
      fetch: async (input, init) => {
        if (String(input).endsWith('/api/v1/projects') && (projectsCalls += 1) === 1) return json({ error: 'busy' }, 503);
        return base(input);
      },
      cwd: '/work/mono',
      explicitUrl: 'http://127.0.0.1:4999',
      warn: (line) => warnings.push(line),
    });
    const first = await resolve();
    expect(first.defaultProjectId).toBe('default');
    expect(first.projectUnknown).toMatch(/could not read the project list of http:\/\/127\.0\.0\.1:4999 \(503\).*pass projectId/);
    expect(warnings).toEqual([expect.stringMatching(/4999 did not list its projects \(503\).*this call only/)]);
    const second = await resolve();
    expect(second).not.toBe(first);
    expect(second.defaultProjectId).toBe('mono');
    expect(second.projectUnknown).toBeUndefined();
    expect(await resolve()).toBe(second);
  });

  it('a discovery that had to skip a stalled port is not kept, and says which port', async () => {
    let stalled = true;
    const warnings: string[] = [];
    const base = cockpits(REGISTRY, { 4321: 'other', 4345: 'mono' });
    const resolve = createCockpitResolver({
      fetch: (input, init) =>
        stalled && new URL(String(input)).port === '4345'
          ? new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
          : base(input),
      cwd: '/work/mono',
      warn: (line) => warnings.push(line),
    });
    const first = await resolve();
    expect(first.defaultProjectId).toBe('mono');
    expect(warnings).toEqual([expect.stringMatching(/127\.0\.0\.1:4345 accepted a connection but did not answer .*this call only/)]);
    stalled = false;
    const second = await resolve();
    expect(second).not.toBe(first);
    expect(await resolve()).toBe(second);
    expect(warnings).toHaveLength(1);
  }, 15_000);

  it('--project wins over the cwd, without asking the registry', async () => {
    const probed: string[] = [];
    const resolve = createCockpitResolver({
      fetch: cockpits(REGISTRY, { 4999: 'other' }, probed),
      cwd: '/work/mono',
      explicitUrl: 'http://127.0.0.1:4999',
      projectId: 'mine',
    });
    expect((await resolve()).defaultProjectId).toBe('mine');
    expect(probed).toEqual([]);
  });

  it('a request keeps its deadline when the caller passes a signal of its own', async () => {
    const stall: CezarFetchLike = (_input, init) =>
      new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    const resolve = createCockpitResolver({ fetch: stall, cwd: '/', explicitUrl: 'http://127.0.0.1:4999', projectId: 'p', requestTimeoutMs: 100 });
    const { api } = await resolve();
    const never = new AbortController();
    const started = Date.now();
    await expect(api.api.v1.projects.$get(undefined, { init: { signal: never.signal } })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('a longDeadline signal is not shortened by the default deadline', async () => {
    const seen: AbortSignal[] = [];
    const resolve = createCockpitResolver({
      fetch: async (_input, init) => {
        seen.push(init!.signal!);
        return json({});
      },
      cwd: '/',
      explicitUrl: 'http://127.0.0.1:4999',
      projectId: 'p',
    });
    const { api } = await resolve();
    const long = longDeadline(30_000);
    await api.api.v1.projects.$get(undefined, { init: { signal: long } });
    expect(seen[0]).toBe(long);
  });

  it('inside a cezar task without CEZ_API_URL, it does not probe: the cockpit withheld the address', async () => {
    const probed: string[] = [];
    const resolve = createCockpitResolver({ fetch: cockpits([], { 4321: 'x' }, probed), cwd: '/', insideTask: true });
    await expect(resolve()).rejects.toThrow(/CEZ_API_URL is not set inside this cezar task/);
    expect(probed).toEqual([]);
  });
});

describe('cez mcp flags', () => {
  const io = (overrides: Partial<McpCliIo> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const factories: McpServerFactory[] = [];
    const harness: McpCliIo = {
      fetch: async () => json({}),
      log: (l) => out.push(l),
      error: (l) => err.push(l),
      cwd: '/',
      serve: async (factory) => {
        factories.push(factory);
      },
      ...overrides,
    };
    return { harness, out, err, factories };
  };

  it('parses --header as "Name: value" and refuses anything else', () => {
    expect(parseHeader('Authorization: Basic abc:def')).toEqual(['Authorization', 'Basic abc:def']);
    expect(() => parseHeader('nocolon')).toThrow(/Name: value/);
    expect(() => parseHeader(' : x')).toThrow(/Name: value/);
    expect(() => parseHeader('Bad Name: x')).toThrow(/Name: value/);
  });

  it('--help prints usage and does not start the server', async () => {
    const h = io();
    expect(await runMcpCommand(['--help'], {}, h.harness)).toBe(0);
    expect(h.out[0]).toContain('cez mcp');
    expect(h.out[0]).toContain('npx -y cezar-run mcp');
    expect(h.factories).toHaveLength(0);
  });

  it.each([[['--nope']], [['--header', 'bad']], [['--header', ' : x']], [['--url', 'ftp://x']], [['--url', '']], [['--url', ' ']]])('%j exits 2 without serving', async (args) => {
    const h = io();
    expect(await runMcpCommand(args, {}, h.harness)).toBe(2);
    expect(h.factories).toHaveLength(0);
  });

  it('serves without contacting any cockpit: discovery waits for the first tool call', async () => {
    const calls: string[] = [];
    const h = io({
      fetch: async (input) => {
        calls.push(String(input));
        return json({});
      },
    });
    expect(await runMcpCommand([], { CEZ_API_URL: 'http://127.0.0.1:4999/' }, h.harness)).toBe(0);
    expect(h.factories).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it('--read-only reaches the server: no write tools', async () => {
    const h = io();
    await runMcpCommand(['--read-only'], {}, h.harness);
    const server = await h.factories[0]!({ era: 'legacy' } as Parameters<McpServerFactory>[0]);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(clientSide);
    const names = (await client.listTools()).tools.map((t) => t.name);
    await client.close();
    expect(names).not.toContain('start_run');
    expect(names).not.toContain('cancel_run');
    expect(names).toContain('wait_for_runs');
  });
});

/** A client-side newline-delimited JSON-RPC transport over a pair of streams — the shape of a
 *  stdio pipe, without spawning a process. */
class PipeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly buffer = new ReadBuffer();
  constructor(
    private readonly input: PassThrough,
    private readonly output: PassThrough,
  ) {}
  async start() {
    this.input.on('data', (chunk: Buffer) => {
      this.buffer.append(chunk);
      for (let message = this.buffer.readMessage(); message; message = this.buffer.readMessage()) this.onmessage?.(message);
    });
  }
  async send(message: JSONRPCMessage) {
    this.output.write(serializeMessage(message));
  }
  async close() {
    this.output.end();
    this.onclose?.();
  }
}

describe('cez mcp over stdio', () => {
  const open: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((close) => close()));
  });

  /** Runs the real `runMcpCommand` + `serveOnStdio` over in-memory pipes. */
  async function start(args: string[] = []) {
    const toServer = new PassThrough();
    const fromServer = new PassThrough();
    let closed = 0;
    const stdout: string[] = [];
    fromServer.on('data', (chunk: Buffer) => stdout.push(chunk.toString('utf8')));
    await runMcpCommand(args, { CEZ_API_URL: 'http://127.0.0.1:9' }, {
      fetch: async () => {
        throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') });
      },
      log: () => {},
      error: () => {},
      cwd: '/',
      serve: (factory) => serveOnStdio(factory, { stdin: toServer, stdout: fromServer, onClose: () => (closed += 1) }),
    });
    return { toServer, fromServer, stdout, closed: () => closed };
  }

  it.each([
    ['2025 (initialize handshake: Codex, OpenCode)', 'legacy' as const, /^2025-/],
    ['2026-07-28 (Claude Code)', 'auto' as const, /^2026-07-28$/],
  ])('serves the %s era', async (_, mode, version) => {
    const pipes = await start();
    const client = new Client({ name: 'era-test', version: '0' }, { versionNegotiation: { mode } });
    await client.connect(new PipeTransport(pipes.fromServer, pipes.toServer));
    open.push(() => client.close());
    expect(client.getNegotiatedProtocolVersion()).toMatch(version);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('start_run');
    // no cockpit behind it: still a tool answer, not a broken server
    const result = await client.callTool({ name: 'list_projects', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe('cannot reach the cezar cockpit (connect ECONNREFUSED 127.0.0.1:9)');
    // stdout carried nothing but JSON-RPC
    for (const line of pipes.stdout.join('').split('\n').filter(Boolean)) expect(JSON.parse(line)).toHaveProperty('jsonrpc', '2.0');
  });

  it('leaves when the client closes stdin', async () => {
    const pipes = await start();
    pipes.toServer.end();
    await new Promise((r) => setTimeout(r, 50));
    expect(pipes.closed()).toBe(1);
  });
});
