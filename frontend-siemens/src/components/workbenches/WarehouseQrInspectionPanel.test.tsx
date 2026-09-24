import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { WarehouseQrInspection } from '../../api/warehouseQrInspection';
import { WarehouseQrInspectionPanel } from './WarehouseQrInspectionPanel';

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

const roll: WarehouseQrInspection = {
  kind: 'roll',
  inspectedAt: '2026-08-06T06:00:00.000Z',
  roll: {
    rollCode: 'ROLL-0001',
    orderId: 'order-1',
    orderNumber: 'ЗК-0001',
    customerAlias: 'УралПак',
    requestCreatedAt: '2026-08-05T09:00:00.000Z',
    readyForShipmentAt: '2026-08-06T05:00:00.000Z',
    shipmentCompletedAt: null,
    sequence: 1,
    plannedKg: 40,
    spoolKg: 0.7,
    grossKg: 40.8,
    netKg: 40.1,
    toleranceOk: true,
    filmType: 'Рукав',
    actualThickness: '80 мкм',
    accountingThickness: '78 мкм',
    widthMm: 400,
    plannedLengthM: 1_500,
    spoolType: 'Тонкая',
    birka: 'ГОСТ',
    productionStatus: 'completed',
    warehouseStatus: 'received',
    producedAt: '2026-08-06T04:30:00.000Z',
    receivedAt: '2026-08-06T05:10:00.000Z',
  },
};

const bigBag: WarehouseQrInspection = {
  kind: 'big_bag',
  inspectedAt: '2026-08-06T06:00:00.000Z',
  bigBag: {
    id: 'bag-1',
    code: 'BB-ПВД-01',
    material: 'ПВД первичный',
    status: 'available',
    registrationStatus: 'registered',
    location: 'warehouse',
    initialKg: 500,
    currentKg: 425.125,
    lastMeasuredKg: 430,
    lastMeasuredAt: '2026-08-06T03:00:00.000Z',
    priceKopecksPerKg: 2_500,
    totalKopecks: 1_062_813,
    priceEffectiveAt: '2026-08-05T07:00:00.000Z',
    createdAt: '2026-08-05T07:00:00.000Z',
  },
};

const pallet: WarehouseQrInspection = {
  kind: 'pallet',
  inspectedAt: '2026-08-06T06:00:00.000Z',
  pallet: {
    palletCode: 'PAL-A-100-01',
    status: null,
    documentStatus: 'sealed',
    materialMark: 'ПВД 10803-020',
    productNames: ['Рукав 80 мкм'],
    article: 'A-100-80',
    rollCount: 12,
    rollCodes: Array.from({ length: 12 }, (_, index) => `A-100-roll-${index + 1}`),
    packagingMaterial: 'Стрейч-плёнка',
    packagingCount: 1,
    shelfLifeMonths: 12,
    storageConditions: 'Хранить в сухом помещении',
    netKg: 481.2,
    grossKg: 489.7,
    productionDate: '06.2026–07.2026',
    deliveryDate: 'август 2026',
    orderNumbers: ['A-100'],
    customerAliases: ['УралПак'],
    createdAt: '2026-08-06T05:30:00.000Z',
    sealedAt: '2026-08-06T05:30:00.000Z',
  },
};

