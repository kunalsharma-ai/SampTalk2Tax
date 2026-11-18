# Loans and treasury

Milestone 6, slice 4. A register of the organisation's borrowings (term loans, vehicle loans, working-capital term loans) repaid in monthly installments, and a treasury overview of cash against debt.

Everything posts through the normal journal code with journal source `LOAN`: periods must be open, entries balance, every posting is in the audit trail, and the database keeps posted history from being changed.

## Adding a loan

Banking → **Loans** → Add a loan. A loan (`LN-0001`) has a name, lender and loan account number, and:

| Term | Rules |
| --- | --- |
| Amount borrowed | More than zero |
| Interest rate | Annual percent, below 100, up to 4 decimal places |
| Term | 1 to 480 months |
| Repayment | **EMI**: equal monthly installments. **Equal principal**: the same principal each month plus interest on what is owed, so installments fall over time |
| Received on, first installment due | The first installment must fall after the loan is received. Later installments fall on the same day of each month, or the month's last day when it is shorter |
| Accounts | A loan account (long-term debt, or another current or non-current liability; 2700 Long-Term Loans in the standard chart), an expense account for interest (7100 Interest Expense) and the bank or cash account it is received into and repaid from |

The repayment schedule is worked out as the form is filled in, with the same engine the server uses, showing the EMI (or first installment), the total interest and every row.

Posting the money received is optional: debit the bank, credit the loan account, on the date received. Leave it off for a loan already in the books (from opening balances); to bring in a loan taken earlier, enter what is owed today as the amount and the installments left as the term.

A loan's amount, original rate, term, dates and accounts never change after it is added (database trigger). Its name, lender, account number, usual bank account and notes can.

## How interest and the schedule are worked out

* Interest is charged monthly on the balance at the start of each installment period (monthly rests), at the annual rate / 12, rounded to the currency (half up).
* EMI = P × r × (1 + r)^n / ((1 + r)^n − 1), with r the monthly rate and n the installments; at a zero rate it is P / n. It is rounded to the currency and the last installment takes what rounding leaves, so the loan clears exactly.
* For example ₹10,00,000 at 9.5% over 60 months is an EMI of ₹21,001.86; the first installment is ₹7,916.67 interest and ₹13,085.19 principal.

## Entries on a loan

Entries are made in date order (no earlier than the last entry, not in the future), and only the latest can be reversed.

| Entry | What it posts | What it changes |
| --- | --- | --- |
| **Installment** | Debit the loan account (principal), debit interest, credit the bank | Pays the next installment. By default the split comes from the schedule; when the lender's statement shows a different split, both the principal and the interest can be given |
| **Prepayment** | Debit the loan account, debit charges (optional, to an expense account), credit the bank | Pays principal early. Then either **keep the installment and finish sooner**, or **keep the end date and lower the installment**. Prepaying everything owed closes the loan |
| **Rate change** | Nothing | A floating-rate reset from the next installment. Either **keep the installment** (the term changes; refused if the installment would no longer cover the interest) or **keep the end date** (the installment is worked out again) |

Reversing the latest entry reverses its journal on the same date and puts the rate, installment and term back to what they were before; a loan closed by that entry opens again.

When nothing is owed, the loan is **Repaid** and takes no more entries.

The loan page shows what is owed, the next installment, interest paid, the split of principal due within 12 months (a current liability) and after, any installments due and not recorded, the entries, and the schedule: installments paid with their journals, then those still to pay at the current rate and installment.

## Treasury

Banking → **Treasury**:

* **Cash and bank**: the balance of every bank and cash account from posted journals up to today.
* **Borrowings**: what is owed on all loans, within 12 months and later.
* **Net cash** (or net debt): cash and bank less borrowings.
* **Interest paid this year**: from the start of the financial year.
* **Due in the next 30 days**, with installments already due and not recorded marked overdue.
* **Repayments over the next 12 months**: principal and interest by month (overdue installments are counted in this month).
* **Loan accounts against the ledger**: for each loan account, what the ledger says is owed against the loans kept here. A difference means a loan was brought in without posting it, or something was posted to the account outside a loan.

## Fixed deposits

Banking → **Fixed deposits** keeps term deposits with banks and the interest they earn (BANK-011, TRS-012).

