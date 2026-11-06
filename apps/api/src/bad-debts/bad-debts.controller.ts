import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { decimalString, isoDate, openApi, ZodPipe } from '../common/zod';
import { BadDebtsService } from './bad-debts.service';

const pct = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Enter a percentage from 0 to 100');
const reason = z.string().trim().min(1, 'Give a reason').max(500);
const SettingsBody = z
  .object({
    expenseAccountId: z.string().uuid('Choose the bad-debt expense account'),
    allowanceAccountId: z.string().uuid('Choose the allowance account'),
    rates: z.object({ current: pct, days1to30: pct, days31to60: pct, days61to90: pct, over90: pct }).strict(),
  })
  .strict();
const ProvideBody = z.object({ asOf: isoDate, memo: z.string().trim().max(400).nullish() }).strict();
const DoubtfulBody = z.object({ percent: pct, reason }).strict();
const WriteOffBody = z.object({ documentId: z.string().uuid(), date: isoDate, amount: decimalString, against: z.enum(['EXPENSE', 'ALLOWANCE']), reason }).strict();
const ReverseBody = z.object({ date: isoDate, reason }).strict();
const Query_ = z.object({ asOf: isoDate.optional() });

/** Bad debts: provisions for doubtful debts (AR-026) and write-offs (AR-027). */
@ApiTags('sales')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/bad-debts')
export class BadDebtsController {
  constructor(private readonly badDebts: BadDebtsService) {}

  /** Settings, the provision the receivables call for as of a date, past provisions and write-offs. */
  @Get()
  @RequirePermission('sales.read')
  overview(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(Query_)) q: z.infer<typeof Query_>) {
    return this.badDebts.overview(org, q.asOf);
  }

  @Put('settings')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(SettingsBody) })
  settings(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(SettingsBody)) body: z.infer<typeof SettingsBody>) {
    return this.badDebts.saveSettings(org, user, body);
  }

  /** Make (where missing) and use a Bad Debts expense account and an Allowance for Doubtful Debts account. */
  @Post('settings/default-accounts')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  defaultAccounts(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    return this.badDebts.createDefaultAccounts(org, user);
  }

  /** Post the provision as of a date: the difference between what the receivables call for and the allowance in the books. */
  @Post('provisions')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(ProvideBody) })
  provide(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(ProvideBody)) body: z.infer<typeof ProvideBody>) {
    return this.badDebts.provide(org, user, body);
  }

  @Put('doubtful/:documentId')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(DoubtfulBody) })
  markDoubtful(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('documentId', ParseUUIDPipe) documentId: string, @Body(new ZodPipe(DoubtfulBody)) body: z.infer<typeof DoubtfulBody>) {
    return this.badDebts.markDoubtful(org, user, documentId, body);
  }

  @Delete('doubtful/:documentId')
  @HttpCode(204)
  @RequirePermission('sales.manage')
  async clearDoubtful(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('documentId', ParseUUIDPipe) documentId: string) {
    await this.badDebts.clearDoubtful(org, user, documentId);
  }

  @Post('write-offs')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(WriteOffBody) })
  writeOff(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(WriteOffBody)) body: z.infer<typeof WriteOffBody>) {
    return this.badDebts.writeOff(org, user, body);
  }

  @Post('write-offs/:id/reverse')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(ReverseBody) })
  reverse(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReverseBody)) body: z.infer<typeof ReverseBody>) {
    return this.badDebts.reverseWriteOff(org, user, id, body);
  }
}
