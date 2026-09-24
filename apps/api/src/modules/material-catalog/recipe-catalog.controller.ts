import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { RecipeCatalogItemResponseDto } from './dto/catalog-response.dto';
import { CreateRecipeCatalogDto } from './dto/create-recipe-catalog.dto';
import { RecipeCatalogService } from './recipe-catalog.service';

@ApiTags('recipe-catalog')
@ApiBearerAuth('session')
@Controller('recipe-catalog')
export class RecipeCatalogController {
  constructor(private readonly recipes: RecipeCatalogService) {}

  @Get()
  @RequireCapabilities('material_catalog:read')
  @ApiOkResponse({
    type: RecipeCatalogItemResponseDto,
    isArray: true,
    description: 'Active recipes with their current immutable version.',
  })
  @ApiUnauthorizedResponse({ description: 'A valid Bearer session is required.' })
  @ApiForbiddenResponse({ description: 'Material-catalog read capability is required.' })
  list() {
    return this.recipes.list();
  }

  @Post()
  @RequireCapabilities('recipe_catalog:create')
  @ApiCreatedResponse({
    type: RecipeCatalogItemResponseDto,
    description: 'Recipe created or an exact idempotent replay returned.',
  })
  @ApiBadRequestResponse({ description: 'The recipe name or composition is invalid.' })
  @ApiUnauthorizedResponse({ description: 'A real authenticated user is required.' })
  @ApiForbiddenResponse({ description: 'Recipe-catalog create capability is required.' })
  @ApiConflictResponse({
    description: 'Request id, name, component, or concurrent catalog conflict.',
  })
  create(@CurrentActor() actor: Actor, @Body() dto: CreateRecipeCatalogDto) {
    return this.recipes.create(actor, dto);
  }
}
