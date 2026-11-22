# Dispute reason suggestions (AR-037)

When a customer queries an invoice, the dispute is recorded with a reason: price or rate,
quantity, quality or damage, not received, billed twice, tax, or other. Talk2Tax suggests the
likely reason from what the customer said and from the invoice. A person always chooses; nothing
is changed by itself and no AI model is used. The logic is in
`packages/accounting-engine/src/dispute-classification.ts`.

## How the reason is worked out

- Each reason has telling phrases (2 points each, such as "agreed rate", "only received",
  "arrived damaged", "never received", "billed twice", "place of supply") and single words (1 point
  each, such as "rate", "short", "broken", "missing", "duplicate", "GST"). Case, punctuation and
  apostrophes are ignored; a word inside a phrase already counted is not counted again.
- Two facts from the invoice add 2 points each: another posted invoice to the same customer for the
  same total within 45 days (billed twice), and an amount in dispute equal to the invoice's tax
  (tax).
- The reason with the most points is suggested, with what it is based on. With nothing found, the
  suggestion is Other.
- Confidence is high at 3 points or more with a lead of 2 over the next reason, medium at 2 points
  with a lead, and low otherwise.

## Where it shows

- **Raising or changing a dispute**: as the description is typed, the form shows "Looks like …"
  with the confidence and the phrases found, and a button to use that reason.
- **Disputes list and dispute page**: a recorded dispute whose suggested reason differs from its
  own, at medium or high confidence, is marked "Looks like …". The list response counts them in
  `reasonDiffers`.

## API

- `POST /v1/orgs/:orgId/sales/disputes/classify` with `{ documentId, description, amount? }`
  (sales.read; read-only) returns `{ reason, label, confidence, because }`.
- Each dispute in `GET /sales/disputes` and `GET /sales/disputes/:id` carries `suggested` and
  `reasonDiffers`.
