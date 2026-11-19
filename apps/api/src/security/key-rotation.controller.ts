import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, RequirePlatform } from '../auth/decorators';
import { KeyRotationService } from './key-rotation.service';

/** Encryption key rotation (SEC-013), for the people who run Talk2Tax. */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('v1/admin/encryption-keys')
export class KeyRotationController {
  constructor(private readonly keys: KeyRotationService) {}

  @Get()
  @RequirePlatform('platform.read')
  report() {
    return this.keys.report();
  }

  @Post('reseal')
  @HttpCode(200)
  @RequirePlatform('platform.manage')
  reseal(@CurrentUser() user: AuthUser) {
    return this.keys.reseal(user);
  }
}