describe('WarehouseQrInspectionPanel', () => {
  it('names every supported object type in the QR inspection scope', () => {
    const renderer = TestRenderer.create(
      <WarehouseQrInspectionPanel dependencies={{ inspect: vi.fn() }} />,
    );

    expect(renderer.root.findByType('input').props['aria-label']).toBe(
      'QR-код рулона, палеты или Big-Bag',
    );
    expect(nodeText(renderer.root)).toContain('Рулоны, палеты и Big-Bag');
  });

  it('keeps inspection visibly read-only and renders current roll facts', async () => {
    const inspect = vi.fn().mockResolvedValue(roll);
    const renderer = TestRenderer.create(<WarehouseQrInspectionPanel dependencies={{ inspect }} />);
    const input = renderer.root.findByType('input');
    const form = renderer.root.findByType('form');
    const payload = `prt_${'a'.repeat(64)}`;

    act(() => input.props.onChange({ currentTarget: { value: payload } }));
    await act(async () => {
      form.props.onSubmit({ preventDefault: vi.fn() });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(inspect).toHaveBeenCalledWith(payload);
    expect(nodeText(renderer.root)).toContain(
      'Показывает актуальные данные без приёмки и перемещения',
    );
    expect(nodeText(renderer.root)).toContain('ROLL-0001');
    expect(nodeText(renderer.root)).toContain('ЗК-0001');
    expect(nodeText(renderer.root)).toContain('40,1 кг');
    expect(nodeText(renderer.root)).toContain('400 мм');
    expect(nodeText(renderer.root)).not.toContain(payload);
  });

  it('uses the same input for Big-Bag and renders current weight and value', async () => {
    const inspect = vi.fn().mockResolvedValue(bigBag);
    const renderer = TestRenderer.create(<WarehouseQrInspectionPanel dependencies={{ inspect }} />);
    const payload = `bbt_${'b'.repeat(64)}`;
    act(() =>
      renderer.root.findByType('input').props.onChange({ currentTarget: { value: payload } }),
    );
    await act(async () => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(inspect).toHaveBeenCalledWith(payload);
    expect(nodeText(renderer.root)).toContain('BB-ПВД-01');
    expect(nodeText(renderer.root)).toContain('425,125 кг');
    expect(nodeText(renderer.root)).toContain('10 628,13 ₽');
  });

  it('uses the same read-only inspection flow for a compact pallet summary', async () => {
    const inspect = vi.fn().mockResolvedValue(pallet);
    const renderer = TestRenderer.create(<WarehouseQrInspectionPanel dependencies={{ inspect }} />);
    const payload = `plt_${'c'.repeat(64)}`;
    act(() =>
      renderer.root.findByType('input').props.onChange({ currentTarget: { value: payload } }),
    );
    await act(async () => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
      await Promise.resolve();
      await Promise.resolve();
    });

    const text = nodeText(renderer.root);
    expect(inspect).toHaveBeenCalledWith(payload);
    expect(text).toContain('PAL-A-100-01');
    expect(text).toContain('ПВД 10803-020');
    expect(text).toContain('Рукав 80 мкм');
    expect(text).toContain('12 рул.');
    expect(text).toContain('Статус палетного листаДействует');
    const rollList = renderer.root.findByProps({ 'aria-label': 'Рулоны на палете' });
    expect(rollList.findAllByType('li').map(nodeText)).toEqual(pallet.pallet.rollCodes);
    expect(text).toContain('Нетто 481,2 кг');
    expect(text).toContain('12 мес.');
    expect(text).toContain('Хранить в сухом помещении');
    expect(text).toContain('Статус не указан');
    expect(text).not.toContain('Открыта');
    expect(text).toContain('06.2026–07.2026');
    expect(text).toContain('август 2026');
    expect(text).toContain('A-100');
    expect(text).not.toContain(payload);
  });

  it('marks a voided pallet document explicitly without exposing its QR payload', async () => {
    const voidedPallet: WarehouseQrInspection = {
      ...pallet,
      pallet: {
        ...pallet.pallet,
        documentStatus: 'voided',
      },
    };
    const inspect = vi.fn().mockResolvedValue(voidedPallet);
    const renderer = TestRenderer.create(<WarehouseQrInspectionPanel dependencies={{ inspect }} />);
    const payload = `plt_${'f'.repeat(64)}`;

    act(() =>
      renderer.root.findByType('input').props.onChange({ currentTarget: { value: payload } }),
    );
    await act(async () => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
      await Promise.resolve();
      await Promise.resolve();
    });

    const text = nodeText(renderer.root);
    expect(text).toContain('Палетный лист аннулирован');
    expect(text).toContain('Статус палетного листаАннулирован');
    expect(text).not.toContain(payload);
  });

  it('keeps a legacy pallet summary concise when roll composition is unavailable', async () => {
    const legacyPallet: WarehouseQrInspection = {
      ...pallet,
      pallet: {
        ...pallet.pallet,
        rollCodes: [],
        documentStatus: null,
      },
    };
    const inspect = vi.fn().mockResolvedValue(legacyPallet);
    const renderer = TestRenderer.create(<WarehouseQrInspectionPanel dependencies={{ inspect }} />);

    act(() =>
      renderer.root.findByType('input').props.onChange({
        currentTarget: { value: `plt_${'d'.repeat(64)}` },
      }),
    );
    await act(async () => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(nodeText(renderer.root)).toContain('12 рул.');
    expect(nodeText(renderer.root)).toContain('Статус палетного листаНе указан');
    expect(renderer.root.findAllByProps({ 'aria-label': 'Рулоны на палете' })).toHaveLength(0);
  });

  it('shows absent legacy pallet shelf-life facts without rendering null as data', async () => {
    const legacyPallet = {
      ...pallet,
      pallet: {
        ...pallet.pallet,
        shelfLifeMonths: null,
        storageConditions: null,
      },
    } as WarehouseQrInspection;
    const inspect = vi.fn().mockResolvedValue(legacyPallet);
    const renderer = TestRenderer.create(<WarehouseQrInspectionPanel dependencies={{ inspect }} />);
    const payload = `plt_${'d'.repeat(64)}`;

    act(() =>
      renderer.root.findByType('input').props.onChange({ currentTarget: { value: payload } }),
    );
    await act(async () => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
      await Promise.resolve();
      await Promise.resolve();
    });

    const text = nodeText(renderer.root);
    expect(text).toContain('Срок годности—');
    expect(text).toContain('Хранение—');
    expect(text).not.toContain('null мес.');
  });

  it('removes a previous pallet while checking another code and keeps it removed on failure', async () => {
    let rejectNext!: (reason?: unknown) => void;
    const inspect = vi
      .fn()
      .mockResolvedValueOnce(pallet)
      .mockImplementationOnce(
        () =>
          new Promise<WarehouseQrInspection>((_resolve, reject) => {
            rejectNext = reject;
          }),
      );
    const renderer = TestRenderer.create(<WarehouseQrInspectionPanel dependencies={{ inspect }} />);
    const input = renderer.root.findByType('input');
    const form = renderer.root.findByType('form');

    act(() =>
      input.props.onChange({
        currentTarget: { value: `plt_${'e'.repeat(64)}` },
      }),
    );
    await act(async () => {
      form.props.onSubmit({ preventDefault: vi.fn() });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(nodeText(renderer.root)).toContain('PAL-A-100-01');

    act(() =>
      input.props.onChange({
        currentTarget: { value: `plt_${'f'.repeat(64)}` },
      }),
    );
    act(() => form.props.onSubmit({ preventDefault: vi.fn() }));

    expect(nodeText(renderer.root)).not.toContain('PAL-A-100-01');

    await act(async () => {
      rejectNext(new Error('Палета не найдена'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(nodeText(renderer.root)).not.toContain('PAL-A-100-01');
  });

  it('announces QR inspection failures as an alert', async () => {
    const inspect = vi.fn().mockRejectedValue(new Error('Палета не найдена'));
    const renderer = TestRenderer.create(<WarehouseQrInspectionPanel dependencies={{ inspect }} />);

    act(() =>
      renderer.root.findByType('input').props.onChange({
        currentTarget: { value: `plt_${'a'.repeat(64)}` },
      }),
    );
    await act(async () => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
      await Promise.resolve();
      await Promise.resolve();
    });

    const alert = renderer.root.findByProps({ role: 'alert' });
    expect(nodeText(alert)).toContain('Палета не найдена');
  });

  it('restores scanner focus only after the QR input is enabled again', async () => {
    let resolveInspection!: (inspection: WarehouseQrInspection) => void;
    const inspect = vi.fn(
      () =>
        new Promise<WarehouseQrInspection>((resolve) => {
          resolveInspection = resolve;
        }),
    );
    const focusDisabledStates: boolean[] = [];
    let renderer!: TestRenderer.ReactTestRenderer;
    renderer = TestRenderer.create(<WarehouseQrInspectionPanel dependencies={{ inspect }} />, {
      createNodeMock: (element) =>
        element.type === 'input'
          ? {
              focus: () => {
                focusDisabledStates.push(renderer.root.findByType('input').props.disabled);
              },
            }
          : null,
    });

    act(() =>
      renderer.root.findByType('input').props.onChange({
        currentTarget: { value: `plt_${'b'.repeat(64)}` },
      }),
    );
    act(() => renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() }));
    expect(renderer.root.findByType('input').props.disabled).toBe(true);

    await act(async () => {
      resolveInspection(pallet);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(focusDisabledStates).toEqual([false]);
  });

  it('does not submit arbitrary text to a physical endpoint', () => {
    const inspect = vi.fn();
    const renderer = TestRenderer.create(<WarehouseQrInspectionPanel dependencies={{ inspect }} />);
    act(() =>
      renderer.root.findByType('input').props.onChange({ currentTarget: { value: 'ROLL-0001' } }),
    );
    const button = renderer.root.findByProps({ type: 'submit' });

    expect(button.props.disabled).toBe(true);
    act(() => renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() }));
    expect(inspect).not.toHaveBeenCalled();
  });
});
