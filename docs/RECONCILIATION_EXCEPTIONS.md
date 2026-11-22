# Reconciliation exceptions (BANK-020)

Banking → Reconciliation exceptions explains why imported bank statement lines and entries in the
books are still unmatched on each active bank account, and says what to do about each. It is read
only: nothing changes the books and no AI model is used. The logic is in
`packages/accounting-engine/src/reconciliation-exceptions.ts`; the API is
`GET /v1/orgs/:orgId/banking/reconciliation-exceptions?accountId=` (banking permission).

Statement lines are the unmatched ones on the account; excluded lines are left out. Entries are the
unmatched bank lines in the books from the start of the first completed reconciliation, or from the
first imported statement line if the account has never been reconciled.

## Kinds

Exceptions are found in this order, and each item is used once:

| Kind | Found when | What to do |
| --- | --- | --- |
| Amounts differ | A line and an entry the same way, within 7 days, whose amounts differ by up to 2%. Closest pairs first | Match them, and book the difference (a bank fee or a short payment) with an entry |
| Split or combined | One item equal to two or three on the other side, the same way, within 7 days | Match them together |
| Reversed | Two lines, or two entries, for the same amount in and out within 7 days | They cancel out: exclude both lines, or leave both entries, saying why |
| Bank charges or interest | A line whose narration reads like a charge, fee, tax on one, or interest | Create an entry to bank charges or interest from the line |
| Not in the books | Any other statement line | Record the receipt or payment, or create an entry from the line |
| In transit | An entry dated within 7 days before the latest statement line, or after it | Nothing yet: it should clear on the next statement |
| Old, not on any statement | An entry more than 30 days older than the latest statement line | Find out why it never reached the bank: void or reissue a cheque, or move the entry |
| Not on the statement yet | Any other entry | Check it reaches the bank; match it when it shows on a statement |

Everything except In transit counts as needing action. Within a kind, the oldest come first.

## Ageing

For one account (the one picked, or the only one with exceptions) the page shows its exceptions by
kind and its unmatched lines and entries by age: up to 7 days, 8 to 30, 31 to 90 and over 90.

## Limits

Talk2Tax has no live bank feed, so the analysis is only as fresh as the latest imported statement.
The narration test for bank charges is a word list (charges, fee, commission, SMS, maintenance,
penalty, GST, interest and the usual bank abbreviations), so an unusual narration may land in Not in
the books instead.
