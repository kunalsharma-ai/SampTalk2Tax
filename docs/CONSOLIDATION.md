# Group consolidation (M6, slice 7)

A parent organisation can report together with the companies it owns: one consolidated profit
and loss and balance sheet, with balances between group companies removed and companies in other
currencies translated. Each company keeps its own books as a separate organisation.

## Setting up a group

Reports → Group consolidation, in the parent organisation.

* **Group:** a name and a presentation currency (the parent's by default). The parent is always a
  member. Needs `org.manage` in the parent (owners and admins).
* **Companies:** you can add only organisations where you are an owner or admin. An organisation
  you do not belong to reads as not found, so ids cannot be probed. The parent cannot be removed,
  and a company cannot be removed while an elimination rule uses it.
* **Translation rates:** for a company keeping its books in another currency, enter rates for each
  period end you report on: closing, average and historical, as presentation currency per one unit
  of the company's currency. They are entered, not fetched from a market source.
* **Elimination rules:** pair one company's account with another's, for example:
  * the parent's "Due from group companies" with the subsidiary's "Due to group companies";
  * intercompany sales with intercompany purchases or fees;
  * the parent's investment with the subsidiary's share capital.

  Both accounts are checked against each company's own chart of accounts when the rule is saved.
  A rule can be turned off without deleting it.

Intercompany balances need their own accounts. Receivable and payable control accounts (1200,
2100) mix group and outside customers and cannot be split, so book intercompany amounts to
dedicated accounts. Manual journals can post to them.

## The consolidation

`GET /v1/orgs/:orgId/consolidation/groups/:groupId/report?from&to` needs `reports.read` in the
parent **and in every member**. If any member is missing, the response is 403 with one issue per
company, and companies the user does not belong to are not named.

Each member's balances come from the same trial balance service as its own reports, read inside
that member's tenant context, so row-level security applies exactly as on the member's own pages.

Method (`packages/accounting-engine/src/consolidation.ts`, `consolidate`):

1. **Balances.** Balance sheet accounts at the end date and revenue and expense accounts for the
   period, as signed net debits. Revenue and expenses before the period that are not yet closed
   to retained earnings become "Earnings brought forward".
2. **Translation (IAS 21 style).** Assets and liabilities at the closing rate, revenue and
   expenses at the average rate, equity and earnings brought forward at the historical rate. The
   difference goes to the "Foreign currency translation reserve" in equity. A company in another
   currency without rates for the end date blocks the report with a message naming it.
3. **Eliminations.** For each active rule, both translated balances are removed. If they do not
   cancel, the difference stays in "Intercompany differences to resolve", so the worksheet still
   balances and the mismatch is visible until the books are corrected.
4. **Combining.** Accounts are added up by account code. Every worksheet column sums to zero.
5. **Statements.** The consolidated profit and loss and balance sheet come from the consolidated
   column. Fully eliminated lines stay on the worksheet but drop off the statements.

The page shows four tabs:

* **Worksheet:** one column per company, plus eliminations and consolidated.
* **Profit and loss.**
* **Balance sheet.**
* **Companies, rates and rules.**

It also shows the status of each elimination and a translation summary.

`GET …/export/worksheet|income-statement|balance-sheet?from&to&format=csv|xlsx|pdf` downloads
the file with the report-export writers (see [`REPORT_EXPORTS.md`](REPORT_EXPORTS.md)). Each
download is audited as `report.exported` with the file's SHA-256.

## Data and security

* **Tables:** `consolidation_groups`, `consolidation_members`, `consolidation_rates` and
  `elimination_rules`. Each carries the parent's `org_id`, with forced row-level security.
* **Constraints:** rates and rules reference `(group_id, member_org_id)`, so they can only name
  members. Removing a member removes its rates, and is refused while a rule uses it. Rates must be
  positive, and a rule cannot pair an account with itself.
* **Audit:** every change is audited:
  * `consolidation_group.created`, `.updated`, `.deleted`, `.member_added`, `.member_removed`,
    `.rates_set`, `.rates_deleted`;
  * `elimination_rule.created`, `.updated`, `.deleted`.

## Tests

* **Engine** (`packages/accounting-engine/test/consolidation.test.ts`, 7): combining by code,
  eliminations of current accounts, sales and the investment, mismatches, missing accounts,
  translation with the reserve, earnings brought forward at the historical rate, and refusals.
* **API** (`apps/api/test/consolidation.e2e.test.ts`, 9): creating groups, member rules (owner or
  admin only, outsiders 404), rates for a USD member, rules checked against each member,
  translated and eliminated figures, a mismatch, report access in every member, exports with the
  audit, removing members and deleting the group.
* **Browser** (`apps/web/e2e/consolidation-flow.test.mjs`): sets up a group and a rule on screen,
  checks the worksheet, statements and a difference, and exports the worksheet.

## Limitations

* **Full consolidation only.** Every member is treated as 100% owned. There are no
  non-controlling interests (ENT-010), associates or equity accounting. An investment that
  differs from the subsidiary's capital (goodwill) shows as an intercompany difference.
* **Combining by code.** Accounts are combined by account code, with no mapping between
  different charts of accounts.
* **Intercompany transactions.** They are booked by hand in each company. There are no mirrored
  intercompany invoices yet (ENT-008), and no unrealised profit in stock.
* **Rates.** Translation uses one historical rate per member and period end, not per equity
  movement. Rates are entered by hand.
