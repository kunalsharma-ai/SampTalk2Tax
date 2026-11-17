import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermission, RequirePlatform } from '../auth/decorators';
import { UsageService } from './usage.service';

/** What the organisation used this month against its plan. */
@ApiTags('usage')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/usage')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  @RequirePermission('org.read')
  get(@Param('orgId') orgId: string) {
    return this.usage.summary(orgId);
  }
}

/** Every organisation's use in a month (platform administration). */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('v1/admin/usage')
export class PlatformUsageController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  @RequirePlatform('platform.read')
  list(@Query('month') month?: string) {
    return this.usage.platform(UsageService.month(month));
  }
}