**Placing a deposit** takes the bank, amount, annual rate, how interest compounds (quarterly, the usual for Indian bank deposits; monthly; half-yearly; yearly; or simple interest), the start and maturity dates (at most ten years apart), and four accounts: the bank or cash account it is paid from, an other current or non-current asset account for the deposit, an other current asset (or prepaid) account for interest earned but not yet paid, and an other income account for the interest. A new chart has no deposit accounts; add them in the chart of accounts first (the form says so). The form shows the maturity value as you type. Saving posts Dr deposit, Cr bank on the start date.

**How interest is worked out**: interest is added to the balance at the end of each full compounding period counted from the start date (a quarter ends on the start date's day three months later, on the last day of the month when that day does not exist), and the part period after the last full one earns simple interest on the compounded balance by days on a 365-day year. Simple interest is on the principal only, by days. Nothing is rounded until the end, so 100,000 at 7% compounded quarterly for one year earns 7,185.90.

**Accruing** posts the interest earned since the last accrual up to a date you choose (not before the start, not after maturity, not in the future): Dr interest accrued, Cr interest income. Each accrual is the interest earned to the date less what is already accrued, so the accruals add up to the maturity interest. From the list, **Accrue interest** does every open deposit at once to a date, capped at each one's maturity; use it at each month or quarter end.

**Closing**, at maturity or early, takes what the bank paid, the tax it deducted at source and the account the tax is claimed back in (a tax receivable account by default; never the deposit or its accrued interest account). The interest is what was paid plus the tax less the principal. The entry is Dr bank, Dr tax deducted, Cr deposit, Cr interest accrued, and Cr interest income for the rest; after a penalty for closing early, interest accrued but not paid is taken back with Dr interest income. A bank paying back less than the principal is refused.

**Reversing**: the latest accrual or the closing can be reversed with a reason and a date; reversing an accrual puts the accrued figure back, and reversing a closing reopens the deposit. The placement itself is not reversed here.

The list shows, for open deposits, the amount deposited, interest earned to date and what is accrued in the books, what is due at maturity, and how many mature within 30 days. Data is in the `deposits` and `depositEvents` collections.

## Permissions

Owners, admins and accountants (`loans.manage`) add loans and deposits and make entries. Everyone with `journals.read` sees loans, deposits and the treasury overview.

## API

| Route | Permission | |
| --- | --- | --- |
| `GET /v1/orgs/:orgId/loans` | journals.read | Loans with what is owed, the next installment, overdue installments and totals |
| `GET …/loans/treasury` | journals.read | The treasury overview |
| `GET …/loans/accounts` | journals.read | Accounts the forms offer |
| `GET …/loans/:id` | journals.read | One loan with entries, installments paid and the schedule still to pay |
| `POST …/loans` | loans.manage | Add a loan |
| `PUT …/loans/:id` | loans.manage | Change its name, lender, account number, usual bank account or notes |
| `POST …/loans/:id/repayments` | loans.manage | Record the next installment |
| `POST …/loans/:id/prepayments` | loans.manage | Prepay principal |
| `POST …/loans/:id/rate-changes` | loans.manage | Change the rate |
| `POST …/loans/:id/events/:eventId/reverse` | loans.manage | Reverse the latest entry |
| `GET …/deposits` | journals.read | Deposits with interest to date, accrued and at maturity, and totals |
| `GET …/deposits/accounts` | journals.read | Accounts the deposit forms offer |
| `GET …/deposits/:id` | journals.read | One deposit with its postings |
| `POST …/deposits` | loans.manage | Place a deposit |
| `POST …/deposits/accrue` | loans.manage | Accrue interest on every open deposit to a date |
| `POST …/deposits/:id/accrue` | loans.manage | Accrue interest on one deposit to a date |
| `POST …/deposits/:id/close` | loans.manage | Close at maturity or early |
| `POST …/deposits/:id/reverse` | loans.manage | Reverse the latest accrual or the closing |

Audit events: `loan.created`, `loan.updated`, `loan.repaid`, `loan.prepaid`, `loan.rate_changed`, `loan.event_reversed`, `deposit.placed`, `deposit.interest_accrued`, `deposit.closed`, `deposit.reversed`.

## Not built yet

Bullet, balloon, quarterly or step-up repayments; moratorium periods; drawdowns in tranches; foreign-currency loans; loans given; interest accrued at month end between installment dates; covenants and security; daily-balance interest; overdraft and cash-credit limits; investments other than fixed deposits (mutual funds, bonds, shares) and their market values; interest on savings or current account balances (record it from the bank statement); deposit renewals (close and place a new one); deposits in a foreign currency. The app records borrowings; it never moves money or borrows.
