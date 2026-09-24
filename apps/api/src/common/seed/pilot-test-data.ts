import { Prisma, Role } from '@prisma/client';
import { registeredProductionBigBagSeed } from './bigbag-seed';
import { seedMaterialCatalog } from './material-catalog-seed';

const TEST_SHIFT_ID = 'pilot-test-shift-001';
const TEST_ORDER_ID = 'pilot-test-order-001';
const TEST_POSITION_ID = 'pilot-test-position-001';
const PILOT_PAYMENT_TERMS_TYPE = 'prepay_50_postpay_50_30d';
const SIMULATOR_ASSIGNMENT_ID = 'pilot-test-assignment-post-5';
const SIMULATOR_DISPATCH_ID = 'pilot-test-dispatch-2';
const SIMULATOR_LINE_ID = 'pilot-test-operator-line-2';
const SIMULATOR_ROLL_CODE = 'PILOT-SIM-ROLL-001';

function dateOnly(value: Date): Date {
  return new Date(`${value.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

interface PilotLane {
  bagCode: string;
  bagId: string;
  machineCode: 'POST-1' | 'POST-5';
  operatorExternalId: 'seed-operator' | 'seed-operator-3';
  rollCode: string;
}

const PILOT_LANES: readonly PilotLane[] = [
  {
    bagCode: 'PILOT-BAG-PHYSICAL-001',
    bagId: 'pilot-test-bag-physical-001',
    machineCode: 'POST-1',
    operatorExternalId: 'seed-operator',
    rollCode: 'PILOT-PHYSICAL-ROLL-001',
  },
  {
    bagCode: 'PILOT-BAG-SIM-001',
    bagId: 'pilot-test-bag-sim-001',
    machineCode: 'POST-5',
    operatorExternalId: 'seed-operator-3',
    rollCode: 'PILOT-SIM-ROLL-001',
  },
] as const;

export class PilotTestDataError extends Error {
  constructor(message: string) {
    super(`Pilot test data: ${message}`);
    this.name = 'PilotTestDataError';
  }
}

async function reconcileLegacySimulatorOwnership(
  prisma: Prisma.TransactionClient,
  currentOperatorId: string,
  postId: string,
): Promise<string> {
  const [assignment, dispatch, retiredOperator] = await Promise.all([
    prisma.operatorShiftMachineAssignment.findUnique({
      where: { id: SIMULATOR_ASSIGNMENT_ID },
    }),
    prisma.rollDispatchItem.findUnique({
      where: { rollCode: SIMULATOR_ROLL_CODE },
    }),
    prisma.user.findUnique({
      where: { externalId: 'seed-operator-4' },
    }),
  ]);
  if ((assignment === null) !== (dispatch === null)) {
    throw new PilotTestDataError('legacy simulator fixture identity is partial or unexpected');
  }
  for (const operatorId of [currentOperatorId, retiredOperator?.id]
    .filter((id): id is string => Boolean(id))
    .sort()) {
    await prisma.$queryRaw(
      Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${operatorId} FOR UPDATE`,
    );
  }
  const conflictingCurrentAssignment = await prisma.operatorShiftMachineAssignment.findFirst({
    where: {
      ...(assignment ? { id: { not: assignment.id } } : {}),
      operatorId: currentOperatorId,
      status: { in: ['planned', 'locked', 'breakdown_reassigned'] },
      shift: { status: { in: ['planned', 'open'] } },
    },
    select: { id: true },
  });
  if (!assignment || !dispatch) {
    if (!conflictingCurrentAssignment) return currentOperatorId;
    if (!retiredOperator) {
      throw new PilotTestDataError(
        'active simulator operator is occupied and no retired fixture owner exists',
      );
    }
    return retiredOperator.id;
  }
  if (
    assignment.shiftId !== TEST_SHIFT_ID ||
    assignment.postId !== postId ||
    dispatch.id !== SIMULATOR_DISPATCH_ID ||
    dispatch.postId !== postId ||
    dispatch.machineId !== 'POST-5' ||
    dispatch.plannedShiftId !== TEST_SHIFT_ID
  ) {
    throw new PilotTestDataError('legacy simulator fixture identity is partial or unexpected');
  }

  const line = await prisma.operatorRollLine.findUnique({
    where: { rollDispatchItemId: dispatch.id },
  });
  if (!line || line.id !== SIMULATOR_LINE_ID) {
    throw new PilotTestDataError('legacy simulator fixture identity is partial or unexpected');
  }

  const currentOwnership =
    assignment.operatorId === currentOperatorId &&
    dispatch.assignedOperatorId === currentOperatorId;
  if (currentOwnership && !retiredOperator) {
    if (conflictingCurrentAssignment) {
      throw new PilotTestDataError(
        'active simulator operator is occupied and no retired fixture owner exists',
      );
    }
    return currentOperatorId;
  }
  const retiredOwnership =
    retiredOperator !== null &&
    assignment.operatorId === retiredOperator.id &&
    dispatch.assignedOperatorId === retiredOperator.id;
  if (!currentOwnership && !retiredOwnership) {
    throw new PilotTestDataError('legacy simulator fixture ownership is partial or unexpected');
  }

  await prisma.$queryRaw(Prisma.sql`SELECT "id" FROM "posts" WHERE "id" = ${postId} FOR UPDATE`);
  await prisma.$queryRaw(
    Prisma.sql`SELECT "id" FROM "shifts" WHERE "id" = ${TEST_SHIFT_ID} FOR UPDATE`,
  );
  await prisma.$queryRaw(
    Prisma.sql`SELECT "id" FROM "operator_shift_machine_assignments"
      WHERE "id" = ${assignment.id} FOR UPDATE`,
  );
  await prisma.$queryRaw(
    Prisma.sql`SELECT "id" FROM "roll_dispatch_items"
      WHERE "id" = ${dispatch.id} FOR UPDATE`,
  );
  await prisma.$queryRaw(
    Prisma.sql`SELECT "id" FROM "operator_roll_lines" WHERE "id" = ${line.id} FOR UPDATE`,
  );

  const [
    lockedAssignment,
    lockedDispatch,
    lockedLine,
    targetAssignment,
    lockedConflictingCurrentAssignment,
  ] = await Promise.all([
    prisma.operatorShiftMachineAssignment.findUnique({
      where: { id: assignment.id },
    }),
    prisma.rollDispatchItem.findUnique({
      where: { id: dispatch.id },
    }),
    prisma.operatorRollLine.findUnique({
      where: { rollDispatchItemId: dispatch.id },
    }),
    prisma.operatorShiftMachineAssignment.findUnique({
      where: {
        shiftId_operatorId: {
          shiftId: TEST_SHIFT_ID,
          operatorId: currentOperatorId,
        },
      },
    }),
    prisma.operatorShiftMachineAssignment.findFirst({
      where: {
        id: { not: assignment.id },
        operatorId: currentOperatorId,
        status: { in: ['planned', 'locked', 'breakdown_reassigned'] },
        shift: { status: { in: ['planned', 'open'] } },
      },
      select: { id: true },
    }),
  ]);
  if (
    !lockedAssignment ||
    !lockedDispatch ||
    !lockedLine ||
    lockedAssignment.shiftId !== TEST_SHIFT_ID ||
    lockedAssignment.postId !== postId ||
    lockedDispatch.id !== SIMULATOR_DISPATCH_ID ||
    lockedDispatch.rollCode !== SIMULATOR_ROLL_CODE ||
    lockedDispatch.postId !== postId ||
    lockedDispatch.machineId !== 'POST-5' ||
    lockedDispatch.plannedShiftId !== TEST_SHIFT_ID ||
    lockedLine.id !== SIMULATOR_LINE_ID ||
    lockedLine.rollDispatchItemId !== lockedDispatch.id
  ) {
    throw new PilotTestDataError('legacy simulator fixture identity changed while locking');
  }
  const lockedCurrentOwnership =
    lockedAssignment.operatorId === currentOperatorId &&
    lockedDispatch.assignedOperatorId === currentOperatorId;
  const lockedRetiredOwnership =
    retiredOperator !== null &&
    lockedAssignment.operatorId === retiredOperator.id &&
    lockedDispatch.assignedOperatorId === retiredOperator.id;
  if (
    (currentOwnership && !lockedCurrentOwnership) ||
    (retiredOwnership && !lockedRetiredOwnership)
  ) {
    throw new PilotTestDataError('legacy simulator fixture ownership changed while locking');
  }
  if (lockedCurrentOwnership && !lockedConflictingCurrentAssignment) return currentOperatorId;
  if (lockedRetiredOwnership && lockedConflictingCurrentAssignment) return retiredOperator.id;
  if (!retiredOperator || (!lockedCurrentOwnership && !lockedRetiredOwnership)) {
    throw new PilotTestDataError('legacy simulator fixture ownership is partial or unexpected');
  }
  if (lockedRetiredOwnership && targetAssignment && targetAssignment.id !== lockedAssignment.id) {
    throw new PilotTestDataError('target operator already has an assignment in the pilot shift');
  }
  if (
    lockedAssignment.status !== 'planned' ||
    lockedAssignment.lockedAt !== null ||
    lockedAssignment.previousPostId !== null ||
    lockedAssignment.breakdownReason !== null ||
    lockedAssignment.reassignedAt !== null ||
    lockedDispatch.status !== 'assigned' ||
    lockedDispatch.completedAt !== null ||
    lockedLine.step !== 'assigned' ||
    lockedLine.deferredFromStep !== null ||
    lockedLine.spoolKg !== null ||
    lockedLine.grossKg !== null ||
    lockedLine.netKg !== null ||
    lockedLine.toleranceOk !== null ||
    lockedLine.labelState !== 'not_printed' ||
    lockedLine.warehouseState !== 'not_ready'
  ) {
    throw new PilotTestDataError('legacy simulator fixture has progressed runtime evidence');
  }

  const [session, machineChange, weightCount, defectCount, printCount, operationCount] =
    await Promise.all([
      prisma.operatorPostSession.findFirst({
        where: {
          shiftId: TEST_SHIFT_ID,
          postId,
        },
      }),
      prisma.operatorMachineChange.findFirst({
        where: { assignmentId: lockedAssignment.id },
        select: { id: true },
      }),
      prisma.weightCapture.count({ where: { operatorRollLineId: lockedLine.id } }),
      prisma.defectRecord.count({ where: { operatorRollLineId: lockedLine.id } }),
      prisma.labelPrintJob.count({ where: { operatorRollLineId: lockedLine.id } }),
      prisma.operatorRollOperation.count({ where: { operatorRollLineId: lockedLine.id } }),
    ]);
  if (
    session ||
    machineChange ||
    weightCount > 0 ||
    defectCount > 0 ||
    printCount > 0 ||
    operationCount > 0
  ) {
    throw new PilotTestDataError('legacy simulator fixture has progressed runtime evidence');
  }

  const previousOperatorId = lockedAssignment.operatorId;
  const nextOperatorId = lockedCurrentOwnership ? retiredOperator.id : currentOperatorId;
  const assignmentResult = await prisma.operatorShiftMachineAssignment.updateMany({
    where: {
      id: lockedAssignment.id,
      shiftId: TEST_SHIFT_ID,
      operatorId: previousOperatorId,
      postId,
      status: 'planned',
      lockedAt: null,
      previousPostId: null,
      breakdownReason: null,
      reassignedAt: null,
    },
    data: { operatorId: nextOperatorId },
  });
  if (assignmentResult.count !== 1) {
    throw new PilotTestDataError('legacy simulator assignment changed during migration');
  }
  const dispatchResult = await prisma.rollDispatchItem.updateMany({
    where: {
      id: lockedDispatch.id,
      rollCode: SIMULATOR_ROLL_CODE,
      assignedOperatorId: previousOperatorId,
      postId,
      machineId: 'POST-5',
      plannedShiftId: TEST_SHIFT_ID,
      status: 'assigned',
      completedAt: null,
    },
    data: { assignedOperatorId: nextOperatorId },
  });
  if (dispatchResult.count !== 1) {
    throw new PilotTestDataError('legacy simulator dispatch changed during migration');
  }
  return nextOperatorId;
}

