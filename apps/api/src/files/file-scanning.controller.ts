import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePlatform } from '../auth/decorators';
import { FileScannerService } from './file-scanner.service';

/** Upload checks and malware scanning (SEC-018/019), for the people who run Talk2Tax. */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('v1/admin/file-scanning')
export class FileScanningController {
  constructor(private readonly scanner: FileScannerService) {}

  @Get()
  @RequirePlatform('platform.read')
  report() {
    return this.scanner.report();
  }
}
