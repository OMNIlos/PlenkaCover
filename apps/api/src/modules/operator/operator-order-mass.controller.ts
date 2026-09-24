import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { OperatorOrderMassResponseDto } from './dto/operator-order-mass-response.dto';
import { OperatorOrderMassService } from './operator-order-mass.service';

@ApiTags('operator')
@Controller('operator/orders')
export class OperatorOrderMassController {
  constructor(private readonly mass: OperatorOrderMassService) {}

  @Get(':orderNumber/mass-summary')
  @RequireCapabilities('operator_task:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: OperatorOrderMassResponseDto })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Operator task read capability is required' })
  @ApiNotFoundResponse({ description: 'Order is not assigned to the current operator' })
  @ApiConflictResponse({ description: 'Order mass source graph is inconsistent' })
  get(@CurrentActor() actor: Actor, @Param('orderNumber') orderNumber: string) {
    return this.mass.getForOrder({ userId: actor.userId }, orderNumber);
  }
}
