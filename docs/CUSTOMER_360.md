# CRM: Customer 360

CRM slice 4. For every customer, the books answer four questions: how much profit they bring,
what they are likely to be worth over their life, how they pay, and how risky it is to give them
credit. Every figure is worked out by the server from posted documents and journals
(`packages/accounting-engine/src/customer-insights.ts`); nothing is estimated by AI and nothing is
stored that could drift from the books.

Screens: *Customer 360* on each customer's page (*Sales → Customers → a customer*), and
*Sales → Customer insights*, which ranks every customer. Reading needs `reports.read`; credit hold
and the suggested limit need `contacts.manage`.

## Profitability

| Figure | From |
|---|---|
| Revenue | Lines on income accounts of posted invoices, before tax, less posted credit notes, by invoice date |
| Direct costs | Expense lines (debits less credits) posted to the customer's projects, by entry date: bills, journals, expense claims, payroll, anything tagged with the project |
| Gross profit and margin | Revenue less direct costs; margin is gross profit over revenue |

A project belongs to a customer when it is linked on *Settings → Departments and projects*
(the *Customer* list shows your customers). Its costs then count against that customer. Without a
linked project the customer's direct costs are zero and the page says so. The page shows the last
twelve months month by month (a chart with the same figures in a table), the twelve-month total and
the total since the first invoice.

## Payment behaviour

An invoice is paid on the day the receipt or credit note that clears it was applied. For paid
invoices: average days to pay (invoice date to paid) and average days late (due date to paid),
both weighted by the invoice total, and the share paid on or before the due date. For open
invoices: what is open, what is overdue and how many days the oldest overdue invoice is past due.

## Lifetime value

```
lifetime value = gross profit to date + yearly gross profit × expected years
yearly gross profit = max(last 12 months revenue, yearly value of active contracts) × margin
margin = last 12 months gross profit ÷ revenue (or since the start, if nothing in 12 months)
expected years = r ÷ (1 − r), at most 5
r = of the customers invoiced 13 to 24 months ago, the share invoiced again in the last 12 months
```

With fewer than five customers invoiced 13 to 24 months ago, three years is assumed, and the page
says it was assumed. A customer with no invoice in the last twelve months and no active contract is
expected to bring nothing more: their lifetime value is the profit earned so far.

## Credit risk

A score from 0 (safe) to 100 from five factors; each factor shows its points and why.

| Factor | Points |
|---|---|
| Overdue share of what is owed | 50% or more: 30 · 25% or more: 20 · any: 10 |
| Oldest overdue invoice | over 90 days: 25 · over 60: 18 · over 30: 10 · any: 5 |
| How late invoices are paid (average) | over 30 days: 20 · over 14: 12 · any: 6 |
| Credit limit used (open ÷ limit) | over 100%: 15 · over 80%: 10 · over 50%: 5 · no limit: 0 |
| Paying slower lately | 10 when the last 90 days' average lateness is 7 or more days worse than before |

Under 25 is *low risk*, under 50 *medium*, under 75 *high*, otherwise *very high*. A customer with
no posted invoice is *not enough history*.

**Suggested credit limit** (low and medium risk only): a month of billing (the last twelve months'
average before tax, or the contracts' monthly value when larger) times (1 + payment terms ÷ 30),
halved for medium risk, rounded up to the next 1,000. *Use as the credit limit* sets it on the
customer; posting an invoice that takes them over the limit already needs an override.

## Credit hold

*Put on credit hold* (with a reason) stops any invoice to the customer from posting until the hold
is lifted: posting is refused with the reason, even with a credit-limit override. Drafts,
quotations, orders, contracts (their invoices are drafts) and credit notes still work. Who put the
hold on and when are shown; setting and lifting are in the audit trail
(`contact.credit_hold_set`, `contact.credit_hold_lifted`). The database refuses a hold without a
reason, who and when.

## API

| Method | Path | Permission |
|---|---|---|
| GET | `/v1/orgs/:orgId/customers/insights` | reports.read |
| GET | `/v1/orgs/:orgId/customers/:contactId/insights` | reports.read |
| PUT | `/v1/orgs/:orgId/customers/:contactId/credit-hold` `{ hold, reason }` | contacts.manage |
| POST/PUT | `/v1/orgs/:orgId/dimensions` with `contactId` on a project | accounts.manage |

## Database

Migration `20261120090000_customer_360`: `dimension_values.contact_id` (projects only, checked;
composite foreign key to the contact in the same organisation) and `contacts.credit_hold`,
`credit_hold_reason`, `credit_hold_at`, `credit_hold_by_id` (checked together).

## Tests

`packages/accounting-engine/test/customer-insights.test.ts` (8), `apps/api/test/customer-insights.e2e.test.ts`
(7: figures, ranking, credit hold blocking posting, permissions, tenant isolation, database
checks) and `apps/web/e2e/customer-360-flow.test.mjs` (linking a project, reading the figures,
applying the suggested limit, hold and lift, the insights page).
