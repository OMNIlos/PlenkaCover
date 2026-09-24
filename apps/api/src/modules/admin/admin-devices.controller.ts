import { Body, Controller, Get, Param, Patch, Post, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { AdminDevicesService } from './admin-devices.service';
import {
  BindAdminDeviceDto,
  CreateAdminDeviceDto,
  UpdateAdminDeviceDto,
} from './dto/admin-device.dto';
import { AdminReasonDto } from './dto/admin-account.dto';

@ApiTags('admin')
@ApiBearerAuth('session')
@Controller('admin/devices')
export class AdminDevicesController {
  constructor(private readonly devices: AdminDevicesService) {}

  @Get()
  @RequireCapabilities('admin:devices')
  @ApiOkResponse({ description: 'Safe device catalog without raw payload.' })
  list() {
    return this.devices.list();
  }

  @Post()
  @RequireCapabilities('admin:devices')
  @ApiCreatedResponse({ description: 'Created device configuration.' })
  create(@CurrentActor() actor: Actor | undefined, @Body() dto: CreateAdminDeviceDto) {
    return this.devices.create(this.requireActor(actor), dto);
  }

  @Get(':deviceId')
  @RequireCapabilities('admin:devices')
  @ApiOkResponse({ description: 'Safe device configuration and post binding.' })
  get(@Param('deviceId') deviceId: string) {
    return this.devices.get(deviceId);
  }

  @Patch(':deviceId')
  @RequireCapabilities('admin:devices')
  @ApiOkResponse({ description: 'Updated device configuration.' })
  update(
    @CurrentActor() actor: Actor | undefined,
    @Param('deviceId') deviceId: string,
    @Body() dto: UpdateAdminDeviceDto,
  ) {
    return this.devices.update(this.requireActor(actor), deviceId, dto);
  }

  @Post(':deviceId/bind')
  @RequireCapabilities('admin:devices', 'admin:posts')
  @ApiCreatedResponse({ description: 'Device binding moved to an existing post.' })
  bind(
    @CurrentActor() actor: Actor | undefined,
    @Param('deviceId') deviceId: string,
    @Body() dto: BindAdminDeviceDto,
  ) {
    return this.devices.bind(this.requireActor(actor), deviceId, dto);
  }

  @Post(':deviceId/test')
  @RequireCapabilities('admin:devices')
  @ApiCreatedResponse({ description: 'Gateway-backed device test result.' })
  test(@CurrentActor() actor: Actor | undefined, @Param('deviceId') deviceId: string) {
    return this.devices.test(this.requireActor(actor), deviceId);
  }

  @Post(':deviceId/recover')
  @RequireCapabilities('admin:devices')
  @ApiCreatedResponse({ description: 'Gateway recovery followed by mandatory verification.' })
  recover(
    @CurrentActor() actor: Actor | undefined,
    @Param('deviceId') deviceId: string,
    @Body() dto: AdminReasonDto,
  ) {
    return this.devices.recover(this.requireActor(actor), deviceId, dto.reason);
  }

  @Get(':deviceId/quality')
  @RequireCapabilities('admin:devices')
  @ApiOkResponse({ description: 'Device freshness, checks, latency and incidents.' })
  quality(@Param('deviceId') deviceId: string) {
    return this.devices.quality(deviceId);
  }

  private requireActor(actor: Actor | undefined): Actor {
    if (!actor) throw new UnauthorizedException('Authentication required.');
    return actor;
  }
}
