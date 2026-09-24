import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RequireCapabilities } from '../auth/require-capabilities.decorator';
import { PenaltySnapshotQueryDto, PenaltySnapshotResponseDto } from './dto/penalty-snapshot.dto';
import { PenaltySnapshotService } from './penalty-snapshot.service';

@ApiTags('penalties')
@ApiBearerAuth('session')
@Controller('penalties')
export class PenaltySnapshotController {
  constructor(private readonly service: PenaltySnapshotService) {}

  @Get('snapshot')
  @RequireCapabilities('penalty:read')
  @ApiOkResponse({ type: PenaltySnapshotResponseDto })
  @ApiBadRequestResponse({ description: 'Некорректный фильтр штрафов.' })
  @ApiUnauthorizedResponse({ description: 'Требуется действующая сессия.' })
  @ApiForbiddenResponse({ description: 'Нет права на чтение штрафов.' })
  snapshot(@Query() query: PenaltySnapshotQueryDto) {
    return this.service.read(query);
  }
}
