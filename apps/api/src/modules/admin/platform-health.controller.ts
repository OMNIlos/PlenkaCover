import { Body, Controller, Get, Param, Post, Query, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import {
  OperationalIncidentQueryDto,
  OperationalIncidentReasonDto,
} from './dto/platform-health.dto';
import { PlatformHealthService } from './platform-health.service';

@ApiTags('admin')
@ApiBearerAuth('session')
@Controller('admin')
export class PlatformHealthController {
  constructor(private readonly health: PlatformHealthService) {}

  @Get('platform-health')
  @RequireCapabilities('admin:platform_health')
  @ApiOkResponse({ description: 'Latest safe platform health snapshot.' })
  snapshot() {
    return this.health.snapshot();
  }

  @Post('platform-health/check')
  @RequireCapabilities('admin:platform_health')
  @ApiCreatedResponse({ description: 'Fresh bounded platform component checks.' })
  check(@CurrentActor() actor: Actor | undefined) {
    return this.health.check(this.requireActor(actor));
  }

  @Get('incidents')
  @RequireCapabilities('admin:platform_health')
  @ApiOkResponse({ description: 'Filtered operational incidents.' })
  incidents(@Query() query: OperationalIncidentQueryDto) {
    return this.health.listIncidents(query);
  }

  @Post('incidents/:incidentId/acknowledge')
  @RequireCapabilities('admin:platform_health')
  @ApiCreatedResponse({ description: 'Acknowledged incident with audit reason.' })
  acknowledge(
    @CurrentActor() actor: Actor | undefined,
    @Param('incidentId') incidentId: string,
    @Body() dto: OperationalIncidentReasonDto,
  ) {
    return this.health.acknowledgeIncident(this.requireActor(actor), incidentId, dto.reason);
  }

  @Post('incidents/:incidentId/resolve')
  @RequireCapabilities('admin:platform_health')
  @ApiCreatedResponse({ description: 'Resolved incident with audit reason.' })
  resolve(
    @CurrentActor() actor: Actor | undefined,
    @Param('incidentId') incidentId: string,
    @Body() dto: OperationalIncidentReasonDto,
  ) {
    return this.health.resolveIncident(this.requireActor(actor), incidentId, dto.reason);
  }

  @Post('incidents/:incidentId/recheck')
  @RequireCapabilities('admin:platform_health')
  @ApiCreatedResponse({ description: 'Scoped incident recheck.' })
  recheck(@CurrentActor() actor: Actor | undefined, @Param('incidentId') incidentId: string) {
    return this.health.recheckIncident(this.requireActor(actor), incidentId);
  }

  private requireActor(actor: Actor | undefined): Actor {
    if (!actor) throw new UnauthorizedException('Authentication required.');
    return actor;
  }
}
