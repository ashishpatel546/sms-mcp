/**
 * Turning what a person says ("six B", "maths", "next Friday", "Riya") into
 * the ids the API needs — on the server, so the model does not spend a tool
 * round trip looking ids up. Tolerant of speech-to-text output.
 */

export interface SchoolContext {
  today: string;
  school: { name?: string; slug?: string; timezone?: string };
  session: { id: number; name: string; from: string; to: string } | null;
  me: {
    userId: number;
    name: string;
    roles: string[];
    staffId: number | null;
    designation: string | null;
    classTeacherOf: { classId: number; sectionId: number; label: string }[];
    teaches: {
      subject: string;
      classId: number;
      sectionId: number | null;
      label: string;
    }[];
  };
  can: Record<string, boolean>;
  classes: { id: number; name: string; sections: { id: number; name: string }[] }[];
  subjects: { id: number; name: string }[];
  leavePolicies: { id: number; code: string; name: string; appliesTo?: string }[];
  credits: { month: string; remaining: number; limit: number };
}

/** A name could not be resolved; the message says what to ask the user. */
export class ResolveError extends Error {}

const NUMBER_WORDS: Record<string, string> = {
  one: '1', first: '1', two: '2', second: '2', three: '3', third: '3',
  four: '4', fourth: '4', five: '5', fifth: '5', six: '6', sixth: '6',
  seven: '7', seventh: '7', eight: '8', eighth: '8', nine: '9', ninth: '9',
  ten: '10', tenth: '10', eleven: '11', eleventh: '11', twelve: '12',
  twelfth: '12',
};
const ROMAN: Record<string, string> = {
  i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8',
  ix: '9', x: '10', xi: '11', xii: '12',
};
const FILLER = new Set([
  'class', 'std', 'standard', 'grade', 'section', 'sec', 'division', 'div',
  'the', 'of',
]);

/** Lowercase tokens with filler words dropped and number words as digits. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(/(\d)([a-z])\b/g, '$1 $2') // "6b" → "6 b"
    .split(/[\s\-_/.,]+/)
    .filter(Boolean)
    .filter((t) => !FILLER.has(t))
    .map((t) => NUMBER_WORDS[t] ?? t);
}

const classKey = (name: string) =>
  tokens(name)
    .map((t) => ROMAN[t] ?? t)
    .join(' ');

export interface ClassRef {
  classId: number;
  sectionId?: number;
  label: string;
}

/**
 * "6B", "class 6 section b", "six b", "VI-B", "UKG B" → ids. With no
 * section, returns the class alone (or its only section) unless one is
 * required, in which case the error lists the choices.
 */
export function resolveClass(
  ctx: SchoolContext,
  text: string,
  requireSection = false,
): ClassRef {
  const toks = tokens(text).map((t, i, all) =>
    // Roman numerals only as the class part — "v" alone could be a section.
    i < all.length - 1 || all.length === 1 ? (ROMAN[t] ?? t) : t,
  );
  if (!toks.length) throw new ResolveError('Which class?');

  const byKey = new Map(ctx.classes.map((c) => [classKey(c.name), c]));
  let cls = byKey.get(toks.join(' '));
  let sectionTok: string | undefined;
  if (!cls && toks.length > 1) {
    cls = byKey.get(toks.slice(0, -1).join(' '));
    sectionTok = toks.at(-1);
  }
  if (!cls) {
    // Last resort: the class part appears inside exactly one class name.
    const want = (sectionTok ? toks.slice(0, -1) : toks).join(' ');
    const hits = ctx.classes.filter((c) => classKey(c.name).includes(want));
    if (hits.length === 1) cls = hits[0];
  }
  if (!cls) {
    throw new ResolveError(
      `No class matches "${text}". Classes: ${ctx.classes.map((c) => c.name).join(', ')}.`,
    );
  }

  if (sectionTok) {
    const section = cls.sections.find(
      (s) => s.name.toLowerCase() === sectionTok,
    );
    if (!section) {
      throw new ResolveError(
        `${cls.name} has no section "${sectionTok.toUpperCase()}". Sections: ${cls.sections.map((s) => s.name).join(', ')}.`,
      );
    }
    return {
      classId: cls.id,
      sectionId: section.id,
      label: `${cls.name}-${section.name}`,
    };
  }
  if (cls.sections.length === 1) {
    const only = cls.sections[0]!;
    return { classId: cls.id, sectionId: only.id, label: `${cls.name}-${only.name}` };
  }
  if (requireSection) {
    throw new ResolveError(
      `Which section of ${cls.name}? ${cls.sections.map((s) => s.name).join(', ')}.`,
    );
  }
  return { classId: cls.id, label: cls.name };
}

