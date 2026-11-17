// The HTTP server: one dispatcher that reads the request, builds an exchange
// object, and routes it to the surface that owns the path — git smart HTTP,
// REST v3, GraphQL v4, or MCP. Every /api/v3 answer carries an
// X-GitHub-Request-Id header.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { store } from './core.ts';
import { handleRest } from './rest.ts';
import { handleSmart } from './smart.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

class ExchangeImpl {
  readonly method: string;
  readonly segments: string[];
  readonly body: Buffer;
  readonly authed: boolean;
  readonly host: string;
  private readonly req: IncomingMessage;
  private readonly res: ServerResponse;
  private readonly apiV3: boolean;
  private readonly rawQuery: string;
  private queryCache: URLSearchParams | null = null;
  private jsonCache: Record<string, unknown> | null | undefined = undefined;

  constructor(req: IncomingMessage, res: ServerResponse, body: Buffer) {
    this.req = req;
    this.res = res;
    this.body = body;
    this.method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const qIndex = url.indexOf('?');
    const rawPath = qIndex < 0 ? url : url.slice(0, qIndex);
    this.rawQuery = qIndex < 0 ? '' : url.slice(qIndex + 1);
    this.segments = rawPath
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => {
        if (!segment.includes('%')) return segment;
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      });
    const authorization = req.headers.authorization ?? '';
    this.authed = /^bearer\s+\S/i.test(authorization);
    this.host = req.headers.host ?? '127.0.0.1';
    this.apiV3 = this.segments[0] === 'api' && this.segments[1] === 'v3';
  }

  get query(): URLSearchParams {
    if (this.queryCache === null) this.queryCache = new URLSearchParams(this.rawQuery);
    return this.queryCache;
  }

  header(name: string): string | null {
    const value = this.req.headers[name.toLowerCase()];
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  }

  jsonBody(): Record<string, unknown> | null {
    if (this.jsonCache !== undefined) return this.jsonCache;
    try {
      const parsed = JSON.parse(this.body.toString('utf8')) as unknown;
      this.jsonCache = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      this.jsonCache = null;
    }
    return this.jsonCache;
  }

  respond(status: number, body: string | Buffer, contentType: string = JSON_TYPE, headers: Record<string, string> = {}): void {
    const length = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.length;
    const out: Record<string, string> = { ...headers };
    if (status !== 204) {
      out['content-type'] = contentType;
      out['content-length'] = String(length);
    }
    if (this.apiV3) {
      store.requestSeq += 1;
      out['x-github-request-id'] = `LF-${store.requestSeq.toString(36).toUpperCase()}`;
    }
    this.res.writeHead(status, out);
    this.res.end(status === 204 ? undefined : body);
  }

  respondJson(status: number, value: unknown, headers: Record<string, string> = {}): void {
    this.respond(status, JSON.stringify(value), JSON_TYPE, headers);
  }
}

function route(ex: ExchangeImpl): void {
  const seg = ex.segments;
  if (ex.method === 'GET' && seg.length === 1 && seg[0] === 'healthz') {
    ex.respondJson(200, { ok: true });
    return;
  }
  if (seg.length === 1 && seg[0] === 'mcp') {
    if (ex.method !== 'POST') {
      ex.respondJson(405, { message: 'Method Not Allowed' });
      return;
    }
    handleMcp(ex);
    return;
  }
  if (seg.length === 2 && seg[0] === 'api' && seg[1] === 'graphql') {
    if (ex.method !== 'POST') {
      ex.respondJson(405, { message: 'Method Not Allowed' });
      return;
    }
    handleGraphql(ex);
    return;
  }
  if (seg[0] === 'api' && seg[1] === 'v3') {
    handleRest(ex);
    return;
  }
  if (seg.length >= 2 && (seg[1] as string).endsWith('.git')) {
    handleSmart(ex);
    return;
  }
  ex.respondJson(404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks);
      const ex = new ExchangeImpl(req, res, body);
      try {
        route(ex);
      } catch (err) {
        process.stderr.write(`[entry] handler error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
        if (!res.headersSent) ex.respondJson(500, { message: 'Internal Server Error' });
        else res.end();
      }
    });
    req.on('error', () => {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    });
  });
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  return server;
}
