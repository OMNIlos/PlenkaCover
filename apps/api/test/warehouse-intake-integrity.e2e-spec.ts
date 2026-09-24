import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import type { Actor } from '../src/common/auth/actor';
import { AuditService } from '../src/common/audit/audit.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { SCALE_ADAPTER, type ScaleAdapter } from '../src/integrations/scale/scale.adapter';
import { WarehouseIntakeIntegrityService } from '../src/modules/warehouse/warehouse-intake-integrity.service';
import { WarehouseOperationService } from '../src/modules/warehouse/warehouse-operation.service';
import { PalletPrintService } from '../src/modules/warehouse/pallet-print.service';
import { WarehousePalletSelectionService } from '../src/modules/warehouse/warehouse-pallet-selection.service';
import { WarehousePalletService } from '../src/modules/warehouse/warehouse-pallet.service';
import { WarehouseService } from '../src/modules/warehouse/warehouse.service';
import { enableSimulatedDevices } from './simulated-device-fixture';

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

type Fixture = {
  actor: Actor;
  token: string;
  postId: string;
  taskId: string;
  rowId: string;
  rollCode: string;
  lineId: string;
  dispatchId: string;
  secondaryMaterialId: string;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForSignal(signal: Promise<void>, label: string, timeoutMs = 10_000) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForAdvisoryLock(prisma: PrismaService, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const waiting = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND wait_event ILIKE '%advisory%'
    `;
    if ((waiting[0]?.count ?? 0) >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for a PostgreSQL advisory lock');
}

describe('Warehouse intake integrity (e2e, real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let audit: AuditService;
  let service: WarehouseIntakeIntegrityService;
  let warehouse: WarehouseService;
  let pallets: WarehousePalletService;
  let palletSelection: WarehousePalletSelectionService;
  let palletPrint: PalletPrintService;
  let scale: ScaleAdapter;
  let sequence = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaService);
    audit = moduleRef.get(AuditService);
    service = moduleRef.get(WarehouseIntakeIntegrityService);
    warehouse = moduleRef.get(WarehouseService);
    pallets = moduleRef.get(WarehousePalletService);
    palletSelection = moduleRef.get(WarehousePalletSelectionService);
    palletPrint = moduleRef.get(PalletPrintService);
    scale = moduleRef.get<ScaleAdapter>(SCALE_ADAPTER);
    await app.init();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  async function createFixture(): Promise<Fixture> {
    sequence += 1;
    const suffix = `${Date.now()}-${process.pid}-${sequence}`;
    const counterparty = await prisma.counterparty.create({
      data: { displayName: `Warehouse integrity ${suffix}` },
    });
    const order = await prisma.commercialOrder.create({
      data: {
        orderNumber: `A-WH-INTEGRITY-${suffix}`,
        creatorRole: 'commercial',
        counterpartyId: counterparty.id,
        positions: {
          create: {
            rollCount: 1,
            filmType: 'Рукав',
            actualThickness: '80 мкм',
            accountingThickness: '78 мкм',
            plannedWeightKg: 40,
          },
        },
      },
      include: { positions: true },
    });
    const productionOrder = await prisma.productionOrder.create({
      data: {
        commercialOrderId: order.id,
        approvalState: 'approved',
      },
    });
    const post = await prisma.post.create({
      data: { code: `WH-${suffix}`, name: `Warehouse post ${suffix}`, status: 'active' },
    });
    const scannerId = `wh-scanner-${suffix}`;
    const scaleId = `wh-scale-${suffix}`;
    const printerId = `wh-printer-${suffix}`;
    await prisma.deviceRuntime.createMany({
      data: [
        {
          id: scannerId,
          code: `WH-SCANNER-${suffix}`,
          label: 'Warehouse scanner',
          kind: 'scanner',
          status: 'ready',
          isEnabled: true,
          postId: post.id,
        },
        {
          id: scaleId,
          code: `WH-SCALE-${suffix}`,
          label: 'Warehouse scale',
          kind: 'scale',
          status: 'ready',
          isEnabled: true,
          postId: post.id,
        },
        {
          id: printerId,
          code: `WH-PRINTER-${suffix}`,
          label: 'Warehouse printer',
          kind: 'printer',
          status: 'ready',
          isEnabled: true,
          postId: post.id,
        },
      ],
    });
    await enableSimulatedDevices(prisma, [scannerId, scaleId, printerId]);
    const user = await prisma.user.create({
      data: {
        login: `warehouse-integrity-${suffix}`,
        displayName: 'Warehouse Integrity User',
        role: 'warehouse',
      },
    });
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        purpose: 'full',
      },
    });
    const rollCode = `WH-ROLL-${suffix}`;
    const rawMaterialId = `rm-wh-integrity-${suffix}`;
    await prisma.rawMaterialStock.create({
      data: {
        materialId: rawMaterialId,
        label: `Warehouse integrity material ${suffix}`,
        actualQty: 100,
      },
    });
    const dispatch = await prisma.rollDispatchItem.create({
      data: {
        rollCode,
        productionOrderId: productionOrder.id,
        orderLineId: order.positions[0]!.id,
        positionSequence: 1,
        rawMaterialId,
        plannedWeightKg: 40,
        status: 'ready_for_warehouse',
        postId: post.id,
      },
    });
    const line = await prisma.operatorRollLine.create({
      data: {
        rollDispatchItemId: dispatch.id,
        planKg: 40,
        spoolKg: 2,
        grossKg: 42,
        netKg: 40,
        toleranceOk: true,
        step: 'warehouse',
        labelState: 'verified',
        warehouseState: 'sent',
      },
    });
    await prisma.warehouseRoll.create({
      data: {
        rollCode,
        ownerCounterpartyId: counterparty.id,
        reservedForOrderId: order.id,
        reservedForPositionId: order.positions[0]!.id,
        warehouseStatus: 'sent',
      },
    });
    const label = await prisma.rollScanToken.create({ data: { rollCode } });
    const task = await prisma.warehouseAcceptanceTask.create({
      data: {
        mode: 'receiving',
        status: 'open',
        operationCode: `PR-${suffix}`,
        orderId: order.id,
        positionId: order.positions[0]!.id,
      },
    });
    const row = await prisma.scanRow.create({
      data: {
        taskId: task.id,
        rollCode,
        fromOrderId: order.id,
        scanStatus: 'expected',
      },
    });
    return {
      actor: {
        userId: user.id,
        role: 'warehouse',
        sessionId: session.id,
        sessionPurpose: 'full',
        capabilities: ['warehouse:scan'],
      },
      token: label.token,
      postId: post.id,
      taskId: task.id,
      rowId: row.id,
      rollCode,
      lineId: line.id,
      dispatchId: dispatch.id,
      secondaryMaterialId: `rm-secondary-${rawMaterialId.replace(/^rm-/, '')}`,
    };
  }

  async function seedLegacyControlWeightEvidence(fixture: Fixture): Promise<void> {
    const device = await prisma.deviceRuntime.findFirstOrThrow({
      where: { postId: fixture.postId, kind: 'scale' },
      select: { id: true },
    });
    const operationId = `legacy-control-${randomUUID()}`;
    await prisma.warehouseOperation.create({
      data: {
        id: operationId,
        operationKey: randomUUID(),
        kind: 'control_weight',
        status: 'succeeded',
        taskId: fixture.taskId,
        scanRowId: fixture.rowId,
        rollCode: fixture.rollCode,
        actorId: fixture.actor.userId!,
        sessionId: fixture.actor.sessionId!,
        postId: fixture.postId,
        deviceId: device.id,
        captureChannel: 'machine_post_gateway',
        requestFingerprint: WarehouseOperationService.fingerprint({}),
        safeResult: {
          operationId,
          taskId: fixture.taskId,
          rollCode: fixture.rollCode,
          grossKg: 42,
          spoolKg: 2,
          netKg: 40,
          toleranceOk: true,
          replacementRollCode: null,
        },
        httpStatus: 200,
        completedAt: new Date(),
      },
    });
    await prisma.weightCapture.create({
      data: {
        operatorRollLineId: fixture.lineId,
        kind: 'control',
        deviceId: device.id,
        deviceStatus: 'ready',
        stable: true,
        grossKg: 42,
        spoolKg: 2,
        netKg: 40,
        toleranceOk: true,
        actorRole: 'warehouse',
        actorId: fixture.actor.userId,
        postId: fixture.postId,
        warehouseOperationId: operationId,
      },
    });
  }

  async function sealCurrentPallet(fixture: Fixture): Promise<void> {
    await palletSelection.setSelection(fixture.actor, fixture.taskId, fixture.rowId, {
      operationKey: randomUUID(),
      selected: true,
    });
    const requestId = randomUUID();
    jest.spyOn(palletPrint, 'print').mockResolvedValueOnce({
      id: randomUUID(),
      requestId,
      printerId: 'e2e-printer',
      status: 'submitted',
      gatewayCommandId: null,
      message: 'Задание отправлено',
    });
    await pallets.closeAndPrint(fixture.actor, fixture.taskId, {
      requestId,
      printerId: 'e2e-printer',
    });
  }

  it('allows exactly one distinct-key winner and replays the winner without duplicate facts', async () => {
    const fixture = await createFixture();
    const firstKey = randomUUID();
    const secondKey = randomUUID();
    const auditReached = deferred();
    const releaseAudit = deferred();
    const originalRecord = audit.record.bind(audit);
    jest.spyOn(audit, 'record').mockImplementationOnce(async (input, client) => {
      auditReached.resolve();
      await releaseAudit.promise;
      return originalRecord(input, client);
    });

    const first = service.scan(fixture.actor, fixture.taskId, {
      operationKey: firstKey,
      payload: fixture.token,
    });
    await waitForSignal(auditReached.promise, 'first warehouse scan audit');
    const second = service.scan(fixture.actor, fixture.taskId, {
      operationKey: secondKey,
      payload: fixture.token,
    });
    try {
      await waitForAdvisoryLock(prisma);
    } finally {
      releaseAudit.resolve();
    }

    const outcomes = await Promise.allSettled([first, second]);
    const winners = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<Awaited<typeof first>> =>
        outcome.status === 'fulfilled',
    );
    const losers = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.reason).toBeInstanceOf(ConflictException);

    const winnerIndex = outcomes.findIndex((outcome) => outcome.status === 'fulfilled');
    const winnerKey = winnerIndex === 0 ? firstKey : secondKey;
    const replay = await service.scan(fixture.actor, fixture.taskId, {
      operationKey: winnerKey,
      payload: fixture.token,
    });
    expect(replay).toMatchObject({ replayed: true, rollCode: fixture.rollCode });
    expect(JSON.stringify([winners[0]!.value, replay])).not.toContain(fixture.token);

    await expect(
      prisma.warehouseOperation.count({
        where: { taskId: fixture.taskId, kind: 'receiving_scan', status: 'succeeded' },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.domainEvent.count({
        where: { objectId: fixture.rollCode, type: 'audit:warehouse_roll_received' },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.scanRow.findUniqueOrThrow({
        where: { id: fixture.rowId },
        select: { scanStatus: true },
      }),
    ).resolves.toEqual({ scanStatus: 'accepted' });
    await expect(
      prisma.warehouseRoll.findUniqueOrThrow({
        where: { rollCode: fixture.rollCode },
        select: { warehouseStatus: true },
      }),
    ).resolves.toEqual({ warehouseStatus: 'received' });
    await expect(
      prisma.operatorRollLine.findUniqueOrThrow({
        where: { id: fixture.lineId },
        select: { warehouseState: true },
      }),
    ).resolves.toEqual({ warehouseState: 'received' });
    await expect(
      prisma.rollDispatchItem.findUniqueOrThrow({
        where: { id: fixture.dispatchId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: 'done' });

    const stored = await prisma.warehouseOperation.findFirstOrThrow({
      where: { taskId: fixture.taskId, kind: 'receiving_scan' },
      select: { safeResult: true },
    });
    const events = await prisma.domainEvent.findMany({
      where: { objectId: fixture.rollCode },
      select: { detail: true },
    });
    expect(JSON.stringify({ stored, events })).not.toContain(fixture.token);
  });

  it('rolls back operation, inventory and audit when the audit write path fails', async () => {
    const fixture = await createFixture();
    const originalRecord = audit.record.bind(audit);
    jest.spyOn(audit, 'record').mockImplementationOnce(async (input, client) => {
      await originalRecord(input, client);
      throw new Error('forced warehouse audit failure');
    });

    await expect(
      service.scan(fixture.actor, fixture.taskId, {
        operationKey: randomUUID(),
        payload: fixture.token,
      }),
    ).rejects.toThrow('forced warehouse audit failure');

    await expect(
      prisma.warehouseOperation.count({ where: { taskId: fixture.taskId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.domainEvent.count({
        where: { objectId: fixture.rollCode, type: 'audit:warehouse_roll_received' },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.scanRow.findUniqueOrThrow({
        where: { id: fixture.rowId },
        select: { scanStatus: true },
      }),
    ).resolves.toEqual({ scanStatus: 'expected' });
    await expect(
      prisma.warehouseRoll.findUniqueOrThrow({
        where: { rollCode: fixture.rollCode },
        select: { warehouseStatus: true },
      }),
    ).resolves.toEqual({ warehouseStatus: 'sent' });
    await expect(
      prisma.operatorRollLine.findUniqueOrThrow({
        where: { id: fixture.lineId },
        select: { warehouseState: true },
      }),
    ).resolves.toEqual({ warehouseState: 'sent' });
    await expect(
      prisma.rollDispatchItem.findUniqueOrThrow({
        where: { id: fixture.dispatchId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: 'ready_for_warehouse' });
  });

  it('converges simultaneous retries with the same key to one successful fact', async () => {
    const fixture = await createFixture();
    const operationKey = randomUUID();
    const auditReached = deferred();
    const releaseAudit = deferred();
    const originalRecord = audit.record.bind(audit);
    jest.spyOn(audit, 'record').mockImplementationOnce(async (input, client) => {
      auditReached.resolve();
      await releaseAudit.promise;
      return originalRecord(input, client);
    });

    const first = service.scan(fixture.actor, fixture.taskId, {
      operationKey,
      payload: fixture.token,
    });
    await waitForSignal(auditReached.promise, 'same-key warehouse scan audit');
    const second = service.scan(fixture.actor, fixture.taskId, {
      operationKey,
      payload: fixture.token,
    });
    try {
      await waitForAdvisoryLock(prisma);
    } finally {
      releaseAudit.resolve();
    }

    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    await expect(prisma.warehouseOperation.count({ where: { operationKey } })).resolves.toBe(1);
    await expect(
      prisma.domainEvent.count({
        where: { objectId: fixture.rollCode, type: 'audit:warehouse_roll_received' },
      }),
    ).resolves.toBe(1);
  });

  it('rejects a valid token in the wrong task without fabricating a row or inventory fact', async () => {
    const fixture = await createFixture();
    const wrongTask = await prisma.warehouseAcceptanceTask.create({
      data: { mode: 'receiving', status: 'open', operationCode: `WRONG-${randomUUID()}` },
    });
    const incidentsBefore = await prisma.operationalIncident.count();

    await expect(
      service.scan(fixture.actor, wrongTask.id, {
        operationKey: randomUUID(),
        payload: fixture.token,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WAREHOUSE_TASK_ROLL_MISMATCH' }),
    });

    await expect(
      prisma.warehouseOperation.count({ where: { taskId: wrongTask.id } }),
    ).resolves.toBe(0);
    await expect(prisma.scanRow.count({ where: { taskId: wrongTask.id } })).resolves.toBe(0);
    await expect(
      prisma.warehouseRoll.findUniqueOrThrow({
        where: { rollCode: fixture.rollCode },
        select: { warehouseStatus: true },
      }),
    ).resolves.toEqual({ warehouseStatus: 'sent' });
    await expect(prisma.operationalIncident.count()).resolves.toBe(incidentsBefore);
    const mismatch = await prisma.domainEvent.findFirstOrThrow({
      where: { objectId: fixture.rollCode, type: 'device.scan.mismatch' },
      orderBy: { createdAt: 'desc' },
    });
    expect(JSON.stringify(mismatch)).not.toContain(fixture.token);
  });

  it('accepts browser HID while the production-post gateway scanner is offline', async () => {
    const fixture = await createFixture();
    await prisma.deviceRuntime.updateMany({
      where: { postId: fixture.postId, kind: 'scanner' },
      data: { status: 'offline' },
    });

    await expect(
      service.scan(fixture.actor, fixture.taskId, {
        operationKey: randomUUID(),
        payload: fixture.token,
      }),
    ).resolves.toMatchObject({
      replayed: false,
      rollCode: fixture.rollCode,
      scanStatus: 'accepted',
    });

    const operation = await prisma.warehouseOperation.findFirstOrThrow({
      where: { taskId: fixture.taskId, kind: 'receiving_scan' },
      select: { status: true, postId: true, deviceId: true, captureChannel: true },
    });
    expect(operation).toEqual({
      status: 'succeeded',
      postId: null,
      deviceId: null,
      captureChannel: 'warehouse_browser_hid',
    });
    await expect(
      prisma.domainEvent.count({
        where: { objectId: fixture.rollCode, type: 'device.scan.mismatch' },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.scanRow.findUniqueOrThrow({
        where: { id: fixture.rowId },
        select: { scanStatus: true },
      }),
    ).resolves.toEqual({ scanStatus: 'accepted' });
    await expect(
      prisma.domainEvent.count({
        where: {
          objectId: fixture.rollCode,
          type: 'audit:warehouse_physical_operation_recovered',
        },
      }),
    ).resolves.toBe(0);
  });

  it('fails control weight closed without reading a POST scale or writing physical facts', async () => {
    const fixture = await createFixture();
    await service.scan(fixture.actor, fixture.taskId, {
      operationKey: randomUUID(),
      payload: fixture.token,
    });
    const operationKey = randomUUID();
    const read = jest.spyOn(scale, 'read');

    await expect(
      service.controlWeight(fixture.actor, fixture.taskId, {
        operationKey,
        rollCode: fixture.rollCode,
      }),
    ).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({ code: 'WAREHOUSE_SCALE_NOT_CONFIGURED' }),
    });

    expect(read).not.toHaveBeenCalled();
    await expect(
      prisma.warehouseOperation.count({
        where: { taskId: fixture.taskId, kind: 'control_weight' },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.weightCapture.count({ where: { operatorRollLineId: fixture.lineId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.domainEvent.count({
        where: {
          objectId: fixture.rollCode,
          type: {
            in: [
              'audit:warehouse_control_weight_recorded',
              'audit:warehouse_control_weight_failed',
              'device.scale.offline',
            ],
          },
        },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.scanRow.findUniqueOrThrow({
        where: { id: fixture.rowId },
        select: { scanStatus: true },
      }),
    ).resolves.toEqual({ scanStatus: 'accepted' });
    await expect(
      prisma.warehouseRoll.findUniqueOrThrow({
        where: { rollCode: fixture.rollCode },
        select: { warehouseStatus: true },
      }),
    ).resolves.toEqual({ warehouseStatus: 'received' });
  });

  it('durably expires a stale lease even when full-close evidence is still incomplete', async () => {
    const fixture = await createFixture();
    await service.scan(fixture.actor, fixture.taskId, {
      operationKey: randomUUID(),
      payload: fixture.token,
    });
    await prisma.scanRow.create({
      data: {
        taskId: fixture.taskId,
        rollCode: `UNSCANNED-${randomUUID()}`,
        scanStatus: 'expected',
      },
    });
    const stale = await prisma.warehouseOperation.create({
      data: {
        operationKey: randomUUID(),
        kind: 'control_weight',
        status: 'in_progress',
        taskId: fixture.taskId,
        scanRowId: fixture.rowId,
        rollCode: fixture.rollCode,
        actorId: fixture.actor.userId!,
        sessionId: fixture.actor.sessionId!,
        postId: fixture.postId,
        requestFingerprint: WarehouseOperationService.fingerprint({}),
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() - 1_000),
      },
    });

    await sealCurrentPallet(fixture);
    await expect(
      warehouse.closeTask({ userId: fixture.actor.userId, role: 'warehouse' }, fixture.taskId, {
        mode: 'full',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      prisma.warehouseOperation.findUniqueOrThrow({
        where: { id: stale.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: 'expired' });
    await expect(
      prisma.domainEvent.count({
        where: {
          objectId: fixture.rollCode,
          type: 'audit:warehouse_physical_operation_expired',
        },
      }),
    ).resolves.toBe(1);
  });

  it('records damage from an accepted browser scan using existing evidence without a scale read', async () => {
    const fixture = await createFixture();
    await service.scan(fixture.actor, fixture.taskId, {
      operationKey: randomUUID(),
      payload: fixture.token,
    });
    await seedLegacyControlWeightEvidence(fixture);
    const read = jest.spyOn(scale, 'read');
    const operationKey = randomUUID();

    const first = await service.markDamaged(fixture.actor, fixture.taskId, {
      operationKey,
      rollCode: fixture.rollCode,
      reason: 'Повреждение рулона при разгрузке',
    });
    const replay = await service.markDamaged(fixture.actor, fixture.taskId, {
      operationKey,
      rollCode: fixture.rollCode,
      reason: 'Повреждение рулона при разгрузке',
    });

    expect(first).toMatchObject({ replayed: false, scanStatus: 'damaged' });
    expect(replay).toMatchObject({ replayed: true, operationId: first.operationId });
    expect(read).not.toHaveBeenCalled();
    await expect(
      prisma.warehouseOperation.findUniqueOrThrow({
        where: { operationKey },
        select: { postId: true, deviceId: true, captureChannel: true },
      }),
    ).resolves.toEqual({
      postId: null,
      deviceId: null,
      captureChannel: 'warehouse_role_action',
    });
    await expect(
      prisma.scanRow.findUniqueOrThrow({
        where: { id: fixture.rowId },
        select: { scanStatus: true },
      }),
    ).resolves.toEqual({ scanStatus: 'damaged' });
    await expect(
      prisma.warehouseRoll.findUniqueOrThrow({
        where: { rollCode: fixture.rollCode },
        select: { warehouseStatus: true },
      }),
    ).resolves.toEqual({ warehouseStatus: 'defect' });
    await expect(
      prisma.operatorRollLine.findUniqueOrThrow({
        where: { id: fixture.lineId },
        select: { warehouseState: true },
      }),
    ).resolves.toEqual({ warehouseState: 'defect' });
    await expect(
      prisma.rawMaterialStock.findUnique({
        where: { materialId: fixture.secondaryMaterialId },
        select: { actualQty: true },
      }),
    ).resolves.toBeNull();
    await expect(
      prisma.productionProblem.count({
        where: { rollId: fixture.rollCode, type: 'defect' },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.domainEvent.count({
        where: { objectId: fixture.rollCode, type: 'audit:warehouse_roll_defect_recycled' },
      }),
    ).resolves.toBe(0);
  });

  it.each(['reserve', 'delivery'])(
    'keeps control weight fail-closed and rejects damage in a %s task without mutation',
    async (mode) => {
      const fixture = await createFixture();
      await service.scan(fixture.actor, fixture.taskId, {
        operationKey: randomUUID(),
        payload: fixture.token,
      });
      await prisma.warehouseAcceptanceTask.update({
        where: { id: fixture.taskId },
        data: { mode },
      });
      const read = jest.spyOn(scale, 'read');

      await expect(
        service.controlWeight(fixture.actor, fixture.taskId, {
          operationKey: randomUUID(),
          rollCode: fixture.rollCode,
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'WAREHOUSE_SCALE_NOT_CONFIGURED',
        }),
      });
      await expect(
        service.markDamaged(fixture.actor, fixture.taskId, {
          operationKey: randomUUID(),
          rollCode: fixture.rollCode,
          reason: 'Не должно примениться вне приёмки',
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'WAREHOUSE_DAMAGE_TASK_MODE_INVALID' }),
      });
      expect(read).not.toHaveBeenCalled();

      await expect(
        prisma.warehouseOperation.count({
          where: { taskId: fixture.taskId, kind: { in: ['control_weight', 'mark_damaged'] } },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.scanRow.findUniqueOrThrow({
          where: { id: fixture.rowId },
          select: { scanStatus: true },
        }),
      ).resolves.toEqual({ scanStatus: 'accepted' });
      await expect(
        prisma.warehouseRoll.findUniqueOrThrow({
          where: { rollCode: fixture.rollCode },
          select: { warehouseStatus: true },
        }),
      ).resolves.toEqual({ warehouseStatus: 'received' });
      await expect(
        prisma.productionProblem.count({
          where: { rollId: fixture.rollCode, type: 'defect' },
        }),
      ).resolves.toBe(0);
    },
  );

  it('enforces immutable scan tokens in PostgreSQL', async () => {
    const fixture = await createFixture();
    const replacement = `prt_${'b'.repeat(64)}`;

    await expect(
      prisma.$executeRaw`UPDATE "roll_scan_tokens" SET "token" = ${replacement} WHERE "rollCode" = ${fixture.rollCode}`,
    ).rejects.toBeDefined();
    await expect(
      prisma.$executeRaw`DELETE FROM "roll_scan_tokens" WHERE "rollCode" = ${fixture.rollCode}`,
    ).rejects.toBeDefined();
    await expect(
      prisma.rollScanToken.findUniqueOrThrow({ where: { rollCode: fixture.rollCode } }),
    ).resolves.toMatchObject({ token: fixture.token });
  });
});
