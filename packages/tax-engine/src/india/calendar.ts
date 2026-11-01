/**
 * India compliance calendar: which returns and payments fall due, and when, for an
 * organisation's GST registration, TDS/TCS (TAN), payroll and advance tax.
 *
 * Due dates are the statutory dates without holiday shifts; extensions announced by
 * notification are not applied automatically. Every rule carries its source.
 */
import { depositDueDate, taxQuarterOf, taxYearOf } from "./withholding";
import { payrollDueDates } from "./payroll";

export const OBLIGATION_KINDS = [
  "GSTR1",
  "GSTR3B",
  "GST_PMT06",
  "GSTR9",
  "TDS_DEPOSIT",
  "TCS_DEPOSIT",
  "TDS_STATEMENT_SALARY",
  "TDS_STATEMENT",
  "TCS_STATEMENT",
  "PF",
  "ESI",
  "PT",
  "ADVANCE_TAX",
] as const;
export type ObligationKind = (typeof OBLIGATION_KINDS)[number];

/** RETURN: filed by the organisation and marked filed here. PAYMENT: settled by records in the books (challans, payroll payments). */
export type ObligationNature = "RETURN" | "PAYMENT";

export interface ObligationRule {
  kind: ObligationKind;
  name: string;
  area: "GST" | "TDS_TCS" | "PAYROLL" | "INCOME_TAX";
  nature: ObligationNature;
  source: string;
}

export const OBLIGATION_RULES: Readonly<
  Record<ObligationKind, ObligationRule>
> = Object.freeze({
  GSTR1: {
    kind: "GSTR1",
    name: "GSTR-1 (outward supplies)",
    area: "GST",
    nature: "RETURN",
    source:
      "CGST Act 2017 s.37; CGST Rules rule 59: 11th of the next month, or 13th of the month after the quarter under QRMP",
  },
  GSTR3B: {
    kind: "GSTR3B",
    name: "GSTR-3B (summary return and tax)",
    area: "GST",
    nature: "RETURN",
    source:
      "CGST Act 2017 s.39; CGST Rules rule 61: 20th of the next month; under QRMP 22nd or 24th of the month after the quarter by state",
  },
  GST_PMT06: {
    kind: "GST_PMT06",
    name: "GST PMT-06 (monthly tax under QRMP)",
    area: "GST",
    nature: "RETURN",
    source:
      "CGST Act 2017 s.39(7) proviso; CGST Rules rule 61(1A): 25th of the next month for the first two months of a quarter",
  },
  GSTR9: {
    kind: "GSTR9",
    name: "GSTR-9 (annual return)",
    area: "GST",
    nature: "RETURN",
    source:
      "CGST Act 2017 s.44; CGST Rules rule 80: 31 December after the financial year (optional for turnover up to Rs 2 crore)",
  },
  TDS_DEPOSIT: {
    kind: "TDS_DEPOSIT",
    name: "TDS deposit",
    area: "TDS_TCS",
    nature: "PAYMENT",
    source:
      "Income-tax Act 2025 and Income-tax Rules 2026: 7th of the next month, 30 April for March",
  },
  TCS_DEPOSIT: {
    kind: "TCS_DEPOSIT",
    name: "TCS deposit",
    area: "TDS_TCS",
    nature: "PAYMENT",
    source:
      "Income-tax Act 2025 and Income-tax Rules 2026: 7th of the next month, 30 April for March",
  },
  TDS_STATEMENT_SALARY: {
    kind: "TDS_STATEMENT_SALARY",
    name: "TDS statement on salary (Form 138, was 24Q)",
    area: "TDS_TCS",
    nature: "RETURN",
    source:
      "Income-tax Act 2025 s.397(3)(b); Income-tax Rules 2026 rule 219: 31 July, 31 October, 31 January and 31 May",
  },
  TDS_STATEMENT: {
    kind: "TDS_STATEMENT",
    name: "TDS statement, residents (Form 140, was 26Q)",
    area: "TDS_TCS",
    nature: "RETURN",
    source:
      "Income-tax Act 2025 s.397(3)(b); Income-tax Rules 2026 rule 219: 31 July, 31 October, 31 January and 31 May",
  },
  TCS_STATEMENT: {
    kind: "TCS_STATEMENT",
    name: "TCS statement (Form 143, was 27EQ)",
    area: "TDS_TCS",
    nature: "RETURN",
    source:
      "Income-tax Rules 2026 rule 219: same dates as TDS statements from tax year 2026-27 (secondary sources; confirm)",
  },
  PF: {
    kind: "PF",
    name: "PF (ECR and challan)",
    area: "PAYROLL",
    nature: "PAYMENT",
    source: "EPF Scheme 1952 para 38: 15th of the next month",
  },
  ESI: {
    kind: "ESI",
    name: "ESI contribution",
    area: "PAYROLL",
    nature: "PAYMENT",
    source: "ESI (Central) Regulations 1950 reg. 31: 15th of the next month",
  },
  PT: {
    kind: "PT",
    name: "Professional tax (Maharashtra)",
    area: "PAYROLL",
    nature: "PAYMENT",
    source:
      "Maharashtra Profession Tax Rules 1975 rule 11: end of the next month for monthly payers",
  },
  ADVANCE_TAX: {
    kind: "ADVANCE_TAX",
    name: "Advance income tax",
    area: "INCOME_TAX",
    nature: "RETURN",
    source:
      "Income-tax Act 2025 advance tax instalments: 15% by 15 June, 45% by 15 September, 75% by 15 December, 100% by 15 March",
  },
});

