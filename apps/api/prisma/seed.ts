import { createHash } from 'node:crypto';
import { Prisma, PrismaClient, Role } from '@prisma/client';
import { buildRollDispatchItemSeedUpsert } from '../src/common/seed/production-seed';
import { seedSystemAccessTemplates } from '../src/common/seed/admin-access-seed';
import { registeredProductionBigBagSeed } from '../src/common/seed/bigbag-seed';
import { seedCanonicalPilotTemplates } from '../src/common/seed/canonical-pilot-templates';
import { seedMaterialCatalog } from '../src/common/seed/material-catalog-seed';
import {
  PilotSeedConflictError,
  seedPilot as seedPilotBootstrap,
} from '../src/common/seed/pilot-seed';
import { PilotTestDataError, seedPilotTestData } from '../src/common/seed/pilot-test-data';
import {
  SeedAccountConflictError,
  reconcileSeedAccounts,
} from '../src/common/seed/seed-account-reconciliation';
import { runSeedProfile } from '../src/common/seed/seed-runner';
import {
  PILOT_ACCOUNT_MANIFEST,
  RETIRED_PILOT_ACCOUNT_EXTERNAL_IDS,
  SeedProfileError,
  type DemoSeedProfile,
} from '../src/common/seed/seed-profile';

let prisma: PrismaClient;

async function seedDemo(config: DemoSeedProfile) {
  if (!process.env.SEED_PASSWORD) {
    console.warn('SEED_PASSWORD not set — using dev default "plenka-dev" (DEV ONLY).');
  }
  await prisma.$transaction(async (tx) => {
    await completeRetiredDemoAssignment(tx);
    await reconcileSeedAccounts(tx, {
      accounts: PILOT_ACCOUNT_MANIFEST,
      retiredExternalIds: RETIRED_PILOT_ACCOUNT_EXTERNAL_IDS,
      passwordFor: () => config.password,
      conflict: (message) => new SeedAccountConflictError(message),
    });
  });
  console.log(`Seeded ${PILOT_ACCOUNT_MANIFEST.length} users (including three operators).`);

  if (config.scope === 'accounts') {
    console.log('Demo seed scope is accounts; business demo facts were not created.');
    return;
  }

  await seedCommercial();
  console.log('Seeded commercial demo (orders, positions, recipes, cover proposal).');

  await seedProduction();
  console.log('Seeded production demo (production order + roll dispatch rows).');

  await seedOperator();
  console.log('Seeded operator demo (roll lines + big bag).');

  await seedWarehouse();
  console.log('Seeded warehouse demo (acceptance task + rows, rolls, raw materials).');

  await seedFinance();
  console.log('Seeded finance demo (finance order + source snapshot).');

  await seedDirectorAdmin();
  console.log('Seeded director/admin demo (decisions, penalties, templates).');

  await seedPosts();
  await seedWarehouseScanTokens();
  console.log('Seeded immutable opaque labels for warehouse demo rolls.');
}

async function seedWarehouseScanTokens() {
  const rolls = await prisma.warehouseRoll.findMany({ select: { rollCode: true } });
  if (rolls.length === 0) return;
  await prisma.rollScanToken.createMany({ data: rolls, skipDuplicates: true });
}

