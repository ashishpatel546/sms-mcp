import { createHash, timingSafeEqual } from 'node:crypto';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { ApiError } from './api.js';
import { requireAgentClaims, TokenError } from './claims.js';
import type { Config } from './config.js';
import { ContextCache } from './context.js';
import { createSessionServer, SERVER_INFO } from './server.js';

const digest = (v: string) => createHash('sha256').update(v).digest();

/** Constant-time check of the X-MCP-Key header against the shared secret. */
export function keyMatches(expected: string, given: unknown): boolean {
  if (!expected) return true;
  return typeof given === 'string' && timingSafeEqual(digest(given), digest(expected));
}

function jsonRpcError(res: Response, status: number, message: string) {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code: status === 401 ? -32001 : -32000, message },
    id: null,
  });
}

/**
 * Streamable HTTP, stateless: every POST builds a server for the caller's
 * token and answers it. Nothing is held between requests except the context
 * cache, so any number of instances can run behind a load balancer.
 *
 * The caller (the agent host) sends `Authorization: Bearer <agent token>` —
 * minted by sms-backend `POST /agent/session` for the signed-in user.
 */
export function createHttpApp(config: Config) {
  const contexts = new ContextCache(config.contextTtlMs);
  const app = createMcpExpressApp({
    host: config.host,
    ...(config.allowedHosts.length
      ? { allowedHosts: config.allowedHosts }
      : {}),
  });

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'ok', ...SERVER_INFO });
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    if (!keyMatches(config.sharedSecret, req.headers['x-mcp-key'])) {
      return jsonRpcError(res, 401, 'Unknown caller.');
    }
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return jsonRpcError(res, 401, 'Missing agent token.');
    }
    let server;
    try {
      const claims = requireAgentClaims(token);
      server = await createSessionServer({ token, claims, config, contexts });
    } catch (err) {
      if (err instanceof TokenError) return jsonRpcError(res, 401, err.message);
      if (err instanceof ApiError) {
        return jsonRpcError(
          res,
          err.status === 401 || err.status === 403 || err.status === 402
            ? err.status
            : 502,
          err.message,
        );
      }
      console.error('[sms-mcp] session setup failed', err);
      return jsonRpcError(res, 500, 'Internal error.');
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[sms-mcp] request failed', err);
      if (!res.headersSent) jsonRpcError(res, 500, 'Internal error.');
    }
  });

  // Stateless server: no standalone SSE stream and no sessions to delete.
  const notAllowed = (_req: Request, res: Response) =>
    jsonRpcError(res, 405, 'Method not allowed.');
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  return app;
}
