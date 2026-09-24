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
import { ProductionService } from '../production/production.service';
import { BusinessOperationalProblemResolutionDto } from './dto/business-operational-problem-resolution.dto';

@ApiTags('commercial-performance')
@ApiBearerAuth('session')
@Controller('commercial/performance/problems')
export class BusinessOperationalProblemOverrideController {
  constructor(private readonly production: ProductionService) {}

  @Post(':problemId/resolve')
  @RequireCapabilities('override:production')
  @ApiCreatedResponse({
    description:
      'Директор применил решение по браку; доменная операция и физическое доказательство проверены.',
  })
  @ApiBadRequestResponse({ description: 'Invalid resolution or required note.' })
  @ApiUnauthorizedResponse({ description: 'A valid Bearer session is required.' })
  @ApiForbiddenResponse({ description: 'Production override capability is required.' })
  @ApiNotFoundResponse({ description: 'Production problem was not found.' })
  @ApiConflictResponse({
    description: 'Problem is already resolved or physical defect evidence is incomplete.',
  })
  resolveProblem(
    @CurrentActor() actor: Actor,
    @Param('problemId') problemId: string,
    @Body() dto: BusinessOperationalProblemResolutionDto,
  ) {
    return this.production.resolveProblem(
      { userId: actor.userId, role: actor.role },
      problemId,
      dto,
    );
  }
}
