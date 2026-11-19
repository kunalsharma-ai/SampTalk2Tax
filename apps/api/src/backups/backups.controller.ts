import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePlatform } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { BackupsService } from './backups.service';

const Filter = z.object({ kind: z.enum(['BACKUP', 'VERIFY', 'RESTORE_DRILL']).optional() }).strict();

/** Backups and restore drills (SEC-021/022), for the people who run Talk2Tax. */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('v1/admin/backups')
export class BackupsController {
  constructor(private readonly backups: BackupsService) {}

  @Get()
  @RequirePlatform('platform.read')
  report(@Query(new ZodPipe(Filter)) q: z.infer<typeof Filter>) {
    return this.backups.report(q.kind);
  }
}
