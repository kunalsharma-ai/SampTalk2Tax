import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { CopilotActionsService } from './copilot.actions';
import { CopilotService, MAX_QUESTION_CHARS } from './copilot.service';

const id = z.string().uuid('Not a conversation id');
const AskBody = z.object({ question: z.string().trim().min(1, 'Ask a question').max(MAX_QUESTION_CHARS, `Keep a question under ${MAX_QUESTION_CHARS} characters`), channel: z.enum(['TEXT', 'VOICE']).default('TEXT') }).strict();
const actionId = z.string().uuid('Not an action id');
const SettingsBody = z.object({ enabled: z.boolean() }).strict();

@ApiTags('copilot')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/copilot')
export class CopilotController {
  constructor(
    private readonly copilot: CopilotService,
    private readonly actions: CopilotActionsService,
  ) {}

  /** Whether the server has an AI provider key, whether the organisation has the copilot on, and the model. */
  @Get('status')
  @RequirePermission('copilot.use')
  status(@CurrentOrg() org: OrgContext) {
    return this.copilot.status({ orgId: org.id, role: org.role });
  }

  /** Turn the copilot on or off for the organisation. Questions and figures are sent to the AI provider only while it is on. */
  @Put('settings')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(SettingsBody) })
  settings(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(SettingsBody)) body: z.infer<typeof SettingsBody>) {
    return this.copilot.saveSettings({ orgId: org.id, role: org.role }, user, body.enabled);
  }

  /** The signed-in member's own conversations, newest first. */
  @Get('conversations')
  @RequirePermission('copilot.use')
  list(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    return this.copilot.list(org.id, user);
  }

  /** Start a conversation with a question. The answer is worked on in the background: read the conversation until it is no longer pending. */
  @Post('conversations')
  @RequirePermission('copilot.use')
  @ApiBody({ schema: openApi(AskBody) })
  start(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(AskBody)) body: z.infer<typeof AskBody>) {
    return this.copilot.ask({ orgId: org.id, role: org.role }, user, null, body.question, body.channel);
  }

  @Get('conversations/:conversationId')
  @RequirePermission('copilot.use')
  get(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('conversationId', new ZodPipe(id)) conversationId: string) {
    return this.copilot.get(org.id, user, conversationId);
  }

  /** Ask a follow-up question in a conversation. */
  @Post('conversations/:conversationId/messages')
  @RequirePermission('copilot.use')
  @ApiBody({ schema: openApi(AskBody) })
  ask(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('conversationId', new ZodPipe(id)) conversationId: string, @Body(new ZodPipe(AskBody)) body: z.infer<typeof AskBody>) {
    return this.copilot.ask({ orgId: org.id, role: org.role }, user, conversationId, body.question, body.channel);
  }

  @Delete('conversations/:conversationId')
  @HttpCode(204)
  @RequirePermission('copilot.use')
  async remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('conversationId', new ZodPipe(id)) conversationId: string) {
    await this.copilot.remove(org.id, user, conversationId);
  }

  /**
   * Carry out an action the assistant proposed. Only the member who asked can confirm it, before it
   * expires, and only with the permission the action needs at that moment.
   */
  @Post('actions/:actionId/confirm')
  @HttpCode(200)
  @RequirePermission('copilot.use')
  confirm(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('actionId', new ZodPipe(actionId)) id: string) {
    return this.actions.confirm({ orgId: org.id, role: org.role }, user, id);
  }

  @Post('actions/:actionId/cancel')
  @HttpCode(200)
  @RequirePermission('copilot.use')
  cancel(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('actionId', new ZodPipe(actionId)) id: string) {
    return this.actions.cancel({ orgId: org.id, role: org.role }, user, id);
  }
}
