import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { PalletListPayload } from '@plenka/contracts';
import request from 'supertest';
import { PALLET_STORAGE_CONDITIONS } from '../src/modules/warehouse/pallet-list.builder';

type AuthHeaders = Record<string, string>;

type SealPalletOptions = {
  expectedRollCount?: number;
  postCode?: string;
};

type IntakeTask = {
  taskId: string;
  rolls: Array<{
    scanRowId: string;
    scanStatus: string;
    palletSelection: { selected: boolean; locked: boolean };
  }>;
};

type SealedPhysicalPalletTask = {
  id: string;
  orderId: string;
  rows: Array<{
    id: string;
    rollCode: string;
    lastScanAt?: Date | null;
  }>;
};

/**
 * Persists the exact physical evidence required by WarehouseService when a focused service-level
 * PostgreSQL test cannot exercise the HTTP pallet workflow. Keep this fixture narrow: it must
 * model a sealed, non-voided pallet, active row membership, and its immutable physical document.
 */
export async function createSealedPhysicalPalletEvidenceFixture(
  prisma: Pick<PrismaClient, 'warehousePallet'>,
  task: SealedPhysicalPalletTask,
  actorId: string | null = null,
) {
  const now = new Date();
  const palletCode = `PAL-E2E-${randomUUID()}`;
  const rollCodes = task.rows.map((row) => row.rollCode);
  const productNames = ['E2E physical pallet evidence'];
  const payload: PalletListPayload = {
    templateVersion: 'pallet-100x150-v1',
    palletId: palletCode,
    operationCode: null,
    orderIds: [task.orderId],
    orderNumbers: [],
    customerAliases: [],
    products: productNames,
    orderNumber: null,
    customerAlias: null,
    scannedCount: task.rows.length,
    expectedCount: task.rows.length,
    printReady: true,
    rows: task.rows.map((row, index) => ({
      seq: index + 1,
      rollCode: row.rollCode,
      orderId: task.orderId,
      orderNumber: null,
      customerAlias: null,
      productName: productNames[0],
      netKg: null,
      grossKg: null,
      planKg: null,
      status: 'accepted',
    })),
    totals: {
      rollCount: task.rows.length,
      plannedKg: 0,
      netKg: 0,
      grossKg: null,
    },
    receivedBy: null,
    collectedBy: null,
    date: now.toISOString(),
    label: {
      templateVersion: 'pallet-100x150-v1',
      palletId: palletCode,
      materialMark: 'PE-LD',
      productNames,
      article: null,
      rollCount: task.rows.length,
      packagingMaterial: null,
      packagingCount: null,
      netKg: 0,
      grossKg: null,
      productionDate: null,
      shelfLifeMonths: 12,
      deliveryDate: null,
      storageConditions: PALLET_STORAGE_CONDITIONS,
      orderNumbers: [],
      customerAliases: [],
      createdAt: now.toISOString(),
    },
  };
  return prisma.warehousePallet.create({
    data: {
      palletCode,
      sequenceNo: 1,
      status: 'sealed',
      closeRequestId: randomUUID(),
      openedById: actorId,
      sealedAt: now,
      sealedById: actorId,
      task: { connect: { id: task.id } },
      order: { connect: { id: task.orderId } },
      items: {
        create: task.rows.map((row, index) => ({
          rollCode: row.rollCode,
          position: index + 1,
          acceptedAt: row.lastScanAt ?? now,
          assignedById: actorId,
          scanRow: { connect: { id: row.id } },
        })),
      },
      document: {
        create: {
          palletId: palletCode,
          origin: 'physical_pallet',
          rollIds: rollCodes,
          orderIds: [task.orderId],
          generatedByRole: 'warehouse',
          format: 'label_100x150',
          fieldSetStatus: 'template_v1',
          payload,
          acceptanceTask: { connect: { id: task.id } },
        },
      },
    },
    include: { document: true, items: true },
  });
}

/**
 * Mirrors the warehouse UI's explicit, server-owned pallet composition step.
 * Physical acceptance alone must never imply pallet membership.
 */
export async function selectAcceptedRowsIntoCurrentPalletFixture(
  app: INestApplication,
  warehouseAuth: AuthHeaders,
  taskId: string,
) {
  const intake = await request(app.getHttpServer())
    .get('/api/warehouse/intake')
    .set(warehouseAuth)
    .expect(200);
  const task = (intake.body.tasks as IntakeTask[]).find((candidate) => candidate.taskId === taskId);
  if (!task) {
    throw new Error(`Warehouse intake task ${taskId} is absent from the public projection.`);
  }

  const selectable = task.rolls.filter(
    (roll) =>
      roll.scanStatus === 'accepted' &&
      !roll.palletSelection.selected &&
      !roll.palletSelection.locked,
  );
  for (const roll of selectable) {
    await request(app.getHttpServer())
      .put(`/api/warehouse/intake/${taskId}/pallet-selection/${roll.scanRowId}`)
      .set(warehouseAuth)
      .send({ operationKey: randomUUID(), selected: true })
      .expect(200);
  }
  return selectable;
}

/**
 * Completes the physical receiving invariant through the public warehouse API:
 * accepted rolls must be sealed into an immutable pallet and submitted to a ready post printer
 * before a full acceptance close is allowed.
 */
export async function sealAndPrintCurrentPalletFixture(
  app: INestApplication,
  warehouseAuth: AuthHeaders,
  taskId: string,
  options: SealPalletOptions = {},
) {
  const postCode = options.postCode ?? 'POST-1';
  await selectAcceptedRowsIntoCurrentPalletFixture(app, warehouseAuth, taskId);
  const draft = await request(app.getHttpServer())
    .get(`/api/warehouse/intake/${taskId}/pallet-list`)
    .set(warehouseAuth)
    .expect(200);
  if (
    options.expectedRollCount !== undefined &&
    draft.body.rows?.length !== options.expectedRollCount
  ) {
    throw new Error(
      `Pallet ${taskId} contains ${String(draft.body.rows?.length)} rolls; ` +
        `expected ${options.expectedRollCount}.`,
    );
  }

  const printers = await request(app.getHttpServer())
    .get('/api/warehouse/printers')
    .set(warehouseAuth)
    .expect(200);
  const readyPrinter = (
    printers.body as Array<{ id: string; ready: boolean; post: { code: string } }>
  ).find((printer) => printer.ready && printer.post.code === postCode);
  if (!readyPrinter) {
    throw new Error(`Post ${postCode} has no ready warehouse printer.`);
  }

  const response = await request(app.getHttpServer())
    .post(`/api/warehouse/intake/${taskId}/pallets/current/close-and-print`)
    .set(warehouseAuth)
    .send({ printerId: readyPrinter.id, requestId: randomUUID() })
    .expect(200);
  if (response.body.pallet?.status !== 'sealed') {
    throw new Error(`Warehouse pallet ${taskId} was not sealed.`);
  }
  return response.body as {
    pallet: { id: string; status: 'sealed'; rollCount: number };
    document: { id: string; printStatus: string };
    printJob: { id: string; status: string };
  };
}
