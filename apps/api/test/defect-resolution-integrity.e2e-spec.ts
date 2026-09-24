import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { AuditService } from '../src/common/audit/audit.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ProductionService } from '../src/modules/production/production.service';

describe('defect resolution integrity (e2e, real PostgreSQL)', () => {
  jest.setTimeout(60_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let production: ProductionService;
  let audit: AuditService;
  let sequence = 0;
  const actor = { userId: null, role: 'production_lead' as const };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaService);
    production = moduleRef.get(ProductionService);
    audit = moduleRef.get(AuditService);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  async function createFixture(label: string) {
    sequence += 1;
    const suffix = `${Date.now()}-${sequence}-${label}`;
    const counterparty = await prisma.counterparty.create({
      data: { id: `defect-resolution-cp-${suffix}`, displayName: `Defect ${suffix}` },
    });
    const order = await prisma.commercialOrder.create({
      data: {
        id: `defect-resolution-order-${suffix}`,
        orderNumber: `DEFECT-RESOLUTION-${suffix}`,
        creatorRole: Role.commercial,
        counterpartyId: counterparty.id,
      },
    });
    const productionOrder = await prisma.productionOrder.create({
      data: {
        id: `defect-resolution-production-${suffix}`,
        commercialOrderId: order.id,
        approvalState: 'approved',
      },
    });
    const rawMaterialId = `rm-e2e-defect-${suffix}`;
    const dispatch = await prisma.rollDispatchItem.create({
      data: {
        id: `defect-resolution-dispatch-${suffix}`,
        rollCode: `DEFECT-RESOLUTION-ROLL-${suffix}`,
        productionOrderId: productionOrder.id,
        rawMaterialId,
        plannedWeightKg: 40,
        queueRank: sequence,
        status: 'deferred',
      },
    });
    const line = await prisma.operatorRollLine.create({
      data: {
        id: `defect-resolution-line-${suffix}`,
        rollDispatchItemId: dispatch.id,
        sequence: 1,
        spoolKg: 2,
        grossKg: 42,
        netKg: 40,
        step: 'deferred',
        warehouseState: 'not_ready',
      },
    });
    const post = await prisma.post.create({
      data: {
        id: `defect-resolution-post-${suffix}`,
        code: `DEFECT-RESOLUTION-POST-${suffix}`,
        name: `Defect resolution post ${suffix}`,
      },
    });
    const device = await prisma.deviceRuntime.create({
      data: {
        id: `defect-resolution-scale-${suffix}`,
        code: `DEFECT-RESOLUTION-SCALE-${suffix}`,
        label: `Defect resolution scale ${suffix}`,
        kind: 'scale',
        status: 'ready',
        postId: post.id,
      },
    });
    const operator = await prisma.user.create({
      data: {
        id: `defect-resolution-operator-${suffix}`,
        login: `defect-resolution-operator-${suffix}`,
        displayName: `Defect resolution operator ${suffix}`,
        role: Role.operator,
      },
    });
    const postSession = await prisma.operatorPostSession.create({
      data: {
        id: `defect-resolution-session-${suffix}`,
        operatorId: operator.id,
        postId: post.id,
        status: 'closed',
        endedAt: new Date(),
      },
    });
    const captureId = `defect-resolution-capture-${suffix}`;
    const defectId = `defect-resolution-defect-${suffix}`;
    const operation = await prisma.operatorRollOperation.create({
      data: {
        operationKey: randomUUID(),
        operatorRollLineId: line.id,
        action: 'defect',
        actorId: operator.id,
        postSessionId: postSession.id,
        postId: post.id,
        deviceId: device.id,
        requestFingerprint: `defect-resolution-${suffix}`,
        expectedStep: 'roll_weight',
        resultStep: 'deferred',
        status: 'succeeded',
        attempt: 1,
        httpStatus: 200,
        resultRef: defectId,
        completedAt: new Date(),
      },
    });
    const capture = await prisma.weightCapture.create({
      data: {
        id: captureId,
        operatorRollLineId: line.id,
        kind: 'roll',
        deviceId: device.id,
        deviceStatus: 'ready',
        stable: true,
        grossKg: 42,
        spoolKg: 2,
        netKg: 40,
        actorRole: Role.operator,
        actorId: operator.id,
        postId: post.id,
        postSessionId: postSession.id,
        operationId: operation.id,
      },
    });
    const defect = await prisma.defectRecord.create({
      data: {
        id: defectId,
        operatorRollLineId: line.id,
        weightCaptureId: capture.id,
        sourceRole: Role.operator,
        weightKg: 40,
        comment: 'Physical defect',
        blocking: true,
      },
    });
    const problem = await prisma.productionProblem.create({
      data: {
        id: `defect-resolution-problem-${suffix}`,
        orderId: order.id,
        rollId: dispatch.rollCode,
        actorRole: Role.operator,
        reason: 'Physical defect',
        type: 'defect',
        defectRecordId: defect.id,
      },
    });
    return {
      order,
      productionOrder,
      dispatch,
      line,
      capture,
      defect,
      problem,
      operation,
      rawMaterialId,
      secondaryMaterialId: `rm-secondary-${rawMaterialId.replace(/^rm-/u, '')}`,
    };
  }

  it('serializes concurrent rework into one replacement and one recycling fact', async () => {
    const fixture = await createFixture('concurrent');

    const outcomes = await Promise.allSettled([
      production.resolveProblem(actor, fixture.problem.id, {
        resolution: 'rework',
        note: 'Переделать по подтверждённому физическому браку',
      }),
      production.resolveProblem(actor, fixture.problem.id, {
        resolution: 'rework',
        note: 'Переделать по подтверждённому физическому браку',
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toEqual(
      expect.objectContaining({ status: 'rejected', reason: expect.any(ConflictException) }),
    );
    const resolved = await prisma.productionProblem.findUniqueOrThrow({
      where: { id: fixture.problem.id },
    });
    expect(resolved.status).toBe('resolved');
    expect(
      await prisma.rollDispatchItem.count({
        where: { rollCode: { startsWith: `${fixture.dispatch.rollCode}-R` } },
      }),
    ).toBe(1);
    expect(
      await prisma.rawMaterialStock.findUnique({
        where: { materialId: fixture.secondaryMaterialId },
      }),
    ).toEqual(expect.objectContaining({ actualQty: 40 }));
    expect(
      await prisma.domainEvent.count({
        where: {
          type: 'audit:warehouse_roll_defect_recycled',
          objectId: fixture.dispatch.rollCode,
        },
      }),
    ).toBe(1);
    expect(
      await prisma.domainEvent.count({
        where: { type: 'audit:defect_resolved_rework', objectId: fixture.order.id },
      }),
    ).toBe(1);
    expect(
      await prisma.domainEvent.count({
        where: {
          type: 'audit:replacement_roll_created',
          objectId: { startsWith: `${fixture.dispatch.rollCode}-R` },
        },
      }),
    ).toBe(1);
  });

  it('rolls replacement, stock, events and resolution back after a mid-transaction failure', async () => {
    const fixture = await createFixture('rollback');
    const originalRecord = audit.record.bind(audit);
    const record = jest.spyOn(audit, 'record').mockImplementation(async (input, client) => {
      if (input.type === 'audit:defect_resolved_rework') {
        throw new Error('forced resolution audit failure');
      }
      return originalRecord(input, client);
    });
    try {
      await expect(
        production.resolveProblem(actor, fixture.problem.id, {
          resolution: 'rework',
          note: 'Проверка атомарного отката',
        }),
      ).rejects.toThrow('forced resolution audit failure');
    } finally {
      record.mockRestore();
    }

    expect(
      await prisma.productionProblem.findUniqueOrThrow({ where: { id: fixture.problem.id } }),
    ).toEqual(expect.objectContaining({ status: 'open', resolvedAt: null }));
    expect(
      await prisma.rollDispatchItem.findUniqueOrThrow({ where: { id: fixture.dispatch.id } }),
    ).toEqual(expect.objectContaining({ status: 'deferred', completedAt: null }));
    expect(
      await prisma.rollDispatchItem.count({
        where: { rollCode: { startsWith: `${fixture.dispatch.rollCode}-R` } },
      }),
    ).toBe(0);
    expect(
      await prisma.rawMaterialStock.findUnique({
        where: { materialId: fixture.secondaryMaterialId },
      }),
    ).toBeNull();
    expect(
      await prisma.domainEvent.count({
        where: {
          OR: [
            { objectId: fixture.order.id },
            { objectId: fixture.dispatch.rollCode },
            { objectId: { startsWith: `${fixture.dispatch.rollCode}-R` } },
          ],
        },
      }),
    ).toBe(0);
  });

  it('keeps the defect open when a plausible capture lacks a successful durable operation', async () => {
    const fixture = await createFixture('failed-provenance');
    await prisma.operatorRollOperation.update({
      where: { id: fixture.operation.id },
      data: { status: 'failed', errorCode: 'SIMULATED_FAILURE' },
    });

    await expect(
      production.resolveProblem(actor, fixture.problem.id, {
        resolution: 'writeoff',
        note: 'Не должно списаться без подтверждённой операции',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PRODUCTION_DEFECT_EVIDENCE_UNVERIFIED' }),
    });

    await expect(
      prisma.productionProblem.findUniqueOrThrow({
        where: { id: fixture.problem.id },
        select: { status: true, resolvedAt: true },
      }),
    ).resolves.toEqual({ status: 'open', resolvedAt: null });
    await expect(
      prisma.rawMaterialStock.findUnique({
        where: { materialId: fixture.secondaryMaterialId },
      }),
    ).resolves.toBeNull();
    await expect(
      prisma.domainEvent.count({
        where: {
          OR: [{ objectId: fixture.order.id }, { objectId: fixture.dispatch.rollCode }],
        },
      }),
    ).resolves.toBe(0);
  });
});
