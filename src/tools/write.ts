import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ApiError } from '../api.js';
import { canWrite } from '../claims.js';
import { errorReply, nameList, plural, reply } from '../format.js';
import {
  isSunday,
  matchPerson,
  parseDate,
  resolveClass,
  resolveLeavePolicy,
  ResolveError,
  resolveSubject,
  spokenDate,
  type ClassRef,
  type Person,
} from '../resolve.js';
import { defineTool, DRAFT, type ToolEnv } from './types.js';

/**
 * Every change is two steps, and the second needs the user:
 *
 *   1. `draft_*` validates and resolves everything, then stores the exact
 *      request with sms-backend (`POST /agent/actions`). Nothing changes yet.
 *      The tool returns a one-sentence preview for the user and an action id.
 *   2. `confirm_action` — called only after the user says yes — confirms the
 *      draft and sends the stored request. sms-backend refuses any agent
 *      write that is not a confirmed draft, or that differs from it by a
 *      byte, so a model cannot skip or alter step 1.
 */

interface DraftRequest {
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
}

interface DraftedAction {
  id: string;
  summary: string;
  expiresAt: string;
}

async function draft(
  env: ToolEnv,
  tool: string,
  summary: string,
  req: DraftRequest,
): Promise<DraftedAction> {
  return env.api.post<DraftedAction>('/agent/actions', {
    body: { tool, summary, ...req },
    tool,
  });
}

/**
 * Besides the text for the model, a draft carries `structuredContent.draft`
 * so an agent host can render its own Confirm / Cancel control without
 * parsing prose.
 */
function draftReply(
  env: ToolEnv,
  actions: DraftedAction[],
  summary: string,
  note?: string,
): CallToolResult {
  const ids = actions.map((a) => a.id);
  const preview = `${summary}${note ? ` ${note}` : ''}`;
  // When the host confirms through its own UI, the model is not told about
  // confirm/cancel tools it cannot see.
  const next = env.config.exposeConfirmTool
    ? `Read this to the user and ask them to confirm. Only after a clear yes, call confirm_action with action_ids ${JSON.stringify(ids)}; if they decline, call cancel_action.`
    : 'Tell the user what will happen and ask them to confirm. They confirm or cancel in the app, or by answering yes or no. Do not say it is done.';
  return {
    ...reply(`DRAFT, not saved: ${preview} ${next}`, {
      action_ids: ids,
      expires: actions[0]?.expiresAt,
    }),
    structuredContent: {
      draft: {
        action_ids: ids,
        summary: preview,
        expires_at: actions[0]?.expiresAt ?? null,
      },
    },
  };
}

// ── Attendance ─────────────────────────────────────────────────────────────

