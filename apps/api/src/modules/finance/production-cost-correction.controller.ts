import { Body, Controller, Param, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { RollProductionCostSnapshotService } from '../director/roll-production-cost-snapshot.service';
import {
  CorrectRollProductionCostDto,
  RollProductionCostSnapshotResponseDto,
} from './dto/production-cost-correction.dto';

@ApiTags('finance')
@ApiBearerAuth('session')
@Controller('finance/production-costs')
export class ProductionCostCorrectionController {
  constructor(private readonly snapshots: RollProductionCostSnapshotService) {}

  @Post(':rollDispatchItemId/corrections')
  @RequireCapabilities('production_cost:correct')
  @ApiCreatedResponse({ type: RollProductionCostSnapshotResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid correction command.' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required.' })
  @ApiForbiddenResponse({ description: 'Production cost correction capability is required.' })
  @ApiNotFoundResponse({ description: 'Roll cost snapshot was not found.' })
  @ApiConflictResponse({ description: 'Version, idempotency, or concurrent correction conflict.' })
  correct(
    @CurrentActor() actor: Actor,
    @Param('rollDispatchItemId') rollDispatchItemId: string,
    @Body() dto: CorrectRollProductionCostDto,
  ) {
    return this.snapshots.correct(actor, rollDispatchItemId, dto);
  }
}
