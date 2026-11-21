import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { LedgerReplayService } from './ledger-replay.service';

const ReplayQuery = z.object({ asOf: z.iso.datetime({ offset: true }), through: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD') }).strict();

@ApiTags('audit')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/ledger-replay')
export class LedgerReplayController {
  constructor(private readonly replay: LedgerReplayService) {}

  /** The posted ledger as recorded at `asOf`, for entries dated up to `through`, beside the ledger now. */
  @Get()
  @RequirePermission('audit.read')
  get(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(ReplayQuery)) q: z.infer<typeof ReplayQuery>) {
    return this.replay.replay(org, user, q);
  }
}
