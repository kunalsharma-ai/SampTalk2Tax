import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { GstPaymentsService } from './gst-payments.service';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM');
const PaymentBody = z
  .object({
    period: month,
    paymentDate: isoDate,
    bankAccountId: z.uuid().nullable().default(null),
    cpin: z.string().trim().max(14).nullable().default(null),
    cin: z.string().trim().max(30).nullable().default(null),
    interest: z.string().trim().max(20).default('0'),
    lateFee: z.string().trim().max(20).default('0'),
    chargesAccountId: z.uuid().nullable().default(null),
    memo: z.string().trim().max(500).nullable().default(null),
  })
  .strict();
const VoidBody = z.object({ date: isoDate, reason: z.string().max(500) }).strict();

/** GST payments and set-off (TAX-022): reports.read sees them; recording and voiding need journals.post too. */
@ApiTags('gst')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/gst/payments')
export class GstPaymentsController {
  constructor(private readonly svc: GstPaymentsService) {}

  @Get()
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.svc.list(org);
  }

  /** What a month leaves to settle: tax payable, credit, set-off and cash. */
  @Get('preview')
  @RequirePermission('reports.read')
  async preview(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(z.object({ period: month }))) q: { period: string }) {
    const { _setOff, ...rest } = await this.svc.preview(org, q.period);
    void _setOff;
    return rest;
  }

  @Post()
  @RequirePermission('reports.read')
  @ApiBody({ schema: openApi(PaymentBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(PaymentBody)) body: z.infer<typeof PaymentBody>) {
    return this.svc.create(org, user.id, body);
  }

  @Post(':paymentId/void')
  @RequirePermission('reports.read')
  @ApiBody({ schema: openApi(VoidBody) })
  void(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('paymentId', ParseUUIDPipe) id: string, @Body(new ZodPipe(VoidBody)) body: z.infer<typeof VoidBody>) {
    return this.svc.void(org, user.id, id, body);
  }
}
