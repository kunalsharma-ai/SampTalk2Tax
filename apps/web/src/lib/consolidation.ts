export interface GroupSummary {
  id: string;
  name: string;
  currency: string;
  members: { orgId: string; name: string | null; currency: string | null }[];
  rules: number;
  updatedAt: string;
}

export interface GroupDetail {
  id: string;
  name: string;
  currency: string;
  parentOrgId: string;
  members: { orgId: string; name: string | null; currency: string | null; isParent: boolean; yourRole: string | null; canReadReports: boolean; addedAt: string }[];
  rates: { id: string; memberOrgId: string; memberName: string | null; periodEnd: string; closing: string; average: string; historical: string; updatedAt: string }[];
  rules: { id: string; name: string; left: { orgId: string; name: string | null; code: string }; right: { orgId: string; name: string | null; code: string }; isActive: boolean }[];
  candidates: { orgId: string; name: string | null; currency: string | null }[];
  updatedAt: string;
}

export type RowKind = 'ACCOUNT' | 'EARNINGS_BROUGHT_FORWARD' | 'TRANSLATION_RESERVE' | 'INTERCOMPANY_DIFFERENCE';
export interface Line { code: string; name: string; kind: RowKind; amount: string }

export interface ConsolidationReport {
  group: { id: string; name: string };
  from: string;
  to: string;
  currency: string;
  entities: { id: string; name: string; currency: string; rates: { closing: string; average: string; historical: string } | null; translationReserve: string; netIncome: string }[];
  rows: { kind: RowKind; code: string; name: string; type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE'; amounts: string[]; elimination: string; consolidated: string }[];
  eliminations: { ruleId: string; name: string; left: { entityId: string; code: string; name: string | null; amount: string }; right: { entityId: string; code: string; name: string | null; amount: string }; difference: string; matched: boolean; problem: string | null }[];
  balanced: boolean;
  incomeStatement: { revenue: Line[]; expenses: Line[]; totalRevenue: string; totalExpenses: string; netIncome: string };
  balanceSheet: { assets: Line[]; liabilities: Line[]; equity: Line[]; periodEarnings: string; totalAssets: string; totalLiabilities: string; totalEquity: string; balanced: boolean };
}
