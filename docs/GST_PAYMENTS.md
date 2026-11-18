# GST payments and set-off (TAX-022)

The **GST payments** page (Tax → GST payments) settles a GST return month from the books.

## What it works out

For the chosen month (YYYY-MM):

* **Tax payable** per head: the credit balance of the output IGST, CGST and SGST accounts (from GST settings) at the end of the month.
* **Credit available** per head: the debit balance of the input IGST, CGST and SGST accounts at the end of the month, so credit carried forward from earlier months counts.
* Payments already recorded for this or an earlier month but dated after its end are taken off both, so a settled month shows nothing to pay.
* **Reverse charge.** Tax on the month's reverse-charge bills (GSTR-3B 3.1(d)) can only be paid in cash (CGST Act s.49(4)). It is kept out of the set-off and added to the cash.
* **Set-off** uses the existing `setOffItc` in `packages/tax-engine/src/india/returns.ts`, the same one GSTR-3B 6.1 uses (s.49(5), s.49A, rule 88A):
  * IGST credit goes first, against IGST and then against CGST and SGST.
  * CGST credit pays CGST, then IGST.
  * SGST credit pays SGST, then IGST.
  * `gstSetOff` in `packages/tax-engine/src/india/gst-setoff.ts` wraps it for the books.
* **Cash to pay** per head, and the credit carried forward.

## Recording a payment

`POST /v1/orgs/:orgId/gst/payments` with `period`, `paymentDate` (after the month, not in the future), and, when there is cash to pay, `bankAccountId` and `cin` (the bank's challan identification number). `cpin` (14 characters) is optional. Optional `interest` and `lateFee` go to an expense account (`chargesAccountId`). Needs `journals.post`.

It posts one journal (source TAX, number GSTP-000001 and up):

| Line | Amount |
|---|---|
| Dr output IGST/CGST/SGST | tax settled for the head (credit plus cash) |
| Cr input IGST/CGST/SGST | credit used from the head |
| Dr interest and late fee account | interest plus late fee |
| Cr bank | cash plus interest plus late fee |

A month that credit covers in full needs no bank account or challan. The payment is kept in the `gst_payments` collection with the set-off it used.

## Rules

* **Months are settled in order.** A payment cannot be recorded for a month earlier than the latest one recorded (`OUT_OF_ORDER`, 409).
* **Only the latest payment can be voided** (`POST .../:id/void` with `date` and `reason`). Voiding posts the reversal and puts the month's tax and credit back.
* `NOTHING_TO_PAY` (422) when the month has no tax left.

## Compliance calendar

A month's GSTR-3B (and PMT-06 under QRMP) shows each GST payment for its months as evidence, with the cash paid. The return itself is still marked filed by hand.

## Not covered

* Cess.
* The electronic cash and credit ledgers as balances separate from the books.
* Interest worked out automatically.
* Quarterly (QRMP) fixed-sum payments.
