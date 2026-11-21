# Organisation setup

Governance → **Organisation setup** (`/orgs/:orgId/setup`) is where a new organisation is made ready for day-to-day use (UX-004 to UX-006, UX-014, UX-017 to UX-019). Until it is activated, the dashboard shows a **Finish setting up** notice that links here.

## Business profile

- **Industry** and **business size** use the same lists as peer benchmarking, so one answer serves both.
- **Accounting framework**: Ind AS, Indian GAAP (AS), IFRS, IFRS for SMEs, US GAAP, FRS 102, FRS 105 or another local framework. Only frameworks used in the organisation's country (or used anywhere) are offered, and the API refuses others (422).
- **AI agents**: how much the agents do from the start.
  - *Off*: no agent runs.
  - *Answers and drafts*: agents with action level 0 or 1 (copilot, virtual CFO) are on; agents that prepare changes (collections, banking, close) stay off.
  - *Prepare work for approval*: every agent is on.
  Every AI action still needs a person's approval. Saving the profile turns agents on or off in the AI control center and keeps their budgets.
- **Use the suggestions** fills the framework and AI preference from the country and the size chosen (for India: Ind AS for large businesses, AS otherwise). Suggestions are applied only when a person saves, and the framework is for the accountant to confirm.

Only an owner or admin (`org.manage`) can save the profile. Every save is recorded in the audit trail as `setup.profile_saved`.

## Setup checklist

Worked out from the books each time the page opens; nothing is ticked by hand.

| Step | Required | Done when |
| --- | --- | --- |
| Business profile | Yes | Industry and size saved |
| Accounting framework | Yes | Framework saved |
| Fiscal year | Yes | At least one fiscal period |
| Bank account | Yes | At least one bank account in the chart |
| GST registration (India) / Tax rates | India only | GSTIN saved / tax rates set up |
| AI preferences | Yes | AI preference saved |
| Opening balances | No | Opening balances posted |
| Customers and vendors | No | At least one contact |
| Team | No | More than one member |
| Approval rules | No | At least one rule on |
| Email | No | Mail server configured |

Each open step links to the page where it is done.

## Activation

**Activate organisation** appears once every required step is done. It records who activated the organisation and when (`setup.activated` in the audit trail). It can be done once: a second attempt returns 409, and the record cannot be changed or deleted. Activation while a step is open returns 422 `SETUP_INCOMPLETE` with the missing steps.

## API

- `GET /v1/orgs/:orgId/setup` (accounts.read): profile, suggestions, options, checks and activation.
- `PUT /v1/orgs/:orgId/setup/profile` (org.manage): `{ industry, size, framework, aiPreference }`.
- `POST /v1/orgs/:orgId/setup/activate` (org.manage).

Tests: `packages/accounting-engine/test/setup.test.ts`, `apps/api/test/setup.e2e.test.ts`, `apps/web/e2e/setup-flow.test.mjs`.
