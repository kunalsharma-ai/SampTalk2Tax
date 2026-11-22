# The assistant prepares payments, never makes them (AP-036)

The copilot can help with supplier payments only up to a **draft**. It can never approve a batch,
download the bank file, record a payment or move money. A person always authorises the payment,
and for a batch the assistant prepared, that person is not the member who accepted the proposal.

## What the assistant can do

1. `list_payable_bills` (needs `purchases.read`) reads the posted bills with something left to
   pay, the vendors whose bank details are verified, and the bank accounts payments can be made
   from. It never sees bank account numbers.
2. `propose_payment_batch` (needs `purchases.manage`) proposes a draft batch: a bank account, a
   payment date from today on, and up to 50 of those bills. It is refused for bills already in an
   open batch, bills not open for payment, other accounts or past dates.

A proposal does nothing. The member sees a card with what would happen in words and a
**Sensitive** badge, and confirms twice within 15 minutes. Confirming prepares the batch as a
draft, as that member, with the note "Prepared with the assistant", and records
`payment_batch.created` with `source: COPILOT` in the audit trail.

## What stays with people

- **Approval by a second person.** A batch prepared with the assistant can only be approved by
  someone other than the member who accepted it, even in an organisation where the only approver
  may otherwise approve their own batch. The server refuses with `SAME_PERSON`.
- **The usual batch controls still apply:** every vendor's bank details verified by a person,
  every bill still payable, the bank file only after approval, payments recorded by a person once
  the bank has paid.
- **No action can execute a payment.** `NEVER_ASSISTANT_ACTIONS` lists approving a batch, the bank
  file, recording or marking payments, transfers and bank-detail changes; the server will not
  start if one of them is ever added to the assistant's actions, and the database refuses an
  assistant action of any kind not on the allowed list.

The batch page shows "Prepared with the assistant" and a badge on who prepared it.

## Tests

- API: `apps/api/test/ai-payment-guard.e2e.test.ts` (proposal, confirmation, second-person
  approval, refusals, permissions and the database check).
- Browser: `apps/web/e2e/ai-payment-guard-flow.test.mjs`.
