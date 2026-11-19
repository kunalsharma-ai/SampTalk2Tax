import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { JournalSuggestionsService } from './journal-suggestions.service';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'The month is written YYYY-MM');
const MonthQuery = z.object({ month }).strict();
const AcceptBody = z.object({ month, key: z.string().min(1).max(80) }).strict();
const DismissBody = AcceptBody.extend({ reason: z.string().max(300) }).strict();

/** Automated journal suggestions (GL-036). */
@ApiTags('journals')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/journal-suggestions')
export class JournalSuggestionsController {
  constructor(private readonly svc: JournalSuggestionsService) {}

  @Get()
  @RequirePermission('journals.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(MonthQuery)) q: z.infer<typeof MonthQuery>) {
    return this.svc.list(org, q.month);
  }

  @Post('accept')
  @RequirePermission('journals.create')
  @ApiBody({ schema: openApi(AcceptBody) })
  accept(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(AcceptBody)) body: z.infer<typeof AcceptBody>) {
    return this.svc.accept(org, user, body.month, body.key);
  }

  @Post('dismiss')
  @HttpCode(200)
  @RequirePermission('journals.create')
  @ApiBody({ schema: openApi(DismissBody) })
  dismiss(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(DismissBody)) body: z.infer<typeof DismissBody>) {
    return this.svc.dismiss(org, user, body.month, body.key, body.reason);
  }
}