const draftAttendance = defineTool({
  name: 'draft_attendance',
  title: 'Draft class attendance',
  description:
    'Prepare attendance for a class-section: everyone present except the students named. Names may be spoken names or roll numbers ("roll 5"). Returns a preview to confirm; nothing is saved until the user confirms.',
  input: {
    class: z.string().max(40).describe('Class-section, e.g. "6B"'),
    date: z.string().max(40).optional().describe('Default today'),
    absent: z.array(z.string().max(80)).max(80).optional(),
    late: z.array(z.string().max(80)).max(80).optional(),
    half_day: z.array(z.string().max(80)).max(80).optional(),
    on_leave: z.array(z.string().max(80)).max(80).optional(),
  },
  annotations: DRAFT,
  available: (ctx, claims) => !!ctx.can.markAttendance && canWrite(claims),
  async run(args, env) {
    const { api, ctx } = env;
    const day = parseDate(args.date, ctx.today, 'past');
    if (day > ctx.today) {
      throw new ResolveError('Attendance cannot be marked for a future date.');
    }
    if (isSunday(day)) {
      throw new ResolveError(
        `${spokenDate(day)} is a Sunday — attendance is not taken on Sundays.`,
      );
    }
    const ref = resolveClass(ctx, args.class, true);
    const [roster, existing] = await Promise.all([
      api.get<{ strength: number; students: Person[] }>('/agent/roster', {
        query: { classId: ref.classId, sectionId: ref.sectionId },
        tool: 'draft_attendance',
      }),
      api.get<{ marked: boolean; takenBy?: string }>(
        '/agent/attendance/class',
        {
          query: { classId: ref.classId, sectionId: ref.sectionId, date: day },
          tool: 'draft_attendance',
        },
      ),
    ]);
    if (!roster.students.length) {
      throw new ResolveError(`${ref.label} has no students on the roll.`);
    }
    if (existing.marked && !ctx.can.editMarkedAttendance) {
      throw new ResolveError(
        `${ref.label}'s attendance for ${spokenDate(day)} was already taken${existing.takenBy ? ` by ${existing.takenBy}` : ''}. Only an admin can change it.`,
      );
    }

    const statusOf = new Map<number, string>();
    const names = new Map<string, string[]>();
    const problems: string[] = [];
    const lists: [string, string[] | undefined][] = [
      ['ABSENT', args.absent],
      ['LATE', args.late],
      ['HALF_DAY', args.half_day],
      ['LEAVE', args.on_leave],
    ];
    for (const [status, list] of lists) {
      for (const said of list ?? []) {
        const m = matchPerson(roster.students, said);
        if (m.kind === 'none') {
          problems.push(`"${said}" is not on ${ref.label}'s roll`);
        } else if (m.kind === 'many') {
          problems.push(
            `"${said}" could be ${m.candidates.map((c) => `${c.name} (roll ${c.rollNo ?? '?'})`).join(' or ')}`,
          );
        } else if (statusOf.has(m.person.id)) {
          problems.push(`${m.person.name} is named twice`);
        } else {
          statusOf.set(m.person.id, status);
          names.set(status, [...(names.get(status) ?? []), m.person.name]);
        }
      }
    }
    if (problems.length) {
      throw new ResolveError(`Please clarify: ${problems.join('; ')}.`);
    }

    const students = roster.students.map((s) => ({
      studentId: s.id,
      status: statusOf.get(s.id) ?? 'PRESENT',
    }));
    const present = students.filter((s) =>
      ['PRESENT', 'LATE', 'HALF_DAY'].includes(s.status),
    ).length;
    const detail = [
      ['ABSENT', 'absent'],
      ['LATE', 'late'],
      ['HALF_DAY', 'half day'],
      ['LEAVE', 'on leave'],
    ]
      .filter(([k]) => names.get(k!)?.length)
      .map(([k, label]) => `${label}: ${nameList(names.get(k!)!, 6)}`);
    const summary = `Mark attendance for ${ref.label} on ${spokenDate(day)}: ${present} of ${students.length} present${detail.length ? `; ${detail.join('; ')}` : ', nobody absent'}. Parents will be notified.`;
    const overwrite = existing.marked
      ? `This replaces the attendance already taken${existing.takenBy ? ` by ${existing.takenBy}` : ''}.`
      : undefined;

    const action = await draft(env, 'draft_attendance', `${summary}${overwrite ? ` ${overwrite}` : ''}`, {
      method: 'POST',
      path: '/attendance',
      body: {
        date: day,
        classId: ref.classId,
        sectionId: ref.sectionId,
        students,
      },
    });
    return draftReply(env, [action], summary, overwrite);
  },
});

// ── Homework ───────────────────────────────────────────────────────────────

