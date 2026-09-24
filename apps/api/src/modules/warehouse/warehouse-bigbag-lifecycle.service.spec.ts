import { ConflictException, NotFoundException } from '@nestjs/common';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import { WarehouseBigBagService } from './warehouse-bigbag.service';

const actor = { userId: 'warehouse-1', role: 'warehouse' as const };
const operationKey = '123e4567-e89b-42d3-a456-426614174000';
const token = `bbt_${'a'.repeat(64)}`;

const baseBag = {
  id: 'bag-1',
  code: 'BB-ПВД-01',
  material: 'ПВД Первичное',
  materialId: null,
  materialSelectionKind: 'material',
  materialPreset: null,
  baseRawMaterialDefinitionId: 'rmd-base-primary',
  recipeDefinitionVersionId: null,
  recipeName: null,
  recipeVersionNumber: null,
  supplierName: null,
  receivedAt: null,
  composition: [],
  status: 'available',
  registrationStatus: 'pending_scan',
  location: 'warehouse',
  locationRevision: 0,
  initialKg: 500,
  currentKg: 500,
  lastMeasuredKg: 500,
  lastActorRole: 'warehouse',
  lastMeasuredAt: new Date('2026-08-03T12:00:00.000Z'),
  machineId: null,
  lastWarehouseMeasuredKg: null,
  lastWarehouseMeasuredAt: null,
  createdByRole: 'warehouse',
  createdAt: new Date('2026-08-03T12:00:00.000Z'),
  priceKopecksPerKg: 2_500,
  priceSource: 'manual_warehouse',
  priceEffectiveAt: new Date('2026-08-03T12:00:00.000Z'),
  printJobs: [],
};

function lifecycleHarness(initial = baseBag) {
  let bag = { ...initial };
  const movements = new Map<string, Record<string, unknown>>();
  const prisma: any = {
    bigBagMovement: {
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(movements.get(where.operationKey) ?? null),
      ),
      create: jest.fn(({ data }: any) => {
        const row = { id: 'movement-1', ...data };
        movements.set(data.operationKey, row);
        return Promise.resolve(row);
      }),
    },
    bigBagScanToken: {
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(where.token === token ? { bigBagId: bag.id } : null),
      ),
    },
    bigBagUnit: {
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(where.id === bag.id ? { ...bag } : null),
        ),
      update: jest.fn(({ data }: any) => {
        bag = { ...bag, ...data };
        return Promise.resolve({ ...bag });
      }),
    },
    shiftBagUsage: {
      count: jest.fn().mockResolvedValue(0),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ id: bag.id }]),
    $transaction: jest.fn((work: (tx: any) => unknown) => work(prisma)),
  };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
  const service = new WarehouseBigBagService(prisma, audit as never, {} as never);
  return { audit, getBag: () => bag, movements, prisma, service };
}

