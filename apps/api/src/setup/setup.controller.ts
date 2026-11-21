import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { ACCOUNTING_FRAMEWORKS, AI_PREFERENCES, BUSINESS_SIZES, INDUSTRIES } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { SetupService } from './setup.service';

const ids = <T extends string>(list: readonly T[], message: string) => z.enum(list as unknown as [T, ...T[]], { message });
const ProfileBody = z
  .object({
    industry: ids(INDUSTRIES.map((i) => i.key), 'Choose an industry from the list'),
    size: ids(BUSINESS_SIZES.map((s) => s.key), 'Choose a size from the list'),
    framework: ids(ACCOUNTING_FRAMEWORKS.map((f) => f.id), 'Choose an accounting framework from the list'),
    aiPreference: ids(AI_PREFERENCES.map((a) => a.id), 'Choose how much the AI agents do'),
  })
  .strict();

@ApiTags('setup')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/setup')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  /** The business profile, suggestions, each setup check and whether the organisation can be activated. */
  @Get()
  @RequirePermission('accounts.read')
  overview(@CurrentOrg() org: OrgContext) {
    return this.setup.overview(org);
  }

  @Put('profile')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(ProfileBody) })
  save(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(ProfileBody)) body: z.infer<typeof ProfileBody>) {
    return this.setup.saveProfile(org, user, body);
  }

  @Post('activate')
  @HttpCode(200)
  @RequirePermission('org.manage')
  activate(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    return this.setup.activate(org, user);
  }
}
