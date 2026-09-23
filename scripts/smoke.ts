/**
 * Live smoke test: connects to a running sms-mcp over HTTP as a real MCP
 * client, lists tools, runs the read tools, and drafts (then discards) a
 * change. Never confirms anything, so it changes no school data.
 *
 *   MCP_URL=http://127.0.0.1:4020/mcp SMS_AGENT_TOKEN=<token> npx tsx scripts/smoke.ts
 *
 * Optional: SMOKE_CLASS (default "1A") for the class-based calls.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.MCP_URL ?? 'http://127.0.0.1:4020/mcp';
const token = process.env.SMS_AGENT_TOKEN;
const cls = process.env.SMOKE_CLASS ?? '1A';
if (!token) {
  console.error('Set SMS_AGENT_TOKEN (from POST /agent/session).');
  process.exit(1);
}

const client = new Client({ name: 'sms-mcp-smoke', version: '1' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);

const { tools } = await client.listTools();
const listing = JSON.stringify(tools);
console.log(
  `${tools.length} tools, ~${Math.round(listing.length / 4)} tokens of definitions:\n  ${tools.map((t) => t.name).join(', ')}\n`,
);

const calls: [string, Record<string, unknown>][] = [
  ['daily_briefing', {}],
  ['find_students', { query: 'a', limit: 3 }],
  ['class_attendance', { class: cls, date: 'yesterday' }],
  ['attendance_register', { pending_only: true }],
  ['low_attendance', { threshold: 80, limit: 3 }],
  ['find_staff', { limit: 3 }],
  ['staff_attendance', {}],
  ['pending_leaves', {}],
  ['fee_status', {}],
  ['homework_list', { class: cls, from: '30 days ago' }],
  ['school_calendar', {}],
  ['assistant_usage', {}],
  ['draft_homework', { classes: [cls], subject: 'maths', task: 'Smoke test — discard me' }],
];
const available = new Set(tools.map((t) => t.name));
let draftIds: string[] = [];
for (const [name, args] of calls) {
  if (!available.has(name)) continue;
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  const out = r.content[0]?.text ?? '';
  console.log(`▶ ${name}${r.isError ? ' [error]' : ''} (~${Math.round(out.length / 4)} tokens)\n${out.split('\n').slice(0, 6).join('\n')}\n`);
  const ids = out.match(/action_ids: (.+)/)?.[1];
  if (name.startsWith('draft_') && ids) draftIds = ids.split(', ');
}
if (draftIds.length) {
  const r = (await client.callTool({
    name: 'cancel_action',
    arguments: { action_ids: draftIds },
  })) as { content: { text: string }[] };
  console.log(`▶ cancel_action\n${r.content[0]?.text}`);
}
await client.close();
