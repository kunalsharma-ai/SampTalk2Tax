# Relationship explorer and figure tracing

Two connected features: a relationship explorer that shows how any record is connected to the rest of the books, and figure tracing that takes a number on a report down to the record that created it.

**Reports → Relationship explorer** (`/orgs/:orgId/graph`).

## The relationship explorer

Search by name or number (at least two characters): customers and vendors, invoice, bill and note numbers, receipt and payment numbers, JE numbers, journal memos and references, account codes and names, department and project codes, loans and fixed assets. Picking a result puts it in the centre. Its connections are grouped by kind, and every connection has a sentence that says why it exists, with the amount and the date taken from the books. For example:

* *Invoice INV-000012 for ₹1,20,000.00 was issued to Acme Retail.*
* *RCPT-000004 settled ₹60,000.00 of Invoice INV-000012 on 30 Oct 2026.*
* *₹1,20,000.00 of its lines, before tax, is income in 4100 Sales Revenue.*
* *1 line (₹1,00,000.00) is tagged with project WH-AUTO.*
* *The alert "Acme Retail owes ₹50,000.00 more than 30 days overdue" lists it as evidence (open).*

"Explore" on a connection moves it to the centre, so you can walk from a customer to an invoice, to its journal entry, to an account, and on. "Open" goes to the record's own page.

| Centre | Connected to |
|---|---|
| Customer or vendor | Its invoices, bills and notes; its receipts and payments; the projects and departments its posted lines are tagged with; alerts that list it |
| Document | Its customer or vendor; the journal entry that posted it (and the one that voided it); receipts or payments that settled it; the accounts its lines are booked to; its projects and departments; alerts |
| Receipt or payment | Its contact; the documents it settles; the bank account; its journal entry; alerts |
| Journal entry | The record that created it (document, payment, claim, payroll, asset, loan, deferral, accrual, close adjustment, intercompany charge); the entry it reverses or that reverses it; every account it debits or credits; projects and departments |
| Account | The latest journal entries posting to it; loans and assets that use it |
| Project or department | The customers and vendors whose documents are tagged; those documents; tagged manual journal lines |
| Loan or fixed asset | The accounts it uses; its disbursement, repayment, purchase, depreciation and disposal entries |
| Alert | The records it lists as evidence |

Each kind of connection shows at most 25 records, and says how many more there are.

The graph is not a separate store. Every connection is read from the books when it is asked for (`apps/api/src/graph/graph.service.ts`), so it can never be out of date and nothing extra has to be kept in step.

## Tracing a figure

* Trial balance, profit and loss and balance sheet lines open the general ledger for that account and the same dates. (A profit and loss filtered by department or project is not linked, because the ledger shows the whole account.)
* Each general ledger line has a **Source** column: what created the line (*posts INV-000012*, *voids BILL-000003*, *records the purchase of FA-0002 Delivery van*, *reverses JE-000041*), linked to that record, or *Manual journal*.
* **Connections** on each line opens the relationship explorer at the source record, or at the journal entry for a manual journal.

So any figure on a report can be followed: report line → ledger line → source document or transaction → everything connected to it.

## API

| Endpoint | Permission | |
|---|---|---|
| `GET /v1/orgs/:orgId/graph/search?q=` | `reports.read`, plus `sales.read` and `purchases.read` | Up to 8 records of each kind (5 loans, 5 assets) matching a name or number; fewer than two characters returns nothing |
| `GET /v1/orgs/:orgId/graph/nodes/:type/:id` | as above | The record and its connections: `{ node, edges: [{ relation, explanation, node }], more: [{ relation, count }] }`. `type` is one of `CONTACT`, `DOCUMENT`, `PAYMENT`, `JOURNAL`, `ACCOUNT`, `PROJECT`, `DEPARTMENT`, `LOAN`, `ASSET`, `ALERT` (anything else is 400); a record that does not exist in the organisation is 404 |
| `GET /v1/orgs/:orgId/reports/general-ledger` | `reports.read` | Each row now has `source: { type, id, label, path, role } \| null` |

## Security

Reading the graph shows customers, vendors and both ledgers together, so it needs `reports.read` and both `sales.read` and `purchases.read` (employees and roles without both ledgers get 403). Every query is scoped to the organisation and runs under row-level security; another organisation's ids return 404. The explorer only reads; it changes nothing.

## Tests

* `apps/api/test/graph.e2e.test.ts` (8): search, the explanations for a customer, invoice, receipt, journal, account, project and alert, a manual journal with no source, permissions and tenant isolation, and the source of each general ledger line.
* `apps/web/e2e/knowledge-graph-flow.test.mjs`: finding a customer, walking to its invoice, and tracing a profit and loss line to the ledger, the invoice and back into the explorer.

## Limitations

* Contracts are not modelled in the product yet, so they are not in the graph. Risks appear as the alerts that list a record as evidence.
* Bank statement lines, budgets, scenarios, tax returns and e-invoices are not nodes yet.
* The explorer shows one record's neighbours at a time, as lists rather than a drawn network.
* An account shows only its latest 25 journal entries; the general ledger has the rest.
