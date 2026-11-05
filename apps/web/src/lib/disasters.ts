/** Types and helpers for financial disaster simulation. */
import type { TwinProjection, TwinRun } from './twin';

export type ShockKind = 'CUSTOMER_DEFAULT' | 'SUPPLIER_FAILURE' | 'LIQUIDITY_SHOCK' | 'OPERATIONAL_DISRUPTION' | 'DEMAND_SHOCK';
export type Shock =
  | { kind: 'CUSTOMER_DEFAULT'; contactId: string; writeOffPercent: string; loseFutureSales: boolean; month?: number }
  | { kind: 'SUPPLIER_FAILURE'; contactId: string; disruptionMonths: number; revenueLostPercent: string; replacementPremiumPercent: string; month?: number }
  | { kind: 'LIQUIDITY_SHOCK'; frozenCash: string; frozenMonths: number; creditWithdrawn: string; collectionDelayDays: number; delayMonths: number; month?: number }
  | { kind: 'OPERATIONAL_DISRUPTION'; revenueLostPercent: string; months: number; recoveryCost: string; insuranceRecovery: string; insuranceMonthsLater: number; month?: number }
  | { kind: 'DEMAND_SHOCK'; revenueLostPercent: string; months: number; extraCollectionDays: number; month?: number };

export type Verdict = 'SURVIVES' | 'BELOW_BUFFER' | 'RUNS_OUT';
export interface Impact {
  profitChange: string;
  lowestCash: { amount: string; month: string };
  lowestCashChange: string;
  closingCashChange: string;
  largestCashGap: { amount: string; month: string };
  cashNegativeFrom: string | null;
  cashRequired: string;
  monthsBeforeShortfall: number | null;
  verdict: Verdict;
}
export interface ShockResult { index: number; kind: ShockKind; title: string; explanation: string[]; drivers: { kind: string; label?: string | null }[]; alone: Impact }
export interface DisasterResult { noShock: TwinProjection; stressed: TwinRun; impact: Impact; shocks: ShockResult[]; summary: string }
export interface SimulateResponse extends DisasterResult { currency: string; actual: { month: string; cash: string }[] }
export interface Options {
  currency: string;
  firstMonth: string;
  cashBuffer: string | null;
  cash: string | null;
  kinds: { key: ShockKind; label: string; description: string }[];
  customers: { contactId: string; name: string; monthlyRevenue: string; balance: string }[];
  suppliers: { contactId: string; name: string; monthlySpend: string }[];
}
export interface StressTest { key: string; title: string; description: string; shocks: Shock[]; impact: Impact }
export interface StressResponse { currency: string; firstMonth: string; baselineMonths: number; horizonMonths: number; tests: StressTest[]; survived: number; summary: string }
export interface Simulation {
  id: string;
  number: string;
  name: string;
  description: string | null;
  baselineMonths: 3 | 6 | 12;
  horizonMonths: number;
  shocks: Shock[];
  createdAt: string;
  updatedAt: string;
}
export interface SimulationItem extends Simulation { verdict: Verdict | null; lowestCash: { amount: string; month: string } | null }
export interface SimulationDetail extends Simulation { currency: string; actual: { month: string; cash: string }[]; result: DisasterResult | null; problem: { message: string; issues: string[] } | null }

export const VERDICT: Record<Verdict, { label: string; tone: 'positive' | 'warning' | 'negative' }> = {
  SURVIVES: { label: 'Gets through', tone: 'positive' },
  BELOW_BUFFER: { label: 'Below minimum balance', tone: 'warning' },
  RUNS_OUT: { label: 'Cash runs out', tone: 'negative' },
};

/** A new shock of a kind, with sensible starting figures the user is expected to change. */
export function newShock(kind: ShockKind, o: Pick<Options, 'customers' | 'suppliers'>): Shock {
  switch (kind) {
    case 'CUSTOMER_DEFAULT':
      return { kind, contactId: o.customers[0]?.contactId ?? '', writeOffPercent: '100', loseFutureSales: true, month: 1 };
    case 'SUPPLIER_FAILURE':
      return { kind, contactId: o.suppliers[0]?.contactId ?? '', disruptionMonths: 2, revenueLostPercent: '25', replacementPremiumPercent: '10', month: 1 };
    case 'LIQUIDITY_SHOCK':
      return { kind, frozenCash: '0', frozenMonths: 3, creditWithdrawn: '0', collectionDelayDays: 30, delayMonths: 6, month: 1 };
    case 'OPERATIONAL_DISRUPTION':
      return { kind, revenueLostPercent: '100', months: 1, recoveryCost: '0', insuranceRecovery: '0', insuranceMonthsLater: 3, month: 1 };
    case 'DEMAND_SHOCK':
      return { kind, revenueLostPercent: '30', months: 6, extraCollectionDays: 15, month: 1 };
  }
}
