import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { decimalString, isoDate, openApi, ZodPipe } from '../common/zod';
import { PurchaseOrdersService } from './purchase-orders.service';

const id = z.string().uuid('Not a valid id');
const text = (max: number) => z.string().trim().max(max, `Keep it under ${max} characters`).nullish();
const percent = z.string().trim().regex(/^\d{1,3}(\.\d{1,2})?$/, 'Enter a percentage such as 2 or 2.5');
const quantity = z.string().trim().regex(/^\d+(\.\d{1,6})?$/, 'Enter a quantity such as 10 or 2.5');
const Line = z
  .object({ accountId: z.string().uuid('Choose an expense or asset account'), description: text(500), quantity: decimalString, unitPrice: decimalString, taxRateId: z.string().uuid().nullish(), hsnCode: z.string().trim().max(8).nullish() })
  .strict();
const OrderBody = z
  .object({
    contactId: z.string().uuid('Choose the vendor'),
    orderDate: isoDate,
    expectedDate: isoDate.nullish(),
    placeOfSupply: z.string().regex(/^\d{2}$/).nullish(),
    reference: text(100),
    terms: text(4000),
    memo: text(1000),
    matchMode: z.enum(['TWO_WAY', 'THREE_WAY']).optional(),
    priceTolerancePercent: percent.optional(),
    quantityTolerancePercent: percent.optional(),
    lines: z.array(Line).min(1, 'Add at least one line').max(200),
  })
  .strict();
const ListQuery = z.object({ view: z.enum(['open', 'to_receive', 'to_bill', 'done', 'all']).optional(), contactId: id.optional() });
const ReasonBody = z.object({ reason: z.string().trim().min(1, 'Give a reason').max(500) }).strict();
const ReceiptBody = z
  .object({
    receiptDate: isoDate,
    reference: text(100),
    memo: text(1000),
    lines: z.array(z.object({ orderLineId: id, quantity, rejected: quantity.nullish(), note: text(500) }).strict()).min(1, 'Enter what was received').max(200),
  })
  .strict();
const BillBody = z.object({ issueDate: isoDate, dueDate: isoDate.nullish(), reference: text(100) }).strict();
const AcceptBody = z.object({ reason: z.string().trim().min(3, 'Say why the differences are accepted').max(1000) }).strict();

/** Purchase orders and goods receipts (AP-015, AP-016). */
@ApiTags('purchases')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/purchases/orders')
export class PurchaseOrdersController {
  constructor(private readonly orders: PurchaseOrdersService) {}

  @Get()
  @RequirePermission('purchases.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.orders.list(org, q);
  }

  @Get(':id')
  @RequirePermission('purchases.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', new ZodPipe(id)) oid: string) {
    return this.orders.get(org, oid);
  }

  /** A draft purchase order; its lines are worked out by the bill rules. */
  @Post()
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(OrderBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(OrderBody)) b: z.infer<typeof OrderBody>) {
    return this.orders.create(org, user, b);
  }

  @Put(':id')
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(OrderBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) oid: string, @Body(new ZodPipe(OrderBody)) b: z.infer<typeof OrderBody>) {
    return this.orders.update(org, user, oid, b);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('purchases.manage')
  async remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) oid: string) {
    await this.orders.remove(org, user, oid);
  }

  @Post(':id/issue')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  issue(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) oid: string) {
    return this.orders.issue(org, user, oid);
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(ReasonBody) })
  close(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) oid: string, @Body(new ZodPipe(ReasonBody)) b: z.infer<typeof ReasonBody>) {
    return this.orders.close(org, user, oid, b.reason);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(ReasonBody) })
  cancel(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) oid: string, @Body(new ZodPipe(ReasonBody)) b: z.infer<typeof ReasonBody>) {
    return this.orders.cancel(org, user, oid, b.reason);
  }

  /** A goods receipt (GRN) against the order. */
  @Post(':id/receipts')
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(ReceiptBody) })
  receive(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) oid: string, @Body(new ZodPipe(ReceiptBody)) b: z.infer<typeof ReceiptBody>) {
    return this.orders.receive(org, user, oid, b);
  }

  @Post(':id/receipts/:receiptId/cancel')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(ReasonBody) })
  cancelReceipt(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodPipe(id)) oid: string,
    @Param('receiptId', new ZodPipe(id)) rid: string,
    @Body(new ZodPipe(ReasonBody)) b: z.infer<typeof ReasonBody>,
  ) {
    return this.orders.cancelReceipt(org, user, oid, rid, b.reason);
  }

  /** A draft bill for what is left to bill on the order. */
  @Post(':id/bill')
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(BillBody) })
  bill(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) oid: string, @Body(new ZodPipe(BillBody)) b: z.infer<typeof BillBody>) {
    return this.orders.bill(org, user, oid, b);
  }
}

/** How a bill matches its purchase order (AP-017). */
@ApiTags('purchases')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/purchases/bills/:documentId/match')
export class BillMatchController {
  constructor(private readonly orders: PurchaseOrdersService) {}

  @Get()
  @RequirePermission('purchases.read')
  get(@CurrentOrg() org: OrgContext, @Param('documentId', new ZodPipe(id)) did: string) {
    return this.orders.match(org, did);
  }

  /** Accept a draft bill's differences from its order so it can post. Needs approvals.decide. */
  @Post('accept')
  @HttpCode(200)
  @RequirePermission('approvals.decide')
  @ApiBody({ schema: openApi(AcceptBody) })
  accept(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('documentId', new ZodPipe(id)) did: string, @Body(new ZodPipe(AcceptBody)) b: z.infer<typeof AcceptBody>) {
    return this.orders.acceptDifferences(org, user, did, b.reason);
  }
}
