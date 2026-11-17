import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { RegionsService } from './regions.service';

@ApiTags('regions')
@Controller('v1/region')
export class RegionsController {
  constructor(private readonly regions: RegionsService) {}

  /** The region this deployment serves, and the other regions it knows. */
  @Public()
  @Get()
  here() {
    return this.regions.here();
  }
}
