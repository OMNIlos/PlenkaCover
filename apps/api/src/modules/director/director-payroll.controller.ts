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
import { DirectorPayrollPreviewResponseDto } from './dto/payroll-response.dto';
import { DirectorPayrollService } from './director-payroll.service';

@ApiTags('director')
@Controller('director')
export class DirectorPayrollController {
  constructor(private readonly payroll: DirectorPayrollService) {}

  @Get('payroll-preview')
  @RequireCapabilities('director:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: DirectorPayrollPreviewResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid payroll preview date range' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Director read capability is required' })
  preview(@Query() query: DirectorPayrollQueryDto) {
    return this.payroll.getPreview(query);
  }
}
