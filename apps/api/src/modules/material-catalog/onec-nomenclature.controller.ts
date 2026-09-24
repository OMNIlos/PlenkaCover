import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { RequireOneCRuntime } from '../../common/auth/require-onec-runtime.decorator';
import { OneCNomenclaturePageResponseDto } from './dto/catalog-response.dto';
import { OneCNomenclatureQueryDto } from './dto/onec-nomenclature-query.dto';
import { OneCNomenclatureService } from './onec-nomenclature.service';

@ApiTags('material-catalog')
@ApiBearerAuth('session')
@RequireOneCRuntime()
@Controller('material-catalog/onec')
export class OneCNomenclatureController {
  constructor(private readonly nomenclature: OneCNomenclatureService) {}

  @Get()
  @RequireCapabilities('material_catalog:read')
  @ApiOkResponse({
    type: OneCNomenclaturePageResponseDto,
    description: 'Paginated safe 1С nomenclature without raw source payload.',
  })
  @ApiUnauthorizedResponse({ description: 'A valid Bearer session is required.' })
  @ApiForbiddenResponse({ description: 'Material-catalog read capability is required.' })
  list(@Query() query: OneCNomenclatureQueryDto) {
    return this.nomenclature.list(query);
  }
}
