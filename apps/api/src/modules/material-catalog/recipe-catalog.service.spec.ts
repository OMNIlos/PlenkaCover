import { Prisma } from '@prisma/client';
import type { Actor } from '../../common/auth/actor';
import { AuditService } from '../../common/audit/audit.service';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import type { CreateRecipeCatalogDto } from './dto/create-recipe-catalog.dto';
import { recipeCreateFingerprintInput } from './recipe-catalog.rules';
import { RecipeCatalogService } from './recipe-catalog.service';

const actor: Actor = {
  userId: 'user-1',
  role: 'commercial',
  capabilities: ['material_catalog:read', 'recipe_catalog:create'],
};

const command: CreateRecipeCatalogDto = {
  clientRequestId: '123e4567-e89b-42d3-a456-426614174000',
  name: 'Синяя смесь',
  ingredients: [
    { rawMaterialDefinitionId: 'material-custom', shareBasisPoints: 2_000 },
    { rawMaterialDefinitionId: 'material-base', shareBasisPoints: 8_000 },
  ],
};

function storedRecipe(fingerprint: string) {
  return {
    id: 'recipe-1',
    name: 'Синяя смесь',
    normalizedName: 'синяя смесь',
    requestFingerprint: fingerprint,
    createdById: 'hidden-user',
    versions: [
      {
        id: 'version-1',
        version: 1,
        ingredients: [
          {
            id: 'ingredient-1',
            sequence: 0,
            rawMaterialDefinitionId: 'material-custom',
            shareBasisPoints: 2_000,
            rawMaterialDefinition: {
              id: 'material-custom',
              name: 'Синий краситель',
              status: 'active',
              stock: { quantityKg: 0, rawPayload: { secret: true } },
            },
          },
          {
            id: 'ingredient-2',
            sequence: 1,
            rawMaterialDefinitionId: 'material-base',
            shareBasisPoints: 8_000,
            rawMaterialDefinition: {
              id: 'material-base',
              name: 'Первичное',
              status: 'active',
            },
          },
        ],
      },
    ],
  };
}

function successfulCreateHarness() {
  let existing: ReturnType<typeof storedRecipe> | null = null;
  const tx = {
    rawMaterialDefinition: {
      findUnique: jest.fn().mockImplementation(({ where }) => {
        if (where.id === 'material-base' || where.id === 'material-custom') {
          return Promise.resolve({
            id: where.id,
            name: where.id === 'material-base' ? 'Первичное' : 'Синий краситель',
            kind: where.id === 'material-base' ? 'base' : 'custom',
            status: 'active',
            isProductionSelectable: true,
          });
        }
        return Promise.resolve(null);
      }),
      create: jest.fn().mockResolvedValue({
        id: 'material-custom',
        name: 'Синий краситель',
        kind: 'custom',
        status: 'active',
      }),
    },
    recipeDefinition: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'recipe-1', name: 'Синяя смесь' }),
    },
    recipeDefinitionVersion: {
      create: jest.fn().mockResolvedValue({ id: 'version-1', version: 1 }),
    },
    recipeIngredient: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
    domainEvent: { create: jest.fn().mockImplementation(({ data }) => Promise.resolve(data)) },
  };
  const prisma = {
    recipeDefinition: {
      findUnique: jest.fn().mockImplementation(() => Promise.resolve(existing)),
      findMany: jest.fn(),
    },
    domainEvent: { create: jest.fn() },
    $transaction: jest.fn().mockImplementation(async (work) => {
      const result = await work(tx);
      const fingerprint = tx.recipeDefinition.create.mock.calls[0][0].data.requestFingerprint;
      existing = storedRecipe(fingerprint);
      return result;
    }),
  };
  return {
    prisma,
    tx,
    service: new RecipeCatalogService(prisma as never, new AuditService(prisma as never)),
  };
}

