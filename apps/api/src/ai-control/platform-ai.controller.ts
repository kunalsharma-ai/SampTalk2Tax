import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentUser, RequirePlatform } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { AiControlService } from './ai-control.service';

const Reason = z.object({ reason: z.string().trim().min(10, 'Give the reason (at least 10 characters)').max(500, 'Keep the reason under 500 characters') }).strict();

const Models = z.object({ allowed: z.array(z.string().trim().min(1).max(100)).min(1, 'Allow at least one model; to stop AI, use the shutdown').max(20).nullable(), reason: Reason.shape.reason }).strict();

/** The platform-wide AI emergency shutdown (SEC-038), for the people who run Talk2Tax. */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('v1/admin/ai')
export class PlatformAiController {
  constructor(private readonly control: AiControlService) {}

  @Get()
  @RequirePlatform('platform.read')
  status() {
    return this.control.platformStatus();
  }

  @Post('stop')
  @HttpCode(200)
  @RequirePlatform('platform.manage')
  @ApiBody({ schema: openApi(Reason) })
  stop(@CurrentUser() user: AuthUser, @Body(new ZodPipe(Reason)) body: z.infer<typeof Reason>) {
    return this.control.platformStop(user, body.reason);
  }

  /** The models allowed across Talk2Tax (SEC-034). */
  @Post('models')
  @HttpCode(200)
  @RequirePlatform('platform.manage')
  @ApiBody({ schema: openApi(Models) })
  models(@CurrentUser() user: AuthUser, @Body(new ZodPipe(Models)) body: z.infer<typeof Models>) {
    return this.control.platformSetModels(user, body.allowed, body.reason);
  }

  @Post('resume')
  @HttpCode(200)
  @RequirePlatform('platform.manage')
  @ApiBody({ schema: openApi(Reason) })
  resume(@CurrentUser() user: AuthUser, @Body(new ZodPipe(Reason)) body: z.infer<typeof Reason>) {
    return this.control.platformResume(user, body.reason);
  }
}
