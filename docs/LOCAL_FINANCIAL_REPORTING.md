# Local financial reporting

**Reports → Statutory statements** shows the balance sheet and the profit and loss in the layout
a country's law or standard sets, with the same period a year earlier beside them. It is built
from posted journals with [`packages/accounting-engine/src/statutory.ts`](../packages/accounting-engine/src/statutory.ts).

These are presentation layouts of your books: a starting point for the accountant who prepares
the statutory accounts. They are not filings, they are not audited, and they have no notes.

## Layouts

| Layout | Used by default for | Basis |
|---|---|---|
| India: Schedule III (Division I) | India | Companies Act, 2013, Schedule III, Division I (Accounting Standards): balance sheet and statement of profit and loss |
| United Kingdom: Companies Act formats (FRS 102) | United Kingdom | SI 2008/410 Schedule 1, balance sheet Format 1 and profit and loss account Format 1 |
| IFRS: IAS 1 presentation | Every other country | IAS 1: statement of financial position (current and non-current) and profit or loss by function |

Any organisation can view any layout; the page marks one that is not its country's.

## How figures are placed

* Every account sits on exactly one line, chosen by its type and subtype (for example
  `ACCUMULATED_DEPRECIATION` on property, plant and equipment, `TAX_RECEIVABLE` on short-term
  loans and advances in Schedule III, or on debtors in the UK layout). Tests check that every
  subtype is placed once in every layout.
* Lines on the assets or expense side show debit balances as positive; liabilities, equity and
  income show credit balances as positive. So accumulated depreciation and drawings reduce
  their lines.
* Profit not yet closed to retained earnings is shown in equity (reserves and surplus, the profit
  and loss account, or retained earnings).
* An account without a subtype goes to its type's fallback line (for example other current
  assets) and is listed at the top of the page so it can be classified.
* Two checks are shown: the balance sheet balances, and the profit line equals the books' net
  profit for the period.
* Each line opens to the accounts behind it, and each account links to its general ledger.
* The comparative column uses the same dates a year earlier (29 February becomes 28 February).

## API

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /v1/orgs/:orgId/reports/statutory/formats` | reports.read | The layouts and `default` for the organisation's country |
| `GET /v1/orgs/:orgId/reports/statutory?from=&to=&format=&comparative=` | reports.read | Balance sheet at `to`, profit and loss for `from`..`to`; `format` defaults to the country's; `comparative=false` leaves out the year before. Rows: `key`, `label`, `kind` (HEADING, LINE, TOTAL), `level`, `note`, `amount`, `previous`, `accounts`. Also `checks` and `unclassified` |

## Tests

* Engine (`test/statutory.test.ts`): every subtype placed once per statement, totals only refer
  to earlier rows, fallbacks are lines, country defaults, Schedule III and UK figures on a set of
  books (including drawings, accumulated depreciation and an account without a subtype), losses
  and profit from earlier periods.
* API (`test/statutory-statements.e2e.test.ts`): agreement with the plain balance sheet and
  profit and loss, the accounts behind a line, the year before, another layout, unclassified
  accounts, validation and permissions.
* Browser (`e2e/statutory-statements-flow.test.mjs`): Schedule III for a new company, opening a
  line, the unclassified warning and switching to IAS 1.

## Not built

* Notes to the accounts, accounting policies, the cash flow statement, the statement of changes
  in equity, directors' reports and earnings per share.
* Ind AS (Schedule III Division II), US GAAP, and any framework-specific recognition or
  measurement: one ledger, different layouts.
* The current and non-current split of a loan's next twelve months, ageing schedules, the MSME
  split of trade payables, intangible assets and investments as separate lines.
* Rounding to thousands, lakhs or crores, and export to Excel or PDF (use Print).
* Filing: MCA AOC-4 XBRL, Companies House or HMRC iXBRL.
