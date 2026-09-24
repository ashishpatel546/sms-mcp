import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentClaims } from '../src/claims.js';
import { loadConfig } from '../src/config.js';
import { ContextCache } from '../src/context.js';
import type { SchoolContext } from '../src/resolve.js';
import { createSessionServer } from '../src/server.js';
import { makeContext } from './fixtures.js';

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
  headers: Record<string, string>;
}

/** A fake sms-backend: records every call and answers from a route table. */
function fakeBackend(ctx: SchoolContext, routes: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL, init: RequestInit) => {
      const u = new URL(url);
      const call: Call = {
        method: init.method ?? 'GET',
        path: u.pathname,
        query: Object.fromEntries(u.searchParams),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        headers: init.headers as Record<string, string>,
      };
      calls.push(call);
      const key = `${call.method} ${call.path}`;
      const data =
        key === 'GET /agent/context'
          ? ctx
          : typeof routes[key] === 'function'
            ? (routes[key] as (c: Call) => unknown)(call)
            : routes[key];
      if (data === undefined) {
        return new Response(JSON.stringify({ message: `no route ${key}` }), {
          status: 404,
        });
      }
      return new Response(JSON.stringify(data), { status: 200 });
    }),
  );
  return calls;
}

const claims = (over: Partial<AgentClaims> = {}): AgentClaims => ({
  sub: 7,
  role: 'TEACHER',
  schoolId: 1,
  slug: 'edusphere',
  agent: true,
  agentSessionId: crypto.randomUUID(),
  agentScopes: ['read', 'write'],
  ...over,
});

