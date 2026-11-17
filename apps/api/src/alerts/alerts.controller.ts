import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { ALERT_RULE_KEYS } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { AlertsService } from './alerts.service';

const ListQuery = z.object({
  status: z.enum(['ACTIVE', 'DISMISSED', 'CLEARED', 'ALL']).default('ACTIVE'),
  /** "false" = do not run stale checks first (for a quick count). */
  fresh: z.enum(['true', 'false']).optional().transform((v) => v !== 'false'),
});
const id = z.string().uuid('Not an alert id');
const rule = z.enum(ALERT_RULE_KEYS);
const NoteBody = z.object({ note: z.string().trim().max(1000).nullable().optional() }).strict();
const DismissBody = z.object({ reason: z.string().trim().min(3, 'Say why this is not a problem (at least 3 characters)').max(1000) }).strict();
const RuleBody = z
  .object({
    enabled: z.boolean(),
    params: z.record(z.string(), z.string().trim().max(20)).default({}),
  })
  .strict();

const NotificationsBody = z
  .object({
    minSeverity: z.enum(['CRITICAL', 'WARNING', 'OFF']),
    taskRole: z.enum(['OWNER', 'ADMIN', 'ACCOUNTANT', 'APPROVER']),
    dueDays: z.number().int('Days must be a whole number').min(0, 'Days cannot be negative').max(30, 'At most 30 days'),
  })
  .strict();

@ApiTags('alerts')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  /** Alerts and counts. Runs the checks first when the last run is over an hour old. */
  @Get('alerts')
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.alerts.list(org.id, q);
  }

  /** Run every check that is on now. */
  @Post('alerts/scan')
  @HttpCode(200)
  @RequirePermission('alerts.manage')
  scan(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    return this.alerts.runScan(org.id, user);
  }

  /** Which new alerts become a task in the work queue, for which role, and how soon they are due. */
  @Get('alerts/notifications')
  @RequirePermission('reports.read')
  notifications(@CurrentOrg() org: OrgContext) {
    return this.alerts.notifications(org.id);
  }

  @Put('alerts/notifications')
  @RequirePermission('alerts.manage')
  @ApiBody({ schema: openApi(NotificationsBody) })
  saveNotifications(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(NotificationsBody)) body: z.infer<typeof NotificationsBody>) {
    return this.alerts.saveNotifications(org.id, user, body);
  }

  @Get('alerts/:alertId')
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Param('alertId', new ZodPipe(id)) alertId: string) {
    return this.alerts.get(org.id, alertId);
  }

  /** Mark an open alert as being looked at, with an optional note. */
  @Post('alerts/:alertId/acknowledge')
  @HttpCode(200)
  @RequirePermission('alerts.manage')
  @ApiBody({ schema: openApi(NoteBody) })
  acknowledge(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('alertId', new ZodPipe(id)) alertId: string, @Body(new ZodPipe(NoteBody)) body: z.infer<typeof NoteBody>) {
    return this.alerts.acknowledge(org.id, user, alertId, body.note || null);
  }

  /** Not a problem: the alert stays dismissed even when the checks find it again. A reason is required. */
  @Post('alerts/:alertId/dismiss')
  @HttpCode(200)
  @RequirePermission('alerts.manage')
  @ApiBody({ schema: openApi(DismissBody) })
  dismiss(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('alertId', new ZodPipe(id)) alertId: string, @Body(new ZodPipe(DismissBody)) body: z.infer<typeof DismissBody>) {
    return this.alerts.dismiss(org.id, user, alertId, body.reason);
  }

  @Post('alerts/:alertId/reopen')
  @HttpCode(200)
  @RequirePermission('alerts.manage')
  @ApiBody({ schema: openApi(NoteBody) })
  reopen(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('alertId', new ZodPipe(id)) alertId: string, @Body(new ZodPipe(NoteBody)) body: z.infer<typeof NoteBody>) {
    return this.alerts.reopen(org.id, user, alertId, body.note || null);
  }

  /** Every check with its description, whether it is on, and its thresholds. */
  @Get('alert-rules')
  @RequirePermission('reports.read')
  rules(@CurrentOrg() org: OrgContext) {
    return this.alerts.rules(org.id);
  }

  @Put('alert-rules/:rule')
  @RequirePermission('alerts.manage')
  @ApiBody({ schema: openApi(RuleBody) })
  saveRule(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('rule', new ZodPipe(rule)) key: z.infer<typeof rule>, @Body(new ZodPipe(RuleBody)) body: z.infer<typeof RuleBody>) {
    return this.alerts.saveRule(org.id, user, key, body);
  }
}
