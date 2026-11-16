# Known limitations

Honest list of what does not exist or is incomplete. Kept current with each milestone.

## Product scope
* The web app covers M1 plus the first M2 slice: customers, invoices, credit notes, receipts, receivables ageing, vendors, bills, vendor credits, payments, payables ageing, tax rates, and bank accounts with statement import, matching and reconciliation. Every other module in the directive has no screen, and the sidebar does not show them.
* Of 1,343 registry entries, the generated [`FEATURE_STATUS.md`](FEATURE_STATUS.md) lists the current counts; everything else is Not started.
* No payroll, procurement, expenses, treasury, FP&A, AI, agents, workflows, documents, integrations, subscriptions or admin modules yet.
* No AI functionality of any kind exists yet, and none is claimed.

## Accounting
* No year-end close (retained earnings roll-forward is shown as "unclosed earnings" on the balance sheet).
* No recurring journals, templates, accrual auto-reversal, revaluation, exchange-rate tables, intercompany, consolidation, subsidiary ledgers or cash-basis reporting.
* Dimensions are free-form key/values on lines; there are no dimension masters or dimension reports.
* The chart template is a generic SMB chart, not a statutory chart (e.g. Schedule III presentation is not implemented).
* Period CLOSED status exists but there is no close workflow; LOCKED/OPEN toggling is available to OWNER/ADMIN.

## Receivables and payables (M2, slice 1)
* Documents are in the organisation's functional currency only; multi-currency invoices and bills are not supported yet.
* Simple tax rates are percentages the tenant configures. India GST (M3, slice 1) and India TDS/TCS with GST reverse charge (M3, slice 2) are the only statutory tax modules; what they do not cover yet is listed in [`TAX_ENGINE_INDIA_GST.md`](TAX_ENGINE_INDIA_GST.md) and [`TAX_ENGINE_INDIA_TDS_TCS.md`](TAX_ENGINE_INDIA_TDS_TCS.md). There is no other country's tax, no e-invoicing, no TDS/TCS statements and no filing.
* No quotes, sales orders, purchase orders, recurring invoices, debit notes, write-offs, bad-debt provisions, collection reminders, payment links or portals.
* No PDF generation or emailing of invoices and statements.
* Approval is role-based only (an APPROVER can post drafts); there is no multi-step approval workflow or amount thresholds.
* Removing an allocation is dated today; there is no back-dated removal.
* Ageing buckets are fixed (current, 1–30, 31–60, 61–90, over 90).

