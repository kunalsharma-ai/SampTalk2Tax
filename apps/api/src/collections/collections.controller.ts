import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { CollectionsService } from './collections.service';

const id = z.string().uuid('Not a reminder id');
const StatusQuery = z.object({ status: z.enum(['DRAFTING', 'READY', 'SENT', 'SEND_FAILED', 'REJECTED', 'FAILED']).optional() }).strict();
const subject = z.string().max(300, 'Keep the subject under 300 characters');
const body = z.string().max(20_000, 'Keep the message under 20,000 characters');
const SendBody = z.object({ subject: subject.optional(), body: body.optional() }).strict();
const CheckBody = z.object({ subject, body }).strict();
const RejectBody = z.object({ note: z.string().trim().max(1000, 'Keep the note under 1,000 characters').nullish() }).strict();
const ActivityQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }).strict();

@ApiTags('collections')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId')
export class CollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  /** Whether AI and email are set up, counts of reminders by status, and the latest drafting run. */
  @Get('collections')
  @RequirePermission('collections.manage')
  overview(@CurrentOrg() org: OrgContext) {
    return this.collections.overview({ orgId: org.id, role: org.role });
  }

  /** Have the AI model draft a payment reminder for each customer with overdue invoices. Drafting runs in the background; nothing is sent. */
  @Post('collections/runs')
  @RequirePermission('collections.manage')
  start(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    return this.collections.start({ orgId: org.id, role: org.role }, user);
  }

  @Get('collections/reminders')
  @RequirePermission('collections.manage')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(StatusQuery)) q: z.infer<typeof StatusQuery>) {
    return this.collections.list(org.id, q.status);
  }

  @Get('collections/reminders/:id')
  @RequirePermission('collections.manage')
  get(@CurrentOrg() org: OrgContext, @Param('id', new ZodPipe(id)) reminderId: string) {
    return this.collections.get(org.id, reminderId);
  }

  /** Check an edited reminder against the books without saving it. */
  @Post('collections/reminders/:id/check')
  @HttpCode(200)
  @RequirePermission('collections.manage')
  @ApiBody({ schema: openApi(CheckBody) })
  check(@CurrentOrg() org: OrgContext, @Param('id', new ZodPipe(id)) reminderId: string, @Body(new ZodPipe(CheckBody)) b: z.infer<typeof CheckBody>) {
    return this.collections.check(org.id, reminderId, b);
  }

  /** Approve and send a reminder, with edits if given. Sent only when every check against the books passes. */
  @Post('collections/reminders/:id/send')
  @HttpCode(200)
  @RequirePermission('collections.manage')
  @ApiBody({ schema: openApi(SendBody) })
  send(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) reminderId: string, @Body(new ZodPipe(SendBody)) b: z.infer<typeof SendBody>) {
    return this.collections.send({ orgId: org.id, role: org.role }, user, reminderId, b);
  }

  @Post('collections/reminders/:id/reject')
  @HttpCode(200)
  @RequirePermission('collections.manage')
  @ApiBody({ schema: openApi(RejectBody) })
  reject(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) reminderId: string, @Body(new ZodPipe(RejectBody)) b: z.infer<typeof RejectBody>) {
    return this.collections.reject({ orgId: org.id, role: org.role }, user, reminderId, b.note || null);
  }

  /** Every AI call made for the organisation: copilot answers and reminder drafts, with model, tokens, outcome and decision. */
  @Get('ai-activity')
  @RequirePermission('audit.read')
  activity(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ActivityQuery)) q: z.infer<typeof ActivityQuery>) {
    return this.collections.activity(org.id, q.limit ?? 100);
  }
}