/**
 * Creates fictional, create-only pilot fixtures. Re-running bootstrap must never rewind a roll,
 * reopen a session, reset a warehouse task or overwrite a physical fact captured by the tester.
 */
export async function seedPilotTestData(prisma: Prisma.TransactionClient): Promise<void> {
  const now = new Date();
  const plannedStartAt = new Date(now.getTime() - 60 * 60 * 1000);
  const plannedEndAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const laneContexts = await Promise.all(
    PILOT_LANES.map(async (lane) => {
      const [operator, post] = await Promise.all([
        prisma.user.findUnique({ where: { externalId: lane.operatorExternalId } }),
        prisma.post.findUnique({ where: { code: lane.machineCode } }),
      ]);
      if (!operator || !post) {
        throw new PilotTestDataError(
          `missing ${lane.operatorExternalId}/${lane.machineCode} topology`,
        );
      }
      return { ...lane, operator, post };
    }),
  );
  const simulatorLane = laneContexts.find((lane) => lane.rollCode === SIMULATOR_ROLL_CODE);
  if (!simulatorLane) throw new PilotTestDataError('simulator lane configuration is missing');
  const simulatorLaneOperatorId = await reconcileLegacySimulatorOwnership(
    prisma,
    simulatorLane.operator.id,
    simulatorLane.post.id,
  );

  for (const material of [
    {
      materialId: 'pilot-rm-pvd-15803',
      label: 'Пилот · ПВД 15803-020',
      actualQty: 320,
    },
    {
      materialId: 'pilot-rm-pvd-10803',
      label: 'Пилот · ПВД 10803-020',
      actualQty: 140,
    },
  ]) {
    await prisma.rawMaterialStock.upsert({
      where: { materialId: material.materialId },
      update: {},
      create: { ...material, unit: 'кг', factStatus: 'warehouse_fact' },
    });
  }
  await seedMaterialCatalog(prisma);

  const counterparty = await prisma.counterparty.upsert({
    where: { id: 'pilot-test-counterparty' },
    update: {},
    create: {
      id: 'pilot-test-counterparty',
      displayName: 'Пилотный заказчик',
      legalName: 'Тестовые данные — не реальный контрагент',
      inn: '0000000000',
    },
  });
  const order = await prisma.commercialOrder.upsert({
    where: { orderNumber: 'PILOT-TEST-001' },
    update: {},
    create: {
      id: TEST_ORDER_ID,
      orderNumber: 'PILOT-TEST-001',
      clientRequestId: '00000000-0000-4000-8000-000000009001',
      title: 'Первый аппаратный тест — фиктивные данные',
      creatorRole: Role.commercial,
      counterpartyId: counterparty.id,
      warehouseCoverageWorkflowVersion: 1,
      requestType: 'client_order',
      productionIndicator: 'in_production',
      warehouseCoverStatus: 'not_checked',
      paymentStatus: 'partial',
      shipmentStatus: 'not_shipped',
      commercialStage: 'sent_to_finance',
      sentToFinanceAt: now,
      positions: {
        create: {
          id: TEST_POSITION_ID,
          rollCount: 2,
          filmType: 'Рукав',
          actualThickness: '80 мкм',
          accountingThickness: '80 мкм',
          widthMm: 1700,
          plannedLengthM: 275,
          rawMaterialId: 'pilot-rm-pvd-15803',
          spoolType: 'Шпуля 76 мм',
          birka: 'PILOT-TEST',
          plannedWeightKg: 41.2,
          recipe: {
            create: {
              parameters: [
                { label: 'Назначение', value: 'Первый тест VPS/оборудования' },
                { label: 'Сырьё', value: 'ПВД 15803-020' },
              ],
              source: 'commercial_form',
              createdBy: 'pilot_seed',
            },
          },
        },
      },
    },
    include: { positions: { select: { id: true } } },
  });
  const position = order.positions.find((candidate) => candidate.id === TEST_POSITION_ID);
  if (!position) throw new PilotTestDataError('test order position is missing');

  const shift = await prisma.shift.upsert({
    where: { id: TEST_SHIFT_ID },
    update: {},
    create: {
      id: TEST_SHIFT_ID,
      label: 'Пилотное окно первого запуска',
      plannedStartAt,
      plannedEndAt,
      startedAt: null,
      status: 'planned',
    },
  });

  for (const lane of laneContexts) {
    const laneOperatorId =
      lane.rollCode === SIMULATOR_ROLL_CODE ? simulatorLaneOperatorId : lane.operator.id;
    await prisma.operatorShiftMachineAssignment.upsert({
      where: { shiftId_operatorId: { shiftId: shift.id, operatorId: laneOperatorId } },
      update: {},
      create: {
        id: `pilot-test-assignment-${lane.machineCode.toLowerCase()}`,
        shiftId: shift.id,
        operatorId: laneOperatorId,
        postId: lane.post.id,
        status: 'planned',
        lockedAt: null,
      },
    });
    await prisma.bigBagUnit.upsert({
      where: { code: lane.bagCode },
      update: {},
      create: {
        id: lane.bagId,
        code: lane.bagCode,
        material: 'ПВД 15803-020',
        materialId: 'pilot-rm-pvd-15803',
        status: 'available',
        initialKg: 500,
        currentKg: 500,
        lastMeasuredKg: 500,
        createdByRole: Role.warehouse,
        ...registeredProductionBigBagSeed(),
      },
    });
  }

  const productionOrder = await prisma.productionOrder.upsert({
    where: { commercialOrderId: order.id },
    update: {},
    create: {
      id: 'pilot-test-production-001',
      commercialOrderId: order.id,
      indicator: 'in_progress',
      approvalState: 'approved',
    },
  });
  for (const [index, lane] of laneContexts.entries()) {
    const dispatch = await prisma.rollDispatchItem.upsert({
      where: { rollCode: lane.rollCode },
      update: {},
      create: {
        id: `pilot-test-dispatch-${index + 1}`,
        rollCode: lane.rollCode,
        productionOrderId: productionOrder.id,
        orderLineId: position.id,
        positionSequence: index + 1,
        rawMaterialId: 'pilot-rm-pvd-15803',
        recipeVersion: 'v1',
        filmType: 'Рукав',
        widthMm: 1700,
        plannedLengthM: 275,
        plannedWeightKg: 41.2,
        characteristicsSnapshot: {
          purpose: 'pilot_test',
          filmType: 'Рукав',
          actualThickness: '80 мкм',
          accountingThickness: '80 мкм',
          widthMm: 1700,
          plannedLengthM: 275,
        },
        assignedOperatorId:
          lane.rollCode === SIMULATOR_ROLL_CODE ? simulatorLaneOperatorId : lane.operator.id,
        machineId: lane.machineCode,
        postId: lane.post.id,
        plannedShiftId: shift.id,
        queueRank: index + 1,
        priority: 100 - index,
        status: 'assigned',
      },
    });
    await prisma.operatorRollLine.upsert({
      where: { rollDispatchItemId: dispatch.id },
      update: {},
      create: {
        id: `pilot-test-operator-line-${index + 1}`,
        rollDispatchItemId: dispatch.id,
        sequence: index + 1,
        planKg: 41.2,
        step: 'assigned',
      },
    });
  }

  await prisma.warehouseAcceptanceTask.upsert({
    where: { id: 'pilot-test-receiving-001' },
    update: {},
    create: {
      id: 'pilot-test-receiving-001',
      mode: 'receiving',
      status: 'open',
      operationCode: 'PILOT-TEST-RECV-001',
      orderId: order.id,
      positionId: position.id,
      rows: {
        create: laneContexts.map((lane, index) => ({
          id: `pilot-test-scan-row-${index + 1}`,
          rollCode: lane.rollCode,
          fromOrderId: order.orderNumber,
          scanStatus: 'expected',
        })),
      },
    },
  });

  const financeCreatedAt = now;
  const financeOrder = await prisma.financeOrder.upsert({
    where: { commercialOrderId: order.id },
    update: {},
    create: {
      id: 'pilot-test-finance-001',
      commercialOrderId: order.id,
      invoiceStatus: 'invoiced',
      paymentStatus: 'partial',
      amountValue: 100,
      amountLabel: '100 RUB · тестовый платёж',
      paymentTermsType: PILOT_PAYMENT_TERMS_TYPE,
      invoiceIssuedAt: financeCreatedAt,
      sourceStatus: 'ready',
      createdAt: financeCreatedAt,
    },
  });
  const invoiceIssuedAt = financeOrder.invoiceIssuedAt ?? financeOrder.createdAt;
  await prisma.financeOrder.updateMany({
    where: { id: financeOrder.id, invoiceIssuedAt: null },
    data: { invoiceIssuedAt },
  });
  await prisma.financeOrder.updateMany({
    where: { id: financeOrder.id, paymentTermsType: null },
    data: { paymentTermsType: PILOT_PAYMENT_TERMS_TYPE },
  });

  const paymentPolicy = await prisma.paymentPolicy.upsert({
    where: { financeOrderId: financeOrder.id },
    update: {},
    create: {
      id: 'pilot-test-payment-policy-001',
      financeOrderId: financeOrder.id,
      installmentDays: 30,
      capturedProductionLeadDays: 2,
      revision: 1,
    },
  });
  const paymentStages = await Promise.all([
    prisma.paymentPolicyStage.upsert({
      where: {
        paymentPolicyId_sequence: { paymentPolicyId: paymentPolicy.id, sequence: 1 },
      },
      update: {},
      create: {
        id: 'pilot-test-payment-stage-001',
        paymentPolicyId: paymentPolicy.id,
        sequence: 1,
        trigger: 'invoice_issued',
        percentageBasisPoints: 5000,
        offsetDays: 0,
        label: 'Предоплата',
      },
    }),
    prisma.paymentPolicyStage.upsert({
      where: {
        paymentPolicyId_sequence: { paymentPolicyId: paymentPolicy.id, sequence: 2 },
      },
      update: {},
      create: {
        id: 'pilot-test-payment-stage-002',
        paymentPolicyId: paymentPolicy.id,
        sequence: 2,
        trigger: 'full_shipment',
        percentageBasisPoints: 5000,
        offsetDays: 30,
        label: 'После полной отгрузки',
      },
    }),
  ]);
  await Promise.all([
    prisma.paymentSchedule.upsert({
      where: { paymentPolicyStageId: paymentStages[0].id },
      update: {},
      create: {
        id: 'pilot-test-payment-schedule-001',
        financeOrderId: financeOrder.id,
        paymentPolicyStageId: paymentStages[0].id,
        percentageBasisPoints: 5000,
        offsetDays: 0,
        kind: 'invoice_prepayment',
        startsAt: invoiceIssuedAt,
        dueDate: dateOnly(invoiceIssuedAt),
        amount: 50,
        status: 'paid',
        source: 'pilot_seed',
      },
    }),
    prisma.paymentSchedule.upsert({
      where: { paymentPolicyStageId: paymentStages[1].id },
      update: {},
      create: {
        id: 'pilot-test-payment-schedule-002',
        financeOrderId: financeOrder.id,
        paymentPolicyStageId: paymentStages[1].id,
        percentageBasisPoints: 5000,
        offsetDays: 30,
        kind: 'post_delivery',
        startsAt: null,
        dueDate: null,
        amount: 50,
        status: 'unpaid',
        source: 'pilot_seed',
      },
    }),
  ]);
  await prisma.paymentOperation.upsert({
    where: {
      financeOrderId_operationKey: {
        financeOrderId: financeOrder.id,
        operationKey: 'pilot-test-prepayment-001',
      },
    },
    update: {},
    create: {
      id: 'pilot-test-payment-001',
      financeOrderId: financeOrder.id,
      operationKey: 'pilot-test-prepayment-001',
      operationType: 'manual_adjustment',
      amount: 50,
      source: 'pilot_seed',
      createdByRole: Role.finance,
      reconciled: true,
    },
  });
}
