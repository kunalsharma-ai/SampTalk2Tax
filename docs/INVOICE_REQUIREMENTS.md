# Invoice requirements and e-invoicing (TAX-039, TAX-040)

Tax → Invoice requirements (`/orgs/:orgId/tax/invoice-requirements`) shows what a sales invoice must carry in the
organisation's country, checks its invoices and credit notes against that rule, and says when the country requires
e-invoices.

## Rules

`packages/tax-engine/src/invoice-rules.ts` holds the rules, each with its source and the date it was last checked:

| Country | Invoice rule | Simplified or stepped invoices | E-invoicing |
| --- | --- | --- | --- |
| India | CGST Rules, rule 46 | Customer address required for unregistered sales of Rs 50,000 or more | IRN above Rs 5 crore turnover (in force) |
| United Kingdom | VAT Notice 700/21 | Simplified up to £250 | Announced for April 2029 |
| Germany | UStG §14, UStDV §33 | Kleinbetragsrechnung up to €250 | Receive from 2025; issue from 2027 above €800,000, everyone from 2028 |
| UAE | Executive Regulation Art. 59 | Simplified for unregistered customers or up to AED 10,000 | Pilot July 2026; AED 50m+ from Jan 2027; others July 2027 |
| Singapore | GST (General) Regulations reg. 11 | Simplified up to S$1,000 | InvoiceNow for new voluntary registrants |
| Australia | GST Act s29-70 | None up to A$82.50; buyer identity from A$1,000 | Not required |
| Canada | ITC Information Regulations | Steps at $30 and $150 | Not required |

Other countries are not covered (TAX-042) and the page says so. Nothing is sent to any portal or network (TAX-027).

## API

- `GET /v1/orgs/:orgId/invoice-requirements[?turnover=]`: the rule, the seller's number and address, the e-invoicing
  outlook with turnover from completed years in the books (or the figure given), and the other countries.
- `GET /v1/orgs/:orgId/invoice-requirements/check?from&to`: invoices and credit notes (drafts included, at most 300)
  with their format and gaps. Default period: the last 90 days.
- `GET /v1/orgs/:orgId/invoice-requirements/documents/:id`: one document.

All need `sales.read`; nothing is stored.

## Printing

Invoices outside India now print the VAT or GST number from the return settings, and an invoice in another currency
prints the tax in the books' currency with the exchange rate (`totals.localTax` placeholder for HTML templates).