const draftHomework = defineTool({
  name: 'draft_homework',
  title: 'Draft homework',
  description:
    'Prepare homework for one or more classes. A class without a section ("6") means all its sections. Returns a preview to confirm; nothing is sent until the user confirms.',
  input: {
    classes: z
      .array(z.string().max(40))
      .min(1)
      .max(8)
      .describe('e.g. ["6A","6B"] or ["7"]'),
    subject: z.string().max(60),
    task: z.string().min(3).max(2000).describe('The homework, as given'),
    date: z.string().max(40).optional().describe('Homework date, default today'),
  },
  annotations: DRAFT,
  available: (ctx, claims) => !!ctx.can.setHomework && canWrite(claims),
  async run({ classes, subject, task, date }, env) {
    const { ctx } = env;
    const day = parseDate(date, ctx.today);
    const refs: ClassRef[] = [];
    for (const c of classes) {
      const ref = resolveClass(ctx, c);
      if (ref.sectionId) {
        refs.push(ref);
      } else {
        const cls = ctx.classes.find((k) => k.id === ref.classId)!;
        for (const s of cls.sections) {
          refs.push({
            classId: cls.id,
            sectionId: s.id,
            label: `${cls.name}-${s.name}`,
          });
        }
      }
    }
    const unique = [
      ...new Map(refs.map((r) => [`${r.classId}:${r.sectionId}`, r])).values(),
    ];
    if (unique.length > 8) {
      throw new ResolveError('That is more than 8 sections — split it up.');
    }
    const subjectName = resolveSubject(ctx, subject);
    const summary = `Send ${subjectName} homework to ${nameList(unique.map((r) => r.label), 8)} dated ${spokenDate(day)}: "${task.length > 160 ? `${task.slice(0, 157)}…` : task}". Parents will be notified.`;
    const actions: DraftedAction[] = [];
    for (const r of unique) {
      actions.push(
        await draft(env, 'draft_homework', summary, {
          method: 'POST',
          path: '/homework/bulk',
          body: {
            classId: r.classId,
            sectionId: r.sectionId,
            homeworkDate: day,
            entries: [{ subject: subjectName, message: task }],
          },
        }),
      );
    }
    return draftReply(env, actions, summary);
  },
});

// ── Leave: apply for myself ────────────────────────────────────────────────

const draftLeaveApplication = defineTool({
  name: 'draft_leave_application',
  title: 'Draft my leave application',
  description:
    "Prepare a leave application for the user themself (leave type like 'casual' or 'CL'). Returns a preview with their balance; nothing is submitted until the user confirms.",
  input: {
    leave_type: z.string().max(40),
    from: z.string().max(40).describe('First day, e.g. "Friday"'),
    to: z.string().max(40).optional().describe('Last day; default same day'),
    half_day: z.boolean().optional(),
    reason: z.string().min(3).max(500),
  },
  annotations: DRAFT,
  available: (ctx, claims) =>
    !!ctx.can.selfServiceHr &&
    ctx.me.staffId !== null &&
    ctx.leavePolicies.length > 0 &&
    canWrite(claims),
  async run({ leave_type, from, to, half_day, reason }, env) {
    const { api, ctx } = env;
    const policy = resolveLeavePolicy(ctx, leave_type);
    const fromDate = parseDate(from, ctx.today);
    const toDate = to ? parseDate(to, ctx.today) : fromDate;
    if (toDate < fromDate) throw new ResolveError('The leave ends before it starts.');
    if (half_day && toDate !== fromDate) {
      throw new ResolveError('A half-day leave must be a single day.');
    }
    const mine = await api.get<{
      staffId: number;
      balances: { policyId: number; available: number }[];
    }>('/agent/me/leaves', { tool: 'draft_leave_application' });
    const balance = mine.balances.find((b) => b.policyId === policy.id);
    const when =
      toDate === fromDate
        ? `${spokenDate(fromDate)}${half_day ? ' (half day)' : ''}`
        : `${spokenDate(fromDate)} to ${spokenDate(toDate)}`;
    const summary = `Apply for ${policy.name} (${policy.code}) on ${when}. Reason: ${reason}.${balance ? ` Available balance: ${balance.available} days.` : ''}`;
    const action = await draft(env, 'draft_leave_application', summary, {
      method: 'POST',
      path: '/hr/staff-leaves',
      body: {
        staffId: mine.staffId,
        leavePolicyId: policy.id,
        fromDate,
        toDate,
        leaveDuration: half_day ? 'HALF_DAY' : 'FULL_DAY',
        reason,
      },
    });
    return draftReply(env, [action], summary);
  },
});

