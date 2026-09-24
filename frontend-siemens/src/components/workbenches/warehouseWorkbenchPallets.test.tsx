import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import * as idempotentOperation from '../../api/idempotentOperation';
import * as warehouseApi from '../../api/warehouse';
import type { ActionDescriptor, PalletListDocument, WarehouseWorkbench } from '../../domain/types';
import { WarehouseWorkbenchView } from './warehouseWorkbench';

const activePallet: NonNullable<WarehouseWorkbench['activePallet']> = {
  id: 'pallet-2',
  palletCode: 'PAL-ORD-77-002',
  orderId: 'order-77',
  orderNumber: 'ORD-77',
  sequenceNo: 2,
  status: 'open',
  rollCount: 1,
  openedAt: '2026-07-31T10:00:00.000Z',
  rows: [
    {
      rollCode: 'ROLL-77-03',
      position: 1,
      acceptedAt: '2026-07-31T10:00:00.000Z',
      scannedByName: 'Кладовщик',
    },
  ],
};

const historyDocument: PalletListDocument = {
  id: 'document-1',
  palletId: 'PAL-ORD-77-001',
  warehousePalletId: 'pallet-1',
  origin: 'physical_pallet',
  documentStatus: 'sealed',
  rollCount: 2,
  orderId: 'order-77',
  status: 'ready',
  formatLabel: 'PDF',
  fields: [],
  rollIds: ['ROLL-77-01', 'ROLL-77-02'],
  orderIds: ['order-77'],
  generatedAt: '2026-07-31T09:30:00.000Z',
  templateVersion: 'pallet-100x150-v1',
  printReady: true,
  printStatus: 'submitted',
  fieldSetStatus: 'contract_ready',
  sourceLabel: 'Backend API',
  auditEvent: 'audit:pallet_list_print_requested',
};

const workbench: WarehouseWorkbench = {
  type: 'warehouse',
  mode: 'receiving',
  taskId: 'task-77',
  prompt: 'Сканируйте QR',
  expected: 10,
  scanned: 3,
  missing: [],
  excess: [],
  accepted: ['ROLL-77-01', 'ROLL-77-02', 'ROLL-77-03'],
  lastScan: 'ROLL-77-03',
  scanSeverity: 'info',
  expectedRolls: [],
  activePallet,
  palletListDocuments: [historyDocument],
  palletHistoryHasMore: false,
};

const actions: ActionDescriptor[] = [
  {
    id: 'warehouse.scan:task-77',
    label: 'Сканировать QR',
    level: 'recommended',
    enabled: true,
  },
  {
    id: 'warehouse-close-and-print-pallet:task-77',
    label: 'Закрыть и распечатать палет',
    level: 'secondary',
    enabled: true,
  },
  {
    id: 'warehouse.close:task-77',
    label: 'Закрыть приемку',
    level: 'disabled',
    enabled: false,
    disabledReason: 'Сначала закройте текущий палет',
  },
];

