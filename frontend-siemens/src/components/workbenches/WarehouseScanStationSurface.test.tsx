import { Profiler, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { warehouseCoverageApi } from '../../api/warehouse';
import { warehouseWorkObjects } from '../../domain/fixtures/warehouse';
import type { WarehouseWorkbench, WorkObject } from '../../domain/types';
import { WarehouseScanStationSurface } from './WarehouseScanStationSurface';

const DELIVERY_OPERATION_ID = 'delivery-6235d3e3-98e9-417b-b708-41f2dfe448b0';

function deliveryOperation(): WorkObject {
  return {
    id: DELIVERY_OPERATION_ID,
    kind: 'warehouseJob',
    title: 'Выдача DEMO-001',
    statusLabel: 'Ожидает сканирования',
    nextOwner: 'Склад',
    severity: 'warning',
    facts: [],
    sections: [],
    actions: [
      {
        id: 'warehouse.delivery.close:delivery-task-1',
        label: 'Закрыть выдачу',
        level: 'disabled',
        enabled: false,
        disabledReason: 'Не все рулоны отсканированы',
      },
    ],
    problems: [],
    audit: [],
    filterTags: ['Выдача'],
    workbench: {
      type: 'warehouse',
      mode: 'delivery',
      prompt: 'Выдача DEMO-001',
      expected: 1,
      scanned: 0,
      missing: ['DEMO-001-roll-1'],
      excess: [],
      accepted: [],
      lastScan: '',
      scanSeverity: 'info',
      expectedRolls: [
        {
          id: 'DEMO-001-roll-1',
          sequenceNumber: 1,
          orderId: 'DEMO-001',
          customerAlias: 'Пилотный заказчик',
          status: 'Ждет скан',
          filmType: 'Готовый рулон',
          micron: '80 мкм',
          sizeMeters: '1700 мм',
          lengthMeters: '275 м',
          plannedNetKg: 42.3,
          tolerancePercent: 2,
          qrCode: 'QR-DEMO-001-roll-1',
          source: 'warehouse_reserve',
        },
      ],
    },
  };
}

function deliverySurface(operation = deliveryOperation()) {
  return (
    <WarehouseScanStationSurface
      objects={[operation]}
      activeSection="Выдача"
      selectedObjectId={operation.id}
      onSelectObject={vi.fn()}
      onClearSelection={vi.fn()}
      onWarehouseRefresh={vi.fn()}
      liveCoverageEnabled={false}
    />
  );
}

function renderedText(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : renderedText(child)))
    .join('');
}

function receivingOperation({
  id = 'intake-task-1',
  taskId = 'task-1',
  accepted = ['ROLL-1'],
  expected = Math.max(accepted.length, 1),
  taskClosed = false,
}: {
  id?: string;
  taskId?: string;
  accepted?: string[];
  expected?: number;
  taskClosed?: boolean;
} = {}): WorkObject {
  const operation = deliveryOperation();
  if (operation.workbench?.type !== 'warehouse') {
    throw new Error('Warehouse fixture is missing');
  }
  return {
    ...operation,
    id,
    title: 'Приемка A-1001',
    filterTags: ['Приемка'],
    workbench: {
      ...operation.workbench,
      mode: 'receiving',
      taskId,
      taskClosed,
      expected,
      scanned: accepted.length,
      accepted,
      missing: Array.from(
        { length: Math.max(0, expected - accepted.length) },
        (_, index) => `ROLL-${accepted.length + index + 1}`,
      ),
      activePallet: {
        id: 'pallet-1',
        palletCode: 'PAL-A-1001-001',
        orderId: 'order-1',
        orderNumber: 'A-1001',
        sequenceNo: 1,
        status: 'open',
        rollCount: accepted.length,
        openedAt: '2026-08-19T08:00:00.000Z',
        rows: accepted.map((rollCode, index) => ({
          rollCode,
          position: index + 1,
          acceptedAt: '2026-08-19T08:00:00.000Z',
          scannedByName: 'Кладовщик',
        })),
      },
    },
  };
}