/** GSTR-3B under QRMP is due on the 22nd for these states and union territories, and on the 24th for the rest. */
export const QRMP_22ND_STATES: ReadonlySet<string> = new Set([
  "22",
  "23",
  "24",
  "25",
  "26",
  "27",
  "29",
  "30",
  "31",
  "32",
  "33",
  "34",
  "35",
  "36",
  "37",
]);

export type GstReturnFrequency = "MONTHLY" | "QUARTERLY";

export interface ComplianceProfile {
  /** GST registration: state from the GSTIN, the date it applies from, and monthly or QRMP filing. */
  gst?: {
    stateCode: string;
    from: string;
    frequency: GstReturnFrequency;
  } | null;
  /** TDS/TCS (TAN) set up from this date. */
  withholding?: { from: string } | null;
  /** Payroll from this date; professional tax only for states that are built (Maharashtra). */
  payroll?: { from: string; ptStates: string[] } | null;
  /** Advance tax instalments from this date. */
  advanceTax?: { from: string } | null;
}

export interface Obligation {
  /** Stable key, unique per organisation: kind and period. */
  key: string;
  kind: ObligationKind;
  name: string;
  area: ObligationRule["area"];
  nature: ObligationNature;
  /** What the obligation covers: a month (2026-10), a quarter (Q2 2026-27) or a year (2026-27). */
  period: string;
  periodLabel: string;
  /** First and last day of the period covered. */
  periodFrom: string;
  periodTo: string;
  dueDate: string;
  note?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) =>
  new Date(Date.UTC(y, m, 0)).getUTCDate();
