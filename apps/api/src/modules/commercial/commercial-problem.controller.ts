import { Controller, Get, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { CommercialProblemQueryDto } from './dto/commercial-problem-query.dto';
import { CommercialProblemPageResponseDto } from './dto/commercial-problem-response.dto';
import { CommercialProblemService } from './commercial-problem.service';

@ApiTags('commercial-problems')
@ApiBearerAuth('session')
@Controller('commercial/problems')
export class CommercialProblemController {
  constructor(private readonly problems: CommercialProblemService) {}

  @Get()
  @RequireCapabilities('order:read')
  @ApiOkResponse({ type: CommercialProblemPageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid filter, cursor, or limit' })
  list(@Query() query: CommercialProblemQueryDto) {
    return this.problems.list(query);
  }
}
