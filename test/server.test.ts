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

  describe('attendance headcount', () => {
    const summary = {
      totalRegisters: 28, taken: 0, pending: 28, students: 105,
      present: 0, absent: 0, late: 0, halfDay: 0, leave: 0, percentage: 0,
    };
    const rows = [{ class: '1-A', marked: false, strength: 4, dayType: 'WORKING' }];

    it('says nobody is counted present when no register is taken', async () => {
      fakeBackend(makeContext(), {
        'GET /agent/attendance/register': { isSunday: false, summary, registers: rows },
      });
      const r = await (await connect(claims())).callTool({ name: 'attendance_register', arguments: {} });
      const first = text(r).split('\n')[0]!;
      expect(first).toContain('0 of 28 class registers taken');
      expect(first).toContain('no attendance marked yet, so present count is unknown (105 students enrolled)');
      expect(text(r)).not.toContain('strength');
    });

    it('gives present, absent and enrolled totals once registers are taken', async () => {
      fakeBackend(makeContext(), {
        'GET /agent/briefing': {
          studentAttendance: {
            ...summary, taken: 3, pending: 25, present: 10, late: 1, absent: 2, leave: 1, percentage: 85,
          },
        },
      });
      const r = await (await connect(claims())).callTool({ name: 'daily_briefing', arguments: {} });
      expect(text(r)).toContain(
        'students: 3 of 28 class registers taken, 11 present, 2 absent, 1 on leave in the marked classes (85% present); 25 classes not marked yet; 105 students enrolled',
      );
    });
  });

  describe('head counts and other basic questions', () => {
    const call = async (name: string, args: Record<string, unknown>, routes: Record<string, unknown>, ctx = makeContext()) => {
      const calls = fakeBackend(ctx, routes);
      const r = await (await connect(claims())).callTool({ name, arguments: args });
      return { r, calls };
    };

    it('lists the new read tools only for users who may use them', async () => {
      fakeBackend(makeContext());
      const tools = (await (await connect(claims())).listTools()).tools.map((t) => t.name);
      for (const t of ['school_overview', 'class_info', 'attendance_trend', 'exam_results', 'on_leave', 'circulars']) {
        expect(tools).toContain(t);
      }
      const guard = makeContext();
      guard.can = Object.fromEntries(Object.keys(guard.can).map((k) => [k, false]));
      fakeBackend(guard);
      const guardTools = (await (await connect(claims({ role: 'GUARD' }))).listTools()).tools.map((t) => t.name);
      expect(guardTools).toContain('circulars');
      for (const t of ['school_overview', 'class_info', 'attendance_trend', 'exam_results', 'on_leave']) {
        expect(guardTools).not.toContain(t);
      }
    });

    it('states the student total instead of leaving it to be added up', async () => {
      const { r } = await call('school_overview', {}, {
        'GET /agent/overview': {
          students: 105, enrolledThisSession: 105, boys: 54, girls: 51, staff: 7, classes: 15, sections: 2,
          byClass: [{ class: 'Class 6-B', enrolled: 7, boys: 2, girls: 5 }],
          staffByRole: [{ role: 'Teacher', count: 7 }],
        },
      });
      expect(text(r).split('\n')[0]).toBe('105 students: 54 boys, 51 girls; 7 staff in all, by designation: 7 Teacher; 15 classes in 1 class-section.');
    });

    it('says when enrolments and accounts disagree', async () => {
      const { r } = await call('school_overview', {}, {
        'GET /agent/overview': {
          students: 105, enrolledThisSession: 101, boys: 50, girls: 51, staff: 7, classes: 15, sections: 2,
          byClass: [], staffByRole: [],
        },
      });
      expect(text(r)).toContain('105 students (101 enrolled in a class this session)');
    });

    it('resolves the class for class_info and names the class teacher', async () => {
      const { r, calls } = await call('class_info', { class: '6B', students: true }, {
        'GET /agent/class': {
          class: 'Class 6-B', classTeacher: 'Sandhya Kumari', strength: 7, boys: 2, girls: 5,
          subjects: [{ subject: 'Maths', teacher: 'Suman Gupta' }],
          students: [{ id: 1, rollNo: 1, name: 'Riya Sharma' }],
        },
      });
      expect(calls.find((c) => c.path === '/agent/class')!.query).toMatchObject({ classId: '9', sectionId: '2', students: 'true' });
      expect(text(r)).toMatch(/^Class 6-B: 7 students \(2 boys, 5 girls\); class teacher Sandhya Kumari\./);
      expect(text(r)).toContain('Riya Sharma');
    });

    it('turns a named period into a date range', async () => {
      const { calls } = await call('attendance_trend', { period: 'this week', class: '6B' }, {
        'GET /agent/attendance/trend': {
          scope: 'Class 6-B', from: '2026-09-21', to: '2026-09-24', daysMarked: 2, daysNotMarked: 2, percentage: 90,
          days: [],
        },
      });
      expect(calls.find((c) => c.path === '/agent/attendance/trend')!.query).toMatchObject({
        from: '2026-09-21', to: '2026-09-24', classId: '9', sectionId: '2',
      });
    });

    it('reports no figures when no attendance was marked in the range', async () => {
      const { r } = await call('attendance_trend', {}, {
        'GET /agent/attendance/trend': {
          scope: 'Whole school', from: '2026-09-18', to: '2026-09-24', daysMarked: 0, daysNotMarked: 6, percentage: null,
          days: [{ date: '2026-09-24', marked: false }],
        },
      });
      expect(text(r)).toBe('Whole school, Fri 18 Sep to Thu 24 Sep: no attendance marked on any day, so there are no figures.');
    });

    it('says when no exam marks exist rather than inventing results', async () => {
      const { r } = await call('exam_results', { class: '6B' }, {
        'GET /agent/exams/results': { scope: 'Class 6-B', session: '2026-2027', exam: null, exams: [] },
      });
      expect(text(r)).toBe('Class 6-B: no exam marks entered this session (2026-2027).');
    });

    it('summarises one exam and names the others', async () => {
      const { r, calls } = await call('exam_results', { exam: 'SA1', subject: 'maths' }, {
        'GET /agent/exams/results': {
          scope: 'Whole school', session: '2026-2027', exam: 'SA1', exams: ['SA1', 'FA1'], students: 40, average: 71.5,
          studentsWithAFail: 3, subjects: [], classes: [], top: [], failed: [],
        },
      });
      const q = calls.find((c) => c.path === '/agent/exams/results')!.query;
      expect(q.exam).toBe('SA1');
      expect(q.subjectId).toBeDefined();
      expect(text(r).split('\n')[0]).toBe('SA1, Whole school: 40 students with marks, average 71.5%; 3 failed at least one subject. Other exams with marks: FA1.');
    });

    it('counts students on leave and flags unapproved requests', async () => {
      const { r } = await call('on_leave', {}, {
        'GET /agent/leaves/on': {
          date: '2026-09-24',
          students: { approved: 2, pendingApproval: 1, list: [{ name: 'Riya Sharma', class: 'Class 6-B' }] },
        },
      });
      expect(text(r).split('\n')[0]).toBe('Thu 24 Sep: 2 students on approved leave (1 more request not yet approved).');
    });

    it('lists circulars matching a word', async () => {
      const { r, calls } = await call('circulars', { search: 'PTM' }, {
        'GET /agent/circulars': { more: false, circulars: [{ title: 'PTM on Saturday', date: '2026-09-20' }] },
      });
      expect(calls.find((c) => c.path === '/agent/circulars')!.query.q).toBe('PTM');
      expect(text(r)).toMatch(/^1 circular matching "PTM"\./);
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
