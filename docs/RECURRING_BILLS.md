# Recurring bills

Registry: **AP-005 Recurring bills**.

Some vendor bills come every month, quarter or year: office rent, a maintenance contract, a
software subscription. A recurring bill keeps the vendor, the lines and a schedule. Each run that
falls due becomes an ordinary bill dated the run date, saved as a draft for someone to check or
posted straight away. The bill is made by the same code as a bill entered by hand, so GST, TDS,
approval rules, closed periods and the duplicate vendor-reference check all apply.

## Setting one up

**Purchases → Recurring bills → New recurring bill**, or open a bill and choose **Make recurring…**
(the vendor, lines, GST rate, SAC, place of supply, reverse charge and TDS section are filled from
that bill).

1. Give it a name and choose the vendor.
2. **Vendor's invoice number** is optional. If you fill it in, it must contain a placeholder that
   changes from one bill to the next, such as `RENT-{period}` or `Lease {month}` for a monthly bill,
   because a vendor's invoice number cannot be entered twice. `{fy}` or `{year}` only work for a
   yearly bill. Without one, the bills carry no vendor reference.
3. The memo and the line descriptions take the same placeholders: `{date}`, `{month}`, `{period}`,
   `{quarter}`, `{fy}`, `{year}`. Without a memo each bill's memo is `RB-0001 <name>`.
4. **Due after (days)**: the bill's due date is the bill date plus this; leave it empty to use the
   vendor's payment terms.
5. The lines are entered as on a bill. With GST, each line needs a GST rate and an HSN/SAC code;
   the tax is worked out on each bill with the rates in force on its date.
6. The schedule: monthly, quarterly, half-yearly or yearly, the first bill date, an optional last
   date, and *On the month's last day* for bills dated at month end. **Each bill** is saved as a
   draft, or posted straight away (that needs `journals.post`).

**Save recurring bill** checks the first bill exactly as it would be made (vendor, accounts, tax
rates, GST, TDS, reference) and saves nothing if it would be refused. It is numbered **RB-0001**.

## Running

Every hour the runner makes each active recurring bill's runs that have fallen due, oldest first,
in one transaction with their run records, so a run is never made twice. **Make due bills now**
(on the list or on one recurring bill) does the same straight away.

If a bill cannot be made (a locked period, an inactive vendor, an approval rule that the bill
must pass before posting, a reference already entered) nothing is saved for that pass, the reason
is shown on the recurring bill, and the next pass tries again.

A recurring bill that posts is posted in the name of the member who set it up; if that member can
no longer post, the runner stops with a message until someone who can saves it again, or it is set
to make drafts.

## Changing, pausing, ending

* **Edit** changes the lines, amounts, memo, reference, due days, last date and whether bills are
  posted. Bills already made keep their lines.
* Once it has made a bill, its vendor, first date, frequency and run day stay as they are (a
  database trigger enforces this, and that runs already made are never undone). End it and make a
  new one instead.
* **Pause** stops it. **Resume…** either makes the bills that fell due while it was paused, or
  skips them and carries on from today.
* **End** stops it for good. It ends by itself after the last date.
* One that has not made a bill can be deleted. Deleting a draft bill it made keeps the run (shown as
  *Draft deleted*), so that run is not made again.

| Action | Permission |
| --- | --- |
| See recurring bills | `purchases.read` |
| Create, change, pause, resume, end, delete, make due bills | `purchases.manage` |
| A recurring bill that posts its bills | also `journals.post` |

## API

Under `/v1/orgs/:orgId/purchases/recurring-bills`:

| Method | Path | |
| --- | --- | --- |
| GET | `/?view=active\|paused\|ended\|all` | recurring bills with counts |
| POST | `/` | `{ name, contactId, reference?, memo?, placeOfSupply?, reverseCharge?, withholdingSectionId?, dueDays?, frequency, startDate, endDate?, monthEnd, postMode, lines: [{ accountId, description?, quantity, unitPrice, taxRateId?, hsnCode?, departmentId?, projectId? }] }` |
| POST | `/run-due` | make every due run of the organisation |
| GET | `/:id` | one recurring bill, its upcoming bills and the bills made |
| PUT | `/:id` | change it (same body) |
| DELETE | `/:id` | delete one that has not made a bill |
| POST | `/:id/run-due` | make its due runs now |
| POST | `/:id/pause`, `/:id/resume` `{ skipMissed }`, `/:id/end` | |

The runner's interval is `RECURRING_BILL_RUNNER_INTERVAL_SECONDS` (default 3600; 0 turns it off).

## Not yet

* Recurring bills in a foreign currency.
* Amounts that change from run to run (for example by usage or an escalation clause); edit the
  lines when the amount changes.
* Starting recurring bills from an e-mailed or uploaded vendor invoice.
