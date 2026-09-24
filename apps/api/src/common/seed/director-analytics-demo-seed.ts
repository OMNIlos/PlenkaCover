import { Role, type PrismaClient } from '@prisma/client';

const LOCAL_PREVIEW_SCHEMA = /^local_graph_[a-z0-9_]+$/;
const LOCAL_PREVIEW_HOSTS = new Set(['localhost', '127.0.0.1']);
const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);
const LOCAL_DATABASE_ERROR =
  'DIRECTOR_PREVIEW_DATABASE_URL must target PostgreSQL on localhost or 127.0.0.1 with exactly one isolated schema=local_graph_*';

export function assertDirectorAnalyticsLocalDatabase(databaseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(LOCAL_DATABASE_ERROR);
  }

  const schemas = parsed.searchParams.getAll('schema');
  const queryKeys = [...parsed.searchParams.keys()];
  if (
    !POSTGRES_PROTOCOLS.has(parsed.protocol) ||
    !LOCAL_PREVIEW_HOSTS.has(parsed.hostname) ||
    schemas.length !== 1 ||
    !LOCAL_PREVIEW_SCHEMA.test(schemas[0] ?? '') ||
    queryKeys.length !== 1 ||
    queryKeys[0] !== 'schema' ||
    parsed.hash !== ''
  ) {
    throw new Error(LOCAL_DATABASE_ERROR);
  }
}

type ApplicationMode = 'direct' | 'promoted' | 'delegated' | 'outside' | 'draft';

const APPLICATION_FACTS = [
  ['2026-07-24', 'client_order', 'direct'],
  ['2026-07-20', 'client_order', 'promoted'],
  ['2026-07-19', 'client_order', 'delegated'],
  ['2026-07-18', 'stock_reserve', 'direct'],
  ['2026-07-17', 'client_order', 'direct'],
  ['2026-06-25', 'stock_reserve', 'direct'],
  ['2026-06-24', 'client_order', 'direct'],
  ['2026-04-24', 'stock_reserve', 'direct'],
  ['2026-04-23', 'client_order', 'direct'],
  ['2026-01-24', 'stock_reserve', 'direct'],
  ['2026-01-23', 'client_order', 'outside'],
  ['2026-07-24', 'client_order', 'draft'],
] as const satisfies readonly (readonly [string, string, ApplicationMode])[];

function fixedTime(date: string): Date {
  return new Date(`${date}T09:00:00.000Z`);
}

function assertPreviewDate(value: string): void {
  if (value !== '2026-07-24') {
    throw new Error('Director analytics preview is fixed to asOfDate 2026-07-24');
  }
}

async function createOnce(
  lookup: () => Promise<unknown>,
  create: () => Promise<unknown>,
): Promise<void> {
  if ((await lookup()) === null) await create();
}

