import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { AuditService } from '../../common/audit/audit.service';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CommercialController } from './commercial.controller';
import { MaterialShortageCorrectionService } from './material-shortage-correction.service';

const ACTOR = { userId: 'commercial-1', role: 'commercial' } as const;
const CORRECTION = {
  problemId: 'problem-1',
  fromRollId: 'A-1-roll-3',
  newRawMaterialId: 'rm-recycled-pvd',
  newParameters: [{ label: 'Сырьё', value: 'ПВД вторичное' }],
  reason: 'Первичного сырья недостаточно',
};

type FakeState = {
  problemStatus: string;
  resolutionCaseStatus: string | null;
  recipeVersion: string;
  recipeParameters: unknown;
  recipeHistory: number[];
  positionRawMaterialId: string;
  rolls: Record<
    string,
    {
      rawMaterialId: string;
      recipeVersion: string;
      characteristicsSnapshot: unknown;
    }
  >;
  auditTypes: string[];
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function p2034() {
  return new Prisma.PrismaClientKnownRequestError('Transaction write conflict', {
    code: 'P2034',
    clientVersion: '6.2.1',
  });
}

async function setupCorrectionService() {
  const target: any = {
    id: 'roll-3',
    rollCode: 'A-1-roll-3',
    productionOrderId: 'po1',
    orderLineId: 'pos1',
    assignedOperatorId: 'operator-1',
    positionSequence: 3,
    completedAt: null,
    status: 'assigned',
    characteristicsSnapshot: {
      rawMaterialId: 'rm-primary-pvd',
      recipeVersion: 'v1',
      preserved: { source: 'target' },
    },
    operatorLine: {
      spoolKg: null,
      grossKg: null,
      netKg: null,
      warehouseState: 'not_ready',
      weightCaptures: [],
    },
  };
  const future: any = {
    ...target,
    id: 'roll-4',
    rollCode: 'A-1-roll-4',
    positionSequence: 4,
    characteristicsSnapshot: {
      rawMaterialId: 'rm-primary-pvd',
      recipeVersion: 'v1',
      preserved: { source: 'future' },
    },
    operatorLine: { ...target.operatorLine, weightCaptures: [] },
  };
  const completed: any = {
    ...target,
    id: 'roll-5',
    rollCode: 'A-1-roll-5',
    positionSequence: 5,
    status: 'done',
    completedAt: new Date('2026-07-11T08:00:00.000Z'),
    characteristicsSnapshot: {
      rawMaterialId: 'rm-primary-pvd',
      recipeVersion: 'v1',
      preserved: { source: 'completed' },
    },
    operatorLine: {
      spoolKg: 2,
      grossKg: 43,
      netKg: 41.2,
      warehouseState: 'sent',
      weightCaptures: [{ kind: 'roll', grossKg: 43, netKg: 41.2 }],
    },
  };
  const initialState: FakeState = {
    problemStatus: 'open',
    resolutionCaseStatus: null,
    recipeVersion: 'v1',
    recipeParameters: [{ label: 'Сырьё', value: 'ПВД первичное' }],
    recipeHistory: [],
    positionRawMaterialId: 'rm-primary-pvd',
    rolls: Object.fromEntries(
      [target, future, completed].map((item) => [
        item.id,
        {
          rawMaterialId: 'rm-primary-pvd',
          recipeVersion: 'v1',
          characteristicsSnapshot: clone(item.characteristicsSnapshot),
        },
      ]),
    ),
    auditTypes: [],
  };
  const committedState = clone(initialState);
  let activeState: FakeState | null = null;
  let failSerializationAtCommit = false;
  let failAuditCall: number | null = null;
  let auditCall = 0;

  const requireActiveState = () => {
    if (!activeState) throw new Error('Fake transaction is not active');
    return activeState;
  };
  const prisma: any = {
    $queryRaw: jest.fn(async () => [{ id: target.id }, { id: future.id }, { id: completed.id }]),
    productionProblem: {
      findFirst: jest.fn(async () => {
        if (requireActiveState().problemStatus !== 'open') return null;
        return {
          id: 'problem-1',
          orderId: 'co1',
          positionId: 'pos1',
          rollId: 'A-1-roll-3',
          type: 'raw_material_shortage',
          status: 'open',
        };
      }),
      updateMany: jest.fn(async () => {
        const state = requireActiveState();
        if (state.problemStatus !== 'open') return { count: 0 };
        state.problemStatus = 'resolved';
        return { count: 1 };
      }),
    },
    commercialOrderPosition: {
      findFirst: jest.fn(async () => ({
        id: 'pos1',
        orderId: 'co1',
        rawMaterialId: requireActiveState().positionRawMaterialId,
        recipe: {
          id: 'recipe-1',
          version: requireActiveState().recipeVersion,
          parameters: clone(requireActiveState().recipeParameters),
        },
      })),
      update: jest.fn(async ({ data }: any) => {
        requireActiveState().positionRawMaterialId = data.rawMaterialId;
        return { id: 'pos1' };
      }),
    },
    rollDispatchItem: {
      findFirst: jest.fn(async () => target),
      findUnique: jest.fn(async () => target),
      findMany: jest.fn(async () => [target, future, completed]),
      update: jest.fn(async ({ where, data }: any) => {
        const roll = requireActiveState().rolls[where.id];
        roll.rawMaterialId = data.rawMaterialId;
        roll.recipeVersion = data.recipeVersion;
        roll.characteristicsSnapshot = clone(data.characteristicsSnapshot);
        return {};
      }),
    },
    recipeSnapshot: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        const state = requireActiveState();
        if (state.recipeVersion !== where.version) return { count: 0 };
        state.recipeVersion = data.version;
        state.recipeParameters = clone(data.parameters);
        return { count: 1 };
      }),
    },
    recipeSnapshotVersion: {
      upsert: jest.fn(async ({ where }: any) => {
        const version = where.recipeSnapshotId_version.version;
        const state = requireActiveState();
        if (!state.recipeHistory.includes(version)) state.recipeHistory.push(version);
        return { id: `recipe-version-${version}`, version };
      }),
      create: jest.fn(async ({ data }: any) => {
        const state = requireActiveState();
        if (state.recipeHistory.includes(data.version)) throw new Error('duplicate recipe version');
        state.recipeHistory.push(data.version);
        return { id: `recipe-version-${data.version}`, version: data.version };
      }),
    },
    orderResolutionCase: {
      create: jest.fn(async () => {
        const state = requireActiveState();
        if (state.resolutionCaseStatus) throw new Error('duplicate resolution case');
        state.resolutionCaseStatus = 'open';
        return { id: 'case-shortage-1', status: 'open', version: 1 };
      }),
      updateMany: jest.fn(async () => {
        const state = requireActiveState();
        if (state.resolutionCaseStatus !== 'open') return { count: 0 };
        state.resolutionCaseStatus = 'resolved';
        return { count: 1 };
      }),
    },
    financeOrder: {
      update: jest.fn(),
    },
  };
  prisma.$transaction = jest.fn(async (callback: (tx: any) => unknown) => {
    activeState = clone(committedState);
    auditCall = 0;
    try {
      const result = await callback(prisma);
      if (failSerializationAtCommit) throw p2034();
      Object.assign(committedState, clone(activeState));
      return result;
    } finally {
      activeState = null;
    }
  });
  const audit = {
    record: jest.fn(async (input: { type: string }, tx: any) => {
      if (tx !== prisma) throw new Error('Audit escaped the transaction');
      auditCall += 1;
      if (failAuditCall === auditCall) throw new Error('audit failed');
      requireActiveState().auditTypes.push(input.type);
      return { id: `event-${auditCall}` };
    }),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      MaterialShortageCorrectionService,
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: audit },
    ],
  }).compile();
  return {
    service: moduleRef.get(MaterialShortageCorrectionService),
    prisma,
    audit,
    records: { target, future, completed },
    initialState: clone(initialState),
    state: () => clone(committedState),
    failAuditAt: (call: number) => {
      failAuditCall = call;
    },
    failWithSerializationConflict: () => {
      failSerializationAtCommit = true;
    },
  };
}

