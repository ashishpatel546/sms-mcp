import { randomUUID } from 'node:crypto';

export type Query = Record<string, string | number | boolean | undefined | null>;

/** A non-2xx answer from sms-backend, with the message it gave. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** MCP tool on whose behalf the call is made — recorded in usage. */
  tool?: string;
  /** Confirmed drafted action this write executes. */
  actionId?: string;
}

/**
 * Thin client for sms-backend, bound to one agent token and school.
 * Every call carries the tenant header and the tool name so the backend can
 * attribute usage per tool.
 */
export class SmsApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly schoolSlug: string,
    private readonly timeoutMs = 20_000,
  ) {}

  get<T>(path: string, opts: RequestOptions = {}) {
    return this.request<T>('GET', path, opts);
  }

  post<T>(path: string, opts: RequestOptions = {}) {
    return this.request<T>('POST', path, opts);
  }

  async request<T>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'X-School-Slug': this.schoolSlug,
      'X-Agent-Call-Id': randomUUID(),
      Accept: 'application/json',
    };
    if (opts.tool) headers['X-Agent-Tool'] = opts.tool;
    if (opts.actionId) headers['X-Agent-Action-Id'] = opts.actionId;
    const hasBody = opts.body !== undefined && opts.body !== null;
    if (hasBody) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: hasBody ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason =
        (err as Error).name === 'TimeoutError'
          ? 'timed out'
          : 'could not be reached';
      throw new ApiError(503, `The school system ${reason}. Try again shortly.`);
    }

    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const payload = (data ?? {}) as {
        message?: string | string[];
        code?: string;
      };
      const message = Array.isArray(payload.message)
        ? payload.message.join('; ')
        : (payload.message ?? `Request failed (${res.status}).`);
      throw new ApiError(res.status, message, payload.code);
    }
    return data as T;
  }
}
