# Compliance document management (TAX-025)

**Tax → Compliance documents** keeps the documents behind the compliance calendar, and shows
which returns or payments still have none on file.

## Records

Each record has:

- a kind: acknowledgement, challan, copy of the return, working papers, registration certificate,
  notice or reply, or other;
- the return or payment it belongs to, which is a compliance-calendar obligation due in the last
  365 days or the next 30 (key, name and period as they were at the time). Registration
  certificates belong to the organisation and are not linked to an obligation;
- a title, a reference (ARN, CIN or challan number) and a note;
- a **keep until** date. This is the end of the eighth financial year after the year the period
  ends in, following section 128(5) of the Companies Act, 2013. Registration certificates have no
  date: they are kept while the registration lasts.

Files are attachments with entity `COMPLIANCE_DOCUMENT`, stored in `compliance_documents`
(migration `20270215100000_compliance_documents`). A record never changes. A record added by
mistake is voided with a reason and kept, and its files are then fixed. Every step is in the audit
trail, together with the files attached at the time.

## Missing documents

A return marked filed should have its **acknowledgement**, and a payment made should have its
**challan**. Done obligations due in the last 30–365 days without one are listed. An obligation
counts as covered only when a record of the right kind has at least one file attached
(`complianceDocumentGaps` in `packages/tax-engine/src/india/compliance-documents.ts`).

## API (`/v1/orgs/:orgId/compliance/documents`)

| Route | Permission |
| --- | --- |
| `GET /?kind&key&includeVoid` | reports.read |
| `GET /obligations` | reports.read |
| `GET /gaps?days=30..365` | reports.read |
| `GET /:id` | reports.read |
| `POST /` `{kind, obligationKey?, title, reference?, note?}` | accounts.manage |
| `POST /:id/void` `{reason}` | accounts.manage |

The API covers Indian organisations only. Nothing is filed, and no AI model is used.

## Not built

The following are not built yet:

- fetching acknowledgements from the GST or income-tax portals;
- linking obligations older than a year;
- reminders when a keep-until date passes.
