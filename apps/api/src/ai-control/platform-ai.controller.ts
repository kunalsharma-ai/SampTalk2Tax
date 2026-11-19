import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentUser, RequirePlatform } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { AiControlService } from './ai-control.service';

const Reason = z.object({ reason: z.string().trim().min(10, 'Give the reason (at least 10 characters)').max(500, 'Keep the reason under 500 characters') }).strict();

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

  @Post('resume')
  @HttpCode(200)
  @RequirePlatform('platform.manage')
  @ApiBody({ schema: openApi(Reason) })
  resume(@CurrentUser() user: AuthUser, @Body(new ZodPipe(Reason)) body: z.infer<typeof Reason>) {
    return this.control.platformResume(user, body.reason);
  }
}
