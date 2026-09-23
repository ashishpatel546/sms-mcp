import { z } from 'zod';
import { nameList, plural, reply } from '../format.js';
import {
  parseDate,
  resolveClass,
  ResolveError,
  spokenDate,
  type ClassRef,
} from '../resolve.js';
import { defineTool, READ, type ToolEnv } from './types.js';

// ── Shared ────────────────────────────────────────────────────────────────

const classArg = z
  .string()
  .max(40)
  .describe('Class as said, e.g. "6B", "class 6 section B", "UKG A"');
const dateArg = z
  .string()
  .max(40)
  .describe('e.g. "today", "yesterday", "Friday", "24 Sep". Default today');

interface StudentHit {
  id: number;
  name: string;
  class: string;
  rollNo?: number | null;
  admissionNo?: string | null;
}

/**
 * A student reference as the user gave it — an id, an admission/roll number
 * or a name — resolved to exactly one student, or an error naming the
 * candidates so the model can ask which one.
 */
export async function findStudent(
  env: ToolEnv,
  student: string,
  cls?: string,
  tool = 'find_students',
): Promise<StudentHit> {
  const text = student.trim();
  if (/^\d+$/.test(text) && !cls) {
    const res = await env.api.get<{ students: StudentHit[] }>(
      '/agent/students',
      { query: { q: text, limit: 5 }, tool },
    );
    const byAdmission = res.students.filter((s) => s.admissionNo === text);
    if (byAdmission.length === 1) return byAdmission[0]!;
    return { id: Number(text), name: `Student #${text}`, class: '' };
  }
  const ref = cls ? resolveClass(env.ctx, cls) : undefined;
  const res = await env.api.get<{ students: StudentHit[] }>(
    '/agent/students',
    {
      query: {
        q: text,
        classId: ref?.classId,
        sectionId: ref?.sectionId,
        limit: 6,
      },
      tool,
    },
  );
  if (res.students.length === 1) return res.students[0]!;
  if (!res.students.length) {
    throw new ResolveError(
      `No student on the current roll matches "${text}"${ref ? ` in ${ref.label}` : ''}.`,
    );
  }
  const exact = res.students.filter(
    (s) => s.name.toLowerCase() === text.toLowerCase(),
  );
  if (exact.length === 1) return exact[0]!;
  throw new ResolveError(
    `More than one student matches "${text}": ${res.students
      .map((s) => `${s.name} (${s.class}, id ${s.id})`)
      .join('; ')}. Ask which one, then pass the id or the class.`,
  );
}

function classQuery(ref?: ClassRef) {
  return { classId: ref?.classId, sectionId: ref?.sectionId };
}

const trueKeys = (o: Record<string, boolean>) =>
  Object.entries(o)
    .filter(([, v]) => v)
    .map(([k]) => k);

// ── Tools ─────────────────────────────────────────────────────────────────

const myContext = defineTool({
  name: 'my_context',
  title: 'Who am I and what can I do',
  description:
    "The user's name, roles, classes they teach, what they may do, today's date, the school's classes, subjects and leave types. Rarely needed: other tools accept names directly.",
  input: {},
  annotations: READ,
  available: () => true,
  async run(_args, { ctx }) {
    return reply(
      `${ctx.me.name} (${ctx.me.roles.join(', ')}) at ${ctx.school.name}. Today is ${spokenDate(ctx.today)} ${ctx.today.slice(0, 4)}.`,
      {
        designation: ctx.me.designation,
        classTeacherOf: ctx.me.classTeacherOf.map((c) => c.label),
        teaches: ctx.me.teaches.map((t) => `${t.subject} ${t.label}`),
        can: trueKeys(ctx.can),
        session: ctx.session?.name,
        classes: ctx.classes.map(
          (c) => `${c.name}: ${c.sections.map((s) => s.name).join('/')}`,
        ),
        subjects: ctx.subjects.map((s) => s.name),
        leaveTypes: ctx.leavePolicies.map((p) => `${p.code}=${p.name}`),
        creditsLeft: `${ctx.credits.remaining}/${ctx.credits.limit}`,
      },
    );
  },
});

