import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { CARD_FEED_MAX_TRANSACTIONS, CARD_KINDS } from '@talk2tax/accounting-engine';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, Public, RequirePermission } from '../auth/decorators';
import { DomainError } from '../common/errors';
import { openApi, ZodPipe } from '../common/zod';
import { CompanyCardsService } from './company-cards.service';

const money = z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/, 'Enter an amount like 50000 or 50000.00');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Enter the expiry as YYYY-MM');
const ProgramBody = z
  .object({ name: z.string().trim().min(2, 'Name the programme').max(80), provider: z.string().trim().min(2, 'Name the card provider').max(80), liabilityAccountId: z.string().uuid('Choose the account the cards are paid through') })
  .strict();
const CardBody = z
  .object({
    programId: z.string().uuid('Choose a card programme'),
    kind: z.enum(CARD_KINDS),
    holderId: z.string().uuid('Choose who holds the card'),
    label: z.string().trim().min(1, 'Name the card').max(80),
    monthlyLimit: money.nullable(),
    last4: z.string().regex(/^\d{4}$/, 'Enter the last four digits only').nullable().optional(),
    expires: month.nullable().optional(),
    providerRef: z.string().trim().max(100).nullable().optional(),
    contactId: z.string().uuid().nullable().optional(),
  })
  .strict();
const ControlBody = z.object({ action: z.enum(['FREEZE', 'UNFREEZE', 'CANCEL', 'LIMIT']), monthlyLimit: money.nullable().optional(), note: z.string().trim().max(200).nullable().optional() }).strict();
const CodeBody = z.object({ accountId: z.string().uuid('Choose an account'), note: z.string().trim().max(300).nullable() }).strict();
const ExcludeBody = z.object({ reason: z.string().trim().min(3, 'Say why this spending stays out of the books').max(300) }).strict();
const Status = z.enum(['UNCODED', 'CODED', 'POSTED', 'EXCLUDED']).optional();
const IssuedBody = z.object({ providerRef: z.string().trim().min(1, 'Send your id for the card').max(100), last4: z.string().regex(/^\d{4}$/, 'Send the last four digits only'), expires: month }).strict();
const TransactionsBody = z
  .object({ transactions: z.array(z.unknown()).min(1, 'Send at least one transaction').max(CARD_FEED_MAX_TRANSACTIONS, `Send at most ${CARD_FEED_MAX_TRANSACTIONS} transactions at a time`) })
  .strict();

/** Company cards (EXP-011/012): programmes, cards and their controls, and card spending. */
@ApiTags('expenses')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/company-cards')
export class CompanyCardsController {
  constructor(private readonly svc: CompanyCardsService) {}

  /** Finance sees every programme and card; anyone else sees the cards they hold. */
  @Get()
  @RequirePermission('org.read')
  overview(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    return this.svc.overview(org, user);
  }

  /** Owners and admins set up a programme; the provider's token is shown once. */
  @Post('programs')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(ProgramBody) })
  createProgram(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(ProgramBody)) b: z.infer<typeof ProgramBody>) {
    return this.svc.createProgram(org, user, b);
  }

  @Post('programs/:programId/rotate-token')
  @HttpCode(200)
  @RequirePermission('org.manage')
  rotate(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('programId', ParseUUIDPipe) id: string) {
    return this.svc.rotateToken(org, user, id);
  }

  @Post('programs/:programId/disconnect')
  @HttpCode(200)
  @RequirePermission('org.manage')
  disconnect(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('programId', ParseUUIDPipe) id: string) {
    return this.svc.disconnect(org, user, id);
  }

  @Post('cards')
  @RequirePermission('banking.manage')
  @ApiBody({ schema: openApi(CardBody) })
  createCard(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CardBody)) b: z.infer<typeof CardBody>) {
    return this.svc.createCard(org, user, b);
  }

  @Post('cards/:cardId/control')
  @HttpCode(200)
  @RequirePermission('banking.manage')
  @ApiBody({ schema: openApi(ControlBody) })
  control(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('cardId', ParseUUIDPipe) id: string, @Body(new ZodPipe(ControlBody)) b: z.infer<typeof ControlBody>) {
    return this.svc.control(org, user, id, b);
  }

  @Get('transactions')
  @RequirePermission('org.read')
  transactions(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query('cardId') cardId?: string, @Query('status') status?: string) {
    const s = Status.safeParse(status || undefined);
    if (!s.success) throw new DomainError('VALIDATION_FAILED', 'Status must be UNCODED, CODED, POSTED or EXCLUDED');
    if (cardId !== undefined && !z.string().uuid().safeParse(cardId).success) throw new DomainError('VALIDATION_FAILED', 'Choose a card');
    return this.svc.transactions(org, user, { cardId, status: s.data });
  }

  /** The cardholder or finance says what the spending was for. */
  @Post('transactions/:txnId/code')
  @HttpCode(200)
  @RequirePermission('org.read')
  @ApiBody({ schema: openApi(CodeBody) })
  code(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('txnId', ParseUUIDPipe) id: string, @Body(new ZodPipe(CodeBody)) b: z.infer<typeof CodeBody>) {
    return this.svc.code(org, user, id, b);
  }

  @Post('transactions/:txnId/post')
  @HttpCode(200)
  @RequirePermission('journals.post')
  post(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('txnId', ParseUUIDPipe) id: string) {
    return this.svc.post(org, user, id);
  }

  @Post('transactions/:txnId/exclude')
  @HttpCode(200)
  @RequirePermission('banking.manage')
  @ApiBody({ schema: openApi(ExcludeBody) })
  exclude(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('txnId', ParseUUIDPipe) id: string, @Body(new ZodPipe(ExcludeBody)) b: z.infer<typeof ExcludeBody>) {
    return this.svc.exclude(org, user, id, b.reason);
  }
}

const bearer = (header: string | undefined) => {
  const m = /^Bearer (\S{1,100})$/.exec(header ?? '');
  if (!m) throw new DomainError('CARD_TOKEN_INVALID', 'Send the card programme token as "Authorization: Bearer t2tc_..."', 401);
  return m[1]!;
};
const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');

/** Where a card provider reads the card controls and sends transactions. No sign-in: the programme's token is the check. */
@ApiTags('card feed')
@ApiBearerAuth()
@Controller('v1/card-feed')
export class CardFeedController {
  constructor(private readonly svc: CompanyCardsService) {}

  @Public()
  @Get('me')
  me(@Headers('authorization') auth: string | undefined, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    return this.svc.whoAmI(bearer(auth));
  }

  @Public()
  @Get('cards')
  cards(@Headers('authorization') auth: string | undefined, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    return this.svc.feedCards(bearer(auth));
  }

  @Public()
  @Post('cards/:cardId/issued')
  @HttpCode(200)
  @ApiBody({ schema: openApi(IssuedBody) })
  issued(@Headers('authorization') auth: string | undefined, @Param('cardId', ParseUUIDPipe) id: string, @Body(new ZodPipe(IssuedBody)) b: z.infer<typeof IssuedBody>, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    return this.svc.issued(bearer(auth), id, b);
  }

  @Public()
  @Post('transactions')
  @HttpCode(200)
  @ApiBody({ schema: openApi(TransactionsBody) })
  transactions(@Headers('authorization') auth: string | undefined, @Body(new ZodPipe(TransactionsBody)) b: z.infer<typeof TransactionsBody>, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    return this.svc.deliver(bearer(auth), b.transactions);
  }
}
