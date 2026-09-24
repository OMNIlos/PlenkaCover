import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { SCALE_ADAPTER } from '../src/integrations/scale/scale.adapter';
import { OperatorSessionService } from '../src/modules/operator/operator-session.service';
import { OperatorShiftService } from '../src/modules/operator/operator-shift.service';
import { ProductionShiftCommandService } from '../src/modules/production/production-shift-command.service';
import { initializeE2eApp } from './e2e-app';
import { runE2eWithCleanup } from './e2e-database';
import { enableSimulatedDevices } from './simulated-device-fixture';

describe('post backlog claim and intentional machine change (e2e)', () => {
  jest.setTimeout(60_000);

  const suffix = randomUUID();
  const operatorId = `carry-operator-${suffix}`;
  const leadId = `carry-lead-${suffix}`;
  const fromPostId = `carry-post-from-${suffix}`;
  const toPostId = `carry-post-to-${suffix}`;
  const fromPostCode = `CARRY-FROM-${suffix}`;
  const toPostCode = `CARRY-TO-${suffix}`;
  const oldShiftId = `carry-old-shift-${suffix}`;
  const shiftId = `carry-shift-${suffix}`;
  const assignmentId = `carry-assignment-${suffix}`;
  const commercialOrderId = `carry-order-${suffix}`;
  const productionOrderId = `carry-production-${suffix}`;
  const counterpartyId = `carry-counterparty-${suffix}`;
  const unfinishedId = `carry-unfinished-${suffix}`;
  const unstartedId = `carry-unstarted-${suffix}`;
  const completedId = `carry-completed-${suffix}`;
  const warehouseId = `carry-warehouse-${suffix}`;
  const lineId = `carry-line-${suffix}`;
  const captureId = `carry-capture-${suffix}`;
  const labelJobId = `carry-label-${suffix}`;
  const firstBagId = `carry-bag-first-${suffix}`;
  const secondBagId = `carry-bag-second-${suffix}`;

  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: OperatorSessionService;
  let shifts: OperatorShiftService;
  let commands: ProductionShiftCommandService;

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SCALE_ADAPTER)
      .useValue({
        read: jest.fn(async (deviceId: string) => ({
          deviceId,
          status: 'ready',
          stable: true,
          grossKg: 450,
        })),
      })
      .compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaService);
    sessions = moduleRef.get(OperatorSessionService);
    shifts = moduleRef.get(OperatorShiftService);
    commands = moduleRef.get(ProductionShiftCommandService);
    await initializeE2eApp(app);

    await prisma.user.createMany({
      data: [
        {
          id: operatorId,
          externalId: operatorId,
          login: `${operatorId}@test.local`,
          displayName: 'Carry-over operator',
          role: Role.operator,
        },
        {
          id: leadId,
          externalId: leadId,
          login: `${leadId}@test.local`,
          displayName: 'Carry-over production lead',
          role: Role.production_lead,
        },
      ],
    });
    await prisma.post.createMany({
      data: [
        { id: fromPostId, code: fromPostCode, name: 'Carry-over old post' },
        { id: toPostId, code: toPostCode, name: 'Carry-over new post' },
      ],
    });
    const deviceIds = (
      [
        [fromPostId, 'from'],
        [toPostId, 'to'],
      ] as const
    ).flatMap(([postId, postLabel]) =>
      (['scale', 'printer', 'scanner'] as const).map((kind) => ({
        id: `carry-${postLabel}-${kind}-${suffix}`,
        code: `CARRY-${postLabel.toUpperCase()}-${kind.toUpperCase()}-${suffix}`,
        kind,
        label: `Carry-over ${postLabel} ${kind}`,
        postId,
        status: 'ready',
        isEnabled: true,
      })),
    );
    await prisma.deviceRuntime.createMany({ data: deviceIds });
    await enableSimulatedDevices(
      prisma,
      deviceIds.map(({ id }) => id),
    );
    await prisma.counterparty.create({
      data: { id: counterpartyId, displayName: 'Carry-over customer' },
    });
    await prisma.commercialOrder.create({
      data: {
        id: commercialOrderId,
        orderNumber: `CARRY-ORDER-${suffix}`,
        creatorRole: Role.commercial,
        counterpartyId,
      },
    });
    await prisma.productionOrder.create({
      data: {
        id: productionOrderId,
        commercialOrderId,
        approvalState: 'approved',
      },
    });
    await prisma.shift.createMany({
      data: [
        { id: oldShiftId, label: 'Closed legacy shift', status: 'closed', endedAt: new Date() },
        {
          id: shiftId,
          label: 'Individual time-free shift',
          plannedStartAt: null,
          plannedEndAt: null,
          status: 'planned',
        },
      ],
    });
    await prisma.operatorShiftMachineAssignment.createMany({
      data: [
        {
          id: `carry-old-assignment-${suffix}`,
          shiftId: oldShiftId,
          operatorId,
          postId: fromPostId,
          status: 'completed',
        },
        {
          id: assignmentId,
          shiftId,
          operatorId,
          postId: toPostId,
          status: 'planned',
          createdById: leadId,
        },
      ],
    });
    await prisma.operatorPostSession.create({
      data: {
        id: `carry-old-session-${suffix}`,
        operatorId,
        postId: fromPostId,
        shiftId: oldShiftId,
        status: 'closed',
        endedAt: new Date(),
      },
    });
    await prisma.rollDispatchItem.createMany({
      data: [
        {
          id: unfinishedId,
          rollCode: `CARRY-UNFINISHED-${suffix}`,
          productionOrderId,
          postId: toPostId,
          workplaceId: toPostId,
          machineId: toPostCode,
          queueRank: 10,
          status: 'deferred',
        },
        {
          id: unstartedId,
          rollCode: `CARRY-UNSTARTED-${suffix}`,
          productionOrderId,
          postId: toPostId,
          workplaceId: toPostId,
          machineId: toPostCode,
          queueRank: 20,
          status: 'assigned',
        },
        {
          id: completedId,
          rollCode: `CARRY-DONE-${suffix}`,
          productionOrderId,
          assignedOperatorId: operatorId,
          plannedShiftId: oldShiftId,
          postId: fromPostId,
          queueRank: 30,
          status: 'done',
        },
        {
          id: warehouseId,
          rollCode: `CARRY-WAREHOUSE-${suffix}`,
          productionOrderId,
          assignedOperatorId: operatorId,
          plannedShiftId: oldShiftId,
          postId: fromPostId,
          queueRank: 40,
          status: 'ready_for_warehouse',
        },
      ],
    });
    await prisma.operatorRollLine.create({
      data: {
        id: lineId,
        rollDispatchItemId: unfinishedId,
        sequence: 1,
        step: 'deferred',
        deferredFromStep: 'qr_check',
        labelState: 'printed',
      },
    });
    await prisma.weightCapture.create({
      data: {
        id: captureId,
        operatorRollLineId: lineId,
        kind: 'roll',
        stable: true,
        grossKg: 50,
        netKg: 45,
        actorRole: Role.operator,
        actorId: operatorId,
      },
    });
    await prisma.labelPrintJob.create({
      data: {
        id: labelJobId,
        operatorRollLineId: lineId,
        status: 'printed',
        actorId: operatorId,
      },
    });
    await prisma.bigBagUnit.createMany({
      data: [
        {
          id: firstBagId,
          code: `CARRY-BAG-FIRST-${suffix}`,
          material: 'ПВД',
          initialKg: 500,
          currentKg: 500,
          status: 'available',
          registrationStatus: 'registered',
          location: 'production',
          createdByRole: 'warehouse',
        },
        {
          id: secondBagId,
          code: `CARRY-BAG-SECOND-${suffix}`,
          material: 'ПВД',
          initialKg: 400,
          currentKg: 400,
          status: 'available',
          registrationStatus: 'registered',
          location: 'production',
          createdByRole: 'warehouse',
        },
      ],
    });
  });

  afterAll(async () => {
    await runE2eWithCleanup(
      async () => undefined,
      [{ label: 'operator post backlog application', run: async () => app?.close() }],
    );
  });

  it('preserves queue facts through post claim, machine change, and the next session', async () => {
    const operator = { userId: operatorId, role: 'operator' as const };
    const opened = await shifts.open(operator, {
      postCode: toPostCode,
      bigBagId: firstBagId,
      startKg: 500,
    });
    expect(opened.session).toMatchObject({ shiftId, postId: toPostId, status: 'active' });

    const carried = await prisma.rollDispatchItem.findMany({
      where: { id: { in: [unfinishedId, unstartedId, completedId, warehouseId] } },
      select: {
        id: true,
        assignedOperatorId: true,
        plannedShiftId: true,
        postId: true,
        workplaceId: true,
        machineId: true,
        queueRank: true,
        status: true,
      },
      orderBy: { queueRank: 'asc' },
    });
    expect(carried).toEqual([
      {
        id: unfinishedId,
        assignedOperatorId: operatorId,
        plannedShiftId: shiftId,
        postId: toPostId,
        workplaceId: toPostId,
        machineId: toPostCode,
        queueRank: 10,
        status: 'deferred',
      },
      {
        id: unstartedId,
        assignedOperatorId: operatorId,
        plannedShiftId: shiftId,
        postId: toPostId,
        workplaceId: toPostId,
        machineId: toPostCode,
        queueRank: 20,
        status: 'assigned',
      },
      expect.objectContaining({
        id: completedId,
        plannedShiftId: oldShiftId,
        postId: fromPostId,
        queueRank: 30,
        status: 'done',
      }),
      expect.objectContaining({
        id: warehouseId,
        plannedShiftId: oldShiftId,
        postId: fromPostId,
        queueRank: 40,
        status: 'ready_for_warehouse',
      }),
    ]);

    await Promise.all([
      prisma.rollDispatchItem.update({
        where: { id: unfinishedId },
        data: { postId: null, workplaceId: null, machineId: null },
      }),
      prisma.rollDispatchItem.update({
        where: { id: unstartedId },
        data: {
          postId: fromPostId,
          workplaceId: fromPostId,
          machineId: fromPostCode,
        },
      }),
    ]);

    const change = await commands.requestMachineChange(
      { userId: leadId, role: 'production_lead' },
      assignmentId,
      {
        postId: fromPostId,
        reason: 'Плановый переход на другую линию',
        operationKey: randomUUID(),
      },
    );
    expect(change.status).toBe('awaiting_final_weight');

    await expect(commands.finalizeMachineChange(operator, change.id)).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(prisma.post.findUniqueOrThrow({ where: { id: toPostId } })).resolves.toMatchObject(
      {
        status: 'active',
      },
    );
    await expect(
      prisma.operatorRollLine.findUniqueOrThrow({ where: { id: lineId } }),
    ).resolves.toMatchObject({
      id: lineId,
      rollDispatchItemId: unfinishedId,
      step: 'deferred',
      deferredFromStep: 'qr_check',
    });
    await expect(
      prisma.weightCapture.findUniqueOrThrow({ where: { id: captureId } }),
    ).resolves.toMatchObject({
      id: captureId,
      operatorRollLineId: lineId,
      stable: true,
    });
    await expect(
      prisma.labelPrintJob.findUniqueOrThrow({ where: { id: labelJobId } }),
    ).resolves.toMatchObject({
      id: labelJobId,
      operatorRollLineId: lineId,
      status: 'printed',
    });

    const continued = await shifts.open(operator, {
      postCode: fromPostCode,
      bigBagId: secondBagId,
      startKg: 400,
    });
    expect(continued.session).toMatchObject({ shiftId, postId: fromPostId, status: 'active' });
    await expect(commands.getCurrentMachineChange({ userId: operatorId })).resolves.toMatchObject({
      id: change.id,
      status: 'completed',
    });
    await expect(
      prisma.domainEvent.count({
        where: {
          objectId: assignmentId,
          type: 'audit:operator_machine_change_completed',
        },
      }),
    ).resolves.toBe(1);

    const finalRows = await prisma.rollDispatchItem.findMany({
      where: { id: { in: [unfinishedId, unstartedId, completedId, warehouseId] } },
      select: {
        id: true,
        assignedOperatorId: true,
        plannedShiftId: true,
        postId: true,
        workplaceId: true,
        machineId: true,
        queueRank: true,
        status: true,
      },
      orderBy: { queueRank: 'asc' },
    });
    expect(finalRows.slice(0, 2)).toEqual([
      {
        id: unfinishedId,
        assignedOperatorId: operatorId,
        plannedShiftId: shiftId,
        postId: fromPostId,
        workplaceId: fromPostId,
        machineId: fromPostCode,
        queueRank: 10,
        status: 'deferred',
      },
      {
        id: unstartedId,
        assignedOperatorId: operatorId,
        plannedShiftId: shiftId,
        postId: fromPostId,
        workplaceId: fromPostId,
        machineId: fromPostCode,
        queueRank: 20,
        status: 'assigned',
      },
    ]);
    expect(finalRows.slice(2)).toEqual([
      expect.objectContaining({
        id: completedId,
        plannedShiftId: oldShiftId,
        postId: fromPostId,
        queueRank: 30,
        status: 'done',
      }),
      expect.objectContaining({
        id: warehouseId,
        plannedShiftId: oldShiftId,
        postId: fromPostId,
        queueRank: 40,
        status: 'ready_for_warehouse',
      }),
    ]);
    expect(await sessions.getCurrent(operatorId)).toMatchObject({
      shiftId,
      postId: fromPostId,
      status: 'active',
    });
  });
});
