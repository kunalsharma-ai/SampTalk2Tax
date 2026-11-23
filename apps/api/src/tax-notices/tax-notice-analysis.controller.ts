import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { TaxNoticeAnalysisService } from './tax-notice-analysis.service';

const AnalysisBody = z
  .object({
    chosenType: z.string().regex(/^[A-Z0-9_]{2,40}$/).nullable(),
    checked: z.array(z.string().regex(/^[a-z0-9_]{1,40}$/)).max(20),
  })
  .strict();

/** Tax notice analysis (TAX-050): the type, deadline, how to reply, checklist and related notices. */
@ApiTags('tax-notices')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/tax-notices/:noticeId/analysis')
export class TaxNoticeAnalysisController {
  constructor(private readonly s: TaxNoticeAnalysisService) {}

  @Get()
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Param('noticeId', ParseUUIDPipe) id: string) {
    return this.s.get(org, id);
  }

  /** Choose the notice type (or null to go by the section) and record which checklist items are done. */
  @Put()
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(AnalysisBody) })
  save(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('noticeId', ParseUUIDPipe) id: string, @Body(new ZodPipe(AnalysisBody)) body: z.infer<typeof AnalysisBody>) {
    return this.s.save(org, user, id, body);
  }
}
