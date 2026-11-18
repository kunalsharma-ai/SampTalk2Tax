# Tax notices (TAX-024)

Letters from tax authorities that ask for a reply, information or payment: GST (ASMT-10,
DRC-01…), income tax (143(2), 148…), TDS/TCS, PF, ESI, professional tax and others. Each notice
is recorded from the letter, tracked to its reply deadline, kept with its files, and closed with
an outcome.

**Tax → Tax notices** (`/v1/orgs/:orgId/tax-notices`). Anyone with `reports.read` sees notices;
`accounts.manage` records and works them, as for compliance filings.

## A notice

* Authority, notice number (DIN/ARN/reference, unique per authority ignoring case), form or
  section, period, what it is about, date received (not in the future), reply due (not before
  receipt), amount demanded (the currency's decimal places), and who it is given to (a member).
* Status: **Open** → **Replied** (`POST :id/respond { on, text }`, not dated in the future or
  before receipt) → **Closed** (`POST :id/close { outcome, text }`, outcome Dropped with no
  demand, Demand paid, Appealed or Other). A closed notice can be reopened
  (`POST :id/reopen`). It goes back to Replied if a reply was recorded, else Open. Only an open
  or replied notice can be changed (`PUT :id`).
* Notes: `POST :id/notes { text }`.
* Files: `POST :id/files?fileName=` with the bytes (PDF, PNG, JPEG or WebP, up to 5 MB, at most
  20 per notice). Download with `GET :id/files/:fileId/content`. Files are kept as uploaded.
* **History**: every step (received, changes, notes, files, reply, closing, reopening) is added
  to the notice's history, which the database only lets grow. Every step is also audited
  (`tax_notice.*`).

## Urgency

The list puts the most pressing first. Open notices are **overdue** after the reply date,
**due soon** within 7 days of it, **upcoming** further out, or have **no deadline**. Replied and
closed notices come last. The summary counts open, overdue, due soon, replied and closed.

## Storage

MongoDB collections `tax_notices` and `tax_notice_files` (migration
`20261224100000_tax_notices`).

## Tests

* `packages/accounting-engine/test/tax-notices.test.ts`
* `apps/api/test/tax-notices.e2e.test.ts`
* `apps/web/e2e/tax-notices-flow.test.mjs` (screenshots in `talk2tax-preview/tax-notices/`)

Not yet: notices do not appear in the compliance calendar, and there are no reminders before
the reply date.
