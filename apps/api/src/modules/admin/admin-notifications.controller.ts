import { Controller, Get, Param, Put, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { RoleInboxQueryDto } from '../../common/role-inbox/dto/role-inbox-query.dto';
import {
  RoleInboxPageResponseDto,
  RoleInboxReadResponseDto,
} from '../../common/role-inbox/dto/role-inbox-response.dto';
import { RoleInboxProjectionService } from '../../common/role-inbox/role-inbox.service';

@ApiTags('admin')
@ApiBearerAuth('session')
@ApiForbiddenResponse({ description: 'Admin platform-health capability is required' })
@Controller('admin/notifications')
export class AdminNotificationsController {
  constructor(private readonly inbox: RoleInboxProjectionService) {}

  @Get()
  @RequireCapabilities('admin:platform_health')
  @ApiOkResponse({ type: RoleInboxPageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid cursor or page limit' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  list(@CurrentActor() actor: Actor, @Query() query: RoleInboxQueryDto) {
    return this.inbox.list(actor, 'admin', query);
  }

  @Put(':eventId/read')
  @RequireCapabilities('admin:platform_health')
  @ApiOkResponse({ type: RoleInboxReadResponseDto })
  @ApiBadRequestResponse({ description: 'Event id is invalid' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiNotFoundResponse({ description: 'Event is not an admin notification' })
  markRead(@CurrentActor() actor: Actor, @Param('eventId') eventId: string) {
    return this.inbox.markRead(actor, 'admin', eventId);
  }
}
