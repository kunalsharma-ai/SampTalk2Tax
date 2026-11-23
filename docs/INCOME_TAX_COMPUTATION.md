# Income tax computation (TAX-019, TAX-020)

**Tax → Income tax computation** prepares the computation of total income and tax for one
financial year of an Indian company, as a tax professional would attach it to the return of
income. It starts from the books, takes what the books cannot know from the preparer, and can be
finalised so the figures stop moving. It files nothing.

## What it works out

| Line | Where it comes from |
| --- | --- |
| Net profit before tax as per the books | Revenue less expenses posted in the year, leaving out accounts with the Income tax expense subtype and closing journals |
| Add: depreciation charged in the books (s.32) | Accounts with the Depreciation subtype |
| Less: depreciation allowed under the Act (s.32) | Entered by the preparer from the block-of-assets working; until it is entered none is deducted and a warning shows |
| Add: cash payments over 10,000 to one person in a day (s.40A(3)) | The same working as the **Tax audit** page (Form 3CD clause 21(d)) |
| Other additions and deductions | Entered by the preparer, each with a description, section and amount (up to 50) |
| Less: brought forward business loss (s.72) | Entered by the preparer; set off up to the business income, the rest carried forward |

Tax is worked out on total income rounded to the nearest 10 (section 288A) at the chosen corporate
rate (the same regimes as advance tax: 22% under section 115BAA, 25% for turnover up to ₹400
crore, 30% otherwise, and 30% for firms), with surcharge, marginal relief and 4% cess. Tax already paid is TDS and advance tax
from the accounts chosen on the **Advance tax** page for that year, plus any other tax paid the
preparer enters. The result is self-assessment tax to pay, or the refund due. Income tax expense in
the books is shown for reference only. Interest under sections 234A to 234C is not worked out.

## Saving and finalising

- Anyone with `reports.read` can see the computation; saving inputs and finalising need
  `accounts.manage`.
- Saved inputs are kept per year (`income_tax_computations`, one row per organisation and year).
  Until finalised, every figure is live from the books.
- A computation can be finalised only after the year has ended and the inputs have been saved.
  Finalising freezes the inputs and every figure; the database guard refuses any later change or
  deletion. Postings made to the year afterwards are shown as a note comparing the profit then and
  now.
- Saving and finalising write `income_tax_computation.saved` and `income_tax_computation.finalised`
  audit events.

## API

- `GET /v1/orgs/:orgId/tax/income-computation?year=2025-26` (defaults to the last financial year)
- `PUT /v1/orgs/:orgId/tax/income-computation/:year` with `regime`, `taxDepreciation` (or null),
  `broughtForwardLoss`, `adjustments[]` and `otherCredits`
- `POST /v1/orgs/:orgId/tax/income-computation/:year/finalise`

Errors: `NOT_INDIA` (422), `INVALID_TAX_YEAR` (400), `FUTURE_YEAR` (422), `YEAR_NOT_ENDED`,
`NOT_SAVED` and `COMPUTATION_FINAL` (409).

## Not built

Minimum alternate tax (115JB), capital gains and other heads of income, unabsorbed depreciation
separately from business loss, deductions under Chapter VI-A, interest under 234A/B/C, the ITR
schema and e-filing.
