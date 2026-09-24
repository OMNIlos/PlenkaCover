import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Actor } from '../../common/auth/actor';
import { projectDomainEvent, type DomainEventRecord } from '../../common/audit/audit-projection';
import type { AuditService } from '../../common/audit/audit.service';
import type { PrismaService } from '../../common/prisma/prisma.service';
import {
  canonicalizeRollCoverageSpec,
  fingerprintRollFact,
  type CanonicalRollCoverageSpec,
} from './warehouse-coverage-canonical';
import { WarehouseRollCoverageFactService } from './warehouse-roll-coverage-fact.service';

const warehouseActor: Actor = {
  userId: 'warehouse-user-1',
  role: 'warehouse',
  capabilities: ['warehouse_coverage:resolve_recheck'],
};

const productionSpec = canonicalizeRollCoverageSpec({
  rollCode: 'ROLL-1',
  sourceOrderId: 'order-1',
  sourcePositionId: 'position-1',
  ownerCounterpartyId: 'counterparty-1',
  filmType: 'Полотно',
  actualThicknessMilliMicron: 80_000,
  accountingThicknessMilliMicron: 80_000,
  widthMilliMm: 1_700_000,
  plannedLengthMilliM: 275_000,
  birka: 'Бирка 1',
  spoolType: '76 мм',
  actualWeightMilliKg: 275_000,
  plannedWeightMilliKg: 275_000,
  ingredients: [
    { rawMaterialDefinitionId: 'material-a', shareBasisPoints: 8_000 },
    { rawMaterialDefinitionId: 'material-b', shareBasisPoints: 2_000 },
  ],
  recipeId: 'recipe-snapshot-1',
  recipeVersion: 'v7',
  recipeDefinitionId: 'recipe-definition-1',
  recipeDefinitionVersionId: 'recipe-definition-version-7',
  recipeVersionNumber: 7,
  policyVersion: 'warehouse-coverage-policy/v2',
});

function frozenDispatch(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dispatch-1',
    rollCode: 'ROLL-1',
    orderLineId: 'position-1',
    widthMm: 1700,
    plannedLengthM: 275,
    plannedWeightKg: 275,
    recipeVersion: 'v7',
    createdAt: new Date('2026-07-24T09:00:00.000Z'),
    characteristicsSnapshot: {
      filmType: 'Полотно',
      actualThickness: '80 мкм',
      accountingThickness: '80 мкм',
      widthMm: 1700,
      plannedLengthM: 275,
      birka: 'Бирка 1',
      spoolType: '76 мм',
      recipeId: 'recipe-snapshot-1',
      recipeDefinitionId: 'recipe-definition-1',
      recipeDefinitionVersionId: 'recipe-definition-version-7',
      recipeVersionNumber: 7,
      ingredients: [
        { rawMaterialDefinitionId: 'material-b', shareBasisPoints: 2_000 },
        { rawMaterialDefinitionId: 'material-a', shareBasisPoints: 8_000 },
      ],
    },
    productionOrder: {
      commercialOrderId: 'order-1',
      sourceCoverageCalculationId: 'calculation-1',
      sourceCoverageDecisionId: '00000000-0000-4000-8000-000000000001',
      sourceCoverageInputFingerprint: 'a'.repeat(64),
      sourceCoverageGeneration: 1,
      sourceCoverageCalculation: {
        id: 'calculation-1',
        orderId: 'order-1',
        generation: 1,
        positionVersions: [{ positionId: 'position-1', version: 1 }],
        inputFingerprint: 'a'.repeat(64),
      },
      sourceCoverageDecision: {
        id: '00000000-0000-4000-8000-000000000001',
        orderId: 'order-1',
        calculationId: 'calculation-1',
        generation: 1,
        kind: 'auto_produce_all',
        inputFingerprint: 'a'.repeat(64),
      },
      commercialOrder: {
        counterpartyId: 'counterparty-1',
        positions: [
          {
            id: 'position-1',
            orderId: 'order-1',
            widthMm: 1700,
            plannedLengthM: 275,
            version: 1,
            updatedAt: new Date('2026-07-24T08:00:00.000Z'),
          },
        ],
      },
    },
    operatorLine: {
      id: 'line-1',
      weightCaptures: [
        {
          id: 'capture-1',
          operatorRollLineId: 'line-1',
          kind: 'roll',
          stable: true,
          netKg: 275,
          actorRole: 'operator',
          actorId: 'operator-user-1',
          supersedesCaptureId: null,
          createdAt: new Date('2026-07-24T08:00:00.000Z'),
        },
      ],
    },
    ...overrides,
  };
}

