export type RawMaterialCatalogItem = {
  id: string;
  name: string;
  kind: 'base' | 'custom';
};

export type RecipeIngredientShare = {
  rawMaterialDefinitionId: string;
  name: string;
  shareBasisPoints: number;
};

export type RecipeCatalogItem = {
  id: string;
  name: string;
  version: {
    id: string;
    version: number;
    ingredients: RecipeIngredientShare[];
  };
};

export type PositionMaterialSelection =
  | { baseRawMaterialDefinitionId: string; recipeDefinitionVersionId?: never }
  | { recipeDefinitionVersionId: string; baseRawMaterialDefinitionId?: never };
