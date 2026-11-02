import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { BankAiService } from './bank-ai.service';

const accountId = z.string().uuid('Not a bank account id');
const id = z.string().uuid('Not a suggestion id');
const StatusQuery = z.object({ status: z.enum(['DRAFTING', 'READY', 'ACCEPTED', 'DISMISSED', 'FAILED']).optional() }).strict();
const DismissBody = z.object({ note: z.string().trim().max(1000, 'Keep the note under 1,000 characters').nullish() }).strict();

@ApiTags('banking')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/banking')
export class BankAiController {
  constructor(private readonly ai: BankAiService) {}

  /** Whether AI is set up and on, counts of suggestions by status, and the latest run on the account. */
  @Get('accounts/:accountId/ai')
  @RequirePermission('banking.read')
  overview(@CurrentOrg() org: OrgContext, @Param('accountId', new ZodPipe(accountId)) account: string) {
    return this.ai.overview(org, account);
  }

  /** Have the AI model suggest what each unmatched line on the account is. Runs in the background; nothing is recorded. */
  @Post('accounts/:accountId/ai/runs')
  @RequirePermission('banking.manage')
  start(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('accountId', new ZodPipe(accountId)) account: string) {
    return this.ai.start(org, user, account);
  }

  @Get('accounts/:accountId/ai/suggestions')
  @RequirePermission('banking.read')
  list(@CurrentOrg() org: OrgContext, @Param('accountId', new ZodPipe(accountId)) account: string, @Query(new ZodPipe(StatusQuery)) q: z.infer<typeof StatusQuery>) {
    return this.ai.list(org, account, q.status);
  }

  @Get('ai-suggestions/:id')
  @RequirePermission('banking.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', new ZodPipe(id)) suggestionId: string) {
    return this.ai.get(org, suggestionId);
  }

  /** Apply a suggestion: the match, receipt or payment, or entry is made exactly as by hand. */
  @Post('ai-suggestions/:id/accept')
  @HttpCode(200)
  @RequirePermission('banking.manage')
  accept(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) suggestionId: string) {
    return this.ai.accept(org, user, suggestionId);
  }

  @Post('ai-suggestions/:id/dismiss')
  @HttpCode(200)
  @RequirePermission('banking.manage')
  @ApiBody({ schema: openApi(DismissBody) })
  dismiss(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) suggestionId: string, @Body(new ZodPipe(DismissBody)) b: z.infer<typeof DismissBody>) {
    return this.ai.dismiss(org, user, suggestionId, b.note || null);
  }
}
