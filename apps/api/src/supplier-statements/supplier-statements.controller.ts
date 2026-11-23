import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { SUPPLIER_STATEMENT_LINE_KINDS } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { SupplierStatementsService } from './supplier-statements.service';

const money = z.string().trim().regex(/^-?\d{1,13}(\.\d{1,2})?$/, 'Give an amount with at most two decimals');
const StatementBody = z
  .object({
    contactId: z.uuid(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    from: isoDate,
    to: isoDate,
    theirOpening: money,
    theirClosing: money,
    lines: z
      .array(
        z
          .object({
            date: isoDate,
            reference: z.string().trim().min(1).max(60),
            kind: z.enum(SUPPLIER_STATEMENT_LINE_KINDS),
            amount: z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/, 'Give a positive amount with at most two decimals').refine((v) => /[1-9]/.test(v), 'An amount must be above zero'),
            description: z.string().trim().max(200).nullable().optional(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();
const ReconcileBody = z.object({ note: z.string().trim().max(1000).default('') }).strict();
const ListQuery = z.object({ contactId: z.uuid().optional() }).strict();

/** Supplier statement reconciliation (AP-011). */
@ApiTags('purchases')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/purchases/supplier-statements')
export class SupplierStatementsController {
  constructor(private readonly s: SupplierStatementsService) {}

  @Get()
  @RequirePermission('purchases.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.s.list(org, q.contactId);
  }

  @Post()
  @RequirePermission('purchases.manage')
  @ApiBody(openApi(StatementBody))
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(StatementBody)) body: z.infer<typeof StatementBody>) {
    return this.s.create(org, user, body);
  }

  @Get(':statementId')
  @RequirePermission('purchases.read')
  get(@CurrentOrg() org: OrgContext, @Param('statementId', ParseUUIDPipe) id: string) {
    return this.s.get(org, id);
  }

  /** Replace the statement as entered (period, balances and lines) while it is open. */
  @Put(':statementId')
  @RequirePermission('purchases.manage')
  @ApiBody(openApi(StatementBody))
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('statementId', ParseUUIDPipe) id: string, @Body(new ZodPipe(StatementBody)) body: z.infer<typeof StatementBody>) {
    return this.s.update(org, user, id, body);
  }

  /** Mark reconciled: the statement must add up, and a note is needed while differences remain. */
  @Post(':statementId/reconcile')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  @ApiBody(openApi(ReconcileBody))
  reconcile(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('statementId', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReconcileBody)) body: z.infer<typeof ReconcileBody>) {
    return this.s.reconcile(org, user, id, body.note);
  }
}