function buttonWithText(renderer: TestRenderer.ReactTestRenderer, text: string) {
  const button = renderer.root
    .findAllByType('button')
    .find((candidate) => renderedText(candidate).trim() === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

describe('WarehouseScanStationSurface base state', () => {
  it('requires the live warehouse refresh callback used by pallet status checks', () => {
    expectTypeOf<
      ComponentProps<typeof WarehouseScanStationSurface>['onWarehouseRefresh']
    >().toEqualTypeOf<() => void>();
  });

  it('renders the scanner without exposing industrial-post configuration', () => {
    const html = renderToStaticMarkup(
      <WarehouseScanStationSurface
        objects={[]}
        activeSection="Приемка"
        selectedObjectId={null}
        onSelectObject={vi.fn()}
        onScanPayload={vi.fn(async () => true)}
        onClearSelection={vi.fn()}
        onWarehouseRefresh={vi.fn()}
      />,
    );

    expect(html).toContain('aria-label="Сканирование QR"');
    expect(html).not.toContain('Промышленный пост');
    expect(html).not.toContain('aria-label="Код промышленного поста склада"');
    expect(html).not.toContain('placeholder="POST-1"');
    expect(html).toContain('Выберите заказ или отсканируйте QR');
    expect(html).not.toContain('Сканируйте QR рулона (сканер вводит сам)');
  });

  it('submits layout-independent ASCII from a focused HID scanner field', async () => {
    const onScanPayload = vi.fn(async () => true);
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <WarehouseScanStationSurface
          objects={[]}
          activeSection="Приемка"
          selectedObjectId={null}
          onSelectObject={vi.fn()}
          onScanPayload={onScanPayload}
          onClearSelection={vi.fn()}
          onWarehouseRefresh={vi.fn()}
        />,
      );
    });

    const scannerInput = renderer.root.findByProps({ 'aria-label': 'Сканирование QR' });
    const preventDefault = vi.fn();
    const inputNode = { value: '' };
    for (const [code, key, shiftKey] of [
      ['KeyP', 'з', false],
      ['KeyR', 'к', false],
      ['KeyT', 'е', false],
      ['Minus', '_', true],
      ['KeyA', 'ф', false],
    ] as const) {
      act(() => {
        scannerInput.props.onKeyDown({
          code,
          key,
          shiftKey,
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          isComposing: false,
          currentTarget: inputNode,
          preventDefault,
        });
      });
    }

    const scannerForm = renderer.root.findByProps({ className: 'warehouse-scan-input-form' });
    await act(async () => {
      await scannerForm.props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(onScanPayload).toHaveBeenCalledWith('prt_a');
    expect(preventDefault).toHaveBeenCalledTimes(5);
  });

  it('suppresses the unsupported return action only for the live scanner path', () => {
    const object = warehouseWorkObjects.find((candidate) => candidate.id === 'WH-2606-044');
    if (!object) throw new Error('WH-2606-044 fixture is missing');
    const baseProps = {
      objects: [object],
      activeSection: 'Приемка',
      selectedObjectId: object.id,
      onSelectObject: vi.fn(),
      onClearSelection: vi.fn(),
      onWarehouseRefresh: vi.fn(),
    };

    const demo = renderToStaticMarkup(<WarehouseScanStationSurface {...baseProps} />);
    const live = renderToStaticMarkup(
      <WarehouseScanStationSurface {...baseProps} onScanPayload={vi.fn(async () => true)} />,
    );

    expect(demo).toContain('>Вернуть</button>');
    expect(demo).toContain('title="Сканирование недоступно без серверного обработчика."');
    expect(live).not.toContain('>Вернуть</button>');
  });

  it('renders roll width and length as separate visible production facts', () => {
    const base = warehouseWorkObjects.find((candidate) => candidate.id === 'WH-2606-044');
    if (!base || base.workbench?.type !== 'warehouse') {
      throw new Error('WH-2606-044 warehouse fixture is missing');
    }
    const firstRoll = base.workbench.expectedRolls?.[0];
    if (!firstRoll) throw new Error('WH-2606-044 roll fixture is missing');
    const object = {
      ...base,
      workbench: {
        ...base.workbench,
        expectedRolls: [
          { ...firstRoll, sizeMeters: '1700 мм', lengthMeters: '275 м' },
          ...(base.workbench.expectedRolls?.slice(1) ?? []),
        ],
      },
    };

    const html = renderToStaticMarkup(
      <WarehouseScanStationSurface
        objects={[object]}
        activeSection="Приемка"
        selectedObjectId={object.id}
        onSelectObject={vi.fn()}
        onClearSelection={vi.fn()}
        onWarehouseRefresh={vi.fn()}
      />,
    );

    expect(html).toContain('1700 мм · 275 м');
  });

  it('hydrates a decision-linked reserve task selected from the live issue queue', async () => {
    const taskId = 'reserve-task-real-id';
    const workbench: WarehouseWorkbench & { coverageDecisionTaskId: string } = {
      type: 'warehouse',
      mode: 'delivery',
      prompt: 'Проверьте физическое наличие рулонов',
      expected: 1,
      scanned: 0,
      missing: ['ROLL-001'],
      excess: [],
      accepted: [],
      lastScan: '—',
      scanSeverity: 'info',
      coverageDecisionTaskId: taskId,
      expectedRolls: [],
    };
    const object: WorkObject = {
      id: `delivery-${taskId}`,
      kind: 'warehouseJob',
      title: 'Проверка резерва A-1001',
      statusLabel: 'Ожидает проверки',
      nextOwner: 'Склад',
      severity: 'warning',
      facts: [],
      sections: [],
      actions: [],
      problems: [],
      audit: [],
      filterTags: ['Выдача'],
      workbench,
    };
    const readSpy = vi.spyOn(warehouseCoverageApi, 'readDecisionTask').mockResolvedValueOnce({
      taskId,
      status: 'open',
      generation: 2,
      stateVersion: 4,
      updatedAt: '2026-07-25T10:00:00.000Z',
      rows: [{ scanRowId: 'scan-row-real-id', rollCode: 'ROLL-001', scanStatus: 'expected' }],
    });
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseScanStationSurface
          objects={[object]}
          activeSection="Выдача"
          selectedObjectId={object.id}
          onSelectObject={vi.fn()}
          onWarehouseRefresh={vi.fn()}
          liveCoverageEnabled
        />,
      );
      await Promise.resolve();
    });

    expect(readSpy).toHaveBeenCalledWith(taskId);
    expect(renderer.root.findByProps({ 'data-coverage-task-id': taskId })).toBeDefined();
    readSpy.mockRestore();
  });

  it('shows a human delivery title without exposing the raw delivery task UUID', () => {
    const html = renderToStaticMarkup(deliverySurface());

    expect(html).toContain('Выдача DEMO-001');
    expect(html).not.toContain(DELIVERY_OPERATION_ID);
  });

  it('shows the delivery counterparty in the operation header with a safe fallback', () => {
    expect(renderToStaticMarkup(deliverySurface())).toContain('Контрагент: Пилотный заказчик');

    const operationWithoutCustomer = deliveryOperation();
    if (operationWithoutCustomer.workbench?.type !== 'warehouse') {
      throw new Error('Warehouse fixture is missing');
    }
    operationWithoutCustomer.workbench.expectedRolls =
      operationWithoutCustomer.workbench.expectedRolls?.map((roll) => ({
        ...roll,
        customerAlias: undefined,
      }));

    expect(renderToStaticMarkup(deliverySurface(operationWithoutCustomer))).toContain(
      'Контрагент: —',
    );
  });

  it('does not render an empty waiting-production summary for a warehouse-only delivery', () => {
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(deliverySurface());
    });

    expect(
      renderer.root.findAll(
        (node) =>
          node.props.className === 'warehouse-route-card is-production' &&
          renderedText(node).includes('Ждем'),
      ),
    ).toHaveLength(0);
  });

  it('renders exactly one close-delivery action', () => {
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(deliverySurface());
    });

    const closeButtons = renderer.root
      .findAllByType('button')
      .filter((button) => renderedText(button).includes('Закрыть выдачу'));

    expect(closeButtons).toHaveLength(1);
  });

  it('uses compact human-readable columns for the delivery operation queue', () => {
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(deliverySurface());
    });

    const columnLabels = renderer.root
      .findAllByType('th')
      .map((header) => renderedText(header).trim())
      .filter(Boolean);

    expect(columnLabels).toEqual(['Операция', 'Прогресс', 'Статус']);
  });

  it('shows full order progress instead of only currently handed-over scan rows', () => {
    const operation = deliveryOperation();
    if (operation.workbench?.type !== 'warehouse') {
      throw new Error('Warehouse fixture is missing');
    }
    const receivingOperation: WorkObject = {
      ...operation,
      title: 'Приемка A-4',
      filterTags: ['Приемка'],
      workbench: {
        ...operation.workbench,
        mode: 'receiving',
        plannedRollCount: 60,
      } as WarehouseWorkbench & { plannedRollCount: number },
    };

    const html = renderToStaticMarkup(
      <WarehouseScanStationSurface
        objects={[receivingOperation]}
        activeSection="Приемка"
        selectedObjectId={receivingOperation.id}
        onSelectObject={vi.fn()}
        onClearSelection={vi.fn()}
        onWarehouseRefresh={vi.fn()}
      />,
    );

    expect(html).toContain('<strong>0/60</strong>');
    expect(html).toContain('60 осталось');
    expect(html).not.toContain('<strong>0/1</strong>');
  });

  it('keeps a one-roll delivery compact without placeholder facts or pagination', () => {
    const operation = deliveryOperation();
    if (operation.workbench?.type !== 'warehouse' || !operation.workbench.expectedRolls?.[0]) {
      throw new Error('Delivery fixture is missing');
    }
    operation.workbench.expectedRolls[0] = {
      ...operation.workbench.expectedRolls[0],
      filmType: 'Готовый рулон',
      micron: '—',
      sizeMeters: '—',
      plannedNetKg: 0,
    };
    const html = renderToStaticMarkup(deliverySurface(operation));

    expect(html).toContain('Рулоны к выдаче');
    expect(html).not.toContain('Готовый рулон');
    expect(html).not.toContain('0 кг');
    expect(html).not.toContain('1-1 из 1');
    expect(html).not.toContain('Стр. 1/1');
  });
});