function setup() {
  let dispatch = frozenDispatch();
  let currentFact: {
    id: string;
    rollId: string;
    version: number;
    sourceDispatchItemId: string | null;
    sourceWeightCaptureId: string | null;
    specFingerprint: string;
    spec: CanonicalRollCoverageSpec;
  } | null = null;
  let currentCoverageFactId: string | null = null;
  let ownerCounterpartyId: string | null = 'counterparty-1';
  const rawTx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'warehouse-roll-1' }]),
    rollDispatchItem: {
      findUnique: jest.fn().mockImplementation(() => Promise.resolve(dispatch)),
    },
    recipeSnapshot: {
      findUnique: jest.fn(),
    },
    warehouseRoll: {
      findUnique: jest.fn().mockImplementation(() =>
        Promise.resolve({
          id: 'warehouse-roll-1',
          rollCode: 'ROLL-1',
          ownerCounterpartyId,
          currentCoverageFactId,
          currentCoverageFact:
            currentFact && currentFact.id === currentCoverageFactId
              ? { id: currentFact.id, version: currentFact.version }
              : null,
        }),
      ),
      updateMany: jest
        .fn()
        .mockImplementation(
          ({
            where,
            data,
          }: {
            where: { currentCoverageFactId?: string | null };
            data: { ownerCounterpartyId?: string | null; currentCoverageFactId: string | null };
          }) => {
            const expectedPointer = Object.prototype.hasOwnProperty.call(
              where,
              'currentCoverageFactId',
            )
              ? (where.currentCoverageFactId ?? null)
              : currentCoverageFactId;
            if (currentCoverageFactId !== expectedPointer) {
              return Promise.resolve({ count: 0 });
            }
            if (Object.prototype.hasOwnProperty.call(data, 'ownerCounterpartyId')) {
              ownerCounterpartyId = data.ownerCounterpartyId ?? null;
            }
            currentCoverageFactId = data.currentCoverageFactId;
            return Promise.resolve({ count: 1 });
          },
        ),
    },
    warehouseRollCoverageFact: {
      aggregate: jest.fn().mockImplementation(() =>
        Promise.resolve({
          _max: { version: currentFact?.version ?? null },
        }),
      ),
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: { where: { sourceDispatchItemId?: string } }) => {
          if (
            where.sourceDispatchItemId !== undefined &&
            currentFact?.sourceDispatchItemId === where.sourceDispatchItemId
          ) {
            return Promise.resolve(currentFact);
          }
          return Promise.resolve(null);
        }),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        currentFact = {
          id: data.version === 1 ? 'fact-1' : `fact-${String(data.version)}`,
          rollId: String(data.rollId),
          version: Number(data.version),
          sourceDispatchItemId:
            typeof data.sourceDispatchItemId === 'string' ? data.sourceDispatchItemId : null,
          sourceWeightCaptureId:
            typeof data.sourceWeightCaptureId === 'string' ? data.sourceWeightCaptureId : null,
          specFingerprint: String(data.specFingerprint),
          spec: data.spec as CanonicalRollCoverageSpec,
        };
        return Promise.resolve(currentFact);
      }),
    },
    domainEvent: { create: jest.fn().mockResolvedValue({ id: 'event-1' }) },
  };
  const tx = rawTx as typeof rawTx & Prisma.TransactionClient;
  const prisma = tx as unknown as PrismaService;
  const audit = {
    record: jest.fn().mockResolvedValue({ id: 'event-1' }),
  } as unknown as AuditService & {
    record: jest.Mock;
  };
  const service = new WarehouseRollCoverageFactService(prisma, audit);
  return {
    service,
    prisma,
    tx,
    audit,
    setDispatch(next: ReturnType<typeof frozenDispatch>) {
      dispatch = next;
    },
    setCurrentFact(next: typeof currentFact) {
      currentFact = next;
      currentCoverageFactId = next?.id ?? null;
    },
    readCurrentFact() {
      return currentCoverageFactId;
    },
    readCurrentFactRecord() {
      return currentFact;
    },
    readOwner() {
      return ownerCounterpartyId;
    },
  };
}

