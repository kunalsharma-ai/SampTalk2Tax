# AI workload isolation (PERF-005)

Every AI call Talk2Tax makes, whichever assistant makes it and whichever key it uses, goes through the server's AI work lanes (`apps/api/src/ai-work/ai-work-pool.service.ts`, wrapped around the model in `UsageService.metered`). The lanes keep AI work from taking capacity people are waiting on, and keep one organisation's AI work from taking it from the others.

## Lanes

- **People waiting on an answer** (`INTERACTIVE`): the copilot, the policy, dashboard and report drafters, the setup assistant, and any call Talk2Tax cannot name.
- **Background work** (`BACKGROUND`): bank line runs, payment reminders, month-end reviews and the CFO report summary.

The lane comes from the agent (`aiLaneFor` in `packages/accounting-engine/src/ai-work-lanes.ts`).

## Rules

- At most `AI_MAX_CONCURRENT` calls run at once on a server (default 16).
- Background work runs at most `AI_MAX_BACKGROUND` of those (default 8). It must be below the total, which the server checks when it starts, so people always have room however much background work is queued.
- One organisation runs at most `AI_MAX_PER_ORG` calls at once (default 4).
- When there is no room, a call waits in line. People's calls start before background work, each in the order they arrived. A call whose organisation is at its share does not hold back the calls behind it.
- A call that waits longer than `AI_WAIT_SECONDS` (default 30) or, for background work, `AI_BACKGROUND_WAIT_SECONDS` (default 600) is turned away with `503 AI_BUSY` and `Retry-After`. The copilot tells the member the AI is busy; background runs treat it like any other AI error from the model's service.
- A turned-away call gets a decision record with the error `AiBusyError`, so it shows under Governance → AI performance (PERF-020). It is not counted against the plan's AI requests. The time a call took counts from when it started, not from when it joined the line.

## Watching it

Platform admin → System health has an **AI work** card: running and waiting calls per lane, how many had to wait, the longest wait, and how many were turned away. Calls turned away in the last 15 minutes are listed under the page's problems, with the advice to raise `AI_MAX_CONCURRENT` or add servers.

The lanes are in memory, per server. With several API servers, each keeps its own limits, so the total across servers is the per-server limit times the number of servers.

## Tests

- `packages/accounting-engine/test/ai-work-lanes.test.ts`: lanes, room kept for people, per-organisation share, order of starting, limit checks.
- `apps/api/test/ai-work-isolation.e2e.test.ts`: against the real API and database with a model whose answers the test holds: background held to its lane while a person's call starts, one organisation held to its share without holding back another, a call turned away after waiting with its decision record in AI performance, the copilot saying the AI is busy, System health showing the lanes, and limits that leave no room for people refused at start.
- `apps/web/e2e/operations-flow.test.mjs`: System health shows the AI work lanes and this server's limits.
