import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CommercialResolutionService } from './commercial-resolution.service';

const ACTOR = { userId: 'commercial-1', role: 'commercial' } as const;
const PROBLEM_ROLL_ID = 'b9cf31bf-2a5d-4af8-a8bc-a7e1590db6d4';
const COMMAND = {
  positionId: 'position-1',
  fromRollId: 'A-1-roll-3',
  expectedRecipeVersion: 'v1',
  currentRollResolution: 'stop_and_apply_new' as const,
  newParameters: [{ label: 'Толщина', value: '90' }],
  reason: 'Клиент подтвердил изменение после остановки рулона',
};

function roll(id: string, sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    rollCode: `A-1-roll-${sequence}`,
    productionOrderId: 'production-1',
    orderLineId: 'position-1',
    assignedOperatorId: 'operator-1',
    positionSequence: sequence,
    status: 'assigned',
    completedAt: null,
    characteristicsSnapshot: {
      recipeVersion: 'v1',
      recipeParameters: [{ label: 'Толщина', value: '80' }],
      preserved: id,
    },
    operatorLine: {
      spoolKg: null,
      grossKg: null,
      netKg: null,
      warehouseState: 'not_ready',
      weightCaptures: [],
    },
    ...overrides,
  };
}

async function setup(problemRollReference = 'A-1-roll-3') {
  let problemOpen = true;
  let caseOpen = true;
  const problemRoll = roll(PROBLEM_ROLL_ID, 3);
  const futureRoll = roll('roll-4', 4);
  const completedRoll = roll('roll-5', 5, {
    status: 'done',
    completedAt: new Date('2026-07-14T09:00:00.000Z'),
    operatorLine: {
      spoolKg: 2,
      grossKg: 42,
      netKg: 40,
      warehouseState: 'received',
      weightCaptures: [{ kind: 'roll', grossKg: 42, netKg: 40 }],
    },
  });
  const candidates = [problemRoll, futureRoll, completedRoll];
  const prisma: any = {
    commercialOrder: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'order-1',
        commercialStage: 'in_work',
        paymentStatus: 'partial',
        commercialLockedAt: new Date('2026-07-14T08:00:00.000Z'),
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    productionProblem: {
      findFirst: jest.fn(async () =>
        problemOpen
          ? {
              id: 'problem-1',
              orderId: 'order-1',
              positionId: 'position-1',
              rollId: problemRollReference,
              status: 'open',
              type: 'general',
              reason: 'Клиент изменил параметры',
            }
          : null,
      ),
      updateMany: jest.fn(async () => {
        if (!problemOpen) return { count: 0 };
        problemOpen = false;
        return { count: 1 };
      }),
    },
    commercialOrderPosition: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'position-1',
        orderId: 'order-1',
        version: 4,
        recipe: {
          id: 'recipe-1',
          version: 'v1',
          parameters: [{ label: 'Толщина', value: '80' }],
          source: 'commercial_form',
          createdBy: 'commercial-creator',
        },
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    rollDispatchItem: {
      findFirst: jest.fn(async ({ where }: any) => {
        const identities = where.OR ?? [{ id: where.id, rollCode: where.rollCode }];
        return (
          candidates.find((item) =>
            identities.some(
              (identity: { id?: string; rollCode?: string }) =>
                item.id === identity.id || item.rollCode === identity.rollCode,
            ),
          ) ?? null
        );
      }),
      findMany: jest.fn(async ({ select }: any) =>
        select ? candidates.map((item) => ({ id: item.id })) : candidates,
      ),
      findUnique: jest.fn(
        async ({ where }: any) => candidates.find((item) => item.id === where.id) ?? null,
      ),
      update: jest.fn().mockResolvedValue({}),
    },
    recipeSnapshotVersion: {
      upsert: jest.fn().mockResolvedValue({ id: 'recipe-version-1', version: 1 }),
      create: jest.fn().mockResolvedValue({ id: 'recipe-version-2', version: 2 }),
    },
    recipeSnapshot: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    orderResolutionCase: {
      create: jest.fn().mockResolvedValue({ id: 'case-1', version: 1, status: 'open' }),
      updateMany: jest.fn(async () => {
        if (!caseOpen) return { count: 0 };
        caseOpen = false;
        return { count: 1 };
      }),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  prisma.$transaction = jest.fn(async (callback: (tx: any) => unknown) => callback(prisma));
  const audit = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
  const moduleRef = await Test.createTestingModule({
    providers: [
      CommercialResolutionService,
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: audit },
    ],
  }).compile();
  return {
    audit,
    candidates: { completedRoll, futureRoll, problemRoll },
    prisma,
    service: moduleRef.get(CommercialResolutionService),
    closeProblem: () => {
      problemOpen = false;
    },
  };
}

describe('CommercialResolutionService', () => {
  it('rejects a raw-material shortage before the generic correction can write', async () => {
    const { audit, prisma, service } = await setup();
    prisma.productionProblem.findFirst.mockResolvedValueOnce({
      id: 'problem-1',
      orderId: 'order-1',
      positionId: 'position-1',
      rollId: 'A-1-roll-3',
      status: 'open',
      type: 'raw_material_shortage',
      reason: 'ПВД закончился',
    });

    await expect(service.apply(ACTOR, 'order-1', 'problem-1', COMMAND)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(prisma.orderResolutionCase.create).not.toHaveBeenCalled();
    expect(prisma.productionProblem.updateMany).not.toHaveBeenCalled();
    expect(prisma.recipeSnapshotVersion.create).not.toHaveBeenCalled();
    expect(prisma.recipeSnapshot.updateMany).not.toHaveBeenCalled();
    expect(prisma.rollDispatchItem.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('requires an open addressed production problem after the order is locked', async () => {
    const { closeProblem, prisma, service } = await setup();
    closeProblem();

    await expect(service.apply(ACTOR, 'order-1', 'problem-1', COMMAND)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(prisma.recipeSnapshot.updateMany).not.toHaveBeenCalled();
    expect(prisma.rollDispatchItem.update).not.toHaveBeenCalled();
  });

  it('creates immutable recipe history and updates only unconsumed rolls from the boundary', async () => {
    const { audit, prisma, service } = await setup();

    await expect(service.apply(ACTOR, 'order-1', 'problem-1', COMMAND)).resolves.toEqual({
      caseId: 'case-1',
      problemId: 'problem-1',
      status: 'resolved',
      oldRecipeVersionId: 'recipe-version-1',
      newRecipeVersionId: 'recipe-version-2',
      recipeVersion: 'v2',
      affectedRollIds: ['A-1-roll-3', 'A-1-roll-4'],
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
          parameters: COMMAND.newParameters,
          source: 'production_problem_correction',
        }),
      }),
    );
    expect(prisma.recipeSnapshot.updateMany).toHaveBeenCalledWith({
      where: { id: 'recipe-1', version: 'v1' },
      data: { version: 'v2', parameters: COMMAND.newParameters },
    });
    expect(prisma.rollDispatchItem.update).toHaveBeenCalledTimes(2);
    expect(prisma.rollDispatchItem.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'roll-5' } }),
    );
    expect(prisma.productionProblem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'problem-1', status: 'open' } }),
    );
    expect(prisma.orderResolutionCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'case-1', status: 'open', version: 1 },
        data: expect.objectContaining({
          status: 'resolved',
          outcome: 'stop_and_apply_new',
          nextOwnerRole: null,
        }),
      }),
    );
    expect(audit.record.mock.calls.map(([input]) => input.type)).toEqual([
      'audit:commercial_position_correction_requested',
      'audit:correction_applies_from_roll_set',
      'audit:current_roll_resolution_set',
      'audit:recipe_correction_applied',
      'notification:commercial_correction_applied',
      'notification:operator_recipe_changed',
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notification:commercial_correction_applied',
        objectId: 'order-1',
        detail: expect.objectContaining({
          notificationKey: 'correction:case-1:v2',
          recipientRoles: [
            'commercial',
            'production_lead',
            'operator',
            'warehouse',
            'finance',
            'director',
          ],
          recipientUserIds: ['operator-1'],
          orderId: 'order-1',
          positionId: 'position-1',
          rollIds: ['A-1-roll-3', 'A-1-roll-4'],
        }),
      }),
      prisma,
    );
    expect(audit.record.mock.calls.every(([, tx]) => tx === prisma)).toBe(true);
  });

  it('resolves a production problem that stores the dispatch-item UUID', async () => {
    const { prisma, service } = await setup(PROBLEM_ROLL_ID);

    await expect(service.apply(ACTOR, 'order-1', 'problem-1', COMMAND)).resolves.toEqual(
      expect.objectContaining({
        problemId: 'problem-1',
        affectedRollIds: ['A-1-roll-3', 'A-1-roll-4'],
      }),
    );

    expect(prisma.productionProblem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'problem-1', status: 'open' } }),
    );
    expect(prisma.rollDispatchItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [{ id: PROBLEM_ROLL_ID }, { rollCode: PROBLEM_ROLL_ID }],
          orderLineId: 'position-1',
          productionOrder: { commercialOrderId: 'order-1' },
        },
      }),
    );
  });

  it('rejects a stale expected recipe version before creating history', async () => {
    const { prisma, service } = await setup();

    await expect(
      service.apply(ACTOR, 'order-1', 'problem-1', {
        ...COMMAND,
        expectedRecipeVersion: 'v0',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.recipeSnapshotVersion.create).not.toHaveBeenCalled();
    expect(prisma.productionProblem.updateMany).not.toHaveBeenCalled();
  });

  it('requires the next roll when the current roll must finish on the old version', async () => {
    const { prisma, service } = await setup();

    await expect(
      service.apply(ACTOR, 'order-1', 'problem-1', {
        ...COMMAND,
        currentRollResolution: 'finish_old_version',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.recipeSnapshot.updateMany).not.toHaveBeenCalled();
  });

  it('allows only one of two competing corrections to claim the problem', async () => {
    const { audit, service } = await setup();

    const results = await Promise.allSettled([
      service.apply(ACTOR, 'order-1', 'problem-1', COMMAND),
      service.apply(ACTOR, 'order-1', 'problem-1', COMMAND),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toEqual(expect.objectContaining({ reason: expect.any(ConflictException) }));
    expect(audit.record).toHaveBeenCalledTimes(6);
  });
});
