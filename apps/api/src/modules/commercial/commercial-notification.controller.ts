import { Controller, Get, Param, Put, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
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

@ApiTags('commercial')
@ApiBearerAuth('session')
@ApiForbiddenResponse({ description: 'Commercial notification capability is required' })
@Controller('commercial/notifications')
export class CommercialNotificationController {
  constructor(private readonly inbox: RoleInboxProjectionService) {}

  @Get()
  @RequireCapabilities('commercial_notification:read')
  @ApiOkResponse({ type: RoleInboxPageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid cursor or page limit' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  list(@CurrentActor() actor: Actor, @Query() query: RoleInboxQueryDto) {
    return this.inbox.list(actor, 'commercial', query);
  }

  @Put(':eventId/read')
  @RequireCapabilities('commercial_notification:read')
  @ApiOkResponse({ type: RoleInboxReadResponseDto })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiNotFoundResponse({ description: 'Event is not a commercial notification' })
  @ApiBadRequestResponse({ description: 'Event id is invalid' })
  markRead(@CurrentActor() actor: Actor, @Param('eventId') eventId: string) {
    return this.inbox.markRead(actor, 'commercial', eventId);
  }
}
