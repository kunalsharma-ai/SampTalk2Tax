# Compliance deadline predictions (TAX-047)

**Tax → Deadline risk** scores each open filing and payment on the compliance calendar
(GSTR-1, GSTR-3B, TDS/TCS deposits, PF, ESI, professional tax) as *Likely late*, *At risk* or
*On track*, and says why.

## What it reads

- **Upcoming deadlines**: the compliance calendar from today to 30–120 days ahead (default 60),
  including anything already overdue. Done and nothing-due items are left out.
- **The record**: the calendar for the last 365 days. A deadline counts as done on its filing date
  (recorded on the compliance calendar) or, for deposits and payroll dues, the latest deposit or
  payment date in the books. A past deadline not done counts as late.
- **The books**, for GST months that have ended: the GST reconciliation (TAX-045/044). High-severity
  tax mistakes in the month's documents block the return; GST accounts that differ from the
  documents are a warning. Payroll dues with no pay run posted are blocked.

## Scoring (`packages/tax-engine/src/india/deadline-predictions.ts`)

| Signal | Points |
| --- | --- |
| Overdue | 3 |
| Late at least half the time (2+ past deadlines) / late at all | 2 / 1 |
| Usually done after the due date / usual date already passed | 2 / 1 |
| No record, 3 days or fewer left, period over | 1 |
| Each blocking / warning signal from the books | 2 / 1 |

3 points or more is *Likely late*, 1–2 *At risk*, 0 *On track*. The usual lead is the median of
days-before-due over the record; the expected date is the due date minus that lead.

## API

`GET /v1/orgs/:orgId/compliance/predictions?days=7..120` (reports.read) returns `today`, `to`,
`configured`, `history` (past deadlines used), `summary` (high, medium, low) and `items`.

Nothing is filed or changed, and no AI model is used.

## Not built

Advance income tax instalments (no filing record), annual returns, and learning from other
organisations.