describe('WarehouseRollCoverageFactService', () => {
  it('uses the dispatch snapshot and canonical capture, not the current recipe', async () => {
    const { service, tx, prisma } = setup();

    await expect(
      service.appendProductionHandoverFact(tx, {
        rollId: 'warehouse-roll-1',
        sourceDispatchItemId: 'dispatch-1',
        sourceWeightCaptureId: 'capture-1',
      }),
    ).resolves.toEqual({ factId: 'fact-1', version: 1 });

    expect(tx.warehouseRollCoverageFact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rollId: 'warehouse-roll-1',
          version: 1,
          source: 'production_handover',
          specVersion: 'warehouse-roll-coverage/v1',
          sourceDispatchItemId: 'dispatch-1',
          sourceWeightCaptureId: 'capture-1',
          sourceOrderId: 'order-1',
          sourcePositionId: 'position-1',
          actorKind: 'user',
          actorRole: 'operator',
          actorId: 'operator-user-1',
          reason: null,
          specFingerprint: fingerprintRollFact(productionSpec),
          spec: productionSpec,
        }),
      }),
    );
    expect(prisma.recipeSnapshot.findUnique).not.toHaveBeenCalled();
    expect(tx.warehouseRoll.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'warehouse-roll-1',
        currentCoverageFactId: null,
      },
      data: {
        ownerCounterpartyId: 'counterparty-1',
        currentCoverageFactId: 'fact-1',
      },
    });
  });

  it('reconciles missing legacy dimensions from the unchanged linked source position', async () => {
    const fixture = setup();
    fixture.setDispatch(
      frozenDispatch({
        widthMm: null,
        plannedLengthM: null,
        characteristicsSnapshot: {
          ...(frozenDispatch().characteristicsSnapshot as Record<string, unknown>),
          widthMm: undefined,
          plannedLengthM: undefined,
        },
      }),
    );

    await expect(
      fixture.service.appendProductionHandoverFact(fixture.tx, {
        rollId: 'warehouse-roll-1',
        sourceDispatchItemId: 'dispatch-1',
        sourceWeightCaptureId: 'capture-1',
      }),
    ).resolves.toEqual({ factId: 'fact-1', version: 1 });

    expect(fixture.tx.warehouseRollCoverageFact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          spec: expect.objectContaining({
            sourcePositionId: 'position-1',
            widthMilliMm: 1_700_000,
            plannedLengthMilliM: 275_000,
          }),
        }),
      }),
    );
  });

  it('does not reconcile legacy dimensions after the linked source position changed', async () => {
    const fixture = setup();
    const dispatch = frozenDispatch({
      widthMm: null,
      plannedLengthM: null,
      characteristicsSnapshot: {
        ...(frozenDispatch().characteristicsSnapshot as Record<string, unknown>),
        widthMm: undefined,
        plannedLengthM: undefined,
      },
    });
    fixture.setDispatch({
      ...dispatch,
      productionOrder: {
        ...dispatch.productionOrder,
        commercialOrder: {
          ...dispatch.productionOrder.commercialOrder,
          positions: [
            {
              id: 'position-1',
              orderId: 'order-1',
              widthMm: 1700,
              plannedLengthM: 275,
              version: 1,
              updatedAt: new Date('2026-07-24T10:00:00.000Z'),
            },
          ],
        },
      },
    });

    await expect(
      fixture.service.appendProductionHandoverFact(fixture.tx, {
        rollId: 'warehouse-roll-1',
        sourceDispatchItemId: 'dispatch-1',
        sourceWeightCaptureId: 'capture-1',
      }),
    ).resolves.toBeNull();

    expect(fixture.tx.warehouseRollCoverageFact.create).not.toHaveBeenCalled();
  });

  it('does not reconcile legacy dimensions from a different position version', async () => {
    const fixture = setup();
    const dispatch = frozenDispatch({
      widthMm: null,
      plannedLengthM: null,
      characteristicsSnapshot: {
        ...(frozenDispatch().characteristicsSnapshot as Record<string, unknown>),
        widthMm: undefined,
        plannedLengthM: undefined,
      },
    });
    fixture.setDispatch({
      ...dispatch,
      productionOrder: {
        ...dispatch.productionOrder,
        commercialOrder: {
          ...dispatch.productionOrder.commercialOrder,
          positions: dispatch.productionOrder.commercialOrder.positions.map((position) => ({
            ...position,
            version: 2,
          })),
        },
      },
    });

    await expect(
      fixture.service.appendProductionHandoverFact(fixture.tx, {
        rollId: 'warehouse-roll-1',
        sourceDispatchItemId: 'dispatch-1',
        sourceWeightCaptureId: 'capture-1',
      }),
    ).resolves.toBeNull();

    expect(fixture.tx.warehouseRollCoverageFact.create).not.toHaveBeenCalled();
  });

  it('does not reconcile legacy dimensions from a different coverage calculation', async () => {
    const fixture = setup();
    const dispatch = frozenDispatch({
      widthMm: null,
      plannedLengthM: null,
      characteristicsSnapshot: {
        ...(frozenDispatch().characteristicsSnapshot as Record<string, unknown>),
        widthMm: undefined,
        plannedLengthM: undefined,
      },
    });
    fixture.setDispatch({
      ...dispatch,
      productionOrder: {
        ...dispatch.productionOrder,
        sourceCoverageInputFingerprint: 'b'.repeat(64),
      },
    });

    await expect(
      fixture.service.appendProductionHandoverFact(fixture.tx, {
        rollId: 'warehouse-roll-1',
        sourceDispatchItemId: 'dispatch-1',
        sourceWeightCaptureId: 'capture-1',
      }),
    ).resolves.toBeNull();

    expect(fixture.tx.warehouseRollCoverageFact.create).not.toHaveBeenCalled();
  });

  it.each([
    [
      'decision belongs to another calculation',
      {
        sourceCoverageDecision: {
          ...frozenDispatch().productionOrder.sourceCoverageDecision,
          calculationId: 'calculation-2',
        },
      },
    ],
    ['production references another calculation', { sourceCoverageCalculationId: 'calculation-2' }],
    ['production references another decision', { sourceCoverageDecisionId: 'decision-2' }],
    ['production generation differs', { sourceCoverageGeneration: 2 }],
  ])('does not reconcile legacy dimensions when %s', async (_case, productionOverrides) => {
    const fixture = setup();
    const dispatch = frozenDispatch({
      widthMm: null,
      plannedLengthM: null,
      characteristicsSnapshot: {
        ...(frozenDispatch().characteristicsSnapshot as Record<string, unknown>),
        widthMm: undefined,
        plannedLengthM: undefined,
      },
    });
    fixture.setDispatch({
      ...dispatch,
      productionOrder: {
        ...dispatch.productionOrder,
        ...productionOverrides,
      },
    });

    await expect(
      fixture.service.appendProductionHandoverFact(fixture.tx, {
        rollId: 'warehouse-roll-1',
        sourceDispatchItemId: 'dispatch-1',
        sourceWeightCaptureId: 'capture-1',
      }),
    ).resolves.toBeNull();

    expect(fixture.tx.warehouseRollCoverageFact.create).not.toHaveBeenCalled();
  });

  it.each([
    [
      'snapshot and dispatch dimensions disagree',
      frozenDispatch({
        characteristicsSnapshot: {
          ...(frozenDispatch().characteristicsSnapshot as Record<string, unknown>),
          widthMm: 1600,
        },
      }),
    ],
    [
      'dispatch and unchanged position dimensions disagree',
      frozenDispatch({
        widthMm: 1600,
        characteristicsSnapshot: {
          ...(frozenDispatch().characteristicsSnapshot as Record<string, unknown>),
          widthMm: undefined,
        },
      }),
    ],
    [
      'a present snapshot dimension is malformed',
      frozenDispatch({
        characteristicsSnapshot: {
          ...(frozenDispatch().characteristicsSnapshot as Record<string, unknown>),
          widthMm: '1700',
        },
      }),
    ],
  ])('does not reconcile when %s', async (_case, dispatch) => {
    const fixture = setup();
    fixture.setDispatch(dispatch);

    await expect(
      fixture.service.appendProductionHandoverFact(fixture.tx, {
        rollId: 'warehouse-roll-1',
        sourceDispatchItemId: 'dispatch-1',
        sourceWeightCaptureId: 'capture-1',
      }),
    ).resolves.toBeNull();

    expect(fixture.tx.warehouseRollCoverageFact.create).not.toHaveBeenCalled();
  });

  it('returns an exact production replay without appending another version', async () => {
    const fixture = setup();
    const input = {
      rollId: 'warehouse-roll-1',
      sourceDispatchItemId: 'dispatch-1',
      sourceWeightCaptureId: 'capture-1',
    };

    await fixture.service.appendProductionHandoverFact(fixture.tx, input);
    await expect(fixture.service.appendProductionHandoverFact(fixture.tx, input)).resolves.toEqual({
      factId: 'fact-1',
      version: 1,
    });

    expect(fixture.tx.warehouseRollCoverageFact.create).toHaveBeenCalledTimes(1);
    expect(fixture.tx.warehouseRoll.updateMany).toHaveBeenCalledTimes(1);
  });

  it('replays an immutable legacy fact after the source position changes later', async () => {
    const fixture = setup();
    const legacyDispatch = frozenDispatch({
      widthMm: null,
      plannedLengthM: null,
      characteristicsSnapshot: {
        ...(frozenDispatch().characteristicsSnapshot as Record<string, unknown>),
        widthMm: undefined,
        plannedLengthM: undefined,
      },
    });
    const input = {
      rollId: 'warehouse-roll-1',
      sourceDispatchItemId: 'dispatch-1',
      sourceWeightCaptureId: 'capture-1',
    };
    fixture.setDispatch(legacyDispatch);
    await fixture.service.appendProductionHandoverFact(fixture.tx, input);

    fixture.setDispatch({
      ...legacyDispatch,
      productionOrder: {
        ...legacyDispatch.productionOrder,
        commercialOrder: {
          ...legacyDispatch.productionOrder.commercialOrder,
          positions: legacyDispatch.productionOrder.commercialOrder.positions.map((position) => ({
            ...position,
            version: 2,
            widthMm: 1800,
            updatedAt: new Date('2026-07-24T10:00:00.000Z'),
          })),
        },
      },
    });

    await expect(fixture.service.appendProductionHandoverFact(fixture.tx, input)).resolves.toEqual({
      factId: 'fact-1',
      version: 1,
    });
    expect(fixture.tx.warehouseRollCoverageFact.create).toHaveBeenCalledTimes(1);
    expect(fixture.tx.warehouseRoll.updateMany).toHaveBeenCalledTimes(1);
  });

  it('locks the immutable dispatch source before reading it and the destination roll', async () => {
    const fixture = setup();

    await fixture.service.appendProductionHandoverFact(fixture.tx, {
      rollId: 'warehouse-roll-1',
      sourceDispatchItemId: 'dispatch-1',
      sourceWeightCaptureId: 'capture-1',
    });

    expect(fixture.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(fixture.tx.$queryRaw.mock.calls[0][0].strings.join(' ')).toContain(
      'roll_dispatch_items',
    );
    expect(fixture.tx.$queryRaw.mock.calls[1][0].strings.join(' ')).toContain('warehouse_rolls');
    expect(fixture.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.tx.rollDispatchItem.findUnique.mock.invocationCallOrder[0],
    );
  });

  it('preserves only evidenced recipe provenance when the frozen snapshot has no definition id', async () => {
    const fixture = setup();
    fixture.setDispatch(
      frozenDispatch({
        characteristicsSnapshot: {
          filmType: 'Полотно',
          actualThickness: '80 мкм',
          accountingThickness: '80 мкм',
          widthMm: 1700,
          plannedLengthM: 275,
          birka: 'Бирка 1',
          spoolType: '76 мм',
          recipe: {
            recipeDefinitionVersionId: 'recipe-definition-version-7',
            version: 7,
            ingredients: [
              {
                rawMaterialDefinitionId: 'material-a',
                name: 'Первичное',
                shareBasisPoints: 8_000,
              },
              {
                rawMaterialDefinitionId: 'material-b',
                name: 'Добавка',
                shareBasisPoints: 2_000,
              },
            ],
          },
        },
      }),
    );

    await expect(
      fixture.service.appendProductionHandoverFact(fixture.tx, {
        rollId: 'warehouse-roll-1',
        sourceDispatchItemId: 'dispatch-1',
        sourceWeightCaptureId: 'capture-1',
      }),
    ).resolves.toEqual({ factId: 'fact-1', version: 1 });

    expect(fixture.tx.warehouseRollCoverageFact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          spec: expect.objectContaining({
            recipeDefinitionId: null,
            recipeDefinitionVersionId: 'recipe-definition-version-7',
            recipeVersionNumber: 7,
            ingredients: [
              { rawMaterialDefinitionId: 'material-a', shareBasisPoints: 8_000 },
              { rawMaterialDefinitionId: 'material-b', shareBasisPoints: 2_000 },
            ],
          }),
        }),
      }),
    );
  });

  it('returns 409 for a reused dispatch source with conflicting provenance', async () => {
    const fixture = setup();
    fixture.setCurrentFact({
      id: 'fact-existing',
      rollId: 'another-roll',
      version: 1,
      sourceDispatchItemId: 'dispatch-1',
      sourceWeightCaptureId: 'capture-other',
      specFingerprint: fingerprintRollFact(productionSpec),
      spec: productionSpec,
    });

    await expect(
      fixture.service.appendProductionHandoverFact(fixture.tx, {
        rollId: 'warehouse-roll-1',
        sourceDispatchItemId: 'dispatch-1',
        sourceWeightCaptureId: 'capture-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.tx.warehouseRollCoverageFact.create).not.toHaveBeenCalled();
  });

  it('returns 409 when the frozen source fingerprint differs from the persisted replay', async () => {
    const fixture = setup();
    const input = {
      rollId: 'warehouse-roll-1',
      sourceDispatchItemId: 'dispatch-1',
      sourceWeightCaptureId: 'capture-1',
    };
    await fixture.service.appendProductionHandoverFact(fixture.tx, input);
    fixture.setDispatch(
      frozenDispatch({
        characteristicsSnapshot: {
          ...(frozenDispatch().characteristicsSnapshot as Record<string, unknown>),
          filmType: 'Рукав',
        },
      }),
    );

    await expect(
      fixture.service.appendProductionHandoverFact(fixture.tx, input),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.tx.warehouseRollCoverageFact.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'missing frozen composition',
      frozenDispatch({
        characteristicsSnapshot: {
          ...(frozenDispatch().characteristicsSnapshot as Record<string, unknown>),
          ingredients: undefined,
        },
      }),
      'capture-1',
    ],
    ['non-canonical capture selection', frozenDispatch(), 'capture-not-canonical'],
  ])('leaves currentCoverageFactId null for %s', async (_case, dispatch, captureId) => {
    const fixture = setup();
    fixture.setDispatch(dispatch);

    await expect(
      fixture.service.appendProductionHandoverFact(fixture.tx, {
        rollId: 'warehouse-roll-1',
        sourceDispatchItemId: 'dispatch-1',
        sourceWeightCaptureId: captureId,
      }),
    ).resolves.toBeNull();

    expect(fixture.readCurrentFact()).toBeNull();
    expect(fixture.tx.warehouseRollCoverageFact.create).not.toHaveBeenCalled();
    expect(fixture.tx.warehouseRoll.updateMany).not.toHaveBeenCalled();
  });

  it('does not persist a production fact from a negative canonical capture', async () => {
    const fixture = setup();
    const dispatch = frozenDispatch();
    fixture.setDispatch({
      ...dispatch,
      operatorLine: {
        ...dispatch.operatorLine,
        weightCaptures: dispatch.operatorLine.weightCaptures.map((capture) => ({
          ...capture,
          netKg: -0.55,
        })),
      },
    });

    await expect(
      fixture.service.appendProductionHandoverFact(fixture.tx, {
        rollId: 'warehouse-roll-1',
        sourceDispatchItemId: 'dispatch-1',
        sourceWeightCaptureId: 'capture-1',
      }),
    ).resolves.toBeNull();

    expect(fixture.readCurrentFact()).toBeNull();
    expect(fixture.tx.warehouseRollCoverageFact.create).not.toHaveBeenCalled();
    expect(fixture.tx.warehouseRoll.updateMany).not.toHaveBeenCalled();
  });

  it('clears a stale verified pointer when frozen production evidence is incomplete', async () => {
    const fixture = setup();
    fixture.setCurrentFact({
      id: 'stale-fact',
      rollId: 'warehouse-roll-1',
      version: 4,
      sourceDispatchItemId: 'old-dispatch',
      sourceWeightCaptureId: 'old-capture',
      specFingerprint: fingerprintRollFact(productionSpec),
      spec: productionSpec,
    });
    fixture.setDispatch(
      frozenDispatch({
        characteristicsSnapshot: {
          ...(frozenDispatch().characteristicsSnapshot as Record<string, unknown>),
          ingredients: undefined,
        },
      }),
    );

    await expect(
      fixture.service.appendProductionHandoverFact(fixture.tx, {
        rollId: 'warehouse-roll-1',
        sourceDispatchItemId: 'dispatch-1',
        sourceWeightCaptureId: 'capture-1',
      }),
    ).resolves.toBeNull();

    expect(fixture.readCurrentFact()).toBeNull();
    expect(fixture.tx.warehouseRoll.updateMany).toHaveBeenCalledWith({
      where: { id: 'warehouse-roll-1', currentCoverageFactId: 'stale-fact' },
      data: { currentCoverageFactId: null },
    });
  });

  it('returns a conflict instead of hiding a concurrent stale-pointer change', async () => {
    const fixture = setup();
    fixture.setCurrentFact({
      id: 'stale-fact',
      rollId: 'warehouse-roll-1',
      version: 4,
      sourceDispatchItemId: 'old-dispatch',
      sourceWeightCaptureId: 'old-capture',
      specFingerprint: fingerprintRollFact(productionSpec),
      spec: productionSpec,
    });
    fixture.setDispatch(
      frozenDispatch({
        characteristicsSnapshot: {
          ...(frozenDispatch().characteristicsSnapshot as Record<string, unknown>),
          ingredients: undefined,
        },
      }),
    );
    fixture.tx.warehouseRoll.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      fixture.service.appendProductionHandoverFact(fixture.tx, {
        rollId: 'warehouse-roll-1',
        sourceDispatchItemId: 'dispatch-1',
        sourceWeightCaptureId: 'capture-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.readCurrentFact()).toBe('stale-fact');
  });

  it('replays unknown coverage without issuing a second pointer mutation', async () => {
    const fixture = setup();
    fixture.setCurrentFact({
      id: 'stale-fact',
      rollId: 'warehouse-roll-1',
      version: 4,
      sourceDispatchItemId: 'old-dispatch',
      sourceWeightCaptureId: 'old-capture',
      specFingerprint: fingerprintRollFact(productionSpec),
      spec: productionSpec,
    });
    fixture.setDispatch(
      frozenDispatch({
        characteristicsSnapshot: {
          ...(frozenDispatch().characteristicsSnapshot as Record<string, unknown>),
          ingredients: undefined,
        },
      }),
    );
    const input = {
      rollId: 'warehouse-roll-1',
      sourceDispatchItemId: 'dispatch-1',
      sourceWeightCaptureId: 'capture-1',
    };

    await expect(
      fixture.service.appendProductionHandoverFact(fixture.tx, input),
    ).resolves.toBeNull();
    await expect(
      fixture.service.appendProductionHandoverFact(fixture.tx, input),
    ).resolves.toBeNull();

    expect(fixture.tx.warehouseRoll.updateMany).toHaveBeenCalledTimes(1);
    expect(fixture.readCurrentFact()).toBeNull();
  });

  it('treats duplicate independent roll captures as ambiguous evidence', async () => {
    const fixture = setup();
    const dispatch = frozenDispatch();
    const baseCapture = dispatch.operatorLine.weightCaptures[0]!;
    fixture.setDispatch({
      ...dispatch,
      operatorLine: {
        ...dispatch.operatorLine,
        weightCaptures: [
          baseCapture,
          {
            ...baseCapture,
            id: 'capture-ambiguous',
            netKg: 276,
            createdAt: new Date('2026-07-24T08:01:00.000Z'),
          },
        ],
      },
    });

    await expect(
      fixture.service.appendProductionHandoverFact(fixture.tx, {
        rollId: 'warehouse-roll-1',
        sourceDispatchItemId: 'dispatch-1',
        sourceWeightCaptureId: 'capture-1',
      }),
    ).resolves.toBeNull();

    expect(fixture.tx.warehouseRollCoverageFact.create).not.toHaveBeenCalled();
    expect(fixture.readCurrentFact()).toBeNull();
  });

  it('keeps an appended roll fact immutable after the mutable recipe is corrected', async () => {
    const fixture = setup();
    const input = {
      rollId: 'warehouse-roll-1',
      sourceDispatchItemId: 'dispatch-1',
      sourceWeightCaptureId: 'capture-1',
    };
    await fixture.service.appendProductionHandoverFact(fixture.tx, input);
    const before = fixture.readCurrentFactRecord();

    fixture.tx.recipeSnapshot.findUnique.mockResolvedValue({
      version: 'v8',
      ingredients: [{ rawMaterialDefinitionId: 'material-c', shareBasisPoints: 10_000 }],
    });

    await expect(fixture.service.appendProductionHandoverFact(fixture.tx, input)).resolves.toEqual({
      factId: 'fact-1',
      version: 1,
    });
    expect(fixture.readCurrentFactRecord()).toEqual(before);
    expect(fixture.tx.recipeSnapshot.findUnique).not.toHaveBeenCalled();
    expect(fixture.tx.warehouseRollCoverageFact.create).toHaveBeenCalledTimes(1);
  });

  it('derives roll ownership and immutable fact from one resolved next spec', async () => {
    const fixture = setup();
    fixture.setCurrentFact({
      id: 'fact-1',
      rollId: 'warehouse-roll-1',
      version: 1,
      sourceDispatchItemId: 'dispatch-1',
      sourceWeightCaptureId: 'capture-1',
      specFingerprint: fingerprintRollFact(productionSpec),
      spec: productionSpec,
    });
    const nextSpec = canonicalizeRollCoverageSpec({
      ...productionSpec,
      ownerCounterpartyId: 'counterparty-2',
      actualWeightMilliKg: 274_500,
    });

    await expect(
      fixture.service.appendWarehouseCorrection(
        fixture.tx,
        {
          rollId: 'warehouse-roll-1',
          expectedFactVersion: 1,
          nextSpec,
          reason: 'Повторная проверка состава и владельца',
        },
        warehouseActor,
      ),
    ).resolves.toEqual({ factId: 'fact-2', version: 2 });

    expect(fixture.tx.warehouseRollCoverageFact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rollId: 'warehouse-roll-1',
          version: 2,
          source: 'warehouse_recheck',
          spec: nextSpec,
          specFingerprint: fingerprintRollFact(nextSpec),
          actorKind: 'user',
          actorRole: 'warehouse',
          actorId: warehouseActor.userId,
          reason: 'Повторная проверка состава и владельца',
        }),
      }),
    );
    expect(fixture.tx.warehouseRoll.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'warehouse-roll-1',
        currentCoverageFactId: 'fact-1',
      },
      data: {
        ownerCounterpartyId: 'counterparty-2',
        currentCoverageFactId: 'fact-2',
      },
    });
    expect(fixture.readOwner()).toBe('counterparty-2');
    expect(fixture.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:warehouse_roll_coverage_fact_corrected',
        actorRole: 'warehouse',
        actorId: warehouseActor.userId,
        objectId: 'warehouse-roll-1',
        reason: 'Повторная проверка состава и владельца',
        detail: expect.objectContaining({
          workflowVersion: 2,
          sourceOrderId: 'order-1',
          sourcePositionId: 'position-1',
        }),
      }),
      fixture.tx,
    );
    const recorded = fixture.audit.record.mock.calls.find(
      ([input]) => input.type === 'audit:warehouse_roll_coverage_fact_corrected',
    )?.[0];
    if (!recorded) throw new Error('Correction audit event was not recorded');
    const persisted: DomainEventRecord = {
      id: 'event-correction',
      family: 'audit',
      type: recorded.type,
      objectId: recorded.objectId ?? null,
      actorKind: 'user',
      actorRole: 'warehouse',
      actorId: warehouseActor.userId,
      systemActorKey: null,
      label: recorded.label ?? null,
      detail: recorded.detail,
      oldValue: recorded.oldValue,
      newValue: recorded.newValue,
      reason: recorded.reason ?? null,
      sourceSnapshotId: recorded.sourceSnapshotId ?? null,
      createdAt: new Date('2026-07-25T08:00:00.000Z'),
    };
    for (const audience of ['commercial', 'director'] as const) {
      const serialized = JSON.stringify(projectDomainEvent(persisted, audience));
      expect(serialized).not.toMatch(
        /counterparty-1|counterparty-2|order-1|position-1|[a-f0-9]{64}/u,
      );
    }
  });

  it('rejects a stale expected fact version before appending a correction', async () => {
    const fixture = setup();
    fixture.setCurrentFact({
      id: 'fact-2',
      rollId: 'warehouse-roll-1',
      version: 2,
      sourceDispatchItemId: null,
      sourceWeightCaptureId: null,
      specFingerprint: fingerprintRollFact(productionSpec),
      spec: productionSpec,
    });

    await expect(
      fixture.service.appendWarehouseCorrection(
        fixture.tx,
        {
          rollId: 'warehouse-roll-1',
          expectedFactVersion: 1,
          nextSpec: productionSpec,
          reason: 'Устаревшая попытка исправления',
        },
        warehouseActor,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.tx.warehouseRollCoverageFact.create).not.toHaveBeenCalled();
  });

  it('fails the correction when the current-fact CAS loses a race', async () => {
    const fixture = setup();
    fixture.tx.warehouseRoll.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      fixture.service.appendWarehouseCorrection(
        fixture.tx,
        {
          rollId: 'warehouse-roll-1',
          expectedFactVersion: null,
          nextSpec: productionSpec,
          reason: 'Первичная проверка полного факта',
        },
        warehouseActor,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.audit.record).not.toHaveBeenCalled();
  });
});
