import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DirectorService } from './director.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';

function setup() {
  const prisma: any = {
    $transaction: jest.fn(async (callback: (client: unknown) => unknown) => callback(prisma)),
    directorDecision: {
      findUnique: jest.fn().mockResolvedValue({ id: 'dec1', status: 'pending' }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'dec1', status: 'approved' }),
      update: jest.fn().mockResolvedValue({ id: 'dec1', status: 'approved' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    financeOrder: {
      findUnique: jest.fn().mockResolvedValue({ id: 'fo1', commercialOrderId: 'co1' }),
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'fo1', paymentStatus: 'overdue', commercialOrder: { counterparty: {} } },
        ]),
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    commercialOrder: { update: jest.fn() },
    productionOrder: {
      findUnique: jest.fn().mockResolvedValue({ id: 'po1' }),
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'po1', commercialOrder: { counterparty: {} }, _count: { dispatchItems: 0 } },
        ]),
      update: jest.fn(),
    },
    productionProblem: {
      findMany: jest.fn().mockResolvedValue([{ id: 'pr1', type: 'defect', status: 'open' }]),
    },
    penalty: {
      create: jest.fn().mockResolvedValue({ id: 'pen1' }),
      findMany: jest.fn().mockResolvedValue([
        { targetRole: 'operator', amount: 1000 },
        { targetRole: 'operator', amount: 500 },
        { targetRole: 'warehouse', amount: 700 },
      ]),
      aggregate: jest.fn().mockResolvedValue({ _count: { _all: 3 }, _sum: { amount: 2200 } }),
    },
    paymentSchedule: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 1000 } }),
    },
    operatorRollLine: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { netKg: 82.4 } }),
    },
    defectRecord: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { weightKg: 5 } }),
    },
    defectBag: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
    },
    rollDispatchItem: {
      count: jest.fn().mockResolvedValue(12),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'operator-1',
        displayName: 'Илья Ковалёв',
        role: 'operator',
        isActive: true,
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const audit = { record: jest.fn(), forObject: jest.fn().mockResolvedValue([]) };
  return { prisma, audit };
}

async function build(prisma: any, audit: any): Promise<DirectorService> {
  const mod = await Test.createTestingModule({
    providers: [
      DirectorService,
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: audit },
    ],
  }).compile();
  return mod.get(DirectorService);
}

function setupStatefulPenalty() {
  const { prisma, audit } = setup();
  let failAt = 0;
  let committed = { penalties: [] as Array<{ id: string }>, events: [] as string[] };
  prisma.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
    const staged = {
      penalties: [...committed.penalties],
      events: [...committed.events],
    };
    let eventNumber = 0;
    const tx = {
      penalty: {
        create: jest.fn(async () => {
          const penalty = { id: 'penalty-atomic-1' };
          staged.penalties.push(penalty);
          return penalty;
        }),
      },
    };
    audit.record.mockImplementation(async (input: { type: string }, client: unknown) => {
      expect(client).toBe(tx);
      eventNumber += 1;
      if (eventNumber === failAt) throw new Error(`event ${eventNumber} failed`);
      staged.events.push(input.type);
    });
    const result = await callback(tx);
    committed = staged;
    return result;
  });
  return {
    prisma,
    audit,
    failEvent: (eventNumber: number) => {
      failAt = eventNumber;
    },
    state: () => committed,
  };
}

const actor = { userId: 'u1', role: 'director' as const };

