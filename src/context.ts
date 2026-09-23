import type { SmsApi } from './api.js';
import type { SchoolContext } from './resolve.js';

interface Entry {
  value: Promise<SchoolContext>;
  expires: number;
}

/**
 * Per-session cache of `GET /agent/context` — who the user is, what they may
 * do, and the school's classes/subjects/leave types. The HTTP transport is
 * stateless (a fresh MCP server per request), so without this every
 * `tools/list` and `tools/call` would refetch it.
 *
 * Keyed by agent session id (one per minted token), so nothing is shared
 * between users or schools. Failures are not cached.
 */
export class ContextCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 5000,
  ) {}

  get(key: string, api: SmsApi): Promise<SchoolContext> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expires > now) return hit.value;

    const value = api.get<SchoolContext>('/agent/context', {
      tool: 'context',
    });
    this.entries.set(key, { value, expires: now + this.ttlMs });
    value.catch(() => this.entries.delete(key));
    this.prune(now);
    return value;
  }

  /** Forget a session's context, e.g. after a change that affects it. */
  invalidate(key: string) {
    this.entries.delete(key);
  }

  private prune(now: number) {
    if (this.entries.size <= this.maxEntries) return;
    for (const [k, e] of this.entries) {
      if (e.expires <= now || this.entries.size > this.maxEntries) {
        this.entries.delete(k);
      }
    }
  }
}
