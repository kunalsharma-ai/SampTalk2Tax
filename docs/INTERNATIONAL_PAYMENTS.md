# International payments (AP-023)

Payments to vendors abroad in their own currency (outward remittances). Talk2Tax prepares the
payment, works out the paperwork, keeps the approval trail and gives the bank a remittance
instruction. **It never moves money**: the bank makes the payment, and the payment is recorded
here once the bank confirms it, at the bank's rate.

Where: **Purchases → International payments** (list and "Prepare an international payment"), one
page per payment, and the **Bank details** card on each vendor's page.

## The vendor's bank abroad

On the vendor's page, **Bank details → Where is the bank? → Abroad (SWIFT/BIC)** takes:

- account holder, **IBAN or account number**, **SWIFT/BIC**, bank country (2 letters);
- a **routing code** where the country needs one: ABA (US, 9 digits with its checksum), transit
  and institution (CA), BSB (AU, NZ);
- optional intermediary SWIFT, bank name and address.

Checks: the SWIFT/BIC shape and that its country letters match the bank country; an IBAN's length
for its country and its mod-97 check digits; the ABA checksum. Like domestic details, any change
clears the verification (a database trigger enforces it), and a second person must verify the
details before a payment to them can be approved (the only approver in an organisation may verify
their own change). Domestic payment batches refuse a vendor whose details are abroad.

## Preparing a payment

Choose a vendor and currency (only **posted bills in a currency other than the organisation's**
with something left to pay appear), the bank account, the value date, the bills, and:

- **Purpose**: an RBI purpose code. A short list is offered (S0101, S0102, S0802, S1005, S1006,
  S1007, S1008, S1014); any other code of the form `S` or `P` plus four digits can be typed.
- **Charges**: OUR (we pay all), SHA (shared) or BEN (vendor pays).
- **Expected rate**: optional; today's rate from Exchange rates is used when empty. It is used only
  to estimate the rupee amount for the Form 15CA threshold.
- Whether the payment is **chargeable to tax in India**, and whether it is **covered by an order or
  certificate** from the assessing officer.

A bill can be in only one open international payment at a time, and no payment can exceed what is
left to pay on a bill.

## Form 15CA and 15CB (organisations in India)

Worked out under Rule 37BB, from the purpose, the tax position and what was paid to the same vendor
earlier in the Indian financial year (April to March; approved, sent and paid payments count):

| Situation | Needs |
| --- | --- |
| Purpose on the no-form list (here: S0101, S0102 imports) | Nothing |
| Not chargeable to tax in India | Form 15CA Part D |
| Covered by an order or certificate | Form 15CA Part B |
| Chargeable, up to ₹5 lakh to this vendor this financial year | Form 15CA Part A |
| Chargeable, above ₹5 lakh | Form 15CB from a chartered accountant, then Form 15CA Part C |

The forms are filed on the income tax portal by the organisation; Talk2Tax does not file them.
The acknowledgement numbers are entered on the draft, and approval is blocked until they are in.
For organisations outside India the forms do not apply.

## Approval, the bank instruction and recording the payment

1. **Approve** (needs `approvals.decide`): blocked while anything is missing (verified bank abroad,
   purpose, bills still posted and owed, Form 15CA/15CB numbers). The preparer cannot approve their
   own payment unless they are the only approver, in which case it is marked self-approved.
2. **Download bank instruction** (needs `purchases.manage` and `journals.post`): a CSV with the
   remitter, beneficiary, bank, SWIFT, routing code, amount, currency, value date, purpose code,
   charges, the invoices paid and the Form 15CA/15CB numbers. The first download marks the payment
   **Sent to bank**. It can be downloaded again.
3. **Record as paid**: enter the bank's rate, the date and the bank's reference. One payment is
   posted in the foreign currency at that rate from the chosen bank account, settling the bills;
   the difference from the bills' rate posts as exchange gain or loss in the usual way.

A draft can be changed or deleted. Approved and sent payments can be cancelled with a reason (stop
it at the bank too if the instruction was sent); paid ones cannot (void the payment instead).
Database triggers stop an approved payment or its bills from being changed.

Every step is in the audit trail (`international_payment.prepared`, `.approved`,
`.instruction_downloaded`, `.paid`, `.cancelled`).

## Not reviewed, not built

- The purpose-code list and the Form 15CA/15CB rules were written from public sources and **have
  not been reviewed by a banker or a chartered accountant**. Check the part with your CA.
- No bank API: the instruction is a file for the bank's own portal or forex desk. No SWIFT MT103.
- No TDS on the remittance itself (section 195) and no DTAA rate lookup; record TDS on the bill.
- No forward contracts or rate booking.
