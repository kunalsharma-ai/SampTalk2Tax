import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { decimalString, isoDate, openApi, ZodPipe } from '../common/zod';
import { InternationalPaymentsService, RemitOrg } from './international-payments.service';

const id = z.string().uuid('Not a valid id');
const Body_ = z
  .object({
    contactId: id,
    bankAccountId: id,
    paymentDate: isoDate,
    currency: z.string().regex(/^[A-Za-z]{3}$/, 'A currency is three letters'),
    items: z.array(z.object({ documentId: id, amount: decimalString.nullish() }).strict()).min(1, 'Add at least one bill').max(100),
    purposeCode: z.string().trim().max(5).nullish(),
    purpose: z.string().trim().max(200).nullish(),
    charges: z.enum(['OUR', 'SHA', 'BEN']).optional(),
    taxableInIndia: z.boolean().optional(),
    hasTaxOrder: z.boolean().optional(),
    estimateRate: decimalString.nullish(),
    form15caAck: z.string().trim().max(40).nullish(),
    form15cbNumber: z.string().trim().max(40).nullish(),
    memo: z.string().trim().max(500).nullish(),
  })
  .strict();
const PaidBody = z.object({ rate: decimalString, date: isoDate.nullish(), bankReference: z.string().trim().max(60).nullish() }).strict();
const CancelBody = z.object({ reason: z.string().trim().min(1, 'Say why it is cancelled').max(500) }).strict();
const ListQuery = z.object({ status: z.enum(['DRAFT', 'APPROVED', 'SENT', 'PAID', 'CANCELLED']).optional() });

/** International payments (AP-023): outward remittances to vendors abroad, prepared, approved, sent and recorded. */
@ApiTags('international payments')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/purchases/international-payments')
export class InternationalPaymentsController {
  constructor(private readonly svc: InternationalPaymentsService) {}

  private org(o: OrgContext): RemitOrg {
    return { id: o.id, role: o.role, functionalCurrency: o.functionalCurrency };
  }

  @Get()
  @RequirePermission('purchases.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.svc.list(this.org(org), q);
  }

  /** Posted bills in foreign currencies with something left to pay. */
  @Get('payable')
  @RequirePermission('purchases.read')
  payable(@CurrentOrg() org: OrgContext) {
    return this.svc.payable(this.org(org));
  }

  @Get(':id')
  @RequirePermission('purchases.read')
  get(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) pid: string) {
    return this.svc.get(this.org(org), pid, user);
  }

  @Post()
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(Body_) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(Body_)) body: z.infer<typeof Body_>) {
    return this.svc.create(this.org(org), user, body);
  }

  @Put(':id')
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(Body_) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) pid: string, @Body(new ZodPipe(Body_)) body: z.infer<typeof Body_>) {
    return this.svc.update(this.org(org), user, pid, body);
  }

  @Delete(':id')
  @RequirePermission('purchases.manage')
  remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) pid: string) {
    return this.svc.remove(this.org(org), user, pid);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('approvals.decide')
  approve(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) pid: string) {
    return this.svc.approve(this.org(org), user, pid);
  }

  /** The remittance instruction (CSV) for the bank; the first download marks it sent. */
  @Post(':id/instruction')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  async instruction(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) pid: string, @Res() res: Response) {
    const f = await this.svc.instruction(this.org(org), user, pid);
    const body = Buffer.from(f.csv, 'utf8');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(body);
  }

  @Post(':id/paid')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(PaidBody) })
  paid(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) pid: string, @Body(new ZodPipe(PaidBody)) body: z.infer<typeof PaidBody>) {
    return this.svc.markPaid(this.org(org), user, pid, body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(CancelBody) })
  cancel(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) pid: string, @Body(new ZodPipe(CancelBody)) body: z.infer<typeof CancelBody>) {
    return this.svc.cancel(this.org(org), user, pid, body.reason);
  }
}
