import {
  PALLET_LABEL_CONFIGURABLE_PROFILE,
  PALLET_LABEL_SNAPSHOT_PROFILES,
  type PalletLabelSnapshotProfile,
  type PalletLabelSnapshot,
} from '@plenka/contracts';
import {
  ConfigurablePalletLabelRenderer,
  PALLET_LABEL_LAYOUT_PREVIEW_TOKEN,
} from '../../common/pallet-label-layout/configurable-pallet-label.renderer';
import { parsePalletLabelLayoutPublication } from '../../common/pallet-label-layout/pallet-label-layout.validator';
import {
  assertExtendedPalletLabelSnapshotRenderable,
  assertSafePalletLabelSnapshotRenderable,
  assertSquarePalletLabelSnapshotRenderable,
} from './pallet-label.renderer';

const BROWSER_ONLY_PALLET_LABEL_PROFILES = [
  'pallet-100x100-square-v4',
  'pallet-100x100-safe-v5',
  'pallet-100x100-extended-v6',
  'pallet-100x100-configurable-v7',
] as const satisfies readonly PalletLabelSnapshotProfile[];

export function isBrowserOnlyPalletLabelProfile(profile: PalletLabelSnapshotProfile): boolean {
  return (BROWSER_ONLY_PALLET_LABEL_PROFILES as readonly string[]).includes(profile);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isPalletLabelProfile(value: unknown): value is PalletLabelSnapshotProfile {
  return (
    typeof value === 'string' &&
    (PALLET_LABEL_SNAPSHOT_PROFILES as readonly string[]).includes(value)
  );
}

export function immutablePalletLabelProfile(payload: unknown): PalletLabelSnapshotProfile | null {
  const payloadRecord = asRecord(payload);
  const labelRecord = asRecord(payloadRecord?.label);
  const payloadProfile = payloadRecord?.templateVersion;
  const labelProfile = labelRecord?.templateVersion;
  if (payloadProfile !== labelProfile || !isPalletLabelProfile(payloadProfile)) {
    return null;
  }
  return payloadProfile;
}

export function palletLabelDocumentFormat(
  profile: PalletLabelSnapshotProfile,
): 'label_100x150' | 'label_100x100' {
  return isBrowserOnlyPalletLabelProfile(profile) ? 'label_100x100' : 'label_100x150';
}

export function palletLabelFieldSetStatus(
  profile: PalletLabelSnapshotProfile,
): 'template_v1' | 'template_square_v4' {
  return isBrowserOnlyPalletLabelProfile(profile) ? 'template_square_v4' : 'template_v1';
}

function exactStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.trim() !== item) return null;
    values.push(item);
  }
  return values;
}

function exactRowRollCodes(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const rollCodes: string[] = [];
  for (const [index, item] of value.entries()) {
    const row = asRecord(item);
    if (
      !row ||
      row.seq !== index + 1 ||
      typeof row.rollCode !== 'string' ||
      row.rollCode.length === 0 ||
      row.rollCode.trim() !== row.rollCode
    ) {
      return null;
    }
    rollCodes.push(row.rollCode);
  }
  return rollCodes;
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Verifies the immutable composition added by square-v4 before its document is persisted.
 * Legacy snapshots deliberately keep their historical shape and are not reinterpreted here.
 */
export function hasExactPalletDocumentComposition(
  payload: unknown,
  documentRollIds: readonly unknown[],
): boolean {
  const payloadRecord = asRecord(payload);
  const labelRecord = asRecord(payloadRecord?.label);
  const payloadProfile = payloadRecord?.templateVersion;
  const labelProfile = labelRecord?.templateVersion;
  const browserProfile =
    typeof payloadProfile === 'string' &&
    isPalletLabelProfile(payloadProfile) &&
    isBrowserOnlyPalletLabelProfile(payloadProfile);
  const isSquare =
    browserProfile ||
    (typeof labelProfile === 'string' &&
      isPalletLabelProfile(labelProfile) &&
      isBrowserOnlyPalletLabelProfile(labelProfile));
  if (!isSquare) return true;
  if (!payloadRecord || !labelRecord || !browserProfile || labelProfile !== payloadProfile) {
    return false;
  }

  const documentCodes = exactStringArray(documentRollIds);
  const rowCodes = exactRowRollCodes(payloadRecord.rows);
  const labelCodes = exactStringArray(labelRecord.rollCodes);
  if (!documentCodes || !rowCodes || !labelCodes || documentCodes.length === 0) return false;
  if (labelRecord.rollCount !== documentCodes.length) return false;
  if (new Set(documentCodes).size !== documentCodes.length) return false;

  return sameOrderedValues(documentCodes, rowCodes) && sameOrderedValues(rowCodes, labelCodes);
}

/**
 * Checks the physical text/geometry envelope independently from composition identity.
 * This distinction keeps an exact pallet mismatch actionable instead of masking a layout limit.
 */
export function hasRenderablePalletDocumentSnapshot(payload: unknown): boolean {
  const payloadRecord = asRecord(payload);
  const labelRecord = asRecord(payloadRecord?.label);
  const payloadProfile = payloadRecord?.templateVersion;
  const labelProfile = labelRecord?.templateVersion;
  const isBrowserProfile = (value: unknown): value is PalletLabelSnapshotProfile =>
    typeof value === 'string' &&
    isPalletLabelProfile(value) &&
    isBrowserOnlyPalletLabelProfile(value);
  const isBrowserDocument = isBrowserProfile(payloadProfile) || isBrowserProfile(labelProfile);

  // Historical 100x150 snapshots retain their existing validation/render path.
  if (!isBrowserDocument) return true;
  if (
    !payloadRecord ||
    !labelRecord ||
    !isBrowserProfile(payloadProfile) ||
    labelProfile !== payloadProfile
  ) {
    return false;
  }

  try {
    if (payloadProfile === PALLET_LABEL_CONFIGURABLE_PROFILE) {
      const publication = parsePalletLabelLayoutPublication(payloadRecord.layoutPublication);
      new ConfigurablePalletLabelRenderer().render(
        labelRecord as unknown as PalletLabelSnapshot,
        publication.layout,
        { qrToken: PALLET_LABEL_LAYOUT_PREVIEW_TOKEN, watermark: true },
      );
    } else if (payloadProfile === 'pallet-100x100-safe-v5') {
      assertSafePalletLabelSnapshotRenderable(labelRecord as unknown as PalletLabelSnapshot);
    } else if (payloadProfile === 'pallet-100x100-extended-v6') {
      assertExtendedPalletLabelSnapshotRenderable(labelRecord as unknown as PalletLabelSnapshot);
    } else {
      assertSquarePalletLabelSnapshotRenderable(labelRecord as unknown as PalletLabelSnapshot);
    }
    return true;
  } catch {
    return false;
  }
}