function addMonths(month: string, n: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  return `${y + Math.floor(m / 12)}-${pad((((m % 12) + 12) % 12) + 1)}`;
}
const monthEnd = (month: string) =>
  `${month}-${pad(lastDay(Number(month.slice(0, 4)), Number(month.slice(5, 7))))}`;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const monthLabel = (month: string) =>
  `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

function make(
  kind: ObligationKind,
  period: string,
  periodLabel: string,
  periodFrom: string,
  periodTo: string,
  dueDate: string,
  note?: string,
): Obligation {
  const r = OBLIGATION_RULES[kind];
  return {
    key: `${kind}:${period}`,
    kind,
    name: r.name,
    area: r.area,
    nature: r.nature,
    period,
    periodLabel,
    periodFrom,
    periodTo,
    dueDate,
    ...(note ? { note } : {}),
  };
}

/** Months (YYYY-MM) whose period ends on or after `from` month and which could fall due by `to`. */
function monthsBetween(fromMonth: string, toMonth: string): string[] {
  const out: string[] = [];
  for (let m = fromMonth; m <= toMonth; m = addMonths(m, 1)) out.push(m);
  return out;
}

/** GST obligations for one month of activity. */
function gstForMonth(
  gst: NonNullable<ComplianceProfile["gst"]>,
  month: string,
): Obligation[] {
  const out: Obligation[] = [];
  const next = addMonths(month, 1);
  const q = taxQuarterOf(`${month}-01`);
  const quarterEndMonth = q.to.slice(0, 7);
  if (gst.frequency === "MONTHLY") {
    out.push(
      make(
        "GSTR1",
        month,
        monthLabel(month),
        `${month}-01`,
        monthEnd(month),
        `${next}-11`,
      ),
    );
    out.push(
      make(
        "GSTR3B",
        month,
        monthLabel(month),
        `${month}-01`,
        monthEnd(month),
        `${next}-20`,
      ),
    );
  } else if (month === quarterEndMonth) {
    const qp = `${q.label}`;
    out.push(
      make(
        "GSTR1",
        qp,
        q.label,
        q.from,
        q.to,
        `${next}-13`,
        "Quarterly under QRMP",
      ),
    );
    out.push(
      make(
        "GSTR3B",
        qp,
        q.label,
        q.from,
        q.to,
        `${next}-${QRMP_22ND_STATES.has(gst.stateCode) ? "22" : "24"}`,
        "Quarterly under QRMP",
      ),
    );
  } else {
    out.push(
      make(
        "GST_PMT06",
        month,
        monthLabel(month),
        `${month}-01`,
        monthEnd(month),
        `${next}-25`,
        "Not needed if the input tax credit covers the tax, or under the fixed-sum method nothing is due",
      ),
    );
  }
  // Annual return after March.
  if (month.endsWith("-03")) {
    const ty = taxYearOf(`${month}-01`);
    out.push(
      make(
        "GSTR9",
        ty.label,
        `FY ${ty.label}`,
        ty.from,
        ty.to,
        `${month.slice(0, 4)}-12-31`,
        "Optional when aggregate turnover is up to Rs 2 crore",
      ),
    );
  }
  return out;
}

function withholdingForMonth(month: string): Obligation[] {
  const out = [
    make(
      "TDS_DEPOSIT",
      month,
      monthLabel(month),
      `${month}-01`,
      monthEnd(month),
      depositDueDate(`${month}-01`),
    ),
    make(
      "TCS_DEPOSIT",
      month,
      monthLabel(month),
      `${month}-01`,
      monthEnd(month),
      depositDueDate(`${month}-01`),
    ),
  ];
  const q = taxQuarterOf(`${month}-01`);
  if (q.to.slice(0, 7) === month) {
    const due = statementDueDate(q.quarter, q.to);
    out.push(make("TDS_STATEMENT", q.label, q.label, q.from, q.to, due));
    out.push(make("TCS_STATEMENT", q.label, q.label, q.from, q.to, due));
  }
  return out;
}

/** Quarterly TDS/TCS statements: 31 July, 31 October, 31 January, and 31 May for the last quarter. */
export function statementDueDate(
  quarter: 1 | 2 | 3 | 4,
  quarterEnd: string,
): string {
  const y = Number(quarterEnd.slice(0, 4));
  return quarter === 1
    ? `${y}-07-31`
    : quarter === 2
      ? `${y}-10-31`
      : quarter === 3
        ? `${y + 1}-01-31`
        : `${y}-05-31`;
}

function payrollForMonth(
  payroll: NonNullable<ComplianceProfile["payroll"]>,
  month: string,
): Obligation[] {
  const due = payrollDueDates(month);
  const out = [
    // TDS on salary is deposited with the same monthly challan as other TDS.
    make(
      "TDS_DEPOSIT",
      month,
      monthLabel(month),
      `${month}-01`,
      monthEnd(month),
      due.TDS,
    ),
    make(
      "PF",
      month,
      monthLabel(month),
      `${month}-01`,
      monthEnd(month),
      due.PF,
    ),
    make(
      "ESI",
      month,
      monthLabel(month),
      `${month}-01`,
      monthEnd(month),
      due.ESI,
    ),
  ];
  if (payroll.ptStates.includes("27"))
    out.push(
      make(
        "PT",
        month,
        monthLabel(month),
        `${month}-01`,
        monthEnd(month),
        due.PT,
      ),
    );
  const q = taxQuarterOf(`${month}-01`);
  if (q.to.slice(0, 7) === month)
    out.push(
      make(
        "TDS_STATEMENT_SALARY",
        q.label,
        q.label,
        q.from,
        q.to,
        statementDueDate(q.quarter, q.to),
      ),
    );
  return out;
}

const ADVANCE_TAX_INSTALMENTS: { month: number; share: string }[] = [
  { month: 6, share: "15%" },
  { month: 9, share: "45%" },
  { month: 12, share: "75%" },
  { month: 3, share: "100%" },
];

function advanceTaxForMonth(month: string): Obligation[] {
  const m = Number(month.slice(5, 7));
  const i = ADVANCE_TAX_INSTALMENTS.find((x) => x.month === m);
  if (!i) return [];
  const ty = taxYearOf(`${month}-01`);
  return [
    make(
      "ADVANCE_TAX",
      month,
      `${ty.label} instalment ${ADVANCE_TAX_INSTALMENTS.indexOf(i) + 1}`,
      ty.from,
      monthEnd(month),
      `${month}-15`,
      `${i.share} of the tax for the year paid by this date`,
    ),
  ];
}

/**
 * Every obligation due between `from` and `to` (inclusive, by due date) for the
 * profile, never for a period that ends before the area applies.
 */
export function complianceObligations(
  profile: ComplianceProfile,
  from: string,
  to: string,
): Obligation[] {
  if (from > to) throw new Error("from must not be after to");
  // The latest due date is GSTR-9's, nine months after the March it is generated for, so a year back is enough.
  const startMonth = addMonths(from.slice(0, 7), -12);
  const months = monthsBetween(startMonth, to.slice(0, 7));
  const out: Obligation[] = [];
  const seen = new Set<string>();
  const applies = (o: Obligation, since: string | undefined) =>
    since !== undefined && o.periodTo >= since;
  for (const month of months) {
    const candidates: [Obligation[], string | undefined][] = [
      [profile.gst ? gstForMonth(profile.gst, month) : [], profile.gst?.from],
      [
        profile.withholding ? withholdingForMonth(month) : [],
        profile.withholding?.from,
      ],
      [
        profile.payroll ? payrollForMonth(profile.payroll, month) : [],
        profile.payroll?.from,
      ],
      [
        profile.advanceTax ? advanceTaxForMonth(month) : [],
        profile.advanceTax?.from,
      ],
    ];
    for (const [list, since] of candidates)
      for (const o of list)
        if (
          applies(o, since) &&
          o.dueDate >= from &&
          o.dueDate <= to &&
          !seen.has(o.key)
        ) {
          seen.add(o.key);
          out.push(o);
        }
  }
  return out.sort(
    (a, b) =>
      a.dueDate.localeCompare(b.dueDate) ||
      OBLIGATION_KINDS.indexOf(a.kind) - OBLIGATION_KINDS.indexOf(b.kind),
  );
}

export type ObligationStatus =
  | "DONE"
  | "NOTHING_DUE"
  | "OVERDUE"
  | "DUE_SOON"
  | "UPCOMING";

/** Status of an open obligation by its due date: overdue after it, due soon within `soonDays` days of it. */
export function openStatus(
  dueDate: string,
  today: string,
  soonDays = 7,
): ObligationStatus {
  if (dueDate < today) return "OVERDUE";
  const days =
    (Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
    86_400_000;
  return days <= soonDays ? "DUE_SOON" : "UPCOMING";
}
