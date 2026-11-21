# Customer financial behaviour analysis (AR-038)

Sales → Customer behaviour shows, for every customer invoiced in the last two years, how they pay
and buy and what is changing. It is worked out from posted invoices and the receipts and credits
applied to them; nothing changes the books and no AI model is used. Amounts are in the functional
currency. The logic is in `packages/accounting-engine/src/customer-behaviour.ts`.

## Paying

Over invoices cleared in the last 12 months (an invoice is paid on the day the receipt or credit
that clears it is applied; days late are days after the due date, never below zero):

- **Days late**: weighted by invoice total, for the 12 months, the last 6 and the 6 before.
- **Trend**: paying slower or faster when the last 6 months differ from the 6 before by 7 days or
  more, with at least 2 paid invoices in each half.
- **Spread**: the standard deviation of days late.
- **In parts**: the share of those invoices cleared by more than one payment.
- **Usual pay day**: the day of the month around which (±3 days) at least 60% of the last 12
  months' receipts fall, with at least 4 receipts.

## Buying

Invoice totals in the last 12 months against the 12 before: growing at +20% or more, shrinking at
−20% or less, otherwise steady; new when nothing was bought the year before or the first invoice
is under 90 days old. **Stopped**: at least 3 invoices in the last 24 months and nothing for longer
than twice the usual gap between invoices, and over 60 days.

## Profile

| Profile | When |
| --- | --- |
| New customer | First invoice under 90 days ago |
| Too little history | Fewer than 3 invoices paid in the last 12 months |
| Unpredictable payer | Days late vary by more than 20 days |
| Pays on time | 5 days late or less on average |
| Pays late, steadily | Otherwise |

## Signals

| Signal | Tone |
| --- | --- |
| Paying slower | Risk |
| Stopped buying | Risk |
| Buying less | Watch |
| Pays in parts (30% or more of at least 3 paid invoices) | Watch |
| Paying faster | Good |
| Buying more | Good |
| Usual pay day | Information: time reminders a few days before |

Customers with a risk signal are listed first, then by what they bought in the last 12 months.

## API

`GET /v1/orgs/:orgId/customer-behaviour?contactId=` (needs `reports.read`): `summary` (customers,
counts by profile and by signal) and `customers`, each with `profile`, `paying`, `buying` and
`signals` (code, tone, label and the detail it was raised on).
