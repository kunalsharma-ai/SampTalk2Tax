# Regulatory change monitoring (TAX-046)

Tax → **Regulatory changes**, for every country.

Talk2Tax does **not** watch government websites or news feeds. Instead it keeps two hand-written lists in `packages/tax-engine/src/regulatory-changes.ts` and shows each business the parts that apply to its country:

1. **Law changes** (`KNOWN_CHANGES`): each has the date it takes effect, what it means, what Talk2Tax already does about it, and the official source to confirm it. A change that is coming up, or took effect in the last 120 days, stays *To review* until someone with accounts.manage records how the business dealt with it. That record is final and goes in the audit trail. Older changes show as *In force*.
2. **Rules Talk2Tax uses** (`ruleSets()`): every set of built-in tax rules for the country (country module, invoice requirements, US sales tax and 1099 rules, tax document explanations), with the date each was last checked against official sources. Rules not checked for more than 180 days are marked *Due for review*.

The page also lists the business's own **scheduled tax rate changes**: future-dated rate versions added on a tax rate (TAX-003), each with the rate it replaces.

Changes listed (as of 24 November 2026): India's 30-day e-invoice reporting limit (2025) and the Income-tax Act 2025 (from 1 April 2026); Germany's e-invoicing phases (2025, 2027, 2028); and the US 1099 threshold rising to $2,000 (2026). **The list was written from memory, is not complete, and needs review by a tax adviser.** Each change names its source so it can be confirmed.

## Evidence

- Engine: `packages/tax-engine/src/regulatory-changes.ts`, tests `packages/tax-engine/test/regulatory-changes.test.ts`
- Data: `regulatory_change_acks` (migration `20270314100000_regulatory_change_acks`)
- API: `GET /v1/orgs/:orgId/tax/regulatory-changes`, `POST .../:key/dealt-with`; tests `apps/api/test/regulatory-changes.e2e.test.ts`
- Web: `apps/web/src/app/orgs/[orgId]/tax/regulatory-changes/page.tsx`; browser test `apps/web/e2e/regulatory-changes-flow.test.mjs`
