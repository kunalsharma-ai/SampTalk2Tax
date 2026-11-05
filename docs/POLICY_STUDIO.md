# Policy studio

The policy studio turns a financial policy written in plain words into rules that run, with tests that show the rules do what the words say.

For example, the policy *"Bills over ₹5 lakh need an approver's review within two days"* becomes a rule that runs whenever a bill is posted. When the bill's total is over ₹5 lakh, the rule gives approvers a review task due in two days. Two tests check it: a ₹6 lakh bill should get a task, and a bill of exactly ₹5 lakh should not.

**Governance → Policy studio** (`/orgs/:orgId/governance/policies`).

## A policy

A policy has:

* a name and the policy in words;
* up to 10 **rules**. Each rule is an ordinary [workflow](WORKFLOW_AUTOMATIONS.md) definition:
  * a trigger (something recorded, a schedule, an overdue invoice or a bill falling due);
  * conditions that must all hold;
  * up to 10 actions: a task, an email or a webhook.

  Policy tasks and emails go to a **role**, or to the customer or vendor. They never go to one named person, so the policy keeps working when people change.
* up to 30 **tests**. Each test names a rule, gives values for the facts the rule looks at, and says whether the rule should act. Facts left empty count as empty, so a money condition on them does not hold.

Policies are numbered POL-0001 and so on, and names are unique per organisation.

Every rule is shown in plain words for checking before approval. For example: *A bill is posted, and total is more than INR 500000.00: give Approvers a task "Review bill {{number}} from {{contactName}}", due in 2 days.*

## Checking and testing

* **Run the tests** checks the policy without saving it. It shows:
  * every problem in words, such as *Rule 1: … colour …* or *Test 2: Total must be an amount such as 500000.00*;
  * each rule in words;
  * each test's result, with every condition's actual value, for example *Total is more than 500000 (is 500000.00)*.
* **Back-test on the last 90 days** runs each rule that is triggered by something recorded over the organisation's real events from the last 90 days (up to 500 per rule). It shows how many events the rule would have acted on, with examples. Rules on a schedule or a due date are not back-tested.

## Drafting with AI

**Draft with AI** sends the policy in words to Claude. Claude proposes:

* a name;
* a short summary;
* the rules and tests;
* questions about anything unclear, such as an amount, who should act or how quickly.

When something is unclear, Claude makes a sensible assumption, uses it, and asks about it. The person answers and chooses **Revise the draft**, which sends the conversation so far, up to 20 messages.

The draft is checked like any policy and its tests are run. Problems are shown, not hidden. **Use this draft** copies the rules and tests into the editor.

Nothing the AI proposes is saved, and nothing runs. A person saves the policy, and someone else approves it.

Drafting rules:

* It is done by the copilot, so it follows the copilot's on/off switch, the emergency stop and the monthly token budget in the [AI control center](AI_CONTROL_CENTER.md). Its calls and tokens count towards the copilot's usage there.
* Each call is recorded in `policy_ai_drafts`, with:
  * the request;
  * the result or the error;
  * the model;
  * the tokens used.
* Each call is also audited as `policy.ai_drafted` or `policy.ai_draft_failed`, with the prompt version (`policy-draft-1`).
* The AI key is set in **Settings → Integrations**. Without one, the editor says so and everything else still works.

## Approval, versions and retiring

1. **Saving** makes a new version, and the policy waits for approval. If the policy is already running, the approved version keeps running in the meantime. A save that started from an older version is refused, so two people cannot overwrite each other.
2. **Approving** needs:
   * `workflows.manage` (owners and admins);
   * every test passing;
   * an approver who is not the person who made the last change.

   On approval, rule *n* runs as the policy's *n*-th workflow, named "POL-0001 · rule name". Approval either creates that workflow or gives it a new version, and then turns it on. Workflows of rules the policy no longer has are turned off.
3. **Retiring** turns every workflow the policy runs off and keeps the history. A retired policy can be edited and approved again.

Every version is kept as it was, and the database refuses any change or delete. Each version records:

* the event: *created*, *edited*, *approved* or *retired*;
* the name, words, rules and tests;
* a note;
* who made it and when.

The audit trail has `policy.created`, `policy.updated` (with before and after), `policy.approved` and `policy.retired`.

## API

| Route | Permission | |
| --- | --- | --- |
| `GET /v1/orgs/:orgId/policies`, `GET …/policies/:id` | `reports.read` | Policies with rules in words and test results. The detail adds its workflows, versions and people |
| `GET …/policies/catalogue` | `reports.read` | The workflow builder's triggers, facts, operators and roles, with the policy limits |
| `POST …/policies/check` | `reports.read` | Checks a policy being edited and runs its tests without saving |
| `POST …/policies/backtest` `{ rules }`, `GET …/policies/:id/backtest` | `reports.read` | Rules against the last 90 days of events |
| `POST …/policies`, `PUT …/policies/:id` `{ …, baseVersion }` | `policies.manage` (owners, admins, accountants) | Create, or save a new version. 422 with `details.issues` when the policy does not make sense; 409 `POLICY_CHANGED` for a stale save |
| `POST …/policies/:id/approve` `{ version, note }` | `workflows.manage` | 403 `SELF_APPROVAL`, 422 `TESTS_FAILING`, 409 when the version is not the latest |
| `POST …/policies/:id/retire` `{ note }` | `workflows.manage` | Turns the workflows off |
| `GET …/policies/ai-status`, `POST …/policies/ai-draft` `{ statement, conversation }` | `reports.read`; drafting needs `policies.manage` | 503 `AI_NOT_CONFIGURED`, 409 when AI is off, 422 `REFUSED` or `NO_PROPOSAL` |

## Tests

* `packages/accounting-engine/test/policies.test.ts` (3) covers:
  * checking rules and tests against the trigger's facts;
  * test results with each condition's actual value;
  * rules in plain words.
* `apps/api/test/policies.e2e.test.ts` (11) covers:
  * validation, and the rule that policy work goes to roles only;
  * checking without saving;
  * saving;
  * a back-test against posted bills;
  * the self-approval block, the accountant block and the failing-tests block;
  * approval creating an enabled workflow, a new version updating it and adding a second one, and a dropped rule's workflow being turned off;
  * retiring;
  * the audit trail and immutable versions;
  * AI drafts, using a scripted model in place of Claude, including a problem draft, a conversation and a refusal, counted in the AI control center;
  * AI not set up, off or stopped;
  * permissions and tenant isolation.
* `apps/web/e2e/policy-studio-flow.test.mjs` runs in the browser:
  1. An accountant writes a policy, finds a wrong test with *Run the tests*, fixes it, back-tests it against real bills and saves it.
  2. The owner approves it into a running automation and retires it.

## Limitations

* Rules can only do what workflows can do: the triggers, facts, conditions and actions of the workflow builder. A policy that needs something else, such as blocking a payment, is written as a task for a person.
* Back-tests read the audit trail. Events from before the last 90 days, and rules on a schedule or a due date, are not back-tested.
* Live AI drafting waits on a Claude key (tests use a scripted model). The AI never approves or turns on anything.
