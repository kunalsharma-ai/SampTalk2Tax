import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentOrg, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, ZodPipe } from '../common/zod';
import { ReportsService } from './reports.service';

const TbQuery = z.object({
  from: isoDate.optional(),
  asOf: isoDate,
  includeZero: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});
const RangeQuery = z.object({ from: isoDate, to: isoDate });
const AsOfQuery = z.object({ asOf: isoDate });
const LedgerQuery = RangeQuery.extend({ accountId: z.uuid() });

function checkRange(from: string | undefined, to: string) {
  if (from && from > to) throw new BadRequestException({ error: 'INVALID_RANGE', message: '"from" must be on or before the end date' });
}

@ApiTags('reports')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('trial-balance')
  @RequirePermission('reports.read')
  trialBalance(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(TbQuery)) q: z.infer<typeof TbQuery>) {
    checkRange(q.from, q.asOf);
    return this.reports.trialBalance(org.id, q);
  }

  @Get('income-statement')
  @RequirePermission('reports.read')
  incomeStatement(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(RangeQuery)) q: z.infer<typeof RangeQuery>) {
    checkRange(q.from, q.to);
    return this.reports.incomeStatement(org.id, q);
  }

  @Get('balance-sheet')
  @RequirePermission('reports.read')
  balanceSheet(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(AsOfQuery)) q: z.infer<typeof AsOfQuery>) {
    return this.reports.balanceSheet(org.id, q);
  }

  @Get('dashboard')
  @RequirePermission('reports.read')
  dashboard(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(AsOfQuery)) q: z.infer<typeof AsOfQuery>) {
    return this.reports.dashboard(org.id, q);
  }

  @Get('general-ledger')
  @RequirePermission('reports.read')
  ledger(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(LedgerQuery)) q: z.infer<typeof LedgerQuery>) {
    checkRange(q.from, q.to);
    return this.reports.accountLedger(org.id, q);
  }
}
