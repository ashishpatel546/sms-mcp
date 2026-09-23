import type {
  CallToolResult,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { ApiError, type SmsApi } from '../api.js';
import type { AgentClaims } from '../claims.js';
import type { Config } from '../config.js';
import { errorReply } from '../format.js';
import { ResolveError, type SchoolContext } from '../resolve.js';

/** Everything a tool handler gets. */
export interface ToolEnv {
  api: SmsApi;
  claims: AgentClaims;
  ctx: SchoolContext;
  config: Config;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  /** Kept short on purpose: every listed description costs tokens per turn. */
  description: string;
  input: S;
  annotations: ToolAnnotations;
  /** Whether to list this tool for this user at all. */
  available(ctx: SchoolContext, claims: AgentClaims, config: Config): boolean;
  run(args: z.infer<z.ZodObject<S>>, env: ToolEnv): Promise<CallToolResult>;
}

/** Keeps each tool's argument types while collecting them in one array. */
export const defineTool = <S extends z.ZodRawShape>(def: ToolDef<S>) =>
  def as unknown as ToolDef;

export const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

/** Drafting stores a pending proposal only — no school data changes. */
export const DRAFT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/** Converts failures into messages the model can relay or act on. */
export function explainError(err: unknown): CallToolResult {
  if (err instanceof ResolveError) return errorReply(err.message);
  if (err instanceof ApiError) {
    switch (err.status) {
      case 401:
        return errorReply(
          'The assistant session has expired. The user needs to start a new session.',
        );
      case 402:
        return errorReply(
          err.message ||
            "This school's AI Assistant credits for the month are used up. An administrator can add more.",
        );
      case 403:
      case 400:
      case 404:
      case 409:
        return errorReply(err.message);
      default:
        return errorReply(
          err.status >= 500
            ? 'The school system had a problem answering. Try again in a moment.'
            : err.message,
        );
    }
  }
  return errorReply(
    'Something went wrong while handling that request. Try again in a moment.',
  );
}
