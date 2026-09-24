import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StockProductionTemplateService } from './stock-production-template.service';

describe('StockProductionTemplateService', () => {
  const actor = { userId: 'lead-1', role: 'production_lead' as const };
  const positions = [
    {
      rollCount: 3,
      filmType: 'Рукав',
      actualThickness: '80 мкм',
      accountingThickness: '78 мкм',
      baseRawMaterialDefinitionId: 'rmd-primary',
      spoolType: 'Шпуля 76 мм',
      birka: 'ГОСТ',
      comment: 'Первая позиция',
      plannedWeightKg: 40,
      recipeParameters: [{ label: 'Цвет', value: 'Прозрачный' }],
    },
    {
      rollCount: 2,
      filmType: 'Полурукав',
      actualThickness: '60 мкм',
      accountingThickness: '58 мкм',
      recipeDefinitionVersionId: 'recipe-version-2',
      plannedWeightKg: 25,
      recipeParameters: [{ label: 'Краситель', value: 'Синий' }],
    },
  ];
  const dto = {
    name: '  Производственный комплект  ',
    description: '  Две позиции  ',
    positions,
  };

  function template(overrides: Record<string, unknown> = {}) {
    return {
      id: 'template-1',
      name: 'Производственный комплект',
      description: 'Две позиции',
      status: 'active',
      positions,
      usageCount: 0,
      lastUsedAt: null,
      createdById: 'lead-1',
      createdAt: new Date('2026-07-27T12:00:00.000Z'),
      updatedAt: new Date('2026-07-27T12:00:00.000Z'),
      version: 1,
      ...overrides,
    };
  }

  it('creates the active template and immutable v1 in one transaction', async () => {
    const createdRow = template();
    const versionRow = {
      id: 'template-version-1',
      templateId: createdRow.id,
      version: 1,
      positions,
      createdById: actor.userId,
      createdAt: new Date('2026-07-27T12:00:00.000Z'),
    };
    const tx = {
      stockProductionTemplate: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(createdRow),
      },
      stockProductionTemplateVersion: {
        create: jest.fn().mockResolvedValue(versionRow),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const audit = { record: jest.fn() };
    const service = new StockProductionTemplateService(prisma as never, audit as never);

    const created = await service.create(actor, {
      ...dto,
      positions: [
        {
          ...positions[0],
          internalOnly: 'must-not-be-snapshotted',
        },
        positions[1],
      ],
    } as never);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.stockProductionTemplate.create).toHaveBeenCalledWith({
      data: {
        name: 'Производственный комплект',
        normalizedName: 'производственный комплект',
        description: 'Две позиции',
        status: 'active',
        positions,
        createdById: actor.userId,
        version: 1,
      },
    });
    expect(tx.stockProductionTemplateVersion.create).toHaveBeenCalledWith({
      data: {
        templateId: created.id,
        version: 1,
        positions,
        createdById: actor.userId,
      },
    });
    expect(created).toMatchObject({
      id: 'template-1',
      version: 1,
      positions,
      versions: [{ id: 'template-version-1', version: 1, positions }],
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:stock_production_template_created',
        actorRole: 'production_lead',
        actorId: 'lead-1',
        objectId: 'template-1',
        detail: { positionCount: 2, version: 1 },
      }),
      tx,
    );
  });

  it('preserves roll dimensions and the manual label in current and version snapshots', async () => {
    const position = {
      rollCount: 2,
      filmType: 'Рукав',
      actualThickness: '80 мкм',
      accountingThickness: '78 мкм',
      widthMm: 1700,
      plannedLengthM: 275,
      manualBirka: 'Маркировка А-17',
      baseRawMaterialDefinitionId: 'rmd-primary',
      recipeParameters: [],
    };
    const createdRow = template({
      id: 'template-dimensions',
      positions: [position],
    });
    const versionRow = {
      id: 'template-version-dimensions',
      templateId: createdRow.id,
      version: 1,
      positions: [position],
      createdById: actor.userId,
      createdAt: new Date('2026-07-27T12:00:00.000Z'),
    };
    const tx = {
      stockProductionTemplate: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(createdRow),
      },
      stockProductionTemplateVersion: {
        create: jest.fn().mockResolvedValue(versionRow),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const service = new StockProductionTemplateService(
      prisma as never,
      { record: jest.fn() } as never,
    );

    const result = await service.create(actor, {
      name: 'Рукав 80 · 1700 × 275',
      positions: [position],
    } as never);

    const expectedPosition = expect.objectContaining({
      widthMm: 1700,
      plannedLengthM: 275,
      manualBirka: 'Маркировка А-17',
    });
    expect(tx.stockProductionTemplate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ positions: [expectedPosition] }),
    });
    expect(tx.stockProductionTemplateVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ positions: [expectedPosition] }),
    });
    expect(result.positions[0]).toEqual(expectedPosition);
    expect(result.versions[0]?.positions[0]).toEqual(expectedPosition);
  });

  it('rejects a normalized duplicate name before creating another template', async () => {
    const tx = {
      stockProductionTemplate: {
        findUnique: jest.fn().mockResolvedValue({ id: 'template-existing' }),
        create: jest.fn(),
      },
      stockProductionTemplateVersion: { create: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const service = new StockProductionTemplateService(
      prisma as never,
      { record: jest.fn() } as never,
    );

    await expect(
      service.create(actor, {
        ...dto,
        name: '  ＰＲＯＤＵＣＴＩＯＮ 80  ',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.stockProductionTemplate.findUnique).toHaveBeenCalledWith({
      where: { normalizedName: 'production 80' },
      select: { id: true },
    });
    expect(tx.stockProductionTemplate.create).not.toHaveBeenCalled();
  });

  it.each([
    ['whitespace-only', ' \t\n '],
    ['over 200 characters after NFKC normalization', '\uFB03'.repeat(67)],
  ])('rejects a %s display name before opening a transaction', async (_case, name) => {
    const prisma = {
      $transaction: jest
        .fn()
        .mockRejectedValue(new Error('transaction must not run for an invalid name')),
    };
    const service = new StockProductionTemplateService(
      prisma as never,
      { record: jest.fn() } as never,
    );

    await expect(service.create(actor, { ...dto, name })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('maps an atomic normalized-name P2002 create race to conflict', async () => {
    const prisma = {
      $transaction: jest.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('normalized name race', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      ),
    };
    const service = new StockProductionTemplateService(
      prisma as never,
      { record: jest.fn() } as never,
    );

    await expect(service.create(actor, dto)).rejects.toMatchObject({ status: 409 });
  });

  it('lists only active templates with immutable versions newest first', async () => {
    const rows = [
      template({
        versions: [
          {
            id: 'template-version-2',
            templateId: 'template-1',
            version: 2,
            positions,
            createdById: actor.userId,
            createdAt: new Date('2026-07-27T13:00:00.000Z'),
          },
        ],
      }),
    ];
    const tx = {
      stockProductionTemplate: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ id: 'template-1' }])
          .mockResolvedValueOnce(rows),
      },
      stockProductionTemplateVersion: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'template-version-2', templateId: 'template-1' }]),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const service = new StockProductionTemplateService(
      prisma as never,
      { record: jest.fn() } as never,
    );

    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({
        id: 'template-1',
        updatedAt: '2026-07-27T12:00:00.000Z',
        versions: [
          expect.objectContaining({
            id: 'template-version-2',
            createdAt: '2026-07-27T13:00:00.000Z',
          }),
        ],
      }),
    ]);
    expect(tx.stockProductionTemplate.findMany).toHaveBeenNthCalledWith(1, {
      where: { status: 'active' },
      select: { id: true },
      orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }, { id: 'asc' }],
      take: 501,
    });
    expect(tx.stockProductionTemplate.findMany).toHaveBeenNthCalledWith(2, {
      where: { id: { in: ['template-1'] } },
      include: {
        versions: {
          orderBy: [{ version: 'desc' }, { id: 'asc' }],
          take: 101,
        },
      },
      orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }, { id: 'asc' }],
    });
  });

  it('fails before hydrating an oversized stock-template catalog', async () => {
    const tx = {
      stockProductionTemplate: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            Array.from({ length: 501 }, (_, index) => ({ id: `template-${index}` })),
          ),
      },
      stockProductionTemplateVersion: { findMany: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const service = new StockProductionTemplateService(
      prisma as never,
      { record: jest.fn() } as never,
    );

    await expect(service.list()).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'STOCK_PRODUCTION_TEMPLATE_CATALOG_TOO_LARGE' }),
    });
    expect(tx.stockProductionTemplate.findMany).toHaveBeenCalledTimes(1);
    expect(tx.stockProductionTemplateVersion.findMany).not.toHaveBeenCalled();
  });

  it('fails before JSON hydration when one template has too many immutable versions', async () => {
    const tx = {
      stockProductionTemplate: {
        findMany: jest.fn().mockResolvedValue([{ id: 'template-1' }]),
      },
      stockProductionTemplateVersion: {
        findMany: jest.fn().mockResolvedValue(
          Array.from({ length: 101 }, (_, index) => ({
            id: `version-${index}`,
            templateId: 'template-1',
          })),
        ),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const service = new StockProductionTemplateService(
      prisma as never,
      { record: jest.fn() } as never,
    );

    await expect(service.list()).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'STOCK_PRODUCTION_TEMPLATE_CATALOG_TOO_LARGE' }),
    });
    expect(tx.stockProductionTemplate.findMany).toHaveBeenCalledTimes(1);
  });

  it('appends the next immutable version with old and new audit snapshots', async () => {
    const existing = template({
      name: 'Старое имя',
      description: null,
      version: 2,
      positions: [positions[0]],
    });
    const updatedVersions = [
      {
        id: 'template-version-3',
        templateId: 'template-1',
        version: 3,
        positions,
        createdById: actor.userId,
        createdAt: new Date('2026-07-27T14:00:00.000Z'),
      },
    ];
    const updated = {
      ...template({
        name: 'Производственный комплект',
        version: 3,
        updatedAt: new Date('2026-07-27T14:00:00.000Z'),
      }),
      versions: updatedVersions,
    };
    const tx = {
      stockProductionTemplate: {
        findFirst: jest.fn().mockResolvedValueOnce(existing).mockResolvedValueOnce(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve('normalizedName' in where ? null : updated),
        ),
      },
      stockProductionTemplateVersion: {
        create: jest.fn().mockResolvedValue(updatedVersions[0]),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const audit = { record: jest.fn() };
    const service = new StockProductionTemplateService(prisma as never, audit as never);

    const result = await service.update(actor, 'template-1', {
      ...dto,
      expectedVersion: 2,
    });

    expect(tx.stockProductionTemplate.updateMany).toHaveBeenCalledWith({
      where: { id: 'template-1', status: 'active', version: 2 },
      data: {
        name: 'Производственный комплект',
        normalizedName: 'производственный комплект',
        description: 'Две позиции',
        positions,
        version: 3,
      },
    });
    expect(tx.stockProductionTemplateVersion.create).toHaveBeenCalledWith({
      data: {
        templateId: 'template-1',
        version: 3,
        positions,
        createdById: 'lead-1',
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:stock_production_template_updated',
        oldValue: {
          name: 'Старое имя',
          description: null,
          version: 2,
          positions: [positions[0]],
        },
        newValue: {
          name: 'Производственный комплект',
          description: 'Две позиции',
          version: 3,
          positions,
        },
      }),
      tx,
    );
    expect(result).toMatchObject({ id: 'template-1', version: 3 });
  });

  it('rejects an update whose normalized name belongs to another template', async () => {
    const existing = template({ version: 1 });
    const tx = {
      stockProductionTemplate: {
        findFirst: jest.fn().mockResolvedValue(existing),
        findUnique: jest.fn().mockResolvedValue({ id: 'template-2' }),
        updateMany: jest.fn(),
      },
      stockProductionTemplateVersion: { create: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const audit = { record: jest.fn() };
    const service = new StockProductionTemplateService(prisma as never, audit as never);

    await expect(
      service.update(actor, 'template-1', {
        ...dto,
        name: '  ＰＲＯＤＵＣＴＩＯＮ 80  ',
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(tx.stockProductionTemplate.findUnique).toHaveBeenCalledWith({
      where: { normalizedName: 'production 80' },
      select: { id: true },
    });
    expect(tx.stockProductionTemplate.updateMany).not.toHaveBeenCalled();
  });

  it('maps an atomic normalized-name P2002 update race to conflict', async () => {
    const existing = template({ version: 1 });
    const tx = {
      stockProductionTemplate: {
        findFirst: jest.fn().mockResolvedValueOnce(existing).mockResolvedValueOnce(null),
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      stockProductionTemplateVersion: {
        create: jest.fn().mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError('normalized name race', {
            code: 'P2002',
            clientVersion: 'test',
          }),
        ),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const audit = { record: jest.fn() };
    const service = new StockProductionTemplateService(prisma as never, audit as never);

    await expect(
      service.update(actor, 'template-1', { ...dto, expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 409 });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects a lost optimistic update', async () => {
    const existing = template({ version: 1 });
    const tx = {
      stockProductionTemplate: {
        findFirst: jest.fn().mockResolvedValueOnce(existing).mockResolvedValueOnce(null),
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      stockProductionTemplateVersion: { create: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const audit = { record: jest.fn() };
    const service = new StockProductionTemplateService(prisma as never, audit as never);

    await expect(
      service.update(actor, 'template-1', { ...dto, expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 409 });
    expect(tx.stockProductionTemplateVersion.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
