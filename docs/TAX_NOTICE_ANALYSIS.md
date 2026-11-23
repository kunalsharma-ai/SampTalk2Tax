# Tax notice analysis (TAX-050)

Every tax notice entered in Talk2Tax (Tax → Notices) gets an analysis card on its page. It says what
kind of notice it is, what it usually asks for, by when, how to reply, what to gather, and for an
unpaid income-tax demand the interest building up.

## How a notice is recognised

- **By section or form.** The analysis reads the notice's authority and section. For example, GST
  `ASMT-10` or `s.61` is scrutiny of returns, and income tax `u/s 156` is a demand notice. The table
  lives in `packages/accounting-engine/src/tax-notice-analysis.ts`. Each entry names the provision it
  comes from (CGST Act, 2017 and Rules; Income-tax Act, 1961).
- **By the type chosen.** When the section is not one the table knows, the analysis does not guess. It
  says so, and an accountant can pick the type from the list for that authority.
- Authorities with no types in the table (PF, ESI and so on) show no analysis. The user can still keep
  the notice, its files and its reply.
- Notices issued under the Income-tax Act, 2025 use new section numbers, so they are not recognised by
  section. The user can choose the type instead.

## What it shows

- **Deadline.** The reply date entered on the notice wins. If no date is entered, the usual period from
  receipt is used, with a warning to enter the date printed on the notice.
- **Usual reply period, how to reply and the source** of each rule.
- **Checklist** of what to gather. Ticks are saved per notice (`tax_notice_analyses`) with who saved
  them last.
- **Interest** on an unpaid income-tax demand: 1% for each month or part of a month after the due date
  (s.220(2)), on the demand entered. This is an estimate; the department's own computation wins.
- **Related notices**: other notices from the same authority for the same period. If the notice has no
  period, the latest other notices from the same authority are shown.

## API

- `GET /v1/orgs/:orgId/tax-notices/:noticeId/analysis` needs `reports.read`.
- `PUT /v1/orgs/:orgId/tax-notices/:noticeId/analysis` with `{ chosenType, checked }` needs
  `accounts.manage`. A type the authority does not have, or a checklist key that is not on the list,
  gets a 422 with a list of issues. Every save is audited as `tax_notice.analysis_saved`.

## Not built

- Reading the notice PDF to find the section automatically.
- GST interest under s.50, and penalties.
- Section numbers of the Income-tax Act, 2025.
- Advice from a professional. The analysis is a starting point, not a legal opinion.
