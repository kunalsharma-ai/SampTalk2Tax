import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { SUPPORT_CATEGORIES, SUPPORT_GRANT_MAX_HOURS, SUPPORT_PRIORITIES, SUPPORT_STATUSES } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AllowWhenReadOnly, AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission, RequirePlatform } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { SupportService } from './support.service';

const Body10k = z.string().trim().min(1, 'Write a message').max(10_000);
const NewTicket = z
  .object({
    subject: z.string().trim().min(3, 'Give the ticket a subject').max(200),
    category: z.enum(SUPPORT_CATEGORIES),
    priority: z.enum(SUPPORT_PRIORITIES).default('NORMAL'),
    body: Body10k,
  })
  .strict();
const Reply = z.object({ body: Body10k }).strict();
const Grant = z
  .object({
    hours: z.number().int().min(1).max(SUPPORT_GRANT_MAX_HOURS),
    reason: z.string().trim().min(3, 'Say why support needs to look').max(500),
    ticketId: z.uuid().optional(),
  })
  .strict();
const SupportReply = z.object({ body: Body10k, internal: z.boolean().default(false), resolve: z.boolean().optional() }).strict();
const SupportUpdate = z
  .object({
    priority: z.enum(SUPPORT_PRIORITIES).optional(),
    assigneeId: z.uuid().nullable().optional(),
    action: z.enum(['RESOLVE', 'CLOSE', 'REOPEN']).optional(),
  })
  .strict();
const QueueFilter = z.object({
  status: z.enum(['active', 'all', ...SUPPORT_STATUSES]).default('active'),
  assigned: z.enum(['all', 'me', 'unassigned']).default('all'),
  q: z.string().max(100).optional(),
});

/**
 * An organisation's support tickets and its support access grants. Asking for help works
 * while the books are read-only (a lapsed plan or a suspension).
 */
@ApiTags('support')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get('tickets')
  @RequirePermission('org.read')
  list(@Param('orgId') orgId: string, @CurrentUser() user: AuthUser, @CurrentOrg() org: OrgContext) {
    return this.support.listForOrg(orgId, user, org.role);
  }

  @Post('tickets')
  @RequirePermission('org.read')
  @AllowWhenReadOnly()
  @ApiBody({ schema: openApi(NewTicket) })
  create(@Param('orgId') orgId: string, @CurrentUser() user: AuthUser, @Body(new ZodPipe(NewTicket)) b: z.infer<typeof NewTicket>) {
    return this.support.create(orgId, user, b);
  }

  @Get('tickets/:id')
  @RequirePermission('org.read')
  get(@Param('orgId') orgId: string, @Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser, @CurrentOrg() org: OrgContext) {
    return this.support.getForOrg(orgId, id, user, org.role);
  }

  @Post('tickets/:id/messages')
  @RequirePermission('org.read')
  @AllowWhenReadOnly()
  @ApiBody({ schema: openApi(Reply) })
  reply(@Param('orgId') orgId: string, @Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser, @CurrentOrg() org: OrgContext, @Body(new ZodPipe(Reply)) b: z.infer<typeof Reply>) {
    return this.support.replyAsCustomer(orgId, id, user, org.role, b.body);
  }

  @Post('tickets/:id/close')
  @RequirePermission('org.read')
  @AllowWhenReadOnly()
  @HttpCode(200)
  close(@Param('orgId') orgId: string, @Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser, @CurrentOrg() org: OrgContext) {
    return this.support.customerAction(orgId, id, user, org.role, 'CLOSE');
  }

  @Post('tickets/:id/reopen')
  @RequirePermission('org.read')
  @AllowWhenReadOnly()
  @HttpCode(200)
  reopen(@Param('orgId') orgId: string, @Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser, @CurrentOrg() org: OrgContext) {
    return this.support.customerAction(orgId, id, user, org.role, 'REOPEN');
  }

  /** Who has been given access to the books, and every request they made. */
  @Get('access')
  @RequirePermission('org.manage')
  access(@Param('orgId') orgId: string) {
    return this.support.access(orgId);
  }

  @Post('access')
  @RequirePermission('org.manage')
  @AllowWhenReadOnly()
  @ApiBody({ schema: openApi(Grant) })
  grant(@Param('orgId') orgId: string, @CurrentUser() user: AuthUser, @Body(new ZodPipe(Grant)) b: z.infer<typeof Grant>) {
    return this.support.grant(orgId, user, b);
  }

  @Post('access/:grantId/revoke')
  @RequirePermission('org.manage')
  @AllowWhenReadOnly()
  @HttpCode(200)
  revoke(@Param('orgId') orgId: string, @Param('grantId', new ParseUUIDPipe()) grantId: string, @CurrentUser() user: AuthUser) {
    return this.support.revoke(orgId, grantId, user);
  }
}

/** The support queue in Platform administration: tickets and messages, never the books. */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('v1/admin/support')
export class PlatformSupportController {
  constructor(private readonly support: SupportService) {}

  @Get('tickets')
  @RequirePlatform('platform.support')
  queue(@CurrentUser() user: AuthUser, @Query(new ZodPipe(QueueFilter)) q: z.infer<typeof QueueFilter>) {
    return this.support.queue(user, q);
  }

  @Get('tickets/:id')
  @RequirePlatform('platform.support')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.support.ticketForSupport(id);
  }

  @Post('tickets/:id/messages')
  @RequirePlatform('platform.support')
  @ApiBody({ schema: openApi(SupportReply) })
  reply(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser, @Body(new ZodPipe(SupportReply)) b: z.infer<typeof SupportReply>) {
    return this.support.replyAsSupport(id, user, b);
  }

  @Put('tickets/:id')
  @RequirePlatform('platform.support')
  @ApiBody({ schema: openApi(SupportUpdate) })
  update(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser, @Body(new ZodPipe(SupportUpdate)) b: z.infer<typeof SupportUpdate>) {
    return this.support.updateBySupport(id, user, b);
  }
}