export async function seedDirectorAnalyticsDemo(
  prisma: PrismaClient,
  asOfDate = '2026-07-24',
): Promise<void> {
  assertPreviewDate(asOfDate);

  const users = [
    {
      id: 'LOCAL-GRAPH-USER-OP-1',
      externalId: 'LOCAL-GRAPH-USER-OP-1',
      login: 'local-graph-operator-1',
      displayName: 'Алексей Орлов',
      role: Role.operator,
    },
    {
      id: 'LOCAL-GRAPH-USER-OP-2',
      externalId: 'LOCAL-GRAPH-USER-OP-2',
      login: 'local-graph-operator-2',
      displayName: 'Мария Волкова',
      role: Role.operator,
    },
    {
      id: 'LOCAL-GRAPH-USER-COMMERCIAL',
      externalId: 'LOCAL-GRAPH-USER-COMMERCIAL',
      login: 'local-graph-commercial',
      displayName: 'Локальная коммерция',
      role: Role.commercial,
    },
  ] as const;
  for (const user of users) {
    await createOnce(
      () => prisma.user.findUnique({ where: { id: user.id } }),
      () =>
        prisma.user.create({
          data: {
            ...user,
            identityProvider: 'local_preview',
            isActive: true,
            mustChangePassword: false,
          },
        }),
    );
  }

  const counterpartyId = 'LOCAL-GRAPH-COUNTERPARTY';
  await createOnce(
    () => prisma.counterparty.findUnique({ where: { id: counterpartyId } }),
    () =>
      prisma.counterparty.create({
        data: {
          id: counterpartyId,
          displayName: 'LOCAL-GRAPH Клиент',
          legalName: 'LOCAL-GRAPH локальные аналитические данные',
        },
      }),
  );

  for (const [index, [submittedDate, requestType, mode]] of APPLICATION_FACTS.entries()) {
    const sequence = String(index + 1).padStart(2, '0');
    const id = `LOCAL-GRAPH-APP-${sequence}`;
    const draftedAt = mode === 'promoted' ? fixedTime('2025-12-01') : fixedTime(submittedDate);
    const createdAt = mode === 'promoted' ? draftedAt : fixedTime(submittedDate);
    await createOnce(
      () => prisma.commercialOrder.findUnique({ where: { id } }),
      () =>
        prisma.commercialOrder.create({
          data: {
            id,
            orderNumber: `LOCAL-GRAPH-APP-${sequence}`,
            title: `LOCAL-GRAPH заявка ${sequence}`,
            creatorRole: mode === 'delegated' ? Role.production_lead : Role.commercial,
            counterpartyId,
            requestType,
            delegationMarker: mode === 'delegated',
            commercialConfirmationPolicy:
              mode === 'delegated' ? 'bypassed_by_delegation' : 'required',
            commercialStage: mode === 'draft' ? 'draft' : 'incoming',
            draftedAt: mode === 'promoted' || mode === 'draft' ? draftedAt : null,
            createdAt,
          },
        }),
    );
    if (mode === 'promoted') {
      const eventId = 'LOCAL-GRAPH-EVENT-APP-02-PROMOTED';
      await createOnce(
        () => prisma.domainEvent.findUnique({ where: { id: eventId } }),
        () =>
          prisma.domainEvent.create({
            data: {
              id: eventId,
              family: 'audit',
              type: 'audit:commercial_draft_promoted',
              objectId: id,
              actorRole: Role.commercial,
              actorId: 'LOCAL-GRAPH-USER-COMMERCIAL',
              label: 'LOCAL-GRAPH draft promoted',
              createdAt: fixedTime(submittedDate),
            },
          }),
      );
    }
  }

  const positionId = 'LOCAL-GRAPH-POSITION-01';
  await createOnce(
    () => prisma.commercialOrderPosition.findUnique({ where: { id: positionId } }),
    () =>
      prisma.commercialOrderPosition.create({
        data: {
          id: positionId,
          orderId: 'LOCAL-GRAPH-APP-05',
          rollCount: 7,
          filmType: 'Плёнка полиэтиленовая',
          actualThickness: '80 мкм',
          accountingThickness: '80 мкм',
          rawMaterialId: 'LOCAL-GRAPH-ПВД-15803-020',
          spoolType: '76 мм',
          plannedWeightKg: 40,
        },
      }),
  );
  const productionOrderId = 'LOCAL-GRAPH-PRODUCTION-ORDER';
  await createOnce(
    () => prisma.productionOrder.findUnique({ where: { id: productionOrderId } }),
    () =>
      prisma.productionOrder.create({
        data: {
          id: productionOrderId,
          commercialOrderId: 'LOCAL-GRAPH-APP-05',
          indicator: 'in_progress',
          approvalState: 'approved',
          createdAt: fixedTime('2026-07-17'),
        },
      }),
  );

  const postId = 'LOCAL-GRAPH-POST-1';
  await createOnce(
    () => prisma.post.findUnique({ where: { id: postId } }),
    () =>
      prisma.post.create({
        data: {
          id: postId,
          code: 'LOCAL-GRAPH-POST-1',
          name: 'LOCAL-GRAPH Станок 1',
          status: 'active',
          agentStatus: 'online',
          createdAt: fixedTime('2026-01-01'),
        },
      }),
  );
  const deviceId = 'LOCAL-GRAPH-SCALE-1';
  await createOnce(
    () => prisma.deviceRuntime.findUnique({ where: { id: deviceId } }),
    () =>
      prisma.deviceRuntime.create({
        data: {
          id: deviceId,
          code: 'LOCAL-GRAPH-SCALE-1',
          label: 'LOCAL-GRAPH Весы',
          kind: 'scale',
          connectionKind: 'simulated',
          status: 'ready',
          ownerRole: Role.admin,
          postId,
          createdAt: fixedTime('2026-01-01'),
        },
      }),
  );

  const shiftId = 'LOCAL-GRAPH-SHIFT';
  await createOnce(
    () => prisma.shift.findUnique({ where: { id: shiftId } }),
    () =>
      prisma.shift.create({
        data: {
          id: shiftId,
          label: 'LOCAL-GRAPH аналитическая смена',
          plannedStartAt: fixedTime('2026-07-18'),
          plannedEndAt: fixedTime('2026-07-25'),
          startedAt: fixedTime('2026-07-18'),
          endedAt: fixedTime('2026-07-24'),
          status: 'closed',
          createdAt: fixedTime('2026-07-18'),
        },
      }),
  );
  const openShiftId = 'LOCAL-GRAPH-SHIFT-OPEN';
  await createOnce(
    () => prisma.shift.findUnique({ where: { id: openShiftId } }),
    () =>
      prisma.shift.create({
        data: {
          id: openShiftId,
          label: 'LOCAL-GRAPH открытая смена',
          plannedStartAt: fixedTime('2026-07-24'),
          plannedEndAt: fixedTime('2026-07-25'),
          startedAt: fixedTime('2026-07-24'),
          status: 'open',
          createdAt: fixedTime('2026-07-24'),
        },
      }),
  );

  const sessionFacts = [
    ['01', 'LOCAL-GRAPH-USER-OP-1', shiftId, '2026-07-18', '2026-07-23', 'closed'],
    ['02', 'LOCAL-GRAPH-USER-OP-2', shiftId, '2026-07-20', '2026-07-23', 'closed'],
    ['03', 'LOCAL-GRAPH-USER-OP-2', shiftId, '2026-07-24', '2026-07-24', 'closed'],
    ['04', 'LOCAL-GRAPH-USER-OP-1', openShiftId, '2026-07-24', null, 'active'],
  ] as const;
  for (const [
    sequence,
    operatorId,
    sessionShiftId,
    startedDate,
    endedDate,
    status,
  ] of sessionFacts) {
    const id = `LOCAL-GRAPH-SESSION-${sequence}`;
    await createOnce(
      () => prisma.operatorPostSession.findUnique({ where: { id } }),
      () =>
        prisma.operatorPostSession.create({
          data: {
            id,
            operatorId,
            postId,
            shiftId: sessionShiftId,
            status,
            startedAt: fixedTime(startedDate),
            endedAt: endedDate === null ? null : fixedTime(endedDate),
          },
        }),
    );
  }

  const rollFacts = [
    ['01', '2026-07-18', 40, 40, 'LOCAL-GRAPH-SESSION-01', 'LOCAL-GRAPH-USER-OP-1'],
    ['02', '2026-07-19', 40, 45, 'LOCAL-GRAPH-SESSION-01', 'LOCAL-GRAPH-USER-OP-1'],
    ['03', '2026-07-20', 40, 37, 'LOCAL-GRAPH-SESSION-02', 'LOCAL-GRAPH-USER-OP-2'],
    ['04', '2026-07-21', null, 42, 'LOCAL-GRAPH-SESSION-02', 'LOCAL-GRAPH-USER-OP-2'],
    ['05', '2026-07-22', 40, 44, null, null],
    ['06', '2026-07-23', 40, 41, 'LOCAL-GRAPH-SESSION-01', 'LOCAL-GRAPH-USER-OP-1'],
    ['07', '2026-07-24', 40, 39, 'LOCAL-GRAPH-SESSION-03', 'LOCAL-GRAPH-USER-OP-2'],
  ] as const;

  for (const [sequence, producedDate, planKg, actualKg, sessionId, actorId] of rollFacts) {
    const dispatchId = `LOCAL-GRAPH-ROLL-${sequence}`;
    const lineId = `LOCAL-GRAPH-LINE-${sequence}`;
    const captureId =
      sequence === '05'
        ? 'LOCAL-GRAPH-CAPTURE-MISSING-ACTOR'
        : sequence === '06'
          ? 'LOCAL-GRAPH-CAPTURE-REWEIGH-ROOT'
          : `LOCAL-GRAPH-CAPTURE-${sequence}`;
    const operationId = actorId === null ? null : `LOCAL-GRAPH-OPERATION-${sequence}`;

    await createOnce(
      () => prisma.rollDispatchItem.findUnique({ where: { id: dispatchId } }),
      () =>
        prisma.rollDispatchItem.create({
          data: {
            id: dispatchId,
            rollCode: `LOCAL-GRAPH-ROLL-${sequence}`,
            productionOrderId,
            orderLineId: positionId,
            positionSequence: Number(sequence),
            rawMaterialId: 'LOCAL-GRAPH-ПВД-15803-020',
            filmType: 'Плёнка полиэтиленовая',
            plannedWeightKg: planKg,
            assignedOperatorId: actorId,
            machineId: 'LOCAL-GRAPH-POST-1',
            postId,
            status: 'completed',
            completedAt: fixedTime(producedDate),
            createdAt: fixedTime(producedDate),
          },
        }),
    );
    await createOnce(
      () => prisma.operatorRollLine.findUnique({ where: { id: lineId } }),
      () =>
        prisma.operatorRollLine.create({
          data: {
            id: lineId,
            rollDispatchItemId: dispatchId,
            sequence: Number(sequence),
            planKg,
            grossKg: actualKg + 2,
            spoolKg: 2,
            netKg: actualKg,
            toleranceOk: actualKg === planKg,
            step: 'handed_over',
            labelState: 'printed',
            warehouseState: 'handed_over',
            createdAt: fixedTime(producedDate),
          },
        }),
    );
    if (operationId !== null && actorId !== null && sessionId !== null) {
      await createOnce(
        () => prisma.operatorRollOperation.findUnique({ where: { id: operationId } }),
        () =>
          prisma.operatorRollOperation.create({
            data: {
              id: operationId,
              operationKey: `LOCAL-GRAPH-OPERATION-KEY-${sequence}`,
              operatorRollLineId: lineId,
              action: 'roll_weight',
              actorId,
              postSessionId: sessionId,
              postId,
              deviceId,
              requestFingerprint: `LOCAL-GRAPH-FINGERPRINT-${sequence}`,
              expectedStep: 'weighing',
              resultStep: 'weighted',
              status: 'succeeded',
              httpStatus: 200,
              attempt: 1,
              leaseToken: null,
              leaseExpiresAt: null,
              resultRef: captureId,
              completedAt: fixedTime(producedDate),
              createdAt: fixedTime(producedDate),
            },
          }),
      );
    }
    if (sequence !== '07') {
      const spoolCaptureId = `LOCAL-GRAPH-SPOOL-${sequence}`;
      await createOnce(
        () => prisma.weightCapture.findUnique({ where: { id: spoolCaptureId } }),
        () =>
          prisma.weightCapture.create({
            data: {
              id: spoolCaptureId,
              operatorRollLineId: lineId,
              kind: 'spool',
              deviceId,
              deviceStatus: 'ready',
              stable: true,
              grossKg: 2,
              spoolKg: 2,
              netKg: 0,
              actorRole: Role.operator,
              actorId,
              postId,
              postSessionId: sessionId,
              createdAt: fixedTime(producedDate),
            },
          }),
      );
    }
    await createOnce(
      () => prisma.weightCapture.findUnique({ where: { id: captureId } }),
      () =>
        prisma.weightCapture.create({
          data: {
            id: captureId,
            operatorRollLineId: lineId,
            kind: 'roll',
            deviceId,
            deviceStatus: 'ready',
            stable: true,
            grossKg: actualKg + 2,
            spoolKg: 2,
            netKg: actualKg,
            toleranceOk: actualKg === planKg,
            actorRole: Role.operator,
            actorId,
            postId: sessionId === null ? null : postId,
            postSessionId: sessionId,
            operationId,
            createdAt: fixedTime(producedDate),
          },
        }),
    );
  }

  const reweighOperationId = 'LOCAL-GRAPH-OPERATION-REWEIGH';
  const reweighCaptureId = 'LOCAL-GRAPH-CAPTURE-REWEIGH';
  await createOnce(
    () => prisma.operatorRollOperation.findUnique({ where: { id: reweighOperationId } }),
    () =>
      prisma.operatorRollOperation.create({
        data: {
          id: reweighOperationId,
          operationKey: 'LOCAL-GRAPH-OPERATION-KEY-REWEIGH',
          operatorRollLineId: 'LOCAL-GRAPH-LINE-06',
          action: 'roll_reweigh',
          actorId: 'LOCAL-GRAPH-USER-OP-2',
          postSessionId: 'LOCAL-GRAPH-SESSION-03',
          postId,
          deviceId,
          requestFingerprint: 'LOCAL-GRAPH-FINGERPRINT-REWEIGH',
          expectedStep: 'weighted',
          resultStep: 'weighted',
          status: 'succeeded',
          httpStatus: 200,
          attempt: 1,
          leaseToken: null,
          leaseExpiresAt: null,
          resultRef: reweighCaptureId,
          completedAt: fixedTime('2026-07-24'),
          createdAt: fixedTime('2026-07-24'),
        },
      }),
  );
  await createOnce(
    () => prisma.weightCapture.findUnique({ where: { id: reweighCaptureId } }),
    () =>
      prisma.weightCapture.create({
        data: {
          id: reweighCaptureId,
          operatorRollLineId: 'LOCAL-GRAPH-LINE-06',
          kind: 'roll',
          deviceId,
          deviceStatus: 'ready',
          stable: true,
          grossKg: 45,
          spoolKg: 2,
          netKg: 43,
          toleranceOk: false,
          actorRole: Role.operator,
          actorId: 'LOCAL-GRAPH-USER-OP-2',
          postId,
          postSessionId: 'LOCAL-GRAPH-SESSION-03',
          operationId: reweighOperationId,
          supersedesCaptureId: 'LOCAL-GRAPH-CAPTURE-REWEIGH-ROOT',
          createdAt: fixedTime('2026-07-24'),
        },
      }),
  );

  const defectFacts = [
    ['01', 'LOCAL-GRAPH-LINE-02', 'LOCAL-GRAPH-CAPTURE-02', 'Перерасход и складка'],
    ['02', 'LOCAL-GRAPH-LINE-02', null, 'Визуальный дефект без взвешивания'],
    ['03', 'LOCAL-GRAPH-LINE-03', 'LOCAL-GRAPH-CAPTURE-03', 'Разрыв полотна'],
  ] as const;
  for (const [sequence, lineId, weightCaptureId, comment] of defectFacts) {
    const id = `LOCAL-GRAPH-DEFECT-${sequence}`;
    await createOnce(
      () => prisma.defectRecord.findUnique({ where: { id } }),
      () =>
        prisma.defectRecord.create({
          data: {
            id,
            operatorRollLineId: lineId,
            weightCaptureId,
            sourceRole: Role.operator,
            weightKg: weightCaptureId === null ? null : 999,
            comment,
            blocking: sequence === '03',
            createdAt: fixedTime(sequence === '03' ? '2026-07-20' : '2026-07-19'),
          },
        }),
    );
  }

  const bagFacts = [
    ['NORMAL', 'available', 500, 372, 'LOCAL-GRAPH-SESSION-01', '2026-07-18', '2026-07-23'],
    ['MISMATCH', 'available', 300, 210, 'LOCAL-GRAPH-SESSION-02', '2026-07-20', '2026-07-23'],
    ['NEGATIVE', 'available', 100, 105, 'LOCAL-GRAPH-SESSION-03', '2026-07-24', '2026-07-24'],
    ['OPEN', 'in_use', 200, null, 'LOCAL-GRAPH-SESSION-04', '2026-07-24', null],
  ] as const;
  for (const [label, status, startKg, endKg, sessionId, openedDate, closedDate] of bagFacts) {
    const bagId = `LOCAL-GRAPH-BIGBAG-${label}`;
    const usageId = `LOCAL-GRAPH-BAG-USAGE-${label}`;
    await createOnce(
      () => prisma.bigBagUnit.findUnique({ where: { id: bagId } }),
      () =>
        prisma.bigBagUnit.create({
          data: {
            id: bagId,
            code: bagId,
            material: 'ПВД 15803-020',
            materialId: 'LOCAL-GRAPH-ПВД-15803-020',
            status,
            initialKg: startKg,
            currentKg: endKg ?? startKg,
            lastMeasuredKg: endKg ?? startKg,
            lastActorRole: Role.operator,
            lastMeasuredAt: fixedTime(closedDate ?? '2026-07-24'),
            createdByRole: Role.warehouse,
            createdAt: fixedTime(openedDate),
          },
        }),
    );
    await createOnce(
      () => prisma.shiftBagUsage.findUnique({ where: { id: usageId } }),
      () =>
        prisma.shiftBagUsage.create({
          data: {
            id: usageId,
            sessionId,
            bigBagId: bagId,
            startKg,
            endKg,
            addedReason: 'LOCAL-GRAPH analytics preview',
            createdAt: fixedTime(openedDate),
            closedAt: closedDate === null ? null : fixedTime(closedDate),
          },
        }),
    );
  }
}
