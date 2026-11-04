import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { CFO_QUESTIONS, type CfoQuestionKey } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { CfoService } from './cfo.service';

const QuestionKey = z.enum(CFO_QUESTIONS.map((q) => q.key) as [CfoQuestionKey, ...CfoQuestionKey[]], { message: 'Unknown question' });
const CreateBody = z.object({ kind: z.enum(['BOARD', 'INVESTOR']) }).strict();
const CommentaryBody = z.object({ commentary: z.string().max(10000, 'Keep the commentary under 10,000 characters').nullable() }).strict();

/**
 * The virtual CFO. Reading the assessment and the answers needs reports.read (answers that list
 * customer or vendor records also need sales.read or purchases.read). Board packs and investor
 * updates, and their AI summary, need cfo.reports. Nothing here changes the books.
 */
@ApiTags('cfo')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/cfo')
export class CfoController {
  constructor(private readonly svc: CfoService) {}

  @Get('assessment')
  @RequirePermission('reports.read')
  assessment(@CurrentOrg() org: OrgContext) {
    return this.svc.assessment(org);
  }

  @Get('questions/:key')
  @RequirePermission('reports.read')
  ask(@CurrentOrg() org: OrgContext, @Param('key', new ZodPipe(QuestionKey)) key: CfoQuestionKey) {
    return this.svc.ask(org, key);
  }

  @Get('ai')
  @RequirePermission('reports.read')
  ai(@CurrentOrg() org: OrgContext) {
    return this.svc.aiStatus(org);
  }

  @Get('reports')
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.svc.listReports(org.id);
  }

  @Post('reports')
  @RequirePermission('cfo.reports')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) b: z.infer<typeof CreateBody>) {
    return this.svc.createReport(org, user, b.kind);
  }

  @Get('reports/:id')
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getReport(org.id, id);
  }

  @Post('reports/:id/refresh')
  @HttpCode(200)
  @RequirePermission('cfo.reports')
  refresh(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.refreshReport(org, user, id);
  }

  @Put('reports/:id/commentary')
  @RequirePermission('cfo.reports')
  @ApiBody({ schema: openApi(CommentaryBody) })
  commentary(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(CommentaryBody)) b: z.infer<typeof CommentaryBody>) {
    return this.svc.saveCommentary(org.id, user, id, b.commentary);
  }

  /** Have the AI write the executive summary. It runs in the background: read the report until ai.status is no longer RUNNING. */
  @Post('reports/:id/summary')
  @HttpCode(202)
  @RequirePermission('cfo.reports')
  summary(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.summarise(org, user, id);
  }

  @Post('reports/:id/finalise')
  @HttpCode(200)
  @RequirePermission('cfo.reports')
  finalise(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.finalise(org.id, user, id);
  }

  @Delete('reports/:id')
  @HttpCode(204)
  @RequirePermission('cfo.reports')
  async remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.svc.removeReport(org.id, user, id);
  }
}
