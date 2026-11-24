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
    how: 'Type or speak a question such as "Who owes us the most?" or "Prepare payment of the Paper Mart bills". Check its answer: every figure links to the report it came from. Nothing is posted until you confirm it, and a payment batch it prepares is only a draft that someone else approves: it never pays.',
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
  'journal-suggestions': {
    what: 'Journals the books suggest for a month: a journal typed in each of the last three months but missing this month, and costs that came every month but not this one, to accrue at the month end.',
    how: 'Pick the month. Save a suggestion as a draft journal, check it and post it, or dismiss it with a reason. Accruals are suggested once the month has ended and need an accrued liabilities account.',
    where: 'Accounting, next to Journal templates. Worked out from posted journals each time; nothing is posted without you.',
  },
  'journal-templates': {
    what: 'Journals you enter again and again, such as rent, accruals or management charges, kept as templates. A template with a schedule is a recurring journal: it makes the journal every month, quarter, half-year or year by itself.',
    how: 'Create a template with its lines, or open a journal and choose Save as template. Use it to make one journal on a date you pick, or give it a schedule that makes drafts for review or posts straight away. Run due now makes any run that has fallen due without waiting for the hourly check.',
    where: 'Accounting, next to Journals. Every journal a template makes is an ordinary journal, numbered and checked like any other, and appears under Journals and in every report.',
  },
  'journal-templates/new': {
    what: 'A new journal template: the lines of a journal you post again and again, with an optional schedule.',
    how: 'Name it, add the accounts and amounts until debits equal credits, and use placeholders such as {month} in the memo. Turn on the schedule to make the journal automatically, and choose whether each run makes a draft or posts.',
    where: 'Opened from Journal templates. Nothing is posted when you save; journals are made when the template is used or a scheduled run falls due.',
  },
  'journal-templates/[id]': {
    what: 'One journal template: its lines, its schedule, the runs still to come and every journal it has made.',
    how: 'Use template makes one journal on a date you choose. Pause, resume or end the schedule from the buttons at the top. Open a journal in the history to check or post it. A template that has made journals is archived, not deleted.',
    where: 'Opened from Journal templates. Scheduled runs are made by the hourly check; if one cannot be made (a locked period, an inactive account), the reason is shown here and the run is tried again.',
  },
  'journal-templates/[id]/edit': {
    what: 'Change a journal template: its lines, memo, reference and schedule.',
    how: 'Edit the lines and save. Once a schedule has made journals, its first run, frequency and run day stay fixed, but you can change the amounts, the last date and whether runs post.',
    where: 'Opened from a template. Changes apply to journals made from now on; journals already made keep their lines.',
  },
  'sales/contracts': {
    what: 'Agreements billed the same way every month, quarter, half-year or year, such as maintenance or retainers.',
    how: 'Create a contract with its lines, billing frequency and dates, then activate it. Each period due becomes a draft invoice automatically. Pause, renew with a price change, or cancel as needed; cancelling part-way through a period billed in advance can credit the unused days on a draft credit note.',
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
  'sales/customer-behaviour': {
    what: 'How each customer invoiced in the last two years pays and buys, and what is changing. A profile (pays on time, pays late steadily, unpredictable, new, too little history) and signals: paying slower or faster than six months before, stopped buying, buying less or more than the year before, paying in parts, and the day of the month they usually pay.',
    how: 'Start with customers marked Paying slower or Stopped buying: call them before the next invoice falls due. Filter by a signal to work through one kind at a time. Time reminders a few days before a customer\'s usual pay day.',
    where: 'Sales. Needs the reports permission. Worked out from posted invoices and the receipts and credits applied to them; nothing here changes the books, and no AI model is used.',
  },
  'sales/customer-insights': {
    what: 'Every customer ranked by what they are worth: revenue, gross profit, margin, lifetime value, overdue money and credit risk.',
    how: 'Sort by the figure you care about and filter by risk or credit hold. Open a customer for the full workings.',
    where: 'Sales. Figures come from posted invoices, receipts and costs on projects linked to each customer.',
  },
  'sales/collection-forecast': {
    what: 'Money expected from customers week by week, from when each open invoice is predicted to be paid, beside what the due dates alone would say; with what is expected later and what is doubtful (over 90 days past due).',
    how: 'Choose how many weeks to see. Where Expected trails By due date, customers are paying later than their terms: chase them from Collection priorities. Open Payment predictions to see each invoice.',
    where: 'Sales. Needs the reports permission. Uses the same predictions as Payment predictions; the cash-flow forecast adds bills and planned items for the full cash position. Nothing here changes the books.',
  },
  'sales/collection-priorities': {
    what: 'Customers ranked by who to chase first today, with a suggested action (call, remind, a friendly note before the due date, settle a dispute, or wait after a recent reminder) and the points behind each score.',
    how: 'Work down from the top. Open a score to see why it is high: money overdue and not disputed, the age of the oldest overdue invoice, the chance of paying late and when the customer was last reminded. Draft reminders from Collections.',
    where: 'Sales. Needs the reports permission. Built from posted invoices, receipts, open disputes, sent reminders and the payment predictions; nothing here changes the books, and no AI model is used.',
  },
  'sales/payment-plans': {
    what: 'Instalment plans for customers behind on paying. Each customer with an overdue balance not in dispute gets a suggested plan: monthly instalments close to what they have paid a month over the last 6 months (3 when nothing was received), between 2 and 12, and at most 6 when an invoice is over 90 days overdue. Agreed plans show how they are going from the money received since.',
    how: 'Talk the plan through with the customer, then Set up plan: keep the suggested instalments or choose another number and the first due date, and agree it. Record receipts against the invoices as usual; they pay the instalments in order. Cancel a broken plan with the reason and agree a new one if needed.',
    where: 'Sales. Anyone who can see sales sees plans; agreeing and cancelling need the collections permission. Plans do not change the invoices or the books; they are kept as a record and every change is audited. No AI model is used.',
  },
  'sales/payment-predictions': {
    what: 'Every open invoice with the day it is likely to be paid, the chance it is paid late and the reasons, worked out from how each customer has paid before; and how accurate the same method has been on invoices already paid.',
    how: 'Start at the top: the riskiest invoices come first. Filter by band to see only very late ones, open the invoice or customer to chase it, and read the reasons to see what drives each prediction. Customers with little history lean on your organisation\'s average.',
    where: 'Sales. Needs the reports permission. Predictions come from receipts and credits applied to posted invoices; nothing here changes the books, and no AI model is used.',
  },
  'sales/contract-matching': {
    what: 'Invoices raised by hand to customers with contracts, each matched to the contract it most likely bills, with the period it falls in, any period billed twice and any price that differs from the contract.',
    how: 'Start with Billed twice?: void one invoice, or dismiss the match if both are right. Count an invoice as the contract\'s next period so the contract does not bill it again. Dismiss a wrong match with the reason; that pair is not suggested again.',
    where: 'Sales. The score comes from the lines, prices, total and date; every link and dismissal is in the contract\'s history and the audit trail.',
  },
  'sales/unbilled-revenue': {
    what: 'Revenue earned or agreed but not yet invoiced, found in your records: milestones marked complete without an invoice, contract periods due but not invoiced, draft invoices left more than a week, delivery orders still unbilled a month on, pro forma invoices that ran out without a tax invoice, and customers billed every month who were not billed last month.',
    how: 'Start with Due now. Open each finding to bill it from its order, contract or draft. If something should not be billed, dismiss it with the reason; it comes back by itself if the amount grows.',
    where: 'Sales. Amounts are before tax in the record\'s currency. Nothing here posts or changes the books; billing happens on the order, contract or invoice.',
  },
  'sales/revenue-recognition': {
    what: 'Revenue invoiced for services delivered over time (a year of support, a subscription billed up front), held as deferred revenue and recognised month by month, with a waterfall of what each month recognises.',
    how: 'Choose the deferred revenue account once. On a draft invoice, tick the lines delivered over time and give the service start, the months and whether to spread by days or evenly. Post the invoice, then run the monthly release under Prepaid and deferred.',
    where: 'Sales. Posting credits those lines to the deferred revenue account and opens a deferred revenue schedule per line; each release run moves a month to the line\'s revenue account. Voiding the invoice takes back what was recognised.',
  },
  'sales/revenue-forecast': {
    what: 'Revenue still to come, month by month, from contracts, open orders, deals and recent sales.',
    how: 'Choose how many months to see. Read committed (contracts and orders), expected (plus weighted deals and other sales) and best case. Save the forecast to compare it with what is invoiced later. The shaded 80% range shows how far each month could land, from how far your saved forecasts were off; save one each month to make it sharper.',
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
    how: 'Choose the customer, dates and lines (account, quantity, price, tax rate, HSN/SAC). For a customer abroad, pick their currency: the recorded exchange rate for the date fills in, or type the rate you agreed. The totals update as you type. Save as a draft or save and post.',
    where: 'Sales → Invoices. A posted invoice can be paid with a receipt or reduced with a credit note.',
  },
  'sales/invoices/[id]': {
    what: 'One invoice or credit note: its lines, tax, payments and credits applied, and history.',
    how: 'Post a draft, print or send it, record a payment, apply a credit, or void it with a reason. Generate the e-invoice or e-way bill where required.',
    where: 'Opened from Invoices, a customer or a report.',
  },
  'sales/receipts': {
    what: 'Money received from customers and the invoices it paid.',
    how: 'Record a receipt into a bank account and apply it to open invoices in the same currency. Money not applied stays as a credit you can apply later. In another currency, enter the rate you were paid at: any difference from the invoice rate posts as an exchange gain or loss.',
    where: 'Sales. Receipts reduce what customers owe and appear on bank reconciliation.',
  },
  'sales/ageing': {
    what: 'What customers owe on a date, split by how long it has been overdue.',
    how: 'Pick the date. Read the buckets from current to over 90 days; open a customer to chase them.',
    where: 'Sales. The total agrees to the receivables account in the balance sheet.',
  },
  'sales/bad-debts': {
    what: 'The allowance for customers who may not pay, worked out from how overdue each invoice is, and the invoices written off as bad debts.',
    how: 'Set the bad-debt accounts and rates once. Pick a date, check the provision matrix and post the provision: only the difference from the allowance already in the books is posted. Mark an invoice doubtful to provide a chosen percentage of it, or write it off when it will not be paid.',
    where: 'Sales. Provisions and write-offs post journals; write-offs reduce the invoice, the ageing and the customer statement without touching GST returns.',
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
    how: 'Enter a bill with the vendor\'s reference, lines and tax. TDS and reverse charge are worked out for you. Each line suggests an expense account from the vendor\'s earlier bills and the description; press Use to take it. Code lines from history fills every blank account, tax, department and project the way this vendor\'s earlier bills were coded. Post it, or submit it for approval if a rule requires.',
    where: 'Purchases. Posting adds to payables and expenses, and to input tax credit and TDS.',
  },
  'purchases/payments': {
    what: 'Money paid to vendors and the bills it settled.',
    how: 'Record a payment from a bank account and apply it to open bills.',
    where: 'Purchases. Payments reduce what you owe and appear on bank reconciliation.',
  },
  'purchases/payment-batches': {
    what: 'Supplier payment runs: bills grouped into one batch that is prepared by one person, approved by another, sent to the bank as a file and then recorded as payments.',
    how: 'Choose New batch, pick the bank account, the date and the bills, or ask the copilot to prepare one. Someone else approves it; a batch prepared with the assistant always needs someone other than the member who accepted it. Download the bank file, upload it to your bank, and record the payments once the bank has paid.',
    where: 'Purchases. Recording a batch posts one payment per vendor with the batch reference, which settles the bills and shows on bank reconciliation.',
  },
  'purchases/supplier-tax': {
    what: 'Every active vendor\'s GSTIN and PAN checked: against each other, against other vendors, against the GST on their bills of the last twelve months, and against what the GST portal showed when someone looked the GSTIN up.',
    how: 'Start with the serious problems. Open a vendor to fix their details or record a GST portal check: look the GSTIN up on the portal\'s Search Taxpayer page and record its status, type and legal name.',
    where: 'Purchases. Talk2Tax does not query the GST portal itself; registration status comes from the checks people record. Nothing here changes the books.',
  },
  'purchases/bill-exceptions': {
    what: 'Draft bills that cannot post because they do not match their purchase order, each difference with its likely cause: goods not received yet or billed beyond what was delivered, a possible duplicate of an earlier bill, a vendor price rise seen on other bills since the order, a line not linked to the order, or an extra charge such as freight. Each bill gets a next step and the amount at stake.',
    how: 'Work down the list. Send duplicates, over-billing and wrong invoices back to the vendor; record goods received when they arrive; link unlinked lines on the bill. When only a confirmed price rise or charge is left, an approver can accept the differences here with a reason, and the bill can post.',
    where: 'Purchases. Needs purchases.read to see, and approvals.decide to accept differences. Compares with the vendor\'s bills of the last year. Rule-based and explained; nothing changes until someone acts, and no AI model is used.',
  },
  'purchases/payment-schedule/predicted': {
    what: 'A suggested payment date for each open bill over the next 30, 60 or 90 days. The cash starts at the bank balances today, less bills already in payment batches; each open customer invoice comes in on its predicted payment date (from how that customer has paid). Bills are taken by due date, then by priority score, and each is paid on its due date (today, if overdue) when the bank stays at or above the balance to keep on every later day; otherwise on the first day it does, waiting for receipts.',
    how: 'Set the balance to keep and how far ahead to plan. Check the bills paid late and those not covered: chase the receipts they wait for, or talk to the vendor. Plan these dates (or one bill at a time) to add them to the payment schedule, then prepare a payment batch from there.',
    where: 'Purchases. Needs the reports permission to see and purchases.manage to plan. Bills in the functional currency only; bills of vendors without verified bank details are blocked. Nothing is paid here, and no AI model is used.',
  },
  'purchases/payment-priorities': {
    what: 'Open bills ranked against the cash in the bank: which to pay now (past due or due within a week, highest score first), which can wait for their due date, which the cash will not cover, and which are blocked because the vendor\'s bank details are not verified. When the cash covers everything, it suggests asking vendors for a discount to be paid early.',
    how: 'Set how much to keep in the bank and the return you want on spare cash, then work it out. Open a score to see its points. Prepare a payment batch for the bills to pay now; offer the listed discounts to vendors before paying those bills early.',
    where: 'Purchases. Needs the reports permission. Uses bank balances, posted bills in your currency, open payment batches and twelve months of purchases; nothing is paid or planned here.',
  },
  'purchases/payment-fraud': {
    what: 'Warning signs on vendor payments: those waiting in open payment batches and those recorded in the last 90 days. High: a bank account shared with an employee or another vendor, bank details changed in the 30 days before and not verified, or the same amount paid twice within a week. Medium: a recently changed (verified) account, a new vendor, an amount far above the usual, a payment against no bill, or the same person changing bank details and paying. Low: near-identical vendor names and large round amounts.',
    how: 'Start with High and with payments still in a batch: they can be stopped. Open the batch or payment, check with the vendor on a number you already have, verify or correct the bank details, and cancel the batch if needed.',
    where: 'Purchases. Needs the reports permission. Account numbers are never shown here. Worked out from the books; no outside data or AI model is used, and nothing here changes the books.',
  },
  'purchases/negotiation': {
    what: 'A negotiation brief for every vendor billed in the last twelve months: items whose price went up 5% or more, the same item 3% or more cheaper from another vendor, spend up 20% on the year before or a 25% share of all purchases, a record of paying on time, and a C or D scorecard grade. Each point says what it was raised on and, where the books show one, the saving.',
    how: 'Start with the vendors with the largest possible saving. Open a vendor to see the points to raise and the items with their first, latest and best other prices, then use them in your conversation. Settle overdue bills first when the brief says so.',
    where: 'Purchases. Needs the purchases read permission. Worked out from posted bills, vendor credits and payments; items match by HSN/SAC code, or by description. Nothing here changes the books, and no vendor is contacted.',
  },
  'purchases/negotiation/[id]': {
    what: 'What to raise with one vendor: spend and its change, its share of all purchases, how you pay them, their scorecard grade, the points to raise and every item bought from them in the last twelve months.',
    how: 'Read the cautions first, then the points with the largest savings. Paid above first price is what the price rises cost you; the best other vendor is the lowest latest price another vendor billed for the same item.',
    where: 'Purchases, Supplier negotiation. The scorecard grade comes from Vendor performance. Nothing here changes the books.',
  },
  'purchases/vendor-contracts': {
    what: 'Every vendor contract on record with its term, payment terms, spend cap and price list, and every posted bill that breaks one. High: a unit price above the contract price, or spend taking the contract over its cap. Medium: a bill due sooner than the contract\'s payment terms, or billed after the contract ended with no other contract covering it. Low: an item not on the price list of a "contract items only" contract.',
    how: 'Record a contract from the vendor\'s signed terms. Start with the High findings: billed above contract prices is what to claim back as a vendor credit. Open a contract to see its findings bill by bill.',
    where: 'Purchases. Needs the purchases read permission; recording and terminating need purchases manage. Checked from posted bills; items match by HSN/SAC code, or by description. Nothing here changes the books, and no vendor is contacted.',
  },
  'purchases/vendor-contracts/new': {
    what: 'Records a vendor contract: the vendor, its term, payment terms in days, an optional spend cap and the agreed unit prices.',
    how: 'Give each item its HSN/SAC code where the bills carry one, else its description as the bills write it. Tick "Contract items only" when the vendor may bill nothing else. A vendor can have one contract at a time; terms cannot be changed afterwards, so terminate and record a new one.',
    where: 'Purchases, Vendor contracts. Needs the purchases manage permission. Prices are in your currency; foreign bills are converted at their own exchange rate.',
  },
  'purchases/vendor-contracts/[id]': {
    what: 'One vendor contract: its state, spend against the cap, the contract prices and every finding on the bills it covers, with what each was raised on.',
    how: 'Use the findings when you talk to the vendor or ask for a credit. Terminate the contract when it ends early: bills after the last day are flagged as outside the term, and the vendor can have a new contract from the next day.',
    where: 'Purchases, Vendor contracts. Terminating needs the purchases manage permission and is kept in the audit trail.',
  },
  'purchases/vendor-risk': {
    what: 'Every active vendor\'s risk, worked out from what the books hold: bank details changed, unverified or shared with another vendor, tax problems, a poor performance grade, a large share of purchases, a new vendor growing fast, onboarding not approved and bills paid late.',
    how: 'Work through the vendors waiting for a review. Open each, look at the factors and record a decision with a note and a date to look again. A new factor, a higher risk or that date asks for another review.',
    where: 'Purchases. The Vendor risk needs a review check in Alerts raises the same vendors. Talk2Tax does not buy outside credit or sanctions data; nothing here changes the books.',
  },
  'purchases/vendor-invoices': {
    what: 'Invoices vendors sent through their vendor portal link, with the file they attached, the purchase order they quoted and their note.',
    how: 'Check each one. Record the bill as usual (with their invoice number as the reference), then Record the sent invoice against it: the vendor\'s file is attached to the bill and the vendor sees it as recorded. Or turn it down with a reason the vendor sees; they can send it again.',
    where: 'Purchases. Give a vendor a link from the Vendor portal card on their page. Nothing a vendor sends posts to the books, and a vendor cannot change their bank details through the portal.',
  },
  'purchases/international-payments': {
    what: 'Payments to vendors abroad in their currency (outward remittances): the bills, the RBI purpose code, who pays the bank charges and, from India, which part of Form 15CA is needed and whether a Form 15CB is.',
    how: 'Choose a vendor and currency, tick the bills and the purpose, then prepare the payment. Someone else approves it. Download the bank instruction, give it to the bank with the forms, and record the payment at the bank\'s rate once paid.',
    where: 'Purchases. Recording the payment posts it in the foreign currency at the bank\'s rate, settles the bills and books any exchange difference. Talk2Tax never moves money itself.',
  },
  'purchases/international-payments/[id]': {
    what: 'One international payment: its bills, the vendor\'s bank abroad, the Form 15CA and 15CB position, and who prepared, approved, sent and recorded it.',
    how: 'While a draft, set the purpose, charges, expected rate and the Form 15CA acknowledgement and 15CB numbers, then approve. Download the instruction (this marks it sent) and record it as paid at the bank\'s rate.',
    where: 'Purchases. The recorded payment links here and appears on bank reconciliation.',
  },
  'purchases/payment-batches/new': {
    what: 'A new payment batch: the bank account, the payment date and the bills it pays.',
    how: 'Tick each bill to pay and change the amount to pay part of it. Vendors without verified bank details are flagged and block approval.',
    where: 'Purchases. Nothing is posted until the payments are recorded.',
  },
  'purchases/payment-batches/[id]': {
    what: 'One payment batch: its bills and vendors, who prepared and approved it, the bank file and the payments it made.',
    how: 'Approve a draft prepared by someone else. Once approved, download the bank file, then record the payments when the bank has paid. Cancel it if it will not be paid.',
    where: 'Purchases. Each vendor\'s payment has the batch reference; bills link to it.',
  },
  'purchases/payment-batches/[id]/edit': {
    what: 'Changing a draft payment batch.',
    how: 'Add or remove bills, change amounts, the date or the bank account. An approved batch cannot be changed; cancel it and prepare a new one.',
    where: 'Purchases. Nothing is posted until the payments are recorded.',
  },
  'purchases/recurring-bills': {
    what: 'Vendor bills that come again and again, such as rent, maintenance contracts and subscriptions, each with its schedule and the bills it has made.',
    how: 'Choose New recurring bill, or open a bill and choose Make recurring. Each bill is made by itself when its date comes, as a draft or posted. Make due bills now makes them straight away.',
    where: 'Purchases. Each bill it makes is an ordinary bill: it goes through GST, TDS, approval rules and periods like one entered by hand.',
  },
  'purchases/recurring-bills/new': {
    what: 'A new recurring bill: the vendor, the lines and the schedule.',
    how: 'Fill in the vendor and lines as on a bill, give the vendor reference a placeholder such as {month}, then choose how often and from when. The first bill is checked before saving.',
    where: 'Purchases. Nothing is posted until a bill falls due.',
  },
  'purchases/recurring-bills/[id]': {
    what: 'One recurring bill: its lines, the bills to come and the bills it has made.',
    how: 'Make due bills now, pause, resume (with or without the missed bills), edit or end it. One that has not made a bill can be deleted.',
    where: 'Purchases. The bills it made are listed with links; they appear in Bills like any other.',
  },
  'purchases/recurring-bills/[id]/edit': {
    what: 'Changing a recurring bill.',
    how: 'Change the lines, the amounts, the end date or whether bills are posted. Once it has made bills, its vendor, first date, frequency and run day stay as they are.',
    where: 'Purchases. Bills already made keep their lines and amounts.',
  },
  'purchases/orders': {
    what: 'Purchase orders: what you ordered from vendors, what has arrived and what is billed.',
    how: 'New purchase order, then Issue to vendor. Record goods received as deliveries arrive, and Make bill… when the vendor\'s invoice comes. Close an order when nothing more is coming.',
    where: 'Purchases. Bills made from an order are checked against it, and against the goods received for three-way matching, before they post.',
  },
  'purchases/orders/new': {
    what: 'A new purchase order, worked out by the same rules as a bill (tax rates, GST place of supply).',
    how: 'Choose the vendor, dates and lines, how bills are matched (three-way for goods, two-way for services) and the price and quantity tolerances. It is saved as a draft you can change until it is issued.',
    where: 'Purchases. Numbered PO- when saved.',
  },
  'purchases/orders/[id]': {
    what: 'One purchase order: its lines with what was ordered, received and billed, its goods receipts and its bills.',
    how: 'Issue a draft, record goods received, make the bill, close it when nothing more is coming, or cancel it if nothing was received or billed. Once issued its lines stay as they are.',
    where: 'Opened from Purchase orders. Each bill links to its match against this order.',
  },
  'purchases/orders/[id]/edit': {
    what: 'Changing a draft purchase order.',
    how: 'Change the vendor, dates, terms, matching, tolerances or lines, then save. An issued order cannot change; close it and raise a new one.',
    where: 'Purchases. Opened with Edit on a draft purchase order.',
  },
  'sales/payment-links': {
    what: 'Payment links: links customers open to pay an invoice online through your own Razorpay or Stripe account, with what was paid and the receipt each paid link recorded.',
    how: 'Make a link from a posted invoice with Make payment link. Show open, paid, cancelled or expired links. Open an invoice to copy, check or cancel its link.',
    where: 'Sales. Set up the gateways under Settings → Payment gateways. A paid link is an ordinary receipt into the gateway\'s bank account.',
  },
  'settings/payment-gateways': {
    what: 'Your organisation\'s own Razorpay and Stripe accounts, used for payment links on invoices: keys, mode, currencies, the bank account payouts go to and the webhook address.',
    how: 'Enter the keys from the gateway\'s dashboard, choose the currencies and the bank account, save, then Test connection. Add the webhook address shown here at the gateway so payments are confirmed straight away.',
    where: 'Governance. Keys are stored encrypted and never shown again. Each currency is paid through one gateway.',
  },
  'purchases/vendor-performance': {
    what: 'Vendor performance: a score and grade for each vendor from their deliveries against expected dates, goods rejected on receipt, bills that needed differences accepted and the team\'s reviews, with what they billed above the order price.',
    how: 'Pick a period (by default the last twelve months). Open a vendor to see each order\'s delivery and to add or withdraw reviews.',
    where: 'Purchases. Figures come from purchase orders, goods receipts and posted bills and vendor credits; the rules are listed at the bottom of the page.',
  },
  'purchases/onboarding': {
    what: 'Vendor onboarding: new vendors\' tax details, verified bank account, documents and payment terms, collected and approved before their bills are posted or they are paid, with the organisation\'s own checklist.',
    how: 'Switch on onboarding for new vendors and set the checklist at the bottom. Open a vendor to tick items off, attach files, verify their bank details, propose payment terms and submit; someone with approval rights approves or rejects.',
    where: 'Purchases. Approval sets the vendor\'s payment terms. Bills from a vendor whose onboarding is not approved cannot be posted, and they cannot be paid.',
  },
  'sales/onboarding': {
    what: 'Customer onboarding: new customers\' details, documents and credit terms, collected and approved before they are invoiced, with the organisation\'s own checklist.',
    how: 'Switch on onboarding for new customers and set the checklist at the bottom. Open a customer to tick items off, attach files, propose credit terms and submit; someone with approval rights approves or rejects.',
    where: 'Sales. Approval sets the customer\'s credit limit and payment terms. Invoices to a customer whose onboarding is not approved cannot be posted.',
  },
  'sales/retainers': {
    what: 'Retainers: money customers keep on account with you at an agreed level, held as their receipts not yet applied, with what each holds and any top-up due.',
    how: 'New retainer agrees the amount and the minimum. Open one to record a receipt into it, pay invoices from it, or close it once it holds nothing.',
    where: 'Sales. Retainer receipts are ordinary receipts, so the customer shows in credit in receivables until the retainer pays their invoices.',
  },
  'sales/retainers/[id]': {
    what: 'One retainer: its terms, the receipts that make it up, the invoices it has paid and the customer\'s open invoices.',
    how: 'Record receipt… posts a new receipt into it; Pay invoices… applies it to invoices, oldest receipt first. A top-up is due when the balance falls below the minimum.',
    where: 'Opened from Retainers.',
  },
  'sales/pro-formas': {
    what: 'Pro forma invoices: what a customer will be billed, sent before the sale to collect an advance or for their approvals. Not a tax invoice; nothing is posted.',
    how: 'New pro forma invoice, or Make pro forma invoice… on a sent or accepted quotation. Issue it, print it, then Make tax invoice… when you supply or are paid.',
    where: 'Sales. The tax invoice made from one is an ordinary draft invoice referenced PF-0001; deleting or voiding it frees the pro forma again.',
  },
  'sales/pro-formas/new': {
    what: 'A new pro forma invoice, worked out by the same rules as an invoice (tax rates, GST place of supply).',
    how: 'Choose the customer, dates and lines. It is saved as a draft you can change until it is issued.',
    where: 'Sales. Filled from the quotation when opened from one.',
  },
  'sales/pro-formas/[id]': {
    what: 'One pro forma invoice: its customer, dates, lines, totals and what became of it.',
    how: 'Issue a draft, print it, record an advance the customer pays, make the tax invoice, or cancel it with a reason. Once issued its lines stay as they are.',
    where: 'Opened from Pro forma invoices.',
  },
  'sales/pro-formas/[id]/edit': {
    what: 'Changing a draft pro forma invoice.',
    how: 'Change the customer, dates, terms or lines, then save. An issued one cannot change; cancel it and make a new one.',
    where: 'Sales. Opened with Edit on a draft pro forma invoice.',
  },
  'sales/pro-formas/[id]/print': {
    what: 'The pro forma invoice as the customer sees it, printed with your invoice template and marked as not a tax invoice.',
    how: 'Pick a template and print, or choose Save as PDF in the print dialog.',
    where: 'Opened from a pro forma invoice. Templates are managed under Invoice templates.',
  },
  'sales/disputes': {
    what: 'Invoices a customer has queried, with the amount in dispute, the reason, who owns it and the date to settle it by.',
    how: 'Raise a dispute from the invoice with Raise dispute…. As you type what the customer disputes, the likely reason is suggested from the words used and the invoice (another invoice for the same total within 45 days, or a disputed amount equal to the tax); use it or keep your own. A dispute whose reason looks wrong shows Looks like… in the list. Open a dispute to add notes, change the owner, amount or target date, and resolve it with a credit note, the customer paying, a write-off or the customer withdrawing it.',
    where: 'Sales. While a dispute is open its invoice is left out of payment reminders and overdue-invoice workflows; it still counts in receivables and the ageing. Suggested reasons are rule-based and explained, never applied by themselves, and use no AI model.',
  },
  'sales/disputes/[id]': {
    what: 'One dispute: what the customer disputes, how much, the owner, the date to settle by and every step taken.',
    how: 'Add a note after each call or email. Change… updates the amount, reason, owner or target date (kept in the history). Resolve… records how it ended; for a credit note, post the credit note first.',
    where: 'Opened from Disputes or the invoice. A resolved dispute is final; raise a new one if the customer queries the invoice again.',
  },
  'purchases/payment-schedule': {
    what: 'When each open bill will be paid, and the bank balance week by week after the planned payments.',
    how: 'Plan a date for each bill (and an amount, to pay part), or press Plan the rest to plan every unplanned bill for its due date or your pay day. Then prepare a payment batch from the bills planned up to a date.',
    where: 'Purchases. A plan moves no money and posts nothing; the payment batch, approved and paid through the bank, does.',
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
  'banking/unusual-activity': {
    what: 'Imported bank statement lines with warning signs, compared with the year before on the same account. High: a possible duplicate (same amount and narration within 3 days), three or more deposits or payments within a week each just under a threshold (50,000 unless set otherwise), or money paid out within 2 days of a large credit of almost the same amount. Medium: over three times the largest movement of the last 90 days, a payment of a lakh or more to a narration not seen in 180 days, or money out more than 14 days ago not matched in the books. Low: large round amounts.',
    how: 'Start with High. Check each line with the bank and the person who made the payment; match it to the books from the account\'s reconcile page, or exclude it with the reason if it is not real. Turn on the Unusual bank activity check in Alerts settings to be told about new ones.',
    where: 'Banking. Needs the banking permission. Works on statement lines, imported or from a bank feed. Nothing here changes the books, and no AI model is used.',
  },
  'banking/reconciliation-exceptions': {
    what: 'Why statement lines and entries in the books are still unmatched on each bank account, with what to do about each. In order: a line and an entry within 7 days whose amounts differ by up to 2% (a fee taken off, a short payment); one item equal to two or three on the other side (cheques banked together, a payment in parts); the same amount in and out again within 7 days (a returned payment, a reversed entry); bank charges or interest not in the books; other money at the bank not in the books; entries dated within 7 days of the latest statement line (in transit); entries more than 30 days older than it (old, not on any statement); and the rest (not on the statement yet).',
    how: 'Work from the top. Open the account\'s reconcile page to match the items, create an entry from a line, or exclude a line with the reason. In transit needs nothing yet. Pick a bank account to see its exceptions by kind and how long items have been waiting.',
    where: 'Banking. Needs the banking permission. Works on statement lines, imported or from a bank feed. Entries are looked at from the first reconciliation, or the first statement line if there is none. Nothing here changes the books, and no AI model is used.',
  },
  'banking/cash-movements': {
    what: 'Each bank account\'s balance week by week for the next 30, 60 or 90 days, from its imported statements. Movements that repeat (the same narration and direction at least 3 times, weekly, monthly or quarterly, each within 25% of the usual amount) are projected forward from when they were last seen; one due but not on a statement yet is put on tomorrow. Everything else is the average week of the last 13 weeks. The forecast starts from the account\'s balance in the books.',
    how: 'Pick an account and how far ahead to look. Watch the lowest expected balance; check the repeating movements are still right (a stopped one is shown but not projected). Import statements regularly to keep it current. For a forecast from open invoices and bills, use the Cash-flow forecast under Planning.',
    where: 'Banking. Needs the banking permission. Excluded statement lines are left out. The range is how the other movements have varied week to week, not a statistical confidence interval. Nothing here changes the books, and no AI model is used.',
  },
  'banking/feeds': {
    what: 'Bank feeds: connections that send a bank account\'s transactions as they happen, from a bank\'s host-to-host channel, an account aggregator partner, a treasury system or a script. A feed sends either transactions as JSON, each with its own id, or statement files (OFX, QIF or MT940). Each delivery adds its new lines to the account, unmatched, like an imported statement.',
    how: 'Owners and admins set up a feed for a bank account and give its token to the sender; the token is shown once. Then match and reconcile the lines as usual. Watch the health: Late means nothing arrived within the expected interval, Failing means the last delivery was refused. Open a feed to see every delivery and the reasons for anything refused.',
    where: 'Banking. Reading needs the banking permission; setting up, replacing a token and disconnecting need an owner or admin. One live feed per account. A transaction already sent (same id) or a line already on the account is never added twice, and nothing dated on or before the last reconciliation is added. Talk2Tax has no built-in connection to a particular bank; the sender posts to the feed. No AI model is used.',
  },
  'banking/feeds/[id]': {
    what: 'One bank feed: its health, how the sender posts to it, and the latest 50 deliveries with what was added, what was already there and what was refused and why.',
    how: 'Pause a feed to refuse deliveries for a while (the sender is told it is paused). Replace the token if it may have leaked: the old one stops at once. Disconnect when the feed is no longer used; the lines it added stay, and the account can have a new feed.',
    where: 'Opened from Bank feeds. Pausing and changing need the banking manage permission; replacing the token and disconnecting need an owner or admin. Every change and every refused delivery is in the audit trail, by the token\'s first characters; the token itself is never stored or recorded.',
  },
  'banking/[id]': {
    what: 'One bank account: imported statement lines, what is matched and what is not.',
    how: 'Import a statement, match each line to a receipt, payment or journal (or create one), then reconcile to the statement balance. Use Files on a line to keep the bank advice or receipt behind it; the button shows how many are attached. Suggestions learn from your matches: when two ledger lines have the same amount, the one with the contact or account you matched similar lines to comes first, and What matching learned shows what it has picked up.',
    where: 'Opened from Bank accounts.',
  },
  'banking/[id]/import': {
    what: 'Bring a bank statement file into the account.',
    how: 'Upload a CSV, OFX/QFX, QIF or MT940 file. For a CSV, map its columns to date, narration and amount; the other formats are read as they are. Check the preview, and import. Lines already imported are skipped. Choose the balance column too when the statement has one: each line is checked against the running balance, and the preview shows where lines are missing and how much.',
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
  deposits: {
    what: 'Fixed deposits with banks: what was deposited, interest earned to date, what is accrued in the books and what each pays at maturity.',
    how: 'Place a deposit with its amount, rate, compounding and dates. At each month or quarter end, accrue interest on every open deposit to that date. When one matures, open it and record what the bank paid and the tax it deducted.',
    where: 'Banking. Placing a deposit posts Dr the deposit account, Cr the bank; accruals post Dr interest accrued, Cr interest income; closing clears both into the bank and the tax deducted.',
  },
  'deposits/new': {
    what: 'Place a new fixed deposit and see what it will pay at maturity before you save it.',
    how: 'Enter the bank, amount, rate, how interest compounds, and the start and maturity dates, then choose the accounts. Most bank deposits in India compound quarterly.',
    where: 'Banking, from Fixed deposits. Saving posts the money leaving the bank on the start date.',
  },
  'deposits/[id]': {
    what: 'One fixed deposit: its terms, interest earned and accrued, and every journal posted for it.',
    how: 'Accrue interest to a date, or close the deposit with what the bank paid and the tax deducted, at maturity or early. The latest accrual or the closing can be reversed with a reason.',
    where: 'Banking, from Fixed deposits. Every action posts a journal you can open from the postings table.',
  },
  expenses: {
    what: 'Expense claims from employees for money they spent on the organisation\'s behalf.',
    how: 'Create a claim with receipts and lines, submit it, and an approver approves or rejects it. Approved claims are posted and paid. As you type a merchant or description, a suggested category appears from how earlier claims were booked; press Use to take it.',
    where: 'Expenses. Approved claims post to expense accounts and what is owed to the employee.',
  },
  'expenses/trips': {
    what: 'Business trips: each request with its purpose, destination, dates and an estimate for travel, lodging, meals and other costs, who is travelling and whether it is approved.',
    how: 'Request a trip before you travel. Someone other than you approves it, or rejects it with the reason. Once it is approved, link your expense claims to it from the trip page to see what it cost.',
    where: 'Expenses. Anyone who claims expenses can request trips and sees their own; finance and approvers see everyone\'s. Every request, decision and link is kept in the audit trail.',
  },
  'expenses/trips/[id]': {
    what: 'One trip: the request and the decision, the expense claims linked to it, and what it cost against the estimate: spent (approved and reimbursed claims), not yet approved, what is left, the cost a day, by expense category, and lines dated outside the trip.',
    how: 'Approvers approve or reject here. The traveller links their claims (any that are not void and not on another trip) and can unlink a claim until it is approved. A trip with no claims can be cancelled.',
    where: 'Expenses > Business trips. A line dated more than a day before or after the trip is flagged, and so are claims that pass the estimate. The request itself is not changed once made; cancel it and request another.',
  },
  'expenses/report': {
    what: 'Claimed spending in a period by category, month, person, status and merchant.',
    how: 'Pick the dates and which claims to count: waiting for approval, approved, reimbursed. Click a category or a person to see only theirs; click the filter again to clear it.',
    where: 'Expenses. Built from the lines of claims, dated by the day the expense happened. Drafts, rejected and void claims are left out. Those who read expenses see everyone; others see their own.',
  },
  'expenses/receipts': {
    what: 'Receipts for spending paid from a company bank or card account, each matched to the money-out line of the bank statement it paid; and the bank payments that still have no receipt. Spending a person paid themselves goes on an expense claim instead.',
    how: "Add a receipt with the merchant, date and amount, then attach the photo or PDF. Finance sees a suggested bank line for each receipt: Sure when the amount matches, the dates are close and the merchant's name is in the bank narration; Likely or Possible otherwise, with the reasons. Match one at a time, or all the sure ones together. Bank spending without a receipt shows who to ask.",
    where: 'Expenses. Anyone who submits expenses adds receipts and sees their own; matching needs the banking manage permission, and the bank list needs banking read. Bank lines come from imported statements; matching changes nothing in the books, and no AI model is used.',
  },
  'expenses/receipts/[id]': {
    what: 'One receipt: its file, the bank line it paid (or the suggested one, with the reasons), and its history.',
    how: 'Attach the file while the receipt is not matched. Finance matches it to the suggested line, or undoes a wrong match with a reason. A receipt uploaded by mistake can be discarded with a reason; it stays as a record.',
    where: 'Receipt matching. Every step is in the audit trail, with the files attached at the time.',
  },
  'expenses/forecast': {
    what: 'What expense claims are likely to cost in the coming months, by expense account, with a likely range, and what is owed to employees now and waiting for approval.',
    how: 'Choose how many months ahead. Each account uses the average of its last three months, adjusted for the season once it has a year of history; the range comes from how much it usually moves. Accounts used only now and then are listed separately.',
    where: 'Expenses. Worked out from approved and paid-back claims by the date the money was spent; drafts and rejected claims do not count.',
  },
  'expenses/missing-receipts': {
    what: 'Expense claims submitted, approved or reimbursed without any receipt attached, with why each matters: a line over the expense policy\'s "receipt above" amount, a category that always needs a receipt, or simply nothing backing the spending.',
    how: 'Start with the claims marked Required by policy. Ask for receipt records the request on the claim and emails the claimant when email is set up; they can attach the receipt even after approval, and the claim leaves this list once one is attached. The same claim can be asked about again after a day.',
    where: 'Expenses. Only receipt lines count; mileage and per diem lines are worked out from rates and need no receipt. Bank payments without a receipt are under Receipt matching. No AI model is used.',
  },
  'expenses/categories': {
    what: 'The categories people claim expenses under, such as Hotels or Client meals. Each posts to one expense account, can carry guidance on what belongs there and a default tax rate, and can always require a receipt.',
    how: 'Finance adds, edits and archives categories here. Once there is at least one, employees pick a category on each receipt line instead of an account; finance can still claim straight to an account. A category that always needs a receipt blocks submitting a claim without one. Per-category spending limits are expense policy rules on the category\'s account, listed beside it.',
    where: 'Expenses. Archived categories are no longer offered; lines already claimed keep the name. Claimed shows submitted, approved and reimbursed lines dated in the last 90 days. No AI model is used.',
  },
  'expenses/department-budgets': {
    what: "Each department's budget for the fiscal year against what it has spent on expense accounts, what claims waiting for approval would add, and how much is left. A department is Over when it spent more than its budget, At risk when waiting claims would take it over or when at this pace it would pass the budget by the year end, and On track otherwise.",
    how: 'Choose a department on each expense claim line. Finance sets a budget per department and year here (it needs the budgets permission); setting it again replaces it. Approvers see on a waiting claim what approving it would leave in each department\'s budget.',
    where: 'Expenses. Spent counts posted entries on expense accounts that carry the department, by posting date, closing entries left out. Waiting counts submitted claims in the functional currency. A budget does not block a claim; no AI model is used.',
  },
  'expenses/risk': {
    what: 'Expense claims submitted in the period with warning signs, compared across claims and people and with the year before. High: the exact same receipt file attached to another claim or to a posted supplier bill; the same receipt (date, amount and merchant, or category when there is no merchant) on another claim, by the same person or someone else, or receipts on one day split to stay under a per-receipt limit. Medium: far above the usual for the category, within 5% under a limit, someone with 3 or more lines just under a limit in 90 days, a receipt more than 60 days older than the claim, or receipts of 5,000 or more with no file attached. Low: a receipt on a Sunday, or a round amount of 1,000 or more.',
    how: 'Start with High and with the people at the top. Open a claim to see its receipts and ask the claimant; reject a claim that is wrong so they can fix it, or void one already approved. Turn on the Unusual expense claims check in Alerts settings to be told about new ones.',
    where: 'Expenses. Needs the expenses permission. Draft, rejected and void claims are left out. These are signs for a second look, not proof of fraud; nothing here blocks or changes a claim, and no AI model is used.',
  },
  'expenses/reimbursement-routing': {
    what: 'Approved expense claims still to be paid, grouped into one payment per person, each with a route and the account to pay from: a bank transfer when the person\'s employee record (matched by email) has a salary account, cash when it has none, wait for cash when no account has room after the amount you keep, or needs bank details when there is no cash account either.',
    how: 'Set how much to keep in each account and route the claims. People waiting over 7 days since approval come first. Tick the ready people and pay them: every claim is reimbursed today from the planned account through the usual journal, with your reference.',
    where: 'Expenses. Needs the expenses.reimburse permission. Only active accounts in your currency are used; the account a person was last reimbursed from is preferred while it has room. Bank account numbers are never shown.',
  },
  'expenses/evidence': {
    what: 'The audit evidence of every expense claim approved, reimbursed or voided in a period, collected automatically from the records: receipt files with their SHA-256 checksums, who approved it and when, policy exceptions and the approver\'s note, the journal entry, the reimbursement, its match on the bank statement, and the hash-chained audit trail. Each item is OK, Noted, Pending, n/a or a Gap.',
    how: 'Choose a period (the 90 days to today by default) and tick Only claims with gaps to see what needs fixing: attach the missing receipts, match payments on the bank statement. Open a claim for its evidence pack, or download the evidence index as CSV for the auditor.',
    where: 'Expenses. Needs the audit.read permission. A payment counts as missing from the statement only once the statement runs more than 3 days past it; cash payments have no statement. Nothing here changes the books.',
  },
  'expenses/evidence/[id]': {
    what: 'One expense claim\'s evidence pack: each kind of evidence with what the records show, the receipt files with their SHA-256, and the claim\'s events in the audit trail with their hashes.',
    how: 'Fix the gaps on the claim itself, then come back: the pack is collected again each time it is opened.',
    where: 'Expenses, Expense audit evidence. The full audit trail is under Audit trail.',
  },
  'expenses/reconciliation': {
    what: 'Employee expense claims reconciled three ways as of a date. The Employee Reimbursements Payable account in the books against the approved claims not yet paid back or voided by then, with every difference listed: an entry on the account that no claim made, or a claim whose own entries do not come to what it says is owed. Each claim paid back in the last 90 days against the imported bank statement. And what is owed to each employee, by days since approval.',
    how: 'Pick a date, such as a month end, or leave it empty for today. When the books and claims differ, open the entry or claim listed to see why. Pay back claims owed over 30 days. A payment not on the statement although the statement runs past it needs a look in Banking: match it, or check it was really paid.',
    where: 'Expenses. Needs the expenses permission. Claims in the functional currency; reimbursements count as on the statement once matched to a statement line. Nothing is posted here, and no AI model is used.',
  },
  'expenses/allowance-rates': {
    what: 'The rates employees can claim without a receipt: mileage per kilometre and per diem per day, each posting to an expense account.',
    how: 'Add a rate with a clear name, such as Car or Metro city, its amount and the expense account. Change a rate or make it inactive when your policy changes; claims already saved keep the rate they were saved with.',
    where: 'Expenses. Claimants choose these rates on mileage and per diem lines of a claim; finance (expenses.reimburse) sets them.',
  },
  'expenses/policy': {
    what: 'Spending limits and other rules every expense claim is checked against: limits per receipt, per day, per month and per claim, receipts needed above an amount, and how old a receipt may be.',
    how: 'Add a rule and choose whether it blocks submission or warns the approver. Limits per receipt, day and month can apply to one category. Make a rule inactive when the policy changes.',
    where: 'Expenses. Claimants see what their claim breaks on the claim; approvers must give a reason to approve a claim outside the policy; finance (expenses.reimburse) sets the rules.',
  },
  // ---------------------------------------------------------------- payroll
  'payroll/employees': {
    what: 'Your employees with their salary structure, PAN, statutory numbers and bank details.',
    how: 'Add an employee and their salary components. Open one to change their structure from a date.',
    where: 'Payroll. Employees are paid in Pay runs.',
  },
  'payroll/leave': {
    what: 'Leave types with a yearly allowance, leave taken by each employee, and the balance left in the April to March year.',
    how: 'Add leave types (paid with days a year, or unpaid), then record leave one month at a time. Unpaid leave becomes loss-of-pay days on that month\'s payslip; a draft run is updated at once.',
    where: 'Payroll. Leave in a month whose pay run is posted cannot change.',
  },
  'payroll/bonus': {
    what: 'The statutory bonus each employee is owed for an April to March year under the Code on Wages, from posted payslips, with what has been paid and what is still to pay.',
    how: 'Choose the year and the bonus rate (8.33% to 20%), check the two ceilings, then add the bonus to a draft pay run. It is paid and taxed with that month\'s salary.',
    where: 'Payroll. The bonus appears as a one-off earning on the payslips of the run you choose.',
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
  setup: {
    what: 'The business profile, how much the AI agents do, and a checklist that says whether the books are ready for day-to-day use.',
    how: 'Describe the business and review what the assistant recommends, or choose the industry, size, accounting framework and AI preference yourself, and save. Work through each required step on the checklist, then activate the organisation.',
    where: 'Governance. The checklist is worked out from your books each time; activation is recorded once in the audit trail.',
  },
  'opening-balances': {
    what: 'The balances you bring in on the day you start keeping your books in Talk2Tax, posted as one opening journal.',
    how: 'Pick the opening date, enter each account\'s balance as a debit or a credit, and post. Any difference goes to Opening Balance Equity; clear it once the figures are agreed. Saving again replaces the balances. Enter unpaid customer invoices and vendor bills as invoices and bills instead.',
    where: 'Accounting. The trial balance, ledgers and statements start from these balances.',
  },
  import: {
    what: 'Bring a chart of accounts, customers, vendors and opening balances in from another system or a spreadsheet saved as CSV.',
    how: 'Choose what to import, download the template or use your own headings, then preview. Fix every row marked Fix and preview again; Import creates the rows marked Create. Codes and names already in your books are skipped, never changed.',
    where: 'Accounting. Each import is recorded in the audit trail; opening balances are posted as one opening journal and replace the ones before.',
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
  'purchases/bill-checks': {
    what: 'Bills from the last 120 days that look unusual against the same vendor\'s earlier bills and bank details.',
    how: 'Open each bill, read what was compared, check with the vendor where needed, then mark it reviewed with why it is fine. A review covers the findings it saw; a new finding brings the bill back.',
    where: 'Purchases. Rule-based checks: vendor invoice number used before, much more than usual, a price that went up, a new expense account, the first bill from a vendor, bank details changed recently or not verified, odd dates and round amounts without tax. Anyone who reads purchases sees them; those who manage purchases review them.',
  },
  'account-reconciliations': {
    what: 'Every asset and liability account at a date, with the items that explain its balance and who signed it off.',
    how: 'Pick the date, open an account and list what makes up its balance: a count, a statement, a schedule, and reconciling items for timing differences. Sign off when nothing is unexplained; someone else then reviews it. Receivable and payable control accounts are compared with the open items in their ledgers.',
    where: 'Accounting, usually during the Month-end close. A posting after sign-off shows the account as changed until it is reopened and signed off again. Anyone who reads reports sees them; those who manage the close prepare and review them.',
  },
  'duplicate-files': {
    what: 'The same file (byte for byte) attached to more than one record, most serious first.',
    how: 'Open each record and check the spending is not counted twice. One receipt on two expense claims or one vendor invoice on two bills is serious; a remittance advice on an invoice and its receipt is usually fine. Remove the file from the wrong record, with the reason, and it drops off the list.',
    where: 'Governance. Files are compared by their SHA-256 fingerprint, so a rescanned or edited copy is not found. Only records you may see are listed. Each record\'s Attachments card also names the other records holding the same file.',
  },
  'cost-allocations': {
    what: 'Rules that spread shared costs, such as rent, power or software, from where they were booked to the departments (cost centres) that use them.',
    how: 'Add a rule: the expense accounts, where the cost sits now (often no department) and each department\'s share, adding up to 100 percent. Pick a period, preview, then post. Each rule posts once per period; reverse a run to post it again.',
    where: 'Accounting, usually during the Month-end close. The journal is dated the last day of the period and shows in Profit by department. Anyone who reads reports sees rules and runs; accounts.manage writes rules; close.manage with journals.post runs them.',
  },
  'financial-tags': {
    what: 'Tags you define to report by, such as Location (an office, store or branch), Business unit or Sales channel, and their values.',
    how: 'Add a tag from a preset or name your own, then add its values. Pick a value on journal lines; a line using a defined tag must use one of its values in use. Switch a value off to stop new lines using it.',
    where: 'Accounting. Tags show under each journal line and as columns in Profit by department, project or tag. Values are never removed, so old lines keep their name.',
  },
  'year-end': {
    what: 'Closing each fiscal year: its revenue and expense accounts brought to nil and the profit or loss moved to retained earnings.',
    how: 'Once a year has ended, choose Close the year, check the closing journal and post it. If something is posted to the year later, close it again: only the difference is posted. Reopen reverses the year\'s closes.',
    where: 'Accounting. The closing journal is dated the year\'s last day. Profit and loss reports leave it out; the balance sheet shows the profit in retained earnings.',
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
    where: 'Accounting. Invoices, bills and payments in another currency take these rates. Revaluations post the unrealised gain or loss; settling a document at another rate posts the realised one.',
  },
  // ---------------------------------------------------------------- reports
  'reports/dashboards': {
    what: 'Your own dashboards of approved metrics, built by hand or described in words.',
    how: 'Create a dashboard, add widgets, or describe what you want and check the AI\'s draft before saving.',
    where: 'Reports. Widgets read the same figures as the reports.',
  },
  'reports/dashboards/[id]': {
    what: 'One dashboard, with its figures worked out from the posted books for the month you choose.',
    how: 'Pick a month to see its figures. Those who manage dashboards can press Arrange to drag metrics onto the dashboard and reorder widgets (or use the buttons without a mouse), or Edit to change titles, sizes and periods.',
    where: 'Reports → Dashboards. Everyone in the organisation sees the same layout; every change is a new version in the audit trail.',
  },
  'reports/trial-balance': {
    what: 'Every account\'s debit or credit balance on a date. Debits always equal credits.',
    how: 'Pick the date. Open an account to see the entries behind its balance.',
    where: 'Reports. The starting point for checking the books and for audits.',
  },
  'tax/notices': {
    what: 'Letters from tax authorities (GST, income tax, TDS, PF, ESI, professional tax and others) that ask for a reply, information or payment, each with its reply deadline.',
    how: 'Record a notice from the letter, add the letter as a file, note what is done, record the reply when it is sent, and close it with the outcome. Overdue and due-soon notices are listed first.',
    where: 'Tax. Anyone who reads reports sees notices; those who manage the accounts (accounts.manage) record and work them. Every step is kept in the notice history and the audit trail.',
  },
  'tax/notices/[id]': {
    what: 'One tax notice: its status and reply date, the amount demanded, the analysis of what kind of notice it is and how to reply, its files and its history.',
    how: 'Use the analysis to see the usual deadline, how to reply and what to gather; tick the checklist as you go. Add the letter and your reply as files, record the reply when it is sent, and close the notice with its outcome.',
    where: 'Tax → Notices. Anyone who reads reports sees it; those who manage the accounts work it. Every step is kept in the history and the audit trail.',
  },
  'reports/income-statement': {
    what: 'Profit and loss: revenue less expenses for a period.',
    how: 'Choose the period and the basis. Accrual (the default) counts income and expenses when invoiced or billed; Cash counts them when money is received or paid, in the share of each invoice, bill, expense claim or pay run settled in the period, and shows the accrual result beside it. Open a line to see its entries. Export to Excel or PDF.',
    where: 'Reports. Comes from posted revenue and expense entries; on a cash basis, also from payments, credit notes applied, expense claims paid back and payroll payments.',
  },
  'reports/profit-by-dimension': {
    what: 'Profit and loss with a column for each department, project or value of a tag such as Location.',
    how: 'Pick the period and whether to split by department, project or one of your tags.',
    where: 'Reports. Uses the tags set on lines; untagged amounts are shown separately.',
  },
  'reports/balance-sheet': {
    what: 'What the organisation owns and owes on a date, and its equity.',
    how: 'Pick the date and compare it with an earlier one. Open a line to see its entries.',
    where: 'Reports. Assets always equal liabilities plus equity.',
  },
  'reports/payroll': {
    what: 'Posted pay runs over a range of months: gross pay, deductions, net pay and the cost to the employer; the statutory amounts (PF, ESI, professional tax and TDS on salary) withheld and added by the employer; each month with its change in gross pay; and each employee with what was paid and withheld.',
    how: 'Choose the months, or leave them blank for the financial year to date. A change of 10% or more in gross pay on the month before is flagged: check joiners, leavers and one-off pay. Post the draft pay runs listed to include them. Download the CSV for your payroll adviser; each download is kept in the audit trail.',
    where: 'Reports. Needs the payroll read permission. Built from posted payslips; voided and draft pay runs are left out. Bank account details are never part of this report. Nothing here changes the books.',
  },
  'reports/audit': {
    what: 'What happened in the books over a period, from the audit trail: how many events each person recorded and on which kinds of record; the sensitive actions an auditor asks about (periods reopened, access changes, bank details changed, deletions, voids, reversals and cancellations, settings changed and data exported); and posted journals that need a second look (posted more than 30 days after their date, large round manual journals, and manual journals prepared and posted by the same person). The audit trail hash chain is checked every time.',
    how: 'Choose the days, or leave them blank for the financial year to date. Work through the journal checks first, high ones first: open each journal, check its support and who approved it. Ask about every sensitive action you do not recognise. Download the CSV for your auditor; each download is kept in the audit trail.',
    where: 'Reports. Needs the audit read permission. Days are in your organisation\'s time zone. Built from the audit trail and posted journals; nothing here changes the books.',
  },
  'tax/income-computation': {
    what: 'The computation of total income and tax for a financial year, as prepared for the return of income of a company or firm: net profit before tax from the books; depreciation in the books added back and depreciation under section 32 deducted; cash payments over 10,000 to one person in a day added back (section 40A(3)); your other additions and deductions with their sections; business loss brought forward set off (section 72); tax at the chosen corporate rates with surcharge, marginal relief and cess; less TDS, advance tax and other tax paid, giving the self-assessment tax or the refund.',
    how: 'Choose the year (the last one by default). Enter the regime, depreciation from your block-of-assets working, any loss brought forward and other adjustments, and save. TDS and advance tax come from the accounts chosen on the Advance tax page. Once the year has ended, finalise the computation to freeze it; later postings to the year are shown against it. Print it for your tax professional.',
    where: 'Tax. Indian organisations. Anyone who can read reports sees it; saving and finalising need the accounts permission and are kept in the audit trail. It does not work out interest under sections 234A to 234C or minimum alternate tax, and it files nothing.',
  },
  'tax/audit-preparation': {
    what: 'What is left to do before a financial year\'s books go to the tax auditor, worked out from the books: every month locked, the year closed to retained earnings, no drafts dated in the year, bank accounts reconciled to the year end, returns and tax payments for the year done (and on time), acknowledgements and challans on file, cash payments over 10,000 a day (40A(3)), cash received of 2 lakh or more (269ST), TDS deposited on time, depreciation posted, and the income tax computation final. Each check is ready, needs attention, missing or does not apply.',
    how: 'Choose the year (the last one by default). Fix what is missing from the page each check links to. For anything that needs attention, fix it or add a note for the auditor saying why it is so. When nothing is missing and every attention point is explained, mark the year ready: the checks and notes are kept as they were, and the page shows which checks moved if the books change later. Download the checklist with your notes for the auditor. Reopen with a reason to change notes.',
    where: 'Tax. Indian organisations. Anyone who can read reports sees it and can download it; notes, marking ready and reopening need the accounts permission and are kept in the audit trail. It prepares; the auditor still audits and signs Form 3CA/3CB and 3CD.',
  },
  'reports/executive': {
    what: 'A report on a fiscal quarter or year for the leadership team and the board: revenue with its growth on the period before and on a year before, gross margin, net income, cash at the end and the runway; a summary profit and loss against the period before and the same period last year; each month; the largest customers; points that need attention (a net loss, revenue down 10% or more, gross margin down 5 points or more, a runway under a year, one customer with 30% or more of revenue); and your narrative.',
    how: 'Choose the period. Write the highlights, challenges, outlook and the decisions you need, and save. When the period has ended, finalise the report: the figures and the narrative are frozen, and postings made later are listed on it instead of changing it. Print it to share it.',
    where: 'Reports. Anyone who can read reports can open it; writing and finalising need the budgets permission. Built from posted journals and invoices. Each save and finalise is kept in the audit trail.',
  },
  'reports/investor': {
    what: 'A report on a fiscal quarter or year for investors: revenue with its growth, gross margin, net income, cash at the end and the runway; a summary profit and loss against the period before and the same period last year; each month; how concentrated revenue is (customers are never named); and your update with highlights, challenges, outlook and asks.',
    how: 'Choose the period, write the update and save. When the period has ended, finalise it to freeze the figures and the update; later postings are listed on it instead of changing it. Print it, or save it as a PDF from the print dialog, to send it.',
    where: 'Reports. Anyone who can read reports can open it; writing and finalising need the budgets permission. It is kept separate from the executive report for the same period, so each can say what its readers need. Each save and finalise is kept in the audit trail.',
  },
  'reports/tax': {
    what: 'The tax in a period from posted invoices, credit notes, bills and vendor credits: taxable value, output tax and input tax at each rate with the net, the same by month, tax withheld (TDS on bills, TCS on invoices) by section, and every tax payable, tax receivable and tax expense account with its balance at the start, debits, credits and balance at the end.',
    how: 'Choose the period, or leave it blank for the financial year to date. Compare the net with the tax accounts: a difference points to tax posted by hand or a document posted to the wrong account. Download the CSV for your tax adviser; each download is kept in the audit trail.',
    where: 'Reports. Needs the reports permission. Foreign-currency documents count at their own exchange rate. Credit notes and vendor credits are taken off. Drafts and voided documents are left out. GST heads show when documents carry them. Nothing here changes the books.',
  },
  'reports/vendor-spend': {
    what: 'What you bought, from whom and on what, compared with the period before.',
    how: 'Pick the dates. Start with the largest vendors and the biggest changes; open an account to see its entries.',
    where: 'Reports. Posted bills before tax, less vendor credits, in your currency.',
  },
  'reports/schedules': {
    what: 'Reports emailed to members on a weekly or monthly day, such as the profit and loss on the 3rd of each month.',
    how: 'Choose the report, the dates it covers, when it goes and who gets it. Send now to try it.',
    where: 'Reports. Email must be set up in Settings › Integrations; each run is kept with the file it sent.',
  },
  'reports/cash-flow-statement': {
    what: 'Where the cash came from and went in a period: operating, investing and financing activities.',
    how: 'Pick the dates. Start from profit, see what working capital used, then open a line to see its entries.',
    where: 'Reports. It explains the change in your cash and bank accounts, so the last line matches the balance sheet.',
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
    how: 'Create a group, add companies and ownership, set rates and elimination rules, record any consolidation adjustments such as goodwill, and run the consolidation for a date.',
    where: 'Reports. Reads each company\'s books; posts nothing to them.',
  },
  // ---------------------------------------------------------------- tax
  'tax/compliance': {
    what: 'Every tax filing and payment due, with its date and status.',
    how: 'Check what is due this month, open an item to see what to file, and mark it filed with the reference.',
    where: 'Tax. Dates come from your GST, TDS/TCS and payroll settings.',
  },
  'tax/advance-tax': {
    what: 'The advance income tax for the tax year: the year\'s estimated income, the tax on it with surcharge and cess, and how much should be paid by each of the four instalment dates.',
    how: 'Choose how the business is taxed and how to estimate the year (the profit so far scaled up to a full year, or your own figure), add adjustments from book profit to taxable income, and pick the accounts that hold advance tax paid and tax deducted at source. Pay what each instalment shows by its date.',
    where: 'Tax. Reads posted journals for the tax year (April to March); income tax expense and year-end closing are left out. Saving changes only the plan, not the books. For companies, firms and LLPs; not individuals, presumptive income, MAT or interest for late instalments.',
  },
  'tax/vat-return': {
    what: 'Your VAT or GST return for each period, prepared from posted invoices, credit notes, bills, vendor credits and approved expense claims: the nine boxes of the UK VAT return, boxes 1 to 8 and 13 of the Singapore GST F5 (with revenue from the ledger), the GST items G1, 1A and 1B of the Australian BAS in whole dollars, lines 101 and 103 to 109 of the Canadian GST/HST return, the boxes of the UAE VAT 201, or the Kennzahlen of the German advance return (Umsatzsteuer-Voranmeldung). It shows the figures by treatment, every line behind them, corrections of returns already submitted and other entries on the tax accounts to check.',
    how: 'Add your registration number, the date it took effect, your return periods and how each tax rate counts (standard, reduced in the UK, zero, exempt or out of scope; in Australia taxable, GST-free, input-taxed or out of scope; in Canada taxable at the GST or HST rate, zero-rated, exempt or out of scope; in the UAE standard-rated at 5%, zero-rated, exempt or out of scope, with the emirate you are established in; in Germany 19%, 7%, tax-free with or without input tax deduction, or not taxable). Open a period that has ended, check the boxes and the warnings, enter the figures in HMRC\'s Making Tax Digital software, IRAS\'s myTax Portal, the ATO\'s online services, the CRA\'s My Business Account, the FTA\'s EmaraTax or ELSTER, then record the submission with its date and reference. A back-dated document in a submitted period goes on the next return as a correction when the net is within the limit (UK: £10,000, or 1% of box 6 up to £50,000; Singapore: S$1,500 net GST; Australia: A$10,000 within 18 months; Canada: only input tax credits missed earlier, within four years; UAE: AED 10,000; Germany: never, a corrected return for the period instead); above it, tell HMRC on form VAT652, file a GST F7 with IRAS revise the earlier BAS with the ATO ask the CRA to adjust the earlier return submit a voluntary disclosure to the FTA or file a corrected advance return with the Finanzamt.',
    where: 'Tax. UK organisations keeping books in pounds, Singapore organisations in Singapore dollars, Australian organisations in Australian dollars, Canadian organisations in Canadian dollars, UAE organisations in dirhams and German organisations in euros. Needs the reports permission; changing the registration and recording a submission need accounts manage and are kept in the audit trail. A submitted return is never changed. A voided document stays in its own period and is taken off in the period it is voided. Not covered: special schemes (cash, flat rate, margin), reverse charge, import schemes, partial exemption, blocked input tax and Northern Ireland EU trade, in Australia the BAS items other than GST and the cash basis, in Canada PST, QST, the Quick Method and the line 104 and 107 adjustments, in the UAE tourist refunds, imports and the place of supply by emirate, and in Germany intra-EU trade, the reverse charge and cash accounting. Nothing is sent to HMRC, IRAS, the ATO, the CRA, the FTA or the Finanzamt.',
  },
  'tax/scenarios': {
    what: 'What a change to the year\'s business would do to income tax and GST, against the year\'s advance tax estimate: more or fewer sales, more or fewer deductible expenses, depreciation on new assets, expenses that are not deductible and another tax regime. Each scenario shows the taxable income, the tax with surcharge, marginal relief and cess, the change on the estimate, the profit after tax, the GST collected less the input credit on the change and the cash effect.',
    how: 'Set the estimate on the Advance tax page first. Enter the changes, choose the GST rates and work it out. Save the scenarios worth keeping: they are worked out again whenever the estimate changes, so they stay comparable. Regimes compared shows the tax on the estimate under each regime open to the business.',
    where: 'Tax. Needs the reports permission; saving and deleting scenarios needs accounts manage and is kept in the audit trail. Indian organisations only. Rates are those in the advance tax module and must be checked against the year\'s Finance Act. Losses carried forward, minimum alternate tax and instalment timing are not modelled. Nothing here changes the books.',
  },
  'tax/forecast': {
    what: 'The tax payments due in the coming months, from the compliance calendar: GST (GSTR-3B or PMT-06), TDS and TCS deposits, PF, ESI and professional tax, and advance income tax, with an amount for each, how it was worked out, and totals by month.',
    how: "Choose how many months ahead. From the books: the period is over and the books say what is owed (GST after input credit set-off, including any earlier unpaid months; TDS/TCS deducted and not deposited; payroll dues of a posted pay run not paid). From the advance tax plan: the instalment the plan needs. Recent average: the average of the last three periods, with a range of how much it usually moves. Pay overdue items first.",
    where: 'Tax. Needs the reports permission; Indian organisations with GST, TDS/TCS, payroll or advance tax set up. Nothing is paid or filed here, and no AI model is used.',
  },
  'tax/compliance-documents': {
    what: 'The documents behind the compliance calendar: acknowledgements of returns, challans of payments, copies of returns, working papers, registration certificates and notices, each linked to its return or payment with the files attached and the date to keep it until; and the returns marked filed and payments made in the last year that do not have their acknowledgement or challan on file.',
    how: "Use Add on a missing document, or choose the return or payment yourself; the kind of document and a title are filled in. Then attach the file. A record added by mistake is voided with a reason, not deleted. Keep until is the end of the eighth financial year after the period (Companies Act, section 128(5)); registration certificates are kept while the registration lasts.",
    where: 'Tax. Reading needs the reports permission; adding, attaching and voiding need the accounts permission (as marking a return filed does). Indian organisations; returns and payments due in the last year or the next 30 days can be linked. Nothing is filed and no AI model is used.',
  },
  'tax/compliance-documents/[id]': {
    what: 'One compliance document: its kind, the return or payment it belongs to, the reference, the files, and how long to keep it.',
    how: 'Attach the files while the record is on file. Void a record added by mistake with a reason; it stays, and its files can no longer change.',
    where: 'Compliance documents. Every step is in the audit trail, with the files attached at the time.',
  },
  'tax/tax-audit': {
    what: 'Working papers for the tax audit report (Form 3CD) of a financial year, from the books: whether a tax audit is needed on turnover (section 44AB(a)), cash paid to one person in a day over 10,000 (section 40A(3), clause 21(d)), cash received of 2 lakh or more from one person in a day (section 269ST, clause 31), TDS deposited late or not at all with interest at 1.5% a month or part (clause 34), and spending by whether the supplier is registered for GST (clause 44).',
    how: 'Choose the financial year (the last one by default). Share the figures with your auditor, fix what can still be fixed (deposit TDS still owed), and keep the lists as support for the clauses. Cash means payments and receipts from or into an account with the Cash subtype.',
    where: "Tax. Needs the reports permission; Indian organisations only. Reads posted invoices, bills, payments and the TDS register; expense claims and journals are not counted as cash. Section and clause numbers are those of the Income-tax Act, 1961 and Form 3CD. Nothing is filed, and no AI model is used; it does not replace the auditor's judgement.",
  },
  'tax/compliance-predictions': {
    what: 'The open filings and payments from the compliance calendar (GSTR-1, GSTR-3B, TDS/TCS deposits, PF, ESI and professional tax), each scored likely late, at risk or on track, with the reasons: how often the same deadline was missed in the last year, how many days before or after the due date it is usually done, how close the date is, and what in the books is not ready yet.',
    how: 'Choose how many days ahead. Work through the deadlines marked likely late first: fix what the books point to (GST accounts that differ from the month\'s documents, high-severity tax mistakes, a pay run not posted), then file or pay. Record each filing on the compliance calendar so the record stays right.',
    where: 'Tax. Needs the reports permission; Indian organisations with GST, TDS/TCS or payroll set up. The record comes from filing dates on the compliance calendar and deposit and payment dates in the books over the last 365 days. Nothing is filed or changed here, and no AI model is used.',
  },
  'tax/gst-reconciliation': {
    what: "A month's GST accounts in the books against what its documents say (the GSTR-3B figures), with every difference traced to the journal or document that made it: a manual journal on a GST account, a document dated in another month but posted in this one, a document voided later or an earlier one voided now, or a posting that no longer matches its document. The month's documents are also checked for tax mistakes: IGST on a supply within the state or CGST and SGST between states, unequal CGST and SGST, tax that is not the rate on the value, tax on exempt lines, an invalid GSTIN or one from another state than the supplier, input tax credit without the supplier's GSTIN, missing HSN codes and one HSN sold at different rates.",
    how: 'Choose the month, usually before filing GSTR-3B. When the books differ, open each item: correct a manual journal, or amend the return of the month a document belongs to. Fix high-severity mistakes before filing; low ones are worth a look.',
    where: 'Tax. Needs the reports permission and a GST registration. GST payments settle the accounts and are shown apart. Reads posted journals and documents only; nothing is changed or filed, and no AI model is used.',
  },
  'reports/department-performance': {
    what: "Each department's revenue, spending, profit and margin over the months you choose, month by month, ranked by profit, with its share of all spending, whether its spending is rising, and its spending in this fiscal year against its budget.",
    how: "Choose the months (up to 24). Compare departments in the bar chart, follow each one's profit in the line chart, and open a department in the ranking to see its own profit and loss for the same months. Spending that carries no department is shown as Not assigned.",
    where: 'Reports. Needs reports.read. Built from posted journal lines booked to departments, leaving out year-end closing entries. Budgets come from Expenses → Department budgets. Nothing is changed and no AI model is used.',
  },
  'reports/timeline': {
    what: 'A timeline of the books: every posted entry, the cash it moved through cash and bank accounts, the cash balance as it went, and the compliance deadlines in the same days.',
    how: 'Choose the days (up to 400) or a preset. The timeline groups them by day, week or month to fit, or as you choose. Drag the handles under the chart to zoom, untick kinds of entries to hide them, and choose a bar or a period to list its entries and deadlines. Open an entry to see the journal.',
    where: 'Reports. Needs reports.read. Built from posted journals (year-end closing entries left out) and the compliance calendar. Transfers between your own cash and bank accounts are not counted as cash in or out. Nothing is changed and no AI model is used.',
  },
  'reports/risk-monitor': {
    what: "Where risk sits today across alerts, payment fraud checks, expense risk, unusual bank activity, compliance deadlines and vendor risk, each scored 0 to 100, with an overall score, the findings that drive each area and the trend of daily readings.",
    how: 'Each high finding adds 25 points to its area, each medium 10 and each low 3, up to 100. The overall score is 60% the worst area and 40% the average of the areas that have something to check. Look first at the areas named at the top, and open an area to act on its findings.',
    where: 'Reports. Needs reports.read; an area your role cannot read is left out. It reads the same checks as Alerts, Payment fraud checks, Expense risk, Unusual bank activity, Deadline risk and Vendor risk. One reading a day is kept when the monitor is opened, for the trend. No AI model is used.',
  },
  'reports/dependencies': {
    what: 'Who the business depends on for its money, as a network: customers for revenue and vendors for spending over the months you choose, and the cash and bank accounts and lenders at their end, with how concentrated each group is and the single dependencies worth watching.',
    how: 'Choose the months (up to 24) and the groups to show. Wider lines are larger shares; red and orange lines are critical and high dependencies. Choose a party in the network, the list or a table to see its share and open the customer, vendor or ledger, or explore its connections.',
    where: 'Reports. Needs reports.read. Revenue comes from posted invoices less credit notes, spending from posted bills less vendor credits (before tax), cash and borrowing from account balances. The concentration index is the Herfindahl–Hirschman index of the shares: under 1,500 spread out, above 2,500 highly concentrated. Nothing is changed and no AI model is used.',
  },
  'reports/role-dashboards': {
    what: 'A dashboard for each role that reads the books, each laid out for its own questions: the CEO (headline, revenue, cash, risk, biggest customers), the CFO (margins, liquidity, what is owed both ways, tax going out), treasury (cash by account, the next 90 days, bills to pay and money coming in), the risk officer (scores by area and concentration), compliance (deadlines and tax due), the board or investors (quarters and position, with no customer or vendor named), and the receivables, payables, tax and expense managers (ageing, whom to chase or pay, held and flagged items, tax payments and returns, claims, receipts and budgets).',
    how: 'Choose a role at the top; the choice stays in the address so it can be bookmarked or shared. Each figure links to the page it comes from, where you can act on it. KPIs are for the last complete month, as on the KPIs page.',
    where: 'Reports. Needs reports.read. It reads the same figures as KPIs, the cash-flow forecast, payment and collection priorities, the risk monitor, financial dependencies, deadline risk, the tax forecast, bill exceptions, payment fraud checks, GST reconciliation, expense risk and department budgets; the expense dashboard also needs expenses.read. Nothing is stored and no AI model is used.',
  },
  'reports/visuals': {
    what: 'The profit and loss of the months you choose, drawn four ways: a waterfall from revenue down to net profit, a Sankey of where income came from and where it went, a heatmap of the largest expense accounts month by month, and a treemap of what spending is made of.',
    how: 'Choose the months (up to 24). Choose a waterfall bar, a Sankey group or a spending group to list the accounts behind it; choose an account, a heatmap cell or a treemap block to open its general ledger for the same months.',
    where: 'Reports. Needs reports.read. Built from posted journals, leaving out year-end closing entries and drafts; nothing is changed and no AI model is used. Charts respect reduced motion, and each has its figures in a list or table beside it.',
  },
  'expenses/cards': {
    what: "Company cards from any card provider: corporate cards people already hold and virtual cards made for one use, each with a holder, a monthly limit and this month's spending; the spending the provider sends; and the card programmes that let it send it. Spending that the same person also put on an expense claim (same amount, within three days) is marked as possibly claimed twice.",
    how: 'An owner sets up a card programme for the provider and gives it the token shown once. Finance adds corporate cards by their last four digits or asks for virtual cards, and freezes, unfreezes, cancels or changes limits; the provider reads these controls. Cardholders choose Explain on their spending to say which account it belongs to; finance posts settled spending to the books or excludes it with a reason.',
    where: 'Expenses. Everyone sees the cards they hold and their own spending; finance (expenses.read) sees all. Adding and controlling cards needs banking.manage, programmes need org.manage, and posting needs journals.post: the journal debits the account and credits the programme\'s card account. Full card numbers never reach Talk2Tax. Connecting a real provider needs that provider to send to the card feed with the token.',
  },
  'purchases/bill-reader': {
    what: "Reads a supplier's bill from the PDF they sent, or from its pasted text: the supplier, bill number, dates, items, taxes and total.",
    how: 'Upload the PDF or paste the text, then open the reading to check what was found and save it as a bill. Scans and photos have no text to read; enter those by hand.',
    where: 'Purchases. Nothing reaches the books until a person reviews the bill in the bill form and saves it; the PDF is then attached to the bill.',
  },
  'purchases/bill-reader/[id]': {
    what: 'One bill read by the bill reader: each field with whether it was printed on the bill, worked out from it or not found, the amounts, and the checks.',
    how: 'Read the checks, correct the bill form (supplier, accounts, tax), then save it as a draft or post it. Discard the reading if it is not a bill you owe.',
    where: 'Purchases → Bill reader. Saving links the reading to the bill, attaches the PDF and records in the audit trail what you changed from what was read.',
  },
  'purchases/supplier-statements': {
    what: 'Statements of account your suppliers send, each matched to the bills, vendor credits and payments in your books for its period, with the difference between their balance and yours traced to the lines and items that cause it.',
    how: 'Choose Reconcile a statement, pick the supplier, enter the period and their balances, and paste the lines from their statement. Open a statement to see what is only on theirs, what is only in your books and which amounts differ.',
    where: 'Purchases. Reading needs purchases.read; entering and reconciling needs purchases.manage and is audited. Amounts are in one currency; the books side is the supplier\'s statement in the purchases ledger. No AI model is used.',
  },
  'purchases/supplier-statements/new': {
    what: "Entering a supplier's statement of account to check it against your books.",
    how: 'Choose the supplier and the period, type their opening and closing balances, and paste the lines as CSV (date, reference, type, amount). Rows that cannot be read are listed before you save. Copy their figures as they are, even ones you think are wrong.',
    where: 'Purchases → Supplier statements. Needs purchases.manage. Dates may be YYYY-MM-DD or DD/MM/YYYY; types are invoice, debit note, credit note or payment.',
  },
  'purchases/supplier-statements/[id]': {
    what: "One supplier statement reconciled: their balance against your books, the parts that make up the difference (a different opening, lines only on theirs, items only in your books, amounts that differ, a statement that does not add up), and each line matched to a bill, vendor credit or payment by their reference or by amount and date.",
    how: 'Work through the lists: enter missing bills, record missing payments, send them details of items they have not recorded. If you typed something wrong, correct the statement as entered. Then mark it reconciled with a note saying how the remaining differences will be settled.',
    where: 'Purchases → Supplier statements. A statement that does not add up cannot be reconciled; once reconciled it is fixed. Matching ignores separators and leading zeros in references; payments match within 10 days, bills within 7.',
  },
  'tax/reverse-charge': {
    what: "A month's reverse-charge register: posted bills and vendor credits where you pay the GST instead of the supplier, on notified goods and services (CGST Act s.9(3)) and services from abroad (IGST Act s.5(3)). It shows the tax by head to pay in cash, which bills need a self-invoice and by when, and bills that were not recorded under reverse charge although their HSN/SAC is a notified category, such as security services, legal services by an advocate, a goods transport agency or metal scrap from an unregistered dealer.",
    how: 'Choose the month. Issue the self-invoice for each bill from a supplier with no GSTIN or outside India within 30 days of the bill. Check each bill under "may need reverse charge" against its condition; if it applies, void the bill and record it again with Reverse charge ticked. Then pay the month on GST payments: reverse-charge tax is paid in cash.',
    where: 'Tax. Needs the reports permission and a GST registration; issuing a self-invoice needs accounts.manage and is audited. Reverse charge is ticked on the bill itself (Purchases → Bills). The category list is a guide matched by HSN/SAC; the notifications decide. No AI model is used.',
  },
  'tax/reverse-charge/[id]': {
    what: 'The self-invoice for one reverse-charge bill from a supplier who is not registered: you, the recipient, issue the tax invoice (CGST Act s.31(3)(f)), with your GSTIN, the supplier, place of supply, HSN/SAC, taxable value and tax by head, marked tax payable on reverse charge.',
    how: 'Choose the date and issue it within 30 days of receiving the supply (rule 47A). The number comes from its own series for the financial year (RCM/2026-27/0001) and cannot be changed. Print the page for your records.',
    where: 'Tax → Reverse charge. Issuing needs accounts.manage and is audited. Not needed when the supplier is registered: their own invoice is the document. The payment voucher (s.31(3)(g)) is not produced yet.',
  },
  'tax/gst-payments': {
    what: 'Settling a month\'s GST: the tax payable and input tax credit in your books, the credit set off in the order the CGST Act requires, and the cash paid by PMT-06 challan.',
    how: 'Choose the month, check the set-off, pay the cash on the GST portal, then record the payment with the CPIN and CIN. Interest and late fee go to an expense account you choose.',
    where: 'Tax. Reads the six GST accounts from GST settings at the end of the month; recording posts one journal (output tax debited, credit used and the bank credited). Months are settled in order; only the latest payment can be voided. Cess is not handled.',
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
    what: 'The tax rates you can choose on lines, such as GST 18%, with the percentage in force today and any change scheduled.',
    how: 'Add a rate with its percentage and accounts. Open a rate\'s history to schedule a change from a date. Deactivate rates you no longer use.',
    where: 'Tax. Used on quotations, orders, contracts, invoices and bills.',
  },
  'settings/tax-rates/[id]': {
    what: 'Every percentage one tax rate has had and will have: the rate as created, each later version with the date it took effect and why, and changes withdrawn before they took effect. Invoices and bills use the rate in force on their issue date, and expense claim lines the rate on the line\'s date, so a change never alters what is already recorded.',
    how: 'To change the rate, enter the new percentage, the date it takes effect and the notification or reason, and schedule it. Changes are added in date order; one cannot reach back past posted documents or approved claims that use the rate. Withdraw a scheduled change, with a reason, any time before it takes effect.',
    where: 'Settings → Tax rates → History. Scheduling and withdrawing need the accounts permission and are kept in the audit trail. Nil-rated, exempt and non-GST rates stay at 0%.',
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
  controls: {
    what: 'The internal controls register: each check that keeps the books right, such as monthly bank reconciliations or locking closed months, with its owner, how often it runs and whether it passed for the last period.',
    how: 'Add controls from the library or write your own, and give each an owner. After each period ends, someone other than the owner opens the control and records a test. Library controls marked as checked against the books are tested from the books for you.',
    where: 'Governance. Reading and testing need the audit trail permission; adding and changing controls needs an owner or admin.',
  },
  'controls/[id]': {
    what: 'One control: test it for a period, see every test recorded with its evidence, and change its owner, frequency or wording.',
    how: 'Pick the period (such as 2026-10). For an automatic check, run it to see the exceptions, fix them if you can, then record the test; the result and evidence come from the books. For a manual control, say whether it worked and what you checked.',
    where: 'Controls register. Tests are kept as recorded and listed in the audit trail.',
  },
  'audit-findings': {
    what: 'Audit findings: problems found by a failed control test, a review or day to day, each with a remediation owner, a plan, a severity and a due date.',
    how: 'Raise a finding here, or from a failed test on a control. The remediation owner records progress until it is ready for review; then an approver, owner or admin who was not fixing it closes it. A finding from a failed control test closes only after a later test of that control passes.',
    where: 'Governance. Reading and raising need the audit trail permission; closing needs the approvals permission.',
  },
  'audit-findings/[id]': {
    what: 'One finding: what was found, the plan to fix it, and every update in order.',
    how: 'The remediation owner moves it to in progress or ready for review, saying what was done. Someone else closes it once the fix is checked. Closed findings are kept as they were closed.',
    where: 'Audit findings.',
  },
  'audit-samples': {
    what: 'Audit samples: transactions picked from a period\'s posted journals, bills, invoices or supplier payments for you to test, by random, monetary unit or high-value selection.',
    how: 'Name the sample, pick the population, the dates, how many items and the method. For high value, give the threshold: every item at or above it is tested, and the rest are picked at random. Each sample keeps its seed, so anyone can draw it again from the books and get the same items.',
    where: 'Governance. Drawing and testing need the audit trail permission. Nothing here changes the books.',
  },
  'audit-samples/[id]': {
    what: 'One audit sample: the items picked, why each was picked, and the result of testing each.',
    how: 'Open each item, check it against its documents, then record no exception or an exception with what you found. Each result is kept as recorded; the sample completes when every item is tested. If the books in the range change later, the page says so.',
    where: 'Audit samples. Every draw and result is in the audit trail.',
  },
  'audit-engagements': {
    what: 'Internal audits: each engagement has a scope, a lead who runs the work with the team, a reviewer who signs it off, and a work programme of steps.',
    how: 'Name the engagement, say what it sets out to check, give the dates it covers, and pick the lead and a reviewer who can approve (not the lead). Then open it to plan the steps.',
    where: 'Governance. Needs the audit trail permission. Nothing here changes the books.',
  },
  'audit-engagements/[id]': {
    what: 'One internal audit: its work programme, the samples and findings it uses, its sign-off and every change in order.',
    how: 'The lead adds steps and assigns them, links samples and findings, and starts fieldwork. Each person records the work done on their steps. Once every step is done and linked samples are tested, the lead sends it for review. The reviewer signs off each step or sends it back, and closes the audit with the conclusion. A closed engagement is kept as it was closed.',
    where: 'Internal audit. Every change is in the audit trail.',
  },
  'audit-evidence': {
    what: 'Evidence internal audits have asked for: what, from whom, by when, and whether it was submitted and accepted.',
    how: 'Open a request to attach the files and submit them. Choose Waiting for me to see what you have been asked for. The audit lead asks for evidence from the engagement page.',
    where: 'Governance. Needs the audit trail permission.',
  },
  'audit-evidence/[id]': {
    what: 'One evidence request: what is asked for, the files, and who submitted and accepted them.',
    how: 'The person asked (or the audit lead) attaches the files and submits them. The lead or reviewer, never whoever submitted, accepts the evidence or returns it with what is missing. Files can change only while the evidence is requested; accepted evidence is kept exactly as accepted, with each file\'s SHA-256.',
    where: 'Audit evidence and the internal audit it belongs to. Every step is in the audit trail, with the files attached at the time.',
  },
  'ledger-replay': {
    what: 'The books exactly as they were recorded at a past moment, beside the books now for the same dates, with every entry posted since that explains the difference.',
    how: 'Pick the moment (your local time) and the last date to include, then replay. Posted entries are never changed, so the replay shows what anyone could have seen then; back-dated entries, reversals and corrections posted later show as the difference.',
    where: 'Governance. Needs the audit trail permission. Each replay is kept in the audit trail; nothing here changes the books.',
  },
  'segregation-of-duties': {
    what: 'Places where one person did two jobs that should be split: a journal written and posted by the same person, a bill entered and posted by them, a payment batch they prepared and approved, a vendor paid by whoever changed the vendor\'s bank details, or a bank reconciled by whoever recorded its payments. It also shows which members\' roles let them do conflicting jobs together.',
    how: 'Pick the dates (up to 400 days; the last 90 by default). Open each record, then clear the finding with what you checked. Only an approver, owner or admin who was not involved can clear one, and each review is kept in the audit trail.',
    where: 'Governance. Reading needs the audit trail permission. Nothing here changes the books.',
  },
  audit: {
    what: 'Every change made in the organisation: who did what, and when.',
    how: 'Filter by person, action or date. Entries can never be changed or deleted.',
    where: 'Governance. Used for audits and to answer "who changed this?".',
  },
  'settings/sso': {
    what: 'Single sign-on: your team signs in with your organisation\'s identity provider (OpenID Connect) instead of a Talk2Tax password.',
    how: 'Register Talk2Tax in your provider with the redirect URI shown, then enter the issuer URL, client ID and secret. Add your email domain and publish the TXT record shown to prove it, then choose Verify. Optionally let new people join with a role, and require single sign-on for members.',
    where: 'Governance. Every change, sign-in and refused sign-in is in the audit trail. Owners can always sign in with their password, so a broken provider never locks you out.',
  },
  'settings/access-rules': {
    what: 'Access rules: on top of their role, limit where and when some roles or people can open the books, or change anything in them: from your office networks, on working days, within working hours.',
    how: 'Owners and admins add a rule, choose the roles or people it binds, and give networks (IP addresses or ranges), days and hours in the organisation\'s time zone. A rule that would lock you out is refused; owners are never bound.',
    where: 'Governance. A refused request says which rule refused it, and every change to a rule is in the audit trail.',
  },
  'settings/retention': {
    what: 'How long your data is kept: records the law requires (never deleted on a schedule) and working data such as copilot conversations, kept until you choose a period.',
    how: 'Owners and admins choose Keep or Delete after a number of days for each kind of working data. Anything older is deleted each day; Apply now runs it straight away.',
    where: 'Governance. Each run that deleted something is listed, and every change is in the audit trail.',
  },
  'settings/communication': {
    what: 'What Talk2Tax may email to your customers and vendors: whether automations may email them at all, and every contact who opted out of email.',
    how: 'Owners and admins choose whether automations may email contacts. Record an opt-out, or that a contact wants email again, on the customer\'s or vendor\'s page, with the reason. A contact who opted out is never emailed, and an AI-drafted reminder goes only after a person approves it.',
    where: 'Governance. Each email that was refused, and every change to the policy or to a contact\'s consent, is in the audit trail.',
  },
  'ai-control': {
    what: 'Controls for every AI feature: which agents run, their limits, and a stop switch.',
    how: 'Turn agents on or off, set their limits, and stop all AI at once if needed.',
    where: 'Governance. Applies to the copilot, collections, bank suggestions and other AI features.',
  },
  'ai-activity': {
    what: 'A log of everything the AI did: questions, drafts, suggestions and who approved them, and below it the decision record of every AI call: the agent, who it acted for, the versions of its instructions and tools, the data it was given, when it ran and its own short explanation.',
    how: 'Filter the calls by feature and the decision records by agent, and open an entry to see what it worked on. The model\'s hidden reasoning is never kept, and copilot answers stay private to the member who asked.',
    where: 'Governance. Reading needs the audit trail permission. Decision records cannot be changed or deleted.',
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
    how: 'Check each meter; near a limit, consider upgrading, or buy extra AI requests that are used once the plan\'s run out.',
    where: 'Governance. Limits come from your plan.',
  },
  'settings/integrations': {
    what: 'Connections to outside services, set up here in the app: the AI, email, and your external CRM through API keys and webhooks.',
    how: 'Enter the keys for a service, test the connection, and save. Keys are stored encrypted. For a CRM, make an API key for calls into Talk2Tax and add a webhook for events going out.',
    where: 'Governance. Used by the copilot, emails, automations and any system connected to the CRM.',
  },
  'settings/approvals': {
    what: 'Rules that send documents for approval before they post.',
    how: 'Add a rule for a document kind above an amount, and choose who approves. Set a second approval amount to need two different approvers above it, and choose whether the second must be an owner or admin.',
    where: 'Governance. Requests appear in Approvals. The approval levels a request needs are fixed when it is submitted.',
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
  login: {
    what: 'Sign in to Talk2Tax.',
    how: 'Enter your email and password. If you turned on two-step sign-in, type the 6-digit code from your authenticator app next, or one of your recovery codes if you do not have your phone.',
    where: 'The start of every session. Two-step sign-in is turned on under Account and preferences.',
  },
  'login/sso': {
    what: 'Sign in with your organisation\'s identity provider (Microsoft, Google, Okta or another OpenID Connect provider) instead of a Talk2Tax password.',
    how: 'Enter your work email and choose Continue. You sign in on your provider\'s page and come back signed in to your organisation.',
    where: 'Works once an owner or admin of your organisation has connected the provider and verified your email\'s domain under Single sign-on.',
  },
  register: { what: 'Create your Talk2Tax account.', how: 'Enter your name, email and a long password.', where: 'After this you create or join an organisation.' },
  onboarding: { what: 'Set up your organisation.', how: 'Enter its name, country and currency; the books are created for you.', where: 'Once, before you start.' },
  'invite/[id]': { what: 'An invitation to join an organisation.', how: 'Sign in or create an account, then accept.', where: 'After accepting, the organisation appears in your list.' },
  'portal/[id]': { what: 'The customer portal: what a customer sees when they open the private link you sent them. Their balance, invoices, payments received and statement, with invoices to open or print and a Pay button where there is a payment link.', how: 'Make the link on the customer\'s page under Customer portal and send it to them. Revoke it there if it reaches the wrong person.', where: 'Open to anyone with the link, without signing in. Read-only: nothing here changes the books.' },
  'auditor-portal/[id]': { what: 'The external auditor portal: what an auditor sees when they open the private link you gave them for one internal audit. The scope, the work done and signed off, the conclusion, accepted evidence with each file\'s SHA-256, findings, samples and the trial balance at the end of the scope.', how: 'An owner or admin makes the link on the engagement under External auditor access, for 7, 30 or 90 days. Withdraw it there if it reaches the wrong person. Each file the auditor opens is recorded.', where: 'Open to anyone with the link, without signing in. Read-only: nothing here changes the books, and evidence not yet accepted is never shown.' },
  'vendor-portal/[id]': { what: 'The vendor portal: what a vendor sees when they open the private link you sent them. What they are owed, their invoices as recorded and when they fall due, payments made with the bank reference, open purchase orders and their statement.', how: 'Make the link on the vendor\'s page under Vendor portal and send it to them. They can send an invoice with its file; it waits under Purchases → Vendor invoices. Revoke the link if it reaches the wrong person.', where: 'Open to anyone with the link, without signing in. Nothing a vendor sends posts to the books, and bank details cannot be changed here.' },
  paid: { what: 'Where a customer lands after paying a payment link: a thank-you with the link reference.', how: 'Nothing to do here. The invoice is marked paid from the gateway\'s own signed notice, not from this page.', where: 'Open to anyone; it shows nothing from the books.' },
  // ---------------------------------------------------------------- platform administration
  admin: {
    what: 'Platform administration: organisations, people, plans, payments, support and system health.',
    how: 'Pick an area from the menu. Every action here is logged.',
    where: 'Only for platform staff; organisations never see these pages.',
  },
  'admin/organisations': { what: 'Every organisation on the platform.', how: 'Search, open one to see its plan, usage and status, and suspend it if needed.', where: 'Platform administration.' },
  'admin/people': { what: 'Every user on the platform.', how: 'Search for a person and see their organisations and platform role.', where: 'Platform administration.' },
  'admin/plans': { what: 'The plans organisations can subscribe to.', how: 'Change prices, limits and included modules, price add-on modules, and offer packs of extra AI requests.', where: 'Platform administration. Used by Subscription and Usage.' },
  'admin/subscriptions': { what: 'Every organisation\'s subscription and its state.', how: 'Find a subscription and see its history.', where: 'Platform administration.' },
  'admin/invoices': { what: 'Invoices the platform issued for subscriptions.', how: 'Search and open one to see its payments.', where: 'Platform administration.' },
  'admin/contracts': { what: 'Enterprise contracts: a plan agreed with one organisation for a term, at its own price and limits.', how: 'Record a contract with its reference, plan, billing, price, term and any limits that differ from the plan. End one early with a reason; the terms themselves never change.', where: 'Platform administration. The organisation sees it under Settings → Subscription, and its renewals under Invoices.' },
  'admin/coupons': { what: 'Coupons that take money off subscription payments.', how: 'Create a coupon with its terms, see which organisations use it and what it has taken off, and switch it off when the offer ends.', where: 'Platform administration. Organisations enter the code under Settings → Subscription.' },
  'admin/payments': { what: 'Payment gateways and payments received.', how: 'Set up a gateway and check payments and webhook notices.', where: 'Platform administration.' },
  'admin/support': { what: 'Support tickets from organisations.', how: 'Pick up a ticket, reply, and close it when solved.', where: 'Platform administration.' },
  'admin/usage': { what: 'Usage across organisations.', how: 'See who is near their limits.', where: 'Platform administration.' },
  'admin/flags': { what: 'Feature flags.', how: 'Turn a feature on or off for everyone or for one organisation.', where: 'Platform administration.' },
  'admin/ai': { what: 'The platform-wide AI emergency shutdown: stops every organisation\'s AI agents at once.', how: 'Give a reason and stop AI for everyone; turn it back on with a reason when the incident is over. Each change is kept in the history.', where: 'Platform administration. Organisations see the reason in their AI control center and in every refusal.' },
  'admin/file-scanning': { what: 'How uploaded files are checked: whether the virus scanner is working, how many files were accepted and refused, and the latest refused files.', how: 'Set CLAMAV_URL on the API to a ClamAV daemon to scan every upload. While it is set but not answering, uploads are refused. PDFs with scripts or embedded files are refused either way.', where: 'Platform administration. Each refusal is also in the organisation\'s audit trail.' },
  'admin/backups': { what: 'Encrypted backups of the whole database, checks that a backup file is whole, and restore drills that bring a backup back into a scratch database and count every collection.', how: 'The backup command runs on your servers on a schedule (node dist/db/backup.js create, verify, drill) and records each run here. Overdue backups (BACKUP_MAX_AGE_HOURS) and drills (RESTORE_DRILL_MAX_AGE_DAYS) are shown here and in System health.', where: 'Platform administration. Recovery steps are in docs/DISASTER_RECOVERY.md.' },
  'admin/security': { what: 'Security events from the audit trail across Talk2Tax, and alerts raised from them: many lockouts in an hour, failed two-step codes after a right password, platform role changes, an administrator turning two-step off, infected uploads and repeated single sign-on refusals.', how: 'The audit trail is checked every few minutes (SECURITY_MONITOR_INTERVAL_SECONDS), or now with Check now. Each new alert is emailed once to every super admin. Acknowledge an alert with a note once it has been looked at.', where: 'Platform administration. Alerts and their acknowledgement are kept and audited.' },
  'admin/encryption-keys': { what: 'Which key encrypts each kind of secret stored in the app, and re-encryption with the current key.', how: 'After setting a new key and listing the old one as previous, re-encrypt here; remove the old key when nothing is left under it.', where: 'Platform administration. Keys themselves are set in the server configuration, never in the app.' },
  'admin/maintenance': { what: 'Maintenance windows.', how: 'Schedule a window; a banner warns users beforehand.', where: 'Platform administration.' },
  'admin/announcements': { what: 'Announcements shown to users.', how: 'Write one, choose who sees it and for how long.', where: 'Platform administration.' },
  'admin/errors': { what: 'Errors the platform caught, grouped.', how: 'Open a group to see occurrences and mark it resolved.', where: 'Platform administration.' },
  'admin/system': { what: 'System health: API, database and background runners.', how: 'Check each part is up and runners are on time.', where: 'Platform administration.' },
};
