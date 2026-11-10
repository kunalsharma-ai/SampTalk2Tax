import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  canonicalInvoiceContent,
  checkHtmlTemplate,
  COUNTRY_PRESETS,
  InvoiceTemplateError,
  layoutFromPreset,
  layoutWarnings,
  MAX_LOGO_BYTES,
  MAX_SIGNATURE_BYTES,
  minorUnits,
  normaliseLayout,
  paletteById,
  presetForCountry,
  renderInvoiceDocument,
  sniffImageType,
  starterHtml,
  type InvoicePrintSource,
  type InvoiceTheme,
  type LayoutConfig,
  type SignatureKind,
  type TemplateEngine,
} from '@talk2tax/accounting-engine';
import { InvoiceTemplate, Prisma } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { fromDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { DOCUMENTS } from '../db/collections/sales';
import { MovedTables } from '../db/moved-table';
import { PrismaService, Tx } from '../common/prisma.service';

export interface TemplateOrg {
  id: string;
  role: RoleName;
}
type Actor = { id: string };

export interface CreateTemplateInput {
  name: string;
  presetId: string;
  engine?: TemplateEngine;
  theme?: InvoiceTheme | null;
  paletteId?: string | null;
}

export interface UpdateTemplateInput {
  name: string;
  engine: TemplateEngine;
  layout: unknown;
  html?: string | null;
}

export interface SignatureInput {
  kind: SignatureKind;
  signerName: string;
  designation?: string | null;
  imageBase64: string;
}

const SALES_KINDS = ['INVOICE', 'CREDIT_NOTE'] as const;

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const dataUrl = (type: string, bytes: Uint8Array) => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;

/**
 * Invoice templates (country presets, themes, palettes, editable sections, logos, HTML
 * templates), the data an invoice prints with, and e-signatures on posted invoices.
 */
@Injectable()
export class InvoiceTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly moved: MovedTables,
  ) {}

  private invalid(message: string, details?: unknown): never {
    throw new DomainError('TEMPLATE_INVALID', message, HttpStatus.UNPROCESSABLE_ENTITY, details);
  }

  private wrap<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof InvoiceTemplateError) this.invalid(e.message);
      throw e;
    }
  }

  private decodeImage(base64: string, max: number, label: string) {
    const clean = base64.replace(/^data:[^;,]+;base64,/, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || !clean) {
      throw new DomainError('IMAGE_INVALID', `${label} must be a PNG, JPEG or WebP image`, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const bytes = Buffer.from(clean, 'base64');
    if (bytes.length > max) {
      throw new DomainError('IMAGE_TOO_LARGE', `${label} must be ${Math.round(max / 1000)} KB or smaller`, HttpStatus.PAYLOAD_TOO_LARGE);
    }
    const type = sniffImageType(bytes);
    if (!type) throw new DomainError('IMAGE_INVALID', `${label} must be a PNG, JPEG or WebP image (SVG is not accepted)`, HttpStatus.UNPROCESSABLE_ENTITY);
    return { bytes, type };
  }

  // ------------------------------------------------------------------ templates

  private serialize(t: InvoiceTemplate, usage = 0, full = false) {
    const layout = t.layout as unknown as LayoutConfig;
    return {
      id: t.id,
      name: t.name,
      presetId: t.presetId,
      presetName: COUNTRY_PRESETS.find((p) => p.id === t.presetId)?.name ?? t.presetId,
      engine: t.engine,
      theme: layout.theme,
      palette: layout.palette,
      title: layout.title,
      isDefault: t.isDefault,
      archived: t.archivedAt !== null,
      hasLogo: t.logo !== null,
      documentsUsing: usage,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      ...(full
        ? {
            layout,
            html: t.html,
            logoDataUrl: t.logo && t.logoType ? dataUrl(t.logoType, t.logo) : null,
            warnings: this.warnings(t.engine, layout, t.html, t.presetId),
          }
        : {}),
    };
  }

  private warnings(engine: TemplateEngine, layout: LayoutConfig, html: string | null, presetId: string) {
    if (engine === 'HTML') {
      const check = checkHtmlTemplate(html ?? '');
      return check.unknownPlaceholders.map((p) => `{{${p}}} is not a known placeholder and will print empty.`);
    }
    return layoutWarnings(layout, presetId);
  }

  private async usage(orgId: string): Promise<Map<string, number>> {
    const rows = await this.prisma.document.groupBy({ by: ['templateId'], where: { orgId, templateId: { not: null }, status: { not: 'VOID' } }, _count: { _all: true } });
    return new Map(rows.map((r) => [r.templateId!, r._count._all]));
  }

  async list(org: TemplateOrg, includeArchived = false) {
    const [rows, usage] = await Promise.all([
      this.prisma.invoiceTemplate.findMany({ where: { orgId: org.id, ...(includeArchived ? {} : { archivedAt: null }) }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] }),
      this.usage(org.id),
    ]);
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { countryCode: true } });
    return { suggestedPresetId: presetForCountry(o.countryCode).id, items: rows.map((t) => this.serialize(t, usage.get(t.id) ?? 0)) };
  }

  private async find(db: Tx | PrismaService, orgId: string, id: string) {
    const t = await db.invoiceTemplate.findFirst({ where: { id, orgId } });
    if (!t) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Template not found' });
    return t;
  }

  async get(org: TemplateOrg, id: string) {
    const t = await this.find(this.prisma, org.id, id);
    const usage = await this.prisma.document.count({ where: { orgId: org.id, templateId: id, status: { not: 'VOID' } } });
    return this.serialize(t, usage, true);
  }

  private async checkName(tx: Tx, orgId: string, name: string, exceptId?: string) {
    const clash = await tx.invoiceTemplate.findFirst({ where: { orgId, archivedAt: null, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) } });
    if (clash) throw new DomainError('TEMPLATE_NAME_TAKEN', `A template called ${clash.name} already exists`, HttpStatus.CONFLICT);
  }

  async create(org: TemplateOrg, actor: Actor, input: CreateTemplateInput) {
    const name = input.name.trim();
    if (!name) this.invalid('Give the template a name');
    if (!COUNTRY_PRESETS.some((p) => p.id === input.presetId)) this.invalid('Choose a country preset');
    const layout = this.wrap(() =>
      layoutFromPreset(input.presetId, {
        theme: input.theme ?? undefined,
        palette: input.paletteId ? paletteById(input.paletteId) : undefined,
      }),
    );
    const engine = input.engine ?? 'LAYOUT';
    const id = await this.prisma.$transaction(async (tx) => {
      await this.checkName(tx, org.id, name);
      const first = (await tx.invoiceTemplate.count({ where: { orgId: org.id, archivedAt: null } })) === 0;
      const t = await tx.invoiceTemplate.create({
        data: {
          orgId: org.id,
          name,
          presetId: input.presetId,
          engine,
          layout: layout as unknown as Prisma.InputJsonValue,
          html: engine === 'HTML' ? starterHtml(input.presetId) : null,
          isDefault: first,
          createdById: actor.id,
        },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'invoice_template.created', entityType: 'invoice_template', entityId: t.id, data: { name, presetId: input.presetId, engine, theme: layout.theme, isDefault: first } });
      return t.id;
    });
    return this.get(org, id);
  }

  async update(org: TemplateOrg, actor: Actor, id: string, input: UpdateTemplateInput) {
    const name = input.name.trim();
    if (!name) this.invalid('Give the template a name');
    const layout = this.wrap(() => normaliseLayout(input.layout));
    let html: string | null = null;
    if (input.engine === 'HTML') {
      html = (input.html ?? '').replace(/\r\n?/g, '\n');
      const check = checkHtmlTemplate(html);
      if (!check.ok) this.invalid(check.errors[0]!, { issues: check.errors });
    }
    await this.prisma.$transaction(async (tx) => {
      const t = await this.find(tx, org.id, id);
      if (t.archivedAt) throw new DomainError('TEMPLATE_ARCHIVED', 'Restore the template before changing it', HttpStatus.CONFLICT);
      await this.checkName(tx, org.id, name, id);
      await tx.invoiceTemplate.update({ where: { id }, data: { name, engine: input.engine, layout: layout as unknown as Prisma.InputJsonValue, html, updatedById: actor.id } });
      await this.audit.append(tx, {
        orgId: org.id,
        actorId: actor.id,
        action: 'invoice_template.updated',
        entityType: 'invoice_template',
        entityId: id,
        data: { name, engine: input.engine, theme: layout.theme, palette: layout.palette, htmlSha256: html ? sha256(html) : null, sections: layout.sections.filter((s) => s.visible).map((s) => s.key) },
      });
    });
    return this.get(org, id);
  }

  async duplicate(org: TemplateOrg, actor: Actor, id: string, name?: string | null) {
    const newId = await this.prisma.$transaction(async (tx) => {
      const t = await this.find(tx, org.id, id);
      let copyName = name?.trim() || `${t.name} (copy)`;
      for (let n = 2; !name?.trim() && (await tx.invoiceTemplate.findFirst({ where: { orgId: org.id, archivedAt: null, name: { equals: copyName, mode: 'insensitive' } } })); n++) {
        copyName = `${t.name} (copy ${n})`;
      }
      await this.checkName(tx, org.id, copyName);
      const c = await tx.invoiceTemplate.create({
        data: { orgId: org.id, name: copyName, presetId: t.presetId, engine: t.engine, layout: t.layout as Prisma.InputJsonValue, html: t.html, logo: t.logo, logoType: t.logoType, logoSha256: t.logoSha256, createdById: actor.id },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'invoice_template.created', entityType: 'invoice_template', entityId: c.id, data: { name: copyName, copiedFrom: id } });
      return c.id;
    });
    return this.get(org, newId);
  }

  async makeDefault(org: TemplateOrg, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.find(tx, org.id, id);
      if (t.archivedAt) throw new DomainError('TEMPLATE_ARCHIVED', 'Restore the template before making it the default', HttpStatus.CONFLICT);
      await tx.invoiceTemplate.updateMany({ where: { orgId: org.id, isDefault: true, id: { not: id } }, data: { isDefault: false } });
      await tx.invoiceTemplate.update({ where: { id }, data: { isDefault: true } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'invoice_template.default_set', entityType: 'invoice_template', entityId: id, data: { name: t.name } });
    });
    return this.get(org, id);
  }

  async archive(org: TemplateOrg, actor: Actor, id: string, archived: boolean) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.find(tx, org.id, id);
      if (archived) {
        if (t.isDefault) throw new DomainError('TEMPLATE_IS_DEFAULT', 'Make another template the default before archiving this one', HttpStatus.CONFLICT);
        const used = await tx.document.count({ where: { orgId: org.id, templateId: id, status: { not: 'VOID' } } });
        if (used) throw new DomainError('TEMPLATE_IN_USE', `${used} invoice${used === 1 ? ' uses' : 's use'} this template; move ${used === 1 ? 'it' : 'them'} to another template first`, HttpStatus.CONFLICT);
      } else {
        await this.checkName(tx, org.id, t.name, id);
      }
      await tx.invoiceTemplate.update({ where: { id }, data: { archivedAt: archived ? new Date() : null } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: archived ? 'invoice_template.archived' : 'invoice_template.restored', entityType: 'invoice_template', entityId: id, data: { name: t.name } });
    });
    return this.get(org, id);
  }

  async setLogo(org: TemplateOrg, actor: Actor, id: string, imageBase64: string | null) {
    const img = imageBase64 ? this.decodeImage(imageBase64, MAX_LOGO_BYTES, 'The logo') : null;
    await this.prisma.$transaction(async (tx) => {
      const t = await this.find(tx, org.id, id);
      if (t.archivedAt) throw new DomainError('TEMPLATE_ARCHIVED', 'Restore the template before changing it', HttpStatus.CONFLICT);
      await tx.invoiceTemplate.update({
        where: { id },
        data: img ? { logo: img.bytes, logoType: img.type, logoSha256: sha256(img.bytes), updatedById: actor.id } : { logo: null, logoType: null, logoSha256: null, updatedById: actor.id },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: img ? 'invoice_template.logo_set' : 'invoice_template.logo_removed', entityType: 'invoice_template', entityId: id, data: img ? { type: img.type, bytes: img.bytes.length, sha256: sha256(img.bytes) } : {} });
    });
    return this.get(org, id);
  }

  // ------------------------------------------------------------------ printing

  private async salesDocument(db: Tx | PrismaService, org: TemplateOrg, documentId: string) {
    if (!hasPermission(org.role, 'sales.read')) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Invoice not found' });
    const d = await db.document.findFirst({
      where: { id: documentId, orgId: org.id, kind: { in: [...SALES_KINDS] } },
      include: {
        contact: true,
        lines: { orderBy: { lineNo: 'asc' } },
        allocationsIn: { where: { removedOn: null }, select: { amount: true } },
        allocationsOut: { where: { removedOn: null }, select: { amount: true } },
        eInvoices: { where: { status: 'ACTIVE' }, orderBy: { createdAt: 'desc' }, take: 1 },
        debitNoteFor: { select: { number: true, issueDate: true } },
      },
    });
    if (!d) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Invoice not found' });
    return d;
  }

  private contentHash(orgId: string, d: Awaited<ReturnType<InvoiceTemplatesService['salesDocument']>>) {
    return sha256(
      canonicalInvoiceContent({
        documentId: d.id,
        orgId,
        kind: d.kind,
        number: d.number,
        issueDate: fromDbDate(d.issueDate),
        dueDate: fromDbDate(d.dueDate),
        currency: d.currency,
        contactName: d.contact.name,
        contactTaxId: d.counterpartyGstin ?? d.contact.gstin ?? d.contact.taxId,
        lines: d.lines.map((l) => ({ description: l.description, quantity: l.quantity.toFixed(), unitPrice: l.unitPrice.toFixed(), taxRate: l.taxRate.toFixed(), netAmount: l.netAmount.toFixed(), taxAmount: l.taxAmount.toFixed() })),
        subtotal: d.subtotal.toFixed(),
        taxTotal: d.taxTotal.toFixed(),
        total: d.total.toFixed(),
      }),
    );
  }

  /**
   * The template an invoice prints with: the one asked for, else the invoice's own, else the
   * organisation's default, else a built-in one from the organisation's country preset.
   */
  async resolveTemplate(orgId: string, countryCode: string, requested: string | null | undefined, own: string | null) {
    const id = requested ?? own;
    let t = id ? await this.prisma.invoiceTemplate.findFirst({ where: { id, orgId } }) : null;
    if (requested && !t) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Template not found' });
    t ??= await this.prisma.invoiceTemplate.findFirst({ where: { orgId, isDefault: true } });
    if (t) return { id: t.id, name: t.name, presetId: t.presetId, engine: t.engine as TemplateEngine, layout: t.layout as unknown as LayoutConfig, html: t.html, logoDataUrl: t.logo && t.logoType ? dataUrl(t.logoType, t.logo) : null, builtIn: false };
    const preset = presetForCountry(countryCode);
    return { id: null, name: `${preset.name} (built in)`, presetId: preset.id, engine: 'LAYOUT' as TemplateEngine, layout: layoutFromPreset(preset.id), html: null, logoDataUrl: null, builtIn: true };
  }

  private async signatureState(orgId: string, d: Awaited<ReturnType<InvoiceTemplatesService['salesDocument']>>) {
    const rows = await this.prisma.documentSignature.findMany({ where: { orgId, documentId: d.id }, orderBy: { signedAt: 'desc' } });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.signedById, r.withdrawnById]).filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
    const userName = (id: string | null) => (id ? (users.find((u) => u.id === id)?.name ?? null) : null);
    const current = rows.find((r) => r.withdrawnAt === null) ?? null;
    const hash = this.contentHash(orgId, d);
    const verification = !current
      ? null
      : d.status === 'VOID'
        ? { status: 'VOIDED' as const, message: 'The invoice was voided after it was signed.' }
        : current.contentHash === hash
          ? { status: 'VALID' as const, message: 'The invoice is unchanged since it was signed.' }
          : { status: 'CHANGED' as const, message: 'The invoice no longer matches what was signed.' };
    return {
      current: current
        ? {
            id: current.id,
            signerName: current.signerName,
            designation: current.designation,
            signedById: current.signedById,
            signedByName: userName(current.signedById),
            signedAt: current.signedAt.toISOString(),
            contentHash: current.contentHash,
            imageDataUrl: dataUrl(current.imageType, current.image),
          }
        : null,
      verification,
      currentHash: hash,
      history: rows.map((r) => ({
        id: r.id,
        signerName: r.signerName,
        designation: r.designation,
        signedAt: r.signedAt.toISOString(),
        contentHash: r.contentHash,
        withdrawnAt: r.withdrawnAt?.toISOString() ?? null,
        withdrawnByName: userName(r.withdrawnById),
        withdrawReason: r.withdrawReason,
      })),
    };
  }

  /** Everything the print page needs: the invoice's data, the template it prints with, the templates to pick from, and its signature. */
  async printData(org: TemplateOrg, documentId: string, templateId?: string | null) {
    const d = await this.salesDocument(this.prisma, org, documentId);
    const [o, gst, templates] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { name: true, legalName: true, countryCode: true } }),
      this.prisma.gstRegistration.findUnique({ where: { orgId: org.id } }),
      this.prisma.invoiceTemplate.findMany({ where: { orgId: org.id, archivedAt: null }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }], select: { id: true, name: true, isDefault: true, engine: true } }),
    ]);
    const template = await this.resolveTemplate(org.id, o.countryCode, templateId, d.templateId);
    const signature = await this.signatureState(org.id, d);
    const scale = minorUnits(d.currency);
    const paid = (d.kind === 'INVOICE' ? d.allocationsIn : d.allocationsOut).reduce((s, a) => s.plus(a.amount), new Prisma.Decimal(0));
    const ein = d.eInvoices[0];
    const source: InvoicePrintSource = {
      kind: d.debitNoteForId ? 'DEBIT_NOTE' : (d.kind as 'INVOICE' | 'CREDIT_NOTE'),
      originalInvoice: d.debitNoteFor ? { number: d.debitNoteFor.number ?? '', issueDate: fromDbDate(d.debitNoteFor.issueDate) } : null,
      status: d.status,
      number: d.number,
      issueDate: fromDbDate(d.issueDate),
      dueDate: fromDbDate(d.dueDate),
      reference: d.reference,
      memo: d.memo,
      currency: d.currency,
      placeOfSupply: d.placeOfSupply,
      reverseCharge: d.reverseCharge,
      seller: { name: o.name, legalName: gst?.legalName ?? o.legalName, taxId: gst?.gstin ?? null },
      buyer: {
        name: d.contact.name,
        taxId: d.counterpartyGstin ?? d.contact.gstin ?? d.contact.taxId,
        address: d.contact.address,
        city: d.contact.city,
        pincode: d.contact.pincode,
        email: d.contact.email,
        phone: d.contact.phone,
        stateCode: d.contact.stateCode,
      },
      lines: d.lines.map((l) => ({
        description: l.description,
        hsnCode: l.hsnCode,
        quantity: l.quantity.toFixed(),
        unitPrice: l.unitPrice.toFixed(),
        taxRate: l.taxRate.toFixed(),
        netAmount: l.netAmount.toFixed(scale),
        taxAmount: l.taxAmount.toFixed(scale),
        cgstAmount: l.cgstAmount.toFixed(scale),
        sgstAmount: l.sgstAmount.toFixed(scale),
        igstAmount: l.igstAmount.toFixed(scale),
      })),
      subtotal: d.subtotal.toFixed(scale),
      taxTotal: d.taxTotal.toFixed(scale),
      withholdingAmount: d.withholdingKind === 'TCS' ? d.withholdingAmount.toFixed(scale) : '0',
      total: d.total.toFixed(scale),
      paid: paid.toFixed(scale),
      eInvoice: ein ? { irn: ein.irn, ackNo: ein.ackNo, ackDate: ein.ackDate.toISOString() } : null,
      signature: signature.current
        ? { imageDataUrl: signature.current.imageDataUrl, signerName: signature.current.signerName, designation: signature.current.designation, signedAt: signature.current.signedAt, contentHash: signature.current.contentHash }
        : null,
      logoDataUrl: template.logoDataUrl,
    };
    return {
      document: { id: d.id, kind: d.debitNoteForId ? ('DEBIT_NOTE' as const) : d.kind, status: d.status, number: d.number, templateId: d.templateId, contactName: d.contact.name },
      source,
      template,
      templates,
      signature,
    };
  }

  /** The invoice as one self-contained HTML page, for saving or for print services. */
  async printHtml(org: TemplateOrg, documentId: string, templateId?: string | null) {
    const data = await this.printData(org, documentId, templateId);
    const html = this.wrap(() => renderInvoiceDocument({ engine: data.template.engine, layout: data.template.layout, html: data.template.html }, data.source));
    return { html, fileName: `${data.document.number ?? 'draft-invoice'}.html` };
  }

  async setDocumentTemplate(org: TemplateOrg, actor: Actor, documentId: string, templateId: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const d = await this.salesDocument(tx, org, documentId);
      if (d.status === 'VOID') throw new DomainError('DOCUMENT_VOID', 'A void invoice keeps its template', HttpStatus.CONFLICT);
      if (templateId) {
        const t = await this.find(tx, org.id, templateId);
        if (t.archivedAt) throw new DomainError('TEMPLATE_ARCHIVED', 'That template is archived', HttpStatus.CONFLICT);
      }
      await this.moved.update(tx, DOCUMENTS, org.id, documentId, { templateId, updatedAt: new Date() });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'document.template_set', entityType: 'document', entityId: documentId, data: { templateId, before: d.templateId } });
    });
    return this.printData(org, documentId);
  }

  // ------------------------------------------------------------------ signatures

  private serializeSignature(s: { id: string; kind: string; signerName: string; designation: string | null; image: Uint8Array; imageType: string; createdAt: Date }) {
    return { id: s.id, kind: s.kind, signerName: s.signerName, designation: s.designation, imageDataUrl: dataUrl(s.imageType, s.image), createdAt: s.createdAt.toISOString() };
  }

  async mySignature(org: TemplateOrg, actor: Actor) {
    const s = await this.prisma.userSignature.findFirst({ where: { orgId: org.id, userId: actor.id, revokedAt: null } });
    const signed = await this.prisma.documentSignature.count({ where: { orgId: org.id, signedById: actor.id, withdrawnAt: null } });
    return { signature: s ? this.serializeSignature(s) : null, documentsSigned: signed };
  }

  async saveSignature(org: TemplateOrg, actor: Actor, input: SignatureInput) {
    const signerName = input.signerName.trim();
    if (!signerName) this.invalid('Give the name to print under the signature');
    const img = this.decodeImage(input.imageBase64, MAX_SIGNATURE_BYTES, 'The signature');
    await this.prisma.$transaction(async (tx) => {
      const old = await tx.userSignature.findFirst({ where: { orgId: org.id, userId: actor.id, revokedAt: null } });
      if (old) await tx.userSignature.update({ where: { id: old.id }, data: { revokedAt: new Date() } });
      const s = await tx.userSignature.create({
        data: { orgId: org.id, userId: actor.id, kind: input.kind, signerName, designation: input.designation?.trim() || null, image: img.bytes, imageType: img.type, imageSha256: sha256(img.bytes) },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'signature.saved', entityType: 'user_signature', entityId: s.id, data: { kind: input.kind, signerName, imageSha256: sha256(img.bytes), replaced: old?.id ?? null } });
    });
    return this.mySignature(org, actor);
  }

  async removeSignature(org: TemplateOrg, actor: Actor) {
    await this.prisma.$transaction(async (tx) => {
      const old = await tx.userSignature.findFirst({ where: { orgId: org.id, userId: actor.id, revokedAt: null } });
      if (!old) throw new NotFoundException({ error: 'NOT_FOUND', message: 'You have no signature saved' });
      await tx.userSignature.update({ where: { id: old.id }, data: { revokedAt: new Date() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'signature.removed', entityType: 'user_signature', entityId: old.id, data: {} });
    });
    return this.mySignature(org, actor);
  }

  async sign(org: TemplateOrg, actor: Actor, documentId: string, userAgent: string | null) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM documents WHERE id = ${documentId}::uuid AND org_id = ${org.id}::uuid FOR UPDATE`;
      const d = await this.salesDocument(tx, org, documentId);
      if (d.status !== 'POSTED') throw new DomainError('DOCUMENT_NOT_POSTED', 'Post the invoice before signing it; drafts can still change', HttpStatus.CONFLICT);
      const existing = await tx.documentSignature.findFirst({ where: { orgId: org.id, documentId, withdrawnAt: null } });
      if (existing) throw new DomainError('ALREADY_SIGNED', `Already signed by ${existing.signerName}; withdraw that signature first to sign again`, HttpStatus.CONFLICT);
      const s = await tx.userSignature.findFirst({ where: { orgId: org.id, userId: actor.id, revokedAt: null } });
      if (!s) throw new DomainError('NO_SIGNATURE', 'Save your signature first (Settings → My signature)', HttpStatus.CONFLICT);
      const contentHash = this.contentHash(org.id, d);
      const row = await tx.documentSignature.create({
        data: { orgId: org.id, documentId, signatureId: s.id, signedById: actor.id, signerName: s.signerName, designation: s.designation, image: s.image, imageType: s.imageType, contentHash, userAgent: userAgent?.slice(0, 300) ?? null },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'document.signed', entityType: 'document', entityId: documentId, data: { documentSignatureId: row.id, number: d.number, contentHash, signatureImageSha256: s.imageSha256, signerName: s.signerName } });
    });
    return this.printData(org, documentId);
  }

  async withdraw(org: TemplateOrg, actor: Actor, documentId: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const d = await this.salesDocument(tx, org, documentId);
      const current = await tx.documentSignature.findFirst({ where: { orgId: org.id, documentId, withdrawnAt: null } });
      if (!current) throw new DomainError('NOT_SIGNED', 'The invoice is not signed', HttpStatus.CONFLICT);
      if (current.signedById !== actor.id && !hasPermission(org.role, 'org.manage')) {
        throw new DomainError('NOT_YOUR_SIGNATURE', 'Only the signer, an owner or an admin can withdraw this signature', HttpStatus.FORBIDDEN);
      }
      await tx.documentSignature.update({ where: { id: current.id }, data: { withdrawnAt: new Date(), withdrawnById: actor.id, withdrawReason: reason.trim() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'document.signature_withdrawn', entityType: 'document', entityId: documentId, data: { documentSignatureId: current.id, number: d.number, reason: reason.trim() } });
    });
    return this.printData(org, documentId);
  }
}
