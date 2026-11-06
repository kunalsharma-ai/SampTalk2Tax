# Bad debts: provisions and write-offs

Registry: **AR-026 Bad debt provisions**, **AR-027 Write-offs**.

Two things happen when a customer may not pay:

* a **provision** (allowance for doubtful debts) is booked for what is expected not to be
  collected, while the invoice stays owed; and
* a **write-off** removes an invoice, or part of one, from receivables once it will not be paid.

Both post ordinary journals with the source `BAD_DEBT`, through `JournalsService.postSystemEntry`,
so the period must be open, the accounts must be postable and active, and debits must equal
credits. Nothing here edits a posted journal.

## Setting it up

**Sales → Bad debts** asks for two accounts and the rates once:

| Setting | Usual account | Type |
| --- | --- | --- |
| Bad-debt expense | 6950 Bad Debts | Expense |
| Allowance for doubtful debts | 1210 Allowance for Doubtful Debts | Asset (contra, credit balance) |

**Create the usual accounts** makes both (under 6000 and 1100) if they are not there and saves the
settings. The default provision matrix is 1% current, 3% 1-30 days, 10% 31-60 days, 25% 61-90 days
and 50% over 90 days overdue. Base the percentages on your own history of losses; they are a
setting, not a rule.

Changing settings needs `sales.manage` and `journals.post`.

## The provision

For the date you choose, the page works out the allowance needed
(`provisionMatrix` in `packages/accounting-engine/src/bad-debts.ts`):

1. Every posted invoice with an amount still owed on the date, in the same ageing buckets as
   **Receivables ageing**. Foreign-currency invoices count at their own exchange rate, so the
   matrix agrees with the receivables control account.
2. Each bucket's open amount × its rate.
3. An invoice **marked doubtful** is taken out of its bucket and provided at its own percentage
   (for example 100% for a customer in insolvency), with the reason recorded.

**Post provision** compares that total with the allowance account's balance on the date and posts
only the difference (`provisionAdjustment`):

* more needed: Dr bad-debt expense, Cr allowance;
* less needed: Dr allowance, Cr bad-debt expense (a release);
* no difference: the run is kept for the record with no journal.

Each run is numbered **PV-0001**, keeps the rates and the matrix it used, and cannot be changed or
deleted (a database trigger). A wrong provision is corrected by the next one. The overview reads
the allowance from the books, so a manual journal to the allowance account is taken into account.

## Writing off an invoice

**Write off…** on a posted invoice (or on its row in **Open invoices**) asks for the date, the amount
in the invoice's currency (up to what is still owed), where to charge it and a reason:

* **The allowance**, when the invoice was provided for: Dr allowance, Cr receivables. Refused with
  `ALLOWANCE_SHORT` if it is more than the allowance holds on the date, so the allowance never turns
  into a debit; write off the provided part against the allowance and the rest against the expense.
* **Bad-debt expense**, when it was not provided for: Dr bad-debt expense, Cr receivables.

Foreign-currency write-offs use the invoice's own rate, so no exchange difference arises.

A write-off (**WO-0001**) settles the invoice the way a receipt does: it is an allocation against
the invoice, so the amount due, **Receivables ageing**, the customer statement (a *Written off*
line) and the control account all agree. It is not a credit note: the sale, its GST and any
e-invoice stay as they were.

The settlement cannot be removed on the invoice and the invoice cannot be voided while it is
written off. **Reverse…** (once, for example when the customer pays after all) reverses the
journal on the date you give and makes the amount owed again. The write-off row is otherwise
immutable in the database.

## Permissions

| Action | Permission |
| --- | --- |
| See the page | `sales.read` |
| Mark or clear doubtful | `sales.manage` |
| Settings, provisions, write-offs, reversals | `sales.manage` and `journals.post` |

## API

All under `/v1/orgs/:orgId/bad-debts`:

| Method | Path | |
| --- | --- | --- |
| GET | `?asOf=` | settings, matrix, carried allowance, open invoices, write-offs, provisions |
| PUT | `/settings` | accounts and rates |
| POST | `/settings/default-accounts` | create 1210 and 6950 and save them |
| POST | `/provisions` | post the difference for `asOf` |
| PUT / DELETE | `/doubtful/:documentId` | mark or clear a specific provision |
| POST | `/write-offs` | write off an invoice |
| POST | `/write-offs/:id/reverse` | reverse a write-off |

## Not yet

* GST bad-debt relief (India has no general relief on output tax; other countries do).
* Provision rates learnt from your own collection history (an expected-credit-loss model).
* Writing off payables, or many small balances in one go.
