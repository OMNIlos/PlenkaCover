import { createHash } from 'node:crypto';
import type { WarehouseIntakeTaskView } from '@plenka/contracts';
import { PUBLISHED_PALLET_LABEL_LAYOUT } from '../admin/pallet-label-layout-editor.validator';
import { PalletLabelRenderer } from './pallet-label.renderer';
import { buildPalletListPayload, PALLET_STORAGE_CONDITIONS } from './pallet-list.builder';
import {
  hasExactPalletDocumentComposition,
  hasRenderablePalletDocumentSnapshot,
} from './pallet-label-snapshot';

const mixedTask: WarehouseIntakeTaskView = {
  taskId: 'task-mixed',
  operationCode: 'ПР-1407-01',
  orderNumbers: ['A-100', 'B-200', 'C-300'],
  customerAliases: ['Альфа', 'Бета', 'Гамма'],
  orderNumber: null,
  customerAlias: null,
  status: 'pallet_open',
  plannedRollCount: 3,
  expected: 0,
  accepted: 3,
  errors: 0,
  closable: true,
  lastScanResult: null,
  activePallet: null,
  palletHistory: [],
  palletHistoryHasMore: false,
  palletList: null,
  createdAt: '2026-07-14T10:00:00.000Z',
  updatedAt: '2026-07-14T11:00:00.000Z',
  rolls: [
    {
      scanRowId: 'scan-r-1',
      rollCode: 'R-1',
      orderId: 'order-a',
      orderLineId: 'line-a',
      orderNumber: 'A-100',
      customerAlias: 'Альфа',
      sequence: 1,
      planKg: 40,
      netKg: 40.1,
      grossKg: 41,
      characteristics: {
        filmType: 'полурукав',
        materialMark: 'ПВД',
        sizeMeters: '2000мм',
        actualThickness: '150мкм',
        lengthMeters: '275м',
        spoolType: '76 мм',
        article: null,
        packagingMaterial: null,
        packagingCount: null,
        deliveryDate: null,
      },
      source: 'production_handover',
      ownership: 'customer_owned',
      operatorLabel: 'Оператор 1',
      machineLabel: 'Станок 1',
      productionStatus: 'done',
      producedAt: '2026-06-20T08:00:00.000Z',
      scanStatus: 'accepted',
      warehouseState: 'sent',
      scannedByName: 'Сборщик 1',
      palletSelection: { selected: false, locked: false, palletId: null, palletCode: null },
    },
    {
      scanRowId: 'scan-r-2',
      rollCode: 'R-2',
      orderId: 'order-b',
      orderLineId: 'line-b',
      orderNumber: 'B-200',
      customerAlias: 'Бета',
      sequence: 2,
      planKg: 41,
      netKg: 41.2,
      grossKg: null,
      characteristics: {
        filmType: 'рукав',
        materialMark: 'ПВД',
        sizeMeters: '1500мм',
        actualThickness: '120мкм',
        lengthMeters: '275м',
        spoolType: '76 мм',
        article: null,
        packagingMaterial: null,
        packagingCount: null,
        deliveryDate: null,
      },
      source: 'warehouse_reserve',
      ownership: 'reserved_for_order',
      operatorLabel: 'Оператор 2',
      machineLabel: 'Станок 2',
      productionStatus: 'done',
      producedAt: '2026-07-02T08:00:00.000Z',
      scanStatus: 'accepted',
      warehouseState: 'received',
      scannedByName: 'Сборщик 2',
      palletSelection: { selected: false, locked: false, palletId: null, palletCode: null },
    },
    {
      scanRowId: 'scan-r-3',
      rollCode: 'R-3',
      orderId: 'order-c',
      orderLineId: 'line-c',
      orderNumber: 'C-300',
      customerAlias: 'Гамма',
      sequence: 3,
      planKg: 42,
      netKg: 42.3,
      grossKg: 43,
      characteristics: {
        filmType: 'полурукав',
        materialMark: 'ПВД',
        sizeMeters: '2000мм',
        actualThickness: '150мкм',
        lengthMeters: '275м',
        spoolType: '76 мм',
        article: null,
        packagingMaterial: null,
        packagingCount: null,
        deliveryDate: null,
      },
      source: 'production_handover',
      ownership: 'free_reserve',
      operatorLabel: 'Оператор 3',
      machineLabel: 'Станок 3',
      productionStatus: 'done',
      producedAt: '2026-07-03T08:00:00.000Z',
      scanStatus: 'accepted',
      warehouseState: 'sent',
      scannedByName: 'Сборщик 1',
      palletSelection: { selected: false, locked: false, palletId: null, palletCode: null },
    },
  ],
};