async function completeRetiredDemoAssignment(tx: Prisma.TransactionClient): Promise<void> {
  const retiredOperator = await tx.user.findUnique({
    where: { externalId: 'seed-operator-4' },
  });
  if (!retiredOperator) return;
  const assignment = await tx.operatorShiftMachineAssignment.findUnique({
    where: {
      shiftId_operatorId: {
        shiftId: 'shift-demo',
        operatorId: retiredOperator.id,
      },
    },
  });
  if (!assignment) return;
  const [retiredPost, shift] = await Promise.all([
    tx.post.findUnique({ where: { code: 'POST-4' } }),
    tx.shift.findUnique({ where: { id: 'shift-demo' } }),
  ]);
  if (!retiredPost || !shift || assignment.postId !== retiredPost.id) {
    throw new SeedAccountConflictError('retired demo assignment identity is unexpected');
  }

  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "posts" WHERE "id" = ${retiredPost.id} FOR UPDATE`,
  );
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "shifts" WHERE "id" = ${shift.id} FOR UPDATE`);
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "operator_shift_machine_assignments"
      WHERE "id" = ${assignment.id} FOR UPDATE`,
  );

  const [lockedPost, lockedShift, lockedAssignment] = await Promise.all([
    tx.post.findUnique({ where: { id: retiredPost.id } }),
    tx.shift.findUnique({ where: { id: shift.id } }),
    tx.operatorShiftMachineAssignment.findUnique({ where: { id: assignment.id } }),
  ]);
  if (
    !lockedPost ||
    lockedPost.code !== 'POST-4' ||
    !lockedShift ||
    lockedShift.id !== 'shift-demo' ||
    !lockedAssignment ||
    lockedAssignment.shiftId !== 'shift-demo' ||
    lockedAssignment.operatorId !== retiredOperator.id ||
    lockedAssignment.postId !== retiredPost.id
  ) {
    throw new SeedAccountConflictError('retired demo assignment identity changed while locking');
  }
  if (
    !['planned', 'locked', 'completed'].includes(lockedAssignment.status) ||
    (lockedAssignment.status === 'planned' && lockedAssignment.lockedAt !== null) ||
    (lockedAssignment.status === 'locked' && lockedAssignment.lockedAt === null) ||
    lockedAssignment.previousPostId !== null ||
    lockedAssignment.breakdownReason !== null ||
    lockedAssignment.reassignedAt !== null
  ) {
    throw new SeedAccountConflictError('retired demo assignment lifecycle is unexpected');
  }
  const [activeSession, machineChange] = await Promise.all([
    tx.operatorPostSession.findFirst({
      where: {
        operatorId: retiredOperator.id,
        shiftId: 'shift-demo',
        postId: retiredPost.id,
        status: 'active',
        endedAt: null,
      },
    }),
    tx.operatorMachineChange.findFirst({
      where: { assignmentId: lockedAssignment.id },
      select: { id: true },
    }),
  ]);
  if (activeSession || machineChange) {
    throw new SeedAccountConflictError('retired demo assignment has progressed runtime evidence');
  }
  if (lockedAssignment.status !== 'completed') {
    const updated = await tx.operatorShiftMachineAssignment.updateMany({
      where: {
        id: lockedAssignment.id,
        shiftId: 'shift-demo',
        operatorId: retiredOperator.id,
        postId: retiredPost.id,
        status: lockedAssignment.status,
        lockedAt: lockedAssignment.lockedAt,
        previousPostId: null,
        breakdownReason: null,
        reassignedAt: null,
      },
      data: { status: 'completed' },
    });
    if (updated.count !== 1) {
      throw new SeedAccountConflictError('retired demo assignment changed during completion');
    }
  }
}

/**
 * V2 S2 seed: 7 machine-posts (Variant B), each with its own scale/printer/scanner bound
 * via postId. A new станок is just one more Post row. Demo order A-1024 rolls bind to POST-1.
 */
async function seedPosts() {
  const POSTS = [
    { code: 'POST-1', name: 'Китайка старая', agentStatus: 'online' },
    { code: 'POST-2', name: 'ABC новая', agentStatus: 'online' },
    { code: 'POST-3', name: 'ABC старая', agentStatus: 'offline' },
    { code: 'POST-4', name: 'Бегемот', agentStatus: 'unknown' },
    { code: 'POST-5', name: 'Матиль', agentStatus: 'unknown' },
    { code: 'POST-6', name: 'Пнд новая', agentStatus: 'unknown' },
    { code: 'POST-7', name: 'Урп', agentStatus: 'unknown' },
  ];
  const postIds = new Map<string, string>();
  for (const [i, p] of POSTS.entries()) {
    // Dev agent token for the (simulated) on-post agent: token = `agent-post-N`.
    const agentTokenHash = createHash('sha256')
      .update(`agent-${p.code.toLowerCase()}`)
      .digest('hex');
    const post = await prisma.post.upsert({
      where: { code: p.code },
      update: { name: p.name, agentStatus: p.agentStatus, agentTokenHash },
      create: {
        code: p.code,
        name: p.name,
        status: 'active',
        agentStatus: p.agentStatus,
        agentTokenHash,
      },
    });
    postIds.set(p.code, post.id);
    const n = i + 1;
    const devices = [
      {
        id: `dev-scale-${n}`,
        code: `SCALE-${n}`,
        label: `Весы станка ${n}`,
        kind: 'scale',
        connectionKind: 'usb-rs232',
        status: 'ready',
      },
      {
        id: `dev-scanner-${n}`,
        code: `SCANNER-${n}`,
        label: `Сканер станка ${n}`,
        kind: 'scanner',
        connectionKind: 'usb-hid',
        status: 'ready',
      },
      {
        id: `dev-printer-${n}`,
        code: `PRINTER-${n}`,
        label: `Принтер станка ${n}`,
        kind: 'printer',
        connectionKind: 'usb-or-tcp',
        status: n === 1 ? 'offline' : 'ready',
      },
    ];
    for (const d of devices) {
      await prisma.deviceRuntime.upsert({
        where: { id: d.id },
        update: {
          code: d.code,
          label: d.label,
          kind: d.kind,
          connectionKind: d.connectionKind,
          isEnabled: true,
          postId: post.id,
          status: d.status,
        },
        create: {
          ...d,
          isEnabled: true,
          postId: post.id,
          ownerRole: Role.admin,
          parsedPayload: { lastValue: d.kind === 'scale' ? '43.4 kg' : 'ok' },
          rawPayload: { _raw: `RAW ${d.kind} frame — admin diagnostics only`, bytes: '0x00ff' },
        },
      });
    }
  }
  // Assignment lands on the post model: bind the demo order rolls to POST-1.
  const post1Id = postIds.get('POST-1');
  if (post1Id) {
    await prisma.rollDispatchItem.updateMany({
      where: {
        rollCode: { startsWith: 'A-1024-roll-' },
        postId: null,
        machineId: null,
      },
      data: { postId: post1Id, machineId: 'POST-1' },
    });
  }

  // Demo (V2 S3): the seed operator is at POST-1 in an open shift — ready to weigh.
  const operators = await prisma.user.findMany({
    where: {
      externalId: {
        in: ['seed-operator', 'seed-operator-2', 'seed-operator-3'],
      },
    },
  });
  if (operators.length > 0 && post1Id) {
    const now = new Date();
    const plannedStartAt = new Date(now.getTime() - 4 * 60 * 60 * 1000);
    const plannedEndAt = new Date(now.getTime() + 4 * 60 * 60 * 1000);
    const shift = await prisma.shift.upsert({
      where: { id: 'shift-demo' },
      update: { plannedStartAt, plannedEndAt, startedAt: plannedStartAt, status: 'open' },
      create: {
        id: 'shift-demo',
        label: 'Демо-смена',
        plannedStartAt,
        plannedEndAt,
        startedAt: plannedStartAt,
        status: 'open',
      },
    });
    const assignmentPlan = [
      { externalId: 'seed-operator', postCode: 'POST-1' },
      { externalId: 'seed-operator-2', postCode: 'POST-2' },
      { externalId: 'seed-operator-3', postCode: 'POST-3' },
    ];
    for (const plan of assignmentPlan) {
      const operator = operators.find((candidate) => candidate.externalId === plan.externalId);
      const postId = postIds.get(plan.postCode);
      if (!operator || !postId) continue;
      await prisma.operatorShiftMachineAssignment.upsert({
        where: { shiftId_operatorId: { shiftId: shift.id, operatorId: operator.id } },
        update: {},
        create: {
          shiftId: shift.id,
          operatorId: operator.id,
          postId,
          status: 'locked',
          lockedAt: plannedStartAt,
        },
      });
    }
    const operator = operators.find((candidate) => candidate.externalId === 'seed-operator');
    if (!operator) return;
    await prisma.rollDispatchItem.updateMany({
      where: {
        rollCode: 'A-1024-roll-1',
        assignedOperatorId: operator.id,
        postId: post1Id,
        machineId: 'POST-1',
        plannedShiftId: null,
      },
      data: { plannedShiftId: shift.id },
    });
    await prisma.operatorPostSession.upsert({
      where: { id: 'sess-demo' },
      update: { status: 'active', endedAt: null, postId: post1Id, shiftId: shift.id },
      create: {
        id: 'sess-demo',
        operatorId: operator.id,
        postId: post1Id,
        shiftId: shift.id,
        status: 'active',
      },
    });
    await seedDefectBagDemo(operators, postIds, shift.id, plannedStartAt);
  }
  console.log(
    `Seeded ${POSTS.length} machine-posts + ${POSTS.length * 3} devices + demo shift/session.`,
  );
}

async function seedDefectBagDemo(
  operators: Array<{ id: string; externalId: string | null }>,
  postIds: Map<string, string>,
  shiftId: string,
  weighedAt: Date,
) {
  const readyOperator = operators.find(({ externalId }) => externalId === 'seed-operator-2');
  const receivedOperator = operators.find(({ externalId }) => externalId === 'seed-operator-3');
  const warehouse = await prisma.user.findUnique({ where: { externalId: 'seed-warehouse' } });
  const post2Id = postIds.get('POST-2');
  const post3Id = postIds.get('POST-3');
  if (!readyOperator || !receivedOperator || !warehouse || !post2Id || !post3Id) {
    return;
  }

  const fixtures = [
    {
      id: 'defect-bag-demo-ready',
      code: 'DEF-DEMO-READY',
      sessionId: 'sess-demo-defect-ready',
      operatorId: readyOperator.id,
      postId: post2Id,
      scaleId: 'dev-scale-2',
      printerId: 'dev-printer-2',
      status: 'ready_for_warehouse',
      defectType: 'secondary',
      weightKg: 4.2,
      recordedDefectKg: 4,
      differenceKg: 0.2,
      token: `bbt_${'a'.repeat(64)}`,
      weighOperationKey: 'd0000000-0000-4000-8000-000000000001',
      printOperationKey: 'd0000000-0000-4000-8000-000000000002',
      printLeaseToken: 'd0000000-0000-4000-8000-000000000003',
    },
    {
      id: 'defect-bag-demo-received',
      code: 'DEF-DEMO-RECEIVED',
      sessionId: 'sess-demo-defect-received',
      operatorId: receivedOperator.id,
      postId: post3Id,
      scaleId: 'dev-scale-3',
      printerId: 'dev-printer-3',
      status: 'received',
      defectType: 'aika',
      weightKg: 3.1,
      recordedDefectKg: 3,
      differenceKg: 0.1,
      token: `bbt_${'b'.repeat(64)}`,
      weighOperationKey: 'd0000000-0000-4000-8000-000000000004',
      printOperationKey: 'd0000000-0000-4000-8000-000000000005',
      printLeaseToken: 'd0000000-0000-4000-8000-000000000006',
    },
  ] as const;

  for (const fixture of fixtures) {
    await prisma.operatorPostSession.upsert({
      where: { id: fixture.sessionId },
      update: {},
      create: {
        id: fixture.sessionId,
        operatorId: fixture.operatorId,
        postId: fixture.postId,
        shiftId,
        status: 'closed',
        startedAt: weighedAt,
        endedAt: weighedAt,
      },
    });
    await prisma.defectBag.upsert({
      where: { code: fixture.code },
      update: {},
      create: {
        id: fixture.id,
        code: fixture.code,
        postSessionId: fixture.sessionId,
        status: fixture.status,
        defectType: fixture.defectType,
        weightKg: fixture.weightKg,
        recordedDefectKg: fixture.recordedDefectKg,
        differenceKg: fixture.differenceKg,
        scaleDeviceId: fixture.scaleId,
        scaleStatus: 'ready',
        scaleStable: true,
        weighOperationKey: fixture.weighOperationKey,
        weighedAt,
        scanToken: { create: { token: fixture.token } },
      },
    });
    await prisma.defectBagLabelPrintJob.upsert({
      where: { operationKey: fixture.printOperationKey },
      update: {},
      create: {
        id: `${fixture.id}-print`,
        operationKey: fixture.printOperationKey,
        defectBagId: fixture.id,
        printerId: fixture.printerId,
        status: 'submitted',
        actorId: fixture.operatorId,
        postSessionId: fixture.sessionId,
        postId: fixture.postId,
        leaseToken: fixture.printLeaseToken,
        leaseExpiresAt: weighedAt,
        gatewayCommandId: `${fixture.id}-demo-print`,
        completedAt: weighedAt,
        createdAt: weighedAt,
      },
    });
  }

  const warehouseSessionId = 'session-demo-defect-warehouse';
  await prisma.session.upsert({
    where: { id: warehouseSessionId },
    update: {},
    create: {
      id: warehouseSessionId,
      userId: warehouse.id,
      tokenHash: createHash('sha256').update(warehouseSessionId).digest('hex'),
      purpose: 'full',
      expiresAt: weighedAt,
      revokedAt: weighedAt,
    },
  });
  await prisma.defectBagMovement.upsert({
    where: { operationKey: 'd0000000-0000-4000-8000-000000000007' },
    update: {},
    create: {
      id: 'defect-bag-demo-received-movement',
      operationKey: 'd0000000-0000-4000-8000-000000000007',
      defectBagId: 'defect-bag-demo-received',
      kind: 'receive',
      actorId: warehouse.id,
      sessionId: warehouseSessionId,
      postId: null,
      deviceId: null,
      captureChannel: 'warehouse_browser_hid',
      createdAt: weighedAt,
    },
  });
}

/**
 * Slice-7 seed: director decision queue + penalties (event-backed analytics) + role templates.
 * (Device runtimes now live with their machine-posts — see seedPosts, V2 S2.)
 */
async function seedDirectorAdmin() {
  const operator = await prisma.user.findUnique({ where: { externalId: 'seed-operator' } });

  await prisma.directorDecision.upsert({
    where: { id: 'dec-1' },
    update: {},
    create: {
      id: 'dec-1',
      scope: 'finance',
      objectId: 'fo-A-1024',
      status: 'pending',
      severity: 'warning',
    },
  });

  await prisma.penalty.upsert({
    where: { id: 'pen-1' },
    update: {},
    create: {
      id: 'pen-1',
      targetRole: Role.operator,
      employeeId: operator?.id,
      amount: 1500,
      reason: 'Брак сверх нормы',
      authorRole: Role.director,
    },
  });

  await seedSystemAccessTemplates(prisma);
}

/**
 * Slice-6 seed: a FinanceOrder for A-1024 plus a 1С-mock source snapshot whose rawPayload
 * must never reach finance/business projections (only admin diagnostics, ТЗ §8).
 */
async function seedFinance() {
  const order = await prisma.commercialOrder.findUnique({ where: { orderNumber: 'A-1024' } });
  if (!order) return;
  const fo = await prisma.financeOrder.upsert({
    where: { id: 'fo-A-1024' },
    update: { externalId: 'mock-invoice-a-1024' },
    create: {
      id: 'fo-A-1024',
      commercialOrderId: order.id,
      invoiceStatus: 'not_invoiced',
      paymentStatus: 'unpaid',
      amountValue: 0,
      amountLabel: '—',
      sourceStatus: 'ready',
      externalId: 'mock-invoice-a-1024',
    },
  });
  await prisma.sourceSnapshot.upsert({
    where: { id: 'snap-1' },
    update: {
      // Backfill the generalized subject fields onto an already-seeded snap-1 row (S6).
      subjectType: 'invoice',
      subjectId: fo.id,
      externalId: 'mock-invoice-a-1024',
      sourceVersion: 'v1',
    },
    create: {
      id: 'snap-1',
      financeOrderId: fo.id,
      subjectType: 'invoice',
      subjectId: fo.id,
      externalId: 'mock-invoice-a-1024',
      sourceVersion: 'v1',
      sourceKind: 'mock_1C',
      ownerRole: Role.finance,
      capturedAt: new Date(),
      importedAt: new Date(),
      staleness: 'fresh',
      parsed: { invoiceNo: 'СЧ-1024', total: 150000, currency: 'RUB' },
      rawPayload: { _internal: 'RAW 1C XML — admin diagnostics only', secret: true },
    },
  });
}

/**
 * Slice-5 seed: a receiving acceptance task whose expected rows are the A-1024 rolls
 * (operator handover later makes them physically scannable), two labelled free warehouse rolls,
 * and raw-material stock (warehouse fact).
 */
async function seedWarehouse() {
  await prisma.warehouseAcceptanceTask.upsert({
    where: { id: 'task-recv-1' },
    update: {},
    create: {
      id: 'task-recv-1',
      mode: 'receiving',
      status: 'open',
      rows: {
        create: [
          { rollCode: 'A-1024-roll-1', fromOrderId: 'A-1024', scanStatus: 'expected' },
          { rollCode: 'A-1024-roll-2', fromOrderId: 'A-1024', scanStatus: 'expected' },
        ],
      },
    },
  });

  for (const code of ['STK-roll-1', 'STK-roll-2']) {
    await prisma.warehouseRoll.upsert({
      where: { rollCode: code },
      update: {},
      create: { rollCode: code, ownerCounterpartyId: 'cp-uralpak', warehouseStatus: 'received' },
    });
  }

  const materials = [
    {
      materialId: 'rm-pvd-15803',
      label: 'ПВД 15803-020',
      actualQty: 320,
      externalId: 'mock-stock-rm-pvd-15803',
    },
    {
      materialId: 'rm-pvd-10803',
      label: 'ПВД 10803-020',
      actualQty: 140,
      externalId: 'mock-stock-rm-pvd-10803',
    },
  ];
  for (const m of materials) {
    await prisma.rawMaterialStock.upsert({
      where: { materialId: m.materialId },
      update: { externalId: m.externalId },
      create: { ...m, unit: 'кг', factStatus: 'warehouse_fact' },
    });
  }
  await seedMaterialCatalog(prisma);
}

/**
 * Slice-4 seed: one OperatorRollLine per A-1024 dispatch roll (so the operator
 * queue/weights/QR endpoints have rolls to execute) plus a big-bag for the manual
 * weight exception.
 */
async function seedOperator() {
  const codes = ['A-1024-roll-1', 'A-1024-roll-2', 'A-1024-roll-3', 'A-1024-roll-4'];
  for (const [i, code] of codes.entries()) {
    const item = await prisma.rollDispatchItem.findUnique({ where: { rollCode: code } });
    if (!item) continue;
    await prisma.operatorRollLine.upsert({
      where: { rollDispatchItemId: item.id },
      update: {},
      create: { rollDispatchItemId: item.id, sequence: i + 1, planKg: 41.2, step: 'assigned' },
    });
  }
  // Big bags the warehouse has already packed from raw material stock — the operator
  // picks one of these at shift open (design 2026-07-13 §3.1, §6).
  const bags = [
    { code: 'BB-PVD-15803', material: 'ПВД 15803-020', materialId: 'rm-pvd-15803', kg: 500 },
    { code: 'BB-15803-01', material: 'ПВД 15803-020', materialId: 'rm-pvd-15803', kg: 500 },
    { code: 'BB-15803-02', material: 'ПВД 15803-020', materialId: 'rm-pvd-15803', kg: 300 },
    { code: 'BB-10803-01', material: 'ПВД 10803-020', materialId: 'rm-pvd-10803', kg: 400 },
  ];
  for (const bag of bags) {
    await prisma.bigBagUnit.upsert({
      where: { code: bag.code },
      update: {},
      create: {
        code: bag.code,
        material: bag.material,
        materialId: bag.materialId,
        initialKg: bag.kg,
        currentKg: bag.kg,
        lastMeasuredKg: bag.kg,
        status: 'available',
        createdByRole: 'warehouse',
        ...registeredProductionBigBagSeed(),
      },
    });
  }
}

/**
 * Slice-3 seed: a ProductionOrder derived from commercial order A-1024 plus four
 * RollDispatchItem rows (roll-1 assigned to the seed operator, the rest new), so the
 * production dispatch + workload endpoints return coherent data for the whole-order flow.
 */
async function seedProduction() {
  const order = await prisma.commercialOrder.findUnique({
    where: { orderNumber: 'A-1024' },
    include: { positions: { orderBy: { id: 'asc' }, include: { recipe: true } } },
  });
  if (!order) return;
  const operator = await prisma.user.findUnique({ where: { externalId: 'seed-operator' } });
  const position = order.positions[0];

  const po = await prisma.productionOrder.upsert({
    where: { commercialOrderId: order.id },
    update: {},
    create: {
      commercialOrderId: order.id,
      indicator: 'needs_production',
      approvalState: 'pending',
    },
  });

  const rolls = [
    { rollCode: 'A-1024-roll-1', assignedOperatorId: operator?.id ?? null, status: 'assigned' },
    { rollCode: 'A-1024-roll-2', assignedOperatorId: null, status: 'new' },
    { rollCode: 'A-1024-roll-3', assignedOperatorId: null, status: 'new' },
    { rollCode: 'A-1024-roll-4', assignedOperatorId: null, status: 'new' },
  ];
  for (const [i, r] of rolls.entries()) {
    await prisma.rollDispatchItem.upsert(
      buildRollDispatchItemSeedUpsert({
        productionOrderId: po.id,
        position,
        sequence: i + 1,
        roll: r,
      }),
    );
  }
}

/**
 * Commercial acceptance seed: incoming, draft, in-work and completed examples with
 * stable request/external ids. All cover facts are persisted as proposals/matches/
 * reservations; no UI-only fixture is required to render the five live sections.
 */
async function seedCommercial() {
  const uralpak = await prisma.counterparty.upsert({
    where: { id: 'cp-uralpak' },
    update: { externalId: 'mock-counterparty-uralpak' },
    create: {
      id: 'cp-uralpak',
      displayName: 'УралПак',
      legalName: 'ООО «УралПак»',
      inn: '6600000000',
      externalId: 'mock-counterparty-uralpak',
    },
  });

  // A couple more platform-native counterparties so the intake picker is non-empty.
  for (const cp of [
    { id: 'cp-sibplast', displayName: 'СибПласт', legalName: 'ООО «СибПласт»', inn: '5400000000' },
    {
      id: 'cp-tehnofilm',
      displayName: 'ТехноПлёнка',
      legalName: 'АО «ТехноПлёнка»',
      inn: '7700000000',
    },
  ]) {
    await prisma.counterparty.upsert({
      where: { id: cp.id },
      update: { displayName: cp.displayName, legalName: cp.legalName, inn: cp.inn },
      create: cp,
    });
  }

  const productionLead = await prisma.user.findUnique({
    where: { externalId: 'seed-production' },
  });
  await seedCanonicalPilotTemplates(prisma, {
    counterpartyId: uralpak.id,
    createdById: productionLead?.id,
  });

  const order = await prisma.commercialOrder.upsert({
    where: { orderNumber: 'A-1024' },
    update: {
      externalId: 'mock-order-a-1024',
      clientRequestId: '00000000-0000-4000-8000-000000001024',
      commercialStage: 'sent_to_finance',
      sentToFinanceAt: new Date(),
    },
    create: {
      orderNumber: 'A-1024',
      clientRequestId: '00000000-0000-4000-8000-000000001024',
      creatorRole: Role.commercial,
      counterpartyId: uralpak.id,
      warehouseCoverageWorkflowVersion: 1,
      requestType: 'client_order',
      warehouseCoverStatus: 'full_proposed',
      commercialStage: 'sent_to_finance',
      sentToFinanceAt: new Date(),
      externalId: 'mock-order-a-1024',
      positions: {
        create: [
          {
            rollCount: 4,
            filmType: 'Рукав',
            actualThickness: '80 мкм',
            accountingThickness: '75 мкм',
            rawMaterialId: 'rm-pvd-15803',
            spoolType: 'втулка 76',
            birka: 'УралПак-80',
            recipe: {
              create: {
                parameters: [
                  { label: 'Сырьё', value: 'ПВД 15803-020' },
                  { label: 'Температура', value: 'шаблон УралПак' },
                ],
                source: 'commercial_form',
                createdBy: 'commercial',
              },
            },
          },
          {
            rollCount: 2,
            filmType: 'Полотно',
            actualThickness: '100 мкм',
            accountingThickness: '95 мкм',
            rawMaterialId: 'rm-pvd-10803',
            spoolType: 'втулка 76',
            birka: 'УралПак-100',
            recipe: {
              create: {
                parameters: [{ label: 'Сырьё', value: 'ПВД 10803-020' }],
                source: 'commercial_form',
                createdBy: 'commercial',
              },
            },
          },
        ],
      },
    },
    include: { positions: true },
  });

  await prisma.warehouseCoverProposal.upsert({
    where: { id: 'cover-A-1024-1' },
    update: {
      route: 'production_only',
      coverType: 'partial',
      coverQty: 0,
      reserveQty: 0,
      productionQty: order.positions[0].rollCount,
      status: 'full_proposed',
      matchedRollIds: [],
    },
    create: {
      id: 'cover-A-1024-1',
      orderId: order.id,
      positionId: order.positions[0].id,
      coverType: 'partial',
      route: 'production_only',
      coverQty: 0,
      productionQty: order.positions[0].rollCount,
      status: 'full_proposed',
      matchedRollIds: [],
    },
  });

  await prisma.commercialOrder.upsert({
    where: { orderNumber: 'R-2048' },
    update: { clientRequestId: '00000000-0000-4000-8000-000000002048' },
    create: {
      orderNumber: 'R-2048',
      clientRequestId: '00000000-0000-4000-8000-000000002048',
      creatorRole: Role.commercial,
      counterpartyId: uralpak.id,
      warehouseCoverageWorkflowVersion: 1,
      requestType: 'stock_reserve',
      positions: {
        create: [
          {
            rollCount: 6,
            filmType: 'Рукав',
            actualThickness: '60 мкм',
            accountingThickness: '60 мкм',
            recipe: {
              create: { parameters: [], source: 'commercial_form', createdBy: 'commercial' },
            },
          },
        ],
      },
    },
  });

  await prisma.commercialOrder.upsert({
    where: { orderNumber: 'D-3001' },
    update: {
      clientRequestId: '00000000-0000-4000-8000-000000003001',
      commercialStage: 'draft',
      draftedAt: new Date(),
    },
    create: {
      orderNumber: 'D-3001',
      clientRequestId: '00000000-0000-4000-8000-000000003001',
      creatorRole: Role.commercial,
      counterpartyId: uralpak.id,
      warehouseCoverageWorkflowVersion: 1,
      requestType: 'client_order',
      commercialStage: 'draft',
      draftedAt: new Date(),
      positions: {
        create: [
          {
            rollCount: 1,
            filmType: 'Рукав',
            actualThickness: '70 мкм',
            accountingThickness: '70 мкм',
            rawMaterialId: 'rm-pvd-15803',
            spoolType: 'втулка 76',
            birka: 'Черновик',
            recipe: {
              create: {
                parameters: [{ label: 'Сырьё', value: 'ПВД 15803-020' }],
                source: 'commercial_form',
                createdBy: 'commercial',
              },
            },
          },
        ],
      },
    },
  });

  const sibplast = await prisma.counterparty.findUniqueOrThrow({ where: { id: 'cp-sibplast' } });
  const incomingCover = await prisma.commercialOrder.upsert({
    where: { orderNumber: 'A-1025' },
    update: {
      clientRequestId: '00000000-0000-4000-8000-000000001025',
      externalId: 'seed-order-a-1025',
      commercialStage: 'incoming',
      productionIndicator: 'not_started',
      warehouseCoverStatus: 'full_proposed',
      paymentStatus: 'unpaid',
      shipmentStatus: 'not_shipped',
      commercialLockedAt: null,
    },
    create: {
      orderNumber: 'A-1025',
      clientRequestId: '00000000-0000-4000-8000-000000001025',
      externalId: 'seed-order-a-1025',
      title: 'Проверка маршрута склад / производство',
      creatorRole: Role.commercial,
      counterpartyId: sibplast.id,
      warehouseCoverageWorkflowVersion: 1,
      requestType: 'client_order',
      warehouseCoverStatus: 'full_proposed',
      positions: {
        create: {
          rollCount: 2,
          filmType: 'Рукав',
          actualThickness: '80 мкм',
          accountingThickness: '78 мкм',
          rawMaterialId: 'rm-pvd-15803',
          spoolType: 'Шпуля 76 мм',
          birka: 'Прозрачная',
          plannedWeightKg: 41.2,
          warehouseCoverStatus: 'full_proposed',
          recipe: {
            create: {
              parameters: [
                { label: 'Сырьё', value: 'ПВД 15803-020' },
                { label: 'План. вес, кг', value: '41.2' },
              ],
              source: 'commercial_form',
              createdBy: 'commercial',
            },
          },
        },
      },
    },
    include: { positions: true },
  });
  const incomingPosition = incomingCover.positions[0];
  await prisma.commercialOrderPosition.update({
    where: { id: incomingPosition.id },
    data: { warehouseCoverStatus: 'full_proposed' },
  });
  await prisma.warehouseCoverProposal.upsert({
    where: { id: 'cover-A-1025-1' },
    update: {
      orderId: incomingCover.id,
      positionId: incomingPosition.id,
      route: 'production_only',
      coverType: 'partial',
      coverQty: 0,
      reserveQty: 0,
      productionQty: incomingPosition.rollCount,
      status: 'full_proposed',
      version: 1,
      commercialApprovedById: null,
      commercialApprovedAt: null,
      technicalApprovedById: null,
      technicalApprovedAt: null,
      expiresAt: null,
      matchedRollIds: [],
    },
    create: {
      id: 'cover-A-1025-1',
      orderId: incomingCover.id,
      positionId: incomingPosition.id,
      route: 'production_only',
      coverType: 'partial',
      coverQty: 0,
      reserveQty: 0,
      productionQty: incomingPosition.rollCount,
      status: 'full_proposed',
      expiresAt: null,
      matchedRollIds: [],
    },
  });

  const commercialUser = await prisma.user.findUnique({
    where: { externalId: 'seed-commercial' },
  });
  const completed = await prisma.commercialOrder.upsert({
    where: { orderNumber: 'A-1022' },
    update: {
      clientRequestId: '00000000-0000-4000-8000-000000001022',
      externalId: 'seed-order-a-1022',
      commercialStage: 'in_work',
      productionIndicator: 'not_started',
      warehouseCoverStatus: 'full_confirmed',
      shipmentStatus: 'not_shipped',
    },
    create: {
      orderNumber: 'A-1022',
      clientRequestId: '00000000-0000-4000-8000-000000001022',
      externalId: 'seed-order-a-1022',
      title: 'Полностью закрыто складским рулоном',
      creatorRole: Role.commercial,
      counterpartyId: uralpak.id,
      warehouseCoverageWorkflowVersion: 1,
      requestType: 'client_order',
      commercialStage: 'in_work',
      warehouseCoverStatus: 'full_confirmed',
      positions: {
        create: {
          rollCount: 1,
          filmType: 'Рукав',
          actualThickness: '80 мкм',
          accountingThickness: '78 мкм',
          rawMaterialId: 'rm-pvd-15803',
          spoolType: 'Шпуля 76 мм',
          birka: 'Прозрачная',
          plannedWeightKg: 41.2,
          warehouseCoverStatus: 'full_confirmed',
          recipe: {
            create: {
              parameters: [{ label: 'Сырьё', value: 'ПВД 15803-020' }],
              source: 'commercial_form',
              createdBy: 'commercial',
            },
          },
        },
      },
    },
    include: { positions: true },
  });
  const completedPosition = completed.positions[0];
  await prisma.commercialOrderPosition.update({
    where: { id: completedPosition.id },
    data: { warehouseCoverStatus: 'full_confirmed' },
  });
  await prisma.warehouseRoll.upsert({
    where: { rollCode: 'SEED-COVER-FREE-1' },
    update: {
      warehouseStatus: 'received',
      positionSnapshot: {
        filmType: 'Рукав',
        actualThickness: '80 мкм',
        birka: 'Прозрачная',
        spoolType: 'Шпуля 76 мм',
        plannedWeightKg: 41.2,
      },
      ownerCounterpartyId: null,
      reservedForOrderId: null,
      reservedForPositionId: null,
      reservedByProposalId: null,
      reservedAt: null,
      externalId: 'seed-cover-free-roll-1',
      sourceVersion: 'seed-v1',
    },
    create: {
      rollCode: 'SEED-COVER-FREE-1',
      warehouseStatus: 'received',
      positionSnapshot: {
        filmType: 'Рукав',
        actualThickness: '80 мкм',
        birka: 'Прозрачная',
        spoolType: 'Шпуля 76 мм',
        plannedWeightKg: 41.2,
      },
      externalId: 'seed-cover-free-roll-1',
      sourceVersion: 'seed-v1',
    },
  });
  const completedRoll = await prisma.warehouseRoll.upsert({
    where: { rollCode: 'SEED-COVER-ROLL-1' },
    update: {
      warehouseStatus: 'received',
      positionSnapshot: {
        filmType: 'Рукав',
        actualThickness: '80 мкм',
        birka: 'Прозрачная',
        spoolType: 'Шпуля 76 мм',
        plannedWeightKg: 41.2,
      },
      reservedForOrderId: null,
      reservedForPositionId: null,
      reservedByProposalId: null,
      reservedAt: null,
    },
    create: {
      rollCode: 'SEED-COVER-ROLL-1',
      warehouseStatus: 'received',
      positionSnapshot: {
        filmType: 'Рукав',
        actualThickness: '80 мкм',
        birka: 'Прозрачная',
        spoolType: 'Шпуля 76 мм',
        plannedWeightKg: 41.2,
      },
    },
  });
  const completedProposal = await prisma.warehouseCoverProposal.upsert({
    where: { id: 'cover-A-1022-1' },
    update: {
      orderId: completed.id,
      positionId: completedPosition.id,
      route: 'full_cover',
      coverType: 'full',
      coverQty: 1,
      reserveQty: 1,
      productionQty: 0,
      status: 'full_confirmed',
      version: 3,
      commercialApprovedById: commercialUser?.id ?? null,
      commercialApprovedAt: new Date(),
      technicalApprovedById: productionLead?.id ?? null,
      technicalApprovedAt: new Date(),
      expiresAt: null,
      matchedRollIds: [completedRoll.id],
    },
    create: {
      id: 'cover-A-1022-1',
      orderId: completed.id,
      positionId: completedPosition.id,
      route: 'full_cover',
      coverType: 'full',
      coverQty: 1,
      reserveQty: 1,
      productionQty: 0,
      status: 'full_confirmed',
      version: 3,
      commercialApprovedById: commercialUser?.id ?? null,
      commercialApprovedAt: new Date(),
      technicalApprovedById: productionLead?.id ?? null,
      technicalApprovedAt: new Date(),
      expiresAt: null,
      matchedRollIds: [completedRoll.id],
    },
  });
  await prisma.warehouseCoverMatch.upsert({
    where: {
      proposalId_rollId: { proposalId: completedProposal.id, rollId: completedRoll.id },
    },
    update: { compatible: true },
    create: {
      proposalId: completedProposal.id,
      rollId: completedRoll.id,
      compatible: true,
      criteria: {},
    },
  });
  await prisma.warehouseRoll.update({
    where: { id: completedRoll.id },
    data: {
      reservedForOrderId: completed.id,
      reservedForPositionId: completedPosition.id,
      reservedByProposalId: completedProposal.id,
      reservedAt: new Date(),
    },
  });
  await prisma.scanRow.deleteMany({ where: { taskId: 'seed-cover-a1022-reserve' } });
  await prisma.warehouseAcceptanceTask.upsert({
    where: { id: 'seed-cover-a1022-reserve' },
    update: {
      mode: 'reserve',
      status: 'closed',
      orderId: completed.id,
      positionId: completedPosition.id,
      proposalId: completedProposal.id,
    },
    create: {
      id: 'seed-cover-a1022-reserve',
      mode: 'reserve',
      status: 'closed',
      orderId: completed.id,
      positionId: completedPosition.id,
      proposalId: completedProposal.id,
    },
  });
  await prisma.scanRow.create({
    data: {
      taskId: 'seed-cover-a1022-reserve',
      rollCode: completedRoll.rollCode,
      fromOrderId: completed.orderNumber,
      scanStatus: 'accepted',
      lastScanAt: new Date(),
      scannedByName: 'Склад',
    },
  });
}

void runSeedProfile(process.env, {
  createPrisma: () => new PrismaClient(),
  seedDemo: async (client, config) => {
    prisma = client;
    await seedDemo(config);
  },
  seedPilot: async (client, config) => {
    await client.$transaction(async (tx) => {
      await seedPilotBootstrap(tx, config);
      await seedPilotTestData(tx);
    });
    console.log(
      'Pilot bootstrap reconciled (accounts, posts, devices, access templates and test-run data).',
    );
  },
}).catch((error: unknown) => {
  if (
    error instanceof SeedProfileError ||
    error instanceof SeedAccountConflictError ||
    error instanceof PilotSeedConflictError ||
    error instanceof PilotTestDataError
  ) {
    console.error(error.message);
  } else {
    console.error('Seed failed.');
  }
  process.exitCode = 1;
});
