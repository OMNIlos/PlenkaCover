import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  PositionMaterialSelection,
  RecipeCatalogItem,
  RecipeIngredientShare,
} from '@plenka/contracts';
import { AuditService } from '../../common/audit/audit.service';
import type { Actor } from '../../common/auth/actor';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { CreateRecipeCatalogDto } from './dto/create-recipe-catalog.dto';
import {
  assertRecipeIngredients,
  assertRecipeName,
  normalizeCatalogName,
  recipeCreateFingerprintInput,
} from './recipe-catalog.rules';

const recipeVersionSelect = {
  id: true,
  version: true,
  ingredients: {
    orderBy: { sequence: 'asc' },
    select: {
      sequence: true,
      rawMaterialDefinitionId: true,
      shareBasisPoints: true,
      rawMaterialDefinition: { select: { name: true } },
    },
  },
} satisfies Prisma.RecipeDefinitionVersionSelect;

const recipeCatalogSelect = {
  id: true,
  name: true,
  versions: {
    orderBy: { version: 'desc' },
    take: 1,
    select: recipeVersionSelect,
  },
} satisfies Prisma.RecipeDefinitionSelect;

const recipeReplaySelect = {
  id: true,
  name: true,
  requestFingerprint: true,
  versions: {
    where: { version: 1 },
    take: 1,
    select: recipeVersionSelect,
  },
} satisfies Prisma.RecipeDefinitionSelect;

type RecipeRow = Prisma.RecipeDefinitionGetPayload<{ select: typeof recipeCatalogSelect }>;
type ReplayRecipeRow = Prisma.RecipeDefinitionGetPayload<{ select: typeof recipeReplaySelect }>;

type ResolvedIngredient = RecipeIngredientShare & { sequence: number };

export type ResolvedRecipeSelection = {
  baseRawMaterialDefinitionId: string | null;
  recipeDefinitionId: string | null;
  recipeDefinitionVersionId: string | null;
  version: number | null;
  name: string;
  ingredients: RecipeIngredientShare[];
};

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ code, message });
}

function displayName(name: string): string {
  return name.trim().normalize('NFKC');
}

function projectIngredients(
  ingredients: readonly {
    sequence: number;
    rawMaterialDefinitionId: string;
    shareBasisPoints: number;
    rawMaterialDefinition: { name: string };
  }[],
): RecipeIngredientShare[] {
  return [...ingredients]
    .sort((left, right) => left.sequence - right.sequence)
    .map((ingredient) => ({
      rawMaterialDefinitionId: ingredient.rawMaterialDefinitionId,
      name: ingredient.rawMaterialDefinition.name,
      shareBasisPoints: ingredient.shareBasisPoints,
    }));
}

function projectRecipe(row: RecipeRow): RecipeCatalogItem {
  const version = row.versions[0];
  if (!version) {
    throw conflict('RECIPE_VERSION_UNAVAILABLE', 'Recipe has no available version.');
  }

  return {
    id: row.id,
    name: row.name,
    version: {
      id: version.id,
      version: version.version,
      ingredients: projectIngredients(version.ingredients),
    },
  };
}

@Injectable()
export class RecipeCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<RecipeCatalogItem[]> {
    const rows = await this.prisma.recipeDefinition.findMany({
      where: { status: 'active', versions: { some: {} } },
      orderBy: [{ normalizedName: 'asc' }, { id: 'asc' }],
      select: recipeCatalogSelect,
    });

