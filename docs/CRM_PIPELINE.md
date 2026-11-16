# CRM: leads and the sales pipeline

CRM slice 1. A lightweight, native CRM built on the same customers, invoices and receipts as the
books, so a won deal leads straight to billing (quotations, orders and contracts come next).

## Leads

A lead is someone who might buy: a person, usually at a company, with an email, phone, source
(website, referral, event, outbound, partner, advertising, other), an owner and an optional first
guess at its value. Leads are numbered `LD-0001` per organisation.

| From | To | Rule |
|---|---|---|
| New | Contacted, Qualified, Disqualified | Disqualifying needs a reason |
| Contacted | New, Qualified, Disqualified | |
| Qualified | New, Contacted, Disqualified, **Converted** | Converting goes through *Convert to customer* only |
| Disqualified | New, Contacted | Reopen before qualifying again |
| Converted | — | Closed for good (a database trigger refuses changes) |

**Converting** a qualified lead, once, in one transaction:

* attaches it to an existing contact (a vendor is marked a customer too), or creates a new customer
  named after the lead's company (or name) with its email and phone. Creating one needs
  `contacts.manage`;
* optionally opens a deal at the *qualification* stage, owned by the lead's owner.

**Duplicates.** A lead whose email matches another lead or a contact shows a warning with links,
so it can be attached to the existing customer instead of creating another. Emails are stored
trimmed and in lower case.

## Deals

A deal is a sale being worked on for one customer, numbered `DL-0001`, with an amount in the
organisation's functional currency, an expected close date, an owner and a win probability.

| Stage | Default probability |
|---|---|
| Prospecting | 10% |
| Qualification | 25% |
| Proposal | 50% |
| Negotiation | 75% |
| Won | 100% (always) |
| Lost | 0% (always, with a reason) |

* A new deal starts at an open stage. Moving to an open stage takes that stage's default unless a
  probability is given; the probability can also change within a stage.
* Winning or losing records the closing date (India time). A closed deal keeps its customer,
  amount and dates (only its owner and notes change) until it is reopened, which is recorded.
* **Weighted value** = amount × probability, rounded half-even to the currency's decimals.

The **pipeline** page shows a board by stage with totals and weighted totals, deals past their
expected close date, the win rate, value won and average days from creation to win over the last
90 days, and the weighted value by expected close month (overdue deals count in this month). Deals
can be moved, or won, from their card; losing needs the deal page for the reason. The customer page
lists the customer's deals.

## Activity timeline

Every lead and deal has an append-only timeline: calls, emails, meetings and notes logged by people,
and every creation, edit (which fields, and the amount before and after), status or stage change,
reopening and conversion. A trigger refuses any update or delete. Each change is also written to the
hash-chained audit trail (`crm.lead.*`, `crm.deal.*`, `crm.activity.logged`).

## Permissions

| Permission | Who | Allows |
|---|---|---|
| `sales.read` | everyone who reads the books | See leads, deals, the pipeline and timelines |
| `crm.manage` | owners, admins, accountants | Add and edit leads and deals, change status and stage, log activities, convert |
| `contacts.manage` | owners, admins, accountants | Needed as well to create a new customer when converting |

Owners of leads and deals must be members of the organisation. All three tables have forced
row-level security; leads and deals are never deleted.

## API

All under `/v1/orgs/:orgId/crm`:

| Method | Path | |
|---|---|---|
| GET | `owners` | Members who can own leads and deals |
| GET, POST | `leads` | List (`status`, `ownerId`, `q`) with counts; add |
| GET, PUT | `leads/:id` | One lead with timeline and duplicates; edit |
| POST | `leads/:id/status` | `{ status, reason? }` |
| POST | `leads/:id/convert` | `{ contactId?, deal?: { name, amount, expectedCloseDate } }` |
| GET, POST | `deals` | List (`view=open|closed|all`, `stage`, `ownerId`, `contactId`, `q`) with the summary and close months; add |
| GET, PUT | `deals/:id` | One deal with timeline; edit |
| POST | `deals/:id/stage` | `{ stage, probability?, lostReason? }` |
| POST | `activities` | `{ leadId | dealId, kind: NOTE|CALL|EMAIL|MEETING, body }` |

## Not yet built

* Quotations, sales orders and contracts (next CRM slices), so a won deal does not yet produce an
  invoice by itself.
* Deals in a currency other than the functional currency.
* Reminders and follow-up tasks from a lead or deal (the task queue can be used by hand).
* Importing leads from a file or an external CRM (CRM slice 6).
