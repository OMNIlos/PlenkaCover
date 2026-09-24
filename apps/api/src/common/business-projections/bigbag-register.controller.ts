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
import { BigBagRegisterProjectionService } from './bigbag-register-projection.service';
import { BigBagRegisterPageResponseDto, BigBagRegisterQueryDto } from './dto/bigbag-register.dto';

@ApiTags('raw-materials')
@ApiBearerAuth('session')
@Controller('raw-materials')
export class BigBagRegisterController {
  constructor(private readonly projection: BigBagRegisterProjectionService) {}

  @Get('big-bags')
  @RequireCapabilities('raw_material:read')
  @ApiOkResponse({ type: BigBagRegisterPageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid search, page, or page size.' })
  @ApiUnauthorizedResponse({ description: 'A valid Bearer session is required.' })
  @ApiForbiddenResponse({ description: 'Raw-material read capability is required.' })
  list(@Query() query: BigBagRegisterQueryDto) {
    return this.projection.list(query);
  }
}
