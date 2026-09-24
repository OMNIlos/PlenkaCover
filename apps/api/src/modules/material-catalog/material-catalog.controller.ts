import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { RawMaterialCatalogItemResponseDto } from './dto/catalog-response.dto';
import { CreateMaterialCatalogItemDto } from './dto/create-material-catalog-item.dto';
import { MaterialCatalogService } from './material-catalog.service';

@ApiTags('material-catalog')
@ApiBearerAuth('session')
@Controller('material-catalog')
export class MaterialCatalogController {
  constructor(private readonly materials: MaterialCatalogService) {}

  @Get()
  @RequireCapabilities('material_catalog:read')
  @ApiOkResponse({
    type: RawMaterialCatalogItemResponseDto,
    isArray: true,
    description: 'Active raw-material definitions in deterministic order.',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    type: String,
    description: 'Case-insensitive material-name search.',
  })
  @ApiUnauthorizedResponse({ description: 'A valid Bearer session is required.' })
  @ApiForbiddenResponse({ description: 'Material-catalog read capability is required.' })
  list(@Query('q') query?: string) {
    return this.materials.list(query);
  }

  @Post()
  @RequireCapabilities('material_catalog:create')
  @ApiCreatedResponse({
    type: RawMaterialCatalogItemResponseDto,
    description: 'Admin-managed raw-material type created and exposed to shared selectors.',
  })
  @ApiBadRequestResponse({ description: 'The material name is empty or too long.' })
  @ApiUnauthorizedResponse({ description: 'A valid Bearer session is required.' })
  @ApiForbiddenResponse({ description: 'Material-catalog create capability is required.' })
  @ApiConflictResponse({ description: 'A material type with the same normalized name exists.' })
  create(@CurrentActor() actor: Actor, @Body() dto: CreateMaterialCatalogItemDto) {
    return this.materials.create({ userId: actor.userId, role: actor.role }, dto);
  }
}
