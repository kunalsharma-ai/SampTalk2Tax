# Usage-based billing (AR-012)

Charges worked out each period from the usage a customer actually had (API calls, GB stored,
hours, messages, seats…), billed on the contract's invoice next to its fixed lines.

Where: the **Usage charges** card on each contract (**Sales → Contracts → a contract**).

## Usage charges (meters)

A usage charge belongs to one contract and has a name (shown on the invoice), a **meter code**
(used in imports and by other systems, fixed once created), a unit, an income account, a tax rate
and HSN/SAC, and its pricing:

| Pricing | How the billable quantity is priced |
| --- | --- |
| Per unit | One price for every unit. |
| Graduated tiers | Each tier prices the units that fall within it: the first 1,000 at 2.00, the next 9,000 at 1.50, the rest at 1.00. |
| Volume tiers | Every unit is priced at the tier the whole quantity reaches. |

The billable quantity is what was used in the period less the **units included** each period.
An optional **minimum charge** tops the period up to that amount (as its own invoice line).
Up to 20 tiers; each tier's upper limit must be above the one before, and the last has none.

Usage is billed **in arrears**, once the period has ended, so only contracts billed in arrears
take usage charges, and a contract with usage charges cannot be switched to billing in advance.
Changing a price applies to periods billed from then on. A charge can be switched off (no longer
billed, usage kept) or, if it never had usage, removed.

## Recording usage

Usage is recorded on an active or paused contract, dated on or before today and inside a period
that is not billed yet:

- **By hand** in the *Record usage* form.
- **By CSV**: columns `meter`, `date` (YYYY-MM-DD), `quantity` and optionally `reference`, in any
  order. The file is checked in the browser and again by the server; if any row is wrong nothing
  is recorded. Up to 5,000 rows at a time.
- **Through the API**: `POST /v1/orgs/:orgId/sales/contracts/:id/usage` (one reading) or
  `.../usage/import` (many, by meter code), with a member's sign-in.

A **reference** makes a reading idempotent: the same reference on the same meter is recorded
once, so a system can safely send a batch again. Quantities can be negative to correct an earlier
period. A mistaken reading not yet billed is **voided** with a reason; it stays in the record.

## Billing

When a period's invoice date comes (its last day), the contract's draft invoice gets the fixed
lines and, for each active usage charge, its usage lines: one per tier used, plus any minimum
top-up, each describing the period, the quantity used and the included units. Lines that come to
nothing are left out. The readings are stamped with the period and invoice and are then frozen:
they cannot be voided or changed (database triggers enforce this), and no new usage can be dated
in that period. If the invoice is deleted or voided, *Bill again* bills the same readings.

The card shows the current period's usage so far and what it comes to before tax.

Every step is in the audit trail: `contract_meter.created/updated/deleted`, `usage.recorded`,
`usage.imported`, `usage.voided`, and `sales_contract.billed`.

## Not built

- Usage in a period that was skipped while the contract was paused is not billed.
- Contracts billed in advance cannot carry usage charges (no "fixed in advance, usage in
  arrears" mix on one contract).
- No API keys for machine-to-machine usage feeds yet; the API uses a member's sign-in.
- No prorating of tiers or minimums for a part period.
