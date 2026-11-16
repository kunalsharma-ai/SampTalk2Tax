# Payroll: India (M3, slice 3)

Monthly payroll for organisations in India that keep their books in INR. The rules live in `packages/tax-engine/src/india/payroll.ts`. Every figure there carries its source and the date it applies from, and the web app shows them on **Payroll settings → Statutory rules in use**. The API (`apps/api/src/payroll`) stores employees, salaries, pay runs and payments, and posts them to the ledger.

> **Not yet reviewed by a payroll professional.** The rules are taken from the primary sources below. Before an organisation pays real salaries from these figures, a qualified person must check them (feature PAY-026).

## What it does

* **Settings.** The PF establishment code, ESI employer code and PT registration, plus seven accounts. By default these are created or reused as 6100 Salaries and Wages, 6110 Employer PF and ESI, and 2410–2414 for salaries, PF, ESI, PT and TDS payable. The accounts are frozen once a pay run has been posted.
* **Employees.**
  * Code, name, PAN (format-checked), UAN, ESI number, and dates of joining and leaving.
  * Work state, professional tax category (general, woman, exempt) and PF/EPS membership. Contributing to PF on full wages above the ceiling is optional.
  * Salary from a previous employer in the same tax year (taxable salary and TDS).
  * The code, joining date and previous-employer figures freeze once a payslip has been posted.
* **Salary structures.**
  * A structure applies from the 1st of a month and is kept as history.
  * Each component is marked as **wages** or an **excluded** allowance under the Code on Social Security 2020 s.2(88).
  * A structure that a posted payslip used cannot change. A new revision is added instead.
* **Pay runs.** One per month: draft → posted → void.
  * A draft holds a payslip for everyone employed in the month.
  * Pay is pro-rated for joining or leaving mid-month and for loss-of-pay days (whole or half).
  * A payslip can carry up to ten one-off earnings, such as a bonus.
  * Posting works out every payslip again and refuses with `PAYSLIPS_CHANGED` if salaries or earlier months changed after the draft was calculated.
* **Calculation per payslip** (`computePayslip`):
  * **Wages.** Wage components plus the part of excluded items above half of total pay (the 50% rule).
  * **PF.** Employee 12%. Employer 12%, split into EPS 8.33% of capped wages (at most ₹2,083 at the new ceiling) and the rest to EPF. EDLI 0.5% and admin 0.5%.
  * **PF wage ceiling.** ₹15,000, then ₹25,000 from 17 September 2026. September 2026 is split by days.
  * **ESI.** Employee 0.75% and employer 3.25%, rounded up to the rupee, while wages are at most ₹21,000. Coverage is decided in the first month of each contribution period (April–September, October–March) and holds for the whole period.
  * **Professional tax (Maharashtra).**
    * General: nil up to ₹7,500; ₹175 up to ₹10,000; ₹200 above that.
    * February: ₹300 instead of ₹200.
    * Women: nil up to ₹25,000.
    * The exempt category pays nothing.
  * **TDS on salary (new regime, tax year 2026-27).**
    * Projection: salary before this month (earlier posted runs plus the previous employer), plus this month, plus this month's regular pay for each remaining month until leaving or March.
    * Taxable income is the projection less the ₹75,000 standard deduction.
    * Slabs: 0–4L nil, then 5/10/15/20/25%, and 30% above ₹24L.
    * Rebate up to ₹60,000 for income up to ₹12L, with marginal relief.
    * Surcharge of 10/15/25% above ₹50L/1Cr/2Cr, with marginal relief, then 4% cess. The result is rounded to ₹10.
    * Monthly TDS is (tax for the year − TDS already deducted) / (months left including this one).
    * Without a PAN, TDS is at least 20% of the month's taxable salary once any tax is due for the year.
* **Ledger.** A posted run is one journal dated the last day of the month, with source `PAYROLL` and number PAY-000001…:
  * Debits: gross pay to 6100, and employer PF and ESI to 6110.
  * Credits: net pay, PF (employee + employer + EDLI + admin), ESI (both shares), PT and TDS to their payables.
  * Voiding reverses it. A run cannot be voided while a later run is posted or while a payment stands against it.
* **Paying.** For each liability (net pay, PF, ESI, PT, TDS) the run shows the amount and its due date:
  * Net pay is due on the pay date.
  * PF and ESI are due on the 15th of the next month.
  * TDS is due on the 7th of the next month, or 30 April for March.
  * Maharashtra PT is due at the end of the next month.
  * Recording a payment posts Dr payable, Cr bank (PAYP-000001…). A payment can be voided.
* **Payslip page.** A printable payslip with earnings, deductions, employer contributions, the income-tax working and year-to-date figures from posted runs.

## Not supported yet (do not rely on these)

* The old tax regime, and declarations or proofs (HRA exemption, 80C, and so on). Every employee is taxed under the new regime.
* Perquisites, arrears and relief under s.157 (formerly s.89).
* Professional tax for states other than Maharashtra. The payslip shows "not built yet" and deducts nothing.
* Labour welfare fund, gratuity provision, Payment of Bonus Act bonus, leave encashment, overtime, loans and advances.
* Daily-wage ESI exemption (employees earning up to ₹176 a day), and the employer PF admin minimum.
* ECR, ESIC, Form 24Q, Form 16 or bank transfer files. Nothing is filed or uploaded.
* Payroll approvals, cost allocation to departments or projects, payroll reports beyond the run and the payslip.
* Payslip PDF or email delivery.

## Sources (checked 2026-11-01)

* Code on Social Security 2020 s.2(88) (wages and the 50% proviso), in force from 21 November 2025.
* EPF Scheme 1952 para 2(f) and para 29; EPS 1995 para 3; EDLI Scheme 1976 para 8; EPFO administrative charges from 1 June 2018.
* Notification S.O. 5109(E) of 17 September 2026: PF wage ceiling ₹25,000 (also reported by KPMG and Keka).
* ESI (Central) Rules 1950 rules 50 and 51; contribution rates from 1 July 2019.
* Maharashtra State Tax on Professions, Trades, Callings and Employments Act 1975, Schedule I entry 1. **These slabs were taken from secondary sources (ClearTax, August 2025) and still need checking against the official schedule.**
* Income-tax Act 2025 s.202 (new regime) and s.392 (TDS on salary). Rates are as in the Finance Act 2025 and unchanged for 2026-27.

## Tests

* `packages/tax-engine/test/payroll.test.ts` (25 tests) covers:
  * Tax slabs, rebate and marginal relief, surcharge relief and rounding.
  * The 50% rule.
  * The PF ceiling change and the September split; full-wage PF.
  * ESI coverage and rounding; Maharashtra PT; due dates.
  * Whole payslips with loss of pay, one-offs, the last month and no PAN.
* `apps/api/test/payroll.e2e.test.ts` (10 tests) covers:
  * Settings and default accounts; employees, the PAN check and salary history.
  * Pay runs across two months, with a raise, a mid-month joiner and loss of pay.
  * Posting and the journal; refusal when payslips changed.
  * Payments and voids in the right order.
  * Database guards; viewer 403; other organisation 404.
* `apps/web/e2e/payroll-flow.test.mjs` (5 tests): in the browser, from setting up payroll through adding an employee, a draft with loss of pay, posting and the payslip to paying net salaries, plus the refused void.

## Maintenance

When a rate or ceiling changes:

1. Add a new dated entry with its source next to the old one (as `PF_WAGE_CEILINGS` does).
2. Add a test for the boundary month.
3. Update this file.

Posted payslips keep the figures they were posted with.