    return rows.map(projectRecipe);
  }

  async create(actor: Actor, dto: CreateRecipeCatalogDto): Promise<RecipeCatalogItem> {
    const actorId = actor.userId;
    if (!actorId) {
      throw new UnauthorizedException({
        code: 'REAL_USER_REQUIRED',
        message: 'A real authenticated user is required to create a recipe.',
      });
    }

    const fingerprint = requestFingerprint(recipeCreateFingerprintInput(actor, dto));
    const replay = await this.findReplay(dto.clientRequestId);
    if (replay) return this.resolveReplay(replay, fingerprint);

    try {
      return await this.prisma.$transaction(async (tx) => {
        this.validateCreate(dto);

        const name = displayName(dto.name);
        const normalizedName = normalizeCatalogName(name);
        const nameOwner = await tx.recipeDefinition.findUnique({
          where: { normalizedName },
          select: { id: true },
        });
        if (nameOwner) {
          throw conflict('RECIPE_NAME_CONFLICT', 'A recipe with this name already exists.');
        }

        const ingredients = await this.resolveCreateIngredients(tx, dto);
        const recipe = await tx.recipeDefinition.create({
          data: {
            name,
            normalizedName,
            status: 'active',
            clientRequestId: dto.clientRequestId,
            requestFingerprint: fingerprint,
            createdById: actorId,
            createdByRole: actor.role,
          },
          select: { id: true, name: true },
        });
        const version = await tx.recipeDefinitionVersion.create({
          data: { recipeDefinitionId: recipe.id, version: 1 },
          select: { id: true, version: true },
        });
        await tx.recipeIngredient.createMany({
          data: ingredients.map((ingredient) => ({
            recipeDefinitionVersionId: version.id,
            rawMaterialDefinitionId: ingredient.rawMaterialDefinitionId,
            sequence: ingredient.sequence,
            shareBasisPoints: ingredient.shareBasisPoints,
          })),
        });
        await this.audit.record(
          {
            type: 'audit:recipe_definition_created',
            actorRole: actor.role,
            actorId,
            objectId: recipe.id,
            label: `Recipe ${recipe.name} created`,
            detail: {
              version: version.version,
              ingredientCount: ingredients.length,
              ingredients: ingredients.map((ingredient) => ({
                rawMaterialDefinitionId: ingredient.rawMaterialDefinitionId,
                name: ingredient.name,
                shareBasisPoints: ingredient.shareBasisPoints,
              })),
            },
          },
          tx,
        );

        return {
          id: recipe.id,
          name: recipe.name,
          version: {
            id: version.id,
            version: version.version,
            ingredients: ingredients.map((ingredient) => ({
              rawMaterialDefinitionId: ingredient.rawMaterialDefinitionId,
              name: ingredient.name,
              shareBasisPoints: ingredient.shareBasisPoints,
            })),
          },
        };
      });
    } catch (error) {
      if (!this.isUniqueConflict(error)) throw error;

      const winner = await this.findReplay(dto.clientRequestId);
      if (winner) return this.resolveReplay(winner, fingerprint);
      throw conflict('RECIPE_CATALOG_CONFLICT', 'The recipe name was allocated concurrently.');
    }
  }

  async resolveSelections(
    tx: Prisma.TransactionClient,
    selectors: readonly PositionMaterialSelection[],
  ): Promise<ResolvedRecipeSelection[]> {
    const baseIds = selectors.flatMap((selector) =>
      typeof selector.baseRawMaterialDefinitionId === 'string'
        ? [selector.baseRawMaterialDefinitionId]
        : [],
    );
    const versionIds = selectors.flatMap((selector) =>
      typeof selector.recipeDefinitionVersionId === 'string'
        ? [selector.recipeDefinitionVersionId]
        : [],
    );

    const materials = await tx.rawMaterialDefinition.findMany({
      where: {
        id: { in: baseIds },
        status: 'active',
        isProductionSelectable: true,
      },
      select: { id: true, name: true },
    });
    const versions = await tx.recipeDefinitionVersion.findMany({
      where: {
        id: { in: versionIds },
        recipeDefinition: { status: 'active' },
      },
      select: {
        id: true,
        version: true,
        recipeDefinition: {
          select: {
            id: true,
            name: true,
            versions: {
              orderBy: { version: 'desc' },
              take: 1,
              select: { id: true, version: true },
            },
          },
        },
        ingredients: {
          orderBy: { sequence: 'asc' },
          select: {
            sequence: true,
            rawMaterialDefinitionId: true,
            shareBasisPoints: true,
            rawMaterialDefinition: { select: { name: true, status: true } },
          },
        },
      },
    });

    const materialById = new Map(materials.map((material) => [material.id, material]));
    const versionById = new Map(versions.map((version) => [version.id, version]));

    return selectors.map((selector) => {
      const hasBase = typeof selector.baseRawMaterialDefinitionId === 'string';
      const hasVersion = typeof selector.recipeDefinitionVersionId === 'string';
      if (Number(hasBase) + Number(hasVersion) !== 1) {
        throw new BadRequestException({
          code: 'INVALID_MATERIAL_SELECTION',
          message: 'A position must select exactly one base material or recipe version.',
        });
      }

      if (hasBase) {
        const material = materialById.get(selector.baseRawMaterialDefinitionId as string);
        if (!material) {
          throw conflict(
            'RAW_MATERIAL_DEFINITION_UNAVAILABLE',
            'The selected base material is unknown or inactive.',
          );
        }
        return {
          baseRawMaterialDefinitionId: material.id,
          recipeDefinitionId: null,
          recipeDefinitionVersionId: null,
          version: null,
          name: material.name,
          ingredients: [
            {
              rawMaterialDefinitionId: material.id,
              name: material.name,
              shareBasisPoints: 10_000,
            },
          ],
        };
      }

      const version = versionById.get(selector.recipeDefinitionVersionId as string);
      if (!version) {
        throw conflict(
          'RECIPE_VERSION_UNAVAILABLE',
          'The selected recipe version is unknown or inactive.',
        );
      }
      if (version.recipeDefinition.versions[0]?.id !== version.id) {
        throw conflict(
          'RECIPE_VERSION_STALE',
          'A newer recipe version is available. Refresh the catalog and select it.',
        );
      }
      if (
        version.ingredients.some(
          (ingredient) => ingredient.rawMaterialDefinition.status !== 'active',
        )
      ) {
        throw conflict(
          'RECIPE_COMPONENT_UNAVAILABLE',
          'The selected recipe contains an inactive material.',
        );
      }

      return {
        baseRawMaterialDefinitionId: null,
        recipeDefinitionId: version.recipeDefinition.id,
        recipeDefinitionVersionId: version.id,
        version: version.version,
        name: version.recipeDefinition.name,
        ingredients: projectIngredients(version.ingredients),
      };
    });
  }

  private validateCreate(dto: CreateRecipeCatalogDto): void {
    try {
      assertRecipeName(dto.name);
      assertRecipeIngredients(dto.ingredients);
    } catch (error) {
      throw new BadRequestException({
        code: 'INVALID_RECIPE_CATALOG_REQUEST',
        message: error instanceof Error ? error.message : 'Invalid recipe catalog request.',
      });
    }
  }

  private async resolveCreateIngredients(
    tx: Prisma.TransactionClient,
    dto: CreateRecipeCatalogDto,
  ): Promise<ResolvedIngredient[]> {
    const resolved: ResolvedIngredient[] = [];

    for (const [index, ingredient] of dto.ingredients.entries()) {
      const material = await tx.rawMaterialDefinition.findUnique({
        where: { id: ingredient.rawMaterialDefinitionId },
        select: { id: true, name: true, status: true, isProductionSelectable: true },
      });
      if (!material || material.status !== 'active' || !material.isProductionSelectable) {
        throw conflict(
          'RAW_MATERIAL_DEFINITION_UNAVAILABLE',
          'A recipe component is unknown, inactive, or unavailable for production.',
        );
      }
      resolved.push({
        sequence: index + 1,
        rawMaterialDefinitionId: material.id,
        name: material.name,
        shareBasisPoints: ingredient.shareBasisPoints,
      });
    }

    return resolved;
  }

  private findReplay(clientRequestId: string): Promise<ReplayRecipeRow | null> {
    return this.prisma.recipeDefinition.findUnique({
      where: { clientRequestId },
      select: recipeReplaySelect,
    });
  }

  private resolveReplay(row: ReplayRecipeRow, fingerprint: string): RecipeCatalogItem {
    if (row.requestFingerprint !== fingerprint) {
      throw conflict(
        'RECIPE_REQUEST_ID_CONFLICT',
        'This clientRequestId was already used for a different recipe request.',
      );
    }
    return projectRecipe(row);
  }

  private isUniqueConflict(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}
