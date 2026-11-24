import { addDays, fiscalYearForDate } from "@talk2tax/accounting-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInOrg } from "../src/common/tenant-context";
import { aiDecisionRecords } from "../src/db/collections/ai-decision-records";
import {
  bootApp,
  createOrg,
  Ctx,
  registerUser,
  TestUser,
  today,
} from "./helpers";

/**
 * DASH-052/062/065 against the real API and database: the payroll manager's runs, team, monthly
 * cost and unpaid dues; the AI agent administrator's agents, budgets and failed calls; the
 * financial analyst's key figures, biggest moves, monthly profit and quarters. Who may open
 * each, no bank details, isolation.
 */
const T = today();
const monthOf = (back: number) => {
  const x = new Date(`${T.slice(0, 7)}-01T00:00:00Z`);
  x.setUTCMonth(x.getUTCMonth() - back);
  return x.toISOString().slice(0, 7);
};
const [M2, M1, M0] = [monthOf(2), monthOf(1), monthOf(0)];
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const runs: Record<
  string,
  { id: string; number: string; totals: Record<string, string> }
> = {};
const structure = (from: string, amount: string) => ({
  effectiveFrom: `${from}-01`,
  components: [
    { code: "BASIC", name: "Basic", kind: "WAGES", monthlyAmount: amount },
  ],
});
const brief = async (
  role: string,
  auth = owner.auth,
  status = 200,
  base = org.base,
) =>
  (
    await ctx
      .http()
      .get(`${base}/reports/role-dashboards/${role}`)
      .set(auth)
      .expect(status)
  ).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, "People Owner");
  viewer = await registerUser(ctx, "People Viewer");
  outsider = await registerUser(ctx, "People Outsider");
  org = await createOrg(ctx, owner, { name: "People Dashboards Pvt Ltd" });
  other = await createOrg(ctx, outsider, { name: "Other People Ltd" });
  await ctx
    .http()
    .post(`${org.base}/members`)
    .set(owner.auth)
    .send({ email: viewer.email, role: "VIEWER" })
    .expect(201);
  for (const fy of new Set(
    [M2, M1, M0].map((m) => fiscalYearForDate(`${m}-01`, 4)),
  ))
    await ctx
      .http()
      .post(`${org.base}/periods/fiscal-years`)
      .set(owner.auth)
      .send({ fiscalYear: fy });
  // Payroll: two people, two posted runs and this month's draft; last month's net pay is paid.
  await ctx
    .http()
    .put(`${org.base}/payroll/settings`)
    .set(owner.auth)
    .send({})
    .expect(200);
  await ctx
    .http()
    .post(`${org.base}/payroll/employees`)
    .set(owner.auth)
    .send({
      code: "E001",
      name: "Asha Kulkarni",
      dateOfJoining: `${M2}-01`,
      structure: structure(M2, "30000"),
      bankAccountName: "Asha Kulkarni",
      bankAccountNumber: "50100012345678",
      bankIfsc: "HDFC0001234",
    })
    .expect(201);
  await ctx
    .http()
    .post(`${org.base}/payroll/employees`)
    .set(owner.auth)
    .send({
      code: "E002",
      name: "Ravi Shetty",
      dateOfJoining: `${M1}-01`,
      structure: structure(M1, "15000"),
    })
    .expect(201);
  for (const m of [M2, M1, M0]) {
    const id = (
      await ctx
        .http()
        .post(`${org.base}/payroll/runs`)
        .set(owner.auth)
        .send({ period: m, payDate: `${m}-28` })
        .expect(201)
    ).body.id;
    if (m !== M0)
      await ctx
        .http()
        .post(`${org.base}/payroll/runs/${id}/post`)
        .set(owner.auth)
        .expect(200);
    runs[m] = (
      await ctx
        .http()
        .get(`${org.base}/payroll/runs/${id}`)
        .set(owner.auth)
        .expect(200)
    ).body;
  }
  await ctx
    .http()
    .post(`${org.base}/payroll/runs/${runs[M1]!.id}/payments`)
    .set(owner.auth)
    .send({
      liability: "NET_PAY",
      date: `${M1}-28`,
      bankAccountId: org.acc["1120"],
      reference: "NEFT batch",
    })
    .expect(201);
  // Revenue in the last two months for the analyst.
  const customer = (
    await ctx
      .http()
      .post(`${org.base}/contacts`)
      .set(owner.auth)
      .send({ name: "Asha Traders", isCustomer: true })
      .expect(201)
  ).body.id;
  for (const [m, amount] of [
    [M2, "100000.00"],
    [M1, "150000.00"],
  ] as const)
    await ctx
      .http()
      .post(`${org.base}/sales/documents`)
      .set(owner.auth)
      .send({
        kind: "INVOICE",
        contactId: customer,
        issueDate: `${m}-10`,
        dueDate: addDays(`${m}-10`, 30),
        post: true,
        lines: [
          { accountId: org.acc["4100"], quantity: "1", unitPrice: amount },
        ],
      })
      .expect(201);
  // AI: the collections agent switched off with a budget, and one failed call on record.
  await ctx
    .http()
    .put(`${org.base}/ai-control/agents/COLLECTIONS`)
    .set(owner.auth)
    .send({ enabled: false, monthlyTokenLimit: 50000 })
    .expect(200);
  const at = new Date();
  await runInOrg(org.orgId, () =>
    ctx.store.collection(aiDecisionRecords).insertOne({
      agent: "COLLECTIONS",
      actingForUserId: null,
      keySource: "SERVER",
      modelRequested: "test-model",
      servedModel: null,
      promptVersion: "abcdef012345",
      toolsVersion: "abcdef012345",
      toolNames: [],
      dataSources: ["invoices"],
      subjectType: null,
      subjectId: null,
      explanation: null,
      reasoningWithheld: false,
      stopReason: null,
      outcome: "FAILED",
      errorName: "RateLimitError",
      inputTokens: 0,
      outputTokens: 0,
      startedAt: at,
      completedAt: at,
      durationMs: 0,
    } as never),
  );
});
afterAll(async () => {
  await ctx?.app.close();
});