const draftCancelMyLeave = defineTool({
  name: 'draft_cancel_my_leave',
  title: 'Draft cancelling my leave',
  description:
    "Prepare cancelling one of the user's own leave applications (id from my_leaves).",
  input: { request_id: z.number().int().positive() },
  annotations: DRAFT,
  available: (ctx, claims) =>
    !!ctx.can.selfServiceHr && ctx.me.staffId !== null && canWrite(claims),
  async run({ request_id }, env) {
    const mine = await env.api.get<{
      recent: {
        id: number;
        policy: string | null;
        from: string;
        to: string;
        status: string;
      }[];
    }>('/agent/me/leaves', { tool: 'draft_cancel_my_leave' });
    const leave = mine.recent.find((l) => l.id === request_id);
    if (!leave) {
      throw new ResolveError(
        `Leave ${request_id} is not among your recent applications.`,
      );
    }
    if (!['PENDING', 'APPROVED'].includes(leave.status)) {
      throw new ResolveError(`That leave is already ${leave.status.toLowerCase()}.`);
    }
    const summary = `Cancel your ${leave.policy ?? ''} leave from ${spokenDate(leave.from)} to ${spokenDate(leave.to)} (currently ${leave.status.toLowerCase()}).`;
    const action = await draft(env, 'draft_cancel_my_leave', summary, {
      method: 'PATCH',
      path: `/hr/staff-leaves/${request_id}/cancel`,
    });
    return draftReply(env, [action], summary);
  },
});

// ── Leave decisions ────────────────────────────────────────────────────────

interface PendingStudentLeave {
  id: number;
  student: string;
  class: string | null;
  from: string;
  to: string;
  type: string;
  status: string;
  next: 'first-approve' | 'second-approve';
}
interface PendingStaffLeave {
  id: number;
  staff: string;
  policy: string | null;
  from: string;
  to: string;
  days: number;
  lossOfPay: number;
}

const draftLeaveDecision = defineTool({
  name: 'draft_leave_decision',
  title: 'Draft a leave approval or rejection',
  description:
    'Prepare approving or rejecting a pending leave request (id and kind from pending_leaves). Rejection needs a reason. Nothing changes until the user confirms.',
  input: {
    request_id: z.number().int().positive(),
    kind: z.enum(['student', 'staff']),
    decision: z.enum(['approve', 'reject']),
    reason: z.string().max(500).optional().describe('Required to reject'),
  },
  annotations: DRAFT,
  available: (ctx, claims) =>
    !!(ctx.can.firstApproveStudentLeave || ctx.can.approveStaffLeave) &&
    canWrite(claims),
  async run({ request_id, kind, decision, reason }, env) {
    const { api, ctx } = env;
    const pending = await api.get<{
      student?: { requests: PendingStudentLeave[] };
      staff?: { requests: PendingStaffLeave[] };
    }>('/agent/leaves/pending', {
      query: { type: kind, limit: 50 },
      tool: 'draft_leave_decision',
    });
    const range = (f: string, t: string) =>
      f === t ? spokenDate(f) : `${spokenDate(f)} to ${spokenDate(t)}`;

    if (kind === 'student') {
      const leave = pending.student?.requests.find((l) => l.id === request_id);
      if (!leave) {
        throw new ResolveError(
          `Student leave ${request_id} is not waiting on you. Check pending_leaves.`,
        );
      }
      const who = `${leave.student}${leave.class ? ` (${leave.class})` : ''}`;
      const what = `${leave.type.replace(/_/g, ' ').toLowerCase()} for ${range(leave.from, leave.to)}`;
      if (decision === 'reject') {
        if (!reason?.trim()) throw new ResolveError('What is the reason for rejecting?');
        const summary = `Reject ${who}'s ${what}. Reason: ${reason}.`;
        const action = await draft(env, 'draft_leave_decision', summary, {
          method: 'PATCH',
          path: `/leaves/${request_id}/reject`,
          body: { rejectionReason: reason },
        });
        return draftReply(env, [action], summary);
      }
      const final = leave.next === 'second-approve';
      if (final && !ctx.can.finalApproveStudentLeave) {
        throw new ResolveError('Final approval needs an admin.');
      }
      const summary = `${final ? 'Give final approval to' : 'Approve (first approval)'} ${who}'s ${what}.${final ? ' Attendance for those days will be marked as leave.' : ''}`;
      const action = await draft(env, 'draft_leave_decision', summary, {
        method: 'PATCH',
        path: `/leaves/${request_id}/${leave.next}`,
      });
      return draftReply(env, [action], summary);
    }

    const leave = pending.staff?.requests.find((l) => l.id === request_id);
    if (!leave) {
      throw new ResolveError(
        `Staff leave ${request_id} is not waiting on you. Check pending_leaves.`,
      );
    }
    const what = `${leave.staff}'s ${leave.policy ?? ''} leave for ${range(leave.from, leave.to)} (${plural(leave.days, 'day')}${leave.lossOfPay ? `, ${leave.lossOfPay} loss of pay` : ''})`;
    const summary =
      decision === 'approve'
        ? `Approve ${what}.`
        : `Reject ${what}.${reason ? ` Reason: ${reason}.` : ''}`;
    const action = await draft(env, 'draft_leave_decision', summary, {
      method: 'PATCH',
      path: `/hr/staff-leaves/${request_id}/${decision}`,
      body: decision === 'reject' && reason ? { rejectionReason: reason } : undefined,
    });
    return draftReply(env, [action], summary);
  },
});