## Banking (M2, slice 2)
* Statements come from CSV files only. There is no live bank feed, no OFX/QIF/MT940/PDF import and no connection to any bank; none is claimed.
* Statement lines are in the organisation's functional currency; foreign-currency bank accounts are not supported yet.
* Matching is one statement line to one or more ledger lines. Several statement lines cannot yet be matched to one ledger line (for example a deposit the bank splits in two).
* Suggestions are rules (same amount, within 14 days, shared words). They do not learn from past matches, and no AI is involved.
* Ledger lines dated before the first reconciliation period are treated as already cleared unless a later statement line matches them, so a cheque issued before that date and still outstanding has to be matched or will show as a difference.
* Only the latest reconciliation of an account can be undone. Transfers between two of your own bank accounts are booked as an entry on each side; there is no transfer detection.
* Excluded lines must be real non-movements (for example a duplicate in the bank's file); excluding a genuine movement will make the statement total disagree.

## Attachments and approvals (M2, slice 3)
* Files are stored inside PostgreSQL (up to 5 MB each, 20 per record). That is fine for evidence at this scale; object storage is planned before larger volumes. Uploaded files are not scanned for malware; they are only served as downloads or in a sandbox.
* No OCR or extraction: a file is evidence attached to a record, nothing is read from it. No standalone document vault, folders or search.
* Bank statement lines accept attachments through the API, but the banking screens do not show them yet.
* Approvals are single-step: one approver per document, one rule per document type with a minimum total. No multi-level chains, approval by department or vendor, escalations, delegation or notifications. Payments and manual journals have no approval rules yet.
* An approval is tied to the exact total; any edit to the draft cancels it. A changed tax rate that alters the total also needs a new approval.

## Expense claims (M2, slice 4)
* Claims are in the organisation's currency only; no foreign-currency receipts, mileage, per diem or travel bookings.
* No expense policies (limits per category, receipt required above an amount); missing receipts and possible duplicates are warnings, not blocks. Duplicate detection compares date and amount only.
* Categories are the organisation's expense accounts. Approval is single-step by anyone with approvals.decide other than the claimant; there is no manager hierarchy or department routing.
* Reimbursement is one claim at a time; no batch payouts, bank payment files or payroll integration. A reimbursed claim cannot be voided.
* No OCR: amounts are typed in, the receipt is attached as evidence. No corporate card feeds.
* Employees are added as members of an organisation with the EMPLOYEE role; there are no email invitations yet.

## Payroll (M3, slice 3)

* India only, new tax regime only, professional tax for Maharashtra only. No old regime or declarations, perquisites, LWF, gratuity, statutory bonus, overtime, loans, ECR/24Q/Form 16 or bank files, payroll approvals or payslip PDFs. The full list and the sources are in [`PAYROLL_INDIA.md`](PAYROLL_INDIA.md).
* The statutory rules have not been reviewed by a payroll professional; the Maharashtra PT slabs come from a secondary source.

## Compliance calendar (M3, slice 4)

* Statutory dates only: no holiday shifts or notified extensions, one GST frequency for all periods, no composition/ISD/GSTR-7/8, no Form 144, certificates, ITR or ROC dates, no reminders. Returns are marked filed by hand; nothing is filed. Some 2026-27 form and TCS-statement dates come from secondary sources. See [`COMPLIANCE_CALENDAR_INDIA.md`](COMPLIANCE_CALENDAR_INDIA.md).

## E-invoicing (M3, slice 5)

* No direct connection to the IRP or a GSP: the user uploads the JSON and pastes the response back. Only B2B invoices and credit notes in INR: no exports, SEZ, deemed exports, debit notes or B2C dynamic QR codes. Signatures are checked only when the user saves the IRP's public key. See [`E_INVOICING_INDIA.md`](E_INVOICING_INDIA.md).

## E-way bills (M3, slice 6)

* No direct connection to the e-way bill portal: the user uploads the JSON and records the number and validity. Only outward supplies on tax invoices, one invoice at a time: no exports, inward supplies, job work, delivery challans, branch transfers, validity extensions, consolidated or multi-vehicle e-way bills. The state's own threshold is whatever the user enters. See [`E_WAY_BILLS_INDIA.md`](E_WAY_BILLS_INDIA.md).

## Budgets (M4, slice 1)

* Monthly budgets for revenue and expense accounts only: no departments or projects (no dimensions yet), balance sheet or cash budgets, driver-based lines, spreadsheet import or approval chains. Budget vs actual reads posted journals with no drill-down or export. See [`BUDGETS.md`](BUDGETS.md).

## Cash-flow forecast (M4, slice 2)

* Rule-based, not machine learning: open invoices and bills at each contact's usual payment delay, plus planned items typed in by hand. No seasonality, no sales pipeline, no recurring invoices or payroll runs projected automatically, single currency (the functional currency), cash and bank accounts together only. The range is the 25th–75th percentile of payment delays, not a statistical confidence interval. Backtests use today's planned items. Unapplied receipts and payments are reported, not netted. No scenarios, alerts or export. See [`CASH_FLOW_FORECAST.md`](CASH_FLOW_FORECAST.md).

## KPIs and management reports (M4, slice 3)

* A fixed set of 13 KPIs for the whole organisation, computed by calendar month from posted journals by account subtype: no custom formulas or dashboards, dimensions, peer benchmarks, alerts, drill-down to journals, scheduled or emailed reports, or PDF/Excel export (browser print only). DSO and DPO compare GST-inclusive balances with tax-exclusive revenue and expenses. The management report compares only the approved budget. See [`KPIS_AND_MANAGEMENT_REPORTS.md`](KPIS_AND_MANAGEMENT_REPORTS.md).

## Languages and regional formats (M8, slice 1)

* Hindi covers the navigation, header, roles and the preferences page; other pages are in English. Not yet reviewed by a professional translator. No right-to-left language yet. Business dates (today, due dates, periods) are in India time for every organisation; time zones change only how moments are shown. A few pages and printed documents format values themselves and do not follow the person's formats. Emails, exports and AI answers are not translated.

## Country modules (M8, slice 2)

* India is the only full tax module. The UAE, UK, Singapore, Australia, Germany and Canada are starter modules: standard national sales-tax rates only, as ordinary tax rates, with no returns, filings, reverse charge, schemes, e-invoicing or payroll, and no check of which rate applies. Canada has federal GST only. The United States and every other country are accounting only. Starter rates have no effective dates, and nothing warns when a module's review is overdue. Reports use one layout everywhere: no local statutory statements. See [`COUNTRY_MODULES.md`](COUNTRY_MODULES.md).

## Local financial reporting (M8, slice 3)

* Balance sheet and profit and loss layouts only (Schedule III Division I, UK Companies Act formats, IFRS IAS 1), placed by account subtype: no notes, cash flow statement, changes in equity, Ind AS, US GAAP or framework-specific adjustments, no current portion of long-term loans, ageing or MSME splits, no rounding to lakhs or crores, no export besides Print, and no filing. See [`LOCAL_FINANCIAL_REPORTING.md`](LOCAL_FINANCIAL_REPORTING.md).

## Multi-currency (M8, slice 4)

* Foreign currencies live on journal lines: invoices, bills and payments are still in the functional currency only, so there are no realised exchange gains or losses on settlement. Rates are entered by people (no feed). Revaluation covers monetary account balances, not individual open documents. See [`MULTI_CURRENCY.md`](MULTI_CURRENCY.md).

## Alerts and leakage checks (M4, slice 4)

* Nine fixed, rule-based checks with thresholds; no machine learning or AI explanations. Checks run in the background (at most hourly per organisation, 20 organisations a pass), on request, and when alerts are opened. Priority is a fixed, explained formula, not learned. New alerts become tasks for a role by one setting for all checks; there are no email, push or chat notifications, no assignment to one person and no snoozing. Duplicates match exact amounts from the same contact only; unusual journals look at size and posting delay only; missed billing looks at the last complete month without contracts. Vendor bank changes, payroll anomalies and unusual bank activity are not checked. See [`ALERTS_AND_LEAKAGE.md`](ALERTS_AND_LEAKAGE.md).

## AI copilot (M4, slice 5)

* Not yet run against the live Claude API: no key has been added yet (Settings → Integrations). The full path up to the HTTP call is tested with the official SDK against a local stand-in. Answers appear whole when finished (no streaming of text). Read-only questions only: no drafting of journals, invoices, reminders or filings, no document reading, no web search, no payroll. No platform screen for the model or spend; per-member hourly limit only. Answers come from tool results but a language model can still misread or miscalculate, so the screen asks members to check the linked reports. English only. See [`AI_COPILOT.md`](AI_COPILOT.md).

## Month-end close (M5, slice 5)

* The AI review has not yet run against the live Claude API; it is tested with the official SDK against a local stand-in.
* A person starts each close and each review. Nothing starts on its own as a month ends. Proposed entries cannot be edited before posting. Entries are in the functional currency, with no tax or dimensions. No report pack is generated at close (the certification records the headline figures). There is no year-end close to retained earnings. See [`MONTH_END_CLOSE.md`](MONTH_END_CLOSE.md).

## AI control center (M5, slice 6)

* Budgets are in tokens, not money; one call can take usage past a budget because its size is known only when it returns. The stop applies to one organisation; a platform-wide stop is removing `ANTHROPIC_API_KEY`. Acceptance rates come from people's decisions, not a labelled evaluation set. No orchestrator hands work between agents, and no agent is above level 2. See [`AI_CONTROL_CENTER.md`](AI_CONTROL_CENTER.md).

## Loans and treasury (M6, slice 4)

* Monthly installments only (EMI or equal principal), with interest on the opening balance of each period; no bullet, balloon, quarterly or step-up repayments, moratoriums, tranches, foreign-currency loans or loans given. Interest is recognised when an installment is recorded, not accrued at month end. No covenants, overdraft limits, investments or deposits; the treasury overview does not include the cash-flow forecast. Only the latest entry on a loan can be reversed. See [`LOANS_AND_TREASURY.md`](LOANS_AND_TREASURY.md).

## Invoice templates and e-signatures (M6, slice 5)

* Templates cover invoices and credit notes only. PDFs come from the browser's print dialog; there is no server-made PDF and no invoice PDF on emails yet. The e-signature is an image with a SHA-256 of the signed content, not Aadhaar eSign or a DSC (those need a licensed provider). Country presets summarise the rules and have not been reviewed by a tax professional in each country. No QR codes (India e-invoice QR, UPI), no right-to-left body text, system fonts only, sections reorder with buttons rather than drag and drop. See [`INVOICE_TEMPLATES.md`](INVOICE_TEMPLATES.md).

## Report exports (M6, slice 6)

* PDFs use the standard Helvetica font, so characters outside Western European scripts (Devanagari, Arabic, CJK, the rupee sign) print as `?`; amounts carry no currency symbol. Exports are on request only (no schedules or email), the Excel file holds values without formulas, and KPIs, management reports, budgets and forecasts are not exportable yet. See [`REPORT_EXPORTS.md`](REPORT_EXPORTS.md).

## Group consolidation (M6, slice 7)

* Full consolidation; non-controlling interests are the outside share of each subsidiary's reported net assets and profit, with no goodwill, fair value adjustments, mid-period ownership changes, indirect holdings or equity accounting. Accounts combine by code, with no mapping between different charts. Intercompany charges and settlements post journals in both companies at once (no GST/VAT, stock or unrealised profit, and no revaluation of intercompany balances). Translation rates are entered per period end, with one historical rate per member. See [`CONSOLIDATION.md`](CONSOLIDATION.md).

## Departments and projects (M6, slice 3)

* Two dimensions only (department, project), one of each per line. No location or custom dimensions, required tags per account, cost allocation or splitting a line across projects. Only the profit and loss is split; budgets, the trial balance, balance sheet and general ledger are not. Bank entries, expense claims, payroll, depreciation and deferral releases post untagged, and document tax, receivable and payable lines are not tagged. See [`FINANCIAL_DIMENSIONS.md`](FINANCIAL_DIMENSIONS.md).

## Prepaid expenses, deferred revenue and accruals (M6, slice 2)

* Release evenly by month or by days only; no revenue recognition by milestone, usage or performance obligation. Schedules are not created from invoice or bill lines automatically. Accruals reverse on the first of the next month only, and do not repeat. Only the latest release run can be reversed, and a schedule added after its months were run is released in the next month's run. See [`PREPAID_AND_DEFERRED.md`](PREPAID_AND_DEFERRED.md).

## Fixed assets (M6, slice 1)

* Straight line and written-down value only, by full calendar months. There are no categories with default terms, revaluation, impairment, partial disposal, transfers, capital work in progress or separate tax-book depreciation. Only the latest depreciation run can be reversed. The conventions have not been reviewed against Companies Act Schedule II by an accountant. See [`FIXED_ASSETS.md`](FIXED_ASSETS.md).

## AI bank reconciliation (M5, slice 4)

* Not yet run against the live Claude API; tested with the official SDK against a local stand-in.
* A person starts each run and accepts each suggestion: no scheduled runs, bulk accept or editing a suggestion before accepting; entries go to one account with no split or tax; no transfers between own accounts or foreign-currency lines; learning is the last 15 entries a person made, not saved rules; up to 25 lines per run. See [`AI_RECONCILIATION.md`](AI_RECONCILIATION.md).

## AI collections agent (M5, slice 3)

* Not yet run against the live Claude API or a real mail provider; tested with the official SDK against a local stand-in and a local SMTP server.
* A person starts each drafting run and approves each reminder: no sequences, escalation, scheduled runs or reply tracking; no links, attachments, payment links, opt-outs or tone settings; plain-text English email only; up to 20 customers per run.
* The risk level is the model's assessment, not a credit score. See [`AI_COLLECTIONS.md`](AI_COLLECTIONS.md).

## Workflow automations and tasks (M5, slices 1 and 2)

* Triggers are events, a schedule (daily, weekly, monthly at a time in India time), an invoice N days overdue and a bill due in N days. No balance or "became true" triggers beyond these (use "An alert opens"), no branches, waits or parallel paths.
* Actions are tasks, plain-text emails and signed webhooks. No SMS, chat or in-app notifications, no HTML email, attachments (such as the invoice PDF) or reply tracking, no actions that post or approve, no AI agent steps, no custom webhook headers or bodies.
* Email has been tested only against a local SMTP server: it is waiting for a real SMTP provider (added in Settings → Integrations) for a live check. Without them, email actions fail with "Email is not set up". There is no bounce handling, unsubscribe or per-contact opt-out, and no SPF/DKIM set-up guide yet.
* The runner runs inside the API process (every 10 seconds by default); no separate worker or dead-letter view beyond the run log, and no load test yet.
* Tasks have no reminders, comments, reassignment or navigation count.
* See [`WORKFLOW_AUTOMATIONS.md`](WORKFLOW_AUTOMATIONS.md) › Not supported yet.

## Web app
* One dashboard chart (revenue, expenses and net income by period, with a table). No drill-down, filters, forecasts or other dashboards.
* Journal entry is a form with line rows, not a spreadsheet-style grid; no CSV import, attachments, templates or recurring entries.
* No global search, command palette, in-app notifications (automations can send emails and webhooks), light theme (the app has one dark theme) or per-user locale setting.
* Layouts are responsive, but there is no automated accessibility audit (axe) or visual regression test yet.
* Invitations are links the inviter copies and sends; Talk2Tax does not send email yet. A member cannot leave an organisation by themself; an owner or admin removes them.

## Security
* No MFA or SSO. No email verification or password reset by email (a signed-in user can change their password).
* Rate-limit counters live in each API process's memory, so several instances multiply the limit; there is no shared store yet. Sign-in lockout is shared (PostgreSQL).
* Per-IP limits depend on the reverse proxy in front of the web app setting `X-Forwarded-For`; without one, the address can be faked (see SECURITY.md).
* A session's "last active" time moves when its access token is renewed (every 15 minutes of use), not on every request.
* Lockout is per email, so someone can keep an account locked by failing on purpose; there is no CAPTCHA or per-IP backoff on top yet.
* Tenant isolation is enforced in the application, by composite foreign keys and by PostgreSQL row-level security. `users`, `auth_sessions` and `login_throttles` are not tenant data and have no policies. Every statement outside a transaction costs one extra round trip for the tenant settings.
* Segregation of duties (creator ≠ poster) is possible through roles but not enforced as a policy.

## Engineering
* Dependency majors are pinned below the newest releases (TypeScript 5.9 vs 7, NestJS 11 vs 12, Prisma 6 vs 7/8). See ADR-005.
* Audit appends serialise per organisation with an advisory lock; fine for current volume, to be revisited under load.
* The Docker image and compose `app` profile are written but have not been built in CI.
* Performance targets in the directive have not been benchmarked.
* `docs/COMPETITIVE_FEATURE_MATRIX.md` is a framework; competitor capabilities have not been researched or verified yet.

## Documents from Directive Part 48 not written yet
`TAX_ENGINE.md`, `AI_AGENT_ARCHITECTURE.md`, `AI_SAFETY_AND_GOVERNANCE.md`, `FINANCIAL_DIGITAL_TWIN.md`, `WORKFLOW_ENGINE.md`, `INTEGRATION_ARCHITECTURE.md`, `DESIGN_SYSTEM.md`, `DASHBOARD_SPECIFICATIONS.md`, `PRICING_STRATEGY.md`. They will be written with the milestone that builds each area rather than as speculative stubs.

## Financial digital twin (M7 slice 1)

* A monthly driver model on averages of the last 3, 6 or 12 months: no seasonality, no per-customer or per-product detail, no balance sheet beyond cash, receivables and payables, and no GST/VAT cash timing. Tax is a flat rate on positive monthly profit with no loss relief. Loans are EMI only and investments depreciate straight-line. Templates are fixed placeholders, with no AI-written scenarios yet. Scenarios are re-run against the latest actuals each time, with no snapshot of a past run. See [`DIGITAL_TWIN.md`](DIGITAL_TWIN.md).

## Scenario war room (M7 slice 2)

* Not live: others see changes on reload, with no presence, live cursors or notifications for notes. Suggestions are rules measured on the model, not written by AI. Approving a scenario records a decision only; it does not feed budgets or the cash-flow forecast. Marginal impacts can be a paisa away from the exact cost because totals are rounded separately. See [`WAR_ROOM.md`](WAR_ROOM.md).

## Recovery planner (M7 slice 3)

* Options are rules measured on the twin, not written by AI, with fixed percentages (open the plan as a twin scenario to try other figures). No reminders when actions fall due. Supplier spend comes from posted bills only. See [`RECOVERY_PLANNER.md`](RECOVERY_PLANNER.md).

## Virtual CFO (M7 slice 4)

* Analyses and answers are rules with fixed thresholds; the CFO's verdicts compare with the organisation's own history (peer comparison is on the Benchmarking page); profit by client is not known (costs are not recorded per client), so that answer ranks revenue; nine fixed questions (the copilot covers the rest); packs print from the browser, with no PDF export; the AI summary has been tested against the local stand-in only. See [`VIRTUAL_CFO.md`](VIRTUAL_CFO.md).

## Benchmarking (M7 slice 5)

* No statistical noise is added, so changes in aggregates over time can reveal a little about a participant who joined or left; one person with several organisations could add them all; database operators can link a participant key to its organisation; industries and size bands are fixed; no external or industry datasets; latest month only. See [`BENCHMARKING.md`](BENCHMARKING.md).

## Relationship explorer and figure tracing (M7 slice 6)

* Contracts are not modelled, so they are not in the graph; risks are the alerts that cite a record; bank statement lines, budgets, scenarios and tax returns are not nodes; one record's neighbours at a time, shown as lists; a profit and loss filtered by department or project does not link to the ledger. See [`KNOWLEDGE_GRAPH.md`](KNOWLEDGE_GRAPH.md).

## Decision memory (M7 slice 7)

* Outcomes are organisation-wide KPIs (not per department or project); no reminders when a review is due; word search only, and the copilot cannot search decisions yet. See [`DECISION_MEMORY.md`](DECISION_MEMORY.md).

## Forecast evaluation lab

* Eight simple, explainable statistical methods only (no ARIMA, decomposition, machine learning or AI); methods are not combined, and the lab does not change which method the cash-flow forecast uses; organisation-wide figures only. See [`FORECAST_LAB.md`](FORECAST_LAB.md).

## Disaster simulation

* Organisation-wide figures only; customer and supplier shares are baseline averages; a supplier's share is measured against cost of sales only; one deterministic path per simulation, not a distribution. See [`DISASTER_SIMULATION.md`](DISASTER_SIMULATION.md).

## Business impact engine

* Organisation-wide figures only; customer and supplier shares are baseline averages; new revenue carries the average cost of sales ratio and the usual payment days; a headcount reduction assumes sales are unchanged; one deterministic path per assessment. See [`BUSINESS_IMPACT.md`](BUSINESS_IMPACT.md).

## Policy studio

* Rules can only do what workflows can do; back-tests cover event rules over the last 90 days only; live AI drafting waits on a Claude key. See [`POLICY_STUDIO.md`](POLICY_STUDIO.md).

## Voice assistant

* Live answers wait on a Claude key and speech recognition has not been checked with a real microphone (tests use doubles); English (India) only; three actions only. See [`VOICE_ASSISTANT.md`](VOICE_ASSISTANT.md).

## Report designer

* Live AI layouts and commentary wait on a Claude key; organisation-wide monthly figures only; no PDF export of designed reports yet (print instead). See [`REPORT_DESIGNER.md`](REPORT_DESIGNER.md).

## Dashboards

* Organisation-wide monthly figures only (no departments, projects, budgets or forecasts yet); live AI drafting waits on a Claude key. See [`AI_DASHBOARDS.md`](AI_DASHBOARDS.md).

## Integrations

* Only AI (Claude) and email (SMTP) are set up in the app. Payment gateways, bank feeds, accounting systems, CRMs, chat tools and GSP connections for e-invoicing and e-way bills are not built. No OAuth sign-in for Google or Microsoft mail (use SMTP with an app password). No external secrets manager. Both are tested against local stand-ins only until live credentials are added. See [`INTEGRATIONS.md`](INTEGRATIONS.md).

## Opportunity intelligence

* Four fixed kinds of opportunity; take-up rates are the user's estimates; lines are revenue accounts, not products; segment margins include only tagged costs; the total of all opportunities ignores overlap. See [`OPPORTUNITY_INTELLIGENCE.md`](OPPORTUNITY_INTELLIGENCE.md).

## Regional deployment

* Moving an organisation between regions is an operator command plus a manual database copy; there is no automated copy or in-app request. Sign-in accounts are per region. No cloud regions are provisioned by the repository. See [`REGIONAL_DEPLOYMENT.md`](REGIONAL_DEPLOYMENT.md).

## Platform administration

* Search shows the newest 200 matches. Disabling asks for the reason in a browser prompt. Monitoring is a later M9 slice; usage metering is in [`USAGE_METERING.md`](USAGE_METERING.md). See [`PLATFORM_ADMINISTRATION.md`](PLATFORM_ADMINISTRATION.md).

## Plans and subscriptions

* Online subscription payments (Razorpay, Stripe) are tested only against a local stand-in of their APIs, not yet with real test accounts. Renewals are paid by the customer: no saved-card, UPI AutoPay or e-mandate charging. No refunds or credit notes for subscriptions; no tax for suppliers outside India. No coupons or add-ons yet. See [`SUBSCRIPTION_PAYMENTS.md`](SUBSCRIPTION_PAYMENTS.md). AI and upload limits are shown but not yet counted. See [`PLANS_AND_SUBSCRIPTIONS.md`](PLANS_AND_SUBSCRIPTIONS.md).
