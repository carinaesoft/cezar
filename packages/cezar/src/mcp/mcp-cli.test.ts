import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport, ReadBuffer, serializeMessage, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client';
import type { McpServerFactory } from '@modelcontextprotocol/server';
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
const health = () => json({ version: '0.15.0', capabilities: {}, repoRoot: '/x' });

/** A fetch answering like cockpits on the given ports, each serving the given project roots. */
function cockpits(byPort: Record<number, Array<{ id: string; root: string }>>, probed: string[] = []) {
  return async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    probed.push(url.href);
    const projects = byPort[Number(url.port)];
    if (!projects) throw new TypeError('fetch failed');
    if (url.pathname === '/api/v1/health') return health();
    if (url.pathname === '/api/v1/projects') return json({ bootProject: projects[0]?.id ?? 'x', projectsDir: '/', projects });
    return json({ error: 'not found' }, 404);
  };
}

describe('cockpit discovery', () => {
  it('probes 4321–4370 and takes the only cockpit, whatever it serves', async () => {
    const probed: string[] = [];
    expect(await discoverCockpit(cockpits({ 4330: [{ id: 'a', root: '/work/a' }] }, probed), '/elsewhere')).toEqual({ url: 'http://127.0.0.1:4330' });
    expect(probed).toContain('http://127.0.0.1:4321/api/v1/health');
    expect(probed).toContain('http://127.0.0.1:4370/api/v1/health');
    expect(probed).not.toContain('http://127.0.0.1:4371/api/v1/health');
  });

  it('with several cockpits, takes the one with a project holding the cwd, and that project', async () => {
    const fetchImpl = cockpits({
      4321: [{ id: 'other', root: '/work/other' }],
      4322: [
        { id: 'mono', root: '/work/mono' },
        { id: 'pkg', root: '/work/mono/packages/pkg' },
      ],
    });
    expect(await discoverCockpit(fetchImpl, '/work/mono/packages/pkg/src')).toEqual({ url: 'http://127.0.0.1:4322', projectId: 'pkg' });
    expect(await discoverCockpit(fetchImpl, '/work/mono/docs')).toEqual({ url: 'http://127.0.0.1:4322', projectId: 'mono' });
    // a sibling whose name merely starts the same is not inside the root
    await expect(discoverCockpit(fetchImpl, '/work/monorepo')).rejects.toThrow(/several cezar cockpits.*--url/);
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

  it('with nothing listening, says how to fix it', async () => {
    await expect(discoverCockpit(cockpits({}), '/')).rejects.toThrow(/no cezar cockpit found on 127\.0\.0\.1:4321-4370.*--url/);
  });
});

describe('cockpit resolver', () => {
  it('discovers again after a connection error — a cockpit restarted on another port is found', async () => {
    const ports: Record<number, Array<{ id: string; root: string }>> = { 4321: [{ id: 'p', root: '/r' }] };
    const requested: string[] = [];
    const resolve = createCockpitResolver({ fetch: cockpits(ports, requested), cwd: '/r' });
    const first = await resolve();
    expect(first.defaultProjectId).toBe('p');
    expect(await resolve()).toBe(first);
    expect((await first.api.api.v1.projects.$get()).status).toBe(200);

    delete ports[4321];
    ports[4340] = [{ id: 'p', root: '/r' }];
    await expect(first.api.api.v1.projects.$get()).rejects.toThrow('fetch failed');
    const second = await resolve();
    expect(second).not.toBe(first);
    expect((await second.api.api.v1.projects.$get()).status).toBe(200);
    expect(requested.at(-1)).toBe('http://127.0.0.1:4340/api/v1/projects');
  });

  it('an explicit URL is never probed for, and --project wins over the cwd', async () => {
    const probed: string[] = [];
    const resolve = createCockpitResolver({
      fetch: cockpits({ 4999: [] }, probed),
      cwd: '/r',
      explicitUrl: 'http://127.0.0.1:4999',
      projectId: 'mine',
    });
    expect((await resolve()).defaultProjectId).toBe('mine');
    expect(probed).toEqual([]);
  });

  it('inside a cezar task without CEZ_API_URL, it does not probe: the cockpit withheld the address', async () => {
    const probed: string[] = [];
    const resolve = createCockpitResolver({ fetch: cockpits({ 4321: [] }, probed), cwd: '/', insideTask: true });
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
  });

  it('--help prints usage and does not start the server', async () => {
    const h = io();
    expect(await runMcpCommand(['--help'], {}, h.harness)).toBe(0);
    expect(h.out[0]).toContain('cez mcp');
    expect(h.out[0]).toContain('npx -y cezar-run mcp');
    expect(h.factories).toHaveLength(0);
  });

  it.each([[['--nope']], [['--header', 'bad']], [['--url', 'ftp://x']]])('%j exits 2 without serving', async (args) => {
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
