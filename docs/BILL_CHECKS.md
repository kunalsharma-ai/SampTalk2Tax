# Unusual bill checks (AP-031)

Each vendor bill is compared with the same vendor's earlier posted bills and the vendor's bank
details, so a person looks at the odd ones before paying. The checks are rule-based: every
finding says what was compared and with which bill. Nothing here blocks a bill.

**Purchases → Unusual bills** (`GET /v1/orgs/:orgId/purchases/bill-checks`) lists draft and
posted bills dated in the last 120 days with a finding worth a look. Each bill's page has an
**Unusual bill checks** card (`GET …/bill-checks/:documentId`). `purchases.read` sees them;
`purchases.manage` marks a bill reviewed (`POST …/bill-checks/:documentId/review` with a note).

## Findings

| Code | Level | When |
| --- | --- | --- |
| `SAME_VENDOR_REFERENCE` | Check first | The vendor invoice number matches another bill from the vendor once spaces, punctuation and case are ignored (`pm 2` and `PM-2`). The exact same number is already refused when posting. |
| `BANK_DETAILS_CHANGED` | Check first | The vendor's bank details changed within 30 days before the bill date, after it, or in the last 30 days. |
| `AMOUNT_ABOVE_USUAL` | Worth a look | The total is 3 times or more the median of the vendor's earlier bills (at least 3 of them). |
| `PRICE_JUMP` | Worth a look | A line's unit price is 25% or more above the last earlier bill with the same item description. |
| `BANK_DETAILS_UNVERIFIED` | Worth a look | The vendor has bank details nobody verified. |
| `DATED_AHEAD` | Worth a look | The bill date is after today. |
| `NEW_ACCOUNT` | For information | A line uses an account none of the vendor's earlier bills (at least 3) used. |
| `FIRST_BILL` | For information | No earlier posted bill from the vendor. |
| `OLD_BILL` | For information | Dated more than 180 days ago. |
| `ROUND_AMOUNT` | For information | A round total (a multiple of 1,000, 10,000 or more) with no tax. |

Only bills dated on or before the bill count as earlier. Amounts are compared in the functional
currency (total and unit price times the bill's exchange rate). Bills with only for-information
findings show them on the bill but stay off the list.

## Reviews

A review records the note, who and when, and the set of findings it covered. If the findings
change (a new bill, the bank details changed or verified), the old review no longer covers the
bill and it comes back on the list. Reviews are kept as written (MongoDB collection
`bill_check_reviews`, guards refuse edits and deletes) and audited as `bill_check.reviewed`.

Rules: `packages/accounting-engine/src/bill-checks.ts` (`checkBill`, `BILL_CHECK_DEFAULTS`).

## Not yet

* Thresholds per organisation (the defaults are fixed for now), checks on vendor invoices before
  they become bills, and an AI explanation of the findings.
