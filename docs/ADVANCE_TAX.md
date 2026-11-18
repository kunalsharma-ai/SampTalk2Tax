# Advance tax (TAX-021)

**Tax → Advance tax** works out the year's advance income tax for a company, firm or LLP and
checks it against what was paid by each instalment date. Indian organisations only.

## How it is worked out

1. **Profit before tax so far**: revenue less expenses posted from 1 April to today (or to the
   year end for a past year). Income tax expense (accounts of subtype `TAX_EXPENSE`) and
   year-end closing journals are left out.
2. **Income for the year**: that profit scaled up by days to a full year, or the
   organisation's own estimate.
3. **Adjustments**: lines the organisation adds to go from book profit to taxable income
   (positive adds, such as disallowed expenses; negative takes off, such as extra tax
   depreciation).
4. **Tax**: taxable income (rounded to tens; a loss counts as nil) at the chosen rate:

   | Taxed as | Rate | Surcharge |
   |---|---|---|
   | Company, concessional | 22% | 10% flat |
   | Company, turnover up to ₹400 crore | 25% | 7% above ₹1 crore, 12% above ₹10 crore |
   | Company, other | 30% | 7% above ₹1 crore, 12% above ₹10 crore |
   | Firm or LLP | 30% | 12% above ₹1 crore |

   Marginal relief keeps the extra tax from crossing a surcharge threshold at or below the
   income above it. Health and education cess is 4% of tax and surcharge. The total is
   rounded to tens.
5. **Credits**: net debits in the tax year to the chosen *tax deducted at source* account,
   plus other credits entered on the plan.
6. **Advance tax for the year**: tax less credits. Under ₹10,000 none is due.
7. **Instalments**: 15%, 45%, 75% and 100% by 15 June, 15 September, 15 December and
   15 March. Payments are the posted net debits to the chosen *advance tax paid* account, by
   date. A past date with less paid is **Short**; for coming dates the amount to pay is what
   is still missing for that instalment.

## Plan

One plan per tax year (`advance_tax_plans`, unique on organisation and year): how the
business is taxed, the income method and estimate, adjustments, the two accounts and other
credits. Saving is audited (`advance_tax_plan.saved`) and posts nothing. Anyone with
`reports.read` sees it; `accounts.manage` saves it.

API: `GET /v1/orgs/:orgId/tax/advance-tax?taxYear=2026-27` and `PUT` with the plan.

## Not covered

Individuals and HUFs (slab rates), presumptive income (one instalment by 15 March), minimum
alternate tax, foreign companies, and interest for late or short instalments. Rates change
with each Finance Act: check them against the year's Act before paying.
