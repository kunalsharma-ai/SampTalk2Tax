import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { ExpenseReceiptsService } from './expense-receipts.service';

const ListQuery = z.object({ status: z.enum(['UNMATCHED', 'MATCHED', 'DISCARDED']).optional() }).strict();
const CreateBody = z
  .object({
    merchant: z.string().trim().min(1, 'Say who was paid').max(200, 'Keep the merchant under 200 characters'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
    amount: z.string().regex(/^\d{1,13}(\.\d{1,2})?$/, 'Use an amount like 1180.50'),
    note: z.string().max(1000, 'Keep the note under 1000 characters').nullish(),
  })
  .strict();
const MatchBody = z.object({ statementLineId: z.uuid() }).strict();
const ReasonBody = z.object({ reason: z.string().trim().min(3, 'Say why').max(1000, 'Keep the reason under 1000 characters') }).strict();
const MissingQuery = z.object({ days: z.coerce.number().int().min(7).max(365).default(90) }).strict();

@ApiTags('expenses')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/expense-receipts')
export class ExpenseReceiptsController {
  constructor(private readonly receipts: ExpenseReceiptsService) {}

  /** Receipts for company-paid spending: all of them with match suggestions for finance, otherwise your own. */
  @Get()
  @RequirePermission('expenses.submit')
  list(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.receipts.list(org, user, q.status);
  }

  /** Add a receipt (then upload its file as an attachment with entityType EXPENSE_RECEIPT). */
  @Post()
  @RequirePermission('expenses.submit')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>) {
    return this.receipts.create(org, user, body);
  }

  /** Money paid out from bank accounts in the last `days` days with no receipt, each with the best receipt for it. */
  @Get('missing')
  @RequirePermission('banking.read')
  missing(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(MissingQuery)) q: z.infer<typeof MissingQuery>) {
    return this.receipts.missing(org, q.days);
  }

  /** Match every receipt whose suggested bank line is sure. */
  @Post('match-sure')
  @RequirePermission('banking.manage')
  matchSure(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    return this.receipts.matchSure(org, user);
  }

  @Get(':id')
  @RequirePermission('expenses.submit')
  get(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.receipts.one(org, user, id);
  }

  /** Match the receipt to the money-out statement line it paid. */
  @Post(':id/match')
  @RequirePermission('banking.manage')
  @ApiBody({ schema: openApi(MatchBody) })
  match(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(MatchBody)) body: z.infer<typeof MatchBody>) {
    return this.receipts.match(org, user, id, body.statementLineId);
  }

  @Post(':id/unmatch')
  @RequirePermission('banking.manage')
  @ApiBody({ schema: openApi(ReasonBody) })
  unmatch(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>) {
    return this.receipts.unmatch(org, user, id, body.reason);
  }

  /** Discard a receipt uploaded by mistake (yours, or any for finance); it is kept as a record. */
  @Post(':id/discard')
  @RequirePermission('expenses.submit')
  @ApiBody({ schema: openApi(ReasonBody) })
  discard(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>) {
    return this.receipts.discard(org, user, id, body.reason);
  }
}
