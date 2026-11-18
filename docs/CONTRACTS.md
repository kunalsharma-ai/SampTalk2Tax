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
| End date | The last day of a period, or none (rolling until cancelled); with a billing day, any date |
| Bill on day of month | Optional, 1 to 28: periods run from that day, and part periods are billed by days |
| Auto-renew | At the end date, run on for a renewal term (a whole number of periods) |
| Renewal notice | Days before the end date from which the contract shows *Renewal due* |
| Payment terms | Days to the invoice's due date; blank uses the customer's terms |
| Lines | Account, description, quantity, unit price, tax rate, HSN/SAC: billed each period |

Periods keep the start date's day of the month; when a month is shorter they use its last day
(a contract from 31 January bills on 28/29 February, then 31 March). An end date that is not a
period end is refused with the nearest valid dates.

### Part periods

With a **billing day**, periods run from that day of the month instead of the start date. A
contract starting on 15 November and billed on the 1st has a first part period of 15 to 30
November, then full periods from 1 December. Its end date can be any date: the last period is
cut short there (to 10 March, say). A part period bills each line at its share of days, the
unit price × days in the part ÷ days in the full period it belongs to, rounded half up to the
paisa, and the line says so: *Payroll (part period: 16 of 30 days)*. Usage charges are billed
as recorded. Coming up on the contract shows each period as a full period or its days.

A contract that ends part-way through a period cannot renew automatically, and is renewed by
hand only after its end date is moved to a period end. Once its last part period is billed, the
end date no longer changes. The billing day is fixed once the contract is active, like the rest
of the schedule.

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

## Credit for unused days on cancelling

Cancelling a contract part-way through a period it billed in advance can credit the days left.
The cancel dialog shows each posted invoice whose period runs past today, its unused days and the
credit, and *Credit the unused days* (on by default) makes one **draft credit note per invoice**,
dated today, with the invoice's currency and rate:

* The customer is served to the end of the cancel day; the unused days run from the next day (or
  from the period's start, for a period billed ahead that has not begun) to the period end.
* Each line is credited at the contract's unit price × unused days ÷ the full period's days. A part
  period keeps its full-period length, so the credit never exceeds what was billed. Tax is worked
  out as on any credit note.
* An invoice still in draft is listed, not credited: edit or void the draft instead. Usage charges
  are not credited.
* A contract billed in arrears has nothing billed ahead, so there is nothing to credit
  (`CONTRACT_NOTHING_TO_CREDIT`, as when no posted invoice runs past today).
* The credit notes appear in the contract's history and the `sales_contract.cancelled` audit event
  (`creditNotes`, `creditTotal`). Review and post them, then set each against its invoice.

## Permissions

Reading needs `sales.read`; everything else needs `sales.manage`.

## API

Under `/v1/orgs/:orgId/sales/contracts`: `GET` (`view` active/renewals/draft/closed/all,
`contactId`, `dealId`), `POST`, `POST bill-due`; per contract `GET`, `PUT`, `DELETE` (draft),
`GET cancel-credit` (what cancelling today would credit),
`POST activate | pause | resume | bill-due | cancel {reason, creditUnused} | renew {months, upliftPercent}`,
`POST periods/:periodNo/bill-again`.

## Not built yet

* Invoices are drafts; there is no automatic posting or e-mailing of contract invoices.
* No automatic collection (card or mandate).
* Contracts are in the functional currency only.
