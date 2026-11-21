import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { OpeningBalancesService } from './opening-balances.service';

const amount = z.string().trim().max(30).nullable().optional();
const SetBody = z.object({
  date: isoDate,
  lines: z.array(z.object({ accountId: z.uuid(), debit: amount, credit: amount })).max(2000),
});

@ApiTags('opening-balances')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/opening-balances')
export class OpeningBalancesController {
  constructor(private readonly opening: OpeningBalancesService) {}

  @Get()
  @RequirePermission('journals.read')
  get(@CurrentOrg() org: OrgContext) {
    return this.opening.get(org);
  }

  /** Posts the balances as one OPENING journal, replacing (reversing) the one before. */
  @Put()
  @RequirePermission('journals.post')
  @ApiBody({ schema: openApi(SetBody) })
  set(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(SetBody)) body: z.infer<typeof SetBody>) {
    return this.opening.set(org, user, body);
  }
}
