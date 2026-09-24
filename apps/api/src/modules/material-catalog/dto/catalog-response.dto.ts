import { ApiProperty } from '@nestjs/swagger';
import type {
  OneCNomenclatureListItem,
  RawMaterialCatalogItem,
  RecipeCatalogItem,
  RecipeIngredientShare,
} from '@plenka/contracts';
import type { OneCNomenclaturePage } from '../onec-nomenclature.service';

type RecipeCatalogVersion = RecipeCatalogItem['version'];

export class RawMaterialCatalogItemResponseDto implements RawMaterialCatalogItem {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: ['base', 'custom'] })
  kind!: RawMaterialCatalogItem['kind'];
}

export class OneCNomenclatureListItemResponseDto implements OneCNomenclatureListItem {
  @ApiProperty()
  externalId!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty({ nullable: true, type: String })
  article!: string | null;

  @ApiProperty()
  name!: string;

  @ApiProperty({ nullable: true, type: String })
  kindName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  unitName!: string | null;

  @ApiProperty()
  archived!: boolean;
}

export class OneCNomenclaturePageResponseDto implements OneCNomenclaturePage {
  @ApiProperty({ type: OneCNomenclatureListItemResponseDto, isArray: true })
  items!: OneCNomenclatureListItem[];

  @ApiProperty({ minimum: 1 })
  page!: number;

  @ApiProperty({ minimum: 1, maximum: 100 })
  pageSize!: number;

  @ApiProperty({ minimum: 0 })
  total!: number;
}

export class RecipeIngredientShareResponseDto implements RecipeIngredientShare {
  @ApiProperty()
  rawMaterialDefinitionId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ minimum: 1, maximum: 10_000 })
  shareBasisPoints!: number;
}

export class RecipeCatalogVersionResponseDto implements RecipeCatalogVersion {
  @ApiProperty()
  id!: string;

  @ApiProperty({ minimum: 1 })
  version!: number;

  @ApiProperty({ type: RecipeIngredientShareResponseDto, isArray: true })
  ingredients!: RecipeIngredientShareResponseDto[];
}

export class RecipeCatalogItemResponseDto implements RecipeCatalogItem {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: RecipeCatalogVersionResponseDto })
  version!: RecipeCatalogVersionResponseDto;
}
