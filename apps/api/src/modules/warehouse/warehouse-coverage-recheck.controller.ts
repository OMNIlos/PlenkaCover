import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { WarehouseCoverageRecheckService } from '../warehouse-coverage/warehouse-coverage-recheck.service';
import { ResolveWarehouseCoverageRecheckDto } from './dto/warehouse-coverage-recheck.dto';

@ApiTags('warehouse', 'warehouse-coverage')
@ApiBearerAuth('session')
@Controller('warehouse/warehouse-coverage/rechecks')
export class WarehouseCoverageRecheckController {
  constructor(private readonly rechecks: WarehouseCoverageRecheckService) {}

  @Get()
  @RequireCapabilities('warehouse_task:read')
  @ApiOkResponse({ description: 'Open V2 warehouse-coverage recheck queue.' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required.' })
  @ApiForbiddenResponse({ description: 'Warehouse task read capability is required.' })
  list(@CurrentActor() actor: Actor) {
    return this.rechecks.listForWarehouse(actor);
  }

  @Post(':caseId/resolve')
  @HttpCode(HttpStatus.OK)
  @RequireCapabilities('warehouse_coverage:resolve_recheck')
  @ApiOkResponse({ description: 'Fresh protected warehouse-coverage projection.' })
  @ApiBadRequestResponse({ description: 'The correction command is malformed.' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required.' })
  @ApiForbiddenResponse({ description: 'Coverage recheck resolution capability is required.' })
  @ApiConflictResponse({ description: 'The case or coverage snapshot changed concurrently.' })
  resolve(
    @CurrentActor() actor: Actor,
    @Param('caseId') caseId: string,
    @Body() dto: ResolveWarehouseCoverageRecheckDto,
  ) {
    return this.rechecks.resolveFromWarehouse(actor, caseId, dto);
  }
}