const dailyBriefing = defineTool({
  name: 'daily_briefing',
  title: "Today's briefing",
  description:
    "One-call summary of a day: attendance registers taken/pending, staff attendance, pending leave requests, holidays, exams, events and birthdays — whatever the user may see. Best first call for 'what's happening today'.",
  input: { date: dateArg.optional() },
  annotations: READ,
  available: () => true,
  async run({ date }, { api, ctx }) {
    const day = parseDate(date, ctx.today);
    const b = await api.get<Record<string, any>>('/agent/briefing', {
      query: { date: day },
      tool: 'daily_briefing',
    });
    const parts: string[] = [];
    const sa = b.studentAttendance;
    if (sa) {
      parts.push(
        `${sa.taken} of ${sa.totalRegisters} attendance registers taken${sa.taken ? `, ${sa.percentage}% present` : ''}`,
      );
      if (sa.pendingClasses?.length > 15) {
        const n = sa.pendingClasses.length;
        sa.pendingClasses = [...sa.pendingClasses.slice(0, 15), `+${n - 15} more`];
      }
    }
    const st = b.staffAttendance;
    if (st) {
      parts.push(
        `staff: ${(st.PRESENT ?? 0) + (st.LATE ?? 0)} present, ${st.ABSENT ?? 0} absent, ${st.ON_LEAVE ?? 0} on leave, ${st.NOT_MARKED ?? 0} not marked`,
      );
    }
    const pl = b.pendingLeaveRequests;
    if (pl && (pl.student || pl.staff)) {
      parts.push(
        `${plural((pl.student ?? 0) + (pl.staff ?? 0), 'leave request')} waiting`,
      );
    }
    if (b.today?.holidays?.length) parts.push(`holiday: ${b.today.holidays.join(', ')}`);
    if (b.birthdays?.count) parts.push(plural(b.birthdays.count, 'birthday'));
    return reply(`${spokenDate(day)}: ${parts.join('; ') || 'nothing to report'}.`, b);
  },
});

const findStudents = defineTool({
  name: 'find_students',
  title: 'Find students',
  description:
    'Search current students by name, admission number or roll number, optionally within a class. Spoken or misspelt names are tolerated.',
  input: {
    query: z.string().max(100).describe('Name, admission no. or roll no.'),
    class: classArg.optional(),
    limit: z.number().int().min(1).max(25).optional(),
  },
  annotations: READ,
  available: (ctx) => !!ctx.can.viewStudents,
  async run({ query, class: cls, limit }, { api, ctx }) {
    const ref = cls ? resolveClass(ctx, cls) : undefined;
    const res = await api.get<{
      approximate: boolean;
      more: boolean;
      students: StudentHit[];
    }>('/agent/students', {
      query: { q: query, ...classQuery(ref), limit: limit ?? 10 },
      tool: 'find_students',
    });
    const n = res.students.length;
    return reply(
      n
        ? `${res.more ? 'First ' : ''}${plural(n, 'student')} matching "${query}"${ref ? ` in ${ref.label}` : ''}${res.approximate ? ' (closest spellings — confirm with the user)' : ''}.`
        : `No current student matches "${query}"${ref ? ` in ${ref.label}` : ''}.`,
      res.students.map((s) => ({
        id: s.id,
        name: s.name,
        class: s.class,
        roll: s.rollNo,
        admission: s.admissionNo,
      })),
    );
  },
});

const studentProfile = defineTool({
  name: 'student_profile',
  title: 'Student profile',
  description:
    "One student's details with optional sections: attendance, exams (marks), leaves, homework, fees (status only), contact (phone numbers). Accepts a name, admission number or id.",
  input: {
    student: z.string().max(100).describe('Name, admission number or id'),
    class: classArg.optional().describe('Class, to tell apart same names'),
    include: z
      .array(
        z.enum(['attendance', 'exams', 'leaves', 'homework', 'fees', 'contact']),
      )
      .max(6)
      .optional()
      .describe('Default: attendance, exams, leaves'),
  },
  annotations: READ,
  available: (ctx) => !!ctx.can.viewStudents,
  async run({ student, class: cls, include }, env) {
    const hit = await findStudent(env, student, cls, 'student_profile');
    const p = await env.api.get<Record<string, any>>(
      `/agent/students/${hit.id}`,
      {
        query: {
          include: (include ?? ['attendance', 'exams', 'leaves']).join(','),
        },
        tool: 'student_profile',
      },
    );
    const bits = [`${p.name}, ${p.class ?? 'not enrolled this session'}`];
    if (p.rollNo) bits.push(`roll ${p.rollNo}`);
    if (p.attendance?.percentage != null) {
      bits.push(`attendance ${p.attendance.percentage}%`);
    }
    if (p.fees?.outstanding != null) {
      bits.push(`fees outstanding ₹${p.fees.outstanding}`);
    }
    return reply(`${bits.join(', ')}.`, p);
  },
});