function palletSelectionWorkbench(
  palletSelection: NonNullable<WarehouseWorkbench['expectedRolls']>[number]['palletSelection'],
  palletListDocuments: PalletListDocument[] = [],
): WarehouseWorkbench {
  return {
    ...workbench,
    activePallet: null,
    palletListDocuments,
    expectedRolls: [
      {
        id: 'ROLL-77-01',
        scanRowId: 'scan-row-77-01',
        status: 'Принят',
        filmType: 'Рукав',
        micron: '80 мкм',
        sizeMeters: '2000 мм',
        plannedNetKg: 41.4,
        tolerancePercent: 5,
        palletSelection,
      },
    ],
  };
}

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WarehouseWorkbenchView pallets', () => {
  it('shows the available roll facts inside the current pallet row', () => {
    const detailedWorkbench: WarehouseWorkbench = {
      ...workbench,
      expectedRolls: [
        {
          id: 'ROLL-77-03',
          scanRowId: 'scan-row-77-03',
          status: 'Принят',
          sequenceNumber: 3,
          orderId: 'ORD-77',
          customerAlias: 'УралПак',
          source: 'production_handover',
          ownership: 'customer_owned',
          operatorLabel: 'Оператор 1',
          machineLabel: 'Станок 1',
          productionStatus: 'completed',
          filmType: 'Рукав',
          micron: '80 мкм',
          materialMark: 'PE-LD',
          sizeMeters: '2000 мм',
          lengthMeters: '275 м',
          spoolType: '76 мм',
          article: 'АРТ-77',
          plannedNetKg: 41.4,
          planNetKg: 41.2,
          actualNetKg: 41.4,
          grossKg: 42.1,
          producedAt: '2026-07-31T09:30:00.000Z',
          tolerancePercent: 5,
          palletSelection: {
            selected: true,
            locked: false,
            palletId: 'pallet-2',
            palletCode: 'PAL-ORD-77-002',
          },
        },
      ],
    };
    const renderer = TestRenderer.create(
      <WarehouseWorkbenchView
        workbench={detailedWorkbench}
        actions={actions}
        coverageDecisionTask={null}
        onWarehouseRefresh={vi.fn()}
      />,
    );
    const pallet = renderer.root.findByProps({ 'aria-label': 'Текущий палет' });
    const content = nodeText(pallet);

    expect(content).toContain('Рукав · 80 мкм · PE-LD');
    expect(content).toContain('2000 мм · 275 м · шпуля 76 мм · арт. АРТ-77');
    expect(content).toContain('Нетто 41,4 кг · Брутто 42,1 кг');
    expect(content).toContain('Оператор 1 · Станок 1');
    expect(content).toContain('Принят 31.07.2026, 13:00 · Кладовщик');
  });

  it('shows material, dimensions, actual weights and production context in the intake row', () => {
    const detailed = palletSelectionWorkbench({
      selected: true,
      locked: false,
      palletId: 'pallet-2',
      palletCode: 'PAL-ORD-77-002',
    });
    detailed.expectedRolls = detailed.expectedRolls?.map((roll) => ({
      ...roll,
      materialMark: 'PE-LD',
      lengthMeters: '275 м',
      spoolType: '76 мм',
      article: 'АРТ-77',
      packagingMaterial: 'Стрейч-плёнка',
      packagingCount: 1,
      deliveryDate: '2026-08-20',
      planNetKg: 41.2,
      actualNetKg: 41.4,
      grossKg: 42.1,
      operatorLabel: 'Оператор 1',
      machineLabel: 'Станок 1',
      producedAt: '2026-07-31T09:30:00.000Z',
    }));
    const renderer = TestRenderer.create(
      <WarehouseWorkbenchView
        workbench={detailed}
        actions={actions}
        coverageDecisionTask={null}
        onWarehouseRefresh={vi.fn()}
      />,
    );
    const row = renderer.root.findByProps({ 'data-roll-code': 'ROLL-77-01' });
    const content = nodeText(row);

    expect(content).toContain('Рукав · 80 мкм · PE-LD');
    expect(content).toContain('2000 мм · 275 м · шпуля 76 мм · арт. АРТ-77');
    expect(content).toContain('Нетто 41,4 кг · Брутто 42,1 кг');
    expect(content).toContain('Оператор 1 · Станок 1 · Произведен 31.07.2026, 12:30');
    expect(content).toContain('Упаковка Стрейч-плёнка × 1 · Выдача 20.08.2026');
  });

  it('labels a fallback roll weight as plan instead of actual net weight', () => {
    const renderer = TestRenderer.create(
      <WarehouseWorkbenchView
        workbench={palletSelectionWorkbench({
          selected: false,
          locked: false,
          palletId: null,
          palletCode: null,
        })}
        actions={actions}
        coverageDecisionTask={null}
        onWarehouseRefresh={vi.fn()}
      />,
    );
    const row = renderer.root.findByProps({ 'data-roll-code': 'ROLL-77-01' });
    const content = nodeText(row);

    expect(content).toContain('План 41,4 кг');
    expect(content).not.toContain('Нетто 41,4 кг');
  });

  it('never exposes production reweigh or defect mutations to the warehouse role', () => {
    const renderer = TestRenderer.create(
      <WarehouseWorkbenchView
        workbench={palletSelectionWorkbench({
          selected: false,
          locked: false,
          palletId: null,
          palletCode: null,
        })}
        actions={actions}
        coverageDecisionTask={null}
        onWarehouseRefresh={vi.fn()}
      />,
    );

    expect(nodeText(renderer.root)).not.toContain('Перевзвесить');
    expect(nodeText(renderer.root)).not.toContain('Брак');
  });

  it('renders an accepted unselected roll with the explicit pallet-list button', () => {
    const renderer = TestRenderer.create(
      <WarehouseWorkbenchView
        workbench={palletSelectionWorkbench({
          selected: false,
          locked: false,
          palletId: null,
          palletCode: null,
        })}
        actions={actions}
        coverageDecisionTask={null}
        onWarehouseRefresh={vi.fn()}
      />,
    );

    const button = renderer.root.findByProps({
      'aria-label': 'Добавить ROLL-77-01 в палетный лист',
    });
    expect(nodeText(button)).toBe('Добавить в палетный лист');
    expect(button.props['aria-pressed']).toBe(false);
  });

  it('shows the selected server state with a pressed bright action', () => {
    const renderer = TestRenderer.create(
      <WarehouseWorkbenchView
        workbench={palletSelectionWorkbench({
          selected: true,
          locked: false,
          palletId: 'pallet-2',
          palletCode: 'PAL-ORD-77-002',
        })}
        actions={actions}
        coverageDecisionTask={null}
        onWarehouseRefresh={vi.fn()}
      />,
    );

    const button = renderer.root.findByProps({
      'aria-label': 'ROLL-77-01 в палетном листе',
    });
    expect(nodeText(button)).toBe('В палетном листе');
    expect(button.props['aria-pressed']).toBe(true);
    expect(button.props.className).toContain('is-selected');
  });

  it('renders all intake rolls without a pager', () => {
    const intake = palletSelectionWorkbench({
      selected: true,
      locked: false,
      palletId: 'pallet-2',
      palletCode: 'PAL-ORD-77-002',
    });
    const template = intake.expectedRolls?.[0];
    if (!template) throw new Error('Expected roll template is missing');
    intake.expected = 17;
    intake.expectedRolls = Array.from({ length: 17 }, (_, index) => ({
      ...template,
      id: `ROLL-77-${String(index + 1).padStart(2, '0')}`,
      scanRowId: `scan-row-77-${String(index + 1).padStart(2, '0')}`,
      sequenceNumber: index + 1,
    }));
    intake.accepted = intake.expectedRolls.map((roll) => roll.id);

    const renderer = TestRenderer.create(
      <WarehouseWorkbenchView
        workbench={intake}
        actions={actions}
        coverageDecisionTask={null}
        onWarehouseRefresh={vi.fn()}
      />,
    );

    expect(renderer.root.findAll((node) => node.props['data-roll-code'])).toHaveLength(17);
    expect(renderer.root.findAllByProps({ 'data-roll-code': 'ROLL-77-17' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'aria-label': 'Пагинация таблицы' })).toHaveLength(0);
  });

  it('does not offer pallet composition for a roll that the server has not accepted', () => {
    const pending = palletSelectionWorkbench({
      selected: false,
      locked: false,
      palletId: null,
      palletCode: null,
    });
    pending.accepted = [];
    pending.expectedRolls = pending.expectedRolls?.map((roll) => ({
      ...roll,
      status: 'Ждет скан',
    }));
    const renderer = TestRenderer.create(
      <WarehouseWorkbenchView
        workbench={pending}
        actions={actions}
        coverageDecisionTask={null}
        onWarehouseRefresh={vi.fn()}
      />,
    );

    expect(
      renderer.root.findAllByProps({
        'aria-label': 'Добавить ROLL-77-01 в палетный лист',
      }),
    ).toHaveLength(0);
  });

  it('serializes duplicate pallet selection clicks and waits for the server response', async () => {
    let resolveRequest!: (value: warehouseApi.ServerSetPalletSelectionResult) => void;
    const request = new Promise<warehouseApi.ServerSetPalletSelectionResult>((resolve) => {
      resolveRequest = resolve;
    });
    const select = vi.spyOn(warehouseApi, 'setWarehousePalletSelection').mockReturnValue(request);
    const refresh = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseWorkbenchView
          workbench={palletSelectionWorkbench({
            selected: false,
            locked: false,
            palletId: null,
            palletCode: null,
          })}
          actions={actions}
          coverageDecisionTask={null}
          onWarehouseRefresh={refresh}
        />,
      );
    });
    const button = renderer.root.findByProps({
      'aria-label': 'Добавить ROLL-77-01 в палетный лист',
    });

    act(() => {
      button.props.onClick();
      button.props.onClick();
    });
    expect(select).toHaveBeenCalledOnce();
    expect(button.props['aria-pressed']).toBe(false);
    expect(button.props.disabled).toBe(false);

    await act(async () => {
      resolveRequest({
        selectionChanged: true,
        activePallet: {
          id: 'pallet-2',
          palletCode: 'PAL-ORD-77-002',
          orderId: 'order-77',
          orderNumber: 'ORD-77',
          sequenceNo: 2,
          status: 'open',
          totalCount: 1,
          hasMore: false,
          openedAt: '2026-08-07T10:00:00.000Z',
          rows: [],
        },
      });
      await request;
    });
    expect(refresh).toHaveBeenCalledOnce();
    // The command response is deliberately ignored until its canonical intake refetch arrives.
    expect(button.props['aria-pressed']).toBe(false);
  });

  it('keeps the server state after an error and retries with the same operation key inline', async () => {
    const select = vi
      .spyOn(warehouseApi, 'setWarehousePalletSelection')
      .mockRejectedValueOnce(new ApiError(503, 'internal transport trace'))
      .mockResolvedValueOnce({ selectionChanged: true, activePallet: null });
    const refresh = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseWorkbenchView
          workbench={palletSelectionWorkbench({
            selected: false,
            locked: false,
            palletId: null,
            palletCode: null,
          })}
          actions={actions}
          coverageDecisionTask={null}
          onWarehouseRefresh={refresh}
        />,
      );
    });
    const button = renderer.root.findByProps({
      'aria-label': 'Добавить ROLL-77-01 в палетный лист',
    });

    await act(async () => {
      button.props.onClick();
      await Promise.resolve();
    });
    expect(button.props['aria-pressed']).toBe(false);
    expect(nodeText(renderer.root)).not.toContain('internal transport trace');
    expect(nodeText(renderer.root)).toContain('Не удалось обновить палетный лист.');
    const retry = renderer.root.findByProps({
      'aria-label': 'Повторить добавление ROLL-77-01 в палетный лист',
    });

    await act(async () => {
      retry.props.onClick();
      await Promise.resolve();
    });
    expect(select).toHaveBeenCalledTimes(2);
    expect(select.mock.calls[0][2].operationKey).toBe(select.mock.calls[1][2].operationKey);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('retires an uncertain include key after canonical pallet selection reconciles', async () => {
    vi.spyOn(idempotentOperation, 'createOperationKey')
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222')
      .mockReturnValueOnce('33333333-3333-4333-8333-333333333333');
    const select = vi
      .spyOn(warehouseApi, 'setWarehousePalletSelection')
      .mockRejectedValueOnce(new ApiError(503, 'delivery result unavailable'))
      .mockResolvedValueOnce({ selectionChanged: true, activePallet: null })
      .mockResolvedValueOnce({ selectionChanged: true, activePallet: null });
    const refresh = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseWorkbenchView
          workbench={palletSelectionWorkbench({
            selected: false,
            locked: false,
            palletId: null,
            palletCode: null,
          })}
          actions={actions}
          coverageDecisionTask={null}
          onWarehouseRefresh={refresh}
        />,
      );
    });

    await act(async () => {
      renderer.root
        .findByProps({ 'aria-label': 'Добавить ROLL-77-01 в палетный лист' })
        .props.onClick();
      await Promise.resolve();
    });
    expect(select.mock.calls[0][2].operationKey).toBe('11111111-1111-4111-8111-111111111111');

    await act(async () => {
      renderer.update(
        <WarehouseWorkbenchView
          workbench={palletSelectionWorkbench({
            selected: true,
            locked: false,
            palletId: 'pallet-2',
            palletCode: 'PAL-ORD-77-002',
          })}
          actions={actions}
          coverageDecisionTask={null}
          onWarehouseRefresh={refresh}
        />,
      );
    });
    expect(
      renderer.root.findAllByProps({
        'aria-label': 'Повторить добавление ROLL-77-01 в палетный лист',
      }),
    ).toHaveLength(0);

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': 'ROLL-77-01 в палетном листе' }).props.onClick();
      await Promise.resolve();
    });
    expect(select.mock.calls[1][2]).toEqual({
      operationKey: '22222222-2222-4222-8222-222222222222',
      selected: false,
    });

    await act(async () => {
      renderer.update(
        <WarehouseWorkbenchView
          workbench={palletSelectionWorkbench({
            selected: false,
            locked: false,
            palletId: null,
            palletCode: null,
          })}
          actions={actions}
          coverageDecisionTask={null}
          onWarehouseRefresh={refresh}
        />,
      );
    });
    await act(async () => {
      renderer.root
        .findByProps({ 'aria-label': 'Добавить ROLL-77-01 в палетный лист' })
        .props.onClick();
      await Promise.resolve();
    });

    expect(select).toHaveBeenCalledTimes(3);
    expect(select.mock.calls[2][2]).toEqual({
      operationKey: '33333333-3333-4333-8333-333333333333',
      selected: true,
    });
  });

  it('ignores a late uncertain failure after canonical selection changes', async () => {
    vi.spyOn(idempotentOperation, 'createOperationKey')
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    let rejectInclude!: (reason: unknown) => void;
    const includeRequest = new Promise<warehouseApi.ServerSetPalletSelectionResult>(
      (_resolve, reject) => {
        rejectInclude = reject;
      },
    );
    const select = vi
      .spyOn(warehouseApi, 'setWarehousePalletSelection')
      .mockReturnValueOnce(includeRequest)
      .mockResolvedValueOnce({ selectionChanged: true, activePallet: null });
    const refresh = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseWorkbenchView
          workbench={palletSelectionWorkbench({
            selected: false,
            locked: false,
            palletId: null,
            palletCode: null,
          })}
          actions={actions}
          coverageDecisionTask={null}
          onWarehouseRefresh={refresh}
        />,
      );
    });

    act(() => {
      renderer.root
        .findByProps({ 'aria-label': 'Добавить ROLL-77-01 в палетный лист' })
        .props.onClick();
    });
    await act(async () => {
      renderer.update(
        <WarehouseWorkbenchView
          workbench={palletSelectionWorkbench({
            selected: true,
            locked: false,
            palletId: 'pallet-2',
            palletCode: 'PAL-ORD-77-002',
          })}
          actions={actions}
          coverageDecisionTask={null}
          onWarehouseRefresh={refresh}
        />,
      );
    });
    await act(async () => {
      rejectInclude(new ApiError(503, 'late delivery result'));
      await includeRequest.catch(() => undefined);
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(nodeText(renderer.root)).not.toContain('Не удалось обновить палетный лист.');
    expect(
      renderer.root.findAllByProps({
        'aria-label': 'Повторить добавление ROLL-77-01 в палетный лист',
      }),
    ).toHaveLength(0);
    expect(
      renderer.root.findByProps({ 'aria-label': 'ROLL-77-01 в палетном листе' }).props['aria-busy'],
    ).toBeUndefined();

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': 'ROLL-77-01 в палетном листе' }).props.onClick();
      await Promise.resolve();
    });
    expect(select).toHaveBeenCalledTimes(2);
    expect(select.mock.calls[1][2]).toEqual({
      operationKey: '22222222-2222-4222-8222-222222222222',
      selected: false,
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does not refresh from a late success after canonical selection changes', async () => {
    let resolveInclude!: (result: warehouseApi.ServerSetPalletSelectionResult) => void;
    const includeRequest = new Promise<warehouseApi.ServerSetPalletSelectionResult>((resolve) => {
      resolveInclude = resolve;
    });
    vi.spyOn(warehouseApi, 'setWarehousePalletSelection').mockReturnValueOnce(includeRequest);
    const refresh = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseWorkbenchView
          workbench={palletSelectionWorkbench({
            selected: false,
            locked: false,
            palletId: null,
            palletCode: null,
          })}
          actions={actions}
          coverageDecisionTask={null}
          onWarehouseRefresh={refresh}
        />,
      );
    });

    act(() => {
      renderer.root
        .findByProps({ 'aria-label': 'Добавить ROLL-77-01 в палетный лист' })
        .props.onClick();
    });
    await act(async () => {
      renderer.update(
        <WarehouseWorkbenchView
          workbench={palletSelectionWorkbench({
            selected: true,
            locked: false,
            palletId: 'pallet-2',
            palletCode: 'PAL-ORD-77-002',
          })}
          actions={actions}
          coverageDecisionTask={null}
          onWarehouseRefresh={refresh}
        />,
      );
    });
    await act(async () => {
      resolveInclude({ selectionChanged: true, activePallet: null });
      await includeRequest;
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(
      renderer.root.findByProps({ 'aria-label': 'ROLL-77-01 в палетном листе' }).props['aria-busy'],
    ).toBeUndefined();
  });

  it('does not offer retry when a safe operation key could not be created', async () => {
    vi.spyOn(idempotentOperation, 'createOperationKey').mockImplementationOnce(() => {
      throw new Error('unsafe random source detail');
    });
    const select = vi.spyOn(warehouseApi, 'setWarehousePalletSelection');
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseWorkbenchView
          workbench={palletSelectionWorkbench({
            selected: false,
            locked: false,
            palletId: null,
            palletCode: null,
          })}
          actions={actions}
          coverageDecisionTask={null}
          onWarehouseRefresh={vi.fn()}
        />,
      );
    });

    await act(async () => {
      renderer.root
        .findByProps({ 'aria-label': 'Добавить ROLL-77-01 в палетный лист' })
        .props.onClick();
      await Promise.resolve();
    });

    expect(select).not.toHaveBeenCalled();
    expect(nodeText(renderer.root)).not.toContain('unsafe random source detail');
    expect(
      renderer.root.findAllByProps({
        'aria-label': 'Повторить добавление ROLL-77-01 в палетный лист',
      }),
    ).toHaveLength(0);
  });

  it.each([
    'WAREHOUSE_PALLET_ROLL_NOT_ACCEPTED',
    'WAREHOUSE_PALLET_ORDER_MISMATCH',
    'WAREHOUSE_PALLET_SELECTION_LOCKED',
    'WAREHOUSE_PALLET_SELECTION_OPERATION_CONFLICT',
  ])(
    'refreshes canonical state without retry after terminal selection conflict %s',
    async (code) => {
      vi.spyOn(warehouseApi, 'setWarehousePalletSelection').mockRejectedValueOnce(
        new ApiError(409, 'raw backend conflict detail', code),
      );
      const refresh = vi.fn();
      const selection = {
        selected: false,
        locked: false,
        palletId: null,
        palletCode: null,
      };
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <WarehouseWorkbenchView
            workbench={palletSelectionWorkbench(selection)}
            actions={actions}
            coverageDecisionTask={null}
            onWarehouseRefresh={refresh}
          />,
        );
      });

      await act(async () => {
        renderer.root
          .findByProps({ 'aria-label': 'Добавить ROLL-77-01 в палетный лист' })
          .props.onClick();
        await Promise.resolve();
      });

      expect(refresh).toHaveBeenCalledOnce();
      expect(nodeText(renderer.root)).not.toContain('raw backend conflict detail');
      expect(
        renderer.root.findAllByProps({
          'aria-label': 'Повторить добавление ROLL-77-01 в палетный лист',
        }),
      ).toHaveLength(0);

      await act(async () => {
        renderer.update(
          <WarehouseWorkbenchView
            workbench={palletSelectionWorkbench({
              selected: true,
              locked: true,
              palletId: 'pallet-1',
              palletCode: 'PAL-ORD-77-001',
            })}
            actions={actions}
            coverageDecisionTask={null}
            onWarehouseRefresh={refresh}
          />,
        );
      });

      const row = renderer.root.findByProps({ 'data-roll-code': 'ROLL-77-01' });
      expect(row.props.className).toContain('is-pallet-locked');
      expect(
        row.findAll((node) => node.type === 'button').every((button) => button.props.disabled),
      ).toBe(true);
    },
  );

  it('does not carry retry state or operation key to a reused roll code target', async () => {
    const select = vi
      .spyOn(warehouseApi, 'setWarehousePalletSelection')
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce({ selectionChanged: true, activePallet: null });
    const refresh = vi.fn();
    const selection = {
      selected: false,
      locked: false,
      palletId: null,
      palletCode: null,
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseWorkbenchView
          workbench={palletSelectionWorkbench(selection)}
          actions={actions}
          coverageDecisionTask={null}
          onWarehouseRefresh={refresh}
        />,
      );
    });
    await act(async () => {
      renderer.root
        .findByProps({ 'aria-label': 'Добавить ROLL-77-01 в палетный лист' })
        .props.onClick();
      await Promise.resolve();
    });
    const firstOperationKey = select.mock.calls[0][2].operationKey;
    expect(
      renderer.root.findAllByProps({
        'aria-label': 'Повторить добавление ROLL-77-01 в палетный лист',
      }),
    ).toHaveLength(1);

    const reusedRollWorkbench = palletSelectionWorkbench(selection);
    reusedRollWorkbench.taskId = 'task-88';
    reusedRollWorkbench.expectedRolls = reusedRollWorkbench.expectedRolls?.map((roll) => ({
      ...roll,
      scanRowId: 'scan-row-88-01',
    }));
    await act(async () => {
      renderer.update(
        <WarehouseWorkbenchView
          workbench={reusedRollWorkbench}
          actions={actions}
          coverageDecisionTask={null}
          onWarehouseRefresh={refresh}
        />,
      );
    });

    expect(
      renderer.root.findAllByProps({
        'aria-label': 'Повторить добавление ROLL-77-01 в палетный лист',
      }),
    ).toHaveLength(0);
    await act(async () => {
      renderer.root
        .findByProps({ 'aria-label': 'Добавить ROLL-77-01 в палетный лист' })
        .props.onClick();
      await Promise.resolve();
    });
    expect(select).toHaveBeenCalledTimes(2);
    expect(select.mock.calls[1][0]).toBe('task-88');
    expect(select.mock.calls[1][1]).toBe('scan-row-88-01');
    expect(select.mock.calls[1][2].operationKey).not.toBe(firstOperationKey);
  });

  it('keeps a server-locked roll green and immutable beyond the bounded history page', () => {
    const renderer = TestRenderer.create(
      <WarehouseWorkbenchView
        workbench={palletSelectionWorkbench(
          {
            selected: true,
            locked: true,
            palletId: 'pallet-1',
            palletCode: 'PAL-ORD-77-001',
          },
          [{ ...historyDocument, rollIds: ['ROLL-77-99'] }],
        )}
        actions={actions}
        coverageDecisionTask={null}
        onWarehouseRefresh={vi.fn()}
      />,
    );
    const row = renderer.root.findByProps({ 'data-roll-code': 'ROLL-77-01' });
    expect(row.props.className).toContain('is-pallet-locked');
    expect(
      row.findAll((node) => node.type === 'button').every((button) => button.props.disabled),
    ).toBe(true);
  });

  it('does not lock a released roll from its historical pallet document', () => {
    const renderer = TestRenderer.create(
      <WarehouseWorkbenchView
        workbench={palletSelectionWorkbench(
          {
            selected: false,
            locked: false,
            palletId: null,
            palletCode: null,
          },
          [{ ...historyDocument, rollIds: ['ROLL-77-01'] }],
        )}
        actions={actions}
        coverageDecisionTask={null}
        onWarehouseRefresh={vi.fn()}
      />,
    );
    const row = renderer.root.findByProps({ 'data-roll-code': 'ROLL-77-01' });

    expect(row.props.className).not.toContain('is-pallet-locked');
    expect(
      renderer.root.findByProps({ 'aria-label': 'Добавить ROLL-77-01 в палетный лист' }).props
        .disabled,
    ).toBe(false);
  });

  it('disables a pending inline retry when the canonical refresh locks the roll', async () => {
    vi.spyOn(warehouseApi, 'setWarehousePalletSelection').mockRejectedValueOnce(
      new TypeError('internal transport trace'),
    );
    const unlocked = {
      selected: false,
      locked: false,
      palletId: null,
      palletCode: null,
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseWorkbenchView
          workbench={palletSelectionWorkbench(unlocked)}
          actions={actions}
          coverageDecisionTask={null}
          onWarehouseRefresh={vi.fn()}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root
        .findByProps({ 'aria-label': 'Добавить ROLL-77-01 в палетный лист' })
        .props.onClick();
      await Promise.resolve();
    });

    await act(async () => {
      renderer.update(
        <WarehouseWorkbenchView
          workbench={palletSelectionWorkbench({
            selected: true,
            locked: true,
            palletId: 'pallet-1',
            palletCode: 'PAL-ORD-77-001',
          })}
          actions={actions}
          coverageDecisionTask={null}
          onWarehouseRefresh={vi.fn()}
        />,
      );
    });
    const row = renderer.root.findByProps({ 'data-roll-code': 'ROLL-77-01' });
    expect(
      row.findAll((node) => node.type === 'button').every((button) => button.props.disabled),
    ).toBe(true);
  });

  it('keeps a native toggle button mounted across the canonical refresh for keyboard focus', async () => {
    const selection = {
      selected: false,
      locked: false,
      palletId: null,
      palletCode: null,
    };
    const renderer = TestRenderer.create(
      <WarehouseWorkbenchView
        workbench={palletSelectionWorkbench(selection)}
        actions={actions}
        coverageDecisionTask={null}
        onWarehouseRefresh={vi.fn()}
      />,
    );
    const button = renderer.root.findByProps({
      'aria-label': 'Добавить ROLL-77-01 в палетный лист',
    });
    expect(button.type).toBe('button');
    expect(button.props.type).toBe('button');
    expect(button.props.onKeyDown).toBeUndefined();

    await act(async () => {
      renderer.update(
        <WarehouseWorkbenchView
          workbench={palletSelectionWorkbench({
            selected: true,
            locked: false,
            palletId: 'pallet-2',
            palletCode: 'PAL-ORD-77-002',
          })}
          actions={actions}
          coverageDecisionTask={null}
          onWarehouseRefresh={vi.fn()}
        />,
      );
    });
    expect(renderer.root.findByProps({ 'aria-label': 'ROLL-77-01 в палетном листе' }).type).toBe(
      'button',
    );
    expect(button.props['aria-label']).toBe('ROLL-77-01 в палетном листе');
  });

  it('показывает специальный текущий палет и не дублирует marker-action общей кнопкой', async () => {
    vi.spyOn(warehouseApi, 'fetchWarehousePrinters').mockResolvedValue([
      {
        id: 'printer-a',
        code: 'TLP4-A',
        label: 'MERTECH TLP4 A',
        post: { id: 'post-a', code: 'WH-A', name: 'Склад A' },
        status: 'online',
        ready: true,
        unavailableReason: null,
      },
    ]);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseWorkbenchView
          workbench={workbench}
          actions={actions}
          coverageDecisionTask={null}
          onWarehouseRefresh={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(renderer.root.findAllByProps({ 'aria-label': 'Текущий палет' })).toHaveLength(1);
    expect(
      renderer.root.findAllByProps({
        'aria-label': 'Распечатать текущий палетный лист',
      }),
    ).toHaveLength(1);
    expect(
      renderer.root
        .findAll((node) => node.type === 'button')
        .filter((node) => nodeText(node) === 'Закрыть и распечатать палет'),
    ).toHaveLength(0);
  });

  it('держит документы закрытых палетов свернутыми и открывает выбранный для перепечатки', async () => {
    vi.spyOn(warehouseApi, 'fetchWarehousePrinters').mockResolvedValue([]);
    vi.spyOn(warehouseApi, 'fetchWarehousePalletPreview').mockResolvedValue(
      new Blob(['preview'], { type: 'image/png' }),
    );
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pallet-preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseWorkbenchView
          workbench={workbench}
          actions={actions}
          coverageDecisionTask={null}
          onWarehouseRefresh={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(renderer.root.findAllByProps({ 'aria-label': 'История палетов' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'aria-label': 'Палетный лист' })).toHaveLength(0);
    expect(createObjectUrl).not.toHaveBeenCalled();

    await act(async () => {
      renderer.root
        .findByProps({ 'aria-label': 'Открыть палетный лист PAL-ORD-77-001' })
        .props.onClick();
      await Promise.resolve();
    });

    expect(renderer.root.findAllByProps({ 'aria-label': 'Палетный лист' })).toHaveLength(1);
    expect(createObjectUrl).toHaveBeenCalledOnce();
  });

  it('обновляет uncertain палетный лист без повторной отправки задания на печать', async () => {
    vi.spyOn(warehouseApi, 'fetchWarehousePrinters').mockResolvedValue([
      {
        id: 'printer-a',
        code: 'TLP4-A',
        label: 'MERTECH TLP4 A',
        post: { id: 'post-a', code: 'WH-A', name: 'Склад A' },
        status: 'online',
        ready: true,
        unavailableReason: null,
      },
    ]);
    vi.spyOn(warehouseApi, 'fetchWarehousePalletPreview').mockResolvedValue(
      new Blob(['preview'], { type: 'image/png' }),
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pallet-preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const print = vi.spyOn(warehouseApi, 'printWarehousePalletList').mockResolvedValue({
      id: 'job-2',
      requestId: 'request-2',
      printerId: 'printer-a',
      status: 'submitted',
      gatewayCommandId: 'command-2',
      message: 'Задание отправлено',
    });
    const refresh = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseWorkbenchView
          workbench={{
            ...workbench,
            palletListDocuments: [{ ...historyDocument, printStatus: 'needs_admin' }],
          }}
          actions={actions}
          coverageDecisionTask={null}
          onWarehouseRefresh={refresh}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      renderer.root
        .findByProps({ 'aria-label': 'Открыть палетный лист PAL-ORD-77-001' })
        .props.onClick();
      await Promise.resolve();
    });
    const checkStatus = renderer.root
      .findAll((node) => node.type === 'button')
      .find((node) => nodeText(node) === 'Проверить статус');
    expect(checkStatus).toBeDefined();
    expect(checkStatus?.findByType('ix-icon').props.name).toBe('refresh');

    await act(async () => {
      checkStatus?.props.onClick();
      await Promise.resolve();
    });

    expect(refresh).toHaveBeenCalledOnce();
    expect(print).not.toHaveBeenCalled();
  });

  it('не монтирует live-панель печати без обязательного callback обновления статуса', async () => {
    vi.spyOn(warehouseApi, 'fetchWarehousePrinters').mockResolvedValue([
      {
        id: 'printer-a',
        code: 'TLP4-A',
        label: 'MERTECH TLP4 A',
        post: { id: 'post-a', code: 'WH-A', name: 'Склад A' },
        status: 'online',
        ready: true,
        unavailableReason: null,
      },
    ]);
    vi.spyOn(warehouseApi, 'fetchWarehousePalletPreview').mockResolvedValue(
      new Blob(['preview'], { type: 'image/png' }),
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pallet-preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseWorkbenchView
          workbench={{
            ...workbench,
            palletListDocuments: [{ ...historyDocument, printStatus: 'needs_admin' }],
          }}
          actions={actions}
          coverageDecisionTask={null}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      renderer.root
        .findByProps({ 'aria-label': 'Открыть палетный лист PAL-ORD-77-001' })
        .props.onClick();
      await Promise.resolve();
    });
    expect(renderer.root.findAllByProps({ 'aria-label': 'Палетный лист' })).toHaveLength(0);
    expect(nodeText(renderer.root)).not.toContain('Требуется администратор');
  });

  it('после uncertain перепечатки проверяет статус из диалога без второго print POST', async () => {
    vi.spyOn(warehouseApi, 'fetchWarehousePrinters').mockResolvedValue([
      {
        id: 'printer-a',
        code: 'TLP4-A',
        label: 'MERTECH TLP4 A',
        post: { id: 'post-a', code: 'WH-A', name: 'Склад A' },
        status: 'online',
        ready: true,
        unavailableReason: null,
      },
    ]);
    vi.spyOn(warehouseApi, 'fetchWarehousePalletPreview').mockResolvedValue(
      new Blob(['preview'], { type: 'image/png' }),
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pallet-preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const print = vi
      .spyOn(warehouseApi, 'printWarehousePalletList')
      .mockRejectedValue(
        new ApiError(
          409,
          'Принтер подтвердил задание, но итог требует проверки администратором.',
          'PALLET_PRINT_DELIVERY_UNKNOWN',
        ),
      );
    const refresh = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseWorkbenchView
          workbench={workbench}
          actions={actions}
          coverageDecisionTask={null}
          onWarehouseRefresh={refresh}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      renderer.root
        .findByProps({ 'aria-label': 'Открыть палетный лист PAL-ORD-77-001' })
        .props.onClick();
      await Promise.resolve();
    });
    act(() => {
      renderer.root
        .findAll((node) => node.type === 'button')
        .find((node) => nodeText(node) === 'Повторная печать')
        ?.props.onClick();
    });
    act(() => {
      renderer.root.findByType('textarea').props.onChange({
        target: { value: 'Этикетка повреждена' },
      });
    });
    await act(async () => {
      renderer.root
        .findAll((node) => node.type === 'button')
        .find((node) => nodeText(node) === 'Напечатать повторно')
        ?.props.onClick();
      await Promise.resolve();
    });
    const checkStatus = renderer.root
      .findAll((node) => node.type === 'button')
      .find(
        (node) =>
          node.props.className === 'action-recommended' && nodeText(node) === 'Проверить статус',
      );
    expect(checkStatus).toBeDefined();

    await act(async () => {
      checkStatus?.props.onClick();
      await Promise.resolve();
    });

    expect(print).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('uses a fresh requestId when refresh confirms the same submitted server status', async () => {
    vi.spyOn(warehouseApi, 'fetchWarehousePrinters').mockResolvedValue([
      {
        id: 'printer-a',
        code: 'TLP4-A',
        label: 'MERTECH TLP4 A',
        post: { id: 'post-a', code: 'WH-A', name: 'Склад A' },
        status: 'online',
        ready: true,
        unavailableReason: null,
      },
    ]);
    vi.spyOn(warehouseApi, 'fetchWarehousePalletPreview').mockResolvedValue(
      new Blob(['preview'], { type: 'image/png' }),
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pallet-preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const print = vi
      .spyOn(warehouseApi, 'printWarehousePalletList')
      .mockRejectedValueOnce(
        new ApiError(
          409,
          'Принтер подтвердил задание, но итог требует проверки администратором.',
          'PALLET_PRINT_DELIVERY_UNKNOWN',
        ),
      )
      .mockResolvedValueOnce({
        id: 'job-3',
        requestId: 'request-3',
        printerId: 'printer-a',
        status: 'submitted',
        gatewayCommandId: 'command-3',
        message: 'Задание отправлено',
      });
    const refresh = vi.fn();
    const view = (printStatus: PalletListDocument['printStatus']) => (
      <WarehouseWorkbenchView
        workbench={{
          ...workbench,
          palletListDocuments: [{ ...historyDocument, printStatus }],
        }}
        actions={actions}
        coverageDecisionTask={null}
        onWarehouseRefresh={refresh}
      />
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(view('submitted'));
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root
        .findByProps({ 'aria-label': 'Открыть палетный лист PAL-ORD-77-001' })
        .props.onClick();
      await Promise.resolve();
    });
    act(() => {
      renderer.root
        .findAll((node) => node.type === 'button')
        .find((node) => nodeText(node) === 'Повторная печать')
        ?.props.onClick();
    });
    act(() => {
      renderer.root.findByType('textarea').props.onChange({
        target: { value: 'Этикетка повреждена' },
      });
    });
    await act(async () => {
      renderer.root
        .findAll((node) => node.type === 'button')
        .find((node) => nodeText(node) === 'Напечатать повторно')
        ?.props.onClick();
      await Promise.resolve();
    });

    await act(async () => {
      renderer.update(view('submitted'));
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root
        .findAll((node) => node.type === 'button')
        .find((node) => nodeText(node) === 'Напечатать повторно')
        ?.props.onClick();
      await Promise.resolve();
    });

    expect(print).toHaveBeenCalledTimes(2);
    expect(print.mock.calls[1][1].requestId).not.toBe(print.mock.calls[0][1].requestId);
  });
});
