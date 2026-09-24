import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { HealthService } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness probe. Public: no @RequireCapabilities, so the guard lets it through. */
  @Get()
  @ApiOkResponse({ description: 'Service is up.' })
  check(): { status: 'ok'; service: string; time: string } {
    return {
      status: 'ok',
      service: 'plenka-api',
      time: new Date().toISOString(),
    };
  }

  /** Readiness probe. Public and safe: verifies PostgreSQL without exposing dependency details. */
  @Get('ready')
  @ApiOkResponse({ description: 'Service and required database are ready.' })
  ready() {
    return this.health.readiness();
  }
}
