# Tax audit support (TAX-026)

**Tax → Tax audit** prepares working papers for the tax audit report (Form 3CA/3CB with Form 3CD)
of one financial year, from the books. The auditor checks them; nothing is filed. Section and
clause numbers are those of the Income-tax Act, 1961 and Form 3CD.

| Paper | Rule | Source |
| --- | --- | --- |
| Is a tax audit needed | 44AB(a): turnover over 1 crore; 10 crore when cash is at most 5% of receipts and of payments | Posted invoices less credit notes (before GST); payments and receipts, cash = Cash-subtype account |
| Cash spending over 10,000 a day | 40A(3), clause 21(d): cash paid to one person in a day over 10,000 is disallowed in full | Supplier payments from cash accounts, by person and day |
| Cash received of 2 lakh or more | 269ST, clause 31: 2 lakh or more in cash from one person in a day | Customer receipts into cash accounts |
| TDS deposited late | Clause 34; 201(1A)(ii): 1.5% for every month or part from deduction to deposit | The TDS register (bills with TDS and their deposits) |
| Spending by GST registration | Clause 44 | Posted bills less vendor credits, before GST; registered = GSTIN on the bill, else the supplier's |

Months or part: whole months from the deduction date, plus one when the deposit day of the month
is later than the deduction day, at least one. Interest is rounded up to the rupee, line by line.

## API

`GET /v1/orgs/:orgId/tax-audit?year=2025-26` (reports.read; Indian organisations; defaults to
the last financial year; the current year is shown as it stands).

Engine: `packages/tax-engine/src/india/tax-audit.ts`. Service: `apps/api/src/tax-audit`.

## Not built

The 35,000 limit for transporters and rule 6DD exceptions, 44AB(b)-(e) grounds, section 43B dues
(clause 26), loans in cash (269SS/269T), composition and exempt suppliers in clause 44, expense
claims and journals paid in cash, and filing the report.
