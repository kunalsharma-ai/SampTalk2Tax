import { monthLabel } from "./cfo";
import { assessImpact, type ImpactChange, type ImpactDelta } from "./impact";
import { D, type Dec } from "./money";
import { TwinError, type TwinBaseline } from "./twin";

/**
 * Opportunity intelligence: profitable growth opportunities found in the organisation's own
 * books, each sized from named records and measured with the business impact engine (and so the
 * digital twin), never guessed. Four kinds are looked for:
 *  - WIN_BACK: customers who bought regularly earlier in the year and have stopped;
 *  - CROSS_SELL: a revenue line many customers buy that active customers do not;
 *  - GROW_SEGMENT: the department or project with the best margin, grown at its own margin;
 *  - MARGIN_RECOVERY: gross margin that has slipped, restored by a price change.
 * Every kind that finds nothing says why, so an empty list is an answer rather than a silence.
 * The rates (how many lapsed customers come back, how many take up a line, how much a segment
 * grows) are the user's to set; the defaults are deliberately modest.
 */

export const OPPORTUNITY_KINDS = [
  "WIN_BACK",
  "CROSS_SELL",
  "GROW_SEGMENT",
  "MARGIN_RECOVERY",
] as const;
export type OpportunityKind = (typeof OPPORTUNITY_KINDS)[number];

export const OPPORTUNITY_INFO: Record<
  OpportunityKind,
  { label: string; description: string }
> = {
  WIN_BACK: {
    label: "Win back lapsed customers",
    description:
      "Customers who bought in at least two of the earlier nine months and nothing in the last three.",
  },
  CROSS_SELL: {
    label: "Sell an existing line to more customers",
    description:
      "A revenue line at least three customers buy, offered to active customers who do not buy it yet.",
  },
  GROW_SEGMENT: {
    label: "Grow the most profitable segment",
    description:
      "The department or project with the best margin, grown at its own margin.",
  },
  MARGIN_RECOVERY: {
    label: "Recover gross margin",
    description:
      "Gross margin in the last three months below the nine months before, restored by a price change.",
  },
};

export interface OpportunitySettings {
  /** Share of lapsed customers' former monthly sales expected back (%). */
  winBackRatePercent: string;
  /** Share of target customers expected to take up the line (%). */
  crossSellRatePercent: string;
  /** Growth of the best segment's sales (%). */
  segmentGrowthPercent: string;
}

export const DEFAULT_OPPORTUNITY_SETTINGS: OpportunitySettings = {
  winBackRatePercent: "25",
  crossSellRatePercent: "15",
  segmentGrowthPercent: "10",
};

export interface OpportunityCustomer {
  contactId: string;
  name: string;
  /** Net sales before tax per month of the window (same order as `months`). */
  byMonth: string[];
  /** Net sales before tax per revenue account over the whole window. */
  byLine: Record<string, string>;
}

export interface OpportunityInput {
  /** The twin baseline the opportunities are measured on. */
  baseline: TwinBaseline;
  horizonMonths: number;
  cashBuffer?: string | null;
  /** The twelve complete months the opportunities are looked for in, oldest first (YYYY-MM). */
  months: string[];
  /** Revenue and cost of sales per month of the window, for the margin trend. */
  margins: { revenue: string; costOfSales: string }[];
  customers: OpportunityCustomer[];
  lines: { accountId: string; code: string; name: string }[];
  /** Departments and projects with their revenue and costs over the window. */
  segments: {
    kind: "DEPARTMENT" | "PROJECT";
    id: string;
    code: string;
    name: string;
    revenue: string;
    costs: string;
  }[];
  settings: OpportunitySettings;
}

export interface Opportunity {
  key: string;
  kind: OpportunityKind;
  title: string;
  /** What was found, in words, with the figures it rests on. */
  finding: string;
  /** The records it rests on. */
  evidence: { columns: string[]; rows: string[][] };
  assumptions: string[];
  confidence: "HIGH" | "MEDIUM" | "LOW";
  confidenceReason: string;
  /** The business change it amounts to, as the impact engine takes it. */
  changes: ImpactChange[];
  /** Measured over the horizon against carrying on as is. */
  effect: ImpactDelta;
  summary: string;
}

export interface OpportunityCheck {
  kind: OpportunityKind;
  label: string;
  found: number;
  /** Why nothing was found, or what was found. */
  note: string;
}

export interface OpportunityResult {
  window: { from: string; to: string };
  settings: OpportunitySettings;
  opportunities: Opportunity[];
  checks: OpportunityCheck[];
  summary: string;
}

