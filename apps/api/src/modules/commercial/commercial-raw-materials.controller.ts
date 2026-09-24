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
import { CommercialRawMaterialRiskService } from './commercial-raw-material-risk.service';
import { CommercialBigBagValueService } from './commercial-bigbag-value.service';
import {
  CommercialBigBagValueResponseDto,
  CommercialRawMaterialRiskPageResponseDto,
  CommercialRawMaterialRiskQueryDto,
} from './dto/commercial-raw-material-risk.dto';

@ApiTags('commercial')
@ApiBearerAuth('session')
@ApiUnauthorizedResponse({ description: 'A valid Bearer session is required' })
@ApiForbiddenResponse({ description: 'Raw-material read capability is required' })
@Controller('commercial/raw-materials')
export class CommercialRawMaterialsController {
  constructor(
    private readonly service: CommercialRawMaterialRiskService,
    private readonly bigBags: CommercialBigBagValueService,
  ) {}

  @Get('big-bags')
  @RequireCapabilities('raw_material:read')
  @ApiOkResponse({ type: CommercialBigBagValueResponseDto, isArray: true })
  bigBagValues() {
    return this.bigBags.list();
  }

  @Get()
  @RequireCapabilities('raw_material:read')
  @ApiOkResponse({ type: CommercialRawMaterialRiskPageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid cursor or page limit' })
  list(@CurrentActor() actor: Actor, @Query() query: CommercialRawMaterialRiskQueryDto) {
    return this.service.list(actor, query);
  }
}
