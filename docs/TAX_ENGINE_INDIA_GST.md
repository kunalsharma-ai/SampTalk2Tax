# Tax engine: India GST module

The first jurisdiction module of the tax engine (directive Part 8). Rules live in
`packages/tax-engine` as pure, framework-free TypeScript with decimal-only arithmetic;
the API (`apps/api/src/gst`, `apps/api/src/ledgers/documents.service.ts`) and the web
invoice form run the same code, so the tax shown while typing is the tax that posts.

## What it does

| Area | Rule implemented | Where |
|---|---|---|
| GSTIN | 15 characters: state code, PAN, entity number, `Z`, check character (base-36 mod N over the first 14 characters, as published by GSTN). Format only: a GSTIN is never looked up on the GST portal | `src/india/gstin.ts` |
| States | GST state codes 01–38 and 97, retired codes 25 and 28 left out; 96 = place of supply outside India. Union territories without a legislature (04, 26, 31, 35, 38, 97) levy UTGST instead of SGST | `src/india/states.ts` |
| Registration | One GSTIN per organisation (India, INR books), an effective date and six accounts (output and input CGST, SGST/UTGST, IGST). The GSTIN and accounts are frozen once a document carries them | `GstService.register` |
| Rates | `TaxRate.kind = GST` with a category: TAXABLE, NIL_RATED, EXEMPT or NON_GST (non-taxable categories are 0%). Rates and categories never change once created (DB trigger) | `tax-rates.service.ts`, migration `20261101120000_india_gst` |
| Place of supply | Sales default to the customer's state (from GSTIN or set on the contact), purchases to the organisation's state; it can be chosen per document. Intra-state when supplier state = place of supply, otherwise inter-state; exports are always inter-state (IGST Act s.7, s.8) | `supplyNature`, `GstService.supplyFacts` |
| Tax split | Intra-state: CGST and SGST/UTGST at half the rate each, each rounded half-even to the paisa on its own (so the halves are always equal). Inter-state and exports: IGST at the full rate. Per line, posted per head to the registration's accounts | `gstComponents`, `buildDocumentJournal` |
| Documents | From the effective date, every invoice, credit note, bill and vendor credit line must use a GST rate and carry an HSN/SAC code (4, 6 or 8 digits; not needed for non-GST lines). An unregistered supplier's bill cannot carry GST. Place of supply, supplier state, nature and counterparty GSTIN are stored and frozen on posting (DB trigger); a draft whose GST split changed is refused at posting | `DocumentsService.prepareGst` |
| GSTR-1 | B2B (table 4), B2CL above Rs 1,00,000 inter-state unregistered (5), exports with IGST (6A), B2CS by place of supply and rate net of their credit notes (7), nil/exempt/non-GST (8), credit notes to registered and unregistered (9B), HSN summary split B2B/B2C (12), documents issued with cancellations (13) | `gstr1Summary` |
| GSTR-3B | 3.1(a), (b), (c), (e); 3.2 inter-state to unregistered by place of supply; 4 ITC net of vendor credits; 5 exempt/nil/non-GST inward; 6.1 payment of tax | `gstr3bSummary` |
| ITC set-off | CGST Act s.49(5), s.49A and rule 88A: IGST credit first (IGST, then CGST and SGST/UTGST, giving first to the head whose own credit falls short), then CGST credit (CGST, then IGST) and SGST/UTGST credit (SGST/UTGST, then IGST). CGST never pays SGST and the reverse | `setOffItc` |
| Ledger check | GSTR-3B compares the document totals with the month's movement on the six GST accounts and flags any difference (for example a manual journal on a GST account) | `GstService.ledgerMovements` |

## Not supported yet (do not rely on these)

* Reverse charge (s.9(3)/9(4)), imports of goods or services, SEZ supplies, deemed exports, exports under LUT/bond without IGST, composition scheme, input service distributor, TCS by e-commerce operators.
* Blocked credits (s.17(5)), ITC reversals (rule 42/43, 180 days), ITC brought forward between months, GSTR-2A/2B matching, interest and late fees.
* E-invoicing (IRN/QR), e-way bills, GSTN JSON export and any filing. Talk2Tax does not connect to the GST portal (TAX-027).
* Units of measure (UQC) for the HSN summary, an HSN master or rate lookup, cess, multiple GSTINs per organisation, amendments of earlier periods.
* A document voided after its month disappears from that month's summaries; under GST a credit note should be issued instead. The ledger check shows such a difference.
* Expense claims cannot use GST rates (no supplier GSTIN); enter the supplier's tax invoice as a bill to claim credit.

## Sources (verified 2026-11-01)

* CGST Act 2017 s.2, s.9, s.16, s.17, s.49, s.49A; CGST Rules rule 88A (order of utilisation of input tax credit).
* IGST Act 2017 s.7 (inter-state supply), s.8 (intra-state supply), s.10–13 (place of supply).
* UTGST Act 2017 s.2(8) (union territories without legislature).
* GSTN: GSTIN structure and check character; state code list; GSTR-1 and GSTR-3B form layouts (including the HSN table split into B2B and B2C, and the Rs 1 lakh B2CL threshold from August 2024).

Rates are never hard-coded: each organisation creates the GST rates it uses and chooses one per line. The engine does not decide which rate applies to an item.

## Tests

* `packages/tax-engine/test` — GSTIN check character, states, split and rounding, UTGST, document journals, GSTR-1 classification, GSTR-3B and set-off order.
* `apps/api/test/gst.e2e.test.ts` — registration, rates, contacts, documents, posting accounts, immutability, returns and the ledger check against PostgreSQL.
* `apps/web/e2e/tax-flow.test.mjs` — the browser flow from registration to GSTR-1.

## Maintenance

When a rule changes (state codes, return layouts, thresholds, set-off order), change it in `packages/tax-engine`, add a test with the source and date, and update this file. The B2CL threshold is a parameter of `gstr1Summary`.
