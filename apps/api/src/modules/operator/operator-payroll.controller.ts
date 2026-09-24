import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { DirectorPayrollQueryDto } from '../director/dto/payroll-query.dto';
import { OperatorPayrollPreviewResponseDto } from './dto/operator-payroll-response.dto';
import { OperatorPayrollService } from './operator-payroll.service';

@ApiTags('operator')
@Controller('operator')
export class OperatorPayrollController {
  constructor(private readonly payroll: OperatorPayrollService) {}

  @Get('payroll')
  @RequireCapabilities('operator_payroll:read_self')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: OperatorPayrollPreviewResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid payroll date range' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Operator self-payroll capability is required' })
  self(@CurrentActor() actor: Actor, @Query() query: DirectorPayrollQueryDto) {
    return this.payroll.getSelf(actor, query);
  }
}
