import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { BANK_FEED_EXPECT_HOURS, BANK_FEED_KINDS, BANK_FEED_MAX_TRANSACTIONS } from '@talk2tax/accounting-engine';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, Public, RequirePermission } from '../auth/decorators';
import { DomainError } from '../common/errors';
import { openApi, ZodPipe } from '../common/zod';
import { BankFeedsService } from './bank-feeds.service';

const hours = z.number().int().refine((h) => (BANK_FEED_EXPECT_HOURS as readonly number[]).includes(h), `Choose ${BANK_FEED_EXPECT_HOURS.join(', ')} hours`);
const name = z.string().trim().min(2, 'Name the feed').max(80, 'Keep the name under 80 characters');
const CreateBody = z.object({ accountId: z.string().uuid('Choose a bank account'), name, kind: z.enum(BANK_FEED_KINDS), expectEveryHours: hours }).strict();
const UpdateBody = z.object({ name: name.optional(), expectEveryHours: hours.optional() }).strict();
const TransactionsBody = z
  .object({ transactions: z.array(z.unknown()).min(1, 'Send at least one transaction').max(BANK_FEED_MAX_TRANSACTIONS, `Send at most ${BANK_FEED_MAX_TRANSACTIONS} transactions at a time`) })
  .strict();
const StatementBody = z
  .object({ fileName: z.string().trim().min(1, 'Name the file').max(200), content: z.string().min(1, 'The file is empty').max(2_000_000, 'Send files under 2 MB') })
  .strict();

/** Staff side of bank feeds (BANK-004): set up, pause, rotate and disconnect, and see every delivery. */
@ApiTags('banking')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/banking/feeds')
export class BankFeedsController {
  constructor(private readonly svc: BankFeedsService) {}

  @Get()
  @RequirePermission('banking.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.svc.list(org);
  }

  @Get(':feedId')
  @RequirePermission('banking.read')
  get(@CurrentOrg() org: OrgContext, @Param('feedId', ParseUUIDPipe) id: string) {
    return this.svc.get(org, id);
  }

  /** Owners and admins set up a feed; its token is shown once. */
  @Post()
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) b: z.infer<typeof CreateBody>) {
    return this.svc.create(org, user, b);
  }

  @Put(':feedId')
  @RequirePermission('banking.manage')
  @ApiBody({ schema: openApi(UpdateBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('feedId', ParseUUIDPipe) id: string, @Body(new ZodPipe(UpdateBody)) b: z.infer<typeof UpdateBody>) {
    return this.svc.update(org, user, id, b);
  }

  @Post(':feedId/pause')
  @HttpCode(200)
  @RequirePermission('banking.manage')
  pause(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('feedId', ParseUUIDPipe) id: string) {
    return this.svc.setPaused(org, user, id, true);
  }

  @Post(':feedId/resume')
  @HttpCode(200)
  @RequirePermission('banking.manage')
  resume(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('feedId', ParseUUIDPipe) id: string) {
    return this.svc.setPaused(org, user, id, false);
  }

  @Post(':feedId/rotate-token')
  @HttpCode(200)
  @RequirePermission('org.manage')
  rotate(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('feedId', ParseUUIDPipe) id: string) {
    return this.svc.rotateToken(org, user, id);
  }

  @Post(':feedId/disconnect')
  @HttpCode(200)
  @RequirePermission('org.manage')
  disconnect(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('feedId', ParseUUIDPipe) id: string) {
    return this.svc.disconnect(org, user, id);
  }
}

const bearer = (header: string | undefined) => {
  const m = /^Bearer (\S{1,100})$/.exec(header ?? '');
  if (!m) throw new DomainError('FEED_TOKEN_INVALID', 'Send the bank feed token as "Authorization: Bearer t2tf_..."', 401);
  return m[1]!;
};
const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');

/** Where a sender posts a feed's transactions or statement files. No sign-in: the feed's token is the check. */
@ApiTags('bank feed')
@ApiBearerAuth()
@Controller('v1/bank-feed')
export class BankFeedDeliveryController {
  constructor(private readonly svc: BankFeedsService) {}

  @Public()
  @Get('me')
  me(@Headers('authorization') auth: string | undefined, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    return this.svc.whoAmI(bearer(auth));
  }

  @Public()
  @Post('transactions')
  @HttpCode(200)
  @ApiBody({ schema: openApi(TransactionsBody) })
  transactions(@Headers('authorization') auth: string | undefined, @Body(new ZodPipe(TransactionsBody)) b: z.infer<typeof TransactionsBody>, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    return this.svc.deliverTransactions(bearer(auth), b.transactions);
  }

  @Public()
  @Post('statement')
  @HttpCode(200)
  @ApiBody({ schema: openApi(StatementBody) })
  statement(@Headers('authorization') auth: string | undefined, @Body(new ZodPipe(StatementBody)) b: z.infer<typeof StatementBody>, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    return this.svc.deliverStatement(bearer(auth), b);
  }
}
