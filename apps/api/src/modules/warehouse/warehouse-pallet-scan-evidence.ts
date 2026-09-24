import { Prisma } from '@prisma/client';
import {
  hasExactPalletDocumentComposition,
  immutablePalletLabelProfile,
} from './pallet-label-snapshot';

export const PALLET_SCAN_TOKEN_SELECT = {
  documentId: true,
  document: {
    select: {
      warehousePalletId: true,
      acceptanceTaskId: true,
      warehousePallet: { select: { orderId: true } },
    },
  },
} satisfies Prisma.PalletScanTokenSelect;

export const PHYSICAL_PALLET_DOCUMENT_SELECT = {
  id: true,
  palletId: true,
  warehousePalletId: true,
  acceptanceTaskId: true,
  origin: true,
  rollIds: true,
  orderIds: true,
  payload: true,
  voidedAt: true,
  acceptanceTask: {
    select: {
      id: true,
      mode: true,
      status: true,
      orderId: true,
    },
  },
  warehousePallet: {
    select: {
      id: true,
      palletCode: true,
      taskId: true,
      orderId: true,
      status: true,
      sealedAt: true,
      voidedAt: true,
      items: {
        where: { releasedAt: null },
        orderBy: [{ position: 'asc' as const }, { id: 'asc' as const }],
        select: {
          id: true,
          scanRowId: true,
          orderId: true,
          rollCode: true,
          position: true,
          acceptedAt: true,
          releasedAt: true,
          scanRow: {
            select: {
              id: true,
              taskId: true,
              rollCode: true,
              scanStatus: true,
              lastScanAt: true,
              operations: {
                where: { kind: 'receiving_scan', status: 'succeeded' },
                select: {
                  taskId: true,
                  scanRowId: true,
                  rollCode: true,
                  kind: true,
                  status: true,
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.PalletListDocumentSelect;

export type PhysicalPalletDocument = Prisma.PalletListDocumentGetPayload<{
  select: typeof PHYSICAL_PALLET_DOCUMENT_SELECT;
}>;

export type ValidatedPhysicalPallet = {
  documentId: string;
  taskId: string;
  palletId: string;
  palletCode: string;
  orderId: string;
  rollCodes: string[];
};

export function exactPalletStrings(value: Prisma.JsonValue): string[] | null {
  if (!Array.isArray(value)) return null;
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.trim() !== item) return null;
    values.push(item);
  }
  return values;
}

export function validatedPhysicalPallet(
  document: PhysicalPalletDocument,
  rollCodes: string[],
): ValidatedPhysicalPallet | null {
  const pallet = document.warehousePallet;
  const task = document.acceptanceTask;
  const orderIds = exactPalletStrings(document.orderIds);
  if (
    document.origin !== 'physical_pallet' ||
    document.voidedAt !== null ||
    document.warehousePalletId === null ||
    document.acceptanceTaskId === null ||
    !pallet ||
    !task ||
    pallet.id !== document.warehousePalletId ||
    pallet.palletCode !== document.palletId ||
    pallet.taskId !== document.acceptanceTaskId ||
    task.id !== document.acceptanceTaskId ||
    task.mode !== 'receiving' ||
    !['open', 'partial', 'closed'].includes(task.status) ||
    pallet.status !== 'sealed' ||
    pallet.sealedAt === null ||
    pallet.voidedAt !== null ||
    (task.orderId !== null && task.orderId !== pallet.orderId) ||
    !orderIds ||
    orderIds.length !== 1 ||
    orderIds[0] !== pallet.orderId ||
    new Set(rollCodes).size !== rollCodes.length ||
    !immutablePalletLabelProfile(document.payload) ||
    !hasExactPalletDocumentComposition(document.payload, rollCodes) ||
    pallet.items.length !== rollCodes.length
  ) {
    return null;
  }

  const itemIds = new Set<string>();
  const scanRowIds = new Set<string>();
  for (const [index, item] of pallet.items.entries()) {
    const hasDurableReceivingEvidence = item.scanRow.operations.some(
      (operation) =>
        operation.taskId === task.id &&
        operation.scanRowId === item.scanRowId &&
        operation.rollCode === item.rollCode &&
        operation.kind === 'receiving_scan' &&
        operation.status === 'succeeded',
    );
    if (
      item.position !== index + 1 ||
      item.rollCode !== rollCodes[index] ||
      item.orderId !== pallet.orderId ||
      item.releasedAt !== null ||
      !(item.acceptedAt instanceof Date) ||
      itemIds.has(item.id) ||
      scanRowIds.has(item.scanRowId) ||
      item.scanRow.id !== item.scanRowId ||
      item.scanRow.taskId !== task.id ||
      item.scanRow.rollCode !== item.rollCode ||
      item.scanRow.scanStatus !== 'accepted' ||
      !(item.scanRow.lastScanAt instanceof Date) ||
      !hasDurableReceivingEvidence
    ) {
      return null;
    }
    itemIds.add(item.id);
    scanRowIds.add(item.scanRowId);
  }

  return {
    documentId: document.id,
    taskId: task.id,
    palletId: pallet.id,
    palletCode: pallet.palletCode,
    orderId: pallet.orderId,
    rollCodes,
  };
}
