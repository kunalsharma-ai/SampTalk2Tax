# Connecting an external CRM: API keys, the CRM API and webhooks

CRM slice 6. Another system (a CRM such as HubSpot, Salesforce or Zoho, a website form, a
marketing tool) can work with Talk2Tax's leads, deals and customers in both directions, set up
entirely in the app under **Settings → Integrations**:

- **In:** the other system calls the **CRM API** with an **API key**.
- **Out:** Talk2Tax sends **CRM events** to the other system's address as signed **webhooks**.

Only owners and admins (`org.manage`) see and change these settings.

## API keys

| | |
| --- | --- |
| Format | `t2t_<8 lowercase letters or digits>_<40 letters or digits>` |
| Stored | Only a SHA-256 of the key, and its prefix to show in lists. The key is shown once, when made. |
| Scopes | `crm.read` (read leads, deals, customers) and `crm.write` (create and update leads and deals, change status, convert, move stage). |
| Acts as | The person who made it. Each call needs that person to still be a member whose role has the scope's permission (`sales.read` for read, `crm.manage` for write). A key stops working when they leave, and becomes read-only when their role no longer allows changes. |
| Expiry | Optional date; after it the key is refused. |
| Revoke | Once, immediately; a revoked key is kept (never deleted) with who revoked it. A database trigger allows a key only to record its use or its revocation. |
| Audit | Every change made with a key is in the audit trail as its creator, with `viaApiKey: { id, prefix }` in the event's data. Making and revoking keys are audited too. |
| Other rules | A suspended organisation or one without an active plan refuses changes; maintenance refuses changes; the organisation must be served in this region. |

## The CRM API

Base address: **`<app address>/api/crm`** (the web app forwards it with the key and nothing else;
no browser session is ever used), or `<API address>/v1/crm-api` directly. Send
`Authorization: Bearer t2t_…` on every call. Bodies and answers are JSON; money is a decimal
string, dates are `YYYY-MM-DD`.

| Call | Scope | What it does |
| --- | --- | --- |
| `GET /me` | read | The organisation, the key's scopes and whom it acts as. |
| `GET /leads?status=&ownerId=&q=` | read | Leads with counts by status. |
| `GET /leads/:id` | read | One lead with its timeline. |
| `POST /leads` | write | Create a lead: `name`, `source`, and optionally `company`, `email`, `phone`, `estimatedValue`, `notes`, `ownerId`, `externalRef`. |
| `PUT /leads/:id` | write | Update a lead. |
| `POST /leads/:id/status` | write | `{ status, reason? }`: contacted, qualified, disqualified (with a reason), reopened. |
| `POST /leads/:id/convert` | write | Convert a qualified lead into a customer (new or `contactId`), optionally with `deal`. |
| `GET /deals?stage=&view=&contactId=` | read | Deals with the pipeline summary. |
| `GET /deals/:id` | read | One deal. |
| `POST /deals` | write | Create a deal: `name`, `contactId`, `amount`, `expectedCloseDate`, optionally `stage`, `probability`, `ownerId`, `notes`, `externalRef`. |
| `PUT /deals/:id` | write | Update a deal. |
| `POST /deals/:id/stage` | write | `{ stage, probability?, lostReason? }`: move, win, lose or reopen. |
| `GET /customers?q=&includeInactive=` | read | Customers with what they owe. |
| `GET /customers/:id` | read | One customer. |

**No duplicates on retry.** Send the other system's own id as `externalRef` when creating a lead or
deal. If a lead (or deal) with that `externalRef` already exists in the organisation, it is
returned unchanged with **200** instead of **201**, so a retried or repeated call never makes a
copy. `externalRef` is unique per organisation (database index) and shown on the record.

The same rules apply as in the app: the same validation, stage rules, credit checks and errors
(`400` invalid body, `401` bad, revoked or expired key, `403` missing scope or permission, `404`
not found or another organisation's record, `409`/`422` business rules).

## CRM webhooks

| | |
| --- | --- |
| Events | `lead.created`, `lead.updated`, `lead.status_changed`, `lead.converted`, `deal.created`, `deal.updated`, `deal.stage_changed` (also reopened), `deal.won`, `deal.lost`, `customer.created`, `customer.updated` (customers only, not vendors). |
| Source | The audit trail: each webhook keeps the id of the last audit event it read, so every event is sent once, in order, and nothing is lost if the server restarts. A new webhook (or one turned back on) starts from now. |
| Body | `{ id, event, occurredAt, organisationId, test, data, object }`: `data` is what the audit trail recorded (the record's `id` and what changed), `object` is the record as it stands when the first attempt is made (usually within seconds). |
| Headers | `t2t-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the secret>`, `t2t-event`, `t2t-delivery` (the delivery id, the same on every attempt), `t2t-attempt`. |
| Secret | `whsec_…`, sealed with AES-256-GCM (the integrations key) and shown once; rotate it any time. |
| Delivery | Any 2xx is success. Otherwise it is tried again after 1 min, 5 min, 30 min, 2 h and 6 h (6 attempts); a 4xx other than 408/429 is final. Redirects are not followed. The address must be public `https://` (private networks only in development). |
| Log | The last 50 deliveries per webhook with status, attempts, HTTP status and error; a failed one can be sent again. **Send test** posts a `ping` and shows the answer. |
| Runner | `CRM_WEBHOOK_RUNNER_INTERVAL_SECONDS` (default 10; 0 turns it off). Appears in platform System health as "CRM webhooks". |

A receiver should check the signature and the timestamp (reject calls older than a few minutes),
and treat `t2t-delivery` as an idempotency key.

## Where it lives

- Engine: `packages/accounting-engine/src/crm-api.ts` (key format, scopes, event map).
- Migration: `20261122090000_crm_external_api` (`api_keys`, `crm_webhooks`, `crm_webhook_deliveries`, `crm_leads.external_ref`, `crm_deals.external_ref`, RLS, the key guard trigger).
- API: `apps/api/src/crm-api/` (key service and guard, CRM API controller, webhooks service and runner, settings controller at `v1/orgs/:orgId/crm-connection`).
- Web: `components/crm-connection/crm-connection.tsx` on Settings → Integrations; `app/api/crm/[...path]/route.ts`.
- Tests: `apps/api/test/crm-api.e2e.test.ts`, `apps/web/e2e/crm-connection-flow.test.mjs`, engine `test/crm-api.test.ts`.

## Not built yet

Ready-made connectors for named CRM platforms that map their objects automatically (the other
system, or a tool such as Zapier or Make, calls the API and receives webhooks); OAuth for third-party
apps; per-key rate limits beyond the server's general limit; quotations, orders and contracts in the
CRM API.
