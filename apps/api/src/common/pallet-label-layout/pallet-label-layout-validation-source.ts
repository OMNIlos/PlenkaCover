import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { PalletLabelSnapshot } from '@plenka/contracts';
import { assertExtendedPalletLabelSnapshotRenderable } from '../../modules/warehouse/pallet-label.renderer';
import { PALLET_STORAGE_CONDITIONS } from '../../modules/warehouse/pallet-list.builder';
import { immutablePalletLabelProfile } from '../../modules/warehouse/pallet-label-snapshot';

const SOURCE_PROFILE = 'pallet-100x100-extended-v6';

/**
 * This is an opaque, server-owned sentinel rather than a pallet-list document id. It is persisted
 * as ordinary scalar provenance when a layout is published, so it deliberately has no database FK.
 */
export const PALLET_LABEL_LAYOUT_CONTROL_SOURCE_ID = 'pllsrc_ctl_1e807e96d0c94b34a5df98cc0ecf4206';

export const PALLET_LABEL_LAYOUT_CONTROL_SOURCE_LABEL = 'Контрольный синтетический источник';

const CONTROL_ROLL_CODES = Array.from(
  { length: 24 },
  (_, index) => `CTRL-ROLL-${String(index + 1).padStart(2, '0')}`,
);

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

/**
 * A synthetic control snapshot for layout validation. It contains no order, customer, device,
 * QR-token or 1C data and cannot identify a production pallet.
 */
export const PALLET_LABEL_LAYOUT_CONTROL_SNAPSHOT: PalletLabelSnapshot = deepFreeze({
  templateVersion: SOURCE_PROFILE,
  palletId: 'CONTROL-VALIDATION-01',
  materialMark: 'CONTROL-MATERIAL-PE-LD',
  productNames: ['CONTROL PRODUCT REPRESENTATIVE MAXIMUM'],
  article: 'CONTROL-ARTICLE-0000000001',
  rollCount: CONTROL_ROLL_CODES.length,
  rollCodes: CONTROL_ROLL_CODES,
  packagingMaterial: 'CONTROL-PACKAGING-MATERIAL',
  packagingCount: 100_000,
  netKg: 999_999_999.999,
  grossKg: 999_999_999.999,
  productionDate: '12.2099',
  shelfLifeMonths: 12,
  deliveryDate: '31.12.2099',
  storageConditions: 'CONTROL STORAGE CONDITIONS FOR LAYOUT VALIDATION ONLY.',
  orderNumbers: ['CONTROL-ORDER-NOT-A-REAL-ORDER'],
  customerAliases: ['CONTROL-CUSTOMER-NOT-A-REAL-CUSTOMER'],
  createdAt: '2026-01-01T00:00:00.000Z',
});

const OPERATIONAL_PRODUCT_NAMES = [
  'Пленка полиэтиленовая рукав 120мкм 1500мм',
  'Пленка полиэтиленовая полурукав 90мкм 1200мм',
  'Пленка полиэтиленовая полотно 70мкм 900мм',
  'Пленка полиэтиленовая фальц 50мкм 600мм',
];
const OPERATIONAL_CUSTOMER_ALIAS = 'ООО ЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗ';
const OPERATIONAL_ROLL_CODES = Array.from(
  { length: 24 },
  (_, index) => `PLK-20260812-${String(index + 1).padStart(2, '0')}`,
);

const COMBINED_OPERATIONAL_BASE: PalletLabelSnapshot = {
  templateVersion: SOURCE_PROFILE,
  palletId: 'PAL-CONTROL-2026-08-0001',
  materialMark: 'ПЭВД 10803-020 / ПЭВД 15803-020 / ПЭВД 15303-003',
  productNames: OPERATIONAL_PRODUCT_NAMES,
  article: 'ПЭВД-1500-120',
  rollCount: OPERATIONAL_ROLL_CODES.length,
  rollCodes: OPERATIONAL_ROLL_CODES,
  packagingMaterial: 'Стрейч-пленка усиленная для палетирования',
  packagingCount: 100_000,
  netKg: 999_999_999.999,
  grossKg: 999_999_999.999,
  productionDate: '12.2099',
  shelfLifeMonths: 12,
  deliveryDate: '31.12.2099',
  storageConditions: PALLET_STORAGE_CONDITIONS,
  orderNumbers: ['ЗАКАЗ-ПРОИЗВОДСТВО-2026-08-12-000001'],
  customerAliases: [OPERATIONAL_CUSTOMER_ALIAS],
  createdAt: '2026-01-01T00:00:00.000Z',
};

