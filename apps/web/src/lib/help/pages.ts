import type { Help } from './types';

/**
 * Help for every page, keyed by its route inside an organisation (ids shown as [id], a month as
 * [month]); platform pages start with admin/. A route without its own entry uses the nearest
 * shorter one, so `sales/contracts/[id]/edit` falls back to `sales/contracts/[id]`, then to
 * `sales/contracts`. English is the source; other languages are in their catalogues.
 */
export const PAGE_HELP: Record<string, Help & { where: string }> = {
  // ---------------------------------------------------------------- overview
  '': {
    what: 'Your organisation at a glance: cash, revenue, expenses, profit, what customers owe and what you owe, by month.',
    how: 'Read the cards from left to right, then the chart. Click a figure that looks wrong to open the report behind it.',
    where: 'The first page after signing in. Every figure comes from posted entries in the books, so it moves as soon as you post an invoice, bill, payment or journal.',
  },
  copilot: {
    what: 'An assistant that answers questions about your books in plain words and can prepare actions for you to confirm.',
    how: 'Type or speak a question such as "Who owes us the most?" or "Draft an invoice for Asha for ₹40,000". Check its answer: every figure links to the report it came from. Nothing is posted until you confirm it.',
    where: 'Overview. It reads the same books as the reports and only does what your role allows. An administrator turns it on under Integrations and the AI control center.',
  },
  alerts: {
    what: 'Problems and money leaks the system found in your books: overdue invoices, duplicate bills, unusual journals, missed billing and more.',
    how: 'Open an alert to see the records behind it, then fix the cause, or dismiss it with a reason. Alerts refresh in the background and when you open this page.',
    where: 'Overview. Checks run over sales, purchases, banking and journals. Choose which checks run, and who is told, in Alert settings.',
  },
  'alerts/settings': {
    what: 'Which checks run, their thresholds, and which role gets a task when an alert is raised.',
    how: 'Turn a check on or off, change its threshold, and choose the role that should act. Save to apply from the next scan.',
    where: 'Opened from the Alerts page. Changes here decide what appears on Alerts and in My tasks.',
  },
  approvals: {
    what: 'Documents waiting for someone to approve them before they can be posted.',
    how: 'Open a request, check the document, and approve or reject it with a comment. Requests you made are listed too.',
    where: 'Overview. Requests come from the rules set in Approval rules, for example bills above an amount.',
  },
  tasks: {
    what: 'Work assigned to you or your role: from automations, alerts, the month-end close and collections.',
    how: 'Open a task, do the work it points to, then mark it done. Filter by status to see what is overdue.',
    where: 'Overview. Tasks are created by Automations, Alerts and other modules, never by hand on this page.',
  },
  account: {
    what: 'Your own profile: name, password, language, number and date formats, and your sign-in sessions.',
    how: 'Change what you need and save. Signing out other sessions ends every sign-in except this one.',
    where: 'Opened from Account at the top right. These settings are yours alone and do not change the organisation.',
  },
  support: {
    what: 'Help from the Talk2Tax team: raise a question or a problem and follow the conversation.',
    how: 'Open a ticket with a clear subject, how urgent it is, and what you saw. You can let support view your organisation for a limited time if they need to.',
    where: 'Governance. Tickets are answered by the platform support team within the response times shown.',
  },
  // ---------------------------------------------------------------- sales and CRM
  'sales/leads': {
    what: 'People and companies who may buy from you but are not customers yet.',
    how: 'Add a lead with where it came from, move it through New, Contacted and Qualified, then convert it into a customer with a deal. Disqualify with a reason when it goes nowhere.',
    where: 'Sales, the first step of the CRM. A converted lead becomes a customer and a deal in the Pipeline.',
  },
  'sales/pipeline': {
    what: 'Deals you are working on, by stage, with their value and chance of winning.',
    how: 'Add a deal for a customer with an amount and expected close date, and move it through the stages as it progresses. Mark it won or lost with a reason.',
    where: 'Sales, after Leads. From a deal you make quotations, orders and contracts; their weighted value feeds the Revenue forecast.',
  },
  'sales/quotes': {
    what: 'Price offers to customers, valid until a date, with the same tax rules as invoices.',
    how: 'Create a quotation, mark it sent, revise it if the price changes (the earlier one is superseded), then record it accepted or declined. Accepting makes a sales order.',
    where: 'Sales, between the Pipeline and Sales orders. Quotations from a deal win the deal when accepted.',
  },
  'sales/orders': {
    what: 'What customers have agreed to buy, billed in full or in parts.',
    how: 'Make an order from an accepted quotation or enter it directly with the customer\'s PO number. Use Bill this order to make a draft invoice for some or all of it.',
    where: 'Sales, after Quotations. Invoices made from an order show its reference; what is left to bill feeds the Revenue forecast.',
  },
  'sales/contracts': {
    what: 'Agreements billed the same way every month, quarter, half-year or year, such as maintenance or retainers.',
    how: 'Create a contract with its lines, billing frequency and dates, then activate it. Each period due becomes a draft invoice automatically. Pause, renew with a price change, or cancel as needed.',
    where: 'Sales. Contract invoices appear under Invoices as drafts for you to post; MRR and ARR feed Customer 360 and the Revenue forecast.',
  },
  'sales/customers': {
    what: 'Everyone you sell to, with what they owe, what is overdue and any unapplied credit.',
    how: 'Add a customer with their GSTIN, payment terms and credit limit. Open one to see their statement, documents, deals and Customer 360.',
    where: 'Sales. Customers are used on quotations, orders, contracts, invoices and receipts.',
  },
  'sales/customers/[id]': {
    what: 'One customer: balances, statement, documents, Customer 360 (profit, lifetime value, credit risk) and deals.',
    how: 'Change the statement dates to see any period. Record a receipt or make an invoice from the buttons at the top. Put the customer on credit hold from Credit risk if needed.',
    where: 'Opened from Customers or anywhere a customer is named.',
  },
  'sales/customer-insights': {
    what: 'Every customer ranked by what they are worth: revenue, gross profit, margin, lifetime value, overdue money and credit risk.',
    how: 'Sort by the figure you care about and filter by risk or credit hold. Open a customer for the full workings.',
    where: 'Sales. Figures come from posted invoices, receipts and costs on projects linked to each customer.',
  },
  'sales/revenue-forecast': {
    what: 'Revenue still to come, month by month, from contracts, open orders, deals and recent sales.',
    how: 'Choose how many months to see. Read committed (contracts and orders), expected (plus weighted deals and other sales) and best case. Save the forecast to compare it with what is invoiced later.',
    where: 'Sales. It reads Contracts, Sales orders, the Pipeline and posted invoices; nothing here changes the books.',
  },
  'sales/revenue-forecast/[id]': {
    what: 'A forecast as it was saved, and how it compares with what was actually invoiced.',
    how: 'Once a month is over, Forecast against actual shows the difference. WAPE is the overall miss as a share of actual revenue: lower is better.',
    where: 'Opened from Saved forecasts on the Revenue forecast page. Saved forecasts never change.',
  },
  'sales/invoices': {
    what: 'Bills you send to customers. Drafts can be changed; posted invoices are in the books.',
    how: 'Create an invoice, check the tax and totals, and post it. Void a posted invoice with a reason instead of deleting it. Filter by status to find drafts or overdue ones.',
    where: 'Sales. Posting adds to receivables and revenue, and to GST returns, e-invoices and e-way bills where they apply.',
  },
  'sales/invoices/new': {
    what: 'A new invoice or credit note for a customer.',
    how: 'Choose the customer, dates and lines (account, quantity, price, tax rate, HSN/SAC). The totals update as you type. Save as a draft or save and post.',
    where: 'Sales → Invoices. A posted invoice can be paid with a receipt or reduced with a credit note.',
  },
  'sales/invoices/[id]': {
    what: 'One invoice or credit note: its lines, tax, payments and credits applied, and history.',
    how: 'Post a draft, print or send it, record a payment, apply a credit, or void it with a reason. Generate the e-invoice or e-way bill where required.',
    where: 'Opened from Invoices, a customer or a report.',
  },
  'sales/receipts': {
    what: 'Money received from customers and the invoices it paid.',
    how: 'Record a receipt into a bank account and apply it to open invoices. Money not applied stays as a credit you can apply later.',
    where: 'Sales. Receipts reduce what customers owe and appear on bank reconciliation.',
  },
  'sales/ageing': {
    what: 'What customers owe on a date, split by how long it has been overdue.',
    how: 'Pick the date. Read the buckets from current to over 90 days; open a customer to chase them.',
    where: 'Sales. The total agrees to the receivables account in the balance sheet.',
  },
  'sales/collections': {
    what: 'Payment reminders to customers, drafted by the AI from what each one owes and how they pay.',
    how: 'Run the collections agent, read each draft, edit it if needed and approve it to send. Nothing is sent without approval.',
    where: 'Sales. It reads Receivables ageing; every run is logged in AI activity.',
  },
  // ---------------------------------------------------------------- purchases, banking, expenses
  'purchases/vendors': {
    what: 'Everyone you buy from, with what you owe them.',
    how: 'Add a vendor with GSTIN, PAN, payment terms and default TDS section. Open one to see their statement and bills.',
    where: 'Purchases. Vendors are used on bills, vendor credits and payments.',
  },
  'purchases/bills': {
    what: 'Bills from vendors. Drafts can be changed; posted bills are in the books.',
    how: 'Enter a bill with the vendor\'s reference, lines and tax. TDS and reverse charge are worked out for you. Post it, or submit it for approval if a rule requires.',
    where: 'Purchases. Posting adds to payables and expenses, and to input tax credit and TDS.',
  },
  'purchases/payments': {
    what: 'Money paid to vendors and the bills it settled.',
    how: 'Record a payment from a bank account and apply it to open bills.',
    where: 'Purchases. Payments reduce what you owe and appear on bank reconciliation.',
  },
  'purchases/ageing': {
    what: 'What you owe vendors on a date, split by how long it has been due.',
    how: 'Pick the date and plan payments from the oldest buckets.',
    where: 'Purchases. The total agrees to the payables account in the balance sheet.',
  },
  banking: {
    what: 'Your bank and cash accounts with their book balances.',
    how: 'Add a bank account, then open it to import statements, match lines to entries and reconcile.',
    where: 'Banking. Receipts, payments and journals that touch a bank account appear here.',
  },
  'banking/[id]': {
    what: 'One bank account: imported statement lines, what is matched and what is not.',
    how: 'Import a statement, match each line to a receipt, payment or journal (or create one), then reconcile to the statement balance.',
    where: 'Opened from Bank accounts.',
  },
  'banking/[id]/import': {
    what: 'Bring a bank statement file into the account.',
    how: 'Upload a CSV, map its columns to date, narration and amount, check the preview, and import. Lines already imported are skipped.',
    where: 'Opened from a bank account. Imported lines wait to be matched on the account page.',
  },
  'banking/[id]/ai': {
    what: 'Matches suggested by the AI for statement lines that are not yet matched.',
    how: 'Run suggestions, read each with its reason and confidence, and accept or reject it. Nothing is matched until you accept.',
    where: 'Opened from a bank account. Runs are logged in AI activity.',
  },
  'banking/[id]/reconcile': {
    what: 'Agree the book balance to the bank statement balance on a date.',
    how: 'Enter the statement date and balance, tick the entries that have cleared, and finish when the difference is zero.',
    where: 'Opened from a bank account. Finished reconciliations are kept in its history.',
  },
  treasury: {
    what: 'Cash across all bank accounts, money coming in and going out soon, and loan repayments due.',
    how: 'Check today\'s cash, the next 30 days of receipts and payments, and any account running low.',
    where: 'Banking. It reads bank accounts, open invoices and bills, and loans.',
  },
  loans: {
    what: 'Loans the organisation has taken, with their repayment schedule and balance.',
    how: 'Add a loan with its amount, rate and term. Record each repayment, prepayment or rate change; the schedule and interest are worked out for you.',
    where: 'Banking. Repayments post journals; balances appear in the balance sheet and Treasury.',
  },
  expenses: {
    what: 'Expense claims from employees for money they spent on the organisation\'s behalf.',
    how: 'Create a claim with receipts and lines, submit it, and an approver approves or rejects it. Approved claims are posted and paid.',
    where: 'Expenses. Approved claims post to expense accounts and what is owed to the employee.',
  },
  // ---------------------------------------------------------------- payroll
  'payroll/employees': {
    what: 'Your employees with their salary structure, PAN, statutory numbers and bank details.',
    how: 'Add an employee and their salary components. Open one to change their structure from a date.',
    where: 'Payroll. Employees are paid in Pay runs.',
  },
  'payroll/runs': {
    what: 'Monthly payroll: gross pay, deductions (PF, ESI, PT, TDS) and net pay for every employee.',
    how: 'Create a run for the month, check each payslip, then post it. Record the remittances to the authorities when paid.',
    where: 'Payroll. Posting creates the salary journal; remittances feed the Compliance calendar.',
  },
  'settings/payroll': {
    what: 'The rules your payroll uses: PF, ESI, professional tax state and the employer\'s registration numbers.',
    how: 'Fill in the registration numbers and choose the options that apply, then save.',
    where: 'Payroll. Used by every pay run.',
  },
  // ---------------------------------------------------------------- accounting
  journals: {
    what: 'Every entry in the books, from documents, payroll, depreciation and manual journals.',
    how: 'Filter by date or source. Open an entry to see its lines. Make a manual journal for adjustments; reverse a posted one instead of deleting it.',
    where: 'Accounting. Everything in the reports comes from posted journals.',
  },
  'journals/new': {
    what: 'A manual journal: debits and credits that must balance.',
    how: 'Add lines with accounts, amounts and optional department and project. Save as a draft or post when debits equal credits.',
    where: 'Accounting → Journals. Use it for adjustments that no other screen makes.',
  },
  accounts: {
    what: 'The chart of accounts: every account money can be posted to, grouped by type.',
    how: 'Add an account with a code, name and type. Deactivate accounts you no longer use; accounts with entries cannot be deleted.',
    where: 'Accounting. Every document line and journal line uses an account from here.',
  },
  'fixed-assets': {
    what: 'Things you own and use for years, such as machines and vehicles, with their depreciation.',
    how: 'Add an asset with its cost, date and method. Run depreciation each month. Record a sale, scrap or write-off when it goes.',
    where: 'Accounting. Depreciation posts journals; assets appear in the balance sheet.',
  },
  deferrals: {
    what: 'Prepaid expenses and deferred revenue spread over the months they belong to.',
    how: 'Create a schedule for an amount paid or received in advance, then release it each month.',
    where: 'Accounting. Releases post journals so profit falls in the right months.',
  },
  accruals: {
    what: 'Expenses or revenue that belong to this month but are not invoiced yet.',
    how: 'Post an accrual at month end and reverse it at the start of the next month, or let it reverse automatically.',
    where: 'Accounting, usually during the Month-end close.',
  },
  dimensions: {
    what: 'Departments (cost centres) and projects you tag lines with, to see profit for each.',
    how: 'Add departments and projects. Link a project to a customer so its costs count against that customer\'s profit.',
    where: 'Accounting. Tags are used on invoices, bills and journals, and in Profit by department and Customer 360.',
  },
  close: {
    what: 'The month-end close: a checklist to finish a month, with an AI review, then lock it.',
    how: 'Open the month, work through each check, record adjustments, run the AI review, and certify. Closing locks the month against changes.',
    where: 'Accounting. A closed month cannot be posted to until it is reopened.',
  },
  periods: {
    what: 'Fiscal years and their monthly periods, open or locked.',
    how: 'Create the next fiscal year before posting in it. Lock a period to stop changes; unlock it with a reason if needed.',
    where: 'Accounting. Every posting date must fall in an open period.',
  },
  fx: {
    what: 'Exchange rates and the month-end revaluation of foreign-currency balances.',
    how: 'Enter rates for each currency and date, then run the revaluation for a month end.',
    where: 'Accounting. Revaluations post the unrealised gain or loss.',
  },
  // ---------------------------------------------------------------- reports
  'reports/dashboards': {
    what: 'Your own dashboards of approved metrics, built by hand or described in words.',
    how: 'Create a dashboard, add widgets, or describe what you want and check the AI\'s draft before saving.',
    where: 'Reports. Widgets read the same figures as the reports.',
  },
  'reports/trial-balance': {
    what: 'Every account\'s debit or credit balance on a date. Debits always equal credits.',
    how: 'Pick the date. Open an account to see the entries behind its balance.',
    where: 'Reports. The starting point for checking the books and for audits.',
  },
  'reports/income-statement': {
    what: 'Profit and loss: revenue less expenses for a period.',
    how: 'Choose the period and compare it with an earlier one. Open a line to see its entries. Export to Excel or PDF.',
    where: 'Reports. Comes from posted revenue and expense entries.',
  },
  'reports/profit-by-dimension': {
    what: 'Profit and loss with a column for each department or project.',
    how: 'Pick the period and whether to split by department or project.',
    where: 'Reports. Uses the tags set on lines; untagged amounts are shown separately.',
  },
  'reports/balance-sheet': {
    what: 'What the organisation owns and owes on a date, and its equity.',
    how: 'Pick the date and compare it with an earlier one. Open a line to see its entries.',
    where: 'Reports. Assets always equal liabilities plus equity.',
  },
  'reports/statutory': {
    what: 'Financial statements in a statutory format, such as Schedule III in India.',
    how: 'Choose the format and period, check every line is mapped, and export.',
    where: 'Reports. Uses the same balances as the balance sheet and profit and loss.',
  },
  'reports/general-ledger': {
    what: 'Every entry in an account over a period, with a running balance.',
    how: 'Choose the account and dates. Open an entry to see the whole journal.',
    where: 'Reports. Used to explain any balance.',
  },
  graph: {
    what: 'How records are connected: a customer, its invoices, payments, deals and journals.',
    how: 'Search for a record, then follow its neighbours. Trace any figure to the entries that make it.',
    where: 'Reports. A read-only map over the whole books.',
  },
  'reports/kpis': {
    what: 'Key performance indicators such as margins, days to collect and cash runway, against targets.',
    how: 'Pick the month, set targets for the ones you track, and open a KPI to see how it is worked out.',
    where: 'Reports. Used in Management reports and the Virtual CFO.',
  },
  'reports/management': {
    what: 'A monthly pack for management: figures, KPIs and commentary.',
    how: 'Open a month, write or draft the commentary, and finalise it. A finalised report does not change.',
    where: 'Reports. Built from the books for a closed month.',
  },
  'reports/designer': {
    what: 'Report layouts you design once and produce every month.',
    how: 'Create a design with headings, text, commentary and widgets, then produce a report for a month and finalise it.',
    where: 'Reports. Produced reports are kept with their figures as they were.',
  },
  consolidation: {
    what: 'Combined accounts for a group of companies, with eliminations and non-controlling interests.',
    how: 'Create a group, add companies and ownership, set rates and elimination rules, and run the consolidation for a date.',
    where: 'Reports. Reads each company\'s books; posts nothing to them.',
  },
  // ---------------------------------------------------------------- tax
  'tax/compliance': {
    what: 'Every tax filing and payment due, with its date and status.',
    how: 'Check what is due this month, open an item to see what to file, and mark it filed with the reference.',
    where: 'Tax. Dates come from your GST, TDS/TCS and payroll settings.',
  },
  'tax/gst-returns': {
    what: 'GSTR-1 and GSTR-3B worked out from your invoices and bills.',
    how: 'Choose the month, check each table and the documents behind it, and export the file to upload on the GST portal.',
    where: 'Tax. Reads posted sales and purchase documents.',
  },
  'tax/e-invoices': {
    what: 'E-invoices: the IRN and signed QR code from the government portal for B2B invoices.',
    how: 'Generate the e-invoice for a posted invoice, or cancel it within 24 hours. Connection details are set in E-invoicing settings.',
    where: 'Tax. The IRN prints on the invoice.',
  },
  'tax/e-way-bills': {
    what: 'E-way bills for moving goods, with vehicle updates.',
    how: 'Generate an e-way bill from a posted invoice, update the vehicle when it changes, or cancel it.',
    where: 'Tax. Needed when goods worth more than the limit move.',
  },
  'tax/tds-tcs': {
    what: 'Tax deducted on bills (TDS) and collected on invoices (TCS), and its deposit.',
    how: 'See what was deducted or collected by section, and record each deposit with its challan.',
    where: 'Tax. Amounts come from posted documents; deposits feed the Compliance calendar.',
  },
  'settings/gst': {
    what: 'Your GST registrations and where GST posts in the books.',
    how: 'Add each GSTIN with its state and effective date, and choose the accounts.',
    where: 'Tax. Used by every document with a GST rate and by GST returns.',
  },
  'settings/e-invoicing': {
    what: 'The connection to the e-invoice portal.',
    how: 'Enter the credentials and test the connection.',
    where: 'Tax. Used by E-invoices.',
  },
  'settings/e-way-bills': {
    what: 'The connection to the e-way bill portal and default transport details.',
    how: 'Enter the credentials, set the defaults, and test the connection.',
    where: 'Tax. Used by E-way bills.',
  },
  'settings/tds-tcs': {
    what: 'TDS and TCS sections, rates and thresholds, and the deductor details.',
    how: 'Turn on the sections you use and check the rates.',
    where: 'Tax. Used on bills, invoices and contacts.',
  },
  'settings/tax-rates': {
    what: 'The tax rates you can choose on lines, such as GST 18%.',
    how: 'Add a rate with its percentage and accounts. Deactivate rates you no longer use.',
    where: 'Tax. Used on quotations, orders, contracts, invoices and bills.',
  },
  'settings/country-module': {
    what: 'Which country\'s rules your organisation follows, and what that module supports.',
    how: 'Read what is fully supported and what is not. The country is set when the organisation is created.',
    where: 'Tax. Decides which tax screens appear in the menu.',
  },
  // ---------------------------------------------------------------- planning
  cfo: {
    what: 'A virtual CFO: an assessment of the business with the questions a CFO would ask, and reports you can keep.',
    how: 'Read the assessment, ask a question, and save a report. Figures are worked out from the books; the AI only writes the words.',
    where: 'Planning. Reads the books, KPIs and forecasts.',
  },
  benchmarking: {
    what: 'How your figures compare with similar businesses, anonymously.',
    how: 'Opt in to share your figures, then compare your margins and ratios with the quartiles of your peers.',
    where: 'Planning. Shown only when enough peers take part.',
  },
  decisions: {
    what: 'A record of management decisions, what you expected, and what actually happened.',
    how: 'Record a decision with the outcome you expect and when to check it. Review it later against the figures.',
    where: 'Planning. Helps learn from past decisions.',
  },
  'planning/budgets': {
    what: 'Budgets by account and month.',
    how: 'Create a budget for a year, enter or copy figures, and approve it.',
    where: 'Planning. Compared with actuals in Budget vs actual.',
  },
  'planning/budget-vs-actual': {
    what: 'Budget against actual results by account and month, with the differences.',
    how: 'Pick the budget and months. Look at the biggest differences first.',
    where: 'Planning. Reads Budgets and the books.',
  },
  'planning/cash-flow': {
    what: 'A forecast of cash for the coming weeks or months, from open invoices, bills and expected items.',
    how: 'Add expected items, check the minimum balance, and save forecasts to compare with what happened.',
    where: 'Planning. Reads open receivables, payables and bank balances.',
  },
  'planning/twin': {
    what: 'A digital twin of the business to try "what if" changes without touching the books.',
    how: 'Create a scenario, change drivers such as prices or headcount, and compare scenarios side by side.',
    where: 'Planning. Starts from your actual figures; nothing is posted.',
  },
  'planning/recovery': {
    what: 'A plan to recover when cash or profit is under pressure.',
    how: 'Pick options from your books, see their effect on cash, and track the actions.',
    where: 'Planning. Uses the digital twin.',
  },
  'planning/forecast-lab': {
    what: 'Tests several forecasting methods on your history and shows which works best.',
    how: 'Run the lab, compare how each method did on past months, and use the best one.',
    where: 'Planning. Reads monthly history from the books.',
  },
  'planning/disasters': {
    what: 'Simulates shocks such as a lost customer or a price rise, and their effect on cash.',
    how: 'Choose shocks and their size, run the simulation, and read when cash would run low.',
    where: 'Planning. Uses the digital twin; nothing is posted.',
  },
  'planning/impact': {
    what: 'The effect of a business change on revenue, profit and cash.',
    how: 'Describe the change with its levers, see the figures before and after, and save the assessment.',
    where: 'Planning. Uses the digital twin.',
  },
  'planning/opportunities': {
    what: 'Ways to grow found in your books, such as raising prices or collecting faster.',
    how: 'Read each opportunity and its estimated effect, and assess the ones worth doing.',
    where: 'Planning. Assessments go to Business impact.',
  },
  // ---------------------------------------------------------------- governance and settings
  audit: {
    what: 'Every change made in the organisation: who did what, and when.',
    how: 'Filter by person, action or date. Entries can never be changed or deleted.',
    where: 'Governance. Used for audits and to answer "who changed this?".',
  },
  'ai-control': {
    what: 'Controls for every AI feature: which agents run, their limits, and a stop switch.',
    how: 'Turn agents on or off, set their limits, and stop all AI at once if needed.',
    where: 'Governance. Applies to the copilot, collections, bank suggestions and other AI features.',
  },
  'ai-activity': {
    what: 'A log of everything the AI did: questions, drafts, suggestions and who approved them.',
    how: 'Filter by agent or date and open an entry to see its input and output.',
    where: 'Governance. Kept for review and audit.',
  },
  members: {
    what: 'The people in the organisation and their roles.',
    how: 'Invite someone by email with a role. Change a role or remove someone when needed.',
    where: 'Governance. Roles decide what each person can see and do.',
  },
  'settings/subscription': {
    what: 'Your plan, what it includes, and its invoices.',
    how: 'Compare plans, upgrade or renew, and download invoices.',
    where: 'Governance. The plan decides which modules are available.',
  },
  'settings/usage': {
    what: 'How much of your plan\'s limits you have used this month.',
    how: 'Check each meter; near a limit, consider upgrading.',
    where: 'Governance. Limits come from your plan.',
  },
  'settings/integrations': {
    what: 'Connections to outside services such as the AI and email, set up here in the app.',
    how: 'Enter the keys for a service, test the connection, and save. Keys are stored encrypted.',
    where: 'Governance. Used by the copilot, emails and other connected features.',
  },
  'settings/approvals': {
    what: 'Rules that send documents for approval before they post.',
    how: 'Add a rule for a document kind above an amount, and choose who approves.',
    where: 'Governance. Requests appear in Approvals.',
  },
  'settings/invoice-templates': {
    what: 'How your invoices look: layout, colours, sections and signature.',
    how: 'Start from a preset, change any section, preview it, and set it as the default.',
    where: 'Sales. Used when printing or sending invoices.',
  },
  'settings/signature': {
    what: 'Your signature for signing invoices electronically.',
    how: 'Draw or upload your signature and save it.',
    where: 'Sales. Used when you sign a document.',
  },
  automations: {
    what: 'Workflows that run by themselves: when something happens or on a schedule, do actions.',
    how: 'Create a workflow with a trigger, conditions and actions such as creating a task or sending an email. Turn it on and check its runs.',
    where: 'Governance. Runs are logged with every action they took.',
  },
  'governance/policies': {
    what: 'Your organisation\'s financial policies, written down and versioned.',
    how: 'Write a policy or start from a template, publish a version, and keep its history.',
    where: 'Governance. Published versions never change.',
  },
  guide: {
    what: 'Every part of Talk2Tax in one list: what each page is for, how to use it and where it fits.',
    how: 'Search for a word such as "GST" or "forecast", or browse by menu group. Open a page from its name.',
    where: 'Governance, next to Help and support. The same help appears behind the (i) beside every page title and section.',
  },
  'print/[id]': {
    what: 'A document laid out for printing or saving as PDF with your invoice template.',
    how: 'Choose a template if you have more than one, then use your browser\'s print command. Choose "Save as PDF" to keep a file.',
    where: 'Opened from an invoice, bill, quotation or order. The layout comes from Invoice templates.',
  },
  // ---------------------------------------------------------------- onboarding and auth
  login: { what: 'Sign in to Talk2Tax.', how: 'Enter your email and password.', where: 'The start of every session.' },
  register: { what: 'Create your Talk2Tax account.', how: 'Enter your name, email and a long password.', where: 'After this you create or join an organisation.' },
  onboarding: { what: 'Set up your organisation.', how: 'Enter its name, country and currency; the books are created for you.', where: 'Once, before you start.' },
  'invite/[id]': { what: 'An invitation to join an organisation.', how: 'Sign in or create an account, then accept.', where: 'After accepting, the organisation appears in your list.' },
  // ---------------------------------------------------------------- platform administration
  admin: {
    what: 'Platform administration: organisations, people, plans, payments, support and system health.',
    how: 'Pick an area from the menu. Every action here is logged.',
    where: 'Only for platform staff; organisations never see these pages.',
  },
  'admin/organisations': { what: 'Every organisation on the platform.', how: 'Search, open one to see its plan, usage and status, and suspend it if needed.', where: 'Platform administration.' },
  'admin/people': { what: 'Every user on the platform.', how: 'Search for a person and see their organisations and platform role.', where: 'Platform administration.' },
  'admin/plans': { what: 'The plans organisations can subscribe to.', how: 'Change prices, limits and included modules.', where: 'Platform administration. Used by Subscription.' },
  'admin/subscriptions': { what: 'Every organisation\'s subscription and its state.', how: 'Find a subscription and see its history.', where: 'Platform administration.' },
  'admin/invoices': { what: 'Invoices the platform issued for subscriptions.', how: 'Search and open one to see its payments.', where: 'Platform administration.' },
  'admin/payments': { what: 'Payment gateways and payments received.', how: 'Set up a gateway and check payments and webhook notices.', where: 'Platform administration.' },
  'admin/support': { what: 'Support tickets from organisations.', how: 'Pick up a ticket, reply, and close it when solved.', where: 'Platform administration.' },
  'admin/usage': { what: 'Usage across organisations.', how: 'See who is near their limits.', where: 'Platform administration.' },
  'admin/flags': { what: 'Feature flags.', how: 'Turn a feature on or off for everyone or for one organisation.', where: 'Platform administration.' },
  'admin/maintenance': { what: 'Maintenance windows.', how: 'Schedule a window; a banner warns users beforehand.', where: 'Platform administration.' },
  'admin/announcements': { what: 'Announcements shown to users.', how: 'Write one, choose who sees it and for how long.', where: 'Platform administration.' },
  'admin/errors': { what: 'Errors the platform caught, grouped.', how: 'Open a group to see occurrences and mark it resolved.', where: 'Platform administration.' },
  'admin/system': { what: 'System health: API, database and background runners.', how: 'Check each part is up and runners are on time.', where: 'Platform administration.' },
};
