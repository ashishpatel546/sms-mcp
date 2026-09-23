#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SmsApi } from './api.js';
import { requireAgentClaims } from './claims.js';
import { loadConfig, type Config } from './config.js';
import { ContextCache } from './context.js';
import { createHttpApp } from './http.js';
import { createSessionServer } from './server.js';

/**
 * stdio mode is for local use (MCP Inspector, Claude Desktop, testing): one
 * user, token from the environment. With SMS_USER_TOKEN + SMS_SCHOOL_SLUG it
 * exchanges the user's session token for an agent token at startup.
 */
async function runStdio(config: Config) {
  let token = config.stdioAgentToken;
  if (!token && config.stdioUserToken && config.stdioSchoolSlug) {
    const api = new SmsApi(
      config.smsApiUrl,
      config.stdioUserToken,
      config.stdioSchoolSlug,
      config.requestTimeoutMs,
    );
    token = (await api.post<{ token: string }>('/agent/session', { body: {} }))
      .token;
  }
  if (!token) {
    throw new Error(
      'Set SMS_AGENT_TOKEN, or SMS_USER_TOKEN and SMS_SCHOOL_SLUG, for stdio mode.',
    );
  }
  const claims = requireAgentClaims(token);
  const server = await createSessionServer({
    token,
    claims,
    config,
    contexts: new ContextCache(config.contextTtlMs),
  });
  await server.connect(new StdioServerTransport());
}

function runHttp(config: Config) {
  const app = createHttpApp(config);
  app.listen(config.port, config.host, () => {
    console.log(
      `[sms-mcp] listening on http://${config.host}:${config.port}/mcp → ${config.smsApiUrl}`,
    );
  });
}

const config = loadConfig();
if (process.argv.includes('--stdio')) {
  runStdio(config).catch((err: Error) => {
    console.error(`[sms-mcp] ${err.message}`);
    process.exit(1);
  });
} else {
  runHttp(config);
}
