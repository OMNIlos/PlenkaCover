import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WarehouseBigBag, WarehouseBigBagMovementResult } from '../../api/warehouseBigBags';
import { WarehouseBigBagManagementPanel } from './WarehouseBigBagManagementPanel';

const bag: WarehouseBigBag = {
  id: 'bag-1',
  code: 'BB-ПВД-01',
  material: 'ПВД Первичное',
  materialId: 'stock-1',
  materialSelectionKind: 'material',
  materialPreset: null,
  baseRawMaterialDefinitionId: 'material-primary',
  recipeDefinitionVersionId: null,
  recipeName: null,
  recipeVersionNumber: null,
  supplierName: null,
  receivedAt: null,
  composition: [
    {
      rawMaterialDefinitionId: 'material-primary',
      materialId: 'stock-1',
      name: 'ПВД Первичное',
      shareBasisPoints: 10_000,
      initialKg: 500,
    },
  ],
  status: 'available',
  registrationStatus: 'registered',
  location: 'warehouse',
  locationRevision: 1,
  initialKg: 500,
  currentKg: 480,
  lastMeasuredKg: 480,
  lastActorRole: 'warehouse',
  lastMeasuredAt: '2026-08-03T12:00:00.000Z',
  machineId: null,
  lastWarehouseMeasuredKg: 480,
  lastWarehouseMeasuredAt: '2026-08-03T12:00:00.000Z',
  priceKopecksPerKg: 2_500,
  totalKopecks: 1_200_000,
  priceSource: 'manual_warehouse',
  priceEffectiveAt: '2026-08-03T12:00:00.000Z',
  createdByRole: 'warehouse',
  createdAt: '2026-08-03T11:00:00.000Z',
  latestLabelPrint: null,
};

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  const found = root.findAllByType('button').find((candidate) => nodeText(candidate) === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}

