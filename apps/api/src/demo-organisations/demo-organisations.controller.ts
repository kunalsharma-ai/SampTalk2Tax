import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { DEMO_PROFILE_KEYS } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { DemoOrganisationsService } from './demo-organisations.service';

const CreateDemoBody = z.object({ profile: z.enum(DEMO_PROFILE_KEYS) }).strict();

/** Demonstration organisations (DEMO-001): the six made-up companies, and making one for yourself. */
@ApiTags('demo-organisations')
@ApiBearerAuth()
@Controller('v1/demo-organisations')
export class DemoOrganisationsController {
  constructor(private readonly demos: DemoOrganisationsService) {}

  @Get('profiles')
  profiles() {
    return this.demos.profiles();
  }

  @Post()
  @ApiBody({ schema: openApi(CreateDemoBody) })
  create(@CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateDemoBody)) body: z.infer<typeof CreateDemoBody>) {
    return this.demos.create(user, body.profile);
  }
}

/** What a demonstration organisation holds, and the recommendations its books lead to. */
@ApiTags('demo-organisations')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/demo-organisation')
export class DemoOrganisationSummaryController {
  constructor(private readonly demos: DemoOrganisationsService) {}

  @Get()
  @RequirePermission('org.read')
  summary(@CurrentOrg() org: OrgContext) {
    return this.demos.summary(org);
  }
}
