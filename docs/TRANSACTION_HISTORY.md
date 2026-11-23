# Transaction history (AUDIT-005)

Every bill, invoice, credit note, receipt, payment, journal entry and expense claim page has a
**Transaction history** card (for people with `audit.read`). It reads the hash-chained audit
trail and shows, oldest first:

- the record's own events (drafted, changed, posted, voided, signed, submitted, approved…);
- money applied to or from it (allocations made and removed);
- files attached to it, removed or given a new version;
- the journal entries it posted (and their reversals, and realised exchange differences).

Each event is in words, with who did it, when, the facts it recorded (number, amount, reason…)
and the fields it changed. Each event is checked against its own SHA-256 hash: an event altered
in the database is marked **Altered** and the card warns. (The whole chain, including order and
removals, is checked with Verify integrity on the Audit trail page.)

API: `GET /v1/orgs/:orgId/transaction-history/:kind/:id`, kind `document`, `payment`,
`journal_entry` or `expense_claim` (up to 2,000 events). No new collection.
Tests: `packages/accounting-engine/test/transaction-history.test.ts`,
`apps/api/test/transaction-history.e2e.test.ts`, `apps/web/e2e/transaction-history-flow.test.mjs`.
