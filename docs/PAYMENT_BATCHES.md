# Payment batches and vendor bank details

Registry: **AP-014 Payment batches**, **AP-027 Supplier bank-detail change detection**.

A payment batch pays several vendor bills in one run. One person prepares it, someone else
approves it, the bank is sent a file, and the payments are recorded once the bank has paid.
Before any of that, each vendor's bank account is entered and then verified by a second person,
because a changed bank account is the most common way supplier payments are stolen.

## Vendor bank details

On a vendor's page the **Bank details** card holds the account holder's name, the account number,
the IFSC and, optionally, the bank and branch.

* The IFSC must have the form `AAAA0XXXXXX`; the account number is 6 to 34 letters or digits
  (spaces and dashes are removed).
* Account numbers are masked everywhere on screen (`XXXXXXXX4567`). The full number is only in the
  bank file.
* **Any change clears the verification.** This is done by a database trigger, so no code path can
  skip it.
* Every change is kept in an append-only history (masked before and after, who and when). Bank
  details cannot be deleted.
* **Verify…** needs `approvals.decide` and a note on how the details were confirmed (for example a
  call to a number already on file). The person who last changed the details cannot verify them,
  unless nobody else in the organisation can approve (`SAME_PERSON`).

| Action | Permission |
| --- | --- |
| See bank details | `purchases.read` |
| Add or change | `contacts.manage` |
| Verify | `approvals.decide` |

## A batch, step by step

**Purchases → Payment batches → New batch**:

1. Pick the bank account (a postable bank account), the payment date and an optional note.
2. Tick the bills. Each one starts at what is left to pay; lower it to pay part of a bill.
   Only posted bills in the functional currency with something left to pay are listed, and a bill
   can be in one open batch at a time (`IN_ANOTHER_BATCH`).
3. **Save batch**. It is numbered **PB-0001** and stays a draft until approved; a draft can be
   changed or deleted.

The batch page lists anything that stops it going ahead:

* a bill no longer posted, or with less left to pay than the batch amount;
* a vendor with no bank details, or with details not verified (including details changed after
  the batch was approved).

**Approve** needs `approvals.decide` and someone other than the person who prepared the batch. When
nobody else can approve, the preparer's approval is accepted and the batch is marked
**Self-approved**. An approved batch cannot be changed (database trigger); cancel it and prepare a
new one.

**Download bank file** (after approval) gives a CSV with one row per vendor: payment date, debit
account, beneficiary name, account number, IFSC, amount, currency, payment reference (the batch
number and the bill numbers, or `PB-0001 3 bills` when they do not fit the bank's 30 characters),
the vendor's e-mail and name. Fields that a spreadsheet would read as a formula are neutralised.
Upload it in your bank's bulk-payment screen.

**Record payments**, once the bank has paid, posts one payment per vendor from the batch's bank
account on the payment date, with the batch number as reference, and settles the bills. Each bill
on the batch page links to its payment; the payments show on bank reconciliation like any other.

**Cancel…** (draft or approved, with a reason) frees the bills for another batch. Paid and
cancelled batches are final and kept for the record.

| Action | Permission |
| --- | --- |
| See batches | `purchases.read` |
| Prepare, change, delete a draft, cancel | `purchases.manage` |
| Approve | `approvals.decide` |
| Bank file, record payments | `purchases.manage` and `journals.post` |

## API

Under `/v1/orgs/:orgId/purchases/payment-batches`:

| Method | Path | |
| --- | --- | --- |
| GET | `/` | batches |
| GET | `/payable-bills` | bills that can be paid, with bank-detail status |
| GET | `/:id` | a batch with its items, vendors, issues and what you can do |
| POST | `/` | `{ bankAccountId, paymentDate, memo?, items: [{ documentId, amount? }] }` |
| PATCH | `/:id` | change a draft |
| DELETE | `/:id` | delete a draft |
| POST | `/:id/approve` | |
| POST | `/:id/payment-file` | the CSV |
| POST | `/:id/paid` | record the payments |
| POST | `/:id/cancel` | `{ reason }` |

Bank details: `GET`, `PUT /v1/orgs/:orgId/contacts/:contactId/bank-details` and
`POST …/bank-details/verify` `{ note }`.

## Not yet

* Sending the file to the bank directly (host-to-host or a bank API). The file is downloaded and
  uploaded by hand.
* Bank-specific file layouts. The CSV has the columns most Indian banks' bulk upload accepts; map
  them in the bank's template if it differs.
* Foreign-currency bills in a batch.
* Checking a beneficiary's name with the bank (penny drop).
