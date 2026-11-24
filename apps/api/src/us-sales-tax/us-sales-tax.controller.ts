import { Body, Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, ZodPipe } from '../common/zod';
import { UsSalesTaxService } from './us-sales-tax.service';

const Period = z.object({ from: isoDate.optional(), to: isoDate.optional() }).strict();
const State = z.string().regex(/^[A-Za-z]{2}$/, 'Use the two-letter state code');
const Registration = z
  .object({
    registeredFrom: isoDate,
    permitNumber: z.string().trim().max(50).nullable().optional(),
    taxRateId: z.uuid().nullable().optional(),
    filingFrequency: z.enum(['MONTHLY', 'QUARTERLY', 'ANNUAL']),
  })
  .strict();

/** US sales tax (TAX-028). */
@ApiTags('tax')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/tax/us-sales-tax')
export class UsSalesTaxController {
  constructor(private readonly s: UsSalesTaxService) {}

  /** Registrations, economic nexus by state and the sales tax charged by state for a period (this month by default). */
  @Get()
  @RequirePermission('reports.read')
  overview(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(Period)) q: z.infer<typeof Period>) {
    return this.s.overview(org, q);
  }

  /** Records (or updates) the permit held in a state. */
  @Put('registrations/:state')
  @RequirePermission('accounts.manage')
  register(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('state', new ZodPipe(State)) state: string, @Body(new ZodPipe(Registration)) body: z.infer<typeof Registration>) {
    return this.s.register(org, user, { ...body, state });
  }

  @Delete('registrations/:state')
  @RequirePermission('accounts.manage')
  unregister(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('state', new ZodPipe(State)) state: string) {
    return this.s.unregister(org, user, state);
  }
}
