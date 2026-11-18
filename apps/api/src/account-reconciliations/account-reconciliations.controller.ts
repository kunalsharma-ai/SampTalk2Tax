import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { AccountReconciliationsService } from './account-reconciliations.service';

const AsOf = z.object({ asOf: isoDate });
const Item = z.object({
  description: z.string().max(200),
  reference: z.string().max(100).nullish(),
  amount: z.string().trim().max(40),
  kind: z.enum(['SUPPORT', 'RECONCILING']),
});
const SaveBody = z.object({ asOf: isoDate, items: z.array(Item).max(500), notes: z.string().max(2000).nullish() });
const ReviewBody = z.object({ asOf: isoDate, note: z.string().max(1000).nullish() });
const ReopenBody = z.object({ asOf: isoDate, reason: z.string().trim().min(3).max(1000) });

/** Balance sheet account reconciliations (GL-032, GL-023): reports.read sees them, close.manage works them. */
@ApiTags('account-reconciliations')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/account-reconciliations')
export class AccountReconciliationsController {
  constructor(private readonly recs: AccountReconciliationsService) {}

  @Get()
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(AsOf)) q: z.infer<typeof AsOf>) {
    return this.recs.list(org, q.asOf);
  }

  @Get(':accountId')
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Param('accountId', ParseUUIDPipe) accountId: string, @Query(new ZodPipe(AsOf)) q: z.infer<typeof AsOf>) {
    return this.recs.get(org, accountId, q.asOf);
  }

  @Put(':accountId')
  @RequirePermission('close.manage')
  @ApiBody({ schema: openApi(SaveBody) })
  save(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('accountId', ParseUUIDPipe) accountId: string, @Body(new ZodPipe(SaveBody)) body: z.infer<typeof SaveBody>) {
    return this.recs.save(org, user.id, accountId, body);
  }

  @Post(':accountId/prepare')
  @RequirePermission('close.manage')
  @ApiBody({ schema: openApi(AsOf) })
  prepare(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('accountId', ParseUUIDPipe) accountId: string, @Body(new ZodPipe(AsOf)) body: z.infer<typeof AsOf>) {
    return this.recs.prepare(org, user.id, accountId, body.asOf);
  }

  @Post(':accountId/review')
  @RequirePermission('close.manage')
  @ApiBody({ schema: openApi(ReviewBody) })
  review(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('accountId', ParseUUIDPipe) accountId: string, @Body(new ZodPipe(ReviewBody)) body: z.infer<typeof ReviewBody>) {
    return this.recs.review(org, user.id, accountId, body.asOf, body.note ?? null);
  }

  @Post(':accountId/reopen')
  @RequirePermission('close.manage')
  @ApiBody({ schema: openApi(ReopenBody) })
  reopen(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('accountId', ParseUUIDPipe) accountId: string, @Body(new ZodPipe(ReopenBody)) body: z.infer<typeof ReopenBody>) {
    return this.recs.reopen(org, user.id, accountId, body.asOf, body.reason);
  }
}
