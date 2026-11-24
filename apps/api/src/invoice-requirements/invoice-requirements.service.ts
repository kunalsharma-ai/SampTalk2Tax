import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { D, layoutFromPreset, layoutWarnings, presetForCountry, type LayoutConfig } from '@talk2tax/accounting-engine';
import {
  checkInvoiceContent,
  E_INVOICING_RULES,
  eInvoicingOutlook,
  eInvoicingRule,
  INVOICE_FORMAT_RULES,
  INVOICE_REQUIREMENT_LABEL,
  invoiceFormatRule,
  type InvoiceFormatRule,
  type InvoiceRequirementKey,
} from '@talk2tax/tax-engine';
import type { OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { vatSettings } from '../db/collections/vat-returns';

const MAX_CHECKED = 300;
const YEARS_LOOKED_AT = 8;

interface TemplateUse {
  id: string | null;
  name: string;
  presetId: string;
  /** The text the title check reads: the layout's title, or a whole HTML template. */
  titleText: string;
  headerAddress: boolean;
  warnings: string[];
}

const money = (v: InstanceType<typeof D>) => v.toDecimalPlaces(2).toFixed(2);

/**
 * Country-specific invoice formats (TAX-039) and electronic invoicing requirements (TAX-040).
 * Checks the organisation's sales invoices and credit notes against what its country's rules say
 * an invoice must show (rules in packages/tax-engine invoice-rules.ts), and says when it has to issue
 * or receive e-invoices, testing the thresholds against turnover from the books (or a figure typed
 * in). Read-only: nothing is stored and nothing is sent anywhere. Needs sales.read.
 */
@Injectable()
export class InvoiceRequirementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
  ) {}

  private async country(org: OrgContext) {
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { countryCode: true } });
    return o.countryCode.toUpperCase();
  }

  /** The seller's registration number and whether an address is on file outside the templates. */
  private async seller(org: OrgContext, country: string) {
    if (country === 'IN') {
      const [gst, ein] = await Promise.all([this.prisma.gstRegistration.findUnique({ where: { orgId: org.id } }), this.prisma.eInvoiceSettings.findUnique({ where: { orgId: org.id } })]);
      return { taxNumber: gst?.gstin ?? null, taxNumberName: 'GSTIN', stateCode: gst?.stateCode ?? null, addressOnFile: !!ein?.address1.trim(), eInvoiceSetUp: !!ein };
    }
    const vat = await this.store.collection(vatSettings).findOne({});
    return { taxNumber: vat?.vrn ?? null, taxNumberName: 'VAT or GST number', stateCode: null, addressOnFile: false, eInvoiceSetUp: false };
  }

  private async templates(org: OrgContext, country: string) {
    const rows = await this.prisma.invoiceTemplate.findMany({
      where: { orgId: org.id },
      select: { id: true, name: true, presetId: true, engine: true, layout: true, html: true, isDefault: true, archivedAt: true },
    });
    const use = (t: (typeof rows)[number]): TemplateUse => {
      if (t.engine === 'HTML') return { id: t.id, name: t.name, presetId: t.presetId, titleText: t.html ?? '', headerAddress: true, warnings: [] };
      const layout = t.layout as unknown as LayoutConfig;
      const header = layout.sections.find((s) => s.key === 'HEADER');
      return { id: t.id, name: t.name, presetId: t.presetId, titleText: layout.title, headerAddress: !!header?.visible && !!header.text.trim(), warnings: layoutWarnings(layout, t.presetId) };
    };
    const byId = new Map(rows.map((t) => [t.id, use(t)]));
    const def = rows.find((t) => t.isDefault && !t.archivedAt);
    const preset = presetForCountry(country);
    const builtIn: TemplateUse = { id: null, name: `${preset.name} (built in)`, presetId: preset.id, titleText: layoutFromPreset(preset.id).title, headerAddress: false, warnings: [] };
    const fallback = def ? byId.get(def.id)! : builtIn;
    return { pick: (templateId: string | null) => (templateId ? (byId.get(templateId) ?? fallback) : fallback), fallback };
  }

  /** Completed years of sales (net of credit notes, before tax) in the books' currency, newest first. */
  private async turnoverYears(org: OrgContext, basis: 'FISCAL_YEAR' | 'CALENDAR_YEAR', today: string) {
    const startMonth = basis === 'CALENDAR_YEAR' ? 1 : org.fiscalYearStartMonth;
    const y = Number(today.slice(0, 4));
    const m = Number(today.slice(5, 7));
    // The start year of the year in progress.
    const current = m >= startMonth ? y : y - 1;
    const years: { label: string; from: string; to: string }[] = [];
    for (let i = 1; i <= YEARS_LOOKED_AT; i++) {
      const sy = current - i;
      const from = `${sy}-${String(startMonth).padStart(2, '0')}-01`;
      const endY = startMonth === 1 ? sy : sy + 1;
      const endM = startMonth === 1 ? 12 : startMonth - 1;
      const to = new Date(Date.UTC(endY, endM, 0)).toISOString().slice(0, 10);
      years.push({ label: startMonth === 1 ? String(sy) : `${sy}-${String((sy + 1) % 100).padStart(2, '0')}`, from, to });
    }
    const docs = await this.prisma.document.findMany({
      where: { orgId: org.id, kind: { in: ['INVOICE', 'CREDIT_NOTE'] }, status: 'POSTED', issueDate: { gte: toDbDate(years[years.length - 1]!.from), lte: toDbDate(years[0]!.to) } },
      select: { kind: true, issueDate: true, subtotal: true, exchangeRate: true },
    });
    const out = years.map((yr) => ({ ...yr, amount: new D(0), documents: 0 }));
    for (const d of docs) {
      const day = fromDbDate(d.issueDate);
      const yr = out.find((x) => x.from <= day && day <= x.to);
      if (!yr) continue;
      const local = new D(d.subtotal.toFixed()).times(d.exchangeRate.toFixed());
      yr.amount = d.kind === 'INVOICE' ? yr.amount.plus(local) : yr.amount.minus(local);
      yr.documents++;
    }
    return out.filter((x) => x.documents > 0).map((x) => ({ label: x.label, from: x.from, to: x.to, amount: money(x.amount), documents: x.documents }));
  }

  async overview(org: OrgContext, enteredTurnover: string | null) {
    const country = await this.country(org);
    const today = todayIso();
    const format = invoiceFormatRule(country);
    const rule = eInvoicingRule(country);
    const seller = await this.seller(org, country);
    let turnover: {
      basis: 'FISCAL_YEAR' | 'CALENDAR_YEAR';
      source: 'BOOKS' | 'ENTERED' | 'NONE';
      amount: string | null;
      currency: string;
      usedYear: string | null;
      rule: string;
      years: Awaited<ReturnType<InvoiceRequirementsService['turnoverYears']>>;
    } | null = null;
    if (rule?.turnoverBasis) {
      const sameCurrency = org.functionalCurrency === rule.currency;
      const years = sameCurrency ? await this.turnoverYears(org, rule.turnoverBasis, today) : [];
      // India tests the highest year since 2017-18; other countries the year just ended.
      const pickRule =
        country === 'IN' ? 'The highest completed financial year in the books' : rule.turnoverBasis === 'CALENDAR_YEAR' ? 'The previous calendar year' : 'The last completed financial year';
      const used = country === 'IN' ? [...years].sort((a, b) => new D(b.amount).cmp(a.amount))[0] : years[0];
      turnover =
        enteredTurnover !== null
          ? { basis: rule.turnoverBasis, source: 'ENTERED', amount: money(new D(enteredTurnover)), currency: rule.currency, usedYear: null, rule: pickRule, years }
          : used
            ? { basis: rule.turnoverBasis, source: 'BOOKS', amount: used.amount, currency: rule.currency, usedYear: used.label, rule: pickRule, years }
            : { basis: rule.turnoverBasis, source: 'NONE', amount: null, currency: rule.currency, usedYear: null, rule: pickRule, years };
    }
    const outlook = rule ? eInvoicingOutlook(rule, { today, turnover: turnover?.amount ?? null }) : null;
    const templates = await this.templates(org, country);
    return {
      today,
      country,
      covered: !!format,
      coveredCountries: INVOICE_FORMAT_RULES.map((r) => ({ country: r.country, countryName: r.countryName })),
      format: format ? { ...format, tiers: format.tiers.map((t) => ({ ...t, items: t.items.map((i) => ({ ...i, label: INVOICE_REQUIREMENT_LABEL[i.key] })) })) } : null,
      seller: {
        taxNumber: seller.taxNumber,
        taxNumberName: seller.taxNumberName,
        address: seller.addressOnFile || templates.fallback.headerAddress,
        defaultTemplate: templates.fallback.name,
        templateWarnings: templates.fallback.warnings,
      },
      eInvoicing: rule ? { ...rule, outlook, turnover, setUpInTalk2Tax: country === 'IN' ? seller.eInvoiceSetUp : null } : null,
      otherCountries: E_INVOICING_RULES.filter((r) => r.country !== country).map((r) => ({
        country: r.country,
        countryName: r.countryName,
        status: r.status,
        summary: r.summary,
        format: r.format,
        source: r.source,
      })),
    };
  }

  private requireRule(country: string): InvoiceFormatRule {
    const rule = invoiceFormatRule(country);
    if (!rule) {
      const names = INVOICE_FORMAT_RULES.map((r) => r.countryName).join(', ');
      throw new DomainError('NO_INVOICE_RULES', `Talk2Tax checks invoices against the rules of ${names}. Your organisation's country is not one of them yet.`, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    return rule;
  }

  private async load(org: OrgContext, where: { id?: string; from?: string; to?: string }) {
    return this.prisma.document.findMany({
      where: {
        orgId: org.id,
        kind: { in: ['INVOICE', 'CREDIT_NOTE'] },
        status: { not: 'VOID' },
        ...(where.id ? { id: where.id } : { issueDate: { gte: toDbDate(where.from!), lte: toDbDate(where.to!) } }),
      },
      include: {
        contact: { select: { name: true, address: true, gstin: true, taxId: true } },
        lines: { orderBy: { lineNo: 'asc' }, select: { description: true, quantity: true, taxRateId: true, hsnCode: true } },
      },
      orderBy: [{ issueDate: 'desc' }, { number: 'desc' }],
      take: MAX_CHECKED + 1,
    });
  }

  private judge(
    rule: InvoiceFormatRule,
    seller: Awaited<ReturnType<InvoiceRequirementsService['seller']>>,
    templates: Awaited<ReturnType<InvoiceRequirementsService['templates']>>,
    d: Awaited<ReturnType<InvoiceRequirementsService['load']>>[number],
  ) {
    const t = templates.pick(d.templateId);
    const total = new D(d.total.toFixed());
    const grossLocal = total.times(d.exchangeRate.toFixed());
    const buyerTaxNumber = d.counterpartyGstin ?? d.contact.gstin ?? d.contact.taxId ?? null;
    const res = checkInvoiceContent(rule, {
      grossLocal: grossLocal.toFixed(),
      numbered: d.status === 'POSTED' && !!d.number,
      title: t.titleText,
      sellerTaxNumber: seller.taxNumber,
      sellerAddress: seller.addressOnFile || t.headerAddress,
      buyerName: d.contact.name,
      buyerAddress: !!d.contact.address?.trim(),
      buyerTaxNumber,
      reverseCharge: d.reverseCharge,
      interstate: rule.country === 'IN' && !!d.placeOfSupply && !!seller.stateCode && d.placeOfSupply !== seller.stateCode,
      placeOfSupply: d.placeOfSupply,
      lines: d.lines.map((l) => ({ description: l.description, quantity: l.quantity.toFixed(), taxRateChosen: !!l.taxRateId, hsnCode: l.hsnCode })),
    });
    return {
      id: d.id,
      kind: d.kind,
      status: d.status,
      number: d.number,
      issueDate: fromDbDate(d.issueDate),
      contactId: d.contactId,
      contactName: d.contact.name,
      currency: d.currency,
      total: total.toFixed(2),
      totalLocal: money(grossLocal),
      template: t.name,
      format: res.tier,
      required: res.required,
      gaps: res.gaps,
    };
  }

  async check(org: OrgContext, from: string, to: string) {
    if (from > to) throw new DomainError('INVALID_RANGE', 'The period must start on or before its end', HttpStatus.UNPROCESSABLE_ENTITY);
    const country = await this.country(org);
    const rule = this.requireRule(country);
    const [seller, templates, docs] = await Promise.all([this.seller(org, country), this.templates(org, country), this.load(org, { from, to })]);
    const rows = docs.slice(0, MAX_CHECKED).map((d) => this.judge(rule, seller, templates, d));
    const byKey = new Map<InvoiceRequirementKey, number>();
    for (const r of rows) for (const g of r.gaps) byKey.set(g.key, (byKey.get(g.key) ?? 0) + 1);
    const used = new Map(
      docs
        .slice(0, MAX_CHECKED)
        .map((d) => templates.pick(d.templateId))
        .map((t) => [t.name, t.warnings] as const),
    );
    return {
      from,
      to,
      country,
      currency: rule.currency,
      checked: rows.length,
      truncated: docs.length > MAX_CHECKED,
      complete: rows.filter((r) => r.gaps.length === 0).length,
      withGaps: rows.filter((r) => r.gaps.length > 0).length,
      byRequirement: [...byKey.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, label: INVOICE_REQUIREMENT_LABEL[key], count })),
      formats: [...new Set(rows.map((r) => r.format))].map((name) => ({ name, count: rows.filter((r) => r.format === name).length })),
      templateWarnings: [...used.entries()].flatMap(([template, warnings]) => warnings.map((message) => ({ template, message }))),
      invoices: rows,
    };
  }

  async document(org: OrgContext, id: string) {
    const country = await this.country(org);
    const rule = this.requireRule(country);
    const [seller, templates, docs] = await Promise.all([this.seller(org, country), this.templates(org, country), this.load(org, { id })]);
    const d = docs[0];
    if (!d) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Invoice not found' });
    return { country, rule: { countryName: rule.countryName, source: rule.source, alsoRequired: rule.alsoRequired }, ...this.judge(rule, seller, templates, d) };
  }
}
