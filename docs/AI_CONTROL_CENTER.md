# AI control center

The AI control center (`/orgs/:orgId/ai-control`, under Governance) puts every AI agent in one place and gives owners and admins the controls over them. It is the governance layer over the four AI features built so far: the finance copilot, the collections agent, AI bank reconciliation and the month-end close review.

## What it shows

For the organisation:

* Whether AI is on, off or **stopped** (with the reason given), the provider and model, and who last changed it.
* This month's AI calls, tokens (input plus output), failures, work running now, and proposals waiting for a person. "This month" is the calendar month in India time.

For each agent:

* What it does and its **action level**, from the product brief:

  | Level | Meaning | Agents |
  |---|---|---|
  | 0 | Read-only analysis | Finance copilot |
  | 1 | Draft recommendations | none |
  | 2 | Prepare changes for approval | Collections, bank reconciliation, month-end close |
  | 3 | Execute approved low-risk workflows | none |
  | 4 | Execute authorised actions within strict limits | none |

  The level is fixed in code, not a setting. No agent posts, pays or sends anything without a person's approval.
* On or off, and its monthly token budget with a meter (amber from 80%, red when reached).
* Calls, tokens and failures this month, and when it was last used.
* **Acceptance rate** over the last 90 days, from what people did with its proposals:
  * collections: reminders sent (with or without edits) against reminders rejected;
  * bank reconciliation: suggestions accepted against suggestions a person dismissed (lines dealt with another way don't count);
  * month-end close: adjusting entries posted against entries rejected (superseded ones don't count).

  The copilot has no rate, because its answers are not approved or rejected.

## Controls

These need `org.manage` (owners and admins). Accountants and approvers can look (`audit.read`); viewers and employees cannot.

* **Turn an agent off or on.** An agent that is off refuses to start (`409 AGENT_OFF`). If it is switched off mid-run, the run stops before its next model call.
* **Monthly token budget** per agent, from 1,000 to 1,000,000,000 tokens, or none. Once usage this month reaches the budget, the agent refuses to start (`429 AI_BUDGET_REACHED`) and a running batch stops before its next call. A single call can take usage past the budget, because a call's size is only known once it returns.
* **Emergency stop.** This turns AI off for the whole organisation at once and needs a reason of at least 10 characters.
  * The reason is shown in every refusal until AI is turned back on: `409 AI_OFF`, or `COPILOT_OFF` for the copilot.
  * Nothing more is sent to the AI provider.
  * Work already running stops before its next model call, and what it had not reached is marked as not done (`AI_STOPPED`).
  * A month-end review whose answer arrives after the stop keeps its token usage but shows none of what it proposed.
  * Proposals already made stay for people to decide.
* **Turn AI back on.** This clears the stop. Turning AI on from the copilot page also clears it.

Every change is recorded in the audit trail: `ai.agent_updated` (with before and after), `ai.emergency_stop` (with the reason and how much was running) and `ai.resumed`.

## How agents are checked

`AiControlService.check(orgId, agent)` is the single guard. It checks four things:

1. the server has an AI key;
2. the organisation has AI on;
3. the agent is on;
4. the agent is under its budget.

Each agent calls the guard when it starts and again before every model call:

* each reminder;
* each bank line;
* each copilot tool round after the first;
* once more when the month-end review's answer arrives.

So every control takes effect on work that is already running, not only on new work.

## API

| Endpoint | Permission | What it does |
|---|---|---|
| `GET /v1/orgs/:orgId/ai-control` | audit.read | The overview above |
| `PUT …/ai-control/agents/:agent` `{ enabled, monthlyTokenLimit }` | org.manage | Switch and budget for `COPILOT`, `COLLECTIONS`, `BANKING` or `CLOSE` |
| `POST …/ai-control/stop` `{ reason }` | org.manage | Emergency stop (`409 AI_ALREADY_STOPPED`) |
| `POST …/ai-control/resume` | org.manage | Turn AI back on (`409 AI_ALREADY_ON`) |

## Data

* `ai_agent_settings` (one row per organisation and agent; no row means on with no budget), with RLS.
* `copilot_settings.off_reason`, which is set only while AI is off (CHECK constraint).
* Usage is worked out from the token counts already stored on each AI call. There is no separate counter that could drift.

## Not built yet

* Money cost. Tokens are tracked, but prices per model are not applied.
* A platform-wide stop across all organisations. Removing the server's `ANTHROPIC_API_KEY` stops only organisations without a key of their own.
* Accuracy against a labelled evaluation set.
* An orchestrator that hands work between agents.
* Agents above level 2.