describe('WarehouseBigBagService lifecycle', () => {
  it('creates a catalog Big-Bag pending QR confirmation with an opaque token', async () => {
    const prisma: any = {
      rawMaterialDefinition: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'rmd-base-primary',
          name: 'ПВД Первичное',
          status: 'active',
          isProductionSelectable: true,
        }),
      },
      bigBagUnit: {
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(({ data }: any) =>
          Promise.resolve({ id: 'bag-1', createdAt: new Date(), ...data }),
        ),
      },
      $transaction: jest.fn((work: (tx: any) => unknown) => work(prisma)),
    };
    const audit = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
    const service = new WarehouseBigBagService(prisma, audit as never, {} as never);

    const created = await service.create(actor, {
      baseRawMaterialDefinitionId: 'rmd-base-primary',
      weightKg: 500,
      priceKopecksPerKg: 2_500,
      batchCode: 'ПАРТИЯ-500',
      supplierName: '  ООО Поставщик  ',
    });

    expect(created).toEqual(
      expect.objectContaining({
        registrationStatus: 'pending_scan',
        location: 'warehouse',
        locationRevision: 0,
        priceKopecksPerKg: 2_500,
        totalKopecks: 1_250_000,
        supplierName: 'ООО Поставщик',
        receivedAt: null,
        latestLabelPrint: null,
      }),
    );
    expect(prisma.bigBagUnit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          registrationStatus: 'pending_scan',
          location: 'warehouse',
          locationRevision: 0,
          priceKopecksPerKg: 2_500,
          priceSource: 'manual_warehouse',
          priceEffectiveAt: expect.any(Date),
          batchCode: 'ПАРТИЯ-500',
          supplierName: 'ООО Поставщик',
          receivedAt: null,
          scanToken: {
            create: {
              token: expect.stringMatching(/^bbt_[0-9a-f]{64}$/u),
            },
          },
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:bigbag_created',
        newValue: expect.objectContaining({
          registered: false,
          priceKopecksPerKg: 2_500,
          totalKopecks: 1_250_000,
          supplierName: 'ООО Поставщик',
        }),
        detail: expect.objectContaining({
          batchCode: 'ПАРТИЯ-500',
          supplierName: 'ООО Поставщик',
        }),
      }),
      prisma,
    );
  });

  it('returns the latest durable print state without exposing the QR token', async () => {
    const latestPrint = {
      id: 'print-job-1',
      requestId: '11111111-1111-4111-8111-111111111111',
      bigBagId: baseBag.id,
      printerId: 'printer-1',
      status: 'submitted',
      reason: null,
      replacesPrintJobId: null,
      gatewayCommandId: 'gateway-command-1',
      createdAt: new Date('2026-08-03T12:05:00.000Z'),
      updatedAt: new Date('2026-08-03T12:05:01.000Z'),
    };
    const prisma: any = {
      bigBagUnit: {
        findMany: jest.fn().mockResolvedValue([
          {
            ...baseBag,
            printJobs: [latestPrint],
          },
        ]),
      },
    };
    const service = new WarehouseBigBagService(prisma, { record: jest.fn() } as never, {} as never);

    const [bag] = await service.list();

    expect(bag.latestLabelPrint).toEqual({
      ...latestPrint,
      createdAt: '2026-08-03T12:05:00.000Z',
      updatedAt: '2026-08-03T12:05:01.000Z',
    });
    expect(JSON.stringify(bag)).not.toContain('bbt_');
  });

  it('queries only usable stock and bags still in use', async () => {
    const prisma: any = { bigBagUnit: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new WarehouseBigBagService(prisma, {} as never, {} as never);

    await expect(service.list()).resolves.toEqual([]);
    expect(prisma.bigBagUnit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { in: ['available', 'in_use'] },
          OR: [{ status: 'in_use' }, { currentKg: { gt: 0 } }, { currentKg: null }],
        },
      }),
    );
  });

  it('uses the first warehouse scan to register the created Big-Bag', async () => {
    const { audit, prisma, service } = lifecycleHarness();

    const result = await service.move(actor, {
      operationKey,
      qrCode: token,
      destination: 'warehouse',
    });

    expect(result).toEqual(
      expect.objectContaining({
        bag: expect.objectContaining({
          registrationStatus: 'registered',
          location: 'warehouse',
          locationRevision: 1,
          receivedAt: expect.any(String),
        }),
        movement: expect.objectContaining({ kind: 'registration', toLocation: 'warehouse' }),
        weightComparison: null,
      }),
    );
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.bigBagUnit.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          registrationStatus: 'registered',
          receivedAt: expect.any(Date),
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:bigbag_registration_confirmed',
        oldValue: expect.objectContaining({ receivedAt: null }),
        newValue: expect.objectContaining({ receivedAt: expect.any(String) }),
      }),
      prisma,
    );
  });

  it('moves a registered available Big-Bag from warehouse to production explicitly', async () => {
    const { audit, service } = lifecycleHarness({
      ...baseBag,
      registrationStatus: 'registered',
      locationRevision: 1,
    });

    const result = await service.move(actor, {
      operationKey,
      qrCode: token,
      destination: 'production',
    });

    expect(result.bag).toEqual(
      expect.objectContaining({ location: 'production', locationRevision: 2 }),
    );
    expect(result.movement.kind).toBe('to_production');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:bigbag_moved_to_production' }),
      expect.anything(),
    );
  });

  it('requires a warehouse control weight on return and records the variance', async () => {
    const { audit, getBag, service } = lifecycleHarness({
      ...baseBag,
      registrationStatus: 'registered',
      location: 'production',
      locationRevision: 2,
      currentKg: 410,
      lastMeasuredKg: 410,
      lastActorRole: 'operator',
    });

    await expect(
      service.move(actor, {
        operationKey,
        qrCode: token,
        destination: 'warehouse',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    const result = await service.move(actor, {
      operationKey: '223e4567-e89b-42d3-a456-426614174000',
      qrCode: token,
      destination: 'warehouse',
      warehouseWeightKg: 408.5,
    });

    expect(result.weightComparison).toEqual({
      operatorReportedKg: 410,
      warehouseMeasuredKg: 408.5,
      differenceKg: -1.5,
      differencePercent: -0.366,
    });
    expect(getBag()).toEqual(
      expect.objectContaining({
        location: 'warehouse',
        currentKg: 408.5,
        lastWarehouseMeasuredKg: 408.5,
        status: 'available',
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:bigbag_warehouse_weight_recorded' }),
      expect.anything(),
    );
  });

  it('rejects a warehouse return weight above the latest shared Big-Bag weight', async () => {
    const { getBag, prisma, service } = lifecycleHarness({
      ...baseBag,
      registrationStatus: 'registered',
      location: 'production',
      locationRevision: 2,
      currentKg: 410,
      lastMeasuredKg: 410,
      lastActorRole: 'operator',
    });

    await expect(
      service.move(actor, {
        operationKey,
        qrCode: token,
        destination: 'warehouse',
        warehouseWeightKg: 410.001,
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'BIGBAG_WAREHOUSE_WEIGHT_INCREASE',
        previousKg: 410,
        warehouseWeightKg: 410.001,
      },
    });
    expect(prisma.bigBagUnit.update).not.toHaveBeenCalled();
    expect(getBag().currentKg).toBe(410);
  });

  it('replays an identical operation key without running a second transaction', async () => {
    const { movements, prisma, service } = lifecycleHarness();
    const result = {
      bag: { id: 'bag-1', location: 'warehouse' },
      movement: { kind: 'registration' },
      weightComparison: null,
    };
    movements.set(operationKey, {
      requestFingerprint: requestFingerprint({
        qrCode: token,
        destination: 'warehouse',
        warehouseWeightKg: null,
      }),
      resultSnapshot: result,
    });

    await expect(
      service.move(actor, {
        operationKey,
        qrCode: token,
        destination: 'warehouse',
      }),
    ).resolves.toEqual({
      ...result,
      bag: { ...result.bag, supplierName: null, receivedAt: null },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects operation-key reuse, unknown QR, same-location movement and an in-use return', async () => {
    const reused = lifecycleHarness();
    reused.movements.set(operationKey, {
      requestFingerprint: requestFingerprint({ different: true }),
      resultSnapshot: {},
    });
    await expect(
      reused.service.move(actor, {
        operationKey,
        qrCode: token,
        destination: 'warehouse',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    const unknown = lifecycleHarness();
    await expect(
      unknown.service.move(actor, {
        operationKey,
        qrCode: `bbt_${'b'.repeat(64)}`,
        destination: 'warehouse',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    const sameLocation = lifecycleHarness({
      ...baseBag,
      registrationStatus: 'registered',
      location: 'warehouse',
      locationRevision: 1,
    });
    await expect(
      sameLocation.service.move(actor, {
        operationKey,
        qrCode: token,
        destination: 'warehouse',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    const inUse = lifecycleHarness({
      ...baseBag,
      registrationStatus: 'registered',
      location: 'production',
      locationRevision: 2,
      status: 'in_use',
    });
    await expect(
      inUse.service.move(actor, {
        operationKey,
        qrCode: token,
        destination: 'warehouse',
        warehouseWeightKg: 400,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