describe('DirectorService', () => {
  it('rejects unsupported decision filters before querying the queue', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);

    await expect(service.listDecisions({ scope: 'unknown' as never })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.directorDecision.findMany).not.toHaveBeenCalled();
  });

  it('fails closed instead of truncating the director decision queue', async () => {
    const { prisma, audit } = setup();
    prisma.directorDecision.findMany.mockResolvedValue(
      Array.from({ length: 201 }, (_, index) => ({ id: `decision-${index}` })),
    );
    const service = await build(prisma, audit);

    await expect(service.listDecisions({ status: 'pending' })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DIRECTOR_PROJECTION_TOO_LARGE' }),
    });
    expect(prisma.directorDecision.findMany).toHaveBeenCalledWith({
      where: { status: 'pending' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 201,
    });
  });

  it('passes the director audit audience explicitly', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);

    await service.getAudit('order-1');

    expect(audit.forObject).toHaveBeenCalledWith('order-1', 'director');
  });

  it('approveDecision sets approved and audits decision_resolved', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);
    await service.approveDecision(actor, 'dec1');
    expect(prisma.directorDecision.updateMany).toHaveBeenCalledWith({
      where: { id: 'dec1', status: 'pending' },
      data: { status: 'approved' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:director_decision_resolved' }),
      prisma,
    );
  });

  it('resolves a pending decision and its audit in one serializable transaction', async () => {
    const { prisma, audit } = setup();
    const tx = {
      directorDecision: {
        findUnique: jest.fn().mockResolvedValue({ id: 'dec1', status: 'pending' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'dec1', status: 'approved' }),
      },
    };
    prisma.$transaction.mockImplementation(async (callback: (client: unknown) => unknown) =>
      callback(tx),
    );
    const service = await build(prisma, audit);

    await service.approveDecision(actor, 'dec1');

    expect(tx.directorDecision.updateMany).toHaveBeenCalledWith({
      where: { id: 'dec1', status: 'pending' },
      data: { status: 'approved' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:director_decision_resolved',
        oldValue: { status: 'pending' },
        newValue: { status: 'approved' },
      }),
      tx,
    );
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    expect(prisma.directorDecision.update).not.toHaveBeenCalled();
  });

  it('rejects a decision that is no longer pending without appending another audit fact', async () => {
    const { prisma, audit } = setup();
    prisma.directorDecision.findUnique.mockResolvedValue({ id: 'dec1', status: 'approved' });
    const service = await build(prisma, audit);

    await expect(service.approveDecision(actor, 'dec1')).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.directorDecision.update).not.toHaveBeenCalled();
    expect(prisma.directorDecision.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('returns the persisted decision timestamp after a successful CAS', async () => {
    const { prisma, audit } = setup();
    const before = new Date('2026-07-17T08:00:00.000Z');
    const after = new Date('2026-07-17T08:00:01.000Z');
    const tx = {
      directorDecision: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ id: 'dec1', status: 'pending', updatedAt: before }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: 'dec1', status: 'approved', updatedAt: after }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.$transaction.mockImplementation(async (callback: (client: unknown) => unknown) =>
      callback(tx),
    );
    const service = await build(prisma, audit);

    await expect(service.approveDecision(actor, 'dec1')).resolves.toMatchObject({
      status: 'approved',
      updatedAt: after,
    });
    expect(tx.directorDecision.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: 'dec1' },
    });
  });

  it('overrideFinance double-audits (requested + applied) and applies value + syncs commercial', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);
    await service.overrideFinance(actor, 'fo1', {
      reason: 'client dispute',
      evidence: 'email',
      value: 'paid',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:director_finance_override_requested' }),
      prisma,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:director_finance_override_applied' }),
      prisma,
    );
    expect(prisma.financeOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { paymentStatus: 'paid' } }),
    );
    expect(prisma.commercialOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'co1' }, data: { paymentStatus: 'paid' } }),
    );
  });

  it('keeps a finance override, both audit facts, and both indicators in one transaction', async () => {
    const { prisma, audit } = setup();
    const tx = {
      financeOrder: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'fo1', commercialOrderId: 'co1', paymentStatus: 'unpaid' }),
        update: jest.fn(),
      },
      commercialOrder: { update: jest.fn() },
    };
    prisma.$transaction.mockImplementation(async (callback: (client: unknown) => unknown) =>
      callback(tx),
    );
    const service = await build(prisma, audit);

    await service.overrideFinance(actor, 'fo1', {
      reason: 'client dispute',
      evidence: 'signed decision',
      value: 'paid',
    });

    expect(tx.financeOrder.update).toHaveBeenCalledWith({
      where: { id: 'fo1' },
      data: { paymentStatus: 'paid' },
    });
    expect(tx.commercialOrder.update).toHaveBeenCalledWith({
      where: { id: 'co1' },
      data: { paymentStatus: 'paid' },
    });
    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: 'audit:director_finance_override_requested' }),
      tx,
    );
    expect(audit.record).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'audit:director_finance_override_applied',
        oldValue: { paymentStatus: 'unpaid' },
        newValue: { paymentStatus: 'paid' },
      }),
      tx,
    );
    expect(prisma.financeOrder.update).not.toHaveBeenCalled();
    expect(prisma.commercialOrder.update).not.toHaveBeenCalled();
  });

  it('rejects an invalid finance override value before any transaction or audit', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);

    await expect(
      service.overrideFinance(actor, 'fo1', {
        reason: 'client dispute',
        evidence: 'signed decision',
        value: 'invented_status',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects the server-derived stock payment status before any transaction or audit', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);

    await expect(
      service.overrideFinance(actor, 'fo1', {
        reason: 'client dispute',
        evidence: 'signed decision',
        value: 'not_applicable',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('overrideProduction audits production_override_applied', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);
    await service.overrideProduction(actor, 'po1', {
      reason: 'rush',
      evidence: 'call',
      value: 'in_production',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:director_production_override_applied' }),
      prisma,
    );
  });

  it('keeps a production override and its audit in one serializable transaction', async () => {
    const { prisma, audit } = setup();
    const tx = {
      productionOrder: {
        findUnique: jest.fn().mockResolvedValue({ id: 'po1', indicator: 'needs_production' }),
        update: jest.fn(),
      },
    };
    prisma.$transaction.mockImplementation(async (callback: (client: unknown) => unknown) =>
      callback(tx),
    );
    const service = await build(prisma, audit);

    await service.overrideProduction(actor, 'po1', {
      reason: 'approved recovery',
      evidence: 'signed decision',
      value: 'in_production',
    });

    expect(tx.productionOrder.update).toHaveBeenCalledWith({
      where: { id: 'po1' },
      data: { indicator: 'in_production' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:director_production_override_applied',
        oldValue: { indicator: 'needs_production' },
        newValue: { indicator: 'in_production' },
      }),
      tx,
    );
    expect(prisma.productionOrder.update).not.toHaveBeenCalled();
  });

  it('createPenalty audits penalty_created + notification', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);
    await service.createPenalty(actor, {
      targetRole: 'operator',
      employeeId: 'operator-1',
      amount: 1500,
      reason: 'defect rate',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.penalty.create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:penalty_created' }),
      prisma,
    );
    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(audit.record.mock.calls.map(([event]: [{ type: string }]) => event.type)).toEqual([
      'audit:penalty_created',
      'notification:penalty_created',
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notification:penalty_created',
        label: 'Штраф назначен: Илья Ковалёв',
        detail: expect.objectContaining({
          targetRole: 'operator',
          employeeId: 'operator-1',
          employeeName: 'Илья Ковалёв',
          amount: 1500,
          reason: 'defect rate',
        }),
      }),
      prisma,
    );
  });

  it.each([1, 2])(
    'rolls back the director penalty when required event %i fails',
    async (eventNumber) => {
      const { prisma, audit, failEvent, state } = setupStatefulPenalty();
      failEvent(eventNumber);
      const service = await build(prisma, audit);

      await expect(
        service.createPenalty(actor, {
          targetRole: 'operator',
          employeeId: 'operator-1',
          amount: 1500,
          reason: 'atomic penalty',
        }),
      ).rejects.toThrow(`event ${eventNumber} failed`);

      expect(state()).toEqual({ penalties: [], events: [] });
      expect(audit.record).toHaveBeenCalledTimes(eventNumber);
    },
  );

  it('rejects a director penalty without a concrete employee target', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);

    await expect(
      service.createPenalty(actor, {
        targetRole: 'operator',
        amount: 1500,
        reason: 'missing employee',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.penalty.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects unsupported director penalty target roles', async () => {
    const { prisma, audit } = setup();
    prisma.user.findUnique.mockResolvedValue({ role: 'warehouse', isActive: true });
    const service = await build(prisma, audit);

    await expect(
      service.createPenalty(actor, {
        targetRole: 'warehouse',
        employeeId: 'warehouse-1',
        amount: 1500,
        reason: 'unsupported target',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.penalty.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only penalty reason before any durable write', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);

    await expect(
      service.createPenalty(actor, {
        targetRole: 'operator',
        employeeId: 'operator-1',
        amount: 1500,
        reason: '   ',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not let production use the director endpoint against a non-operator role', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);
    await expect(
      service.createPenalty(
        { userId: 'lead-1', role: 'production_lead' },
        {
          targetRole: 'warehouse',
          employeeId: 'warehouse-1',
          amount: 1500,
          reason: 'not allowed',
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.penalty.create).not.toHaveBeenCalled();
  });

  it('rejects a director penalty when the selected employee role does not match the target role', async () => {
    const { prisma, audit } = setup();
    prisma.user.findUnique.mockResolvedValue({
      id: 'lead-1',
      role: 'production_lead',
      isActive: true,
    });
    const service = await build(prisma, audit);

    await expect(
      service.createPenalty(actor, {
        targetRole: 'operator',
        employeeId: 'lead-1',
        amount: 1500,
        reason: 'mismatched target',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.penalty.create).not.toHaveBeenCalled();
  });

  it('penaltiesSummary aggregates by role from durable rows', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);
    const summary = await service.penaltiesSummary();
    expect(summary.total).toBe(3);
    const op = summary.byRole.find((r) => r.targetRole === 'operator');
    expect(op).toEqual({ targetRole: 'operator', count: 2, totalAmount: 1500 });
  });

  it('lists durable penalties with the safe employee projection for the live register', async () => {
    const { prisma, audit } = setup();
    const rows = [{ id: 'pen-live-1', employee: { id: 'operator-1', displayName: 'Оператор' } }];
    prisma.penalty.findMany.mockResolvedValueOnce(rows);
    const service = await build(prisma, audit);

    await expect(service.listPenalties()).resolves.toEqual(rows);
    expect(prisma.penalty.findMany).toHaveBeenCalledWith({
      include: { employee: { select: { id: true, displayName: true } } },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('lists only safe penalty target identity fields for director', async () => {
    const { prisma, audit } = setup();
    const targets = [
      { id: 'operator-1', displayName: 'Оператор', role: 'operator', isActive: true },
    ];
    prisma.user.findMany.mockResolvedValueOnce(targets);
    const service = await build(prisma, audit);

    await expect(service.listPenaltyTargets()).resolves.toEqual(targets);
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { role: { in: ['operator', 'production_lead'] }, isActive: true },
      select: { id: true, displayName: true, role: true, isActive: true },
      orderBy: [{ role: 'asc' }, { displayName: 'asc' }],
    });
  });

  it('getControl returns dashboard aggregates (finance + production + penalties)', async () => {
    const { prisma, audit } = setup();
    prisma.paymentSchedule.aggregate = jest
      .fn()
      .mockResolvedValueOnce({ _sum: { amount: 5000 } }) // all
      .mockResolvedValueOnce({ _sum: { amount: 2000 } }) // paid
      .mockResolvedValueOnce({ _sum: { amount: 800 } }); // overdue
    const service = await build(prisma, audit);
    const control = await service.getControl();
    expect(control).toEqual(
      expect.objectContaining({
        penalties: 3,
        penaltiesAmount: 2200,
        plannedInvoicedAmount: 5000,
        paidAmount: 2000,
        unbilledAmount: 3000,
        overdueAmount: 800,
        producedKg: 82.4,
        defectKg: 5,
        warehouseAcceptedRolls: 12,
      }),
    );
  });

  it('projects defect-bag totals and recent logistics without private QR or device data', async () => {
    const { prisma, audit } = setup();
    prisma.defectBag.groupBy.mockResolvedValue([
      {
        status: 'ready_for_warehouse',
        defectType: 'secondary',
        _count: { _all: 1 },
        _sum: { weightKg: 12.5 },
      },
      {
        status: 'shipped',
        defectType: 'aika',
        _count: { _all: 1 },
        _sum: { weightKg: 8 },
      },
      {
        status: 'weighed',
        defectType: null,
        _count: { _all: 1 },
        _sum: { weightKg: 3 },
      },
    ]);
    prisma.defectBag.findMany.mockResolvedValue([
      {
        id: 'defect-bag-2',
        code: 'DB-20260907-0002',
        status: 'shipped',
        defectType: 'aika',
        weightKg: 8,
        recordedDefectKg: 7.5,
        differenceKg: 0.5,
        weighedAt: new Date('2026-09-07T08:00:00.000Z'),
        scaleDeviceId: 'private-scale-id',
        weighOperationKey: 'private-operation-key',
        scanToken: { token: 'private-qr-token' },
        postSession: {
          operator: { displayName: 'Оператор 2' },
          post: { code: 'POST-2', name: 'Станок 2' },
          shift: { label: 'День' },
        },
        movements: [
          {
            kind: 'receive',
            createdAt: new Date('2026-09-07T09:00:00.000Z'),
            actor: { displayName: 'Кладовщик' },
          },
          {
            kind: 'ship',
            createdAt: new Date('2026-09-07T10:00:00.000Z'),
            actor: { displayName: 'Кладовщик' },
          },
        ],
      },
    ]);
    const service = await build(prisma, audit);

    const control = await service.getControl();

    expect(control.defectBags).toEqual({
      totalCount: 3,
      totalWeightKg: 23.5,
      byStatus: [
        { status: 'weighed', count: 1, weightKg: 3 },
        { status: 'ready_for_warehouse', count: 1, weightKg: 12.5 },
        { status: 'received', count: 0, weightKg: 0 },
        { status: 'shipped', count: 1, weightKg: 8 },
      ],
      byType: [
        { defectType: 'secondary', count: 1, weightKg: 12.5 },
        { defectType: 'aika', count: 1, weightKg: 8 },
        { defectType: 'primary', count: 0, weightKg: 0 },
      ],
      unclassified: { count: 1, weightKg: 3 },
      recent: [
        {
          id: 'defect-bag-2',
          code: 'DB-20260907-0002',
          status: 'shipped',
          defectType: 'aika',
          weightKg: 8,
          recordedDefectKg: 7.5,
          differenceKg: 0.5,
          operatorName: 'Оператор 2',
          postCode: 'POST-2',
          postName: 'Станок 2',
          shiftLabel: 'День',
          weighedAt: '2026-09-07T08:00:00.000Z',
          receivedAt: '2026-09-07T09:00:00.000Z',
          receivedBy: 'Кладовщик',
          shippedAt: '2026-09-07T10:00:00.000Z',
          shippedBy: 'Кладовщик',
        },
      ],
      hasMore: false,
    });
    expect(prisma.defectBag.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { weightKg: { gt: 0 } },
        take: 101,
      }),
    );
    expect(prisma.defectBag.groupBy).toHaveBeenCalledWith({
      by: ['status', 'defectType'],
      where: { weightKg: { gt: 0 } },
      _count: { _all: true },
      _sum: { weightKg: true },
    });
    expect(JSON.stringify(control.defectBags)).not.toMatch(
      /private-qr-token|private-scale-id|private-operation-key/u,
    );
  });

  it('listFinance projects counterparty per role', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);
    const list = await service.listFinance('director');
    expect(prisma.financeOrder.findMany).toHaveBeenCalled();
    expect(list).toHaveLength(1);
    expect(list[0]).toHaveProperty('commercialOrder.counterparty');
    expect(prisma.financeOrder.findMany).toHaveBeenCalledWith({
      select: {
        id: true,
        invoiceStatus: true,
        paymentStatus: true,
        amountValue: true,
        amountLabel: true,
        commercialOrder: {
          select: {
            orderNumber: true,
            counterparty: { select: { displayName: true, legalName: true } },
          },
        },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 201,
    });
  });

  it('keeps bounded safe payment schedules in the director finance drilldown', async () => {
    const { prisma, audit } = setup();
    const schedules = [
      {
        kind: 'invoice_prepayment',
        status: 'paid',
        dueDate: new Date('2026-08-10T00:00:00.000Z'),
        amount: '75000.00',
      },
    ];
    prisma.financeOrder.findUnique.mockResolvedValueOnce({
      id: 'fo1',
      invoiceStatus: 'invoiced',
      paymentStatus: 'partial',
      amountValue: '150000.00',
      amountLabel: 'Демо-счёт',
      commercialOrder: {
        orderNumber: 'A-1',
        counterparty: { displayName: 'Контрагент', legalName: null },
      },
      schedules,
    });
    const service = await build(prisma, audit);

    await expect(service.getFinance('director', 'fo1')).resolves.toMatchObject({ schedules });
    expect(prisma.financeOrder.findUnique).toHaveBeenCalledWith({
      where: { id: 'fo1' },
      select: {
        id: true,
        invoiceStatus: true,
        paymentStatus: true,
        amountValue: true,
        amountLabel: true,
        commercialOrder: {
          select: {
            orderNumber: true,
            counterparty: { select: { displayName: true, legalName: true } },
          },
        },
        schedules: {
          select: { kind: true, status: true, dueDate: true, amount: true },
          orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
          take: 51,
        },
      },
    });
  });

  it('fails closed instead of truncating an oversized director payment schedule', async () => {
    const { prisma, audit } = setup();
    prisma.financeOrder.findUnique.mockResolvedValueOnce({
      id: 'fo1',
      schedules: Array.from({ length: 51 }, (_, index) => ({
        kind: 'post_delivery',
        status: 'unpaid',
        dueDate: null,
        amount: index + 1,
      })),
    });
    const service = await build(prisma, audit);

    await expect(service.getFinance('director', 'fo1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DIRECTOR_PROJECTION_TOO_LARGE' }),
    });
  });

  it('listProduction and listWarehouse read durable rows', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);
    expect(await service.listProduction('director')).toHaveLength(1);
    const warehouse = await service.listWarehouse();
    expect(prisma.productionProblem.findMany).toHaveBeenCalled();
    expect(warehouse[0]).toEqual(expect.objectContaining({ type: 'defect' }));
    expect(prisma.productionProblem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 201,
      }),
    );
  });

  it('fails closed instead of hiding an older active warehouse problem', async () => {
    const { prisma, audit } = setup();
    prisma.productionProblem.findMany.mockResolvedValueOnce(
      Array.from({ length: 201 }, (_, index) => ({
        id: `problem-${index}`,
        type: 'defect',
        status: index === 200 ? 'open' : 'resolved',
      })),
    );
    const service = await build(prisma, audit);

    await expect(service.listWarehouse()).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DIRECTOR_PROJECTION_TOO_LARGE' }),
    });
  });

  it('fails before hydrating an oversized director production catalog', async () => {
    const { prisma, audit } = setup();
    prisma.productionOrder.findMany.mockResolvedValueOnce(
      Array.from({ length: 201 }, (_, index) => ({ id: `po-${index}` })),
    );
    const service = await build(prisma, audit);

    await expect(service.listProduction('director')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DIRECTOR_PROJECTION_TOO_LARGE' }),
    });
    expect(prisma.productionOrder.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.rollDispatchItem.count).not.toHaveBeenCalled();
  });

  it('returns a compact roll count when the director catalog contains more than 2,000 rolls', async () => {
    const { prisma, audit } = setup();
    prisma.productionOrder.findMany.mockResolvedValueOnce([
      {
        id: 'po-1',
        indicator: 'in_production',
        approvalState: 'approved',
        commercialOrder: { orderNumber: 'A-30', counterparty: null },
        _count: { dispatchItems: 2_001 },
      },
    ]);
    const service = await build(prisma, audit);

    await expect(service.listProduction('director')).resolves.toEqual([
      expect.objectContaining({ id: 'po-1', rollCount: 2_001 }),
    ]);
    expect(prisma.rollDispatchItem.count).not.toHaveBeenCalled();
  });

  it('uses an explicit safe projection for director production rows', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);

    await service.listProduction('director');

    expect(prisma.productionOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 201,
        select: {
          id: true,
          indicator: true,
          approvalState: true,
          commercialOrder: {
            select: {
              orderNumber: true,
              counterparty: { select: { displayName: true, legalName: true } },
            },
          },
          _count: { select: { dispatchItems: true } },
        },
      }),
    );
  });
});
