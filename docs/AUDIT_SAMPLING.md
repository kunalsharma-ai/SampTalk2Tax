# Audit sampling (AUDIT-009)

Governance → Audit samples picks transactions to test from a period's books.

## The population

Each sample draws from one population, limited to posted items dated in the chosen range:

* **Posted journals.** Every posted journal, including those posted by bills, invoices and payments. The amount is the journal's total debit.
* **Posted bills** and **posted invoices.** Voided documents are left out. The amount is the total in the organisation's currency (total × exchange rate).
* **Payments to suppliers.** Voided payments are left out.

A population can hold up to 50,000 items. For more, use a shorter range.

## Methods

* **Random.** Simple random sampling without replacement: every item has the same chance. Uses a partial Fisher–Yates shuffle over the items sorted by id, so the order the database returns them in does not matter.
* **Monetary unit.** Each currency unit has the same chance, so larger items are likelier to be picked.
  * Systematic selection from a random start, over items with a non-zero amount.
  * The interval is the population total ÷ the sample size.
  * An item at or above the interval is always picked, and is marked *above the interval*.
  * Fewer items than asked can be picked when large items take several selection points.
* **High value.** Every item whose absolute amount is at or above the threshold is picked, largest first. If that is fewer than the sample size, the rest are filled with a random pick of the items below the threshold.

A sample has 1 to 200 items.

## Drawing it again

* The generator is seeded: mulberry32, seeded by a 32-bit hash of the seed text. It is the same generator the test fixtures use. It is not for security.
* The seed is kept with the sample. Give your own seed, or leave it blank to get a new UUID.
* The same population, method, size, threshold and seed always give the same items. Anyone can check a sample by drawing it again.
* The sample keeps a fingerprint of its population (the ids and amounts). When the sample is opened, the population is read again and drawn again from the seed. The page then shows:
  * whether the books in the range changed since the sample was drawn
  * whether drawing again still picks the same items
* The sample itself always keeps the items first drawn.

## Testing

* Open each item from the sample, check it against its documents, then record one of:
  * **No exception**
  * **Exception**, which needs a note of at least 10 characters saying what was wrong
* Each result is recorded once, with who recorded it and when.
* The sample completes when every item has a result. Completing is a separate conditional step, so two people finishing the last items at the same moment still complete it.
* Raise an audit finding ([AUDIT_FINDINGS.md](AUDIT_FINDINGS.md)) for any exception that needs fixing.

## Record and access

* Drawing a sample and recording results need `audit.read` (owners, admins, accountants, approvers, auditors). Viewers cannot see samples.
* The collection guards keep the record intact:
  * The selection (seed, method, size, range, items and amounts) never changes.
  * A recorded result cannot change.
  * A completed sample cannot change.
  * Samples are never deleted.
* Drawing and each result are audited (`audit_sample.drawn`, `audit_sample.item_tested`). The audit record includes the seed, method and population size.

## Code and tests

* Engine: `packages/accounting-engine/src/audit-sampling.ts`, `test/audit-sampling.test.ts`
* API: `apps/api/src/audit-sampling/`, collection `audit_samples` (migration `20270204100000_audit_samples`), `test/audit-sampling.e2e.test.ts`
* Web: `apps/web/src/app/orgs/[orgId]/audit-samples/`, `e2e/audit-samples-flow.test.mjs`
