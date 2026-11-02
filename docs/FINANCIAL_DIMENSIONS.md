# Departments and projects (financial dimensions)

Milestone 6, slice 3. Two dimensions that tag the lines of journals, invoices, credit notes, bills and vendor credits, so the profit and loss can be read for each:

* **Departments**: the parts of the business that earn and spend (Sales, Operations, People). A department is also the cost centre: expenses tagged to it are its costs.
* **Projects**: a job, contract or initiative whose revenue and cost should be seen together. A project can carry a customer and start and end dates.

A line can carry one department and one project, both optional. Lines without a tag still count; reports show them under **Not assigned**, so every split adds up to the whole profit and loss.

## Departments and projects

Accounting → **Departments and projects**. Each value has:

| Field | Rules |
| --- | --- |
| Code | 1 to 20 letters, digits, `-` and `_`, starting with a letter or digit; stored in capitals. Unique per organisation and kind, so a department and a project can share a code (`DIMENSION_CODE_TAKEN` otherwise). |
| Name | Required, up to 120 characters |
| Description | Optional |
| Customer, starts, ends | Projects only (`Only projects have a customer and dates`); a project cannot end before it starts |
| Active | New lines can only use active values. Making one inactive keeps every line already tagged, and the reports still show it |

Values are never deleted, and a value keeps its organisation, kind and creator (database trigger). Owners, admins and accountants (`accounts.manage`) add and change them; everyone who can read journals sees them, with how many lines use each.

## Tagging lines

When an organisation has departments or projects, the journal form and the invoice and bill forms show a department and a project picker under each line's account. Books that use neither see no extra fields.

* The API checks each tag before saving: the value must exist in the same organisation, be the right kind, and be active (`INVALID_DIMENSION` for journals, `DOCUMENT_INVALID` for documents, with messages such as `Line 1: department not found` or `Line 1: department HR is inactive`).
* A database trigger on `journal_lines` and `document_lines` refuses a department that is not a department or a project that is not a project, and composite foreign keys keep tags inside the organisation.
* A document's line tags are carried to the revenue or expense line of its journal when it is posted. Tax, receivable and payable lines are not tagged.
* A reversal keeps the original tags, even when a value has since been made inactive, so a reversal always nets out in the same column.
* Journal and document pages show the tags on each line.

## Reports

**Reports → Profit by department** (`/reports/profit-by-dimension`): revenue and expense accounts as rows, one column per department (or per project) in code order, then **Not assigned** and the total. It shows each section's totals, the net profit per column and the margin (net profit as a share of revenue, one decimal place; blank where there is no revenue). Accounts that net to zero in the period are left out. Inactive values are shown when they have activity in the period, or all of them with "Show inactive ones with nothing posted".

The **Profit and loss** page can be filtered to one department, one project or both. The API takes `departmentId` and `projectId` on `GET …/reports/income-statement`.

Only posted journals count, by journal date, in the functional currency.

## API

| Route | Permission | |
| --- | --- | --- |
| `GET /v1/orgs/:orgId/dimensions?type=` | journals.read | Values with usage counts and whether the caller can manage them |
| `GET …/dimensions/profit?type=&from=&to=&includeInactive=` | reports.read | Profit and loss by department or project |
| `POST …/dimensions` | accounts.manage | Add a department or project |
| `PUT …/dimensions/:id` | accounts.manage | Change one, or make it inactive or active |

Journal and document lines take `departmentId` and `projectId` (uuid or null) and return them.

Audit events: `dimension.created`, `dimension.updated`.

## Not built yet

Budgets, the trial balance, the balance sheet and the general ledger are not split by dimension. There are no other dimensions (location, class, custom), no required-tag rules per account, no allocation of shared costs across departments, and no splitting of one line across several projects. Bank entries, expense claims, payroll, depreciation and deferral releases post without tags.