// ── Confirm / cancel ───────────────────────────────────────────────────────

const actionIds = z
  .array(z.string().uuid())
  .min(1)
  .max(8)
  .describe('action_ids from the draft');

interface Executable {
  summary: string;
  status: string;
  request: DraftRequest;
}

const confirmAction = defineTool({
  name: 'confirm_action',
  title: 'Confirm and carry out a drafted change',
  description:
    'Carries out drafted changes. Call ONLY after the user has heard the draft preview and clearly said yes.',
  input: { action_ids: actionIds },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  available: (_ctx, claims, config) => config.exposeConfirmTool && canWrite(claims),
  async run({ action_ids }, env) {
    const done: string[] = [];
    const failed: string[] = [];
    for (const id of action_ids) {
      try {
        const exec = await env.api.post<Executable>(
          `/agent/actions/${id}/confirm`,
          { tool: 'confirm_action' },
        );
        await env.api.request(exec.request.method, exec.request.path, {
          body: exec.request.body ?? undefined,
          actionId: id,
          tool: 'confirm_action',
        });
        done.push(exec.summary);
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : 'failed';
        failed.push(`${id.slice(0, 8)}: ${msg}`);
      }
    }
    const uniqueDone = [...new Set(done)];
    if (!failed.length) {
      return reply(`Done. ${uniqueDone.join(' ')}`.replace(/Parents will be notified\./g, 'Parents have been notified.'));
    }
    const text = `${done.length ? `Done: ${uniqueDone.join(' ')} ` : ''}Not done (${failed.length}): ${failed.join('; ')}`;
    return done.length ? reply(text) : errorReply(text);
  },
});

const cancelAction = defineTool({
  name: 'cancel_action',
  title: 'Discard a drafted change',
  description: 'Discards drafted changes the user declined.',
  input: { action_ids: actionIds },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  // With host-side confirmation, discarding is the host's job too.
  available: (_ctx, claims, config) => config.exposeConfirmTool && canWrite(claims),
  async run({ action_ids }, env): Promise<CallToolResult> {
    for (const id of action_ids) {
      await env.api.post(`/agent/actions/${id}/cancel`, { tool: 'cancel_action' });
    }
    return reply(`Discarded ${plural(action_ids.length, 'draft')}. Nothing was changed.`);
  },
});

export const WRITE_TOOLS = [
  draftAttendance,
  draftHomework,
  draftLeaveApplication,
  draftCancelMyLeave,
  draftLeaveDecision,
  confirmAction,
  cancelAction,
];

