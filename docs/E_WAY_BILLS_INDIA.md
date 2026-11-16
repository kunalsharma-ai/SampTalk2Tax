# E-way bills: India (M3, slice 6)

An e-way bill must be generated on the e-way bill portal (ewaybillgst.gov.in) before goods worth more than ₹50,000 are moved (CGST Rule 138). Part A holds the invoice details and Part B the vehicle. Talk2Tax tells you which invoices need one, prepares the portal's bulk-upload JSON, and records the e-way bill number, validity, vehicle changes and cancellation.

**Talk2Tax does not connect to the e-way bill portal.** The user uploads the JSON (or keys the bill in) and records what the portal returns. Requirement TAX-027 allows government submission only through an approved GSP/ASP integration, which is not built.

* **Rules:** `packages/tax-engine/src/india/ewaybill.ts`, which has no framework or database code.
* **API:** `apps/api/src/e-way-bills`.
* **Web:**
  * **Tax → E-way bill settings**.
  * **Tax → E-way bills**, the register by month.
  * A panel on each invoice: prepare, record, change the vehicle, cancel.

## How it works

1. **Set-up.** E-way bills need the GST registration first. The settings hold:
   * the threshold (₹50,000 by default);
   * optionally, the organisation's state's own threshold for movement within the state;
   * the dispatch-from address, city and PIN code (suggested from the e-invoicing settings when those exist);
   * the unit code used on goods lines (NOS by default).
2. **Which invoices.** Every posted invoice is checked. The value that counts is the taxable value plus GST of goods lines (HSN codes, not SAC codes starting 99), leaving out nil-rated, exempt and non-GST lines. Each invoice gets a state:
   * **Needed, not recorded:** the value is over the threshold (the state's own threshold for a movement within the state, when one is set). The JSON can be prepared.
   * **Needs details:** the portal would refuse it. The page lists what is missing, such as the customer's delivery address, city or PIN code, or an HSN code.
   * **Optional:** goods under the threshold. An e-way bill can still be made, after any missing details are added.
   * **Too old for the portal:** dated more than 180 days ago. From 1 January 2025 the portal only takes documents dated within 180 days.
   * **E-way bill recorded** (with "Part A only" until a vehicle is entered, and "expiring" within 12 hours of the end of validity) or **Cancelled**.
   * **Not applicable:** services only, so no goods move.
   * **Not supported:** exports, which must be made on the portal.
3. **Part B.** The user enters the mode of transport (road, rail, air or ship), the distance (1 to 4,000 km; at most 100 km when both ends have the same PIN code), the vehicle number for road (the vessel number for ship), the transport document number and date for rail, air and ship, and optionally the transporter's GSTIN or TRANSIN and name. With only a transporter ID and no vehicle, the bill is Part A only.
   * Vehicle numbers are normalised (MH 12 AB 1234 → MH12AB1234) and checked against the forms the portal accepts: state registrations, Bharat series (22BH1234AA), and temporary or defence numbers.
   * Over-dimensional cargo can be marked.
4. **JSON.** One bill in the portal's bulk-generation format (`version` 1.0.0621, `billLists`): outward supply on a tax invoice, seller and buyer GSTINs (`URP` for an unregistered buyer), from and to addresses, state codes, the goods lines with HSN, quantity, unit and tax rates, the CGST/SGST/IGST totals, TCS in `OthValue`, and the transport fields. Services on the same invoice are left out of the item list.
5. **Recording.** After the portal generates it, the user records the 12-digit e-way bill number, the time it was generated (IST) and its validity. Talk2Tax works out the validity under Rule 138(10): one day per 200 km (20 km for over-dimensional cargo), or part of it, counted from when Part B is first entered and ending at midnight (23:59:59 IST) of the last day. The form fills in that date; the user enters the portal's own when it differs, and the page shows both.
6. **Change of vehicle.** While the bill is valid, a new Part B can be recorded with the reason (breakdown, transhipment, others; "first time" only for a Part A only bill) and the place and state the goods move on from. On a Part A only bill the first Part B starts the validity. Every change is kept, in order.
7. **Cancellation.** The portal allows cancellation within 24 hours of generation. Talk2Tax records it (reason: duplicate, order cancelled, data entry mistake, others; and a remark) only within that window.
8. **Guards.**
   * An invoice with a live e-way bill cannot be voided until its cancellation is recorded. The API returns `HAS_EWAY_BILL`, and a database trigger enforces it as well.
   * E-way bills are recorded only for posted invoices, are never deleted or edited, and change only once, from ACTIVE to CANCELLED, inside the 24 hours (trigger and CHECK).
   * Only one live e-way bill per invoice (partial unique index), and a number is unique within an organisation.
   * Vehicle updates are append-only and only on a live bill.
   * Every recording, vehicle change and cancellation is in the audit trail.

## Not supported yet (do not rely on these)

* **Connection.** No direct portal or GSP connection: no automatic generation, no import of the portal's reply, no fetching of bills generated against the organisation's GSTIN by others.
* **Movements.** Only outward supplies on tax invoices. No exports, imports, inward supplies, job work, delivery challans, bills of supply, SKD/CKD, line sales or movements of own goods between branches. No dispatch-from or ship-to addresses other than the settings and the customer's address. No bulk JSON for several invoices at once.
* **Portal actions.** No extension of validity (allowed from 8 hours before to 8 hours after expiry), consolidated e-way bills, multi-vehicle movements, rejection by the recipient, or transporter updates.
* **Thresholds.** Talk2Tax uses the value in the settings; it does not keep each state's notified intra-state thresholds or the goods each state exempts.
* **Timing.** Validity, the 180-day limit and the 24-hour window are worked out by Talk2Tax; the portal's clock decides at the margin.

## Sources (checked 2026-11-01)

* **Rule 138** of the CGST Rules, 2017: the ₹50,000 threshold, Part A and Part B, cancellation within 24 hours, and the validity table in sub-rule (10) (200 km a day; 20 km for over-dimensional cargo).
* **180-day limit.** GSTN advisory of 17 December 2024: from 1 January 2025, e-way bills can be generated only for documents dated within 180 days, and validity can be extended up to 360 days from generation.
* **JSON format.** The portal's bulk-generation format, as produced by the e-way bill offline tool (`version` 1.0.0621). Field names were cross-checked against the open-source implementation in resilient-tech/india-compliance. The NIC portal pages themselves were not reachable from here.
* **Vehicle and cancel reasons.** The codes the portal uses (NIC e-way bill API documentation, as reproduced in the same open-source implementation).

## Tests

* `packages/tax-engine/test/ewaybill.test.ts` (9 tests): the consignment value, validity days and the end time in IST, the 180-day and 24-hour windows, vehicle numbers, what each mode needs, the JSON for an inter-state invoice with goods and a service, an unregistered buyer within the state and Part A only, and the messages for what the portal would reject.
* `apps/api/test/e-way-bills.e2e.test.ts` (11 tests): set-up needs GST; the value of goods; the state's own threshold; the JSON and the register; recording once; a change of vehicle, and Part A only; Part B refused after expiry; voiding blocked until the cancellation, within 24 hours; immutability in the database; viewers and tenant isolation.
* `apps/web/e2e/e-way-bills-flow.test.mjs` (4 tests), in the browser: set-up; the invoice that needs one, the JSON downloaded and checked, and the e-way bill recorded; a change of vehicle after a breakdown, a void refused, the cancellation recorded and the invoice voided; the register.

The demo data includes one e-way bill for a synthetic invoice. Its number is made up, not issued by the portal.
