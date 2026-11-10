import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { decimalString, isoDate, openApi, ZodPipe } from '../common/zod';
import { RetainersService } from './retainers.service';

const id = z.string().uuid('Not a valid id');
const text = (max: number) => z.string().trim().max(max, `Keep it under ${max} characters`).nullish();
const Terms = { name: z.string().trim().min(1, 'Give the retainer a name').max(200), amount: decimalString, minimumBalance: decimalString, startDate: isoDate, terms: text(2000) };
const CreateBody = z.object({ contactId: z.string().uuid('Choose the customer'), ...Terms }).strict();
const UpdateBody = z.object(Terms).strict();
const ReceiptBody = z.object({ paymentId: id.nullish(), date: isoDate.nullish(), bankAccountId: id.nullish(), amount: decimalString.nullish(), reference: text(100), memo: text(1000) }).strict();
const DrawdownBody = z.object({ invoices: z.array(z.object({ documentId: id, amount: decimalString }).strict()).max(200).nullish(), oldestFirst: z.boolean().nullish() }).strict();
const ReasonBody = z.object({ reason: z.string().trim().min(1, 'Give a reason').max(500) }).strict();
const ListQuery = z.object({ view: z.enum(['active', 'closed', 'all']).optional(), contactId: id.optional() });

@ApiTags('sales')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/sales/retainers')
export class RetainersController {
  constructor(private readonly retainers: RetainersService) {}

  /** Retainers (active by default) with what each holds and any top-up due. */
  @Get()
  @RequirePermission('sales.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.retainers.list(org, q);
  }

  @Get(':id')
  @RequirePermission('sales.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', new ZodPipe(id)) rid: string) {
    return this.retainers.get(org, rid);
  }

  @Post()
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) b: z.infer<typeof CreateBody>) {
    return this.retainers.create(org, user, b);
  }

  @Put(':id')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(UpdateBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) rid: string, @Body(new ZodPipe(UpdateBody)) b: z.infer<typeof UpdateBody>) {
    return this.retainers.update(org, user, rid, b);
  }

  /** Record a receipt into the retainer, or add an unapplied receipt of the customer. */
  @Post(':id/receipts')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(ReceiptBody) })
  receipt(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) rid: string, @Body(new ZodPipe(ReceiptBody)) b: z.infer<typeof ReceiptBody>) {
    return this.retainers.addReceipt(org, user, rid, b);
  }

  /** Pay invoices from the retainer. */
  @Post(':id/drawdown')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(DrawdownBody) })
  drawdown(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) rid: string, @Body(new ZodPipe(DrawdownBody)) b: z.infer<typeof DrawdownBody>) {
    return this.retainers.drawdown(org, user, rid, b);
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(ReasonBody) })
  close(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) rid: string, @Body(new ZodPipe(ReasonBody)) b: z.infer<typeof ReasonBody>) {
    return this.retainers.close(org, user, rid, b.reason);
  }
}
