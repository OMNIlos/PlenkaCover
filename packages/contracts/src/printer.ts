import { PALLET_LABEL_PROFILES, type PalletLabelProfile } from './warehouse-runtime';

export const PALLET_LABEL_PROFILE = {
  templateVersion: 'pallet-100x150-v1',
  widthMm: 100,
  heightMm: 150,
  dpi: 203,
  widthDots: 800,
  heightDots: 1200,
  bytesPerRow: 100,
  bitmapBytes: 120_000,
  copies: 1,
} as const;

export type RollLabelPrinterPayload = {
  kind: 'roll_label';
  rollCode: string;
  qrCode: string;
};

export type BigBagLabelPrinterPayload = {
  kind: 'big_bag_label';
  destination: 'operator' | 'warehouse';
  bigBagCode: string;
  material: string;
  qrCode: string;
};

export type PalletLabelPrinterPayload = {
  kind: 'pallet_label';
  documentId: string;
  templateVersion: PalletLabelProfile;
  widthMm: typeof PALLET_LABEL_PROFILE.widthMm;
  heightMm: typeof PALLET_LABEL_PROFILE.heightMm;
  dpi: typeof PALLET_LABEL_PROFILE.dpi;
  widthDots: typeof PALLET_LABEL_PROFILE.widthDots;
  heightDots: typeof PALLET_LABEL_PROFILE.heightDots;
  bitmapBase64: string;
  copies: typeof PALLET_LABEL_PROFILE.copies;
};

export type PrinterPayload =
  | RollLabelPrinterPayload
  | BigBagLabelPrinterPayload
  | PalletLabelPrinterPayload;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isNonEmptyString = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maxLength;

const palletLabelProfileSet = new Set<string>(PALLET_LABEL_PROFILES);

const isPalletLabelProfile = (value: unknown): value is PalletLabelProfile =>
  typeof value === 'string' && palletLabelProfileSet.has(value);

export const isRollScanToken = (value: unknown): value is string =>
  typeof value === 'string' && /^prt_[0-9a-f]{64}$/u.test(value);

export const isBigBagScanToken = (value: unknown): value is string =>
  typeof value === 'string' && /^bbt_[0-9a-f]{64}$/u.test(value);

export const isPalletScanToken = (value: unknown): value is string =>
  typeof value === 'string' && /^plt_[0-9a-f]{64}$/u.test(value);

const isPalletBitmap = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length === 160_000 &&
  /^[A-Za-z0-9+/]+={0,2}$/.test(value) &&
  Buffer.from(value, 'base64').length === PALLET_LABEL_PROFILE.bitmapBytes;

export function isPrinterPayload(value: unknown): value is PrinterPayload {
  if (!isRecord(value)) return false;

  if (value.kind === 'roll_label') {
    return isNonEmptyString(value.rollCode, 200) && isRollScanToken(value.qrCode);
  }

  if (value.kind === 'big_bag_label') {
    return (
      (value.destination === 'operator' || value.destination === 'warehouse') &&
      isNonEmptyString(value.bigBagCode, 200) &&
      isNonEmptyString(value.material, 200) &&
      isBigBagScanToken(value.qrCode)
    );
  }

  return (
    value.kind === 'pallet_label' &&
    isNonEmptyString(value.documentId, 200) &&
    isPalletLabelProfile(value.templateVersion) &&
    value.widthMm === PALLET_LABEL_PROFILE.widthMm &&
    value.heightMm === PALLET_LABEL_PROFILE.heightMm &&
    value.dpi === PALLET_LABEL_PROFILE.dpi &&
    value.widthDots === PALLET_LABEL_PROFILE.widthDots &&
    value.heightDots === PALLET_LABEL_PROFILE.heightDots &&
    value.copies === PALLET_LABEL_PROFILE.copies &&
    isPalletBitmap(value.bitmapBase64)
  );
}
