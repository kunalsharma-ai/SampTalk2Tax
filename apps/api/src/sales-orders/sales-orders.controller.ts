import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { BILLING_METHODS, QUOTE_STATUSES } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { decimalString, isoDate, openApi, ZodPipe } from '../common/zod';
import { SalesOrdersService } from './sales-orders.service';

const id = z.string().uuid('Not a valid id');
const text = (max: number) => z.string().trim().max(max, `Keep it under ${max} characters`).nullish();
const Line = z
  .object({
    accountId: z.string().uuid('Choose an income account'),
    description: text(500),
    quantity: decimalString,
    unitPrice: decimalString,
    taxRateId: z.string().uuid().nullish(),
    hsnCode: z.string().trim().max(8).nullish(),
  })
  .strict();
const lines = z.array(Line).min(1, 'Add at least one line').max(200);
const QuoteBody = z
  .object({ contactId: z.string().uuid('Choose the customer'), dealId: id.nullish(), issueDate: isoDate, validUntil: isoDate, placeOfSupply: z.string().regex(/^\d{2}$/).nullish(), reference: text(100), terms: text(4000), memo: text(1000), lines })
  .strict();
const OrderBody = z
  .object({ contactId: z.string().uuid('Choose the customer'), dealId: id.nullish(), orderDate: isoDate, placeOfSupply: z.string().regex(/^\d{2}$/).nullish(), reference: text(100), memo: text(1000), lines })
  .strict();
const AcceptBody = z.object({ orderDate: isoDate.nullish(), reference: text(100) }).strict();
const ReasonBody = z.object({ reason: z.string().trim().min(1, 'Give a reason').max(500) }).strict();
const BillBody = z.object({ issueDate: isoDate, dueDate: isoDate.nullish(), lines: z.array(z.object({ orderLineId: z.string().uuid(), quantity: decimalString }).strict()).max(200).nullish() }).strict();
const MethodBody = z.object({ method: z.enum(BILLING_METHODS) }).strict();
const PlanBody = z
  .object({ milestones: z.array(z.object({ id: id.nullish(), name: z.string().trim().min(1, 'Give the milestone a name').max(200), percent: decimalString, dueDate: isoDate.nullish() }).strict()).min(1, 'Add at least one milestone').max(50) })
  .strict();
const DoneBody = z.object({ done: z.boolean() }).strict();
const InvoiceBody = z.object({ issueDate: isoDate, dueDate: isoDate.nullish() }).strict();
const ClaimBody = z.object({ percentComplete: decimalString, issueDate: isoDate, dueDate: isoDate.nullish(), note: text(500) }).strict();
const QuoteQuery = z.object({ status: z.enum(QUOTE_STATUSES).optional(), contactId: id.optional(), dealId: id.optional() });
const OrderQuery = z.object({ view: z.enum(['open', 'billed', 'cancelled', 'all']).optional(), contactId: id.optional(), dealId: id.optional() });

@ApiTags('sales')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/sales')
export class SalesOrdersController {
  constructor(private readonly sales: SalesOrdersService) {}