const classAttendance = defineTool({
  name: 'class_attendance',
  title: "A class's attendance",
  description:
    "Whether a class-section's attendance is taken for a day, with counts and who was absent, late or on leave.",
  input: { class: classArg, date: dateArg.optional() },
  annotations: READ,
  available: (ctx) => !!ctx.can.viewAttendance,
  async run({ class: cls, date }, { api, ctx }) {
    const ref = resolveClass(ctx, cls, true);
    const day = parseDate(date, ctx.today);
    const a = await api.get<Record<string, any>>('/agent/attendance/class', {
      query: { classId: ref.classId, sectionId: ref.sectionId, date: day },
      tool: 'class_attendance',
    });
    if (!a.marked) {
      return reply(`${ref.label}: attendance not taken for ${spokenDate(day)}.`);
    }
    const c = a.counts as Record<string, number>;
    const present = (c.PRESENT ?? 0) + (c.LATE ?? 0) + (c.HALF_DAY ?? 0);
    const absent = (a.notPresent as { name: string; status: string }[])
      .filter((s) => s.status === 'ABSENT')
      .map((s) => s.name);
    return reply(
      `${ref.label} on ${spokenDate(day)}: ${present} present, ${absent.length} absent${absent.length ? ` (${nameList(absent)})` : ''}. Taken by ${a.takenBy ?? 'unknown'}.`,
      { notPresent: a.notPresent },
    );
  },
});

const attendanceRegister = defineTool({
  name: 'attendance_register',
  title: 'Attendance register (all classes)',
  description:
    'For a day, every class-section: taken or pending, present/absent counts, who took it. Use pending_only to list classes still to mark.',
  input: {
    date: dateArg.optional(),
    pending_only: z.boolean().optional(),
  },
  annotations: READ,
  available: (ctx) => !!ctx.can.viewAttendance,
  async run({ date, pending_only }, { api, ctx }) {
    const day = parseDate(date, ctx.today);
    const r = await api.get<Record<string, any>>('/agent/attendance/register', {
      query: { date: day, pendingOnly: pending_only },
      tool: 'attendance_register',
    });
    const s = r.summary;
    const head = r.isSunday
      ? `${spokenDate(day)} is a Sunday.`
      : `${spokenDate(day)}: ${s.taken} of ${s.totalRegisters} registers taken, ${s.pending} pending${s.taken ? `; ${s.percentage}% present (${s.absent} absent)` : ''}.`;
    return reply(
      head,
      (r.registers as Record<string, unknown>[]).map((x) => ({
        class: x.class,
        taken: x.marked,
        strength: x.strength,
        present: x.marked ? x.present : null,
        absent: x.marked ? x.absent : null,
        pct: x.percentage,
        by: x.takenBy,
        day: x.dayType === 'WORKING' ? null : x.dayType,
      })),
    );
  },
});

const lowAttendance = defineTool({
  name: 'low_attendance',
  title: 'Students with low attendance',
  description:
    'Students below an attendance percentage over a period (default: this session so far, below 75%), lowest first.',
  input: {
    threshold: z.number().min(1).max(100).optional(),
    class: classArg.optional(),
    from: dateArg.optional().describe('Default: session start'),
    to: dateArg.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  },
  annotations: READ,
  available: (ctx) => !!ctx.can.viewAttendance,
  async run({ threshold, class: cls, from, to, limit }, { api, ctx }) {
    const ref = cls ? resolveClass(ctx, cls) : undefined;
    const r = await api.get<Record<string, any>>('/agent/attendance/low', {
      query: {
        threshold,
        ...classQuery(ref),
        from: from ? parseDate(from, ctx.today) : undefined,
        to: to ? parseDate(to, ctx.today) : undefined,
        limit: limit ?? 20,
      },
      tool: 'low_attendance',
    });
    const shown = r.students.length;
    return reply(
      `${plural(r.totalBelow, 'student')} below ${r.threshold}%${ref ? ` in ${ref.label}` : ''} (${r.from} to ${r.to})${shown < r.totalBelow ? `; lowest ${shown} shown` : ''}.`,
      r.students,
    );
  },
});

const findStaff = defineTool({
  name: 'find_staff',
  title: 'Find staff',
  description:
    'Search current staff by name, designation, department or employee code.',
  input: {
    query: z.string().max(100).optional(),
    limit: z.number().int().min(1).max(25).optional(),
  },
  annotations: READ,
  available: (ctx) => !!ctx.can.viewStudents,
  async run({ query, limit }, { api }) {
    const r = await api.get<{ more: boolean; staff: unknown[] }>(
      '/agent/staff',
      { query: { q: query, limit: limit ?? 10 }, tool: 'find_staff' },
    );
    return reply(
      r.staff.length
        ? `${r.more ? 'First ' : ''}${plural(r.staff.length, 'staff member', 'staff members')}${query ? ` matching "${query}"` : ''}.`
        : `No staff member matches "${query}".`,
      r.staff,
    );
  },
});

