import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Tool output is plain text in a compact shape, because the agent pays for
 * every token of it:
 *
 *   - line 1 is a one-sentence summary a voice assistant can read aloud;
 *   - objects render as `key: value` lines;
 *   - lists of records render as a pipe table (header once, not per row —
 *     roughly half the tokens of the equivalent JSON);
 *   - empty values (null, '', [], {}) are dropped entirely.
 */

type Primitive = string | number | boolean;

const isEmpty = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.keys(v as object).every((k) =>
      isEmpty((v as Record<string, unknown>)[k]),
    ));

const isPrimitive = (v: unknown): v is Primitive =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** A cell-friendly value: primitives, or a list of primitives. */
const isFlatValue = (v: unknown) =>
  isEmpty(v) || isPrimitive(v) || (Array.isArray(v) && v.every(isPrimitive));

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function scalar(v: unknown): string {
  if (Array.isArray(v)) return v.map(scalar).join(', ');
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v).replace(/\s+/g, ' ').trim();
}

function table(rows: Record<string, unknown>[]): string {
  const cols: string[] = [];
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!cols.includes(k) && !isEmpty(row[k])) cols.push(k);
    }
  }
  if (!cols.length) return '';
  const cell = (v: unknown) =>
    isEmpty(v) ? '-' : scalar(v).replace(/\|/g, '/');
  return [
    cols.join(' | '),
    ...rows.map((r) => cols.map((c) => cell(r[c])).join(' | ')),
  ].join('\n');
}

export function renderCompact(value: unknown, indent = ''): string {
  if (isEmpty(value)) return '';
  if (isPrimitive(value)) return indent + scalar(value);
  if (Array.isArray(value)) {
    if (value.every(isPrimitive)) return indent + scalar(value);
    if (value.every((r) => isRecord(r) && Object.values(r).every(isFlatValue))) {
      return table(value as Record<string, unknown>[])
        .split('\n')
        .map((l) => indent + l)
        .join('\n');
    }
    return value
      .map((v) => renderCompact(v, indent + '  ').replace(/^\s*/, `${indent}- `))
      .join('\n');
  }
  if (isRecord(value)) {
    const lines: string[] = [];
    for (const [k, v] of Object.entries(value)) {
      if (isEmpty(v)) continue;
      if (isPrimitive(v) || (Array.isArray(v) && v.every(isPrimitive))) {
        lines.push(`${indent}${k}: ${scalar(v)}`);
      } else {
        lines.push(`${indent}${k}:`, renderCompact(v, indent + '  '));
      }
    }
    return lines.join('\n');
  }
  return indent + String(value);
}

export function reply(summary: string, data?: unknown): CallToolResult {
  const body = data === undefined ? '' : renderCompact(data);
  return {
    content: [{ type: 'text', text: body ? `${summary}\n${body}` : summary }],
  };
}

export function errorReply(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** "3 students" / "1 student". */
export function plural(n: number, word: string, pluralWord = `${word}s`) {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** "Riya, Aman and 3 others" — keeps spoken summaries short. */
export function nameList(names: string[], max = 4): string {
  if (names.length <= max) {
    return names.length <= 1
      ? (names[0] ?? '')
      : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  }
  return `${names.slice(0, max).join(', ')} and ${names.length - max} others`;
}
