# Explainable AI ledger: decision records

Covers AUDIT-018, AUDIT-020, AUDIT-021, AUDIT-027, AUDIT-029 and AUDIT-030.

Every call Talk2Tax makes to an AI model gets a **decision record**. Calls that fail get one too. The record is written in one place, the usage meter that wraps every organisation's model (`UsageService.metered`), so no AI feature can skip it.

Find the records under Governance → AI activity → **Decision records**. They can be filtered by agent and paged by time. The API is `GET /v1/orgs/:orgId/ai-decisions?agent=&subjectId=&outcome=&limit=&before=`, which needs `audit.read`.

## What a record holds

| Requirement | Field |
| --- | --- |
| Agent identity (AUDIT-018) | `agent`: Copilot, Bank line assistant, Month-end reviewer, Collections assistant, CFO report writer, Policy drafter, Dashboard drafter, Report designer, Setup assistant. The caller names the agent, or it is worked out from the tool the model was made to answer with. Also `actingForUserId` (the member the call was made for, taken from the request's opaque user id) and `keySource` (the organisation's own key, or Talk2Tax's). |
| Prompt or policy version (AUDIT-020) | `promptVersion`: the first 12 hex digits of the SHA-256 of the exact system prompt sent. `toolsVersion`: the same for the tool definitions sent. `toolNames`. The same instructions always give the same version, so a change to a prompt or tool shows as a new version. The model requested and the model that answered are also kept. |
| Data sources (AUDIT-021) | `dataSources`: the caller describes the data it gave, such as "Bank line 2026-11-19: BANK SERVICE FEE" or "31 accounts". The ledger adds every tool result the model read in that call ("Tool: get_income_statement"). `subjectType` and `subjectId` name the record the call was about (a bank suggestion, close review, reminder draft, CFO report or copilot answer). |
| Timestamp (AUDIT-027) | `startedAt`, `completedAt`, `durationMs`. |
| No hidden chain of thought (AUDIT-029) | Thinking and redacted-thinking blocks are never read into the record or returned by any endpoint. `reasoningWithheld` only says that there was some. The copilot keeps the provider's own message blocks for the next turn of a conversation, because the provider needs them. No endpoint returns them. |
| Concise explanation (AUDIT-030) | `explanation` (up to 500 characters) is the model's own stated reason: the `reason`, `explanation`, `rationale`, `why`, `summary` or `note` field of the tool it answered with. Otherwise it is "Used <tool>", or the start of its text. Copilot answers are private to the member who asked, so for the copilot the record keeps only the fact of the answer, never its words. |

The record also keeps the outcome (`ANSWERED` or `FAILED`), the error class of a failed call, the stop reason and the tokens used.

## Integrity

* Collection `ai_decision_records` (migration `20270206100000_ai_decision_records`). Its guards refuse any change or deletion.
* Records are tenant-scoped like everything else.
* Writing a record never blocks the AI call. If the write fails, the failure is logged as an error.

## Code and tests

* Engine: `packages/accounting-engine/src/ai-decision-records.ts`, `test/ai-decision-records.test.ts`
* API:
  * `apps/api/src/usage/usage.service.ts` (`decisionRecord`)
  * `apps/api/src/ai-decisions/`
  * callers pass `record` in `model.send` options: copilot, bank AI, close review, collections, CFO
  * `test/ai-decisions.e2e.test.ts`
* Web: `apps/web/src/components/ai/decision-records.tsx`, `e2e/ai-decision-records-flow.test.mjs`
