import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, Public, RequirePermission, RequirePlatform } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { ErrorsService } from './errors.service';
import { FlagsService } from './flags.service';
import { MaintenanceService } from './maintenance.service';
import { SystemService } from './system.service';

const FlagSetting = z.object({ enabled: z.boolean(), rolloutPercent: z.number().int().min(0).max(100).default(100), note: z.string().max(500).nullable().optional() }).strict();
const Override = z.object({ enabled: z.boolean(), reason: z.string().trim().min(1).max(500) }).strict();
const Maintenance = z
  .object({ message: z.string().trim().min(1).max(500), startsAt: z.iso.datetime({ offset: true }).optional(), expectedEndAt: z.iso.datetime({ offset: true }).nullable().optional() })
  .strict();
const ErrorQuery = z.object({ status: z.enum(['open', 'resolved', 'all']).default('open') });
const Resolve = z.object({ resolved: z.boolean() }).strict();
const RequestId = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);

/** Status for everyone, before and after signing in: is maintenance scheduled or in progress. */
@ApiTags('operations')
@Controller('v1/status')
export class StatusController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Public()
  @Get()
  async status() {
    const m = await this.maintenance.current();
    return { maintenance: m ? { message: m.message, state: m.state, startsAt: m.startsAt, expectedEndAt: m.expectedEndAt } : null };
  }
}

/** The organisation's feature flags, for its menus (the API enforces them on its own). */
@ApiTags('operations')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/flags')
export class OrgFlagsController {
  constructor(private readonly flags: FlagsService) {}

  @Get()
  @RequirePermission('org.read')
  forOrg(@CurrentOrg() org: OrgContext) {
    return this.flags.forOrg(org.id);
  }
}

/** Platform operations: system health, errors, feature flags and maintenance. */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('v1/admin')
export class OperationsController {
  constructor(
    private readonly system: SystemService,
    private readonly errors: ErrorsService,
    private readonly flags: FlagsService,
    private readonly maintenance: MaintenanceService,
  ) {}

  @Get('system')
  @RequirePlatform('platform.read')
  health() {
    return this.system.health();
  }

  @Get('errors')
  @RequirePlatform('platform.read')
  errorGroups(@Query(new ZodPipe(ErrorQuery)) q: z.infer<typeof ErrorQuery>) {
    return this.errors.groups(q.status);
  }

  @Get('errors/requests/:requestId')
  @RequirePlatform('platform.read')
  byRequest(@Param('requestId', new ZodPipe(RequestId)) requestId: string) {
    return this.errors.byRequestId(requestId);
  }

  @Get('errors/:id')
  @RequirePlatform('platform.read')
  errorGroup(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.errors.group(id);
  }

  @Put('errors/:id/resolved')
  @RequirePlatform('platform.manage')
  @ApiBody({ schema: openApi(Resolve) })
  resolve(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(Resolve)) body: z.infer<typeof Resolve>) {
    return this.errors.resolve(user, id, body.resolved);
  }

  @Get('flags')
  @RequirePlatform('platform.read')
  listFlags() {
    return this.flags.list();
  }

  @Put('flags/:key')
  @RequirePlatform('platform.manage')
  @ApiBody({ schema: openApi(FlagSetting) })
  setFlag(@CurrentUser() user: AuthUser, @Param('key') key: string, @Body(new ZodPipe(FlagSetting)) body: z.infer<typeof FlagSetting>) {
    return this.flags.set(user, key, body);
  }

  @Delete('flags/:key')
  @RequirePlatform('platform.manage')
  resetFlag(@CurrentUser() user: AuthUser, @Param('key') key: string) {
    return this.flags.reset(user, key);
  }

  @Put('flags/:key/organisations/:orgId')
  @RequirePlatform('platform.manage')
  @ApiBody({ schema: openApi(Override) })
  override(@CurrentUser() user: AuthUser, @Param('key') key: string, @Param('orgId', new ParseUUIDPipe()) orgId: string, @Body(new ZodPipe(Override)) body: z.infer<typeof Override>) {
    return this.flags.override(user, key, orgId, body);
  }

  @Delete('flags/:key/organisations/:orgId')
  @RequirePlatform('platform.manage')
  removeOverride(@CurrentUser() user: AuthUser, @Param('key') key: string, @Param('orgId', new ParseUUIDPipe()) orgId: string) {
    return this.flags.removeOverride(user, key, orgId);
  }

  @Get('maintenance')
  @RequirePlatform('platform.read')
  windows() {
    return this.maintenance.list();
  }

  @Post('maintenance')
  @RequirePlatform('platform.manage')
  @ApiBody({ schema: openApi(Maintenance) })
  start(@CurrentUser() user: AuthUser, @Body(new ZodPipe(Maintenance)) body: z.infer<typeof Maintenance>) {
    return this.maintenance.start(user, body);
  }

  @Post('maintenance/:id/end')
  @RequirePlatform('platform.manage')
  end(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.maintenance.end(user, id);
  }
}
