import { ROLE_CAPABILITIES, type Capability } from '@plenka/contracts';
import { Reflector } from '@nestjs/core';
import { DECORATORS } from '@nestjs/swagger';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import { MaterialCatalogController } from './material-catalog.controller';
import { OneCNomenclatureController } from './onec-nomenclature.controller';
import { RecipeCatalogController } from './recipe-catalog.controller';

type SwaggerResponse = {
  type?: { name: string; prototype: object };
  isArray?: boolean;
};

function responseMetadata(handler: (...args: never[]) => unknown, status: number): SwaggerResponse {
  return Reflect.getMetadata(DECORATORS.API_RESPONSE, handler)?.[status] ?? {};
}

function decoratedFields(type: SwaggerResponse['type']): string[] {
  if (!type) return [];
  return (Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES_ARRAY, type.prototype) ?? []).map(
    (field: string) => field.slice(1),
  );
}

function decoratedField(type: SwaggerResponse['type'], field: string) {
  if (!type) return undefined;
  return Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES, type.prototype, field);
}

it.each(['commercial', 'warehouse', 'production_lead'] as const)(
  '%s can read the material catalog',
  (role) => {
    expect(ROLE_CAPABILITIES[role]).toContain('material_catalog:read');
  },
);

it.each(['commercial', 'production_lead'] as const)('%s can create recipes', (role) => {
  expect(ROLE_CAPABILITIES[role]).toContain('recipe_catalog:create');
});

it('warehouse cannot create recipes', () => {
  expect(ROLE_CAPABILITIES.warehouse).not.toContain('recipe_catalog:create');
});

it.each(['operator', 'finance', 'director'] as const)('%s has no catalog capability', (role) => {
  expect(ROLE_CAPABILITIES[role]).not.toContain('material_catalog:read');
  expect(ROLE_CAPABILITIES[role]).not.toContain('recipe_catalog:create');
});

it('admin can read and create material types but cannot create recipes', () => {
  expect(ROLE_CAPABILITIES.admin).toContain('material_catalog:read');
  expect(ROLE_CAPABILITIES.admin).toContain('material_catalog:create');
  expect(ROLE_CAPABILITIES.admin).not.toContain('recipe_catalog:create');
});

it('does not broaden unrelated warehouse or commercial mutations', () => {
  expect(ROLE_CAPABILITIES.warehouse).not.toContain('order:update_position');
  expect(ROLE_CAPABILITIES.commercial).not.toContain('raw_material:adjust');
});

describe('catalog route contract', () => {
  const reflector = new Reflector();
  const materialList = MaterialCatalogController.prototype.list;
  const materialCreate = MaterialCatalogController.prototype.create;
  const oneCList = OneCNomenclatureController.prototype.list;
  const recipeList = RecipeCatalogController.prototype.list;
  const recipeCreate = RecipeCatalogController.prototype.create;

  it.each([materialList, oneCList, recipeList])(
    'gates list routes with material_catalog:read',
    (handler) => {
      expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([
        'material_catalog:read',
      ]);
      expect(Object.keys(Reflect.getMetadata(DECORATORS.API_RESPONSE, handler) ?? {})).toEqual(
        expect.arrayContaining(['200', '401', '403']),
      );
    },
  );

  it('documents the material list with the exact safe array response type', () => {
    const response = responseMetadata(materialList, 200);

    expect(response).toMatchObject({
      type: expect.any(Function),
      isArray: true,
    });
    expect(response.type?.name).toBe('RawMaterialCatalogItemResponseDto');
    expect(decoratedFields(response.type)).toEqual(['id', 'name', 'kind']);
  });

  it('gates material creation with the admin material-catalog capability', () => {
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, materialCreate)).toEqual([
      'material_catalog:create',
    ]);
    expect(Object.keys(Reflect.getMetadata(DECORATORS.API_RESPONSE, materialCreate) ?? {})).toEqual(
      expect.arrayContaining(['201', '400', '401', '403', '409']),
    );
  });

  it('documents recipe list/create with the exact nested safe response type', () => {
    const listResponse = responseMetadata(recipeList, 200);
    const createResponse = responseMetadata(recipeCreate, 201);

    expect(listResponse).toMatchObject({
      type: expect.any(Function),
      isArray: true,
    });
    expect(createResponse).toMatchObject({
      type: listResponse.type,
      isArray: false,
    });
    expect(listResponse.type?.name).toBe('RecipeCatalogItemResponseDto');
    expect(decoratedFields(listResponse.type)).toEqual(['id', 'name', 'version']);

    const versionType = decoratedField(listResponse.type, 'version')?.type;
    expect(versionType?.name).toBe('RecipeCatalogVersionResponseDto');
    expect(decoratedFields(versionType)).toEqual(['id', 'version', 'ingredients']);

    const ingredients = decoratedField(versionType, 'ingredients');
    expect(ingredients).toMatchObject({ isArray: true });
    expect(ingredients.type?.name).toBe('RecipeIngredientShareResponseDto');
    expect(decoratedFields(ingredients.type)).toEqual([
      'rawMaterialDefinitionId',
      'name',
      'shareBasisPoints',
    ]);
  });

  it('documents the generic 1C catalog with an exact raw-free allowlist', () => {
    const response = responseMetadata(oneCList, 200);

    expect(response.type?.name).toBe('OneCNomenclaturePageResponseDto');
    expect(decoratedFields(response.type)).toEqual(['items', 'page', 'pageSize', 'total']);
    const items = decoratedField(response.type, 'items');
    expect(items).toMatchObject({ isArray: true });
    expect(items.type?.name).toBe('OneCNomenclatureListItemResponseDto');
    expect(decoratedFields(items.type)).toEqual([
      'externalId',
      'code',
      'article',
      'name',
      'kindName',
      'unitName',
      'archived',
    ]);
  });

  it('gates recipe creation and documents validation, auth, and conflict responses', () => {
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, recipeCreate)).toEqual([
      'recipe_catalog:create',
    ]);
    expect(Object.keys(Reflect.getMetadata(DECORATORS.API_RESPONSE, recipeCreate) ?? {})).toEqual(
      expect.arrayContaining(['201', '400', '401', '403', '409']),
    );
  });
});
