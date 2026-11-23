import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TRANSACTION_KINDS } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { CurrentOrg, OrgContext, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { TransactionHistoryService } from './transaction-history.service';

const Kind = z.enum(TRANSACTION_KINDS);

/** Transaction history (AUDIT-005): one transaction's audit trail with what hangs off it. */
@ApiTags('audit')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/transaction-history')
export class TransactionHistoryController {
  constructor(private readonly history: TransactionHistoryService) {}

  @Get(':kind/:id')
  @RequirePermission('audit.read')
  get(@CurrentOrg() org: OrgContext, @Param('kind', new ZodPipe(Kind)) kind: z.infer<typeof Kind>, @Param('id', ParseUUIDPipe) id: string) {
    return this.history.history(org, kind, id);
  }
}