const SUBJECT_ALIASES: Record<string, string> = {
  math: 'mathematics', maths: 'mathematics', mathematic: 'mathematics',
  sst: 'social science', social: 'social science', sci: 'science',
  eng: 'english', comp: 'computer', cs: 'computer', evs: 'environmental',
  gk: 'general knowledge', pe: 'physical education', skt: 'sanskrit',
};

/** Canonical subject name if one matches; otherwise the text as given. */
export function resolveSubject(ctx: SchoolContext, text: string): string {
  const raw = text.trim();
  const want = raw.toLowerCase();
  const alias = SUBJECT_ALIASES[want] ?? want;
  const subjects = ctx.subjects.map((s) => s.name);
  return (
    subjects.find((s) => s.toLowerCase() === want) ??
    subjects.find((s) => s.toLowerCase() === alias) ??
    subjects.find((s) => s.toLowerCase().startsWith(alias)) ??
    subjects.find((s) => s.toLowerCase().includes(alias)) ??
    raw
  );
}

/** "CL", "casual", "sick leave" → a leave policy. */
export function resolveLeavePolicy(ctx: SchoolContext, text: string) {
  const want = text.trim().toLowerCase().replace(/\s*leave$/, '');
  const policies = ctx.leavePolicies;
  const hit =
    policies.find((p) => p.code.toLowerCase() === want) ??
    policies.find((p) => p.name.toLowerCase().replace(/\s*leave$/, '') === want) ??
    policies.find((p) => p.name.toLowerCase().startsWith(want));
  if (!hit) {
    throw new ResolveError(
      policies.length
        ? `No leave type matches "${text}". Types: ${policies.map((p) => `${p.name} (${p.code})`).join(', ')}.`
        : 'No leave types are set up for this school.',
    );
  }
  return hit;
}

// ── Dates ──────────────────────────────────────────────────────────────────

const WEEKDAYS = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];
const MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov',
  'dec',
];

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utc(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

export function addDays(date: string, days: number): string {
  const d = utc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}

function validDate(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    ? iso(date)
    : null;
}

/**
 * "today", "tomorrow", "yesterday", "day after tomorrow", "friday",
 * "next monday", "last tuesday", "2026-09-24", "24 sep", "sep 24",
 * "24/09", "24-09-2026", "3 days ago", "in 2 weeks" → YYYY-MM-DD, relative to the school's today.
 * Day-first for numeric dates, as written in India.
 */
export function parseDate(text: string | undefined, today: string): string {
  if (!text || !text.trim()) return today;
  const t = text.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) {
    const [y, m, d] = t.slice(0, 10).split('-').map(Number);
    const ok = validDate(y!, m!, d!);
    if (ok) return ok;
  }
  if (t === 'today' || t === 'now') return today;
  if (t === 'tomorrow') return addDays(today, 1);
  if (t === 'yesterday') return addDays(today, -1);
  if (t === 'day after tomorrow') return addDays(today, 2);
  if (t === 'day before yesterday') return addDays(today, -2);

  const rel = t.match(/^(?:(in) )?(\d+|a|an|one|two|three|four|five|six|seven) (day|week)s?(?: (ago|from now|later))?$/);
  if (rel && (rel[1] || rel[4])) {
    const n = /^\d+$/.test(rel[2]!) ? Number(rel[2]) : Number(NUMBER_WORDS[rel[2]!] ?? 1);
    const days = n * (rel[3] === 'week' ? 7 : 1);
    return addDays(today, rel[4] === 'ago' ? -days : days);
  }
  if (t === 'last week' || t === 'a week ago') return addDays(today, -7);
  if (t === 'next week') return addDays(today, 7);

  const wd = t.match(/^(next |last |this |coming )?([a-z]+)$/);
  if (wd) {
    const idx = WEEKDAYS.findIndex((w) => w.startsWith(wd[2]!.slice(0, 3)));
    if (idx >= 0 && wd[2]!.length >= 3) {
      const cur = utc(today).getUTCDay();
      if (wd[1] === 'last ') {
        const back = (cur - idx + 7) % 7 || 7;
        return addDays(today, -back);
      }
      let ahead = (idx - cur + 7) % 7;
      if (wd[1] === 'next ' && ahead === 0) ahead = 7;
      return addDays(today, ahead);
    }
  }

  const [ty] = today.split('-').map(Number);
  const monthIdx = (s: string) => MONTHS.indexOf(s.slice(0, 3)) + 1;
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(\d{1,2}) ([a-z]+)(?: (\d{4}))?$/))) {
    const ok = validDate(Number(m[3] ?? ty), monthIdx(m[2]!), Number(m[1]));
    if (ok && monthIdx(m[2]!) > 0) return ok;
  }
  if ((m = t.match(/^([a-z]+) (\d{1,2})(?: (\d{4}))?$/))) {
    const ok = validDate(Number(m[3] ?? ty), monthIdx(m[1]!), Number(m[2]));
    if (ok && monthIdx(m[1]!) > 0) return ok;
  }
  if ((m = t.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/))) {
    let y = Number(m[3] ?? ty);
    if (y < 100) y += 2000;
    const ok = validDate(y, Number(m[2]), Number(m[1]));
    if (ok) return ok;
  }
  throw new ResolveError(
    `Could not understand the date "${text}". Say e.g. "today", "Friday" or "24 Sep".`,
  );
}