describe('RecipeCatalogService', () => {
  it('projects only active recipes, the highest version, and ordered safe ingredients', async () => {
    const prisma = {
      recipeDefinition: {
        findMany: jest.fn().mockResolvedValue([
          {
            ...storedRecipe('hidden'),
            versions: [
              {
                id: 'version-2',
                version: 2,
                ingredients: [...storedRecipe('hidden').versions[0].ingredients].reverse(),
              },
            ],
          },
        ]),
      },
    };
    const service = new RecipeCatalogService(prisma as never, {} as never);

    await expect(service.list()).resolves.toEqual([
      {
        id: 'recipe-1',
        name: 'Синяя смесь',
        version: {
          id: 'version-2',
          version: 2,
          ingredients: [
            {
              rawMaterialDefinitionId: 'material-custom',
              name: 'Синий краситель',
              shareBasisPoints: 2_000,
            },
            {
              rawMaterialDefinitionId: 'material-base',
              name: 'Первичное',
              shareBasisPoints: 8_000,
            },
          ],
        },
      },
    ]);
    expect(prisma.recipeDefinition.findMany).toHaveBeenCalledWith({
      where: { status: 'active', versions: { some: {} } },
      orderBy: [{ normalizedName: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        versions: {
          orderBy: { version: 'desc' },
          take: 1,
          select: {
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
          },
        },
      },
    });
  });

  it('returns identical ids on exact replay without appending events', async () => {
    const { service, prisma, tx } = successfulCreateHarness();

    const first = await service.create(actor, command);
    const replay = await service.create(actor, command);

    expect(replay).toEqual(first);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.domainEvent.create).toHaveBeenCalledTimes(1);
    expect(tx.rawMaterialDefinition.create).not.toHaveBeenCalled();
    expect(prisma.domainEvent.create).not.toHaveBeenCalled();
  });

  it('replays the originally created version after newer immutable versions exist', async () => {
    const fingerprint = requestFingerprint(recipeCreateFingerprintInput(actor, command));
    const original = storedRecipe(fingerprint);
    const originalVersion = original.versions[0];
    const newerVersion = { ...originalVersion, id: 'version-2', version: 2 };
    const prisma = {
      recipeDefinition: {
        findUnique: jest.fn().mockImplementation(({ select }) =>
          Promise.resolve({
            ...original,
            versions:
              select.versions.where?.version === 1
                ? [originalVersion]
                : [newerVersion, originalVersion],
          }),
        ),
      },
      $transaction: jest.fn(),
    };
    const service = new RecipeCatalogService(prisma as never, {} as never);

    await expect(service.create(actor, command)).resolves.toMatchObject({
      id: 'recipe-1',
      version: { id: 'version-1', version: 1 },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a divergent replay with 409', async () => {
    const { service } = successfulCreateHarness();
    await service.create(actor, command);

    await expect(
      service.create(actor, { ...command, name: 'Другой состав' }),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'RECIPE_REQUEST_ID_CONFLICT' }),
    });
  });

  it.each([
    ['unknown', null],
    [
      'inactive',
      {
        id: 'material-base',
        name: 'Первичное',
        kind: 'base',
        status: 'archived',
        isProductionSelectable: true,
      },
    ],
  ])('rejects an %s existing component with 409', async (_label, component) => {
    const tx = {
      recipeDefinition: { findUnique: jest.fn().mockResolvedValue(null) },
      rawMaterialDefinition: { findUnique: jest.fn().mockResolvedValue(component) },
    };
    const prisma = {
      recipeDefinition: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn().mockImplementation((work) => work(tx)),
    };
    const service = new RecipeCatalogService(prisma as never, {} as never);
    const existingOnly = {
      ...command,
      ingredients: [{ rawMaterialDefinitionId: 'material-base', shareBasisPoints: 10_000 }],
    };

    await expect(service.create(actor, existingOnly)).rejects.toMatchObject({ status: 409 });
  });

  it('rejects a case-insensitive recipe-name conflict with 409', async () => {
    const tx = {
      recipeDefinition: {
        findUnique: jest.fn().mockResolvedValue({ id: 'other-recipe', name: 'сИНЯЯ СМЕСЬ' }),
      },
    };
    const prisma = {
      recipeDefinition: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn().mockImplementation((work) => work(tx)),
    };
    const service = new RecipeCatalogService(prisma as never, {} as never);

    await expect(service.create(actor, command)).rejects.toMatchObject({ status: 409 });
  });

  it('never creates a product while creating a recipe', async () => {
    const { service, tx } = successfulCreateHarness();

    await service.create(actor, command);

    expect(tx.rawMaterialDefinition.create).not.toHaveBeenCalled();
  });

  it('reads the committed winner after a P2002 request-id race', async () => {
    const fingerprint = requestFingerprint(recipeCreateFingerprintInput(actor, command));
    const winner = storedRecipe(fingerprint);
    const prisma = {
      recipeDefinition: {
        findUnique: jest.fn().mockResolvedValueOnce(null).mockResolvedValue(winner),
      },
      $transaction: jest.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique race', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      ),
    };
    const service = new RecipeCatalogService(prisma as never, {} as never);

    await expect(service.create(actor, command)).resolves.toMatchObject({
      id: 'recipe-1',
      version: { id: 'version-1' },
    });
  });

  it('rejects a divergent committed winner after a P2002 request-id race', async () => {
    const winner = storedRecipe(requestFingerprint({ different: true }));
    const prisma = {
      recipeDefinition: {
        findUnique: jest.fn().mockResolvedValueOnce(null).mockResolvedValue(winner),
      },
      $transaction: jest.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique race', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      ),
    };
    const service = new RecipeCatalogService(prisma as never, {} as never);

    await expect(service.create(actor, command)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'RECIPE_REQUEST_ID_CONFLICT' }),
    });
  });

  it('maps a P2002 without a request-id winner to RECIPE_CATALOG_CONFLICT', async () => {
    const prisma = {
      recipeDefinition: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique race', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      ),
    };
    const service = new RecipeCatalogService(prisma as never, {} as never);

    await expect(service.create(actor, command)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'RECIPE_CATALOG_CONFLICT' }),
    });
    expect(prisma.recipeDefinition.findUnique).toHaveBeenCalledTimes(2);
  });

  it('requires a real user identity for creation', async () => {
    const prisma = { $transaction: jest.fn() };
    const service = new RecipeCatalogService(prisma as never, {} as never);

    await expect(service.create({ ...actor, userId: null }, command)).rejects.toMatchObject({
      status: 401,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('resolves active selections in input order from server-authored composition', async () => {
    const tx = {
      rawMaterialDefinition: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'material-base', name: 'Первичное', kind: 'base', status: 'active' },
          ]),
      },
      recipeDefinitionVersion: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'version-1',
            version: 1,
            recipeDefinition: {
              id: 'recipe-1',
              name: 'Синяя смесь',
              status: 'active',
              versions: [{ id: 'version-1', version: 1 }],
            },
            ingredients: [...storedRecipe('hidden').versions[0].ingredients].reverse(),
          },
        ]),
      },
    };
    const service = new RecipeCatalogService({} as never, {} as never);

    await expect(
      service.resolveSelections(tx as never, [
        { recipeDefinitionVersionId: 'version-1' },
        { baseRawMaterialDefinitionId: 'material-base' },
      ]),
    ).resolves.toEqual([
      {
        baseRawMaterialDefinitionId: null,
        recipeDefinitionId: 'recipe-1',
        recipeDefinitionVersionId: 'version-1',
        version: 1,
        name: 'Синяя смесь',
        ingredients: [
          {
            rawMaterialDefinitionId: 'material-custom',
            name: 'Синий краситель',
            shareBasisPoints: 2_000,
          },
          {
            rawMaterialDefinitionId: 'material-base',
            name: 'Первичное',
            shareBasisPoints: 8_000,
          },
        ],
      },
      {
        baseRawMaterialDefinitionId: 'material-base',
        recipeDefinitionId: null,
        recipeDefinitionVersionId: null,
        version: null,
        name: 'Первичное',
        ingredients: [
          {
            rawMaterialDefinitionId: 'material-base',
            name: 'Первичное',
            shareBasisPoints: 10_000,
          },
        ],
      },
    ]);
  });

  it('rejects a selected recipe version when a higher immutable version exists', async () => {
    const selectedVersion = storedRecipe('hidden').versions[0];
    const findMany = jest.fn().mockResolvedValue([
      {
        ...selectedVersion,
        recipeDefinition: {
          id: 'recipe-1',
          name: 'Синяя смесь',
          status: 'active',
          versions: [{ id: 'version-2', version: 2 }],
        },
      },
    ]);
    const tx = {
      rawMaterialDefinition: { findMany: jest.fn().mockResolvedValue([]) },
      recipeDefinitionVersion: { findMany },
    };
    const service = new RecipeCatalogService({} as never, {} as never);

    await expect(
      service.resolveSelections(tx as never, [{ recipeDefinitionVersionId: 'version-1' }]),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'RECIPE_VERSION_STALE' }),
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          recipeDefinition: {
            select: expect.objectContaining({
              versions: {
                orderBy: { version: 'desc' },
                take: 1,
                select: { id: true, version: true },
              },
            }),
          },
        }),
      }),
    );
  });

  it('rejects a selected version whose component became inactive', async () => {
    const recipe = storedRecipe('hidden').versions[0];
    recipe.ingredients[0].rawMaterialDefinition.status = 'archived';
    const tx = {
      rawMaterialDefinition: { findMany: jest.fn().mockResolvedValue([]) },
      recipeDefinitionVersion: {
        findMany: jest.fn().mockResolvedValue([
          {
            ...recipe,
            recipeDefinition: {
              id: 'recipe-1',
              name: 'Синяя смесь',
              status: 'active',
              versions: [{ id: 'version-1', version: 1 }],
            },
          },
        ]),
      },
    };
    const service = new RecipeCatalogService({} as never, {} as never);

    await expect(
      service.resolveSelections(tx as never, [{ recipeDefinitionVersionId: 'version-1' }]),
    ).rejects.toMatchObject({ status: 409 });
  });
});