/**
 * Finite operational conformance corpus, not a mathematical proof of every bounded v6 value.
 * Every snapshot combines fields emitted together by the pallet-list builder. The second case
 * adds wide, unbroken synthetic values that are accepted by the existing extended-v6 renderer.
 */
export const PALLET_LABEL_LAYOUT_CONFORMANCE_CORPUS = deepFreeze([
  {
    id: 'combined-builder-operational',
    snapshot: COMBINED_OPERATIONAL_BASE,
  },
  {
    id: 'combined-wide-unbroken',
    snapshot: {
      ...COMBINED_OPERATIONAL_BASE,
      palletId: 'Ш'.repeat(13),
      materialMark: 'Ш'.repeat(25),
      productNames: [
        'Пленка полиэтиленовая рукав 999мкм 9999мм 9999м',
        'Пленка полиэтиленовая полурукав 999мкм 9999мм 9999м',
        'Пленка полиэтиленовая полотно 999мкм 9999мм 9999м',
        'Пленка полиэтиленовая фальц 999мкм 9999мм 9999м',
      ],
      article: 'Ш'.repeat(26),
      packagingMaterial: 'Ш'.repeat(44),
      orderNumbers: ['З'.repeat(38)],
      rollCount: 24,
      rollCodes: Array.from(
        { length: 24 },
        (_, index) => `${String(index + 1).padStart(2, '0')}-${'Ш'.repeat(9)}`,
      ),
    },
  },
] satisfies Array<{ id: string; snapshot: PalletLabelSnapshot }>);

type PalletListDocumentSource = {
  id: string;
  palletId: string;
  voidedAt: Date | null;
  payload: unknown;
};

export type PalletLabelLayoutValidationSourceReader = {
  palletListDocument: {
    findUnique(args: {
      where: { id: string };
      select: { id: true; palletId: true; voidedAt: true; payload: true };
    }): Promise<PalletListDocumentSource | null>;
  };
};

export type ResolvedPalletLabelLayoutValidationSource = {
  sourceDocumentId: string;
  snapshot: PalletLabelSnapshot;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sourceUnavailable(message: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: 'PALLET_LABEL_LAYOUT_SOURCE_UNAVAILABLE',
    message,
  });
}

function assertRenderable(snapshot: PalletLabelSnapshot, message: string): PalletLabelSnapshot {
  try {
    assertExtendedPalletLabelSnapshotRenderable(snapshot);
    return snapshot;
  } catch {
    throw sourceUnavailable(message);
  }
}

export async function resolvePalletLabelLayoutValidationSource(
  reader: PalletLabelLayoutValidationSourceReader,
  sourceDocumentId: string,
): Promise<ResolvedPalletLabelLayoutValidationSource> {
  if (sourceDocumentId === PALLET_LABEL_LAYOUT_CONTROL_SOURCE_ID) {
    return {
      sourceDocumentId,
      snapshot: assertRenderable(
        PALLET_LABEL_LAYOUT_CONTROL_SNAPSHOT,
        'The synthetic control source is not renderable.',
      ),
    };
  }

  const document = await reader.palletListDocument.findUnique({
    where: { id: sourceDocumentId },
    select: { id: true, palletId: true, voidedAt: true, payload: true },
  });
  if (!document) {
    throw new NotFoundException({
      code: 'PALLET_LABEL_LAYOUT_SOURCE_NOT_FOUND',
      message: 'Pallet-label source was not found.',
    });
  }
  if (document.voidedAt) {
    throw sourceUnavailable('Voided pallet-label documents cannot be layout sources.');
  }
  if (immutablePalletLabelProfile(document.payload) !== SOURCE_PROFILE) {
    throw sourceUnavailable('The layout source is not an immutable extended-v6 document.');
  }

  const payload = asRecord(document.payload);
  const label = asRecord(payload?.label);
  if (!label || label.palletId !== document.palletId) {
    throw sourceUnavailable('The layout source has an inconsistent immutable label snapshot.');
  }

  return {
    sourceDocumentId,
    snapshot: assertRenderable(
      label as unknown as PalletLabelSnapshot,
      'The immutable layout source is not renderable.',
    ),
  };
}
