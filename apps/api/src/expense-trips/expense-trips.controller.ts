import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { ExpenseTripsService } from './expense-trips.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as YYYY-MM-DD');
const amount = z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/, 'An amount such as "12000" or "450.50"');
const TripBody = z
  .object({
    purpose: z.string().trim().min(1).max(200),
    destination: z.string().trim().min(1).max(120),
    startDate: isoDate,
    endDate: isoDate,
    estimate: z.object({ transport: amount, lodging: amount, meals: amount, other: amount }).strict(),
  })
  .strict();
const ListQuery = z.object({ status: z.enum(['REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(), mine: z.enum(['true', 'false']).optional() });
const DecideBody = z.object({ note: z.string().trim().max(500).optional() }).strict();
const LinkBody = z.object({ claimId: z.string().min(1).max(64) }).strict();
const id = z.string().min(1).max(64);

/**
 * Business trips (EXP-007): request with an estimate, approve or reject (someone other than the
 * traveller), link the traveller's expense claims, and see the trip's cost against the estimate.
 * Permissions are checked in the service: expenses.submit to request and link, approvals.decide
 * to decide, expenses.read to see everyone's trips.
 */
@ApiTags('expenses')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/expense-trips')
export class ExpenseTripsController {
  constructor(private readonly trips: ExpenseTripsService) {}

  @Get()
  @RequirePermission('org.read')
  list(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.trips.list(org, user, { status: q.status, mine: q.mine === 'true' });
  }

  @Get(':tripId')
  @RequirePermission('org.read')
  get(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('tripId', new ZodPipe(id)) tripId: string) {
    return this.trips.get(org, user, tripId);
  }

  @Post()
  @RequirePermission('org.read')
  @ApiBody({ schema: openApi(TripBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(TripBody)) body: z.infer<typeof TripBody>) {
    return this.trips.create(org, user, body);
  }

  @Post(':tripId/approve')
  @HttpCode(200)
  @RequirePermission('org.read')
  @ApiBody({ schema: openApi(DecideBody) })
  approve(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('tripId', new ZodPipe(id)) tripId: string, @Body(new ZodPipe(DecideBody)) body: z.infer<typeof DecideBody>) {
    return this.trips.decide(org, user, tripId, true, body.note || null);
  }

  @Post(':tripId/reject')
  @HttpCode(200)
  @RequirePermission('org.read')
  @ApiBody({ schema: openApi(DecideBody) })
  reject(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('tripId', new ZodPipe(id)) tripId: string, @Body(new ZodPipe(DecideBody)) body: z.infer<typeof DecideBody>) {
    return this.trips.decide(org, user, tripId, false, body.note || null);
  }

  @Post(':tripId/cancel')
  @HttpCode(200)
  @RequirePermission('org.read')
  cancel(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('tripId', new ZodPipe(id)) tripId: string) {
    return this.trips.cancel(org, user, tripId);
  }

  @Post(':tripId/claims')
  @HttpCode(200)
  @RequirePermission('org.read')
  @ApiBody({ schema: openApi(LinkBody) })
  link(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('tripId', new ZodPipe(id)) tripId: string, @Body(new ZodPipe(LinkBody)) body: z.infer<typeof LinkBody>) {
    return this.trips.link(org, user, tripId, body.claimId);
  }

  @Delete(':tripId/claims/:claimId')
  @RequirePermission('org.read')
  unlink(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('tripId', new ZodPipe(id)) tripId: string, @Param('claimId', new ZodPipe(id)) claimId: string) {
    return this.trips.unlink(org, user, tripId, claimId);
  }
}
