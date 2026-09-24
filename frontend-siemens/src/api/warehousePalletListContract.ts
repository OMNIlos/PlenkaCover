import {
  usesPalletBrowserSystemPrint,
  type BrowserPalletListTemplateVersion,
  type PalletListTemplateVersion,
} from '../domain/palletListProfiles';

const PALLET_COMPOSITION_PAGE_SIZE = 100;

export type ServerWarehousePallet = {
  id: string;
  palletCode: string;
  orderId: string;
  orderNumber: string;
  sequenceNo: number;
  status: 'open' | 'sealed';
  rollCount: number;
  openedAt: string;
  rows: Array<{
    rollCode: string;
    position: number;
    acceptedAt: string;
    scannedByName: string | null;
  }>;
};

export type ServerWarehousePalletDocument = {
  id: string;
  palletId: string;
  warehousePalletId: string | null;
  origin: 'physical_pallet' | 'legacy';
  /** Missing/unknown server values are deliberately not actionable in the UI. */
  documentStatus?: 'sealed' | 'voided';
  createdAt: string;
  templateVersion: PalletListTemplateVersion;
  printReady: boolean;
  printStatus: 'not_printed' | 'submitted' | 'failed' | 'needs_admin';
  rollCount: number;
  rollCodes: string[];
  rollCodesHasMore: boolean;
  orderId: string | null;
};

type ServerSealedWarehousePalletDocument = ServerWarehousePalletDocument & {
  warehousePalletId: string;
  origin: 'physical_pallet';
  documentStatus: 'sealed';
  templateVersion: BrowserPalletListTemplateVersion;
  printReady: true;
  printStatus: 'not_printed';
  orderId: string;
};

export type ServerSealPalletResult = {
  pallet: ServerWarehousePallet & { status: 'sealed' };
  document: ServerSealedWarehousePalletDocument;
};

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value === value.trim() ? value : null;
}

function identifier(value: unknown): string | null {
  const parsed = text(value);
  return parsed && parsed.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(parsed) ? parsed : null;
}

function nullableText(value: unknown): string | null | undefined {
  if (value === null) return null;
  return text(value) ?? undefined;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value ? value : null;
}

function parsePallet(value: unknown): ServerWarehousePallet & { status: 'sealed' } {
  const input = objectValue(value);
  const id = identifier(input?.id);
  const palletCode = identifier(input?.palletCode);
  const orderId = identifier(input?.orderId);
  const orderNumber = text(input?.orderNumber);
  const sequenceNo = positiveInteger(input?.sequenceNo);
  const rollCount = positiveInteger(input?.rollCount);
  const openedAt = timestamp(input?.openedAt);
  if (
    !input ||
    !id ||
    !palletCode ||
    !orderId ||
    !orderNumber ||
    !sequenceNo ||
    input.status !== 'sealed' ||
    !rollCount ||
    !openedAt ||
    !Array.isArray(input.rows) ||
    input.rows.length !== rollCount
  ) {
    throw new Error('Некорректный закрытый палет.');
  }

  const rows = input.rows.map((value, index) => {
    const row = objectValue(value);
    const rollCode = identifier(row?.rollCode);
    const position = positiveInteger(row?.position);
    const acceptedAt = timestamp(row?.acceptedAt);
    const scannedByName = nullableText(row?.scannedByName);
    if (
      !row ||
      !rollCode ||
      position !== index + 1 ||
      !acceptedAt ||
      scannedByName === undefined
    ) {
      throw new Error('Некорректная строка закрытого палета.');
    }
    return { rollCode, position, acceptedAt, scannedByName };
  });
  if (new Set(rows.map((row) => row.rollCode)).size !== rows.length) {
    throw new Error('Состав закрытого палета содержит повторяющиеся рулоны.');
  }

  return {
    id,
    palletCode,
    orderId,
    orderNumber,
    sequenceNo,
    status: 'sealed',
    rollCount,
    openedAt,
    rows,
  };
}

function parseDocument(value: unknown): ServerSealedWarehousePalletDocument {
  const input = objectValue(value);
  const id = identifier(input?.id);
  const palletId = identifier(input?.palletId);
  const warehousePalletId = identifier(input?.warehousePalletId);
  const createdAt = timestamp(input?.createdAt);
  const rollCount = positiveInteger(input?.rollCount);
  const orderId = identifier(input?.orderId);
  if (
    !input ||
    !id ||
    !palletId ||
    !warehousePalletId ||
    input.origin !== 'physical_pallet' ||
    input.documentStatus !== 'sealed' ||
    !createdAt ||
    !usesPalletBrowserSystemPrint(input.templateVersion) ||
    input.printReady !== true ||
    input.printStatus !== 'not_printed' ||
    !rollCount ||
    !Array.isArray(input.rollCodes) ||
    input.rollCodes.length === 0 ||
    !input.rollCodes.every((rollCode) => identifier(rollCode) !== null) ||
    typeof input.rollCodesHasMore !== 'boolean' ||
    !orderId
  ) {
    throw new Error('Некорректный закрытый палетный лист.');
  }
  const rollCodes = input.rollCodes.map((rollCode) => identifier(rollCode)!);
  if (new Set(rollCodes).size !== rollCodes.length) {
    throw new Error('Палетный лист содержит повторяющиеся рулоны.');
  }
  const expectedCompositionSize = Math.min(rollCount, PALLET_COMPOSITION_PAGE_SIZE);
  if (
    rollCodes.length !== expectedCompositionSize ||
    input.rollCodesHasMore !== (rollCount > PALLET_COMPOSITION_PAGE_SIZE)
  ) {
    throw new Error('Пагинация состава палетного листа некорректна.');
  }

  return {
    id,
    palletId,
    warehousePalletId,
    origin: 'physical_pallet',
    documentStatus: 'sealed',
    createdAt,
    templateVersion: input.templateVersion,
    printReady: true,
    printStatus: 'not_printed',
    rollCount,
    rollCodes,
    rollCodesHasMore: input.rollCodesHasMore,
    orderId,
  };
}

export function parseSealPalletResult(value: unknown): ServerSealPalletResult {
  const input = objectValue(value);
  if (!input) throw new Error('Некорректный ответ закрытия палета.');
  const pallet = parsePallet(input.pallet);
  const document = parseDocument(input.document);
  const palletRollCodes = pallet.rows.map((row) => row.rollCode);
  if (
    document.palletId !== pallet.palletCode ||
    document.warehousePalletId !== pallet.id ||
    document.orderId !== pallet.orderId ||
    document.rollCount !== pallet.rollCount ||
    document.rollCodes.some((rollCode, index) => rollCode !== palletRollCodes[index]) ||
    Date.parse(document.createdAt) < Date.parse(pallet.openedAt)
  ) {
    throw new Error('Связи закрытого палета и палетного листа не совпадают.');
  }
  return { pallet, document };
}
