import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { decimalString, isoDate, openApi, ZodPipe } from '../common/zod';
import { ProFormaService } from './pro-forma.service';

const id = z.string().uuid('Not a valid id');
const text = (max: number) => z.string().trim().max(max, `Keep it under ${max} characters`).nullish();
const Line = z
  .object({ accountId: z.string().uuid('Choose an income account'), description: text(500), quantity: decimalString, unitPrice: decimalString, taxRateId: z.string().uuid().nullish(), hsnCode: z.string().trim().max(8).nullish() })
  .strict();
const Body_ = z
  .object({
    contactId: z.string().uuid('Choose the customer'),
    quoteId: id.nullish(),
    issueDate: isoDate,
    validUntil: isoDate,
    placeOfSupply: z.string().regex(/^\d{2}$/).nullish(),
    reference: text(100),
    terms: text(4000),
    memo: text(1000),
    lines: z.array(Line).min(1, 'Add at least one line').max(200),
  })
  .strict();
const ListQuery = z.object({ view: z.enum(['open', 'invoiced', 'all']).optional(), contactId: id.optional() });
const ReasonBody = z.object({ reason: z.string().trim().min(1, 'Give a reason').max(500) }).strict();
const PrintQuery = z.object({ templateId: id.optional() });
const InvoiceBody = z.object({ issueDate: isoDate, dueDate: isoDate.nullish() }).strict();

/** Pro forma invoices (AR-008). */
@ApiTags('sales')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/sales/pro-formas')
export class ProFormaController {
  constructor(private readonly proFormas: ProFormaService) {}

  @Get()
  @RequirePermission('sales.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.proFormas.list(org, q);
  }

  /** The pro forma as an invoice print source with the organisation's invoice template. */
  @Get(':id/print')
  @RequirePermission('sales.read')
  print(@CurrentOrg() org: OrgContext, @Param('id', new ZodPipe(id)) pid: string, @Query(new ZodPipe(PrintQuery)) q: z.infer<typeof PrintQuery>) {
    return this.proFormas.printData(org, pid, q.templateId);
  }

  @Get(':id')
  @RequirePermission('sales.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', new ZodPipe(id)) pid: string) {
    return this.proFormas.get(org, pid);
  }

  /** A draft pro forma invoice; its lines are worked out by the invoice rules. */
  @Post()
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(Body_) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(Body_)) b: z.infer<typeof Body_>) {
    return this.proFormas.create(org, user, b);
  }

  @Put(':id')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(Body_) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) pid: string, @Body(new ZodPipe(Body_)) b: z.infer<typeof Body_>) {
    return this.proFormas.update(org, user, pid, b);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('sales.manage')
  async remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) pid: string) {
    await this.proFormas.remove(org, user, pid);
  }

  @Post(':id/issue')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  issue(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) pid: string) {
    return this.proFormas.issue(org, user, pid);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(ReasonBody) })
  cancel(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) pid: string, @Body(new ZodPipe(ReasonBody)) b: z.infer<typeof ReasonBody>) {
    return this.proFormas.cancel(org, user, pid, b.reason);
  }

  /** A draft tax invoice with the pro forma's lines. */
  @Post(':id/invoice')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(InvoiceBody) })
  invoice(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) pid: string, @Body(new ZodPipe(InvoiceBody)) b: z.infer<typeof InvoiceBody>) {
    return this.proFormas.invoice(org, user, pid, b);
  }
}
