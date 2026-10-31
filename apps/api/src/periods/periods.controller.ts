import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { PeriodsService } from './periods.service';

const ListQuery = z.object({ fiscalYear: z.coerce.number().int().min(1900).max(2200).optional() });
const CreateFyBody = z.object({ fiscalYear: z.number().int().min(1900).max(2200) });

@ApiTags('periods')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/periods')
export class PeriodsController {
  constructor(private readonly periods: PeriodsService) {}

  @Get()
  @RequirePermission('periods.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.periods.list(org.id, q.fiscalYear);
  }

  @Post('fiscal-years')
  @RequirePermission('periods.manage')
  @ApiBody({ schema: openApi(CreateFyBody) })
  createFy(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateFyBody)) body: z.infer<typeof CreateFyBody>) {
    return this.periods.createFiscalYear(org.id, user.id, body.fiscalYear, org.fiscalYearStartMonth);
  }

  @Post(':periodId/lock')
  @HttpCode(200)
  @RequirePermission('periods.lock')
  lock(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('periodId', ParseUUIDPipe) periodId: string) {
    return this.periods.setLocked(org.id, periodId, user.id, true);
  }

  @Post(':periodId/unlock')
  @HttpCode(200)
  @RequirePermission('periods.lock')
  unlock(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('periodId', ParseUUIDPipe) periodId: string) {
    return this.periods.setLocked(org.id, periodId, user.id, false);
  }
}