  /** Quotations, newest first, with what is awaiting an answer and the acceptance rate. */
  @Get('quotes')
  @RequirePermission('sales.read')
  quotes(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(QuoteQuery)) q: z.infer<typeof QuoteQuery>) {
    return this.sales.listQuotes(org, q);
  }

  @Get('quotes/:id')
  @RequirePermission('sales.read')
  quote(@CurrentOrg() org: OrgContext, @Param('id', new ZodPipe(id)) quoteId: string) {
    return this.sales.getQuote(org, quoteId);
  }

  /** A draft quotation; its lines are worked out by the invoice rules (tax rates, GST place of supply). */
  @Post('quotes')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(QuoteBody) })
  createQuote(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(QuoteBody)) b: z.infer<typeof QuoteBody>) {
    return this.sales.createQuote(org, user, b);
  }

  @Put('quotes/:id')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(QuoteBody) })
  updateQuote(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) quoteId: string, @Body(new ZodPipe(QuoteBody)) b: z.infer<typeof QuoteBody>) {
    return this.sales.updateQuote(org, user, quoteId, b);
  }

  /** Delete a draft quotation (or a draft revision). */
  @Delete('quotes/:id')
  @HttpCode(204)
  @RequirePermission('sales.manage')
  async deleteQuote(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) quoteId: string) {
    await this.sales.deleteQuote(org, user, quoteId);
  }

  /** Mark a draft sent to the customer; it no longer changes. Sending a revision supersedes the one before. */
  @Post('quotes/:id/send')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  send(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) quoteId: string) {
    return this.sales.sendQuote(org, user, quoteId);
  }

  /** The customer accepted: a sales order with the same lines, and the deal (if open) won. */
  @Post('quotes/:id/accept')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(AcceptBody) })
  accept(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) quoteId: string, @Body(new ZodPipe(AcceptBody)) b: z.infer<typeof AcceptBody>) {
    return this.sales.acceptQuote(org, user, quoteId, b);
  }

  @Post('quotes/:id/decline')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(ReasonBody) })
  decline(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) quoteId: string, @Body(new ZodPipe(ReasonBody)) b: z.infer<typeof ReasonBody>) {
    return this.sales.declineQuote(org, user, quoteId, b.reason);
  }

  /** A draft revision of a sent, expired or declined quotation. */
  @Post('quotes/:id/revise')
  @RequirePermission('sales.manage')
  revise(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) quoteId: string) {
    return this.sales.reviseQuote(org, user, quoteId);
  }

  /** Sales orders: open (not fully billed) by default. */
  @Get('orders')
  @RequirePermission('sales.read')
  orders(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(OrderQuery)) q: z.infer<typeof OrderQuery>) {
    return this.sales.listOrders(org, q);
  }

  @Get('orders/:id')
  @RequirePermission('sales.read')
  order(@CurrentOrg() org: OrgContext, @Param('id', new ZodPipe(id)) orderId: string) {
    return this.sales.getOrder(org, orderId);
  }

  /** An order entered directly, without a quotation. */
  @Post('orders')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(OrderBody) })
  createOrder(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(OrderBody)) b: z.infer<typeof OrderBody>) {
    return this.sales.createOrder(org, user, b);
  }

  /** Bill all that is left, or chosen quantities, into a draft invoice. */
  @Post('orders/:id/invoices')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(BillBody) })
  bill(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) orderId: string, @Body(new ZodPipe(BillBody)) b: z.infer<typeof BillBody>) {
    return this.sales.billOrder(org, user, orderId, b);
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(ReasonBody) })
  cancel(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) orderId: string, @Body(new ZodPipe(ReasonBody)) b: z.infer<typeof ReasonBody>) {
    return this.sales.cancelOrder(org, user, orderId, b.reason);
  }

  /** Bill by delivery, milestones or progress; only while nothing on the order is billed. */
  @Put('orders/:id/billing-method')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(MethodBody) })
  method(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) orderId: string, @Body(new ZodPipe(MethodBody)) b: z.infer<typeof MethodBody>) {
    return this.sales.setBillingMethod(org, user, orderId, b.method);
  }

  /** Save the milestone plan (shares in percent of the order, at most 100 in all). */
  @Put('orders/:id/milestones')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(PlanBody) })
  plan(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) orderId: string, @Body(new ZodPipe(PlanBody)) b: z.infer<typeof PlanBody>) {
    return this.sales.planMilestones(org, user, orderId, b.milestones);
  }

  @Post('orders/:id/milestones/:mid/complete')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(DoneBody) })
  complete(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) orderId: string, @Param('mid', new ZodPipe(id)) mid: string, @Body(new ZodPipe(DoneBody)) b: z.infer<typeof DoneBody>) {
    return this.sales.completeMilestone(org, user, orderId, mid, b.done);
  }

  /** A draft invoice for a reached milestone's share of every line. */
  @Post('orders/:id/milestones/:mid/invoice')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(InvoiceBody) })
  invoiceMilestone(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) orderId: string, @Param('mid', new ZodPipe(id)) mid: string, @Body(new ZodPipe(InvoiceBody)) b: z.infer<typeof InvoiceBody>) {
    return this.sales.invoiceMilestone(org, user, orderId, mid, b);
  }

  /** A draft invoice billing every line up to the percent complete, less earlier claims. */
  @Post('orders/:id/progress-claims')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(ClaimBody) })
  claim(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) orderId: string, @Body(new ZodPipe(ClaimBody)) b: z.infer<typeof ClaimBody>) {
    return this.sales.claimProgress(org, user, orderId, b);
  }
}
