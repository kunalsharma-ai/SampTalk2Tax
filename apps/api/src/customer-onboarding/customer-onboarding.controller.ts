import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { decimalString, openApi, ZodPipe } from '../common/zod';
import { CustomerOnboardingService } from './customer-onboarding.service';

const id = z.string().uuid('Not a valid id');
const SettingsBody = z
  .object({
    required: z.boolean(),
    requirements: z.array(z.object({ id: id.nullish(), label: z.string().trim().min(1, 'Every checklist item needs a description').max(300), needsFile: z.boolean() }).strict()).max(30),
  })
  .strict();
const UpdateBody = z
  .object({
    creditLimit: decimalString.nullish(),
    paymentTermsDays: z.number().int().min(0).max(365).nullish(),
    notes: z.string().max(2000).nullish(),
  })
  .strict();
const CheckBody = z.object({ done: z.boolean(), attachmentId: id.nullish(), note: z.string().max(1000).nullish() }).strict();
const DecideBody = z.object({ approve: z.boolean(), note: z.string().max(1000).nullish() }).strict();
const ListQuery = z.object({ status: z.enum(['OPEN', 'SUBMITTED', 'APPROVED', 'REJECTED']).optional() });

@ApiTags('customer onboarding')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/sales')
export class CustomerOnboardingController {
  constructor(private readonly onboarding: CustomerOnboardingService) {}

  /** Whether new customers must be onboarded, and the organisation's checklist. */
  @Get('onboarding-settings')
  @RequirePermission('sales.read')
  settings(@CurrentOrg() org: OrgContext) {
    return this.onboarding.settings(org);
  }

  @Put('onboarding-settings')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(SettingsBody) })
  saveSettings(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(SettingsBody)) b: z.infer<typeof SettingsBody>) {
    return this.onboarding.saveSettings(org, user, { required: b.required, requirements: b.requirements.map((r) => ({ id: r.id ?? null, label: r.label, needsFile: r.needsFile })) });
  }

  @Get('onboardings')
  @RequirePermission('sales.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.onboarding.list(org, q);
  }

  /** A customer's onboarding, or null with whether one can be started. */
  @Get('customers/:contactId/onboarding')
  @RequirePermission('sales.read')
  forContact(@CurrentOrg() org: OrgContext, @Param('contactId', new ZodPipe(id)) contactId: string) {
    return this.onboarding.forContact(org, contactId);
  }

  @Post('customers/:contactId/onboarding')
  @RequirePermission('sales.manage')
  start(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('contactId', new ZodPipe(id)) contactId: string) {
    return this.onboarding.start(org, user, contactId);
  }

  @Get('onboardings/:id')
  @RequirePermission('sales.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', new ZodPipe(id)) oid: string) {
    return this.onboarding.detail(org, oid);
  }

  @Put('onboardings/:id')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(UpdateBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) oid: string, @Body(new ZodPipe(UpdateBody)) b: z.infer<typeof UpdateBody>) {
    return this.onboarding.update(org, user, oid, b);
  }

  @Put('onboardings/:id/checks/:checkId')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(CheckBody) })
  check(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) oid: string, @Param('checkId', new ZodPipe(id)) checkId: string, @Body(new ZodPipe(CheckBody)) b: z.infer<typeof CheckBody>) {
    return this.onboarding.setCheck(org, user, oid, checkId, b);
  }

  @Post('onboardings/:id/submit')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  submit(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) oid: string) {
    return this.onboarding.submit(org, user, oid);
  }

  @Post('onboardings/:id/withdraw')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  withdraw(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) oid: string) {
    return this.onboarding.withdraw(org, user, oid);
  }

  /** Approve (sets the customer's credit limit and terms) or reject with a reason. */
  @Post('onboardings/:id/decide')
  @HttpCode(200)
  @RequirePermission('approvals.decide')
  @ApiBody({ schema: openApi(DecideBody) })
  decide(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) oid: string, @Body(new ZodPipe(DecideBody)) b: z.infer<typeof DecideBody>) {
    return this.onboarding.decide(org, user, oid, b);
  }

  @Post('onboardings/:id/reopen')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  reopen(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) oid: string) {
    return this.onboarding.reopen(org, user, oid);
  }
}
