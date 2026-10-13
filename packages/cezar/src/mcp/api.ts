/**
 * The HTTP side of the MCP server: a typed client for a running cockpit's `/api/v1`.
 *
 * `hc<AppType>` straight from `hono/client` rather than `createCezarClient` — `packages/cezar` must
 * not import the private api-client at runtime (AGENTS.md), and the wrapper is five lines of this.
 * `AppType` is a type-only import, so nothing from `server.ts` is loaded by `cezar mcp`.
 *
 * The same client serves both transports: stdio hands it the global `fetch` aimed at a discovered
 * cockpit, the HTTP endpoint hands it `app.request` so every call goes through the very handlers,
 * validators and origin guard a browser would hit.
 */
import { hc } from 'hono/client';
import type { ClientResponse } from 'hono/client';
import type { SuccessStatusCode } from 'hono/utils/http-status';
import type { AppType } from '../server/app-type.ts';

export type CezarFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CezarApiOptions {
  baseUrl: string;
  fetch: CezarFetch;
  /** Extra headers on every request — e.g. the Basic/Cloudflare Access header a hosted cockpit's proxy wants. */
  headers?: Record<string, string>;
}

export type CezarClient = ReturnType<typeof hc<AppType>>;

export function createApiClient(options: CezarApiOptions): CezarClient {
  return hc<AppType>(options.baseUrl, {
    fetch: options.fetch,
    ...(options.headers ? { headers: options.headers } : {}),
  });
}

/** A non-2xx answer from the cockpit, carrying the route's own one-line `{error}` when it sent one. */
export class CezarApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CezarApiError';
  }
}

/** The 2xx JSON member of a typed response union (same rule as the api-client's `Ok`, which this
 *  package may not import). */
export type Ok<R> = R extends ClientResponse<infer T, infer S, 'json'> ? (S extends SuccessStatusCode ? T : never) : never;

/** Read a JSON body, turning a non-2xx into a `CezarApiError` with the server's reason. */
// `any`s: Hono's own ClientResponse type parameters — narrowing them would reject real routes.
export async function readJson<R extends ClientResponse<any, any, any>>(res: R): Promise<Ok<R>> {
  if (res.ok) return (await res.json()) as Ok<R>;
  let reason = `${res.status} ${res.statusText}`.trim();
  try {
    const body = (await res.json()) as { error?: unknown };
    if (body && typeof body === 'object' && typeof body.error === 'string') reason = `${res.status}: ${body.error}`;
  } catch {
    // not JSON — keep the status line
  }
  throw new CezarApiError(res.status, reason);
}

export interface SseFrame {
  event: string;
  id?: string;
  data: string;
}

/**
 * A minimal `text/event-stream` reader — enough for `/runs/:id/events`, which only ever sends
 * `event:`, `id:` and single-line `data:` fields. Stops when the body ends or the caller's signal
 * aborts; the caller breaks out of the loop to disconnect (the stream never ends on its own).
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame: SseFrame = { event: 'message', data: '' };
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') frame.event = value;
          else if (field === 'id') frame.id = value;
          else if (field === 'data') data.push(value);
        }
        frame.data = data.join('\n');
        if (data.length > 0 || frame.event !== 'message') yield frame;
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
    await body.cancel().catch(() => {});
  }
}