describe('MaterialShortageCorrectionService', () => {
  it('atomically updates the recipe, position, eligible snapshots and all three audits', async () => {
    const { service, prisma, audit, state } = await setupCorrectionService();

    await expect(service.apply(ACTOR, 'co1', CORRECTION)).resolves.toEqual({
      caseId: 'case-shortage-1',
      problemId: 'problem-1',
      status: 'resolved',
      oldRecipeVersionId: 'recipe-version-1',
      newRecipeVersionId: 'recipe-version-2',
      recipeVersion: 'v2',
      affectedRollIds: ['A-1-roll-3', 'A-1-roll-4'],
    });

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
    expect(prisma.productionProblem.findFirst).toHaveBeenCalledWith({
      where: {
        id: CORRECTION.problemId,
        orderId: 'co1',
        type: 'raw_material_shortage',
        status: 'open',
      },
    });
    expect(prisma.commercialOrderPosition.findFirst).toHaveBeenCalledWith({
      where: { id: 'pos1', orderId: 'co1' },
      include: { recipe: true },
    });
    expect(prisma.rollDispatchItem.findFirst).toHaveBeenCalledWith({
      where: {
        rollCode: CORRECTION.fromRollId,
        orderLineId: 'pos1',
        productionOrder: { commercialOrderId: 'co1' },
      },
      select: {
        id: true,
        productionOrderId: true,
        orderLineId: true,
        positionSequence: true,
      },
    });
    expect(prisma.rollDispatchItem.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        productionOrderId: 'po1',
        orderLineId: 'pos1',
        positionSequence: { gte: 3 },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.rollDispatchItem.findUnique).toHaveBeenCalledWith({
      where: { id: 'roll-3' },
      include: { operatorLine: { include: { weightCaptures: true } } },
    });
    expect(prisma.rollDispatchItem.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        productionOrderId: 'po1',
        orderLineId: 'pos1',
        positionSequence: { gte: 3 },
      },
      include: { operatorLine: { include: { weightCaptures: true } } },
      orderBy: [{ positionSequence: 'asc' }, { id: 'asc' }],
    });
    expect(prisma.productionProblem.updateMany).toHaveBeenCalledWith({
      where: { id: 'problem-1', status: 'open' },
      data: {
        status: 'resolved',
        resolvedAt: expect.any(Date),
        resolvedById: ACTOR.userId,
      },
    });
    expect(prisma.recipeSnapshot.updateMany).toHaveBeenCalledWith({
      where: { id: 'recipe-1', version: 'v1' },
      data: { version: 'v2', parameters: CORRECTION.newParameters },
    });
    expect(prisma.recipeSnapshotVersion.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { recipeSnapshotId_version: { recipeSnapshotId: 'recipe-1', version: 1 } },
      }),
    );
    expect(prisma.recipeSnapshotVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recipeSnapshotId: 'recipe-1',
          version: 2,
          parameters: CORRECTION.newParameters,
          source: 'material_shortage_correction',
        }),
      }),
    );
    expect(prisma.orderResolutionCase.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'co1',
        problemId: 'problem-1',
        type: 'material_shortage_correction',
        status: 'open',
        ownerRole: 'commercial',
      }),
    });
    expect(prisma.orderResolutionCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'case-shortage-1', status: 'open', version: 1 },
        data: expect.objectContaining({ status: 'resolved', outcome: 'material_substituted' }),
      }),
    );
    expect(prisma.commercialOrderPosition.update).toHaveBeenCalledWith({
      where: { id: 'pos1' },
      data: { rawMaterialId: 'rm-recycled-pvd' },
    });
    expect(prisma.rollDispatchItem.update).toHaveBeenCalledTimes(2);
    expect(prisma.rollDispatchItem.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'roll-5' } }),
    );
    expect(audit.record.mock.calls.map(([input]) => input.type)).toEqual([
      'audit:recipe_correction_applied',
      'audit:raw_material_shortage_resolved',
      'notification:commercial_correction_applied',
      'notification:operator_recipe_changed',
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notification:commercial_correction_applied',
        objectId: 'co1',
        detail: expect.objectContaining({
          notificationKey: 'correction:case-shortage-1:v2',
          recipientRoles: [
            'commercial',
            'production_lead',
            'operator',
            'warehouse',
            'finance',
            'director',
          ],
          recipientUserIds: ['operator-1'],
          orderId: 'co1',
          positionId: 'pos1',
          rollIds: ['A-1-roll-3', 'A-1-roll-4'],
        }),
      }),
      prisma,
    );
    expect(audit.record.mock.calls.every(([, tx]) => tx === prisma)).toBe(true);
    expect(prisma.financeOrder.update).not.toHaveBeenCalled();

    expect(state()).toEqual({
      problemStatus: 'resolved',
      resolutionCaseStatus: 'resolved',
      recipeVersion: 'v2',
      recipeParameters: CORRECTION.newParameters,
      recipeHistory: [1, 2],
      positionRawMaterialId: 'rm-recycled-pvd',
      rolls: {
        'roll-3': {
          rawMaterialId: 'rm-recycled-pvd',
          recipeVersion: 'v2',
          characteristicsSnapshot: {
            rawMaterialId: 'rm-recycled-pvd',
            recipeVersion: 'v2',
            recipeParameters: CORRECTION.newParameters,
            preserved: { source: 'target' },
          },
        },
        'roll-4': {
          rawMaterialId: 'rm-recycled-pvd',
          recipeVersion: 'v2',
          characteristicsSnapshot: {
            rawMaterialId: 'rm-recycled-pvd',
            recipeVersion: 'v2',
            recipeParameters: CORRECTION.newParameters,
            preserved: { source: 'future' },
          },
        },
        'roll-5': {
          rawMaterialId: 'rm-primary-pvd',
          recipeVersion: 'v1',
          characteristicsSnapshot: {
            rawMaterialId: 'rm-primary-pvd',
            recipeVersion: 'v1',
            preserved: { source: 'completed' },
          },
        },
      },
      auditTypes: [
        'audit:recipe_correction_applied',
        'audit:raw_material_shortage_resolved',
        'notification:commercial_correction_applied',
        'notification:operator_recipe_changed',
      ],
    });
  });

  it('locks every candidate in stable order before authoritative weight eligibility reads', async () => {
    const { service, prisma, records } = await setupCorrectionService();
    const order: string[] = [];
    prisma.rollDispatchItem.findFirst.mockImplementation(async () => {
      order.push('target-identity-read');
      return records.target;
    });
    prisma.rollDispatchItem.findMany.mockImplementation(async ({ select }: any) => {
      if (select) {
        order.push('candidate-id-read');
        return [{ id: 'roll-5' }, { id: 'roll-3' }, { id: 'roll-4' }];
      }
      order.push('authoritative-candidate-read');
      return [records.target, records.future, records.completed];
    });
    prisma.$queryRaw.mockImplementation(async () => {
      order.push('dispatch-lock');
      return [{ id: 'roll-3' }, { id: 'roll-4' }, { id: 'roll-5' }];
    });
    prisma.rollDispatchItem.findUnique.mockImplementation(async () => {
      order.push('authoritative-target-read');
      return records.target;
    });

    await service.apply(ACTOR, 'co1', CORRECTION);

    expect(order).toEqual([
      'target-identity-read',
      'candidate-id-read',
      'dispatch-lock',
      'authoritative-target-read',
      'authoritative-candidate-read',
    ]);
    expect(prisma.rollDispatchItem.findFirst).toHaveBeenCalledWith({
      where: {
        rollCode: CORRECTION.fromRollId,
        orderLineId: 'pos1',
        productionOrder: { commercialOrderId: 'co1' },
      },
      select: {
        id: true,
        productionOrderId: true,
        orderLineId: true,
        positionSequence: true,
      },
    });
    expect(prisma.rollDispatchItem.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        productionOrderId: 'po1',
        orderLineId: 'pos1',
        positionSequence: { gte: 3 },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    expect(prisma.rollDispatchItem.findUnique).toHaveBeenCalledWith({
      where: { id: 'roll-3' },
      include: { operatorLine: { include: { weightCaptures: true } } },
    });
    expect(prisma.rollDispatchItem.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        productionOrderId: 'po1',
        orderLineId: 'pos1',
        positionSequence: { gte: 3 },
      },
      include: { operatorLine: { include: { weightCaptures: true } } },
      orderBy: [{ positionSequence: 'asc' }, { id: 'asc' }],
    });
    const [lockQuery] = prisma.$queryRaw.mock.calls[0];
    expect(lockQuery.values).toEqual(['roll-3', 'roll-4', 'roll-5']);
    expect(lockQuery.strings.join('?').replace(/\s+/g, ' ').trim()).toBe(
      'SELECT "id" FROM "roll_dispatch_items" WHERE "id" IN (?,?,?) ORDER BY "id" FOR UPDATE',
    );
  });

  it('rejects a closed or foreign shortage without partial writes', async () => {
    const { service, prisma, initialState, state } = await setupCorrectionService();
    prisma.productionProblem.findFirst.mockResolvedValueOnce(null);

    await expect(service.apply(ACTOR, 'co1', CORRECTION)).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.commercialOrderPosition.update).not.toHaveBeenCalled();
    expect(state()).toEqual(initialState);
  });

  it.each([
    ['operator gross weight', (target: any) => (target.operatorLine.grossKg = 43)],
    ['operator net weight', (target: any) => (target.operatorLine.netKg = 41)],
    [
      'persisted roll-weight capture',
      (target: any) =>
        target.operatorLine.weightCaptures.push({ kind: 'roll', grossKg: null, netKg: null }),
    ],
    [
      'persisted gross capture',
      (target: any) =>
        target.operatorLine.weightCaptures.push({ kind: 'roll', grossKg: 43, netKg: null }),
    ],
    [
      'persisted net capture',
      (target: any) =>
        target.operatorLine.weightCaptures.push({ kind: 'roll', grossKg: 43, netKg: 41 }),
    ],
  ])('blocks correction after %s', async (_label, arrange) => {
    const { service, prisma, records, initialState, state } = await setupCorrectionService();
    arrange(records.target);

    await expect(service.apply(ACTOR, 'co1', CORRECTION)).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.productionProblem.updateMany).not.toHaveBeenCalled();
    expect(state()).toEqual(initialState);
  });

  it.each([
    ['persisted spool weight', (target: any) => (target.operatorLine.spoolKg = 2)],
    [
      'persisted spool capture',
      (target: any) =>
        target.operatorLine.weightCaptures.push({
          kind: 'spool',
          grossKg: 2,
          spoolKg: 2,
          netKg: null,
        }),
    ],
  ])('blocks the target after %s', async (_label, arrange) => {
    const { service, prisma, records, initialState, state } = await setupCorrectionService();
    arrange(records.target);

    await expect(service.apply(ACTOR, 'co1', CORRECTION)).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.productionProblem.updateMany).not.toHaveBeenCalled();
    expect(state()).toEqual(initialState);
  });

  it('excludes a future candidate after spool weighing', async () => {
    const { service, prisma, records, state } = await setupCorrectionService();
    records.future.operatorLine.weightCaptures.push({
      kind: 'spool',
      grossKg: 2,
      spoolKg: 2,
      netKg: null,
    });

    await expect(service.apply(ACTOR, 'co1', CORRECTION)).resolves.toMatchObject({
      status: 'resolved',
      affectedRollIds: ['A-1-roll-3'],
    });
    expect(prisma.rollDispatchItem.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'roll-4' } }),
    );
    expect(state().rolls['roll-4'].rawMaterialId).toBe('rm-primary-pvd');
  });

  it('keeps an accepted target eligible while it has no weight or downstream facts', async () => {
    const { service, records } = await setupCorrectionService();
    records.target.operatorLine.step = 'spool_weight';

    await expect(service.apply(ACTOR, 'co1', CORRECTION)).resolves.toMatchObject({
      status: 'resolved',
      affectedRollIds: ['A-1-roll-3', 'A-1-roll-4'],
    });
  });

  it.each(['ready_for_handover', 'missing', 'sent', 'received', 'delivered'])(
    'treats warehouse state %s as an immutable downstream fact',
    async (warehouseState) => {
      const { service, prisma, records, initialState, state } = await setupCorrectionService();
      records.target.operatorLine.warehouseState = warehouseState;

      await expect(service.apply(ACTOR, 'co1', CORRECTION)).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(prisma.productionProblem.updateMany).not.toHaveBeenCalled();
      expect(state()).toEqual(initialState);
    },
  );

  it('accepts null snapshots and creates a correction object', async () => {
    const { service, records, state } = await setupCorrectionService();
    records.target.characteristicsSnapshot = null;

    await service.apply(ACTOR, 'co1', CORRECTION);

    expect(state().rolls['roll-3'].characteristicsSnapshot).toEqual({
      rawMaterialId: 'rm-recycled-pvd',
      recipeVersion: 'v2',
      recipeParameters: CORRECTION.newParameters,
    });
  });

  it.each([
    ['scalar', 'malformed'],
    ['array', [{ rawMaterialId: 'rm-primary-pvd' }]],
  ])('rejects a %s snapshot instead of silently replacing it', async (_label, snapshot) => {
    const { service, prisma, records, initialState, state } = await setupCorrectionService();
    records.target.characteristicsSnapshot = snapshot;

    await expect(service.apply(ACTOR, 'co1', CORRECTION)).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.productionProblem.updateMany).not.toHaveBeenCalled();
    expect(prisma.rollDispatchItem.update).not.toHaveBeenCalled();
    expect(state()).toEqual(initialState);
  });

  it('rolls back cleanly when the problem CAS loses', async () => {
    const { service, prisma, audit, initialState, state } = await setupCorrectionService();
    prisma.productionProblem.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.apply(ACTOR, 'co1', CORRECTION)).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.recipeSnapshot.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(state()).toEqual(initialState);
  });

  it('rolls back the problem claim when the recipe CAS loses', async () => {
    const { service, prisma, audit, initialState, state } = await setupCorrectionService();
    prisma.recipeSnapshot.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.apply(ACTOR, 'co1', CORRECTION)).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.productionProblem.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.commercialOrderPosition.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(state()).toEqual(initialState);
  });

  it('rolls back all writes and prior staged audits when an audit write fails', async () => {
    const { service, audit, failAuditAt, initialState, state } = await setupCorrectionService();
    failAuditAt(2);

    await expect(service.apply(ACTOR, 'co1', CORRECTION)).rejects.toThrow('audit failed');

    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(state()).toEqual(initialState);
  });

  it('translates a retryable transaction race and leaves no committed writes or audits', async () => {
    const { service, prisma, audit, failWithSerializationConflict, initialState, state } =
      await setupCorrectionService();
    failWithSerializationConflict();

    await expect(service.apply(ACTOR, 'co1', CORRECTION)).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
    expect(audit.record).toHaveBeenCalledTimes(4);
    expect(state()).toEqual(initialState);
  });
});

describe('CommercialController material shortage correction', () => {
  it('exposes the capability-gated command and delegates the authenticated actor', async () => {
    const apply = jest.fn().mockResolvedValue({ problemId: 'problem-1', status: 'resolved' });
    const controller = new (CommercialController as any)({}, {}, { apply });

    await controller.materialShortageCorrection(
      { userId: 'commercial-1', role: 'commercial', capabilities: ['correction:create'] },
      'co1',
      CORRECTION,
    );

    expect(apply).toHaveBeenCalledWith(ACTOR, 'co1', CORRECTION);
    expect(
      Reflect.getMetadata(
        REQUIRE_CAPABILITIES,
        CommercialController.prototype.materialShortageCorrection,
      ),
    ).toEqual(['correction:create']);
  });
});
