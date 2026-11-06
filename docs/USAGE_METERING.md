# Usage metering

M9 slice 5. Talk2Tax counts each organisation's AI requests and uploads per calendar month and holds them to the limits of its plan. Organisations see their usage under **Governance → Usage**. The people who run Talk2Tax see every organisation's usage under **Platform admin → Usage**.

## What counts

| Kind | One unit is | Recorded | Limit (plan field) |
|---|---|---|---|
| AI request | one answered call to the AI model, by any agent (copilot, collections, bank reconciliation, month-end close, virtual CFO, and AI drafting of policies, dashboards and reports) | after the model answers, with its input and output tokens and whose key was used | `aiCreditsPerMonth` |
| Upload | one file attached to a record (receipt, bill or other document) | inside the upload's own transaction | `documentUploadsPerMonth` |

A limit of `null` means no limit. The default plans are:

| Plan | AI requests | Uploads |
|---|---|---|
| Starter | no AI module | 100 |
| Growth | 300 | 500 |
| Professional | 1,500 | 2,000 |
| Enterprise | 5,000 | no limit |

Super admins can change these under Platform admin → Plans.

Some things are not counted:
- AI calls that fail;
- the **Test connection** call in Settings → Integrations;
- uploads that are refused or duplicates.

AI requests count whether the organisation uses its own Claude key or the server's key. The summary shows how many used each.

## Months

Usage counts by calendar month in India time, like every business date. The counts start again at 00:00 IST on the 1st. They are kept in `usage_events`, one row per unit. The table is append-only (a trigger enforces this) and has forced RLS.

## Limits

- **AI.** The AI control center's `check` runs before every model call, by every agent. It now also asks `UsageService.aiBlock`. Once the month's requests are used up, it refuses with 429 `AI_CREDITS_USED_UP`, and the agent's work stops with that message. Calls that are already running finish, so usage can go slightly past the limit, by the calls of one copilot turn at most.
- **Uploads.** `UsageService.takeUpload` runs inside the attachment's transaction, under a per-organisation advisory lock. It refuses with 429 `UPLOAD_LIMIT_REACHED`, and the file is not stored.

Each limit is shown in one of three states:
- within the plan;
- nearly used up, from 80%;
- used up.

The AI control center's own per-agent token budgets still apply on top of these limits.

## Screens

- **Usage** (organisation, everyone with `org.read`):
  - meters for AI requests and uploads;
  - tokens and bytes;
  - a day-by-day chart of this month;
  - the last six months.
- **Platform admin → Usage** (`platform.read`):
  - totals for a chosen month, including how many organisations are at or near a limit;
  - each organisation that used anything, with its plan, ordered by the share of a limit used.

## API

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/v1/orgs/:orgId/usage` | members | This month: `ai` and `uploads` (`used`, `limit`, `remaining`, `percent`, `state`, tokens or bytes), `days`, `history` (six months), `resetsAt` |
| GET | `/v1/admin/usage?month=YYYY-MM` | platform.read | `totals`, `organisations`, `months` (the last 12) |

## Tests

- Engine: `test/usage.test.ts` (5).
- API: `test/usage.e2e.test.ts` (5). It covers:
  - AI calls counted with tokens, and the next question refused at the limit without reaching the model;
  - uploads counted, near the limit, refused at the limit and not stored, with duplicates not counted;
  - a larger plan lifting the limit;
  - the platform view and its permissions;
  - the append-only table.
- Browser: `e2e/usage-flow.test.mjs`. An owner uploads a receipt and sees it counted, and a support person sees the organisation in Platform admin.

## Not yet

- Buying extra AI requests or uploads beyond the plan (SUBS-018 stays Implementing).
- Usage-based billing.
- API usage plans and metering of API calls.
- Bank statement imports and e-invoice and e-way bill files are not counted as uploads.
- Warning emails when usage nears a limit.