/** "Thu 24 Sep" — how dates are read back to the user. */
export function spokenDate(date: string): string {
  const d = utc(date);
  const wd = WEEKDAYS[d.getUTCDay()]!.slice(0, 3);
  const mon = MONTHS[d.getUTCMonth()]!;
  return `${wd[0]!.toUpperCase()}${wd.slice(1)} ${d.getUTCDate()} ${mon[0]!.toUpperCase()}${mon.slice(1)}`;
}

export function isSunday(date: string): boolean {
  return utc(date).getUTCDay() === 0;
}

// ── People ─────────────────────────────────────────────────────────────────

export interface Person {
  id: number;
  name: string;
  rollNo?: number | null;
}

export type PersonMatch =
  | { kind: 'one'; person: Person }
  | { kind: 'many'; candidates: Person[] }
  | { kind: 'none' };

const nameToks = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

/**
 * Finds one person in a known list (a class roster): by roll number
 * ("roll 5", "#5", "5"), full name, every spoken word matching a name part,
 * or — for STT misspellings — word prefixes.
 */
export function matchPerson(people: Person[], text: string): PersonMatch {
  const raw = text.trim().toLowerCase();
  const roll = raw.match(/^(?:roll(?: no\.?| number)?\s*|#)?(\d+)$/);
  if (roll) {
    const hit = people.filter((p) => p.rollNo === Number(roll[1]));
    if (hit.length === 1) return { kind: 'one', person: hit[0]! };
  }
  const want = nameToks(raw);
  if (!want.length) return { kind: 'none' };

  const exact = people.filter((p) => nameToks(p.name).join(' ') === want.join(' '));
  if (exact.length === 1) return { kind: 'one', person: exact[0]! };

  const tryMatch = (fn: (have: string[], w: string) => boolean) =>
    people.filter((p) => {
      const have = nameToks(p.name);
      return want.every((w) => have.some((h) => fn([h], w)));
    });
  for (const test of [
    (h: string[], w: string) => h[0] === w,
    (h: string[], w: string) => h[0]!.startsWith(w) || w.startsWith(h[0]!),
    (h: string[], w: string) =>
      w.length >= 3 && h[0]!.slice(0, 3) === w.slice(0, 3),
  ]) {
    const hits = tryMatch(test);
    if (hits.length === 1) return { kind: 'one', person: hits[0]! };
    if (hits.length > 1) return { kind: 'many', candidates: hits.slice(0, 6) };
  }
  return { kind: 'none' };
}
