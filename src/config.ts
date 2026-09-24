/** Runtime configuration, read once from the environment. */
export interface Config {
  /** Base URL of sms-backend, e.g. https://api.colegios.in (no trailing slash). */
  smsApiUrl: string;
  host: string;
  port: number;
  /** Extra Host header values accepted by the HTTP transport (DNS-rebinding protection). */
  allowedHosts: string[];
  /** How long a user's context (classes, roles, capabilities) is reused, in ms. */
  contextTtlMs: number;
  /** Per-call timeout for backend requests, in ms. */
  requestTimeoutMs: number;
  /**
   * Whether to offer `confirm_action`. Hosts that confirm through their own UI
   * (a button in the app) can hide it, so the model can never confirm alone.
   */
  exposeConfirmTool: boolean;
  /**
   * When set, every HTTP request must carry it in `X-MCP-Key`, so only the
   * agent host (sms-agent) can reach this server — on top of the per-user
   * agent token that sms-backend verifies on every call.
   */
  sharedSecret: string;
  /** stdio mode only: an agent token, or a user token to exchange for one. */
  stdioAgentToken?: string;
  stdioUserToken?: string;
  stdioSchoolSlug?: string;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(v: string | undefined, fallback: number): number {
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const smsApiUrl = (env.SMS_API_URL ?? 'http://localhost:4010').replace(
    /\/+$/,
    '',
  );
  return {
    smsApiUrl,
    host: env.MCP_HOST ?? '127.0.0.1',
    port: int(env.MCP_PORT, 4020),
    allowedHosts: (env.MCP_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    contextTtlMs: int(env.MCP_CONTEXT_TTL_SECONDS, 300) * 1000,
    requestTimeoutMs: int(env.MCP_REQUEST_TIMEOUT_MS, 20_000),
    exposeConfirmTool: bool(env.MCP_EXPOSE_CONFIRM_TOOL, true),
    sharedSecret: env.MCP_SHARED_SECRET ?? '',
    stdioAgentToken: env.SMS_AGENT_TOKEN || undefined,
    stdioUserToken: env.SMS_USER_TOKEN || undefined,
    stdioSchoolSlug: env.SMS_SCHOOL_SLUG || undefined,
  };
}
