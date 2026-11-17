# Mileage and per diem (EXP-006, EXP-008)

Employees can claim travel without a receipt: a distance driven for work at a rate per
kilometre, or days away from base at a daily rate. The organisation sets the rates.

## Rates

**Expenses → Mileage and per diem rates** (`/v1/orgs/:orgId/expense-allowance-rates`). Finance
(`expenses.reimburse`) adds and changes rates; anyone with `expenses.read` can see them, and
claimants get the active ones with the claim options.

* Kind: mileage (per km) or per diem (per day). A rate keeps its kind.
* Name: unique per kind, ignoring case, such as Car, Two-wheeler, Metro city, Other city.
* Rate: above zero. Mileage rates may have up to 4 decimal places (₹9.50, $0.725); daily rates
  no more places than the currency has.
* Expense account: an active, postable expense account that is not a control account. Approved
  claims post the line there.
* Making a rate inactive stops new claims choosing it. Claims already saved keep the rate and
  amount they were saved with.

## Claim lines

A claim line is a receipt (category, amount, tax) or an allowance:
`{ date, allowance: { rateId, quantity, from, to, purpose } }`. The server works out the line:

* amount = quantity × rate, rounded half-even to the currency;
* account = the rate's account; no tax;
* description, for example `Mileage 148.5 km × 9.50 (Car), Pune to Mumbai: Client visit` or
  `Per diem 1.5 days × 2500 (Metro city), Mumbai`.

Mileage needs a distance above 0 and at most 5,000 km, to 0.1 km, and where the trip started and
ended. Per diem needs whole or half days, at most 31 on a line, and where the person stayed. An
amount or account sent with an allowance line is ignored. The calculation is
`computeAllowance` in `packages/accounting-engine`, also used by the claim form for its preview.

From there the line is an ordinary claim line: approval, posting, reimbursement and voiding are
unchanged.

## Data (MongoDB)

| Collection | What it holds |
| --- | --- |
| `expense_allowance_rates` (tenant) | kind, name, rate (Decimal128), account, active, who made it. Unique on organisation, kind and name (case-insensitive). The kind cannot change. |
| `expense_claim_allowances` (tenant) | per claim line number: kind, rate id, name and value used, unit, quantity, from, to, purpose, amount. Replaced whenever the claim's lines are saved and removed with a deleted draft; never edited in place. |

Audit: `expense_allowance_rate.created`, `expense_allowance_rate.updated`; claims keep their
existing `expense_claim.*` events.
