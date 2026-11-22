# Business trips (EXP-007)

Expenses → **Business trips** (employees: **My business trips**) records travel before it happens and gathers its expense claims afterwards.

1. **Request**: the traveller gives the purpose, destination, dates (at most 90 days; a trip that ended more than 90 days ago cannot be requested) and an estimate in four parts: travel and transport, hotels and lodging, meals and daily allowance, other. The request is fixed once made (collection guard); to change it, cancel and request again.
2. **Decide**: someone other than the traveller with `approvals.decide` approves it (note optional) or rejects it (reason required).
3. **Link claims**: once approved, the traveller links their own expense claims that are not void and not on another trip. A claim can be unlinked until it is approved.
4. **Cancel**: the traveller can cancel a trip waiting for approval, or an approved trip with no claims.

The trip page shows the cost against the estimate (engine `packages/accounting-engine/src/trip-costs.ts`, `tripCosts`):

- Spent: lines of approved and reimbursed claims; not yet approved: draft, submitted and rejected claims. Void claims are left out.
- By expense category (account), what is left of the estimate, and the cost a day (spent ÷ days, both ends counted).
- Flags: claims passing the estimate (`OVER_ESTIMATE`, with the percent) and lines dated more than a day before or after the trip (`OUTSIDE_DATES`).

Travellers see their own trips; finance (`expenses.read`) and approvers (`approvals.decide`) see everyone's. Trips are stored in `expense_trips` (migration `20270219100000_expense_trips`) and never deleted. Every request, decision, cancellation, link and unlink is in the audit trail (`expense_trip.*`).

## API

- `GET /v1/orgs/:orgId/expense-trips?status&mine=true`, `GET .../:tripId`
- `POST /v1/orgs/:orgId/expense-trips` `{ purpose, destination, startDate, endDate, estimate: { transport, lodging, meals, other } }`
- `POST .../:tripId/approve` `{ note? }`, `POST .../:tripId/reject` `{ note }`, `POST .../:tripId/cancel`
- `POST .../:tripId/claims` `{ claimId }`, `DELETE .../:tripId/claims/:claimId`

## Tests

- `packages/accounting-engine/test/trip-costs.test.ts`
- `apps/api/test/expense-trips.e2e.test.ts`
- `apps/web/e2e/expense-trips-flow.test.mjs`
