import { HttpStatus, Injectable } from '@nestjs/common';
import { D, formatAmountText, minorUnits } from '@talk2tax/accounting-engine';
import { GST_HEADS, gstSetOff, TAX_FORECAST_MAX_MONTHS, taxLiabilityForecast, TaxForecastObligation, taxYearOf } from '@talk2tax/tax-engine';
import { AdvanceTaxService } from '../advance-tax/advance-tax.service';
import { OrgContext } from '../auth/decorators';
import { todayIso } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { ComplianceService } from '../compliance/compliance.service';
import { GstPaymentsService } from '../gst/gst-payments.service';
import { GstService } from '../gst/gst.service';

const PAYMENT_KINDS = new Set(['GSTR3B', 'GST_PMT06', 'TDS_DEPOSIT', 'TCS_DEPOSIT', 'PF', 'ESI', 'PT', 'ADVANCE_TAX']);
const RECORD_KINDS = ['TDS_DEPOSIT', 'TCS_DEPOSIT', 'PF', 'ESI', 'PT'];
const HISTORY_MONTHS = 6;

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10); // not money
const pad = (n: number) => String(n).padStart(2, '0');
function addMonths(month: string, n: number) {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  return `${y + Math.floor(m / 12)}-${pad((((m % 12) + 12) % 12) + 1)}`;
}
const monthEnd = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);

/**
 * Tax liability forecast (TAX-048): the tax payments the compliance calendar expects in the coming
 * months (GST, TDS/TCS, PF, ESI, PT, advance tax), from the books where the period is over, the
 * advance tax plan, or the recent average. India only; read-only.
 */
@Injectable()
export class TaxForecastService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly compliance: ComplianceService,
    private readonly gst: GstService,
    private readonly gstPayments: GstPaymentsService,
    private readonly advanceTax: AdvanceTaxService,
  ) {}

  async forecast(org: OrgContext, months = 3, today = todayIso()) {
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { countryCode: true } });
    if (o.countryCode !== 'IN') throw new DomainError('NOT_INDIA', 'The tax forecast covers Indian GST, TDS/TCS, payroll dues and advance tax', HttpStatus.UNPROCESSABLE_ENTITY);
    const horizon = Math.min(Math.max(1, Math.trunc(months)), TAX_FORECAST_MAX_MONTHS); // not money
    const current = today.slice(0, 7);
    const to = monthEnd(addMonths(current, horizon - 1));
    const cal = await this.compliance.calendar(org.id, today, to);
    const open = [...cal.overdueBefore, ...cal.items].filter((i) => PAYMENT_KINDS.has(i.kind) && i.status !== 'DONE' && i.status !== 'NOTHING_DUE');

    // Past amounts of the obligations the books settle (TDS/TCS, payroll), one per month.
    const historyFrom = `${addMonths(current, -HISTORY_MONTHS)}-01`;
    const past = (await this.compliance.calendar(org.id, historyFrom, addDays(today, -1))).items;
    const recordHistory = new Map<string, string[]>();
    for (const k of RECORD_KINDS) recordHistory.set(k, past.filter((p) => p.kind === k && p.amount !== null && p.periodTo < today).sort((a, b) => a.period.localeCompare(b.period)).map((p) => p.amount!));

    // GST: the cash each of the last six months needed, worked out from its documents as the return would.
    const gstRegistered = !!(await this.gst.registration(this.prisma, org.id));
    const gstHistory: string[] = [];
    if (gstRegistered && open.some((i) => i.kind === 'GSTR3B' || i.kind === 'GST_PMT06')) {
      for (let k = HISTORY_MONTHS; k >= 1; k--) {
        const m = addMonths(current, -k);
        const s = await this.gst.gstr3b(org.id, `${m}-01`, monthEnd(m));
        const liability = Object.fromEntries(GST_HEADS.map((h) => [h, new D(s.outwardTaxable[h]).plus(h === 'igst' ? s.outwardZeroRated.igst : 0).plus(s.inwardReverseCharge[h])])) as Record<(typeof GST_HEADS)[number], InstanceType<typeof D>>;
        const r = gstSetOff(liability, s.itcTotal, s.reverseChargeCash);
        gstHistory.push(GST_HEADS.reduce((t, h) => t.plus(r.cash[h]), new D(0)).toFixed(2));
      }
      // Months before anything was recorded say nothing about the future.
      while (gstHistory.length && gstHistory[0] === '0.00') gstHistory.shift();
    }

    // Advance tax: the instalments the plan needs, for this tax year and the next if the window reaches it.
    const plans = new Map<string, string>();
    if (open.some((i) => i.kind === 'ADVANCE_TAX')) {
      const years = [...new Set([taxYearOf(today).label, taxYearOf(to).label])];
      for (const y of years) for (const i of (await this.advanceTax.get(org, y)).instalments) plans.set(i.dueDate, i.toPay);
    }

    // GST owed for months already over is one running balance: only the latest such return carries it.
    const gstOver = open.filter((i) => (i.kind === 'GSTR3B' || i.kind === 'GST_PMT06') && i.paid === null && i.periodTo < today).sort((a, b) => a.periodTo.localeCompare(b.periodTo));
    const gstLatest = gstOver[gstOver.length - 1];
    const gstEarlier = gstOver.slice(0, -1).map((i) => i.periodLabel);
    const obligations: TaxForecastObligation[] = [];
    for (const i of open) {
      const base = { key: i.key, kind: i.kind, name: i.name, area: i.area, period: i.period, periodLabel: i.periodLabel, dueDate: i.dueDate };
      const over = i.periodTo < today;
      if (i.kind === 'GSTR3B' || i.kind === 'GST_PMT06') {
        if (i.paid !== null) continue;
        // Under QRMP the quarter's GSTR-3B pays only the last month; PMT-06 paid the first two.
        const month = i.periodTo.slice(0, 7);
        if (over) {
          if (i !== gstLatest) continue;
          const p = await this.gstPayments.preview(org, month);
          const earlier = gstEarlier.length ? ` Includes ${gstEarlier.join(', ')}, not paid yet.` : '';
          obligations.push({ ...base, known: p.totalCash, note: `Tax less input credit, as of the month end; includes anything unpaid from earlier months.${earlier}` });
        } else obligations.push({ ...base, history: gstHistory, note: 'Net of input tax credit, per month.' });
      } else if (i.kind === 'ADVANCE_TAX') {
        obligations.push({ ...base, plan: plans.get(i.dueDate) ?? '0' });
      } else if (over && i.outstanding !== null) {
        obligations.push({ ...base, known: i.outstanding });
      } else {
        obligations.push({ ...base, history: recordHistory.get(i.kind) ?? [] });
      }
    }
    const f = taxLiabilityForecast(obligations, { scale: minorUnits(org.functionalCurrency), money: (a) => formatAmountText(a, org.functionalCurrency) });
    return {
      asOf: today,
      to,
      horizon,
      currency: org.functionalCurrency,
      configured: cal.configured,
      areas: cal.areas,
      overdue: f.items.filter((i) => i.dueDate < today).length,
      ...f,
    };
  }
}
