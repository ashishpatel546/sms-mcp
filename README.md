# sms-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent (chat or voice) work with the school management system on behalf of a signed-in **staff member or admin**. It is a thin, stateless layer over `sms-backend`'s `/agent` API.

Design goals:

- **Keep token cost low.** Each user is offered only the tools their role may use. Results are compact text, and every result opens with a one-line summary.
- **Put a human in the loop.** The agent can only *draft* changes. The user confirms a draft before it runs.
- **Meter every school.** Each school has a credit allowance per month.

## How it fits together

```
 agent host (chat app / voice app, LLM)
   │  1. user signs in to sms-backend as usual
   │  2. POST /agent/session  (user token → 30-min agent token)
   │  3. MCP over HTTP, Authorization: Bearer <agent token>
   ▼
 sms-mcp  ── resolves names, formats output, runs draft → confirm
   │  every call: agent token + X-School-Slug + X-Agent-Tool
   ▼
 sms-backend /agent/*  ── permissions, tenant isolation, credit metering,
                          confirmed-action enforcement
```

The MCP server holds no secrets and no database. It decodes the agent token (without verifying it) only to pick the school header and to decide which tools to list. sms-backend verifies the token on every call. It also refuses agent tokens anywhere outside the agent allowlist, and refuses any agent write that isn't a confirmed draft.

## Tools

Each tool is listed only if the user's role and the school's enabled modules allow it. A teacher sees about 21 tools; a super-admin without a staff profile sees 19.

| Tool | What it answers / does |
|---|---|
| `daily_briefing` | "What's happening today?": attendance registers taken or pending, staff attendance, pending leave requests, holidays, exams, events, birthdays |
| `find_students` | Search by name, admission number or roll number. Tolerates spoken names and misspellings. |
| `student_profile` | One student, with optional attendance, exam marks, leaves, homework, fee status and contact details |
| `class_attendance` | One class-section on a day: taken or not, counts, who was absent |
| `attendance_register` | All classes on a day, e.g. "which classes haven't marked attendance?" |
| `low_attendance` | Students below a percentage over a period |
| `find_staff` / `staff_attendance` | Staff lookup; who is present, absent, on leave or not marked |
| `pending_leaves` | Student and staff leave requests waiting on this user |
| `fee_status` | **Read-only** dues and collection for a student, a class or the school |
| `homework_list` | Homework given to a class, or set by me |
| `school_calendar` | Holidays, exam papers and events in a date range |
| `my_leaves` / `my_attendance` | The user's own leave balance and attendance |
| `assistant_usage` | Credits used and left (admins also see a breakdown by person and by tool) |
| `my_context` | Roles, capabilities and school reference data. Rarely needed. |
| `draft_attendance` | "Mark 6B, everyone present except Riya and roll 12" |
| `draft_homework` | Homework for one or more classes; "6" means all its sections |
| `draft_leave_application` | Apply for the user's own leave, with their balance shown |
| `draft_cancel_my_leave` | Cancel one of the user's own leave applications |
| `draft_leave_decision` | Approve or reject a pending student or staff leave |
| `confirm_action` / `cancel_action` | Carry out or discard drafted changes |

No tool takes or records a payment, runs payroll, or handles uploads or credentials. The backend allowlist enforces the same rules.

### Inputs as spoken

Tools accept what people say. The server resolves it and asks back when something is ambiguous.

- **Classes:** `6B`, `6-b`, `class 6 section B`, `six b`, `VI B`, `UKG A`
- **Dates:** `today`, `yesterday`, `Friday`, `next Monday`, `24 Sep`, `24/09`, `3 days ago`. Numeric dates are day-first.
- **Students on a roster:** full name, surname, first name, `roll 12`, or close misspellings
- **Subjects and leave types:** `maths`, `SST`, `casual`, `CL`

## Human in the loop

1. The model calls `draft_attendance` (or another `draft_*` tool). The server resolves and validates everything, then stores the exact request with sms-backend (`POST /agent/actions`). **Nothing changes yet.** The result is a one-sentence preview written to be read aloud, plus `action_ids`, which expire after 15 minutes. The same draft is also returned as `structuredContent.draft` (`action_ids`, `summary`, `expires_at`), so a host can render its own Confirm and Cancel controls.
2. The host reads the preview to the user.
3. Only after the user says yes, `confirm_action` confirms the draft and sends the stored request. The backend executes it once, and only if method, path and body are byte-for-byte what was confirmed.

Choose how strict the confirmation should be:

