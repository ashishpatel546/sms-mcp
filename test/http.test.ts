import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createHttpApp, keyMatches } from '../src/http.js';

let close: (() => void) | undefined;
afterEach(() => close?.());

async function start(env: Record<string, string>) {
  const app = createHttpApp(loadConfig({ SMS_API_URL: 'http://sms.test', ...env }));
  const server = await new Promise<import('node:http').Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  close = () => server.close();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

const call = (url: string, headers: Record<string, string>) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as { error?: { message: string } } }));

describe('shared key', () => {
  it('compares in constant time and is off when unset', () => {
    expect(keyMatches('', undefined)).toBe(true);
    expect(keyMatches('s3cret', 's3cret')).toBe(true);
    expect(keyMatches('s3cret', 's3cre')).toBe(false);
    expect(keyMatches('s3cret', undefined)).toBe(false);
  });

  it('refuses callers without the key before looking at the token', async () => {
    const url = await start({ MCP_SHARED_SECRET: 's3cret' });
    const noKey = await call(url, { Authorization: 'Bearer x.y.z' });
    expect(noKey.status).toBe(401);
    expect(noKey.body.error?.message).toBe('Unknown caller.');
    const withKey = await call(url, { 'X-MCP-Key': 's3cret' });
    expect(withKey.status).toBe(401);
    expect(withKey.body.error?.message).toBe('Missing agent token.');
  });
});