const NUM = /^\d{1,3}(\.\d{1,2})?$/;
const dec = (v: string | Dec) => new D(v);

export function checkOpportunitySettings(s: OpportunitySettings): string[] {
  const issues: string[] = [];
  const pct = (v: unknown, label: string) => {
    if (
      typeof v !== "string" ||
      !NUM.test(v) ||
      dec(v).lte(0) ||
      dec(v).gt(100)
    )
      issues.push(`${label} must be a number above 0 and at most 100`);
  };
  pct(s.winBackRatePercent, "Lapsed customers’ sales won back (%)");
  pct(s.crossSellRatePercent, "Customers taking up the line (%)");
  pct(s.segmentGrowthPercent, "Growth of the best segment (%)");
  return issues;
}

/** Looks for growth opportunities in the books and measures each one. */
export function findOpportunities(input: OpportunityInput): OpportunityResult {
  const issues = checkOpportunitySettings(input.settings);
  if (issues.length) throw new TwinError("Some settings need fixing", issues);
  if (
    input.months.length !== 12 ||
    input.margins.length !== 12 ||
    input.customers.some((c) => c.byMonth.length !== 12)
  )
    throw new TwinError("Opportunities need twelve months of figures");
  const scale = input.baseline.scale;
  const cur = input.baseline.currency;
  const money = (v: Dec | string) =>
    `${cur} ${dec(v).abs().toDecimalPlaces(scale, D.ROUND_HALF_UP).toFixed(scale)}`;
  const amt = (v: Dec) =>
    v.toDecimalPlaces(scale, D.ROUND_HALF_UP).toFixed(scale);
  const sum = (xs: readonly string[]) =>
    xs.reduce((a, x) => a.plus(x), new D(0));
  const s = input.settings;
  const months = input.months;
  const earlier = `${monthLabel(months[0]!)} to ${monthLabel(months[8]!)}`;
  const recent = `${monthLabel(months[9]!)} to ${monthLabel(months[11]!)}`;
  const activeMonths = input.margins.filter(
    (m) => !dec(m.revenue).isZero(),
  ).length;
  const thin = activeMonths < 9;
  const measure = (changes: ImpactChange[]) =>
    assessImpact({
      baseline: input.baseline,
      horizonMonths: input.horizonMonths,
      cashBuffer: input.cashBuffer,
      customers: [],
      suppliers: [],
      changes,
    });
  const found: Opportunity[] = [];
  const checks: OpportunityCheck[] = [];
  const finish = (o: Omit<Opportunity, "effect" | "summary">) => {
    const r = measure(o.changes);
    const e = r.change;
    const profit = dec(e.netProfit);
    const summary = `Over ${input.horizonMonths} months: revenue ${money(e.revenue)} ${dec(e.revenue).gte(0) ? "higher" : "lower"}, net profit ${money(profit)} ${profit.gte(0) ? "higher" : "lower"}, cash at the end ${money(e.closingCash)} ${dec(e.closingCash).gte(0) ? "higher" : "lower"}.`;
    found.push({ ...o, effect: e, summary });
  };

  // --- Win back lapsed customers.
  const lapsed = input.customers
    .map((c) => {
      const early = c.byMonth.slice(0, 9).map(dec);
      const late = c.byMonth.slice(9).map(dec);
      const boughtIn = early.filter((x) => x.gt(0)).length;
      const total = early.reduce((a, x) => a.plus(x), new D(0));
      const lastMonth = c.byMonth
        .slice(0, 9)
        .reduce((a, x, i) => (dec(x).gt(0) ? i : a), -1);
      return {
        c,
        boughtIn,
        total,
        late: late.reduce((a, x) => a.plus(x), new D(0)),
        lastMonth,
      };
    })
    .filter((x) => x.boughtIn >= 2 && x.total.gt(0) && x.late.lte(0))
    .sort(
      (a, b) => b.total.comparedTo(a.total) || a.c.name.localeCompare(b.c.name),
    );
  if (lapsed.length) {
    const monthly = lapsed.reduce((a, x) => a.plus(x.total.div(9)), new D(0));
    const target = monthly.times(s.winBackRatePercent).div(100);
    const n = lapsed.length;
    finish({
      key: "WIN_BACK",
      kind: "WIN_BACK",
      title: `Win back ${n} lapsed customer${n === 1 ? "" : "s"}`,
      finding: `${n} customer${n === 1 ? "" : "s"} bought in at least two months from ${earlier}, ${money(monthly)} a month on average over those nine months, and nothing from ${recent}.`,
      evidence: {
        columns: [
          "Customer",
          "Months bought (of 9)",
          "Last bought",
          "Sales over the 9 months",
        ],
        rows: lapsed
          .slice(0, 10)
          .map((x) => [
            x.c.name,
            String(x.boughtIn),
            monthLabel(months[x.lastMonth]!),
            money(x.total),
          ]),
      },
      assumptions: [
        `${s.winBackRatePercent}% of their former monthly sales comes back, building up over 3 months from next month.`,
        "They buy at the business’s usual margin and pay in its usual days.",
      ],
      confidence: thin ? "LOW" : n >= 3 ? "MEDIUM" : "LOW",
      confidenceReason: thin
        ? "Fewer than nine of the twelve months have sales."
        : n >= 3
          ? "Several customers, each with a buying history; whether they return depends on why they left."
          : "Only one or two customers; whether they return depends on why they left.",
      changes: [
        {
          lever: "NEW_CUSTOMER",
          label: `Win back: ${n} lapsed customer${n === 1 ? "" : "s"}`,
          monthlyRevenue: amt(target),
          rampMonths: 3,
          month: Math.min(2, input.horizonMonths),
        },
      ],
    });
    checks.push({
      kind: "WIN_BACK",
      label: OPPORTUNITY_INFO.WIN_BACK.label,
      found: 1,
      note: `${n} lapsed customer${n === 1 ? "" : "s"} found.`,
    });
  } else {
    checks.push({
      kind: "WIN_BACK",
      label: OPPORTUNITY_INFO.WIN_BACK.label,
      found: 0,
      note: `No customer who bought in two or more months from ${earlier} has stopped buying.`,
    });
  }

  // --- Cross-sell: lines at least three customers buy, offered to customers active in the last six months who do not.
  const active = input.customers.filter((c) =>
    c.byMonth.slice(6).some((x) => dec(x).gt(0)),
  );
  const crossSells = input.lines
    .map((l) => {
      const buyers = input.customers.filter((c) =>
        dec(c.byLine[l.accountId] ?? 0).gt(0),
      );
      const total = sum(buyers.map((c) => c.byLine[l.accountId]!));
      const perBuyer = buyers.length
        ? total.div(buyers.length).div(12)
        : new D(0);
      const targets = active
        .filter((c) => !dec(c.byLine[l.accountId] ?? 0).gt(0))
        .sort(
          (a, b) =>
            sum(b.byMonth).comparedTo(sum(a.byMonth)) ||
            a.name.localeCompare(b.name),
        );
      return {
        l,
        buyers,
        perBuyer,
        targets,
        size: perBuyer
          .times(targets.length)
          .times(s.crossSellRatePercent)
          .div(100),
      };
    })
    .filter(
      (x) => x.buyers.length >= 3 && x.targets.length >= 1 && x.size.gt(0),
    )
    .sort(
      (a, b) => b.size.comparedTo(a.size) || a.l.code.localeCompare(b.l.code),
    )
    .slice(0, 2);
  for (const x of crossSells) {
    const t = x.targets.length;
    finish({
      key: `CROSS_SELL:${x.l.accountId}`,
      kind: "CROSS_SELL",
      title: `Sell ${x.l.name} to ${t} more customer${t === 1 ? "" : "s"}`,
      finding: `${x.buyers.length} customers buy ${x.l.code} ${x.l.name}, ${money(x.perBuyer)} a month each on average. ${t} customer${t === 1 ? "" : "s"} who bought in the last six months ${t === 1 ? "does" : "do"} not.`,
      evidence: {
        columns: ["Customer not buying it", "Sales over 12 months"],
        rows: x.targets
          .slice(0, 10)
          .map((c) => [c.name, money(sum(c.byMonth))]),
      },
      assumptions: [
        `${s.crossSellRatePercent}% of those customers take it up at the average buyer’s ${money(x.perBuyer)} a month, building up over 4 months from next month.`,
        "At the business’s usual margin and payment days.",
      ],
      confidence: x.buyers.length >= 10 && !thin ? "MEDIUM" : "LOW",
      confidenceReason:
        x.buyers.length >= 10 && !thin
          ? "Many customers already buy the line, so its appeal is shown; take-up by others is the estimate."
          : "Few customers buy the line so far, so the average per buyer is uncertain.",
      changes: [
        {
          lever: "NEW_CUSTOMER",
          label: `Cross-sell: ${x.l.name}`,
          monthlyRevenue: amt(x.size),
          rampMonths: 4,
          month: Math.min(2, input.horizonMonths),
        },
      ],
    });
  }
  checks.push({
    kind: "CROSS_SELL",
    label: OPPORTUNITY_INFO.CROSS_SELL.label,
    found: crossSells.length,
    note: crossSells.length
      ? crossSells.length === 1
        ? "1 line found."
        : `${crossSells.length} lines found (at most the two largest are shown).`
      : input.lines.length < 2
        ? "Sales are booked to fewer than two revenue lines, so there is nothing to cross-sell."
        : "No revenue line is bought by at least three customers while active customers go without it.",
  });

  // --- Grow the segment (department or project) with the best margin.
  const segs = input.segments
    .filter((g) => dec(g.revenue).gt(0))
    .map((g) => ({
      g,
      margin: dec(g.revenue).minus(g.costs).div(g.revenue).times(100),
    }))
    .sort(
      (a, b) =>
        b.margin.comparedTo(a.margin) ||
        dec(b.g.revenue).comparedTo(a.g.revenue),
    );
  const bestByKind = (["DEPARTMENT", "PROJECT"] as const)
    .map((k) => segs.filter((x) => x.g.kind === k))
    .filter((xs) => xs.length >= 2);
  const best = bestByKind
    .map((xs) => xs[0]!)
    .filter((x) => x.margin.gt(0))
    .sort((a, b) => b.margin.comparedTo(a.margin))[0];
  if (best) {
    const kindWord = best.g.kind === "DEPARTMENT" ? "department" : "project";
    const peers = segs.filter((x) => x.g.kind === best.g.kind);
    const monthly = dec(best.g.revenue).div(12);
    const growth = monthly.times(s.segmentGrowthPercent).div(100);
    const costShare = D.min(
      D.max(new D(100).minus(best.margin), 0),
      100,
    ).toDecimalPlaces(2, D.ROUND_HALF_UP);
    finish({
      key: `GROW_SEGMENT:${best.g.id}`,
      kind: "GROW_SEGMENT",
      title: `Grow ${best.g.name}`,
      finding: `${best.g.code} ${best.g.name} earns a ${best.margin.toFixed(1)}% margin on ${money(monthly)} of sales a month, the best of ${peers.length} ${kindWord}s with sales.`,
      evidence: {
        columns: [
          kindWord === "department" ? "Department" : "Project",
          "Sales over 12 months",
          "Costs over 12 months",
          "Margin",
        ],
        rows: peers.map((x) => [
          `${x.g.code} ${x.g.name}`,
          money(x.g.revenue),
          money(x.g.costs),
          `${x.margin.toFixed(1)}%`,
        ]),
      },
      assumptions: [
        `Its sales grow ${s.segmentGrowthPercent}%, building up over 6 months from next month.`,
        `The extra sales cost ${costShare.toFixed(2)}% of their value, the ${kindWord}’s own cost share; costs not tagged to the ${kindWord} are not included, so the margin may be overstated.`,
      ],
      confidence: "LOW",
      confidenceReason: `Rests on how costs are tagged to ${kindWord}s, and on growth that has not been planned yet.`,
      changes: [
        {
          lever: "NEW_CUSTOMER",
          label: `Grow: ${best.g.name}`,
          monthlyRevenue: amt(growth),
          rampMonths: 6,
          month: Math.min(2, input.horizonMonths),
          costOfSalesPercent: costShare.toFixed(2),
        },
      ],
    });
    checks.push({
      kind: "GROW_SEGMENT",
      label: OPPORTUNITY_INFO.GROW_SEGMENT.label,
      found: 1,
      note: `${best.g.name} has the best margin.`,
    });
  } else {
    checks.push({
      kind: "GROW_SEGMENT",
      label: OPPORTUNITY_INFO.GROW_SEGMENT.label,
      found: 0,
      note: segs.length
        ? "No two departments or projects of the same kind both have sales, or none makes a profit, so there is nothing to compare."
        : "No sales are tagged to departments or projects.",
    });
  }

  // --- Margin recovery.
  const gm = (rows: { revenue: string; costOfSales: string }[]) => {
    const r = sum(rows.map((x) => x.revenue));
    return r.gt(0)
      ? r
          .minus(sum(rows.map((x) => x.costOfSales)))
          .div(r)
          .times(100)
      : null;
  };
  const before = gm(input.margins.slice(0, 9));
  const now = gm(input.margins.slice(9));
  if (
    before !== null &&
    now !== null &&
    before.minus(now).gte(2) &&
    before.lt(100)
  ) {
    // Price p restores the earlier margin when cost of sales is unchanged: 1 − c/(1 + p) = g0.
    const c = new D(100).minus(now).div(100);
    const p = c
      .div(new D(1).minus(before.div(100)))
      .minus(1)
      .times(100)
      .toDecimalPlaces(2, D.ROUND_UP);
    if (p.gt(0) && p.lte(500)) {
      finish({
        key: "MARGIN_RECOVERY",
        kind: "MARGIN_RECOVERY",
        title: `Restore gross margin to ${before.toFixed(1)}%`,
        finding: `Gross margin was ${before.toFixed(1)}% from ${earlier} and ${now.toFixed(1)}% from ${recent}: ${before.minus(now).toFixed(1)} points lower. Costs have risen faster than prices.`,
        evidence: {
          columns: ["Months", "Revenue", "Cost of sales", "Gross margin"],
          rows: [
            [
              earlier,
              money(sum(input.margins.slice(0, 9).map((x) => x.revenue))),
              money(sum(input.margins.slice(0, 9).map((x) => x.costOfSales))),
              `${before.toFixed(1)}%`,
            ],
            [
              recent,
              money(sum(input.margins.slice(9).map((x) => x.revenue))),
              money(sum(input.margins.slice(9).map((x) => x.costOfSales))),
              `${now.toFixed(1)}%`,
            ],
          ],
        },
        assumptions: [
          `Prices rise ${p.toFixed(2)}% from next month, which restores the earlier margin if costs stay where they are.`,
          "Sales volume is assumed not to change; enter a volume change in the business impact engine to test customers buying less.",
        ],
        confidence: thin ? "LOW" : "MEDIUM",
        confidenceReason: thin
          ? "Fewer than nine of the twelve months have sales."
          : "The fall in margin is measured; how customers respond to a price rise is not.",
        changes: [
          {
            lever: "PRICE_CHANGE",
            pricePercent: p.toFixed(2),
            volumePercent: "0",
            month: Math.min(2, input.horizonMonths),
          },
        ],
      });
      checks.push({
        kind: "MARGIN_RECOVERY",
        label: OPPORTUNITY_INFO.MARGIN_RECOVERY.label,
        found: 1,
        note: `Gross margin is ${before.minus(now).toFixed(1)} points lower than before.`,
      });
    } else
      checks.push({
        kind: "MARGIN_RECOVERY",
        label: OPPORTUNITY_INFO.MARGIN_RECOVERY.label,
        found: 0,
        note: "Gross margin has fallen too far for a price change alone to restore it.",
      });
  } else {
    checks.push({
      kind: "MARGIN_RECOVERY",
      label: OPPORTUNITY_INFO.MARGIN_RECOVERY.label,
      found: 0,
      note:
        before === null || now === null
          ? "There are not enough sales in both periods to compare gross margin."
          : `Gross margin is ${now.toFixed(1)}% in the last three months against ${before.toFixed(1)}% before: not down by 2 points or more.`,
    });
  }

  found.sort(
    (a, b) =>
      dec(b.effect.netProfit).comparedTo(a.effect.netProfit) ||
      a.key.localeCompare(b.key),
  );
  const total = found.reduce((a, o) => a.plus(o.effect.netProfit), new D(0));
  const summary =
    found.length === 1
      ? `1 opportunity found in the books from ${monthLabel(months[0]!)} to ${monthLabel(months[11]!)}. It adds ${money(found[0]!.effect.netProfit)} of net profit over ${input.horizonMonths} months.`
      : found.length
        ? `${found.length} opportunit${found.length === 1 ? "y" : "ies"} found in the books from ${monthLabel(months[0]!)} to ${monthLabel(months[11]!)}. Each on its own adds between ${money(found[found.length - 1]!.effect.netProfit)} and ${money(found[0]!.effect.netProfit)} of net profit over ${input.horizonMonths} months (${money(total)} if all were taken, before any overlap between them).`
        : `No growth opportunities found in the books from ${monthLabel(months[0]!)} to ${monthLabel(months[11]!)}. What was checked is listed below.`;
  return {
    window: { from: months[0]!, to: months[11]! },
    settings: s,
    opportunities: found,
    checks,
    summary,
  };
}