- **Default:** the model calls `confirm_action` after the user says yes in chat or by voice.
- **Stricter:** set `MCP_EXPOSE_CONFIRM_TOOL=false` in this server and `AGENT_CONFIRM_REQUIRES_USER_TOKEN=true` in sms-backend. The host then shows its own Confirm button, which calls `POST /agent/actions/:id/confirm` with the **user's** session token. The model can draft changes but can never approve them.

## Credits and usage tracking

- Every agent call is charged in sms-backend: most reads cost 1, heavy reports 2–3, writes 2, and control calls (drafting, confirming, usage) 0. A school over its allowance gets a clear "credits used up" message.
- The agent host should report model and voice usage so that school budgets cover the whole cost:

  ```http
  POST /agent/usage/report            (agent token + X-School-Slug)
  { "kind": "LLM", "model": "…", "inputTokens": 3000, "cachedInputTokens": 8000, "outputTokens": 400 }
  { "kind": "STT", "audioSeconds": 42 }
  { "kind": "TTS", "characters": 900 }
  ```

- Where to see usage:
  - School admins: the `assistant_usage` tool, or `GET /agent/usage`.
  - Platform: `GET /admin/agent-usage` and `GET /admin/schools/:slug/agent-usage`.
- Where to set allowances: `PATCH /admin/schools/:slug/agent-credits` with `{ monthlyCredits, bonusCredits, month }`.

## Running

```bash
npm install
cp .env.example .env        # set SMS_API_URL
npm run build && npm start  # HTTP: http://127.0.0.1:4020/mcp (reads ./.env if present)
npm run dev                 # watch mode
npm test                    # unit + in-process MCP tests
```

**Who can call it.** Three layers protect it:

1. It binds to `127.0.0.1` by default and must never be published, whether through the Cloudflare tunnel or a public load balancer.
2. When `MCP_SHARED_SECRET` is set, every request must carry the same value in `X-MCP-Key`. sms-agent sends it as `SMS_MCP_KEY`, and the comparison is constant-time.
3. Every call still needs the user's agent token, which sms-backend verifies.

Across hosts, put TLS in front of it (HTTPS on a private network).

The HTTP transport is Streamable HTTP in stateless JSON mode: `POST /mcp` only, plus `GET /healthz`. You can run any number of instances. Each keeps an in-memory context cache per agent session, 5 minutes by default.

**Docker:** `docker build -t sms-mcp . && docker run -p 4020:4020 -e SMS_API_URL=… sms-mcp`. The image listens on `0.0.0.0:4020`. Add the public hostname to `MCP_ALLOWED_HOSTS`, and keep the port private: only the agent host should reach it.

**stdio**, for MCP Inspector or Claude Desktop during development:

```bash
SMS_API_URL=http://localhost:4010 SMS_USER_TOKEN=<user jwt> SMS_SCHOOL_SLUG=edusphere \
  node dist/index.js --stdio
```

**Live smoke test** against a running server. It confirms nothing, so it doesn't change school data:

```bash
MCP_URL=http://127.0.0.1:4020/mcp SMS_AGENT_TOKEN=<agent token> npx tsx scripts/smoke.ts
```

It prints the number of tools, the approximate size of their definitions, and the size of each result.

## Building an agent host (notes)

[sms-agent](../sms-agent) is the agent host for the portal. It already follows the notes below, and it keeps `confirm_action` away from the model entirely: confirmation comes only from a Confirm button or a plain spoken or typed yes.

- Mint the agent token server-side, right after the user signs in, and refresh it before the 30 minutes run out. Pass `{ "readOnly": true }` for sessions that must never change data.
- Keep the tool list stable within a session and put it first in the prompt, so the model provider's prompt caching applies.
- For voice, speak the first line of each result. Details follow on later lines.
- Handle the error texts as they are: they are written to be relayed to the user ("Which section of Class 6? A, B.").

## Layout

```
src/
  index.ts        entry: HTTP (default) or --stdio
  http.ts         Streamable HTTP transport, per-request session server
  server.ts       tool registration filtered by role/scope, server instructions
  api.ts          sms-backend client (tenant, tool and action headers)
  claims.ts       agent token decoding
  context.ts      per-session context cache
  resolve.ts      classes / dates / subjects / leave types / names from speech
  format.ts       compact text output
  tools/read.ts   read tools
  tools/write.ts  draft_* tools, confirm_action, cancel_action
test/             vitest: resolvers, formatting, MCP client ↔ server flows
scripts/smoke.ts  live check against a running server
```
