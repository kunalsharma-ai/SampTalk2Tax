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

## Setup assistant

The **Describe your business** card (UX-020 to UX-022) lets the owner say in their own words what the business does. The assistant reads the description and recommends:

- the profile: industry, size (from a head count such as "14 employees", or words such as "just me"), the accounting framework (Ind AS for a company that says it is listed in India) and the AI preference;
- setup steps that fit what was said: payroll for staff, TDS for contractors (India), currencies for foreign trade, contracts for recurring billing, dimensions for projects or branches, fixed assets, loans, a payment gateway, and an e-invoicing check for larger Indian businesses;
- plain notes where Talk2Tax does not cover something, such as stock quantities.

**Recommend setup** reads the description with word rules. **Recommend with AI** sends it to the organisation's AI model (when AI is on); the model only records findings, and each must quote the owner's own words: a finding whose quote is not in the description, or whose value is not on the lists, is dropped and the page says so. The recommendations themselves are always worked out by the same rules.

Nothing is applied on its own. Each recommendation is accepted or dismissed by an owner or admin; accepting a profile one saves that field (and an AI preference turns agents on or off). While a reading has undecided recommendations, the checklist's **Assistant recommendations** step is required and activation waits. A new reading replaces the previous one; after activation the assistant is closed.

API: `POST /v1/orgs/:orgId/setup/assistant` `{ description, useAi }` and `POST /v1/orgs/:orgId/setup/assistant/recommendations/:id` `{ decision: ACCEPTED | DISMISSED }`, both org.manage, audited as `setup.assistant_read`, `setup.recommendation_accepted` and `setup.recommendation_dismissed`. Tests: `packages/accounting-engine/test/onboarding-assistant.test.ts`, `apps/api/test/setup-assistant.e2e.test.ts`, `apps/web/e2e/setup-assistant-flow.test.mjs`.