const staffAttendance = defineTool({
  name: 'staff_attendance',
  title: 'Staff attendance for a day',
  description:
    'Staff present, absent, on leave and not yet marked for a day (names for HR roles).',
  input: { date: dateArg.optional() },
  annotations: READ,
  available: (ctx) => !!ctx.can.viewStaffAttendanceSummary,
  async run({ date }, { api, ctx }) {
    const day = parseDate(date, ctx.today);
    const r = await api.get<Record<string, any>>('/agent/staff/attendance', {
      query: { date: day },
      tool: 'staff_attendance',
    });
    const s = r.summary as Record<string, number>;
    return reply(
      `${spokenDate(day)}: of ${r.totalStaff} staff, ${(s.PRESENT ?? 0) + (s.LATE ?? 0)} present, ${s.ABSENT ?? 0} absent, ${s.ON_LEAVE ?? 0} on leave, ${s.NOT_MARKED ?? 0} not marked${r.lateArrivals ? `, ${r.lateArrivals} late` : ''}.`,
      r.names ? { names: r.names } : undefined,
    );
  },
});

const pendingLeaves = defineTool({
  name: 'pending_leaves',
  title: 'Leave requests waiting on me',
  description:
    'Student and/or staff leave requests awaiting this user’s approval, with ids to pass to draft_leave_decision.',
  input: {
    type: z.enum(['student', 'staff', 'all']).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  },
  annotations: READ,
  available: (ctx) =>
    !!(ctx.can.viewStudentLeaves || ctx.can.approveStaffLeave),
  async run({ type, limit }, { api }) {
    const r = await api.get<Record<string, any>>('/agent/leaves/pending', {
      query: { type: type ?? 'all', limit: limit ?? 20 },
      tool: 'pending_leaves',
    });
    const sN = r.student?.total ?? 0;
    const tN = r.staff?.total ?? 0;
    const parts = [
      r.student ? plural(sN, 'student leave request') : null,
      r.staff ? plural(tN, 'staff leave request') : null,
    ].filter(Boolean);
    return reply(`${parts.join(' and ')} waiting.`, {
      student: r.student?.requests,
      staff: r.staff?.requests,
    });
  },
});

const feeStatus = defineTool({
  name: 'fee_status',
  title: 'Fee status (read-only)',
  description:
    'Fee dues and collection status — for one student, a class, or the whole school. Read-only: the assistant cannot take or record payments.',
  input: {
    student: z.string().max(100).optional().describe('Name, admission no. or id'),
    class: classArg.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  },
  annotations: READ,
  available: (ctx) => !!ctx.can.viewFeeStatus,
  async run({ student, class: cls, limit }, env) {
    const { api, ctx } = env;
    if (student) {
      const hit = await findStudent(env, student, cls, 'fee_status');
      const f = await api.get<Record<string, any>>('/agent/fees/status', {
        query: { studentId: hit.id },
        tool: 'fee_status',
      });
      if (f.unavailable) return reply(`${hit.name}: ${f.unavailable}`);
      return reply(
        `${f.student}: ₹${f.outstanding} outstanding${f.overdue?.length ? ` (overdue: ${f.overdue.join(', ')})` : ''}${f.nextDue ? `; next ₹${f.nextDue.amount} due ${f.nextDue.dueDate}` : ''}.`,
        f,
      );
    }
    if (cls) {
      const ref = resolveClass(ctx, cls);
      const f = await api.get<Record<string, any>>('/agent/fees/status', {
        query: { ...classQuery(ref), limit: limit ?? 15 },
        tool: 'fee_status',
      });
      return reply(
        `${ref.label}: ${plural(f.studentsWithDues, 'student')} with dues, ₹${f.totalPending} pending in total.`,
        f.top,
      );
    }
    const f = await api.get<Record<string, any>>('/agent/fees/status', {
      tool: 'fee_status',
    });
    return reply(
      `Session ${f.session}: ₹${f.collected} collected of ₹${f.expected} due so far; ₹${f.overdue} overdue. This month ${f.currentMonth.collectionRate}% collected.`,
      f,
    );
  },
});

