import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SmsApi } from './api.js';
import { canWrite, type AgentClaims } from './claims.js';
import type { Config } from './config.js';
import type { ContextCache } from './context.js';
import { READ_TOOLS } from './tools/read.js';
import { explainError, type ToolDef } from './tools/types.js';
import { WRITE_TOOLS } from './tools/write.js';

export const ALL_TOOLS: ToolDef[] = [...READ_TOOLS, ...WRITE_TOOLS];

export const SERVER_INFO = { name: 'sms-mcp', version: '0.1.0' };

function instructions(
  schoolName: string | undefined,
  writes: boolean,
  modelConfirms: boolean,
) {
  const lines = [
    `Tools for staff of ${schoolName ?? 'the school'} (school management system).`,
    'Pass things as the user says them — classes like "6B", students by name, dates like "Friday"; the server resolves them and asks back if ambiguous.',
    'Every result starts with a one-line summary suitable for reading aloud; keep answers short.',
    'Answer only from what results state. The summary line carries the totals: quote them, never add up or estimate from table rows. Data not entered yet (attendance not marked, no marks) is not zero; say it is not recorded. If a result lacks what was asked, say so rather than guess.',
    'Fee information is read-only: the assistant cannot take or record payments.',
  ];
  if (writes) {
    lines.push(
      modelConfirms
        ? 'Changes are two-step: a draft_* tool returns a preview and action_ids; read the preview to the user and call confirm_action only after they clearly agree. Never say a change is done until confirm_action reports "Done".'
        : 'Changes are two-step: a draft_* tool returns a preview; the user confirms or cancels it in the app (or by saying yes or no). Never say a change is done unless told "Done".',
    );
  }
  return lines.join('\n');
}

export interface SessionInput {
  token: string;
  claims: AgentClaims;
  config: Config;
  contexts: ContextCache;
}

/**
 * Builds an MCP server for one user session. Only the tools this user may
 * actually use are listed: every tool definition costs tokens on every turn,
 * so a teacher sees ~12 tools and a principal ~20 instead of all of them.
 */
export async function createSessionServer({
  token,
  claims,
  config,
  contexts,
}: SessionInput): Promise<McpServer> {
  const api = new SmsApi(
    config.smsApiUrl,
    token,
    claims.slug,
    config.requestTimeoutMs,
  );
  const ctx = await contexts.get(claims.agentSessionId ?? token, api);

  const server = new McpServer(SERVER_INFO, {
    instructions: instructions(ctx.school.name, canWrite(claims), config.exposeConfirmTool),
  });

  for (const tool of ALL_TOOLS) {
    if (!tool.available(ctx, claims, config)) continue;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: tool.annotations,
      },
      async (args: unknown) => {
        try {
          return await tool.run(args as never, { api, claims, ctx, config });
        } catch (err) {
          return explainError(err);
        }
      },
    );
  }
  return server;
}
