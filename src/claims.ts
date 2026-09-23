/**
 * Claims of an sms-backend agent token (minted by `POST /agent/session`).
 *
 * The MCP server decodes but does not verify the token: it never holds the
 * signing secret. Decoding is only used to pick the tenant header and to
 * choose which tools to list; every data call is verified by sms-backend,
 * which also confines agent tokens to the agent API and meters them.
 */
export interface AgentClaims {
  sub: number;
  role: string;
  roles?: string[];
  firstName?: string;
  lastName?: string;
  schoolId: number;
  slug: string;
  agent?: boolean;
  agentSessionId?: string;
  agentScopes?: string[];
  exp?: number;
}

export class TokenError extends Error {}

export function decodeClaims(token: string): AgentClaims {
  const part = token.split('.')[1];
  if (!part) throw new TokenError('Malformed token.');
  let claims: AgentClaims;
  try {
    claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new TokenError('Malformed token.');
  }
  if (!claims || typeof claims !== 'object' || !claims.slug) {
    throw new TokenError('Token carries no school.');
  }
  return claims;
}

/** Throws unless this is an unexpired agent token. */
export function requireAgentClaims(token: string, now = Date.now()) {
  const claims = decodeClaims(token);
  if (!claims.agent) {
    throw new TokenError(
      'Not an agent token. Exchange the user session at POST /agent/session first.',
    );
  }
  if (claims.exp && claims.exp * 1000 <= now) {
    throw new TokenError('Agent token expired. Start a new assistant session.');
  }
  return claims;
}

export function canWrite(claims: AgentClaims): boolean {
  return claims.agentScopes?.includes('write') ?? false;
}
