import { describe, expect, it } from 'vitest';
import { discoverCockpit, parseHeader, runMcpCommand, type McpCliIo } from './mcp-cli.ts';

/** `cezar mcp` flags and cockpit discovery. The stdio transport itself is the SDK's; the tool set
 *  has its own tests. */
describe('cezar mcp', () => {
  const cockpit = (repoRoot: string) =>
    new Response(JSON.stringify({ version: '0.11.1', capabilities: {}, repoRoot }), { status: 200 });

  it('discovery probes the cockpit port range and prefers the cockpit serving the cwd', async () => {
    const probed: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      probed.push(url);
      if (url.startsWith('http://127.0.0.1:4322/')) return cockpit('/work/other');
      if (url.startsWith('http://127.0.0.1:4330/')) return cockpit('/work/app');
      if (url.startsWith('http://127.0.0.1:4331/')) return new Response('<html>', { status: 200 }); // not a cockpit
      throw new TypeError('fetch failed');
    };
    expect(await discoverCockpit(fetchImpl, '/work/app/packages/x')).toBe('http://127.0.0.1:4330');
    expect(await discoverCockpit(fetchImpl, '/elsewhere')).toBe('http://127.0.0.1:4322');
    expect(probed).toContain('http://127.0.0.1:4321/api/v1/health');
    expect(probed).toContain('http://127.0.0.1:4370/api/v1/health');
    expect(probed).not.toContain('http://127.0.0.1:4371/api/v1/health');
  });

  it('discovery with nothing listening says how to fix it', async () => {
    await expect(
      discoverCockpit(async () => {
        throw new TypeError('fetch failed');
      }, '/'),
    ).rejects.toThrow(/no cezar cockpit found on 127\.0\.0\.1:4321-4370.*--url/);
  });

  it('parses --header as "Name: value" and refuses anything else', () => {
    expect(parseHeader('Authorization: Basic abc:def')).toEqual(['Authorization', 'Basic abc:def']);
    expect(() => parseHeader('nocolon')).toThrow(/Name: value/);
  });

  const io = (overrides: Partial<McpCliIo> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    let served = 0;
    const harness: McpCliIo = {
      fetch: async () => new Response('{}'),
      log: (l) => out.push(l),
      error: (l) => err.push(l),
      serve: async () => {
        served += 1;
      },
      ...overrides,
    };
    return { harness, out, err, served: () => served };
  };

  it('--help prints usage and does not start the server', async () => {
    const h = io();
    expect(await runMcpCommand(['--help'], {}, h.harness)).toBe(0);
    expect(h.out[0]).toContain('cezar mcp');
    expect(h.served()).toBe(0);
  });

  it('an unknown flag or a malformed header exits 2 without serving', async () => {
    const a = io();
    expect(await runMcpCommand(['--nope'], {}, a.harness)).toBe(2);
    const b = io();
    expect(await runMcpCommand(['--header', 'bad'], {}, b.harness)).toBe(2);
    expect(a.served() + b.served()).toBe(0);
  });

  it('serves without contacting any cockpit: discovery waits for the first tool call', async () => {
    const calls: string[] = [];
    const h = io({
      fetch: async (input) => {
        calls.push(String(input));
        return new Response('{}');
      },
    });
    expect(await runMcpCommand([], { CEZ_API_URL: 'http://127.0.0.1:4999/' }, h.harness)).toBe(0);
    expect(h.served()).toBe(1);
    expect(calls).toEqual([]);
  });
});
