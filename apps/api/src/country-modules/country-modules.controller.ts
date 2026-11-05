import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { CountryModulesService } from './country-modules.service';

const Code = z.string().regex(/^[A-Za-z]{2}$/, 'ISO 3166-1 alpha-2, e.g. IN');
const StarterBody = z.object({ names: z.array(z.string().trim().min(1).max(100)).min(1).max(20).optional() }).strict();

/** The catalogue is the same for everyone signed in, so onboarding can show it before an organisation exists. */
@ApiTags('country-modules')
@ApiBearerAuth()
@Controller('v1/country-modules')
export class CountryModulesCatalogueController {
  constructor(private readonly svc: CountryModulesService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Get(':code')
  one(@Param('code', new ZodPipe(Code)) code: string) {
    return this.svc.one(code);
  }
}

@ApiTags('country-modules')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/country-module')
export class CountryModuleController {
  constructor(private readonly svc: CountryModulesService) {}

  @Get()
  @RequirePermission('org.read')
  get(@CurrentOrg() org: OrgContext) {
    return this.svc.forOrg(org.id);
  }

  /** Adds the country's standard sales-tax rates as ordinary tax rates (accounts.manage, like any tax rate). */
  @Post('starter-rates')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(StarterBody) })
  addStarterRates(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(StarterBody)) body: z.infer<typeof StarterBody>) {
    return this.svc.addStarterRates(org.id, user, body.names);
  }
}
