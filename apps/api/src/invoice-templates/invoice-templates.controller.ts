import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { INVOICE_PAGE_CSP } from '@talk2tax/accounting-engine';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { InvoiceTemplatesService } from './invoice-templates.service';

const name = z.string().trim().min(1, 'Give the template a name').max(120, 'Keep the name under 120 characters');
const CreateBody = z
  .object({
    name,
    presetId: z.enum(['IN_GST', 'AE_VAT', 'GB_VAT', 'US_SALES', 'SG_GST', 'AU_GST', 'EU_VAT', 'GENERIC']),
    engine: z.enum(['LAYOUT', 'HTML']).optional(),
    theme: z.enum(['CLASSIC', 'MODERN', 'MINIMAL', 'BOLD', 'ELEGANT']).nullish(),
    paletteId: z.string().max(40).nullish(),
  })
  .strict();
// The layout's own rules are checked by the engine (normaliseLayout), which gives clearer messages.
const UpdateBody = z.object({ name, engine: z.enum(['LAYOUT', 'HTML']), layout: z.record(z.string(), z.unknown()), html: z.string().max(400_000).nullish() }).strict();
const DuplicateBody = z.object({ name: z.string().trim().max(120).nullish() }).strict();
const ArchiveBody = z.object({ archived: z.boolean() }).strict();
const ImageBody = z.object({ imageBase64: z.string().min(1, 'Choose an image').max(1_000_000, 'The image is too large') }).strict();
const SignatureBody = z
  .object({
    kind: z.enum(['DRAWN', 'UPLOADED', 'TYPED']),
    signerName: z.string().trim().min(1, 'Give the name to print under the signature').max(120),
    designation: z.string().trim().max(120).nullish(),
    imageBase64: z.string().min(1, 'Draw, upload or type a signature').max(500_000, 'The signature image is too large'),
  })
  .strict();
const TemplateChoiceBody = z.object({ templateId: z.string().uuid('Not a template id').nullable() }).strict();
const WithdrawBody = z.object({ reason: z.string().trim().min(3, 'Say why the signature is withdrawn').max(300) }).strict();
const PrintQuery = z.object({ templateId: z.string().uuid('Not a template id').optional(), download: z.enum(['0', '1']).optional() });

@ApiTags('invoice-templates')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/invoice-templates')
export class InvoiceTemplatesController {
  constructor(private readonly templates: InvoiceTemplatesService) {}

  @Get()
  @RequirePermission('sales.read')
  list(@CurrentOrg() org: OrgContext, @Query('archived') archived?: string) {
    return this.templates.list(org, archived === '1');
  }

  @Get(':id')
  @RequirePermission('sales.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.templates.get(org, id);
  }

  /** A new template from a country preset, optionally with a theme and palette, as a layout or an HTML template. */
  @Post()
  @RequirePermission('templates.manage')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>) {
    return this.templates.create(org, user, body);
  }

  /** Save the whole design: name, engine, layout (theme, palette, font, labels, sections) and HTML. */
  @Put(':id')
  @RequirePermission('templates.manage')
  @ApiBody({ schema: openApi(UpdateBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(UpdateBody)) body: z.infer<typeof UpdateBody>) {
    return this.templates.update(org, user, id, body);
  }

  @Post(':id/duplicate')
  @RequirePermission('templates.manage')
  @ApiBody({ schema: openApi(DuplicateBody) })
  duplicate(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(DuplicateBody)) body: z.infer<typeof DuplicateBody>) {
    return this.templates.duplicate(org, user, id, body.name);
  }

  @Post(':id/default')
  @HttpCode(200)
  @RequirePermission('templates.manage')
  makeDefault(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.templates.makeDefault(org, user, id);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermission('templates.manage')
  @ApiBody({ schema: openApi(ArchiveBody) })
  archive(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ArchiveBody)) body: z.infer<typeof ArchiveBody>) {
    return this.templates.archive(org, user, id, body.archived);
  }

  /** PNG, JPEG or WebP up to 500 KB, base64 (a data: URL is accepted). SVG is refused. */
  @Put(':id/logo')
  @RequirePermission('templates.manage')
  @ApiBody({ schema: openApi(ImageBody) })
  setLogo(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ImageBody)) body: z.infer<typeof ImageBody>) {
    return this.templates.setLogo(org, user, id, body.imageBase64);
  }

  @Delete(':id/logo')
  @RequirePermission('templates.manage')
  removeLogo(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.templates.setLogo(org, user, id, null);
  }
}

/** Printing invoices and credit notes with a template, and e-signing them. */
@ApiTags('invoice-templates')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/invoice-print/:documentId')
export class InvoicePrintController {
  constructor(private readonly templates: InvoiceTemplatesService) {}

  @Get()
  @RequirePermission('sales.read')
  data(@CurrentOrg() org: OrgContext, @Param('documentId', ParseUUIDPipe) documentId: string, @Query(new ZodPipe(PrintQuery)) q: z.infer<typeof PrintQuery>) {
    return this.templates.printData(org, documentId, q.templateId);
  }

  /** The invoice as one self-contained HTML page (no script, nothing loaded from the network). */
  @Get('html')
  @RequirePermission('sales.read')
  async html(@CurrentOrg() org: OrgContext, @Param('documentId', ParseUUIDPipe) documentId: string, @Query(new ZodPipe(PrintQuery)) q: z.infer<typeof PrintQuery>, @Res() res: Response) {
    const out = await this.templates.printHtml(org, documentId, q.templateId);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', `${INVOICE_PAGE_CSP}; sandbox allow-modals`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `${q.download === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(out.fileName)}`);
    res.end(out.html);
  }

  /** Print this invoice with a chosen template from now on; null = the organisation's default. */
  @Put('template')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(TemplateChoiceBody) })
  setTemplate(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('documentId', ParseUUIDPipe) documentId: string, @Body(new ZodPipe(TemplateChoiceBody)) body: z.infer<typeof TemplateChoiceBody>) {
    return this.templates.setDocumentTemplate(org, user, documentId, body.templateId);
  }

  /** E-sign a posted invoice with your saved signature; records a SHA-256 of what was signed. */
  @Post('signature')
  @HttpCode(200)
  @RequirePermission('documents.sign')
  sign(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('documentId', ParseUUIDPipe) documentId: string, @Headers('user-agent') ua?: string) {
    return this.templates.sign(org, user, documentId, ua ?? null);
  }

  @Post('signature/withdraw')
  @HttpCode(200)
  @RequirePermission('documents.sign')
  @ApiBody({ schema: openApi(WithdrawBody) })
  withdraw(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('documentId', ParseUUIDPipe) documentId: string, @Body(new ZodPipe(WithdrawBody)) body: z.infer<typeof WithdrawBody>) {
    return this.templates.withdraw(org, user, documentId, body.reason);
  }
}

/** The signed-in member's own e-signature in this organisation. */
@ApiTags('invoice-templates')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/signatures/me')
export class SignaturesController {
  constructor(private readonly templates: InvoiceTemplatesService) {}

  @Get()
  @RequirePermission('documents.sign')
  mine(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    return this.templates.mySignature(org, user);
  }

  /** Save (or replace) your signature: a drawn, uploaded or typed image, PNG/JPEG/WebP up to 300 KB. */
  @Put()
  @RequirePermission('documents.sign')
  @ApiBody({ schema: openApi(SignatureBody) })
  save(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(SignatureBody)) body: z.infer<typeof SignatureBody>) {
    return this.templates.saveSignature(org, user, body);
  }

  @Delete()
  @RequirePermission('documents.sign')
  remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    return this.templates.removeSignature(org, user);
  }
}