function dependencies(
  movement: WarehouseBigBagMovementResult,
  loadedBags: WarehouseBigBag[] = [bag],
) {
  const preview = new Blob(['label'], { type: 'image/png' });
  return {
    loadBags: vi.fn().mockResolvedValue(loadedBags),
    moveBag: vi.fn().mockResolvedValue(movement),
    loadLabelPreview: vi.fn().mockResolvedValue(preview),
    openSystemPrint: vi.fn().mockResolvedValue(undefined),
    recordSystemPrintIntent: vi.fn().mockResolvedValue({
      id: 'print-1',
      requestId: '11111111-1111-4111-8111-111111111111',
      bigBagId: bag.id,
      printerId: null,
      channel: 'browser_system_print' as const,
      status: 'intent_recorded' as const,
      reason: null,
      replacesPrintJobId: null,
      gatewayCommandId: null,
      createdAt: '2026-08-03T12:05:00.000Z',
      updatedAt: '2026-08-03T12:05:00.000Z',
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WarehouseBigBagManagementPanel', () => {
  it('never loads or renders production-post printers for the warehouse workstation', async () => {
    const deps = dependencies({
      bag,
      movement: {
        kind: 'registration',
        fromLocation: null,
        toLocation: 'warehouse',
        locationRevision: 1,
        createdAt: '2026-08-03T12:05:00.000Z',
      },
      weightComparison: null,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<WarehouseBigBagManagementPanel dependencies={deps} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(nodeText(renderer.root)).not.toContain('Принтер Device Gateway');
    expect(renderer.root.findAllByProps({ 'aria-label': 'Принтер QR-этикетки' })).toHaveLength(0);
    renderer.unmount();
  });

  it('loads the safe lifecycle list and renders operational counts', async () => {
    const deps = dependencies({
      bag,
      movement: {
        kind: 'to_production',
        fromLocation: 'warehouse',
        toLocation: 'production',
        locationRevision: 2,
        createdAt: '2026-08-03T12:05:00.000Z',
      },
      weightComparison: null,
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<WarehouseBigBagManagementPanel dependencies={deps} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(nodeText(renderer.root)).toContain('Учет Big-Bag');
    expect(nodeText(renderer.root)).toContain('Всего 1');
    expect(nodeText(renderer.root)).toContain('На складе 1');
    expect(nodeText(renderer.root)).toContain('BB-ПВД-01');
    expect(nodeText(renderer.root)).toContain('25 ₽/кг');
    expect(nodeText(renderer.root)).toContain('12 000 ₽');
    expect(nodeText(renderer.root)).not.toContain('bbt_');
  });

  it('sends an explicit QR destination and shows the movement result', async () => {
    const movedBag = { ...bag, location: 'production' as const, locationRevision: 2 };
    const movement = {
      bag: movedBag,
      movement: {
        kind: 'to_production' as const,
        fromLocation: 'warehouse' as const,
        toLocation: 'production' as const,
        locationRevision: 2,
        createdAt: '2026-08-03T12:05:00.000Z',
      },
      weightComparison: null,
    };
    const deps = dependencies(movement);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<WarehouseBigBagManagementPanel dependencies={deps} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const qrCode = `bbt_${'a'.repeat(64)}`;
    act(() => {
      renderer.root
        .findByProps({ 'aria-label': 'QR-код Big-Bag' })
        .props.onChange({ currentTarget: { value: qrCode } });
      renderer.root
        .findByProps({ 'aria-label': 'Операция с Big-Bag' })
        .props.onChange({ currentTarget: { value: 'to_production' } });
    });
    const preventDefault = vi.fn();
    await act(async () => {
      renderer.root
        .findByProps({ 'aria-label': 'QR-код Big-Bag' })
        .props.onKeyDown({ key: 'Enter', preventDefault });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(deps.moveBag).toHaveBeenCalledWith({
      operationKey: expect.any(String),
      qrCode,
      destination: 'production',
    });
    expect(nodeText(renderer.root)).toContain('Передан в производство');
  });

  it('requires manual warehouse weight on return and displays the comparison', async () => {
    const returnedBag = {
      ...bag,
      location: 'warehouse' as const,
      locationRevision: 3,
      currentKg: 451.2,
      lastWarehouseMeasuredKg: 451.2,
    };
    const deps = dependencies({
      bag: returnedBag,
      movement: {
        kind: 'to_warehouse',
        fromLocation: 'production',
        toLocation: 'warehouse',
        locationRevision: 3,
        createdAt: '2026-08-03T12:05:00.000Z',
      },
      weightComparison: {
        operatorReportedKg: 450,
        warehouseMeasuredKg: 451.2,
        differenceKg: 1.2,
        differencePercent: 0.267,
      },
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<WarehouseBigBagManagementPanel dependencies={deps} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      renderer.root
        .findByProps({ 'aria-label': 'QR-код Big-Bag' })
        .props.onChange({ currentTarget: { value: `bbt_${'b'.repeat(64)}` } });
      renderer.root
        .findByProps({ 'aria-label': 'Операция с Big-Bag' })
        .props.onChange({ currentTarget: { value: 'to_warehouse' } });
    });
    expect(button(renderer.root, 'Подтвердить сканирование').props.disabled).toBe(true);

    act(() => {
      renderer.root
        .findByProps({ 'aria-label': 'Контрольный вес склада, кг' })
        .props.onChange({ currentTarget: { value: '451,2' } });
    });
    await act(async () => {
      button(renderer.root, 'Подтвердить сканирование').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(deps.moveBag).toHaveBeenCalledWith(
      expect.objectContaining({ warehouseWeightKg: 451.2 }),
    );
    expect(nodeText(renderer.root)).toContain('Оператор: 450 кг');
    expect(nodeText(renderer.root)).toContain('Склад: 451,2 кг');
    expect(nodeText(renderer.root)).toContain('Разница: 1,2 кг');
  });

  it('removes a consumed zero-weight Big-Bag after warehouse return', async () => {
    const consumed = {
      ...bag,
      status: 'consumed' as const,
      currentKg: 0,
      lastMeasuredKg: 0,
    };
    const deps = dependencies({
      bag: consumed,
      movement: {
        kind: 'to_warehouse',
        fromLocation: 'production',
        toLocation: 'warehouse',
        locationRevision: 3,
        createdAt: '2026-08-03T12:05:00.000Z',
      },
      weightComparison: {
        operatorReportedKg: 1,
        warehouseMeasuredKg: 0,
        differenceKg: -1,
        differencePercent: -100,
      },
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<WarehouseBigBagManagementPanel dependencies={deps} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      renderer.root.findByProps({ 'aria-label': 'QR-код Big-Bag' }).props.onChange({
        currentTarget: { value: `bbt_${'c'.repeat(64)}` },
      });
      renderer.root.findByProps({ 'aria-label': 'Операция с Big-Bag' }).props.onChange({
        currentTarget: { value: 'to_warehouse' },
      });
    });
    act(() => {
      renderer.root.findByProps({ 'aria-label': 'Контрольный вес склада, кг' }).props.onChange({
        currentTarget: { value: '0' },
      });
    });
    await act(async () => {
      button(renderer.root, 'Подтвердить сканирование').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(nodeText(renderer.root)).toContain('Возвращён на склад');
    expect(nodeText(renderer.root)).toContain('Всего 0');
    expect(renderer.root.findAllByProps({ role: 'listitem' })).toHaveLength(0);
  });

  it('opens the immutable Big-Bag preview through warehouse system printing', async () => {
    const deps = dependencies({
      bag,
      movement: {
        kind: 'registration',
        fromLocation: null,
        toLocation: 'warehouse',
        locationRevision: 1,
        createdAt: '2026-08-03T12:05:00.000Z',
      },
      weightComparison: null,
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<WarehouseBigBagManagementPanel dependencies={deps} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      button(renderer.root, 'Печать QR-этикетки').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(deps.recordSystemPrintIntent).toHaveBeenCalledWith(bag.id, {
      requestId: expect.any(String),
    });
    expect(deps.loadLabelPreview).toHaveBeenCalledWith(bag.id);
    expect(deps.openSystemPrint).toHaveBeenCalledWith(expect.any(Blob));
    expect(nodeText(renderer.root)).toContain('Открыта системная печать');
    expect(button(renderer.root, 'Повторить печать').props.disabled).toBe(true);
  });

  it('restores the durable print state after reload and requires a reprint reason', async () => {
    const latestLabelPrint = {
      id: 'print-existing',
      requestId: '33333333-3333-4333-8333-333333333333',
      bigBagId: bag.id,
      printerId: null,
      channel: 'browser_system_print' as const,
      status: 'intent_recorded' as const,
      reason: null,
      replacesPrintJobId: null,
      gatewayCommandId: null,
      createdAt: '2026-08-03T12:04:00.000Z',
      updatedAt: '2026-08-03T12:04:00.000Z',
    };
    const deps = dependencies(
      {
        bag,
        movement: {
          kind: 'registration',
          fromLocation: null,
          toLocation: 'warehouse',
          locationRevision: 1,
          createdAt: '2026-08-03T12:05:00.000Z',
        },
        weightComparison: null,
      },
      [{ ...bag, latestLabelPrint }],
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<WarehouseBigBagManagementPanel dependencies={deps} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(nodeText(renderer.root)).toContain('Открыта системная печать');
    expect(button(renderer.root, 'Повторить печать').props.disabled).toBe(true);
    act(() => {
      renderer.root
        .findByProps({ placeholder: 'Заполните только для повторной печати' })
        .props.onChange({ currentTarget: { value: 'Этикетка повреждена' } });
    });
    await act(async () => {
      button(renderer.root, 'Повторить печать').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(deps.recordSystemPrintIntent).toHaveBeenCalledWith(
      bag.id,
      expect.objectContaining({ reason: 'Этикетка повреждена' }),
    );
  });

  it('freezes the reprint reason and reuses one request after the local print window fails', async () => {
    const latestLabelPrint = {
      id: 'print-existing',
      requestId: '33333333-3333-4333-8333-333333333333',
      bigBagId: bag.id,
      printerId: null,
      channel: 'browser_system_print' as const,
      status: 'intent_recorded' as const,
      reason: null,
      replacesPrintJobId: null,
      gatewayCommandId: null,
      createdAt: '2026-08-03T12:04:00.000Z',
      updatedAt: '2026-08-03T12:04:00.000Z',
    };
    const deps = dependencies(
      {
        bag,
        movement: {
          kind: 'registration',
          fromLocation: null,
          toLocation: 'warehouse',
          locationRevision: 1,
          createdAt: '2026-08-03T12:05:00.000Z',
        },
        weightComparison: null,
      },
      [{ ...bag, latestLabelPrint }],
    );
    deps.openSystemPrint.mockRejectedValueOnce(new Error('Окно печати не открылось'));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<WarehouseBigBagManagementPanel dependencies={deps} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const reasonInput = renderer.root.findByProps({
      placeholder: 'Заполните только для повторной печати',
    });
    act(() => {
      reasonInput.props.onChange({ currentTarget: { value: 'Этикетка повреждена' } });
    });

    await act(async () => {
      button(renderer.root, 'Повторить печать').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    const frozenReason = renderer.root.findByProps({
      placeholder: 'Заполните только для повторной печати',
    });
    expect(frozenReason.props.disabled).toBe(true);
    expect(frozenReason.props.value).toBe('Этикетка повреждена');
    expect(nodeText(renderer.root)).toContain('Причина зафиксирована до открытия печати');
    const retryButton = button(renderer.root, 'Повторить запрос');
    await act(async () => {
      retryButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(deps.recordSystemPrintIntent).toHaveBeenCalledTimes(2);
    expect(deps.recordSystemPrintIntent.mock.calls[1]).toEqual(
      deps.recordSystemPrintIntent.mock.calls[0],
    );
  });

  it('serializes rapid print clicks and locks Big-Bag selection until completion', async () => {
    const secondBag = { ...bag, id: 'bag-2', code: 'BB-ПВД-02' };
    const deps = dependencies(
      {
        bag,
        movement: {
          kind: 'registration',
          fromLocation: null,
          toLocation: 'warehouse',
          locationRevision: 1,
          createdAt: '2026-08-03T12:05:00.000Z',
        },
        weightComparison: null,
      },
      [bag, secondBag],
    );
    let resolvePrint!: () => void;
    deps.openSystemPrint.mockReturnValue(
      new Promise<void>((resolve) => {
        resolvePrint = resolve;
      }),
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<WarehouseBigBagManagementPanel dependencies={deps} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const printButton = button(renderer.root, 'Печать QR-этикетки');

    act(() => {
      printButton.props.onClick();
      printButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(deps.recordSystemPrintIntent).toHaveBeenCalledTimes(1);
    expect(deps.openSystemPrint).toHaveBeenCalledTimes(1);
    const bagButtons = renderer.root
      .findAllByType('button')
      .filter((candidate) => candidate.props.role === 'listitem');
    expect(bagButtons).toHaveLength(2);
    expect(bagButtons.every((candidate) => candidate.props.disabled === true)).toBe(true);

    await act(async () => {
      resolvePrint();
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});
