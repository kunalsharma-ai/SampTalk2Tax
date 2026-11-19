import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentUser, RequirePlatform } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { SecurityMonitorRunnerService } from './security-monitor-runner.service';
import { SecurityMonitorService } from './security-monitor.service';

const Ack = z.object({ note: z.string().trim().min(5, 'Say what was found or done (at least 5 characters)').max(500, 'Keep the note under 500 characters') }).strict();
const Filter = z.object({ severity: z.enum(['HIGH', 'MEDIUM']).optional() }).strict();

/** Security event monitoring (SEC-023), for the people who run Talk2Tax. */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('v1/admin/security')
export class SecurityMonitorController {
  constructor(
    private readonly monitor: SecurityMonitorService,
    private readonly runner: SecurityMonitorRunnerService,
  ) {}

  @Get()
  @RequirePlatform('platform.read')
  report(@Query(new ZodPipe(Filter)) q: z.infer<typeof Filter>) {
    return this.monitor.report(q);
  }

  /** Check the audit trail now instead of waiting for the next run. */
  @Post('scan')
  @HttpCode(200)
  @RequirePlatform('platform.manage')
  async scan() {
    await this.runner.tick();
    return this.monitor.report();
  }

  @Post('alerts/:id/acknowledge')
  @HttpCode(200)
  @RequirePlatform('platform.manage')
  @ApiBody({ schema: openApi(Ack) })
  acknowledge(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Ack)) body: z.infer<typeof Ack>) {
    return this.monitor.acknowledge(user, id, body.note);
  }
}
