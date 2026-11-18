import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { DocumentStoreService } from '../common/document-store.service';
import { RegionsService } from '../regions/regions.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly regions: RegionsService,
    private readonly documents: DocumentStoreService,
  ) {}

  @Public()
  @Get()
  async health() {
    await this.documents.ping();
    return { status: 'ok', database: 'ok', region: this.regions.current };
  }
}