describe('buildPalletListPayload', () => {
  it.each(['pallet-100x150-v1', 'pallet-100x150-compact-v2'] as const)(
    'preserves the immutable legacy label JSON bytes for %s',
    (profile) => {
      const payload = buildPalletListPayload(
        mixedTask,
        'Склад 1',
        '2026-07-14T12:00:00.000Z',
        undefined,
        profile,
      );
      const expected = {
        templateVersion: profile,
        palletId: 'ПР-1407-01',
        materialMark: 'ПВД',
        productNames: [
          'Пленка полиэтиленовая полурукав 150мкм 2000мм 275м',
          'Пленка полиэтиленовая рукав 120мкм 1500мм 275м',
        ],
        article: null,
        rollCount: 3,
        packagingMaterial: null,
        packagingCount: null,
        netKg: 123.6,
        grossKg: null,
        productionDate: '06.2026–07.2026',
        shelfLifeMonths: 12,
        deliveryDate: null,
        storageConditions: PALLET_STORAGE_CONDITIONS,
        orderNumbers: ['A-100', 'B-200', 'C-300'],
        customerAliases: ['Альфа', 'Бета', 'Гамма'],
        createdAt: '2026-07-14T12:00:00.000Z',
      };

      expect(Object.keys(payload.label)[0]).toBe('templateVersion');
      expect(JSON.stringify(payload.label)).toBe(JSON.stringify(expected));
    },
  );

  it('persists the explicitly selected compact profile in both immutable payload snapshots', () => {
    const buildWithProfile = buildPalletListPayload as unknown as (
      task: Parameters<typeof buildPalletListPayload>[0],
      actorName: string | null,
      createdAt: string,
      scope: Parameters<typeof buildPalletListPayload>[3],
      profile: 'pallet-100x150-compact-v2',
    ) => ReturnType<typeof buildPalletListPayload>;
    const payload = buildWithProfile(
      mixedTask,
      'Склад 1',
      '2026-07-14T12:00:00.000Z',
      undefined,
      'pallet-100x150-compact-v2',
    );

    expect(payload.templateVersion).toBe('pallet-100x150-compact-v2');
    expect(payload.label.templateVersion).toBe('pallet-100x150-compact-v2');
  });

  it.each([
    'pallet-100x100-square-v4',
    'pallet-100x100-safe-v5',
    'pallet-100x100-extended-v6',
  ] as const)('persists every selected roll code in the immutable %s label snapshot', (profile) => {
    const payload = buildPalletListPayload(
      mixedTask,
      'Склад 1',
      '2026-07-14T12:00:00.000Z',
      {
        palletId: 'PAL-A-100-01',
        rollCodes: ['R-1'],
        printReady: true,
      },
      profile,
    );

    expect(payload.templateVersion).toBe(profile);
    expect(Object.keys(payload.label)[0]).toBe('templateVersion');
    expect(payload.label.templateVersion).toBe(profile);
    expect(payload.label.rollCodes).toEqual(['R-1']);
    expect(payload.label.rollCodes).toEqual(payload.rows.map((row) => row.rollCode));
  });

  it.each(['pallet-100x100-safe-v5', 'pallet-100x100-extended-v6'] as const)(
    'builds a renderable one-roll %s document from production storage conditions',
    (profile) => {
      const payload = buildPalletListPayload(
        mixedTask,
        'Склад 1',
        '2026-08-09T14:00:00.000Z',
        {
          palletId: 'PAL-A-2-04',
          rollCodes: ['R-1'],
          printReady: true,
        },
        profile,
      );

      expect(hasExactPalletDocumentComposition(payload, ['R-1'])).toBe(true);
      expect(hasRenderablePalletDocumentSnapshot(payload)).toBe(true);
    },
  );

  it('keeps an exact four-product builder boundary in v6 and resized v7 capacity', () => {
    const forms = ['рукав', 'полурукав', 'полотно', 'фальц'];
    const rolls = forms.map((filmType, index) => ({
      ...mixedTask.rolls[0],
      scanRowId: `scan-boundary-${index + 1}`,
      rollCode: `BOUNDARY-${index + 1}`,
      orderLineId: `line-boundary-${index + 1}`,
      sequence: index + 1,
      characteristics: {
        ...mixedTask.rolls[0].characteristics,
        filmType,
        actualThickness: '999мкм',
        sizeMeters: '9999мм',
        lengthMeters: '9999м',
        article: 'Ш'.repeat(26),
        packagingMaterial: 'Ш'.repeat(44),
        packagingCount: 100_000,
      },
    }));
    const task: WarehouseIntakeTaskView = {
      ...mixedTask,
      accepted: rolls.length,
      rolls,
    };
    const scope = {
      palletId: 'PAL-A-100-BOUNDARY',
      rollCodes: rolls.map((roll) => roll.rollCode),
      printReady: true,
    };
    const v6 = buildPalletListPayload(
      task,
      'Склад 1',
      '2026-08-11T18:30:00.000Z',
      scope,
      'pallet-100x100-extended-v6',
    );
    const v7 = buildPalletListPayload(
      task,
      'Склад 1',
      '2026-08-11T18:30:00.000Z',
      scope,
      'pallet-100x100-configurable-v7',
    );
    const renderer = new PalletLabelRenderer();
    const token = `plt_${'a'.repeat(64)}`;
    const publicationFor = (layout: typeof PUBLISHED_PALLET_LABEL_LAYOUT) => ({
      id: 'publication-boundary',
      version: 1,
      contentHash: createHash('sha256').update(JSON.stringify(layout), 'utf8').digest('hex'),
      activatedAt: '2026-08-11T18:30:00.000Z',
      layout,
    });

    expect(v6.label.productNames).toEqual(
      forms.map((filmType) => `Пленка полиэтиленовая ${filmType} 999мкм 9999мм 9999м`),
    );
    expect(v6.label).toMatchObject({
      article: 'Ш'.repeat(26),
      packagingMaterial: 'Ш'.repeat(44),
      packagingCount: 100_000,
    });
    expect(() =>
      renderer.renderPalletLabelSvg(v6.label, token, 'pallet-100x100-extended-v6'),
    ).not.toThrow();
    expect(() =>
      renderer.renderPalletLabelSvg(
        v7.label,
        token,
        'pallet-100x100-configurable-v7',
        publicationFor(PUBLISHED_PALLET_LABEL_LAYOUT),
      ),
    ).not.toThrow();

    const narrowLayout = structuredClone(PUBLISHED_PALLET_LABEL_LAYOUT);
    narrowLayout.elements.find((element) => element.id === 'storage')!.widthDots = 332;
    expect(
      renderer.renderPalletLabelSvg(
        v7.label,
        token,
        'pallet-100x100-configurable-v7',
        publicationFor(narrowLayout),
      ),
    ).toContain('data-fit-mode="emergency"');
  });

  it('builds a print-ready snapshot from only the current physical pallet', () => {
    const task: WarehouseIntakeTaskView = {
      ...mixedTask,
      status: 'scanning',
      accepted: 1,
      expected: 1,
      closable: false,
      rolls: [
        mixedTask.rolls[0],
        {
          ...mixedTask.rolls[1],
          scanStatus: 'expected',
        },
      ],
    };

    const payload = buildPalletListPayload(task, 'Склад 1', '2026-07-14T12:00:00.000Z', {
      palletId: 'PAL-A-100-01',
      rollCodes: ['R-1'],
      printReady: true,
    });

    expect(payload.palletId).toBe('PAL-A-100-01');
    expect(payload.label.palletId).toBe('PAL-A-100-01');
    expect(payload.rows.map((row) => row.rollCode)).toEqual(['R-1']);
    expect(payload.orderIds).toEqual(['order-a']);
    expect(payload.orderNumbers).toEqual(['A-100']);
    expect(payload.scannedCount).toBe(1);
    expect(payload.expectedCount).toBe(1);
    expect(payload.printReady).toBe(true);
    expect(JSON.stringify(payload)).not.toContain('scanRowId');
  });

  it('rejects a missing scoped roll or rolls from multiple orders', () => {
    expect(() =>
      buildPalletListPayload(mixedTask, 'Склад 1', '2026-07-14T12:00:00.000Z', {
        palletId: 'PAL-A-100-01',
        rollCodes: ['R-MISSING'],
        printReady: true,
      }),
    ).toThrow('Pallet scope contains an unknown roll');

    expect(() =>
      buildPalletListPayload(mixedTask, 'Склад 1', '2026-07-14T12:00:00.000Z', {
        palletId: 'PAL-MIXED-01',
        rollCodes: ['R-1', 'R-2'],
        printReady: true,
      }),
    ).toThrow('Physical pallet cannot contain multiple orders');
  });

  it('keeps every mixed-pallet order and creates an immutable label snapshot', () => {
    const payload = buildPalletListPayload(mixedTask, 'Склад 1', '2026-07-14T12:00:00.000Z');

    expect(payload.orderNumbers).toEqual(['A-100', 'B-200', 'C-300']);
    expect(payload.rows.map((row) => row.customerAlias)).toEqual(['Альфа', 'Бета', 'Гамма']);
    expect(payload.label.productNames).toEqual([
      'Пленка полиэтиленовая полурукав 150мкм 2000мм 275м',
      'Пленка полиэтиленовая рукав 120мкм 1500мм 275м',
    ]);
    expect(payload.label.productionDate).toBe('06.2026–07.2026');
    expect(payload.label.grossKg).toBeNull();
    expect(payload.label.shelfLifeMonths).toBe(12);
    expect(payload.label.createdAt).toBe('2026-07-14T12:00:00.000Z');
    expect(payload.label.rollCodes).toBeUndefined();
    expect(payload.printReady).toBe(true);
  });

  it('normalizes material, form and measurement units into one stable 1C name', () => {
    const nomenclatureTask: WarehouseIntakeTaskView = {
      ...mixedTask,
      rolls: mixedTask.rolls.map((roll, index) => ({
        ...roll,
        characteristics: {
          ...roll.characteristics,
          filmType: ['ПВД Полотно', 'пленка полиэтиленовая полотно', 'Полотно пленка ПВД'][index],
          actualThickness: ['80', '80 мкм', '80мкм'][index],
          sizeMeters: ['1700', '1700 мм', '1,7 м'][index],
          lengthMeters: ['275', '275 м', '275м'][index],
        },
      })),
    };

    const payload = buildPalletListPayload(nomenclatureTask, 'Склад 1', '2026-07-14T12:00:00.000Z');

    expect(payload.label.productNames).toEqual(['Пленка полиэтиленовая полотно 80мкм 1700мм 275м']);
    expect(payload.rows.map((row) => row.productName)).toEqual([
      'Пленка полиэтиленовая полотно 80мкм 1700мм 275м',
      'Пленка полиэтиленовая полотно 80мкм 1700мм 275м',
      'Пленка полиэтиленовая полотно 80мкм 1700мм 275м',
    ]);
  });

  it.each([
    'ПВД',
    'Пленка',
    'Полиэтиленовая',
    'Пленка полиэтиленовая',
    '  пЛёНкА, ПОЛИЭТИЛЕНОВАЯ / ПвД!  ',
  ])('removes standalone Cyrillic material tokens from %p', (filmType) => {
    const nomenclatureTask: WarehouseIntakeTaskView = {
      ...mixedTask,
      rolls: [
        {
          ...mixedTask.rolls[0],
          characteristics: {
            ...mixedTask.rolls[0].characteristics,
            filmType,
            actualThickness: '80 мкм',
            sizeMeters: '1700 мм',
            lengthMeters: '275 м',
          },
        },
      ],
    };

    const payload = buildPalletListPayload(nomenclatureTask, 'Склад 1', '2026-07-14T12:00:00.000Z');

    expect(payload.rows[0].productName).toBe('Пленка полиэтиленовая 80мкм 1700мм 275м');
  });

  it.each([
    ['ПВД-полотно', 'полотно'],
    ['Пленка-полотно', 'полотно'],
    ['PE-LD-рукав', 'рукав'],
  ])('removes orphan separators from %p', (filmType, expectedForm) => {
    const nomenclatureTask: WarehouseIntakeTaskView = {
      ...mixedTask,
      rolls: [
        {
          ...mixedTask.rolls[0],
          characteristics: {
            ...mixedTask.rolls[0].characteristics,
            filmType,
            actualThickness: '80 мкм',
            sizeMeters: '1700 мм',
            lengthMeters: '275 м',
          },
        },
      ],
    };

    const payload = buildPalletListPayload(nomenclatureTask, 'Склад 1', '2026-07-14T12:00:00.000Z');

    expect(payload.rows[0].productName).toBe(
      `Пленка полиэтиленовая ${expectedForm} 80мкм 1700мм 275м`,
    );
  });

  it.each(['суперпвд', 'пленкообразующий', 'неполиэтиленовая'])(
    'keeps material-like substrings in a real film form: %p',
    (filmType) => {
      const nomenclatureTask: WarehouseIntakeTaskView = {
        ...mixedTask,
        rolls: [
          {
            ...mixedTask.rolls[0],
            characteristics: {
              ...mixedTask.rolls[0].characteristics,
              filmType,
              actualThickness: '80 мкм',
              sizeMeters: '1700 мм',
              lengthMeters: '275 м',
            },
          },
        ],
      };

      const payload = buildPalletListPayload(
        nomenclatureTask,
        'Склад 1',
        '2026-07-14T12:00:00.000Z',
      );

      expect(payload.rows[0].productName).toBe(
        `Пленка полиэтиленовая ${filmType} 80мкм 1700мм 275м`,
      );
    },
  );
});