async function connect(c: AgentClaims, env: Record<string, string> = {}) {
  const config = loadConfig({ SMS_API_URL: 'http://sms.test', ...env });
  const server = await createSessionServer({
    token: 'x.eyJ9.y',
    claims: c,
    config,
    contexts: new ContextCache(60_000),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (r: any) => r.content[0].text as string;

describe('sms-mcp server', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('tool listing follows what the user may do', () => {
    it('gives a teacher teacher tools only', async () => {
      fakeBackend(makeContext());
      const tools = (await (await connect(claims())).listTools()).tools.map(
        (t) => t.name,
      );
      expect(tools).toContain('draft_attendance');
      expect(tools).toContain('draft_homework');
      expect(tools).toContain('draft_leave_application');
      expect(tools).not.toContain('fee_status');
      expect(tools).not.toContain('staff_attendance');
    });

    it('hides every change tool from a read-only session', async () => {
      fakeBackend(makeContext());
      const tools = (
        await (await connect(claims({ agentScopes: ['read'] }))).listTools()
      ).tools.map((t) => t.name);
      expect(tools.filter((t) => t.startsWith('draft_') || t.endsWith('_action'))).toEqual([]);
      expect(tools).toContain('daily_briefing');
    });

    it('can leave confirmation to the host UI', async () => {
      fakeBackend(makeContext());
      const client = await connect(claims(), { MCP_EXPOSE_CONFIRM_TOOL: 'false' });
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toContain('draft_attendance');
      expect(tools).not.toContain('confirm_action');
      expect(tools).not.toContain('cancel_action');
      expect(client.getInstructions()).not.toContain('confirm_action');
      expect(client.getInstructions()).toContain('confirms or cancels it in the app');
    });

    it('marks reads read-only and confirm as destructive', async () => {
      fakeBackend(makeContext());
      const { tools } = await (await connect(claims())).listTools();
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      expect(byName.find_students!.annotations?.readOnlyHint).toBe(true);
      expect(byName.confirm_action!.annotations?.destructiveHint).toBe(true);
    });
  });

  describe('draft → confirm', () => {
    let calls: Call[];
    beforeEach(() => {
      calls = fakeBackend(makeContext(), {
        'GET /agent/roster': {
          strength: 3,
          students: [
            { id: 101, rollNo: 1, name: 'Riya Sharma' },
            { id: 102, rollNo: 2, name: 'Aman Gupta' },
            { id: 103, rollNo: 3, name: 'Kabir Das' },
          ],
        },
        'GET /agent/attendance/class': { marked: false },
        'POST /agent/actions': (c: Call) => ({
          id: '11111111-1111-4111-8111-111111111111',
          summary: c.body.summary,
          expiresAt: '2026-09-24T10:15:00Z',
        }),
        'POST /agent/actions/11111111-1111-4111-8111-111111111111/confirm': {
          summary: 'Mark attendance for Class 6-B …',
          status: 'CONFIRMED',
          request: { method: 'POST', path: '/attendance', body: { date: 'x' } },
        },
        'POST /attendance': { id: 5 },
      });
    });

    it('drafts attendance from spoken names without writing anything', async () => {
      const client = await connect(claims());
      const r = await client.callTool({
        name: 'draft_attendance',
        arguments: { class: 'six b', absent: ['aman', 'roll 3'] },
      });
      expect(text(r)).toMatch(
        /^DRAFT, not saved: Mark attendance for Class 6-B on Thu 24 Sep: 1 of 3 present; absent: Aman Gupta and Kabir Das\./,
      );
      const drafted = calls.find((c) => c.path === '/agent/actions')!;
      expect(drafted.body).toMatchObject({
        tool: 'draft_attendance',
        method: 'POST',
        path: '/attendance',
        body: {
          date: '2026-09-24',
          classId: 9,
          sectionId: 2,
          students: [
            { studentId: 101, status: 'PRESENT' },
            { studentId: 102, status: 'ABSENT' },
            { studentId: 103, status: 'ABSENT' },
          ],
        },
      });
      expect(calls.some((c) => c.path === '/attendance')).toBe(false);
      expect(r.structuredContent).toMatchObject({
        draft: {
          action_ids: [expect.any(String)],
          summary: expect.stringMatching(/^Mark attendance for Class 6-B/),
        },
      });
    });

    it('asks back instead of guessing an unknown or ambiguous name', async () => {
      const client = await connect(claims());
      const r = await client.callTool({
        name: 'draft_attendance',
        arguments: { class: '6B', absent: ['Zoya'] },
      });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain(`"Zoya" is not on Class 6-B's roll`);
      expect(calls.some((c) => c.path === '/agent/actions')).toBe(false);
    });

    it('confirm_action executes exactly the stored request, tagged with the action', async () => {
      const client = await connect(claims());
      const r = await client.callTool({
        name: 'confirm_action',
        arguments: { action_ids: ['11111111-1111-4111-8111-111111111111'] },
      });
      expect(text(r)).toMatch(/^Done\./);
      const write = calls.find((c) => c.path === '/attendance')!;
      expect(write.body).toEqual({ date: 'x' });
      expect(write.headers['X-Agent-Action-Id']).toBe(
        '11111111-1111-4111-8111-111111111111',
      );
      expect(write.headers['X-School-Slug']).toBe('edusphere');
    });

    it('drafts a leave span from a day count ("parson se 2 din")', async () => {
      fakeBackend(makeContext(), {
        'GET /agent/me/leaves': {
          staffId: 21,
          balances: [{ policyId: 12, available: 12 }],
        },
        'POST /agent/actions': (c: Call) => ({
          id: '11111111-1111-4111-8111-111111111111',
          summary: c.body.summary,
          expiresAt: '2026-09-24T10:15:00Z',
        }),
      });
      const client = await connect(claims());
      const r = await client.callTool({
        name: 'draft_leave_application',
        arguments: { leave_type: 'sick', from: 'parson', days: 2, reason: 'fever' },
      });
      expect(text(r)).toContain('on Sat 26 Sep to Sun 27 Sep');
    });

    it('refuses to draft attendance on a Sunday', async () => {
      const client = await connect(claims());
      const r = await client.callTool({
        name: 'draft_attendance',
        arguments: { class: '6B', date: 'last sunday' },
      });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('Sunday');
    });
  });

  it('turns a credit-exhausted backend answer into a plain message', async () => {
    fakeBackend(makeContext());
    vi.mocked(fetch).mockImplementation(async (url: any) =>
      new URL(url).pathname === '/agent/context'
        ? new Response(JSON.stringify(makeContext()))
        : new Response(
            JSON.stringify({
              statusCode: 402,
              code: 'AGENT_CREDITS_EXHAUSTED',
              message: 'This school has used all 500 AI Assistant credits for 2026-09.',
            }),
            { status: 402 },
          ),
    );
    const client = await connect(claims());
    const r = await client.callTool({ name: 'daily_briefing', arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('used all 500 AI Assistant credits');
  });
});