describe("payroll, AI and analyst dashboards", () => {
  it("lists the new dashboards and says which a viewer may open", async () => {
    const forViewer = (
      await ctx
        .http()
        .get(`${org.base}/reports/role-dashboards`)
        .set(viewer.auth)
        .expect(200)
    ).body.roles as { role: string; available: boolean }[];
    expect(forViewer.slice(-3).map((r) => [r.role, r.available])).toEqual([
      ["PAYROLL_MANAGER", false],
      ["AI_ADMIN", false],
      ["ANALYST", true],
    ]);
    expect((await brief("PAYROLL_MANAGER", viewer.auth, 403)).message).toBe(
      "This dashboard needs access to payroll",
    );
    expect((await brief("AI_ADMIN", viewer.auth, 403)).message).toBe(
      "This dashboard needs access to audit and AI controls",
    );
  });

  it("gives the payroll manager this month's run, the team, the cost by month and unpaid dues", async () => {
    const r = await brief("PAYROLL_MANAGER");
    expect(r).toMatchObject({
      role: "PAYROLL_MANAGER",
      name: "Payroll manager",
    });
    const v = r.payroll;
    expect(v.thisMonth).toMatchObject({
      id: runs[M0]!.id,
      status: "DRAFT",
      employees: 2,
    });
    expect(v.team.active).toBe(2);
    expect(
      v.runs.map((x: { period: string; status: string }) => [
        x.period,
        x.status,
      ]),
    ).toEqual([
      [M0, "DRAFT"],
      [M1, "POSTED"],
      [M2, "POSTED"],
    ]);
    expect(v.drafts).toEqual([
      { id: runs[M0]!.id, number: runs[M0]!.number, period: M0, missing: 0 },
    ]);
    // Last month's net pay is paid; the month before has net pay and its dues still open.
    const open = v.unpaid.items.map(
      (u: { period: string; liability: string }) =>
        `${u.period} ${u.liability}`,
    );
    expect(open).not.toContain(`${M1} NET_PAY`);
    expect(open).toContain(`${M2} NET_PAY`);
    expect(
      v.unpaid.items.find(
        (u: { period: string; liability: string }) =>
          u.period === M2 && u.liability === "NET_PAY",
      ).amount,
    ).toBe(runs[M2]!.totals.net);
    expect(
      v.cost.byMonth.map(
        (m: { period: string; employees: number; gross: string }) => [
          m.period,
          m.employees,
          m.gross,
        ],
      ),
    ).toEqual([
      [M2, 1, "30000.00"],
      [M1, 2, "45000.00"],
    ]);
    expect(v.cost.byMonth[1]).toMatchObject({
      grossChange: "50.0",
      flagged: true,
    });
    expect(JSON.stringify(r)).not.toContain("50100012345678");
  });

  it("gives the AI administrator each agent, its budget and the failed calls", async () => {
    const v = (await brief("AI_ADMIN")).ai;
    expect(v).toMatchObject({
      enabled: false,
      stopped: false,
      platformStopped: false,
      totals: { calls: 0, failed: 0 },
    });
    expect(v.agents.map((a: { key: string }) => a.key)).toEqual([
      "COPILOT",
      "COLLECTIONS",
      "BANKING",
      "CLOSE",
      "CFO",
    ]);
    expect(
      v.agents.find((a: { key: string }) => a.key === "COLLECTIONS"),
    ).toMatchObject({
      name: "Collections agent",
      enabled: false,
      monthlyTokenLimit: 50000,
      percentOfBudget: 0,
      budgetReached: false,
      nearBudget: false,
      calls: 0,
      cost: "0.0000",
    });
    expect(v.failures).toEqual([
      expect.objectContaining({
        agent: "Collections assistant",
        errorName: "RateLimitError",
        model: "test-model",
      }),
    ]);
    // Another organisation sees none of it.
    expect(
      (await brief("AI_ADMIN", outsider.auth, 200, other.base)).ai.failures,
    ).toEqual([]);
  });

  it("gives the analyst every key figure, the biggest moves, monthly profit and quarters", async () => {
    const v = (await brief("ANALYST", viewer.auth)).analyst;
    expect(v.month).toBe(M1); // the last full month
    expect(v.metrics.map((m: { key: string }) => m.key)).toContain("dso");
    const rev = v.metrics.find((m: { key: string }) => m.key === "revenue");
    expect(rev).toMatchObject({ group: "GROWTH", unit: "MONEY" });
    expect(v.monthly).toHaveLength(12);
    const byMonth = Object.fromEntries(
      v.monthly.map(
        (m: { month: string; revenue: string; grossMargin: string | null }) => [
          m.month,
          [m.revenue, m.grossMargin],
        ],
      ),
    );
    expect(byMonth[M2]).toEqual(["100000.00", "100.0"]);
    expect(byMonth[M1]).toEqual(["150000.00", "100.0"]);
    expect(v.twelveMonths).toMatchObject({
      revenue: "250000.00",
      grossProfit: "250000.00",
    });
    expect(v.quarters.length).toBeGreaterThanOrEqual(4);
    expect(v.customers).toMatchObject({ largestShare: "100.0", band: "HIGH" });
    for (const m of v.movers) expect(Number(m.changePercent)).not.toBeNaN();
  });

  it("keeps members of other organisations and people without reports out", async () => {
    await brief("ANALYST", outsider.auth, 404);
    await brief("PAYROLL_MANAGER", outsider.auth, 404);
  });
});
