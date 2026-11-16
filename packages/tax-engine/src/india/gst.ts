import { D, Dec, TaxComponent, TaxRateInfo, TaxSplitter, dec, roundToCurrency } from '@talk2tax/accounting-engine';
import { FOREIGN_PLACE_OF_SUPPLY, indiaState, isPlaceOfSupply } from './states';

/**
 * How a GST rate treats a supply. Only TAXABLE carries tax; the rest are rate 0
 * and are reported separately in GSTR-1 table 8 and GSTR-3B tables 3.1 and 5.
 */
export const GST_CATEGORIES = ['TAXABLE', 'NIL_RATED', 'EXEMPT', 'NON_GST'] as const;
export type GstCategory = (typeof GST_CATEGORIES)[number];

/** Intra-state supplies carry CGST + SGST (or UTGST); inter-state supplies and exports carry IGST. */
export type SupplyNature = 'INTRA' | 'INTER';

/**
 * IGST Act 2017 s.7 and s.8: a supply is intra-state when the supplier's
 * location and the place of supply are in the same state or union territory;
 * otherwise, and always for a place of supply outside India, it is inter-state.
 * (Supplies to SEZ units are inter-state too; SEZ recipients are not modelled yet.)
 */
export function supplyNature(supplierState: string, placeOfSupply: string): SupplyNature {
  if (placeOfSupply === FOREIGN_PLACE_OF_SUPPLY) return 'INTER';
  return supplierState === placeOfSupply ? 'INTRA' : 'INTER';
}

/** HSN codes (goods) and SAC codes (services, starting 99) are reported at 4, 6 or 8 digits. */
export function hsnIssue(code: string | null | undefined): string | null {
  const c = (code ?? '').trim();
  if (!c) return 'enter the HSN or SAC code';
  if (!/^(\d{4}|\d{6}|\d{8})$/.test(c)) return `HSN/SAC "${c}" must be 4, 6 or 8 digits`;
  return null;
}

export interface GstAccounts {
  cgst: string;
  /** Receives SGST and UTGST: both are the state/UT head in GST returns. */
  sgst: string;
  igst: string;
}

export interface GstSplitContext {
  nature: SupplyNature;
  /** The state whose tax applies on an intra-state supply (decides SGST vs UTGST). */
  stateCode: string;
  accounts: GstAccounts;
  categories: ReadonlyMap<string, GstCategory>;
}

/**
 * Tax on one line under GST. Inter-state: IGST at the full rate. Intra-state:
 * CGST and SGST/UTGST at half the rate each, each rounded to the currency on
 * its own, so the two halves are always equal.
 */
export function gstComponents(netAmount: Dec, ratePercent: Dec, category: GstCategory, ctx: Omit<GstSplitContext, 'categories'>, currency: string): TaxComponent[] {
  if (category !== 'TAXABLE') return [];
  if (ctx.nature === 'INTER') {
    return [{ code: 'IGST', accountId: ctx.accounts.igst, rate: ratePercent, amount: roundToCurrency(netAmount.times(ratePercent).dividedBy(100), currency) }];
  }
  const half = ratePercent.dividedBy(2);
  const amount = roundToCurrency(netAmount.times(half).dividedBy(100), currency);
  const stateLabel = indiaState(ctx.stateCode)?.levies ?? 'SGST';
  return [
    { code: 'CGST', accountId: ctx.accounts.cgst, rate: half, amount },
    { code: stateLabel, accountId: ctx.accounts.sgst, rate: half, amount },
  ];
}

/** A TaxSplitter for computeDocument. */
export function gstSplitter(ctx: GstSplitContext): TaxSplitter {
  return (netAmount: Dec, rate: TaxRateInfo, currency: string) => {
    const category = ctx.categories.get(rate.id);
    if (!category) return `"${rate.name}" is not a GST rate`;
    const r = dec(rate.rate);
    if (category !== 'TAXABLE' && !r.isZero()) return `"${rate.name}" is ${category.toLowerCase().replace('_', '-')} and must be 0%`;
    return gstComponents(netAmount, r, category, ctx, currency);
  };
}

/** Splits component amounts into the three GST heads. */
export function gstHeads(components: readonly { code: string; amount: Dec }[]): { cgst: Dec; sgst: Dec; igst: Dec } {
  const out = { cgst: new D(0), sgst: new D(0), igst: new D(0) };
  for (const c of components) {
    if (c.code === 'CGST') out.cgst = out.cgst.plus(c.amount);
    else if (c.code === 'SGST' || c.code === 'UTGST') out.sgst = out.sgst.plus(c.amount);
    else if (c.code === 'IGST') out.igst = out.igst.plus(c.amount);
  }
  return out;
}

export function assertPlaceOfSupply(code: string): void {
  if (!isPlaceOfSupply(code)) throw new Error(`${code} is not a GST place of supply`);
}
