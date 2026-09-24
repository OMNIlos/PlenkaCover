import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  CounterpartyTemplateService,
  snapshotCounterpartyTemplatePosition,
} from './counterparty-template.service';

describe('CounterpartyTemplateService', () => {
  const actor = { userId: 'lead1', role: 'production_lead' as const };
  const catalog = () => ({
    resolveSelections: jest.fn(
      async (
        _tx: unknown,
        selectors: Array<{
          baseRawMaterialDefinitionId?: string;
          recipeDefinitionVersionId?: string;
        }>,
      ) =>
        selectors.map((selector) => ({
          baseRawMaterialDefinitionId: selector.baseRawMaterialDefinitionId ?? null,
          recipeDefinitionId: selector.recipeDefinitionVersionId ? 'recipe-1' : null,
          recipeDefinitionVersionId: selector.recipeDefinitionVersionId ?? null,
          version: selector.recipeDefinitionVersionId ? 1 : null,
          name: 'Каталожное сырьё',
          ingredients: [],
        })),
    ),
  });

  it.each([
    ['filmType', 'Пятый тип'],
    ['spoolType', 'Самодельная'],
    ['birka', 'Произвольная'],
  ])('rejects an unsupported bounded %s in every template snapshot', (field, value) => {
    expect(() =>
      snapshotCounterpartyTemplatePosition({
        rollCount: 1,
        filmType: 'Рукав',
        actualThickness: '80',
        accountingThickness: '80',
        baseRawMaterialDefinitionId: 'material-1',
        [field]: value,
      } as never),
    ).toThrow(BadRequestException);
  });

  it.each([
    'RAW_MATERIAL_DEFINITION_UNAVAILABLE',
    'RECIPE_VERSION_UNAVAILABLE',
    'RECIPE_VERSION_STALE',
  ])('rejects a template when catalog resolution reports %s', async (code) => {
    const tx = {
      counterpartyOrderTemplate: { create: jest.fn() },
      counterpartyOrderTemplateVersion: { create: jest.fn() },
    };
    const prisma = {
      counterparty: { findUnique: jest.fn().mockResolvedValue({ id: 'cp1' }) },
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const recipeCatalog = {
      resolveSelections: jest
        .fn()
        .mockRejectedValue(
          new ConflictException({ code, message: 'Catalog selection is unavailable.' }),
        ),
    };
    const service = new CounterpartyTemplateService(
      prisma as never,
      { record: jest.fn() } as never,
      recipeCatalog as never,
    );

    await expect(
      service.create(actor, 'cp1', {
        name: 'Проверяемый шаблон',
        positions: [
          {
            rollCount: 1,
            filmType: 'Рукав',
            actualThickness: '80',
            accountingThickness: '80',
            baseRawMaterialDefinitionId: 'unavailable-selection',
          },
        ],
      } as never),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code }) });
    expect(tx.counterpartyOrderTemplate.create).not.toHaveBeenCalled();
  });

  it('creates a production-owned template for a concrete counterparty and audits it', async () => {
    const tx = {
      counterparty: { findUnique: jest.fn().mockResolvedValue({ id: 'cp1' }) },
      counterpartyOrderTemplate: {
        create: jest.fn().mockResolvedValue({
          id: 'tpl1',
          counterpartyId: 'cp1',
          name: 'УралПак · рукав 80',
          status: 'active',
          positions: [],
        }),
      },
      counterpartyOrderTemplateVersion: {
        create: jest.fn().mockResolvedValue({ id: 'tplv1', templateId: 'tpl1', version: 1 }),
      },
    };
    const prisma = {
      ...tx,
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const audit = { record: jest.fn() };
    const service = new CounterpartyTemplateService(
      prisma as never,
      audit as never,
      catalog() as never,
    );

    await service.create(actor, 'cp1', {
      name: 'УралПак · рукав 80',
      positions: [
        {
          rollCount: 3,
          filmType: 'Рукав',
          actualThickness: '80 мкм',
          accountingThickness: '78 мкм',
          rawMaterialId: 'PVD-15803',
          spoolType: 'Тонкая',
          birka: 'ГОСТ',
          recipeParameters: [{ label: 'Сырье', value: 'ПВД 15803' }],
        },
      ],
    });

    expect(prisma.counterpartyOrderTemplate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        counterpartyId: 'cp1',
        name: 'УралПак · рукав 80',
        ownerRole: 'production_lead',
        positions: [
          {
            rollCount: 3,
            filmType: 'Рукав',
            actualThickness: '80 мкм',
            accountingThickness: '78 мкм',
            rawMaterialId: 'PVD-15803',
            spoolType: 'Тонкая',
            birka: 'ГОСТ',
            recipeParameters: [{ label: 'Сырье', value: 'ПВД 15803' }],
          },
        ],
      }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:counterparty_template_created',
        actorRole: 'production_lead',
        objectId: 'tpl1',
        detail: expect.objectContaining({ counterpartyId: 'cp1' }),
      }),
      tx,
    );
  });

  it('creates immutable version one in the same transaction as the template', async () => {
    const tx = {
      counterparty: { findUnique: jest.fn().mockResolvedValue({ id: 'cp1' }) },
      counterpartyOrderTemplate: {
        create: jest.fn().mockResolvedValue({
          id: 'tpl1',
          counterpartyId: 'cp1',
          name: 'Рукав 80',
          version: 1,
        }),
      },
      counterpartyOrderTemplateVersion: {
        create: jest.fn().mockResolvedValue({ id: 'tplv1', templateId: 'tpl1', version: 1 }),
      },
    };
    const prisma = {
      ...tx,
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const audit = { record: jest.fn() };
    const service = new CounterpartyTemplateService(
      prisma as never,
      audit as never,
      catalog() as never,
    );

    const result = await service.create(actor, 'cp1', {
      name: 'Рукав 80',
      positions: [
        {
          rollCount: 2,
          filmType: 'Рукав',
          actualThickness: '80',
          accountingThickness: '80',
          recipeParameters: [],
        },
      ],
    });

    expect(prisma.counterpartyOrderTemplateVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        templateId: 'tpl1',
        version: 1,
        positions: expect.any(Array),
        createdById: 'lead1',
      }),
    });
    expect(result.versions).toEqual([
      expect.objectContaining({ id: 'tplv1', templateId: 'tpl1', version: 1 }),
    ]);
    expect(audit.record).toHaveBeenCalledWith(expect.any(Object), tx);
  });

  it('preserves roll dimensions and the manual label in every template snapshot', async () => {
    const tx = {
      counterparty: { findUnique: jest.fn().mockResolvedValue({ id: 'cp1' }) },
      counterpartyOrderTemplate: {
        create: jest.fn().mockResolvedValue({
          id: 'tpl-dimensions',
          counterpartyId: 'cp1',
          name: 'Рукав 80 · 1700 × 275',
          version: 1,
        }),
      },
      counterpartyOrderTemplateVersion: {
        create: jest.fn().mockResolvedValue({
          id: 'tplv-dimensions',
          templateId: 'tpl-dimensions',
          version: 1,
        }),
      },
    };
    const prisma = {
      ...tx,
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const service = new CounterpartyTemplateService(
      prisma as never,
      { record: jest.fn() } as never,
      catalog() as never,
    );

    await service.create(actor, 'cp1', {
      name: 'Рукав 80 · 1700 × 275',
      positions: [
        {
          rollCount: 2,
          filmType: 'Рукав',
          actualThickness: '80 мкм',
          accountingThickness: '78 мкм',
          widthMm: 1700,
          plannedLengthM: 275,
          manualBirka: 'Маркировка А-17',
          recipeParameters: [],
        },
      ],
    } as never);

    const expectedPosition = expect.objectContaining({
      widthMm: 1700,
      plannedLengthM: 275,
      manualBirka: 'Маркировка А-17',
    });
    expect(tx.counterpartyOrderTemplate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ positions: [expectedPosition] }),
    });
    expect(tx.counterpartyOrderTemplateVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ positions: [expectedPosition] }),
    });
  });

  it('preserves a structured material selector in the immutable template snapshot', async () => {
    const tx = {
      counterparty: { findUnique: jest.fn().mockResolvedValue({ id: 'cp1' }) },
      counterpartyOrderTemplate: {
        create: jest.fn().mockResolvedValue({
          id: 'tpl-structured',
          counterpartyId: 'cp1',
          name: 'Синяя смесь',
          version: 1,
        }),
      },
      counterpartyOrderTemplateVersion: {
        create: jest.fn().mockResolvedValue({
          id: 'tplv-structured',
          templateId: 'tpl-structured',
          version: 1,
        }),
      },
    };
    const prisma = {
      ...tx,
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const service = new CounterpartyTemplateService(
      prisma as never,
      {
        record: jest.fn(),
      } as never,
      catalog() as never,
    );

    await service.create(actor, 'cp1', {
      name: 'Синяя смесь',
      positions: [
        {
          rollCount: 2,
          filmType: 'Рукав',
          actualThickness: '80',
          accountingThickness: '75',
          recipeDefinitionVersionId: 'recipe-version-1',
          recipeParameters: [],
        },
      ],
    } as never);

    expect(prisma.counterpartyOrderTemplate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        positions: [
          expect.objectContaining({
            recipeDefinitionVersionId: 'recipe-version-1',
            recipeParameters: [{ label: 'Сырьё', value: 'Каталожное сырьё' }],
          }),
        ],
      }),
    });
    expect(prisma.counterpartyOrderTemplateVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        positions: [
          expect.objectContaining({
            recipeDefinitionVersionId: 'recipe-version-1',
            recipeParameters: [{ label: 'Сырьё', value: 'Каталожное сырьё' }],
          }),
        ],
      }),
    });
  });

  it('appends an immutable version instead of overwriting history', async () => {
    const existing = {
      id: 'tpl1',
      counterpartyId: 'cp1',
      name: 'Рукав 70',
      status: 'active',
      version: 2,
      positions: [],
    };
    const tx = {
      counterpartyOrderTemplate: {
        findFirst: jest.fn().mockResolvedValue(existing),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest
          .fn()
          .mockResolvedValue({ ...existing, version: 3, name: 'Рукав 80', versions: [] }),
      },
      counterpartyOrderTemplateVersion: {
        create: jest.fn().mockResolvedValue({ id: 'tplv3', templateId: 'tpl1', version: 3 }),
      },
    };
    const prisma = {
      ...tx,
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const audit = { record: jest.fn() };
    const service = new CounterpartyTemplateService(
      prisma as never,
      audit as never,
      catalog() as never,
    );

    await service.update(actor, 'cp1', 'tpl1', {
      name: 'Рукав 80',
      positions: [
        {
          rollCount: 3,
          filmType: 'Рукав',
          actualThickness: '80',
          accountingThickness: '80',
          recipeParameters: [],
        },
      ],
    });

    expect(prisma.counterpartyOrderTemplate.updateMany).toHaveBeenCalledWith({
      where: { id: 'tpl1', counterpartyId: 'cp1', status: 'active', version: 2 },
      data: expect.objectContaining({ version: 3, name: 'Рукав 80' }),
    });
    expect(prisma.counterpartyOrderTemplateVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ templateId: 'tpl1', version: 3 }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        oldValue: expect.objectContaining({ version: 2 }),
        newValue: expect.objectContaining({ version: 3 }),
      }),
      tx,
    );
  });

  it('lists active and archived templates for lifecycle management', async () => {
    const rows = [
      {
        id: 'tpl1',
        counterpartyId: 'cp1',
        name: 'Рукав 80',
        status: 'active',
        versions: [],
      },
      {
        id: 'tpl2',
        counterpartyId: 'cp1',
        name: 'Рукав 60',
        status: 'archived',
        versions: [],
      },
    ];
    const tx = {
      counterpartyOrderTemplate: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce(rows.map(({ id }) => ({ id })))
          .mockResolvedValueOnce(rows),
      },
      counterpartyOrderTemplateVersion: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const prisma = {
      ...tx,
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const service = new CounterpartyTemplateService(
      prisma as never,
      { record: jest.fn() } as never,
      catalog() as never,
    );

    await expect(service.listForCounterparty('cp1')).resolves.toHaveLength(2);
    expect(prisma.counterpartyOrderTemplate.findMany).toHaveBeenNthCalledWith(1, {
      where: { counterpartyId: 'cp1', status: { in: ['active', 'archived'] } },
      select: { id: true },
      orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }, { id: 'asc' }],
      take: 501,
    });
    expect(tx.counterpartyOrderTemplateVersion.findMany).toHaveBeenCalledWith({
      where: { templateId: { in: ['tpl1', 'tpl2'] } },
      select: { id: true, templateId: true },
      orderBy: [{ templateId: 'asc' }, { version: 'desc' }, { id: 'asc' }],
      take: 2001,
    });
  });

  it.each(['archived', 'active'] as const)(
    'persists the %s lifecycle status and audits the transition',
    async (status) => {
      const previousStatus = status === 'archived' ? 'active' : 'archived';
      const existing = {
        id: 'tpl1',
        counterpartyId: 'cp1',
        name: 'Рукав 80',
        status: previousStatus,
        version: 2,
        positions: [],
        versions: [],
      };
      const updated = { ...existing, status };
      const tx = {
        counterpartyOrderTemplate: {
          findFirst: jest.fn().mockResolvedValue(existing),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue(updated),
        },
      };
      const prisma = {
        ...tx,
        $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
      };
      const audit = { record: jest.fn() };
      const service = new CounterpartyTemplateService(
        prisma as never,
        audit as never,
        catalog() as never,
      );

      const result = await (
        service as never as {
          updateStatus: (
            transitionActor: typeof actor,
            counterpartyId: string,
            templateId: string,
            nextStatus: typeof status,
          ) => Promise<{ status: string }>;
        }
      ).updateStatus(actor, 'cp1', 'tpl1', status);

      expect(result.status).toBe(status);
      expect(tx.counterpartyOrderTemplate.updateMany).toHaveBeenCalledWith({
        where: { id: 'tpl1', counterpartyId: 'cp1', status: previousStatus },
        data: { status },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'audit:counterparty_template_updated',
          objectId: 'tpl1',
          oldValue: { status: previousStatus },
          newValue: { status },
        }),
        tx,
      );
    },
  );

  it('fails closed instead of truncating an oversized template catalog', async () => {
    const tx = {
      counterpartyOrderTemplate: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            Array.from({ length: 501 }, (_, index) => ({ id: `tpl-${index}`, versions: [] })),
          ),
      },
      counterpartyOrderTemplateVersion: { findMany: jest.fn() },
    };
    const prisma = {
      ...tx,
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const service = new CounterpartyTemplateService(
      prisma as never,
      { record: jest.fn() } as never,
      catalog() as never,
    );

    await expect(service.listForCounterparty('cp1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'COUNTERPARTY_TEMPLATE_CATALOG_TOO_LARGE' }),
    });
  });

  it('fails closed instead of truncating one template version history', async () => {
    const tx = {
      counterpartyOrderTemplate: {
        findMany: jest.fn().mockResolvedValue([{ id: 'tpl-1' }]),
      },
      counterpartyOrderTemplateVersion: {
        findMany: jest.fn().mockResolvedValue(
          Array.from({ length: 101 }, (_, index) => ({
            id: `version-${index}`,
            templateId: 'tpl-1',
          })),
        ),
      },
    };
    const prisma = {
      ...tx,
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const service = new CounterpartyTemplateService(
      prisma as never,
      { record: jest.fn() } as never,
      catalog() as never,
    );

    await expect(service.listForCounterparty('cp1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'COUNTERPARTY_TEMPLATE_HISTORY_TOO_LARGE' }),
    });
  });

  it('fails before hydrating a globally oversized version catalog', async () => {
    const tx = {
      counterpartyOrderTemplate: { findMany: jest.fn().mockResolvedValue([{ id: 'tpl-1' }]) },
      counterpartyOrderTemplateVersion: {
        findMany: jest.fn().mockResolvedValue(
          Array.from({ length: 2001 }, (_, index) => ({
            id: `version-${index}`,
            templateId: `tpl-${index % 500}`,
          })),
        ),
      },
    };
    const prisma = {
      ...tx,
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const service = new CounterpartyTemplateService(
      prisma as never,
      { record: jest.fn() } as never,
      catalog() as never,
    );

    await expect(service.listForCounterparty('cp1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'COUNTERPARTY_TEMPLATE_HISTORY_TOO_LARGE' }),
    });
    expect(tx.counterpartyOrderTemplate.findMany).toHaveBeenCalledTimes(1);
  });

  it('updates a production-owned template snapshot and audits the change', async () => {
    const existing = {
      id: 'tpl1',
      counterpartyId: 'cp1',
      name: 'УралПак · рукав 70',
      status: 'active',
      version: 1,
      positions: [],
    };
    const tx = {
      counterpartyOrderTemplate: {
        findFirst: jest.fn().mockResolvedValue(existing),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({ ...existing, version: 2, versions: [] }),
      },
      counterpartyOrderTemplateVersion: {
        create: jest.fn().mockResolvedValue({ id: 'tplv2', templateId: 'tpl1', version: 2 }),
      },
    };
    const prisma = {
      ...tx,
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const audit = { record: jest.fn() };
    const service = new CounterpartyTemplateService(
      prisma as never,
      audit as never,
      catalog() as never,
    );

    await service.update(actor, 'cp1', 'tpl1', {
      name: 'УралПак · рукав 70',
      positions: [
        {
          rollCount: 10,
          filmType: 'Рукав',
          actualThickness: '70 мкм',
          accountingThickness: '70 мкм',
          rawMaterialId: 'PVD-10803',
          spoolType: 'Толстая',
          birka: 'ГОСТ',
          recipeParameters: [{ label: 'Рулоны', value: '10 шт. по 32.5 кг' }],
        },
      ],
    });

    expect(prisma.counterpartyOrderTemplate.findFirst).toHaveBeenCalledWith({
      where: { id: 'tpl1', counterpartyId: 'cp1', status: 'active' },
    });
    expect(prisma.counterpartyOrderTemplate.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'tpl1',
        counterpartyId: 'cp1',
        status: 'active',
        version: 1,
      },
      data: expect.objectContaining({
        name: 'УралПак · рукав 70',
        version: 2,
        positions: [
          {
            rollCount: 10,
            filmType: 'Рукав',
            actualThickness: '70 мкм',
            accountingThickness: '70 мкм',
            rawMaterialId: 'PVD-10803',
            spoolType: 'Толстая',
            birka: 'ГОСТ',
            recipeParameters: [{ label: 'Рулоны', value: '10 шт. по 32.5 кг' }],
          },
        ],
      }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:counterparty_template_updated',
        actorRole: 'production_lead',
        objectId: 'tpl1',
        detail: expect.objectContaining({ counterpartyId: 'cp1', positionCount: 1 }),
      }),
      tx,
    );
  });

  it('rejects update for a template outside the selected counterparty', async () => {
    const prisma = {
      counterpartyOrderTemplate: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn(),
      },
    } as any;
    const service = new CounterpartyTemplateService(
      prisma,
      { record: jest.fn() } as any,
      catalog() as never,
    );

    await expect(
      service.update(actor, 'cp1', 'tpl-missing', {
        name: 'Любой шаблон',
        positions: [
          {
            rollCount: 10,
            filmType: 'Рукав',
            actualThickness: '70',
            accountingThickness: '70',
            recipeParameters: [],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.counterpartyOrderTemplate.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an update that would make the template unreadable at version 101', async () => {
    const prisma = {
      counterpartyOrderTemplate: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'tpl-full',
          counterpartyId: 'cp1',
          status: 'active',
          version: 100,
        }),
        updateMany: jest.fn(),
      },
      $transaction: jest.fn(),
    } as any;
    const service = new CounterpartyTemplateService(
      prisma,
      { record: jest.fn() } as any,
      catalog() as never,
    );

    await expect(
      service.update(actor, 'cp1', 'tpl-full', {
        name: 'Полная история',
        positions: [
          {
            rollCount: 1,
            filmType: 'Рукав',
            actualThickness: '80',
            accountingThickness: '80',
            recipeParameters: [],
          },
        ],
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'COUNTERPARTY_TEMPLATE_HISTORY_TOO_LARGE' }),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.counterpartyOrderTemplate.updateMany).not.toHaveBeenCalled();
  });

  it('rejects creation for an unknown counterparty', async () => {
    const prisma = {
      counterparty: { findUnique: jest.fn().mockResolvedValue(null) },
      counterpartyOrderTemplate: { create: jest.fn() },
    } as any;
    const service = new CounterpartyTemplateService(
      prisma,
      { record: jest.fn() } as any,
      catalog() as never,
    );

    await expect(
      service.create(actor, 'missing-cp', {
        name: 'Любой шаблон',
        positions: [
          {
            rollCount: 1,
            filmType: 'Рукав',
            actualThickness: '80',
            accountingThickness: '80',
            recipeParameters: [],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.counterpartyOrderTemplate.create).not.toHaveBeenCalled();
  });
});
