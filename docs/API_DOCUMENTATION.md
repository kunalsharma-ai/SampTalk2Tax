# API

Base URL (local): `http://localhost:4000`. Live OpenAPI UI: `/docs`; JSON: `/docs/openapi.json`.

All org routes need `Authorization: Bearer <access token>` and membership in the organisation. Access tokens last 15 minutes (`JWT_TTL_SECONDS`); renew them with `POST /v1/auth/refresh`. Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`. Money values are decimal **strings**. Dates are `YYYY-MM-DD`.

## Endpoints

| Method & path | Permission | Purpose |
|---|---|---|
| `GET /health` | public | Liveness + DB check |
| `POST /v1/auth/register` | public | Create user and sign in: `accessToken`, `expiresIn`, `refreshToken`, `sessionId`, `sessionExpiresAt` |
| `POST /v1/auth/login` | public | Sign in (same response). 5 failures for one email lock it for 15 min (429) |
| `POST /v1/auth/refresh` | public | `{ refreshToken }` → new access token and a new refresh token. Inside the 30 s grace window `refreshToken` is `null` (keep the one you have); an older token ends the session |
| `POST /v1/auth/logout` | public | `{ refreshToken }` → ends that session. Always 204 |
| `GET /v1/auth/me` | auth | Profile and organisations |
| `GET /v1/auth/sessions` | auth | My live sessions (browser, address, created, last active, ends by, `current`) |
| `DELETE /v1/auth/sessions/current` | auth | Sign out this session |
| `DELETE /v1/auth/sessions/:id` | auth | Sign out one of my sessions (another user's id → 404) |
| `POST /v1/auth/sessions/revoke-others` | auth | Sign out every other session → `{ signedOut }` |
| `PUT /v1/auth/password` | auth | `{ currentPassword, newPassword }` → changes it and signs out other sessions → `{ otherSessionsSignedOut }` |
| `POST /v1/orgs` | auth | Create organisation (caller becomes OWNER); applies chart template and current fiscal year |
| `GET /v1/orgs` | auth | My organisations |
| `GET /v1/orgs/:orgId` | org.read | Organisation |
| `GET/POST /v1/orgs/:orgId/members` | members.read / members.manage | List / add existing user with role |
| `PUT /v1/orgs/:orgId/members/:userId` | members.manage | `{ role }`: change a role (only to and from roles the caller may grant; 409 `LAST_OWNER`) |
| `DELETE /v1/orgs/:orgId/members/:userId` | members.manage | Remove a member (409 `LAST_OWNER`) |
| `GET /v1/orgs/:orgId/invitations` | members.read | Invitations with status PENDING / EXPIRED / ACCEPTED / REVOKED |
| `POST /v1/orgs/:orgId/invitations` | members.manage | `{ email, role }` → `{ invitation, token }`. The token is returned once; the link is `/invite/<token>`. 409 `ALREADY_MEMBER`, `INVITE_EXISTS` |
| `POST /v1/orgs/:orgId/invitations/:id/renew` · `/revoke` | members.manage | New link and 7 more days (old link stops working) / revoke |
| `GET /v1/invitations/:token` | auth | Preview: organisation, role, inviter, status, `forYou`, `alreadyMember` |
| `POST /v1/invitations/:token/accept` | auth | Join with the invited role. Only for the invited email (403 `INVITE_OTHER_EMAIL`); 410 `INVITE_EXPIRED` / `INVITE_REVOKED` / `INVITE_ACCEPTED` |
| `GET /v1/orgs/:orgId/accounts` | accounts.read | Chart of accounts (`?type=`, `?includeInactive=true`) |
| `GET /v1/orgs/:orgId/accounts/:id` | accounts.read | One account |
| `POST /v1/orgs/:orgId/accounts` | accounts.manage | Create account |
| `PATCH /v1/orgs/:orgId/accounts/:id` | accounts.manage | Update (code/header/deactivate protected when in use) |
| `GET /v1/orgs/:orgId/periods` | periods.read | Periods (`?fiscalYear=`) |
| `POST /v1/orgs/:orgId/periods/fiscal-years` | periods.manage | Create a fiscal year |
| `POST /v1/orgs/:orgId/periods/:id/lock` / `unlock` | periods.lock | Lock / unlock |
| `GET /v1/orgs/:orgId/journals` | journals.read | List (`status`, `from`, `to`, `accountId`, `limit`, `offset`) |
| `GET /v1/orgs/:orgId/journals/:id` | journals.read | Entry with lines |
| `POST /v1/orgs/:orgId/journals` | journals.create (+ journals.post if `post: true`) | Create draft or create-and-post. Optional `Idempotency-Key` header |
| `PUT /v1/orgs/:orgId/journals/:id` | journals.create | Replace a draft |
| `DELETE /v1/orgs/:orgId/journals/:id` | journals.create | Delete a draft |
| `POST /v1/orgs/:orgId/journals/:id/post` | journals.post | Post a draft |
| `POST /v1/orgs/:orgId/journals/:id/reverse` | journals.reverse | Post a reversing entry |
| `GET /v1/orgs/:orgId/reports/trial-balance?asOf=&from=&includeZero=` | reports.read | Trial balance |
| `GET /v1/orgs/:orgId/reports/income-statement?from=&to=&departmentId=&projectId=` | reports.read | Income statement, optionally for one department or project |
| `GET /v1/orgs/:orgId/reports/balance-sheet?asOf=` | reports.read | Balance sheet |
| `GET /v1/orgs/:orgId/reports/general-ledger?accountId=&from=&to=` | reports.read | Account ledger |
| `GET /v1/orgs/:orgId/contacts?role=customer\|vendor&q=&includeInactive=` | contacts.read | Customers / vendors with outstanding, overdue and unapplied balances |
| `GET /v1/orgs/:orgId/contacts/:id` | contacts.read | One contact with balances |
| `GET /v1/orgs/:orgId/contacts/:id/statement?ledger=SALES\|PURCHASES&from=&to=` | contacts.read | Statement with opening balance and running balance |
| `POST` / `PATCH /v1/orgs/:orgId/contacts[/:id]` | contacts.manage | Create / update (role removal blocked once used) |
| `GET` / `POST` / `PATCH /v1/orgs/:orgId/tax-rates[/:id]` | accounts.read / accounts.manage | Tenant tax rates (rate immutable after creation) |
| `GET /v1/orgs/:orgId/{sales\|purchases}/documents?kind=&view=all\|draft\|open\|overdue\|paid\|void&contactId=` | sales.read / purchases.read | Invoices and credit notes, or bills and vendor credits |
| `GET /v1/orgs/:orgId/{sales\|purchases}/documents/:id` | …read | Document with lines, allocations, amount due |
| `POST /v1/orgs/:orgId/{sales\|purchases}/documents` | …manage (+ journals.post if `post: true`) | Create a draft, or create and post. `overrideCreditLimit` is audited |
| `PUT` / `DELETE …/documents/:id` | …manage | Replace / delete a draft |
| `POST …/documents/:id/post` | …read + journals.post | Post a draft (so an APPROVER can approve an accountant's draft) |
| `POST …/documents/:id/void` | …manage + journals.reverse | Void with a reason; posts an exact reversal. Refused while allocations exist |
| `POST …/documents/:id/apply-credit` | …manage | Apply a credit note / vendor credit to this invoice / bill |
| `GET` / `POST …/payments` | …read / …manage | Receipts (sales) or payments (purchases) with optional allocations. Optional `Idempotency-Key` header |
| `POST …/payments/:id/allocate`, `…/payments/:id/void` | …manage | Allocate unapplied money; void a payment |
| `POST …/allocations/:id/remove` | …manage | Remove an allocation (kept as history) |
| `GET …/ageing?asOf=` | …read | Ageing buckets per contact, reconciled to the control-account balance |
| `GET /v1/orgs/:orgId/banking/accounts` | banking.read | Bank and cash accounts with ledger balance, lines to review, last reconciliation |
| `POST /v1/orgs/:orgId/banking/accounts/:id/imports` | banking.manage | CSV statement (`csv` text + column `mapping`). `dryRun: true` previews and flags lines imported before; otherwise stores new lines |
| `GET …/banking/accounts/:id/imports` | banking.read | Import history |
| `GET …/banking/accounts/:id/lines?status=&from=&to=` | banking.read | Statement lines with their matches and a rule-based suggestion |
| `POST …/banking/accounts/:id/auto-match` | banking.manage | Applies only suggestions where line and ledger line are each other's single same-amount candidate within 14 days |
| `GET …/banking/lines/:id/candidates?search=` | banking.read | Unmatched posted ledger lines on the account within 90 days, closest amount first |
| `POST …/banking/lines/:id/match` | banking.manage | Match to one or more ledger lines whose net equals the statement amount |
| `POST …/banking/lines/:id/unmatch` | banking.manage | Remove the match; an entry created from the line is reversed |
| `POST …/banking/lines/:id/create-entry` | banking.manage + journals.post | Post a bank entry to another (non-control) account and match it |
| `POST …/banking/lines/:id/record-payment` | banking.manage + sales/purchases.manage | Money in → customer receipt, money out → vendor payment, with allocations; matched to the line |
| `POST …/banking/lines/:id/exclude` / `include` | banking.manage | Exclude a line that is not a real movement (reason required) / include it again |
| `POST …/banking/accounts/:id/reconciliations/preview` | banking.read | Figures, uncleared items, unmatched lines and the reasons it does not reconcile |
| `POST …/banking/accounts/:id/reconciliations` | banking.reconcile | Complete; locks the lines it covers |
| `GET …/banking/accounts/:id/reconciliations` | banking.read | History, including undone ones |
| `POST …/banking/reconciliations/:id/undo` | banking.reconcile + periods.lock | Undo the latest reconciliation of an account (reason required) |
| `GET /v1/orgs/:orgId/attachments?entityType=&entityId=&includeRemoved=` | read permission of the record | Files on a document, payment, journal entry, bank statement line or expense claim (claimants see their own claims' receipts) |
| `POST /v1/orgs/:orgId/attachments?entityType=&entityId=&fileName=` | manage permission of the record (journals.create for journals) | Body is the raw file (`Content-Type: application/octet-stream` or the file type). PDF, PNG, JPEG or WebP detected from the bytes; at most 5 MB, 20 per record; exact duplicates refused |
| `GET …/attachments/:id/content?inline=1` | read permission of the record | The file, byte for byte, with `nosniff`, a sandbox CSP, `no-store` and `X-Checksum-SHA256` |
| `POST …/attachments/:id/remove` | manage permission of the record | Remove with a reason; the record and bytes are kept |
| `GET /v1/orgs/:orgId/approval-policies` | org.read | One rule per document type (INVOICE, CREDIT_NOTE, BILL, VENDOR_CREDIT) |
| `PUT /v1/orgs/:orgId/approval-policies/:kind` | org.manage | `minAmount`, `requireDifferentApprover`, `isActive` |
| `GET /v1/orgs/:orgId/approvals?status=&documentId=` | sales.read / purchases.read per request | Requests with `canApprove` for the caller |
| `GET /v1/orgs/:orgId/approvals/for-document/:documentId` | …read | Whether a rule applies, whether the draft may post, and its request history |
| `POST /v1/orgs/:orgId/approvals` | sales.manage / purchases.manage | Submit a draft covered by a rule |
| `POST …/approvals/:id/approve` | approvals.decide (+ journals.post with `post: true`) | Approve; with `post: true` also posts. A posting problem is returned as `postError` and the approval stays |
| `POST …/approvals/:id/reject` | approvals.decide | Reject with a reason |
| `POST …/approvals/:id/withdraw` | sales.manage / purchases.manage | Take back a pending request |
| `GET /v1/orgs/:orgId/expense-claims/options` | expenses.submit | Expense accounts and tax rates a claimant may use (employees cannot read the chart of accounts) |
| `GET /v1/orgs/:orgId/expense-claims?status=&mine=` | expenses.submit (own) / expenses.read (all) | Claims with totals by status |
| `GET /v1/orgs/:orgId/expense-claims/:id` | claimant or expenses.read | Claim with lines, duplicate hints, receipt count and the caller's allowed actions |
| `POST /v1/orgs/:orgId/expense-claims` | expenses.submit | New draft: `title`, `lines[]` of `date`, `accountId` (expense account), `merchant`, `description`, `amount` (tax included), `taxRateId` |
| `PUT` / `DELETE …/expense-claims/:id` | claimant | Edit a draft or rejected claim (it becomes a draft) / delete a draft |
| `POST …/expense-claims/:id/submit`, `…/withdraw` | claimant | Submit for approval / take it back |
| `POST …/expense-claims/:id/approve` | approvals.decide + journals.post, not the claimant | Approve and post (optional `date`, `note`) |
| `POST …/expense-claims/:id/reject` | approvals.decide, not the claimant | Reject with a reason |
| `POST …/expense-claims/:id/reimburse` | expenses.reimburse | Pay back from a bank or cash account (`bankAccountId`, `date`, `reference`) |
| `POST …/expense-claims/:id/void` | journals.reverse | Void an approved, unpaid claim; reverses its posting |
| `GET /v1/orgs/:orgId/gst/registration` | accounts.read | `{ registered: false }` or GSTIN, state, effective date, the six GST accounts and the first GST document date |
| `PUT /v1/orgs/:orgId/gst/registration` | accounts.manage | `gstin`, `legalName`, `effectiveFrom`, optional `accounts` (six account ids); without them the standard accounts 2310–2312 and 1451–1453 are created or reused. GSTIN and accounts are frozen once documents carry them |
| `GET /v1/orgs/:orgId/gst/states` | contacts.read | GST state codes, whether each levies SGST or UTGST, and 96 for exports |
| `POST /v1/orgs/:orgId/gst/check-gstin` | contacts.read | Format and check character of a GSTIN (no portal lookup) |
| `GET /v1/orgs/:orgId/gst/returns/gstr-1?from=&to=` | reports.read | GSTR-1 working paper (B2B, B2CL, exports, B2CS, credit notes, nil/exempt, HSN, documents issued) |
| `GET /v1/orgs/:orgId/gst/returns/gstr-3b?from=&to=` | reports.read | GSTR-3B working paper with ITC set-off, reverse charge (3.1(d), 4(A)(2), 4(A)(3)) and a comparison with the GST ledger accounts |
| `GET` / `PUT /v1/orgs/:orgId/withholding/settings` | accounts.read / accounts.manage | TAN and the TDS and TCS payable accounts (`tan`, optional `tdsPayableAccountId`, `tcsPayableAccountId`; created as 2320/2321 otherwise). India and INR only; accounts frozen once tax is withheld |
| `GET /v1/orgs/:orgId/withholding/templates` | accounts.read | Income-tax Act 2025 s.393(1) section templates |
| `GET` / `POST /v1/orgs/:orgId/withholding/sections` | contacts.read / accounts.manage | List sections; create one from `{ template }` or a full rule (`kind`, `code`, `name`, rates, thresholds, `thresholdWindow`, `thresholdBasis`, `validFrom`) |
| `PATCH /v1/orgs/:orgId/withholding/sections/:id` | accounts.manage | Rename or (de)activate; the rule itself never changes |
| `POST /v1/orgs/:orgId/withholding/preview` | contacts.read | TDS/TCS for a draft (`documentKind`, `contactId`, `sectionId`, `issueDate`, `amount`, optional `documentId`): subject amount, base, rate, amount and the reason |
| `GET /v1/orgs/:orgId/withholding/register?kind=&from=&to=` | reports.read | Register rows, totals by section, to deposit with due dates and overdue, and the payable account check (period of a year or less) |
| `GET` / `POST /v1/orgs/:orgId/withholding/deposits` | reports.read / journals.post | List challans; record one (`kind`, `documentIds`, `depositDate`, `bankAccountId`, `challanReference`, optional `interestAmount` and `interestAccountId`), posting Dr payable, Cr bank |
| `POST /v1/orgs/:orgId/withholding/deposits/:id/void` | journals.reverse | Void a challan (`reason`); reverses its journal |
| `GET` / `PUT /v1/orgs/:orgId/payroll/settings` | payroll.read / payroll.manage | `{ configured: false }` or PF/ESI/PT codes and the seven payroll accounts (optional `accounts`; created as 6100, 6110, 2410–2414 otherwise). India and INR only; accounts frozen once a run is posted |
| `GET /v1/orgs/:orgId/payroll/rules` | payroll.read | The statutory rules in use with their sources |
| `GET` / `POST /v1/orgs/:orgId/payroll/employees` | payroll.read / payroll.manage | List employees; add one with its first `structure` (`effectiveFrom` on the 1st, `components` with `code`, `name`, `kind` WAGES/EXCLUDED, `monthlyAmount`) |
| `GET` / `PUT /v1/orgs/:orgId/payroll/employees/:id` | payroll.read / payroll.manage | One employee with salary history; update details (code, joining date and previous-employer figures frozen after a posted payslip) |
| `POST /v1/orgs/:orgId/payroll/employees/:id/salaries` | payroll.manage | Add a salary revision from a month (`STRUCTURE_USED` if that month's structure is already on a posted payslip) |
| `GET` / `POST /v1/orgs/:orgId/payroll/runs` | payroll.read / payroll.manage | List pay runs; create a draft (`period` YYYY-MM, `payDate`; `PAY_RUN_EXISTS` if one is open) |
| `GET` / `DELETE /v1/orgs/:orgId/payroll/runs/:id` | payroll.read / payroll.manage | A run with payslips, totals, liabilities with due dates and payments; delete a draft |
| `POST /v1/orgs/:orgId/payroll/runs/:id/recalculate` | payroll.manage | Work out a draft again (optional `payDate`), keeping loss-of-pay days and one-offs |
| `GET` / `PUT /v1/orgs/:orgId/payroll/runs/:id/payslips/:employeeId` | payroll.read / payroll.manage | The payslip with organisation, employee and year-to-date figures; set `lopDays` and `oneOffs` on a draft |
| `POST /v1/orgs/:orgId/payroll/runs/:id/post` | payroll.manage + journals.post | Post to the ledger (`PAYSLIPS_CHANGED` if a recalculation gives different figures) |
| `POST /v1/orgs/:orgId/payroll/runs/:id/void` | payroll.manage + journals.reverse | Void (`reason`, optional `date`); refused while a later run is posted or a payment stands |
| `POST /v1/orgs/:orgId/payroll/runs/:id/payments` | payroll.manage + journals.post | Record a payment of `liability` (NET_PAY, PF, ESI, PT, TDS) from `bankAccountId` on `date` with `reference`; posts Dr payable, Cr bank |
| `POST /v1/orgs/:orgId/payroll/runs/:id/payments/:paymentId/void` | payroll.manage + journals.reverse | Void a payment (`reason`) |
| `GET` / `PUT /v1/orgs/:orgId/compliance/settings` | reports.read / accounts.manage | GST return frequency (`MONTHLY` or `QUARTERLY` for QRMP) and `advanceTaxFrom` (or null); the GET also shows which areas apply and from when |
| `GET /v1/orgs/:orgId/compliance/calendar?from=&to=` | reports.read | Obligations due in the window (at most 400 days) with status, amount, paid, outstanding, evidence and filing, plus `overdueBefore` (open items from up to two years earlier) and a summary |
| `GET` / `POST /v1/orgs/:orgId/compliance/filings` | reports.read / accounts.manage | List filing records; mark a return filed or advance tax paid (`key` such as `GSTR3B:2026-10`, `filedOn`, `reference`, optional `note`). Payments are refused (`SETTLED_BY_RECORDS`) |
| `POST /v1/orgs/:orgId/compliance/filings/:id/void` | accounts.manage | Void a filing record (`reason`) |
| `GET` / `PUT /v1/orgs/:orgId/e-invoicing/settings` | accounts.read / accounts.manage | E-invoicing: `applicableFrom`, `aatoTenCroreOrMore` (turns on the 30-day limit), seller `tradeName`, `address1`, `address2`, `city`, `pincode`, `goodsUnit`, and an optional `irpPublicKey` (RSA PEM) for signature checks. Needs the GST registration (`GST_NOT_REGISTERED`); a bad key is `INVALID_KEY` |
| `GET /v1/orgs/:orgId/e-invoicing/documents?from=&to=` | sales.read | Invoices and credit notes in the window (at most 400 days) with their state (`READY`, `NEEDS_DATA`, `TOO_LATE`, `GENERATED`, `CANCELLED`, `NOT_REQUIRED`, `UNSUPPORTED`), reason, reporting deadline and IRN, plus a summary |
| `GET /v1/orgs/:orgId/e-invoicing/documents/:id` | sales.read | One document's state and its IRN history |
| `GET /v1/orgs/:orgId/e-invoicing/documents/:id/json` | sales.read | The INV-01 (schema 1.1) JSON for the IRP. `EINVOICE_DATA_MISSING` (with `details.issues`), `REPORTING_WINDOW_CLOSED` or `EINVOICE_NOT_APPLICABLE` when it is not ready |
| `POST /v1/orgs/:orgId/e-invoicing/bulk-json` | sales.read | `documentIds` (up to 100): `payloads` (a JSON array for the IRP's bulk upload) and `skipped` with reasons |
| `POST /v1/orgs/:orgId/e-invoicing/documents/:id/irn` | sales.manage | Record the IRP's response (`response`: Irn, AckNo, AckDt, SignedInvoice, SignedQRCode, bare or wrapped in `data`). Checked against the document (`IRP_RESPONSE_MISMATCH` with `details.issues`) and, with a saved key, the signature (`SIGNATURE_INVALID`). `IRN_EXISTS` while a live IRN stands |
| `POST /v1/orgs/:orgId/e-invoicing/documents/:id/irn/cancel` | sales.manage | Record that the IRN was cancelled on the IRP (`reason` `1`–`4`, `remark`, optional `cancelledAt`); only within 24 hours of the acknowledgement (`CANCEL_WINDOW_CLOSED`). Voiding a document with a live IRN is refused with `HAS_IRN` |
| `GET /v1/orgs/:orgId/budgets?fiscalYear=` | reports.read | The versions of a fiscal year (this year by default) with revenue, expense and net income totals, plus the years to choose from |
| `POST /v1/orgs/:orgId/budgets` | budgets.manage | New draft version: `fiscalYear`, `name`, `note`, `basis` `EMPTY`, `COPY` (`sourceBudgetId`) or `PRIOR_ACTUALS` (`changePercent`; `NO_PRIOR_ACTUALS` when last year has none) |
| `GET /v1/orgs/:orgId/budgets/:id` | reports.read | The version with its twelve months, one row per revenue and expense account (`amounts` null when not budgeted) and totals |
| `PATCH /v1/orgs/:orgId/budgets/:id` | budgets.manage | Rename a draft (`BUDGET_NOT_DRAFT` otherwise) |
| `PUT /v1/orgs/:orgId/budgets/:id/lines` | budgets.manage | `lines: [{ accountId, amounts: [12 decimal strings] or null }]` replaces those accounts in a draft; `BUDGET_INVALID` with `details.issues` |
| `DELETE /v1/orgs/:orgId/budgets/:id` | budgets.manage | Delete a draft (`BUDGET_IN_USE` when another version was copied from it) |
| `POST /v1/orgs/:orgId/budgets/:id/submit`, `/withdraw` | budgets.manage | Draft → submitted (`BUDGET_EMPTY` without amounts) and back |
| `POST /v1/orgs/:orgId/budgets/:id/return`, `/approve` | approvals.decide | Send back to draft with a `reason`, or approve (supersedes the year's approved version). Not by the submitter: `SELF_APPROVAL` |
| `GET /v1/orgs/:orgId/budgets/:id/variance?granularity=&asOf=` | reports.read | `granularity` MONTH, QUARTER or YEAR. Budget against posted actuals per account and for revenue, expenses and net income: budget, actual, variance, percent and favourable per period, year to date and full-year budget |
| `GET /v1/orgs/:orgId/cash-flow/forecast?horizonDays=&asOf=` | reports.read | `horizonDays` 30, 60, 90, 180 or 365 (default 90); `asOf` today (India time) by default, or an earlier day up to 2 years back for a backtest (`INVALID_DATE` otherwise). Daily `days` (base, low, high), `buckets`, `closing`, `lowest`, `belowBuffer`, `totals`, open `receivables` and `payables` with expected dates and their basis, `planned` occurrences, `unapplied` receipts and payments, payment `delays` |
| `GET`, `PUT /v1/orgs/:orgId/cash-flow/settings` | reports.read / budgets.manage | `minimumBalance` (0 = no warning) |
| `GET`, `POST /v1/orgs/:orgId/cash-flow/items`; `PUT`, `DELETE …/items/:id` | reports.read / budgets.manage | Planned receipts and payments: `name`, `direction` IN or OUT, `amount` (> 0, 2 decimals), `frequency` ONCE, WEEKLY, MONTHLY, QUARTERLY or YEARLY, `startDate`, `endDate` (not for ONCE; `INVALID_ITEM`), `note`, `isActive` |
| `GET`, `POST /v1/orgs/:orgId/cash-flow/forecasts` | reports.read / budgets.manage | Saved forecasts with their accuracy so far; save the forecast for `horizonDays` and optional `asOf` (a backtest when earlier than today) with a `note` |
| `GET /v1/orgs/:orgId/cash-flow/forecasts/:id` | reports.read | A saved forecast's days and its accuracy against the actual closing cash: days measured, mean absolute error, bias, % of days inside the range, largest miss, day-by-day series |
| `GET /v1/orgs/:orgId/kpis?month=YYYY-MM` | reports.read | The 13 KPIs for a month (the last complete month by default; `INVALID_MONTH` for a month not started): value or `reason`, `components`, `previous`, `change`, `improved`, `lastYear`, `target` with `status` (MET, MISSED, NO_VALUE), 13-month `series`; and `customers` (revenue by customer, last 12 months) |
| `GET /v1/orgs/:orgId/kpis/targets`; `PUT`, `DELETE …/kpis/targets/:kpi` | reports.read / budgets.manage | A target per KPI: `comparator` AT_LEAST or AT_MOST, `target` (up to 4 decimals; `INVALID_TARGET` when negative for a ratio, percentage or days), `note` |
| `GET /v1/orgs/:orgId/management-reports` | reports.read | The last 24 months with each report's status, commentary flag and who finalised it |
| `GET /v1/orgs/:orgId/management-reports/:month` | reports.read | The month's report: P&L `lines` (actual, previous, lastYear, budget, variance, favourable, ytd, ytdBudget), `cash`, `kpis`, `customers`, `commentary`, `status`; once FINAL the frozen figures plus `changedSince` |
| `PUT /v1/orgs/:orgId/management-reports/:month/commentary` | budgets.manage | `commentary` (≤ 10,000 characters); `REPORT_FINAL` (409) once final |
| `POST /v1/orgs/:orgId/management-reports/:month/finalise` | budgets.manage | Freeze figures and commentary; `MONTH_NOT_ENDED` or `REPORT_FINAL` (409) |
| `GET /v1/orgs/:orgId/alerts?status=ACTIVE\|DISMISSED\|CLEARED\|ALL&fresh=` | reports.read | Alerts by severity with `evidence`, `summary` counts and `lastScan`; runs the checks first when the last run is over 60 minutes old (unless `fresh=false`) |
| `POST /v1/orgs/:orgId/alerts/scan` | alerts.manage | Run every check that is on now; returns the run (found, opened, reopened, cleared, failures) |
| `GET /v1/orgs/:orgId/alerts/:alertId` | reports.read | One alert with the check's description and its `history` |
| `POST /v1/orgs/:orgId/alerts/:alertId/acknowledge`, `/dismiss`, `/reopen` | alerts.manage | `note` (optional) or `reason` (dismiss, 3–1,000 characters); `INVALID_ALERT_STATE` (409) from the wrong state |
| `GET /v1/orgs/:orgId/alert-rules`; `PUT …/alert-rules/:rule` | reports.read / alerts.manage | The nine checks with description, settings, values and who changed them; save `enabled` and `params` (`INVALID_SETTING` naming the setting when out of range) |
| `GET /v1/orgs/:orgId/integrations`; `PUT …/integrations/ai`, `PUT …/integrations/email`; `POST …/integrations/:kind/test`; `DELETE …/integrations/:kind` (`ai` or `email`) | org.manage | Integrations set up in the app: the organisation's own Claude key and model and its own mail server, stored encrypted, never returned, tested for real. See [`INTEGRATIONS.md`](INTEGRATIONS.md) |
| `GET /v1/orgs/:orgId/copilot/status` | copilot.use | AI copilot: `configured` (a Claude key is available: the organisation's own or the server's), `source` (ORGANISATION, SERVER or NONE), `provider`, `model`, `enabled` for the organisation and who changed it, `canChange`, `questionsPerHour`, `tools` |
| `PUT /v1/orgs/:orgId/copilot/settings` | org.manage | `enabled`: turn the copilot on or off for the organisation (off by default) |
| `GET /v1/orgs/:orgId/copilot/conversations` | copilot.use | The member's own conversations, newest first: title, number of questions, `closed` |
| `POST /v1/orgs/:orgId/copilot/conversations`; `POST …/conversations/:id/messages` | copilot.use | `question` (1–4,000 characters): starts a conversation or asks a follow-up. Returns the conversation at once with the answer `PENDING`; read it until the answer is COMPLETE, REFUSED, INCOMPLETE or FAILED. `AI_NOT_CONFIGURED` (503), `COPILOT_OFF`, `COPILOT_BUSY`, `CONVERSATION_CLOSED` (409), `COPILOT_LIMIT` (429) |
| `GET /v1/orgs/:orgId/copilot/conversations/:id`; `DELETE` | copilot.use | One of the member's conversations: messages with `text`, `sources` (reports looked at, with a page path), `errorCode`/`errorMessage`, `servedModel`, `usage`. Delete removes it (`COPILOT_BUSY` while answering). Another member's conversation is 404. See [`AI_COPILOT.md`](AI_COPILOT.md) |
| `GET /v1/orgs/:orgId/workflows/catalogue` | workflows.manage | Automations builder: triggers with their facts (key, label, type, options), `kind` (`event` or `schedule`) and `emailsContact`, schedule frequencies and weekdays, condition tests per fact type, roles and members a task or email can go to, limits (10 conditions, 5 actions, 6 delivery attempts and the retry delays), `webhooksMustBeHttps`, `email` {`ready`, `from`} |
| `GET /v1/orgs/:orgId/workflows`; `POST` | workflows.manage | List: name, on/off, version, trigger, number of conditions, action types, last run, runs in the last 30 days (acted, skipped, failed). Create: `name`, `description`, `trigger`, `triggerParams` (`SCHEDULE`: {`frequency` DAILY/WEEKLY/MONTHLY, `time` HH:MM India time, `weekday` 1–7 for weekly, `dayOfMonth` 1–28 for monthly}; `INVOICE_OVERDUE`: {`days` 1–365}; `BILL_DUE_SOON`: {`days` 0–90}; otherwise `{}`), `conditions` [{`fact`, `op`, `value`}], `actions` [{`type`: `CREATE_TASK`, `title`, `description`, `assignTo` {`role`} or {`userId`}, `dueInDays` 0–365 or null} or {`type`: `WEBHOOK`, `url`} or {`type`: `SEND_EMAIL`, `to` {`role`} or {`userId`} or {`contact`: true}, `subject`, `body`}]; starts off. `422 INVALID_WORKFLOW` with `details.issues` listing every problem |
| `GET /v1/orgs/:orgId/workflows/:id`; `PUT` | workflows.manage | The workflow with its definition, `triggerLabel` in words, `nextOccurrence` (on schedules that are on), `activatedAt`, signing secret, versions and the last 20 runs. Save: the same fields plus `baseVersion` (the version edited; `409 WORKFLOW_CHANGED` if someone saved since) and an optional `note`; a change to what it does makes a new version |
| `POST /v1/orgs/:orgId/workflows/:id/turn-on`; `…/turn-off` | workflows.manage | Turn on (acts only on events, times and dates from now) or off (queued webhooks and emails are still sent) |
| `POST /v1/orgs/:orgId/workflows/:id/rotate-secret` | workflows.manage | A new webhook signing secret; the old one stops working at once |
| `POST /v1/orgs/:orgId/workflows/:id/test` | workflows.manage | Dry run on the latest event the trigger listens to, or `eventId`; for a schedule, the latest time it came round; for a date trigger, a real open invoice or bill: `matched` and the run (facts, conditions with actual values, task and email previews). Creates nothing; `sendWebhooks: true` sends each webhook once with `"test": true`, and each email to the person testing only, with `[Test]` in front of the subject. `404 NO_SAMPLE_EVENT` when nothing has happened yet |
| `GET /v1/orgs/:orgId/workflows/:id/runs?status=&before=&limit=` | workflows.manage | Runs, newest first: version, status, error, link to the record, facts, conditions, actions with attempts (status, answer, duration), next attempt, `canRetry` |
| `GET /v1/orgs/:orgId/workflow-runs/:runId`; `POST …/actions/:position/retry` | workflows.manage | One run (with `occurrenceKey` for schedule triggers); send a failed webhook or email again now (`409 NOT_FAILED`, `TEST_RUN`, `TOO_MANY_ATTEMPTS`, `NO_RECIPIENTS`, `EMAIL_NOT_SET_UP`) |
| `GET /v1/orgs/:orgId/collections`; `POST …/collections/runs` | collections.manage | AI collections agent: overview (AI and email readiness, counts, latest run with customers left out) and starting a drafting run (`503 AI_NOT_CONFIGURED`, `409 AI_OFF`, `COLLECTIONS_BUSY`). See [`AI_COLLECTIONS.md`](AI_COLLECTIONS.md) |
| `GET /v1/orgs/:orgId/collections/reminders?status=`; `GET …/reminders/:id`; `POST …/:id/check`; `POST …/:id/send`; `POST …/:id/reject` | collections.manage | Reminders with facts, risk, checks; dry check of an edit; approve and send (`422 DRAFT_CHECKS_FAILED`, `409 DRAFT_OUT_OF_DATE`, `NOT_SENDABLE`, `EMAIL_NOT_SET_UP`); reject with a note |
| `GET /v1/orgs/:orgId/banking/accounts/:accountId/ai`; `POST …/ai/runs`; `GET …/ai/suggestions?status=` | banking.read / banking.manage | AI reconciliation: overview, start a run (`503 AI_NOT_CONFIGURED`, `409 AI_OFF`, `BANK_AI_BUSY`), suggestions with the proposal, confidence, reason, checks, `canAccept`. See [`AI_RECONCILIATION.md`](AI_RECONCILIATION.md) |
| `GET /v1/orgs/:orgId/banking/ai-suggestions/:id`; `POST …/accept`; `POST …/dismiss` | banking.read / banking.manage | One suggestion; accept (applied through matching, receipts or entries by hand; `409 NOT_ACCEPTABLE` and their errors); dismiss with a note |
| `GET /v1/orgs/:orgId/close`; `GET …/close/:periodId` | periods.read | Month-end close: months with close status; one month's checklist (live, or as certified), readiness, AI review, proposed adjusting entries, certifications. See [`MONTH_END_CLOSE.md`](MONTH_END_CLOSE.md) |
| `POST …/close/:periodId/start`; `POST …/tasks`; `POST …/reviews`; `POST …/close/adjustments/:id/post`; `POST …/reject` | close.manage (posting also journals.post) | Start the close, tasks for open checks, AI review (`503 AI_NOT_CONFIGURED`, `409 AI_OFF`, `CLOSE_REVIEW_BUSY`, `CLOSE_CLOSED`), post an entry with its reversal (`409 NOT_POSTABLE`) or reject it |
| `POST …/close/:periodId/close`; `POST …/reopen` | periods.lock | Close (`409 CLOSE_NOT_READY` with the open check keys; a note needed with warnings open), locking the period with a certification; reopen with a reason (`409 LATER_MONTH_CLOSED`). `POST …/periods/:id/unlock` answers `409 PERIOD_CLOSE_CERTIFIED` while a close stands |
| `GET /v1/orgs/:orgId/ai-activity?limit=` | audit.read | Every copilot answer, reminder draft, bank suggestion and month-end close review: model asked and answering, tokens, outcome, decision |
| `GET /v1/orgs/:orgId/ai-control` | audit.read | AI control center: AI on/off/stopped, every agent's action level, switch, monthly token budget, usage, failures and acceptance rate. See [`AI_CONTROL_CENTER.md`](AI_CONTROL_CENTER.md) |
| `PUT …/ai-control/agents/:agent`; `POST …/ai-control/stop`; `POST …/ai-control/resume` | org.manage | Switch an agent and set its budget; emergency stop with a reason (`409 AI_ALREADY_STOPPED`); turn AI back on (`409 AI_ALREADY_ON`). Agents refuse with `409 AGENT_OFF` or `429 AI_BUDGET_REACHED` |
| `GET /v1/orgs/:orgId/fixed-assets`; `GET …/:id`; `GET …/accounts`; `GET …/depreciation?month=` | journals.read | Fixed asset register, one asset with its schedule, accounts by role, depreciation runs and the preview of a month. See [`FIXED_ASSETS.md`](FIXED_ASSETS.md) |
| `POST …/fixed-assets`; `PUT …/:id`; `POST …/:id/dispose`; `POST …/depreciation/runs`; `POST …/depreciation/runs/:id/reverse` | assets.manage | Add or change an asset (purchase optionally posted), dispose with gain or loss, post a month's depreciation (with catch-up), reverse the latest run |
| `GET /v1/orgs/:orgId/deferrals`; `GET …/:id`; `GET …/accounts`; `GET …/releases?month=`; `GET …/accruals?month=` | journals.read | Prepaid expense and deferred revenue schedules, one schedule with its releases, accounts by role, release runs and the preview of a month, accruals. See [`PREPAID_AND_DEFERRED.md`](PREPAID_AND_DEFERRED.md) |
| `POST …/deferrals`; `PUT …/:id`; `POST …/:id/end`; `POST …/releases/runs`; `POST …/releases/runs/:id/reverse`; `POST …/accruals`; `POST …/accruals/:id/cancel` | deferrals.manage | Add or change a schedule (payment or receipt optionally posted), end it early, post a month's releases (with catch-up), reverse the latest run, post an accrual with its automatic reversal, cancel an accrual |
| `GET /v1/orgs/:orgId/dimensions?type=` | journals.read | Departments and projects with how many lines use each. See [`FINANCIAL_DIMENSIONS.md`](FINANCIAL_DIMENSIONS.md) |
| `GET …/dimensions/profit?type=&from=&to=&includeInactive=` | reports.read | Profit and loss with a column per department or project and Not assigned |
| `POST …/dimensions`; `PUT …/dimensions/:id` | accounts.manage | Add or change a department or project, or make it inactive. Journal and document lines take `departmentId` and `projectId` |
| `GET /v1/orgs/:orgId/loans`; `GET …/loans/:id`; `GET …/loans/treasury`; `GET …/loans/accounts` | journals.read | Loans with what is owed and the schedule, and the treasury overview (cash, borrowings, net cash, installments due, the ledger check). See [`LOANS_AND_TREASURY.md`](LOANS_AND_TREASURY.md) |
| `POST …/loans`; `PUT …/loans/:id`; `POST …/loans/:id/repayments`; `POST …/loans/:id/prepayments`; `POST …/loans/:id/rate-changes`; `POST …/loans/:id/events/:eventId/reverse` | loans.manage | Add or change a loan, record an installment, prepay, change the rate, reverse the latest entry |
| `GET /v1/orgs/:orgId/invoice-templates`; `GET …/invoice-templates/:id`; `GET …/invoice-print/:documentId`; `GET …/invoice-print/:documentId/html` | sales.read | Invoice templates, and an invoice's print data or rendered page. See [`INVOICE_TEMPLATES.md`](INVOICE_TEMPLATES.md) |
| `GET /v1/orgs/:orgId/reports/export/:report?format=csv\|xlsx\|pdf` | reports.read (ageing also sales.read or purchases.read) | Downloads trial-balance, income-statement, balance-sheet, general-ledger, receivables-ageing, payables-ageing or profit-by-dimension as a file with the report's own parameters; audited as `report.exported` with the file's SHA-256. See [`REPORT_EXPORTS.md`](REPORT_EXPORTS.md) |
| `GET/POST /v1/orgs/:orgId/consolidation/groups`; `GET/PUT/DELETE …/groups/:groupId`; `POST/DELETE …/members`, `PUT …/members/:memberOrgId` (ownership percentage), `PUT …/members/:memberOrgId/intercompany-accounts`; `GET/POST …/intercompany`, `POST …/intercompany/:id/reverse` (journals.post / journals.reverse in both companies); `PUT …/rates`, `DELETE …/rates/:rateId`; `POST/PUT/DELETE …/rules` | reports.read to read; org.manage to change (and owner or admin of each company added) | Consolidation groups. `GET …/groups/:groupId/report?from&to` (reports.read in every member) gives the worksheet and consolidated statements; `GET …/export/:statement?from&to&format=` downloads them. See [`CONSOLIDATION.md`](CONSOLIDATION.md) |
| `GET /v1/orgs/:orgId/twin/templates`, `GET …/twin/baseline?baselineMonths&horizonMonths`, `POST …/twin/simulate`, `GET …/twin/compare?ids=`; `GET/POST …/twin/scenarios`, `GET/PUT/DELETE …/twin/scenarios/:id` | reports.read to read and simulate; scenarios.manage to save, change or delete | Financial digital twin: what-if scenarios played forward from the posted books. Never posts. See [`DIGITAL_TWIN.md`](DIGITAL_TWIN.md) |
| `POST …/twin/scenarios/:id/versions/:version/restore`, `POST …/submit`, `…/withdraw`, `…/reopen`; `POST …/approve`, `…/reject`; `POST …/notes`, `PUT/DELETE …/notes/:noteId` | scenarios.manage for versions and approval steps; scenarios.approve to decide (not your own submission); reports.read for notes | Scenario war room: versions, approval and notes. See [`WAR_ROOM.md`](WAR_ROOM.md) |
| `GET /v1/orgs/:orgId/recovery/options`; `GET/POST …/recovery/plans`, `GET/PUT/DELETE …/recovery/plans/:id`; `POST …/plans/:id/actions`, `PUT/DELETE …/plans/:id/actions/:actionId`; `POST …/plans/:id/scenario` | reports.read to read; scenarios.manage to change | Financial recovery planner: options from the books measured on the twin, and tracked plans. Never posts, pays or borrows. See [`RECOVERY_PLANNER.md`](RECOVERY_PLANNER.md) |
| `GET /v1/orgs/:orgId/cfo/assessment`, `GET …/cfo/questions/:key`, `GET …/cfo/ai`; `GET/POST …/cfo/reports`, `GET/DELETE …/cfo/reports/:id`; `POST …/reports/:id/refresh`, `PUT …/reports/:id/commentary`, `POST …/reports/:id/summary`, `POST …/reports/:id/finalise` | reports.read to read (plus sales.read or purchases.read for answers listing those records); cfo.reports for packs | Virtual CFO: health score, analyses, worked answers, board packs and investor updates with an AI summary checked against the figures. Never posts. See [`VIRTUAL_CFO.md`](VIRTUAL_CFO.md) |
| `GET /v1/orgs/:orgId/benchmarking`; `PUT/DELETE …/benchmarking/participation`; `POST …/benchmarking/participation/refresh` | reports.read to read; org.manage to join, change what is shared, refresh or withdraw | Privacy-preserving benchmarking: ten metrics from the books, compared with medians and quartiles of at least five other participants. See [`BENCHMARKING.md`](BENCHMARKING.md) |
| `POST …/invoice-templates`; `PUT …/invoice-templates/:id`; `POST …/:id/duplicate`; `POST …/:id/default`; `POST …/:id/archive`; `PUT`/`DELETE …/:id/logo` | templates.manage | Create, design, copy, make default, archive templates; logos |
| `PUT …/invoice-print/:documentId/template` | sales.manage | Print an invoice with a chosen template (allowed after posting) |
| `POST …/invoice-print/:documentId/signature`; `POST …/signature/withdraw`; `GET`/`PUT`/`DELETE …/signatures/me` | documents.sign | E-sign posted invoices; your signature |
| `GET /v1/orgs/:orgId/tasks?scope=mine|all&status=OPEN|DONE|CANCELLED|ALL` | tasks.use | Tasks for me and my role (`all`: every task, owners and admins only), with counts of my open and overdue tasks; each with assignee, due date, `overdue`, link (path and label), the workflow that made it, who closed it and the note, `canClose` |
| `GET /v1/orgs/:orgId/tasks/count`; `GET …/tasks/:id` | tasks.use | My open tasks; one task I can see (404 otherwise) |
| `POST /v1/orgs/:orgId/tasks` | tasks.use | `title`, `description`, `assignTo` {`role`} or {`userId`} (a member who can take tasks; `422 ASSIGNEE_NOT_MEMBER`), `dueDate` |
| `POST /v1/orgs/:orgId/tasks/:id/complete`; `…/cancel` | tasks.use | `note` optional. For the assignee, their role, the creator, or an owner or admin; `409 TASK_CLOSED` |
| `GET` / `PUT /v1/orgs/:orgId/e-way-bills/settings` | accounts.read / accounts.manage | E-way bills: `threshold`, optional `intraStateThreshold`, dispatch `address1`, `address2`, `city`, `pincode`, `goodsUnit`. Needs the GST registration (`GST_NOT_REGISTERED`); GET suggests the e-invoicing address before set-up |
| `GET /v1/orgs/:orgId/e-way-bills/documents?from=&to=` | sales.read | Posted invoices in the window with their state (`NEEDED`, `OPTIONAL`, `NEEDS_DATA`, `TOO_OLD`, `GENERATED`, `CANCELLED`, `NOT_APPLICABLE`, `UNSUPPORTED`), reason, value of goods and e-way bill, plus a summary |
| `GET /v1/orgs/:orgId/e-way-bills/documents/:id` | sales.read | One invoice's state, the live e-way bill (current Part B, validity, expected validity, vehicle updates, cancellable until) and its history |
| `POST /v1/orgs/:orgId/e-way-bills/documents/:id/json` | sales.read | `transport` (mode, distanceKm, vehicleNo, vehicleType, transDocNo, transDocDate, transporterId, transporterName): the portal's bulk JSON (`version`, `billLists`). `EWAY_BILL_DATA_MISSING` (with `details.issues`), `DOCUMENT_TOO_OLD` or `EWAY_BILL_NOT_APPLICABLE` when it cannot be made |
| `POST /v1/orgs/:orgId/e-way-bills/documents/:id/e-way-bill` | sales.manage | Record the e-way bill: `number` (12 digits), `generatedAt`, `validUntil` (required with Part B, `VALIDITY_REQUIRED`; refused without it), `transport`. The response also gives the validity worked out under Rule 138(10). `EWAY_BILL_EXISTS` while a live one stands |
| `POST /v1/orgs/:orgId/e-way-bills/documents/:id/e-way-bill/vehicle` | sales.manage | Record a new Part B (`mode`, vehicle or transport document, `fromPlace`, `fromStateCode`, `reason` `1`–`4`, `remark`, optional `updatedAt`, `validUntil`); `EWAY_BILL_EXPIRED` after validity, `NO_EWAY_BILL` without a live one |
| `POST /v1/orgs/:orgId/e-way-bills/documents/:id/e-way-bill/cancel` | sales.manage | Record that it was cancelled on the portal (`reason` `1`–`4`, `remark`, optional `cancelledAt`); only within 24 hours of generation (`CANCEL_WINDOW_CLOSED`). Voiding an invoice with a live e-way bill is refused with `HAS_EWAY_BILL` |
| `GET /v1/orgs/:orgId/audit-events` | audit.read | Audit events (newest first) |
| `GET /v1/orgs/:orgId/audit-events/verify` | audit.read | Recompute the hash chain |

## Example: create and post a journal

```http
POST /v1/orgs/{orgId}/journals
Authorization: Bearer …
Idempotency-Key: inv-2026-0042
Content-Type: application/json

