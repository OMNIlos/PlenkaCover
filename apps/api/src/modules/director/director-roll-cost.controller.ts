import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { DirectorPayrollQueryDto } from './dto/payroll-query.dto';
import { DirectorRollCostPreviewResponseDto } from './dto/roll-cost-response.dto';
import { DirectorRollCostService } from './director-roll-cost.service';

@ApiTags('director')
@Controller('director')
export class DirectorRollCostController {
  constructor(private readonly costs: DirectorRollCostService) {}

  @Get('roll-costs')
  @RequireCapabilities('director:read', 'production_cost:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: DirectorRollCostPreviewResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid production cost date range.' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required.' })
  @ApiForbiddenResponse({ description: 'Director read capability is required.' })
  preview(@Query() query: DirectorPayrollQueryDto) {
    return this.costs.getPreview(query);
  }
}