describe('WarehouseScanStationSurface pallet formation mode', () => {
  it('only offers the mode for the selected receiving task', () => {
    const operation = receivingOperation();
    const html = renderToStaticMarkup(
      <WarehouseScanStationSurface
        objects={[operation]}
        activeSection="Приемка"
        selectedObjectId={null}
        onSelectObject={vi.fn()}
        onScanPayload={vi.fn(async () => true)}
        onPalletScanPayload={vi.fn(async () => true)}
        onWarehouseRefresh={vi.fn()}
      />,
    );

    expect(html).not.toContain('Начать формирование палеты');
  });

  it('requires at least one accepted roll before the mode can start', () => {
    const operation = receivingOperation({ accepted: [] });
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <WarehouseScanStationSurface
          objects={[operation]}
          activeSection="Приемка"
          selectedObjectId={operation.id}
          onSelectObject={vi.fn()}
          onScanPayload={vi.fn(async () => true)}
          onPalletScanPayload={vi.fn(async () => true)}
          onWarehouseRefresh={vi.fn()}
        />,
      );
    });

    const button = buttonWithText(renderer, 'Начать формирование палеты');
    expect(button.props.disabled).toBe(true);
    expect(button.props.title).toBe('Сначала примите хотя бы один рулон.');
    expect(renderedText(renderer.root)).toContain('Сначала примите хотя бы один рулон.');
  });

  it('does not offer the mode for a closed receiving task', () => {
    const operation = receivingOperation({ taskClosed: true });
    const html = renderToStaticMarkup(
      <WarehouseScanStationSurface
        objects={[operation]}
        activeSection="Приемка"
        selectedObjectId={operation.id}
        onSelectObject={vi.fn()}
        onScanPayload={vi.fn(async () => true)}
        onPalletScanPayload={vi.fn(async () => true)}
        onWarehouseRefresh={vi.fn()}
      />,
    );

    expect(html).not.toContain('Начать формирование палеты');
  });

  it('routes scans to the pallet task and returns explicitly to normal receiving', async () => {
    const operation = receivingOperation();
    const onScanPayload = vi.fn(async () => true);
    const onPalletScanPayload = vi.fn(async () => true);
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <WarehouseScanStationSurface
          objects={[operation]}
          activeSection="Приемка"
          selectedObjectId={operation.id}
          onSelectObject={vi.fn()}
          onScanPayload={onScanPayload}
          onPalletScanPayload={onPalletScanPayload}
          onWarehouseRefresh={vi.fn()}
        />,
      );
    });

    act(() => buttonWithText(renderer, 'Начать формирование палеты').props.onClick());
    expect(renderedText(renderer.root)).toContain('Повторный скан не удаляет рулон');
    const palletInput = renderer.root.findByProps({ 'aria-label': 'QR в палетный лист' });
    act(() => palletInput.props.onChange({ target: { value: 'prt_physical' } }));
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(onPalletScanPayload).toHaveBeenCalledWith('task-1', 'prt_physical');
    expect(onScanPayload).not.toHaveBeenCalled();

    act(() => buttonWithText(renderer, 'Вернуться к приёмке').props.onClick());
    const receivingInput = renderer.root.findByProps({ 'aria-label': 'Сканирование QR' });
    act(() => receivingInput.props.onChange({ target: { value: 'prt_receiving' } }));
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(onScanPayload).toHaveBeenCalledWith('prt_receiving');
  });

  it('clears the field immediately and buffers another pallet scan while the first is pending', async () => {
    const operation = receivingOperation();
    let resolveFirst!: (value: boolean) => void;
    const onPalletScanPayload = vi
      .fn<(taskId: string, payload: string) => Promise<boolean>>()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(true);
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <WarehouseScanStationSurface
          objects={[operation]}
          activeSection="Приемка"
          selectedObjectId={operation.id}
          onSelectObject={vi.fn()}
          onScanPayload={vi.fn(async () => true)}
          onPalletScanPayload={onPalletScanPayload}
          onWarehouseRefresh={vi.fn()}
        />,
      );
    });
    act(() => buttonWithText(renderer, 'Начать формирование палеты').props.onClick());

    let first!: Promise<void>;
    act(() => {
      renderer.root
        .findByProps({ 'aria-label': 'QR в палетный лист' })
        .props.onChange({ target: { value: 'prt_first' } });
    });
    act(() => {
      first = renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });
    const readyForNext = renderer.root.findByProps({ 'aria-label': 'QR в палетный лист' });
    expect(readyForNext.props.disabled).toBe(false);
    expect(readyForNext.props.value).toBe('');

    let second!: Promise<void>;
    act(() => {
      readyForNext.props.onChange({ target: { value: 'prt_second' } });
    });
    act(() => {
      second = renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });
    expect(renderer.root.findByProps({ 'aria-label': 'QR в палетный лист' }).props.value).toBe('');
    expect(onPalletScanPayload).toHaveBeenCalledTimes(1);

    resolveFirst(true);
    await act(async () => {
      await Promise.all([first, second]);
    });
    expect(onPalletScanPayload.mock.calls.map(([, payload]) => payload)).toEqual([
      'prt_first',
      'prt_second',
    ]);
  });

  it('buffers a physical 68-character QR without rerendering the warehouse table', async () => {
    const operation = receivingOperation();
    const payload = 'a'.repeat(68);
    const onPalletScanPayload = vi.fn(async () => true);
    const inputNode = { value: '', focus: vi.fn() };
    let commits = 0;
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <Profiler id="warehouse-hid" onRender={() => (commits += 1)}>
          <WarehouseScanStationSurface
            objects={[operation]}
            activeSection="Приемка"
            selectedObjectId={operation.id}
            onSelectObject={vi.fn()}
            onScanPayload={vi.fn(async () => true)}
            onPalletScanPayload={onPalletScanPayload}
            onWarehouseRefresh={vi.fn()}
          />
        </Profiler>,
        { createNodeMock: (element) => (element.type === 'input' ? inputNode : null) },
      );
    });
    act(() => buttonWithText(renderer, 'Начать формирование палеты').props.onClick());
    commits = 0;

    const input = renderer.root.findByProps({ 'aria-label': 'QR в палетный лист' });
    for (let index = 0; index < payload.length; index += 1) {
      act(() =>
        input.props.onKeyDown({
          code: 'KeyA',
          key: 'ф',
          shiftKey: false,
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          isComposing: false,
          currentTarget: inputNode,
          preventDefault: vi.fn(),
        }),
      );
    }

    expect(inputNode.value).toBe(payload);
    expect(commits).toBe(0);
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });
    expect(onPalletScanPayload).toHaveBeenCalledWith('task-1', payload);
    expect(inputNode.value).toBe('');
  });

  it('allows printing the current 2-roll pallet while 18 order rolls remain', () => {
    const operation = receivingOperation({ accepted: ['ROLL-1', 'ROLL-2'], expected: 20 });
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <WarehouseScanStationSurface
          objects={[operation]}
          activeSection="Приемка"
          selectedObjectId={operation.id}
          onSelectObject={vi.fn()}
          onScanPayload={vi.fn(async () => true)}
          onPalletScanPayload={vi.fn(async () => true)}
          onWarehouseRefresh={vi.fn()}
        />,
      );
    });

    act(() => buttonWithText(renderer, 'Начать формирование палеты').props.onClick());
    const print = renderer.root.findByProps({
      'aria-label': 'Распечатать текущий палетный лист',
    });

    expect(renderedText(renderer.root)).toContain('2/20');
    expect(renderedText(renderer.root)).toContain('Можно печатать до завершения приёмки');
    expect(print.props.disabled).toBe(false);
    act(() => print.props.onClick());
    expect(renderedText(renderer.root)).toContain('Рулонов2');
  });

  it('leaves pallet mode when the selected task or section changes', () => {
    const first = receivingOperation();
    const second = receivingOperation({ id: 'intake-task-2', taskId: 'task-2' });
    const props = {
      objects: [first, second],
      activeSection: 'Приемка',
      selectedObjectId: first.id,
      onSelectObject: vi.fn(),
      onScanPayload: vi.fn(async () => true),
      onPalletScanPayload: vi.fn(async () => true),
      onWarehouseRefresh: vi.fn(),
    };
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(<WarehouseScanStationSurface {...props} />);
    });
    act(() => buttonWithText(renderer, 'Начать формирование палеты').props.onClick());
    act(() => {
      renderer.update(<WarehouseScanStationSurface {...props} selectedObjectId={second.id} />);
    });
    expect(renderer.root.findByProps({ 'aria-label': 'Сканирование QR' })).toBeDefined();

    act(() => buttonWithText(renderer, 'Начать формирование палеты').props.onClick());
    act(() => {
      renderer.update(
        <WarehouseScanStationSurface {...props} activeSection="Выдача" selectedObjectId={null} />,
      );
    });
    expect(renderer.root.findByProps({ 'aria-label': 'Сканирование QR' })).toBeDefined();
  });

  it.each([
    ['success', async () => true, ''],
    ['safe failure', async () => false, 'prt_retry'],
    ['rejection', async () => Promise.reject(new Error('offline')), 'prt_retry'],
  ])('keeps mode and restores scanner focus after %s', async (_, submit, expectedPayload) => {
    const operation = receivingOperation();
    const focus = vi.fn();
    vi.stubGlobal('window', {
      matchMedia: () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    });
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <WarehouseScanStationSurface
          objects={[operation]}
          activeSection="Приемка"
          selectedObjectId={operation.id}
          onSelectObject={vi.fn()}
          onScanPayload={vi.fn(async () => true)}
          onPalletScanPayload={vi.fn(submit)}
          onWarehouseRefresh={vi.fn()}
        />,
        { createNodeMock: (element) => (element.type === 'input' ? { focus } : null) },
      );
    });
    act(() => buttonWithText(renderer, 'Начать формирование палеты').props.onClick());
    const focusCallsBeforeSubmit = focus.mock.calls.length;
    const input = renderer.root.findByProps({ 'aria-label': 'QR в палетный лист' });
    act(() => input.props.onChange({ target: { value: 'prt_retry' } }));
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(renderer.root.findByProps({ 'aria-label': 'QR в палетный лист' }).props.value).toBe(
      expectedPayload,
    );
    expect(buttonWithText(renderer, 'Вернуться к приёмке')).toBeDefined();
    expect(focus.mock.calls.length).toBeGreaterThan(focusCallsBeforeSubmit);
    vi.unstubAllGlobals();
  });
});
