/**
 * Browser end-to-end test for the payroll manager, AI agent administrator and financial analyst
 * dashboards (DASH-052/062/065): an owner with two posted pay runs (last month's salaries paid),
 * this month's draft run, invoices in the last two months and the collections agent switched off
 * reads each dashboard, then opens an unpaid run from the payroll dashboard. Real Next.js app →
 * real API → real MongoDB.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { chromium } from "playwright";

const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
let consoleErrors = [];
const call = (path, body, method = body ? "POST" : "GET") =>
  page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, {
        method: m,
        headers: { "content-type": "application/json", "x-t2t-csrf": "1" },
        body: b ? JSON.stringify(b) : undefined,
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
const ok = (r, what) => {
  assert.ok(r.status < 300, `${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const monthOf = (back) => {
  const x = new Date(`${T.slice(0, 7)}-01T00:00:00Z`);
  x.setUTCMonth(x.getUTCMonth() - back);
  return x.toISOString().slice(0, 7);
};
const [M2, M1, M0] = [monthOf(2), monthOf(1), monthOf(0)];
const structure = (from, amount) => ({
  effectiveFrom: `${from}-01`,
  components: [
    { code: "BASIC", name: "Basic", kind: "WAGES", monthlyAmount: amount },
  ],
});

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
    reducedMotion: "reduce",
  });
  page.on(
    "console",
    (m) => m.type() === "error" && consoleErrors.push(m.text()),
  );
});
after(async () => browser?.close());

test("an owner reads the payroll, AI agent and financial analyst dashboards", async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel("Full name").fill("Dev People");
  await page
    .getByLabel("Email")
    .fill(`e2e-people-${randomUUID()}@example.test`);
  await page.getByLabel("Password").fill("e2e-very-long-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel("Organisation name").fill("E2E People Traders");
  await page.getByRole("button", { name: "Create organisation" }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split("/").pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries(
    ok(await call(`${base}/accounts`), "accounts").map((a) => [a.code, a.id]),
  );
  const periods = ok(await call(`${base}/periods`), "periods");
  if (!periods.some((p) => p.startDate <= `${M2}-01`))
    await call(`${base}/periods/fiscal-years`, {
      fiscalYear: Number(periods[0].startDate.slice(0, 4)) - 1,
    });
  ok(await call(`${base}/payroll/settings`, {}, "PUT"), "payroll settings");
  ok(
    await call(`${base}/payroll/employees`, {
      code: "E001",
      name: "Asha Kulkarni",
      dateOfJoining: `${M2}-01`,
      structure: structure(M2, "30000"),
    }),
    "employee 1",
  );
  ok(
    await call(`${base}/payroll/employees`, {
      code: "E002",
      name: "Ravi Shetty",
      dateOfJoining: `${M1}-01`,
      structure: structure(M1, "15000"),
    }),
    "employee 2",
  );
  const runs = {};
  for (const m of [M2, M1, M0]) {
    runs[m] = ok(
      await call(`${base}/payroll/runs`, { period: m, payDate: `${m}-28` }),
      `run ${m}`,
    );
    if (m !== M0)
      ok(
        await call(`${base}/payroll/runs/${runs[m].id}/post`, {}),
        `post ${m}`,
      );
  }
  ok(
    await call(`${base}/payroll/runs/${runs[M1].id}/payments`, {
      liability: "NET_PAY",
      date: `${M1}-28`,
      bankAccountId: acc["1120"],
      reference: "NEFT batch",
    }),
    "pay net",
  );
  const customer = ok(
    await call(`${base}/contacts`, { name: "Asha Traders", isCustomer: true }),
    "customer",
  ).id;
  for (const [m, amount] of [
    [M2, "100000.00"],
    [M1, "150000.00"],
  ])
    ok(
      await call(`${base}/sales/documents`, {
        kind: "INVOICE",
        contactId: customer,
        issueDate: `${m}-10`,
        dueDate: `${m}-25`,
        post: true,
        lines: [{ accountId: acc["4100"], quantity: "1", unitPrice: amount }],
      }),
      `invoice ${m}`,
    );
  ok(
    await call(
      `${base}/ai-control/agents/COLLECTIONS`,
      { enabled: false, monthlyTokenLimit: 50000 },
      "PUT",
    ),
    "agent",
  );
  consoleErrors = [];
  const shot = async (name) =>
    SHOTS &&
    (await page.screenshot({
      path: `${SHOTS}/role-dashboards-${name}.png`,
      fullPage: true,
    }));

  // Payroll: this month's draft, the unpaid run of two months ago, cost by month.
  await page.goto(
    `${WEB}/orgs/${orgId}/reports/role-dashboards?role=PAYROLL_MANAGER`,
  );
  const tabs = page.getByRole("tablist", { name: "Dashboard for" });
  await page
    .getByRole("group", { name: "People on payroll" })
    .getByText("2", { exact: true })
    .waitFor();
  const pay = page.getByRole("table", { name: "Payroll by month" });
  await pay.getByRole("row").nth(2).waitFor();
  assert.equal(await pay.getByRole("row").count(), 3);
  await pay.getByRole("row", { name: /50\.0% \(check\)/ }).waitFor();
  const unpaid = page.getByRole("table", { name: "Unpaid salaries and dues" });
  await unpaid.getByRole("row", { name: /Net salaries/ }).waitFor();
  assert.equal(
    await unpaid.getByRole("row", { name: /Net salaries/ }).count(),
    1,
  );
  await shot("payroll");

  // AI agents: the collections agent is off with a budget.
  await tabs.getByRole("tab", { name: "AI agents", exact: true }).click();
  await page.waitForURL(/role=AI_ADMIN/);
  await page
    .getByRole("table", { name: "AI agents" })
    .getByRole("row", { name: /Collections agent.*off.*0% of 50,000/ })
    .waitFor();
  await page
    .getByRole("region", { name: "Recent failed AI calls" })
    .getByText("No AI call has failed.")
    .waitFor();
  await shot("ai-agents");

  // Analyst: key figures, monthly profit and quarters.
  await tabs
    .getByRole("tab", { name: "Financial analyst", exact: true })
    .click();
  await page.waitForURL(/role=ANALYST/);
  await page
    .getByRole("table", { name: "Key figures" })
    .getByRole("row", { name: /Days sales outstanding/ })
    .waitFor();
  const profit = page.getByRole("table", { name: "Profit by month" });
  await profit.getByRole("row", { name: /12 months/ }).waitFor();
  assert.equal(await profit.getByRole("row").count(), 14);
  await page
    .getByRole("table", { name: "Largest customers" })
    .getByRole("row", { name: /Asha Traders.*100\.0%/ })
    .waitFor();
  await page
    .getByRole("img", {
      name: /Revenue by month as bars with gross and operating margin/,
    })
    .waitFor();
  await shot("analyst");

  // Back to payroll, and open the unpaid run.
  await tabs.getByRole("tab", { name: "Payroll", exact: true }).click();
  await unpaid
    .getByRole("row", { name: /Net salaries/ })
    .getByRole("link")
    .click();
  await page.waitForURL(new RegExp(`/payroll/runs/${runs[M2].id}$`));
  assert.deepEqual(consoleErrors, []);
});
