import { ConflictException } from '@nestjs/common';
import { MaterialCatalogService } from './material-catalog.service';

const ACTOR = { userId: 'admin-1', role: 'admin' as const };

function setup(existing: Record<string, unknown> | null = null) {
  const created = {
    id: 'material-pnd',
    name: 'ПНД гранула',
    kind: 'custom',
  };
  const tx = {
    rawMaterialDefinition: {
      findUnique: jest.fn().mockResolvedValue(existing),
      create: jest.fn().mockResolvedValue(created),
      update: jest.fn().mockResolvedValue(created),
    },
    domainEvent: {
      create: jest.fn().mockResolvedValue({ id: 'event-1' }),
    },
  };
  const prisma = {
    rawMaterialDefinition: {
      findMany: jest.fn().mockResolvedValue([{ id: 'material-aika', name: 'Айка', kind: 'base' }]),
    },
    $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const audit = {
    record: jest.fn().mockResolvedValue({ id: 'event-1' }),
  };
  return {
    audit,
    prisma,
    service: new MaterialCatalogService(prisma as never, audit as never),
    tx,
  };
}

describe('MaterialCatalogService', () => {
  it('lists only active admin-managed production selectors', async () => {
    const { prisma, service } = setup();

    await expect(service.list()).resolves.toEqual([
      { id: 'material-aika', name: 'Айка', kind: 'base' },
    ]);
    expect(prisma.rawMaterialDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'active', isProductionSelectable: true },
      }),
    );
  });

  it('normalizes a search term and filters by the catalog name', async () => {
    const { prisma, service } = setup();

    await service.list('  ПЕРВИЧКА  ');

    expect(prisma.rawMaterialDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'active',
          isProductionSelectable: true,
          normalizedName: { contains: 'первичка' },
        },
      }),
    );
  });

  it('creates a custom type and audits its immediate shared availability', async () => {
    const { audit, service, tx } = setup();

    await expect(service.create(ACTOR, { name: '  ПНД гранула  ' })).resolves.toEqual({
      id: 'material-pnd',
      name: 'ПНД гранула',
      kind: 'custom',
    });
    expect(tx.rawMaterialDefinition.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'ПНД гранула',
          normalizedName: 'пнд гранула',
          isProductionSelectable: true,
          createdById: 'admin-1',
          createdByRole: 'admin',
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:raw_material_definition_created',
        objectId: 'material-pnd',
        detail: { source: 'admin_material_type_catalog' },
      }),
      tx,
    );
  });

  it('rejects an already selectable type without writing or auditing', async () => {
    const { audit, service, tx } = setup({
      id: 'material-aika',
      name: 'Айка',
      kind: 'base',
      status: 'active',
      isProductionSelectable: true,
    });

    await expect(service.create(ACTOR, { name: 'АЙКА' })).rejects.toBeInstanceOf(ConflictException);
    expect(tx.rawMaterialDefinition.create).not.toHaveBeenCalled();
    expect(tx.rawMaterialDefinition.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