const homeworkList = defineTool({
  name: 'homework_list',
  title: 'Homework given',
  description:
    'Homework set for a class (default last 7 days), or set by me (mine=true).',
  input: {
    class: classArg.optional(),
    mine: z.boolean().optional(),
    from: dateArg.optional(),
    to: dateArg.optional(),
  },
  annotations: READ,
  available: (ctx) => !!ctx.can.viewHomework,
  async run({ class: cls, mine, from, to }, { api, ctx }) {
    const ref = cls ? resolveClass(ctx, cls) : undefined;
    if (!ref && !mine) {
      throw new ResolveError('Which class? Or ask for homework set by me.');
    }
    const r = await api.get<{ from: string; to: string; homework: unknown[] }>(
      '/agent/homework',
      {
        query: {
          ...classQuery(ref),
          mine,
          from: from ? parseDate(from, ctx.today) : undefined,
          to: to ? parseDate(to, ctx.today) : undefined,
        },
        tool: 'homework_list',
      },
    );
    return reply(
      `${plural(r.homework.length, 'homework entry', 'homework entries')}${ref ? ` for ${ref.label}` : ' set by you'} from ${r.from} to ${r.to}.`,
      r.homework,
    );
  },
});

const schoolCalendar = defineTool({
  name: 'school_calendar',
  title: 'School calendar',
  description:
    'Holidays, published exam papers and school events in a date range (default: next 14 days; max ~2 months).',
  input: { from: dateArg.optional(), to: dateArg.optional() },
  annotations: READ,
  available: () => true,
  async run({ from, to }, { api, ctx }) {
    const f = parseDate(from, ctx.today);
    const r = await api.get<Record<string, any>>('/agent/calendar', {
      query: { from: f, to: to ? parseDate(to, ctx.today) : undefined },
      tool: 'school_calendar',
    });
    return reply(
      `${r.from} to ${r.to}: ${plural(r.holidays.length, 'holiday')}, ${plural(r.exams.length, 'exam paper')}, ${plural(r.activities.length, 'event')}.`,
      { holidays: r.holidays, exams: r.exams, events: r.activities },
    );
  },
});

const myLeaves = defineTool({
  name: 'my_leaves',
  title: 'My leave balance',
  description: "The user's own leave balances and recent leave applications.",
  input: {},
  annotations: READ,
  available: (ctx) => !!ctx.can.selfServiceHr && ctx.me.staffId !== null,
  async run(_args, { api }) {
    const r = await api.get<Record<string, any>>('/agent/me/leaves', {
      tool: 'my_leaves',
    });
    const bal = (r.balances as { code: string; available: number }[])
      .map((b) => `${b.code} ${b.available}`)
      .join(', ');
    return reply(`Available leave: ${bal || 'none set up'}.`, {
      balances: r.balances,
      recent: r.recent,
    });
  },
});

const myAttendance = defineTool({
  name: 'my_attendance',
  title: 'My attendance',
  description: "The user's own attendance for a month (default this month).",
  input: {
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional()
      .describe('YYYY-MM'),
  },
  annotations: READ,
  available: (ctx) => !!ctx.can.selfServiceHr && ctx.me.staffId !== null,
  async run({ month }, { api }) {
    const r = await api.get<Record<string, any>>('/agent/me/attendance', {
      query: { month },
      tool: 'my_attendance',
    });
    const c = r.counts as Record<string, number>;
    return reply(
      `${r.month}: ${(c.PRESENT ?? 0) + (c.LATE ?? 0)} days present, ${c.ABSENT ?? 0} absent, ${c.ON_LEAVE ?? 0} on leave${r.lateArrivals ? `, late ${r.lateArrivals} times` : ''}.`,
      { notPresent: r.notPresentDays },
    );
  },
});

const assistantUsage = defineTool({
  name: 'assistant_usage',
  title: 'Assistant credits',
  description:
    "This school's AI Assistant credits for a month; admins also see use by person and by tool.",
  input: {
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional()
      .describe('YYYY-MM'),
  },
  annotations: READ,
  available: () => true,
  async run({ month }, { api }) {
    const r = await api.get<Record<string, any>>('/agent/usage', {
      query: { month },
      tool: 'assistant_usage',
    });
    const q = r.quota;
    return reply(
      `${q.month}: ${q.used} of ${q.limit} credits used, ${q.remaining} left.`,
      r.byUser ? { byUser: r.byUser, byTool: r.byTool } : undefined,
    );
  },
});

export const READ_TOOLS = [
  dailyBriefing,
  findStudents,
  studentProfile,
  classAttendance,
  attendanceRegister,
  lowAttendance,
  findStaff,
  staffAttendance,
  pendingLeaves,
  feeStatus,
  homeworkList,
  schoolCalendar,
  myLeaves,
  myAttendance,
  assistantUsage,
  myContext,
];
