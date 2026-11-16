# Revenue recognition (AR-028)

Invoice lines for a service delivered over time, such as a year of support or a subscription
billed up front, can be recognised over the service period instead of when the invoice posts.

## How it works

1. **Deferred revenue account.** Sales → Revenue recognition. New organisations use
   `2350 Deferred revenue`. Another active liability account with subtype other current
   liability, other non-current liability or accrued liability can be chosen (needs `org.manage`
   or `journals.post`).
2. **On a draft invoice**, the *Revenue recognition* card lists the lines. Tick a line to a
   revenue account. Give the service start, the months (1 to 120) and the spread: by days or
   evenly by month. Save. This needs `sales.manage`. Terms can only change while the invoice is a
   draft. A database trigger enforces this.
3. **Posting** checks the terms again against the lines as they stand. A line that was removed or
   moved off a revenue account blocks posting with a clear message. The invoice journal credits
   those lines to the deferred revenue account instead of revenue. Tax and the receivable are
   unchanged. One `DEFERRED_REVENUE` schedule (`DR-nnnn`) is opened per line for the amount the
   journal credited, in the functional currency. Its opening entry is the invoice journal.
4. **Each month**, the release run under Prepaid and deferred → Monthly release run moves that
   month's share to the line's revenue account (debit deferred revenue, credit revenue). It is
   the same run as for hand-entered schedules.
5. **Voiding the invoice** posts the invoice reversal as usual. That debits deferred revenue for
   the full amount. It then posts, on the void date, a take-back of what the schedules already
   recognised (debit revenue, credit deferred revenue), and ends each schedule. The schedule's
   end note names the take-back journal. After voiding, the receivable, tax, deferred revenue and
   revenue all return to zero.

A schedule that comes from an invoice keeps its terms. Change them by voiding and re-invoicing.
The schedule can still be renamed. It can be ended early from its page, which releases what is
left on the end date (for example when the service is finished sooner).

## Screens

- Invoice page → **Revenue recognition** card: terms on a draft; on a posted invoice, each line's
  schedule with what has been recognised and what is still deferred.
- **Sales → Revenue recognition**: the deferred revenue account; totals; a 12-month **revenue
  waterfall** over every deferred revenue schedule, including those entered by hand (posted
  months as posted, later months as scheduled, with before and after totals); and every invoice
  line recognised over time.

## API

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/v1/orgs/:orgId/sales/revenue-recognition?from=YYYY-MM` | `sales.read` |
| GET/PUT | `/v1/orgs/:orgId/sales/revenue-recognition/settings` | read: `sales.read`; save: `org.manage` or `journals.post` |
| GET | `/v1/orgs/:orgId/sales/documents/:id/recognition` | `sales.read` |
| PUT | `/v1/orgs/:orgId/sales/documents/:id/recognition` `{ lines: [{ lineNo, startDate, months, method }] }` | `sales.manage` (an empty list clears) |

Errors: `RECOGNITION_INVALID` (with `details.issues`), `NO_DEFERRED_ACCOUNT`, `NOT_DRAFT`.

## Data

- `revenue_recognition_settings`: one row per organisation with the deferred revenue account.
- `invoice_line_recognition`: one row per invoice line with terms. Its `schedule_id` is set once
  on posting. Rows of a posted invoice are never changed or deleted (trigger). Both tables have
  forced row-level security.

## Limits and what is not built

- Not reviewed by an accountant against Ind AS 115 or ASC 606.
- No allocation of the transaction price by standalone selling price across bundled lines. Each
  line is recognised for its own net amount.
- Credit notes do not adjust schedules. To reduce the service, end the schedule early with the
  refund account, or void and re-invoice.
- No milestone, percentage-of-completion or usage-based recognition. Usage charges (AR-012) are
  billed in arrears and are recognised when invoiced.