{
  "date": "2026-10-15",
  "memo": "Export invoice INV-0042",
  "post": true,
  "lines": [
    { "accountId": "…AR…",      "debit": "1000.00", "currency": "USD", "exchangeRate": "83.4567" },
    { "accountId": "…Revenue…", "credit": "83456.70" }
  ]
}
```

`201` with the posted entry (`displayNumber: "JE-000042"`, line functional amounts). A retry with the same key and body returns `200` with header `Idempotent-Replay: true`.

## Errors

`{ "error": "<CODE>", "message": "…", ... }`

| HTTP | Codes |
|---|---|
| 400 | `VALIDATION_FAILED` (with `issues[]`), `INVALID_RANGE` |
| 401 | `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `TOKEN_EXPIRED` (refresh and retry), `SESSION_REVOKED`, `SESSION_EXPIRED`, `INVALID_REFRESH_TOKEN`, `REFRESH_TOKEN_REUSED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND`, `USER_NOT_FOUND` |
| 409 | `PERIOD_NOT_OPEN`, `ALREADY_POSTED`, `ENTRY_POSTED`, `ALREADY_REVERSED`, `IS_REVERSAL`, `NOT_POSTED`, `SYSTEM_ENTRY`, `DOCUMENT_POSTED`, `ALREADY_VOID`, `HAS_ALLOCATIONS`, `CREDIT_LIMIT_EXCEEDED`, `DUPLICATE_BILL`, `TOTAL_CHANGED`, `CONTACT_IN_USE`, `ALREADY_REMOVED`, `BANK_MATCHED`, `ALREADY_MATCHED`, `NOT_MATCHED`, `LINE_RECONCILED`, `LINE_EXCLUDED`, `NOTHING_NEW`, `PERIOD_RECONCILED`, `NOT_LATEST`, `ALREADY_UNDONE`, `ACCOUNT_IN_USE`, `NON_ZERO_BALANCE`, `HAS_CHILDREN`, `CONFLICT`, `FISCAL_YEAR_EXISTS`, `LEDGER_INTEGRITY` |
| 422 | `JOURNAL_INVALID` / `DOCUMENT_INVALID` / `STATEMENT_INVALID` / `RECONCILIATION_FAILED` (with `issues[]`), `INVALID_MATCH`, `OPENING_REQUIRED`, `OPENING_MISMATCH`, `CONTROL_ACCOUNT`, `INVALID_ALLOCATION`, `INVALID_BANK_ACCOUNT`, `TAX_ACCOUNT_REQUIRED`, `NOT_A_CUSTOMER`, `NOT_A_VENDOR`, `CONTACT_INACTIVE`, `NO_FISCAL_PERIOD`, `IDEMPOTENCY_KEY_REUSED`, `INVALID_PARENT`, `INVALID_SUBTYPE`, `WEAK_PASSWORD`, `WRONG_PASSWORD`, `SAME_PASSWORD`, `INVALID_DATE` |
| 429 | `RATE_LIMITED`, `TOO_MANY_ATTEMPTS` (both with `Retry-After`) |
