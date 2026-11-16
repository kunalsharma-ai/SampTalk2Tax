# E-invoicing: India (M3, slice 5)

E-invoicing reports each B2B invoice and credit note to the government's Invoice Registration Portal (IRP). The IRP returns an Invoice Reference Number (IRN), an acknowledgement and a signed QR code. Talk2Tax prepares the JSON the IRP takes and records what the IRP returns.

**Talk2Tax does not connect to the IRP.** The user uploads the JSON on the IRP (or through their GSP) and pastes the response back. A direct connection needs an approved GSP/ASP integration, and requirement TAX-027 allows government submission only through one.

* **Rules:** `packages/tax-engine/src/india/einvoice.ts`, which has no framework or database code.
* **API:** `apps/api/src/e-invoicing`.
* **Web:**
  * **Tax → E-invoicing settings**.
  * **Tax → E-invoices**, the register, with bulk download.
  * A panel on each invoice and credit note.
  * City and PIN code fields on customers.

## How it works

1. **Set-up.** E-invoicing needs the GST registration first. The settings hold:
   * the date e-invoicing applies from;
   * whether the organisation's aggregate turnover (AATO) is ₹10 crore or more, which turns on the 30-day limit;
   * the seller's trade name, address, city and PIN code;
   * the GST unit code used on goods lines (NOS by default);
   * optionally, the IRP's RSA public key.
2. **Which documents.** Posted invoices and credit notes dated on or after that date, for customers with a GSTIN, are e-invoiced. Each document gets a state:
   * **Ready for IRP:** the JSON can be downloaded. The page shows the date to report it by when the 30-day limit applies.
   * **Needs details:** something the IRP requires is missing, such as the customer's PIN code or city, an HSN code, or an address over 100 characters. The page lists what is missing.
   * **Past 30 days:** the AATO is ₹10 crore or more and the document is more than 30 days old. The IRP would refuse it. An IRP response can still be imported if the user has one.
   * **IRN generated** or **IRN cancelled**.
   * **Not required:** B2C sales, or documents dated before e-invoicing applies.
   * **Not supported:** exports.
3. **JSON.** INV-01, schema version 1.1, built from the posted document:
   * **Sections:** `TranDtls` (B2B, reverse charge N), `DocDtls` (INV or CRN, number, dd/mm/yyyy date), `SellerDtls`, `BuyerDtls` (with `Pos`), `ItemList` and `ValDtls`.
   * **Lines:** `IsServc` is Y for SAC codes starting 99. The unit is sent only for goods. The unit price is net divided by quantity, to 3 decimals.
   * **Charges:** TCS goes in `OthChrg`.
   * **Total:** must agree with the posted total to the paisa.

   One document downloads as an object. The register downloads several as an array for the IRP's bulk upload.
4. **IRP response.** The user pastes the response, bare or wrapped in `data`. Before saving, Talk2Tax:
   * reads `Irn` (64 hex characters), `AckNo`, `AckDt` (IST) and `SignedQRCode`;
   * decodes the QR code's `data` claim and checks that it matches this document: IRN, seller GSTIN, buyer GSTIN, document number (ignoring case, as the IRP does), type (INV/CRN), date and total;
   * also checks the document number in `SignedInvoice`, when one is present.
5. **Signature.** With an IRP public key saved, the signed QR code must verify (RS256), or the import is refused. Without a key, the IRN is saved and marked **signature not verified**, and the page says so.
6. **QR code.** The signed QR code, exactly as returned, is drawn as a QR image on the invoice. Its decoded contents are shown beside it.
7. **Cancellation.** An IRN can be cancelled on the IRP within 24 hours of its acknowledgement. Talk2Tax records the cancellation (reason 1–4 and a remark) only within that window; after it, a credit note is the way to reverse the invoice. After a cancellation the document can be voided, or corrected and reported again with a new IRN.
8. **Guards.**
   * A document with a live IRN cannot be voided. The API returns `HAS_IRN`, and a database trigger enforces it as well.
   * IRN records are never deleted or edited. Their only change is a single move from ACTIVE to CANCELLED, inside the 24-hour window, which a trigger and a CHECK enforce.
   * Only one live IRN per document is allowed (a partial unique index), and an IRN is unique within an organisation.
   * Every recording and cancellation is in the audit trail, with a hash of the JSON sent.

## Not supported yet (do not rely on these)

* **Connection.** No direct IRP or GSP connection, no automatic IRN generation, no e-way bill (Part A/B) generation.
* **Document types.** No exports (EXPWP/EXPWOP), SEZ supplies, deemed exports, debit notes, or reverse charge supplies from the seller's side. No dynamic QR codes for B2C invoices when AATO exceeds ₹500 crore.
* **Lines and documents.**
  * One unit code for all goods lines (no per-line UQC).
  * No batch, serial, attribute, discount-per-line, cess or state cess fields.
  * No foreign currency invoices.
  * No dispatch-from or ship-to addresses.
  * No payment or reference details (`PayDtls`, `RefDtls`).
* **Applicability.** Talk2Tax does not work out whether e-invoicing applies to the organisation (AATO over ₹5 crore in any year since 2017-18); the user sets the date.
* **Signature checks.** Talk2Tax does not fetch the IRP key; the user pastes it. The key is not versioned, so changing it does not re-check earlier IRNs.
* **Timing.** The 30-day limit is worked out by date only (document date + 29 days). The IRP's own clock decides at the margin.

## Sources (checked 2026-11-01)

* **Schema.** INV-01 schema 1.1 (NIC e-invoice API documentation). Field names were cross-checked against the open-source implementation in resilient-tech/india-compliance (`e_invoice.py`). The NIC schema pages themselves were not reachable from here.
* **30-day limit.** GSTN advisory of 5 November 2024: from 1 April 2025, taxpayers with AATO of ₹10 crore and above cannot report invoices, credit notes and debit notes older than 30 days. Read from a published copy of the advisory.
* **Cancellation.** The IRP allows an IRN to be cancelled within 24 hours, as set out in the NIC e-invoice FAQs (not re-checked against the portal here). Reason codes: 1 Duplicate, 2 Data entry mistake, 3 Order cancelled, 4 Others.
* **GST rates.** Allowed `GstRt` values include 40% from the September 2025 rate changes.

## Tests

* `packages/tax-engine/test/einvoice.test.ts` (8 tests):
  * the schema 1.1 JSON for an inter-state invoice with goods and services, and for a credit note with TCS;
  * validation messages;
  * the 30-day deadline and the 24-hour window;
  * reading IRP responses, and matching them to the document;
  * UTF-8 token decoding.
* `apps/api/test/e-invoicing.e2e.test.ts` (15 tests):
  * set-up needs GST, and bad PINs or keys are refused;
  * contact city and PIN code;
  * states and JSON (NEEDS_DATA then READY, B2C not required), the register and bulk download, and the 30-day limit;
  * the IRP response: refused for another document, recorded, and IRN_EXISTS;
  * a duplicate IRN on another document;
  * a void blocked by the API and the trigger;
  * immutability;
  * cancellation inside, then outside, the 24 hours;
  * RS256 signature verification with a test key pair;
  * viewer and tenant isolation.
* `apps/web/e2e/e-invoicing-flow.test.mjs` (5 tests), in the browser:
  * set-up;
  * a customer with city and PIN code;
  * JSON download, checked field by field;
  * a mismatched response refused;
  * the right response recorded, with the QR code drawn;
  * a void blocked;
  * the register;
  * the cancellation recorded and the invoice voided.

The demo data includes one IRN for a synthetic invoice. Its tokens are unsigned and made up, not issued by the IRP, so the app shows it as signature not verified.
