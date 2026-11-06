# CRM: customer contracts and recurring billing

CRM slice 3. A **contract** bills the same lines every period: monthly, quarterly, half-yearly or
yearly. Each period that falls due becomes a **draft invoice**, made by the same code as any
invoice (tax rates, GST place of supply and split, HSN/SAC), which you check and post as usual.

Screens: *Sales → Contracts*, each contract's page, and *Quotations, orders and contracts* on a
deal's page (with *New contract*).

## Terms

| Field | |
|---|---|
| Billed | Monthly, quarterly, half-yearly or yearly, from the start date |
| Invoice dated | In advance (the period's first day) or in arrears (its last day) |
| End date | The last day of a period, or none (rolling until cancelled) |
| Auto-renew | At the end date, run on for a renewal term (a whole number of periods) |
| Renewal notice | Days before the end date from which the contract shows *Renewal due* |
| Payment terms | Days to the invoice's due date; blank uses the customer's terms |
| Lines | Account, description, quantity, unit price, tax rate, HSN/SAC: billed each period |

Periods keep the start date's day of the month; when a month is shorter they use its last day
(a contract from 31 January bills on 28/29 February, then 31 March). An end date that is not a
period end is refused with the nearest valid dates.

## Life of a contract

| Status | What happens |
|---|---|
| Draft | Change anything, or delete it |
| Active | Each period is billed on its invoice date. Lines, prices, end date and renewal terms can change and apply to periods billed from then on; the customer, start date and schedule are fixed (a database trigger refuses changes) |
| Paused | Nothing is billed. On *Resume*, periods whose invoice date passed while paused are recorded as **skipped** |
| Ended | Every period to the end date is billed and the end date has passed (and it does not auto-renew). It can still be renewed |
| Cancelled | With a reason; nothing more is billed and the contract no longer changes |

**Activating** bills straight away every period already due (a contract started two months ago
gets three draft invoices) and marks the linked deal won.

**Renewing** extends the end date by whole periods, optionally changing every price by a
percentage (for example +5%). Automatic renewal happens on the first billing pass after the end
date, and is recorded in the history as *Renewed automatically*.

## Billing

* The **billing runner** checks every `CONTRACT_RUNNER_INTERVAL_SECONDS` (default 3600; 0 turns
  it off) and appears on the operations heartbeat page as *Contract billing*. *Bill now* on a
  contract and *Bill due periods now* on the list do the same on request.
* Each period is recorded once (billed or skipped) under a row lock, so nothing is billed twice,
  even if the runner and a person bill at the same moment.
* Invoices made by the runner are created in the name of the member who created the contract.
  Their reference is `CT-0001 1 Nov 2026 to 30 Nov 2026 / <customer reference>` and their memo
  the contract's title.
* If a period's draft invoice is **deleted** or the invoice is **voided**, the period shows
  *Bill again*.
* If an invoice cannot be made (an inactive tax rate, a missing place of supply), billing stops at
  that period, the reason shows on the contract and in its history (once per new reason), and the
  next pass tries again.

## Figures

* **MRR**: each active contract's value per period excluding tax, divided by the months in the
  period; **ARR** = MRR × 12.
* **Renewals due**: active or paused contracts within their notice days of the end date, or past it.

## Permissions

Reading needs `sales.read`; everything else needs `sales.manage`.

## API

Under `/v1/orgs/:orgId/sales/contracts`: `GET` (`view` active/renewals/draft/closed/all,
`contactId`, `dealId`), `POST`, `POST bill-due`; per contract `GET`, `PUT`, `DELETE` (draft),
`POST activate | pause | resume | bill-due | cancel {reason} | renew {months, upliftPercent}`,
`POST periods/:periodNo/bill-again`.

## Not built yet

* Invoices are drafts; there is no automatic posting or e-mailing of contract invoices.
* No proration of part periods, no usage-based or metered charges, no automatic collection.
* Contracts are in the functional currency only.
