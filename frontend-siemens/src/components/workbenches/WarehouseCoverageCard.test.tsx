import { useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { financeWorkObjects } from '../../domain/fixtures/finance';
import type {
  FinanceWarehouseCoverageRollView,
  FinanceWarehouseCoverageView,
  WarehouseCoverageReasonCode,
} from '../../domain/warehouseCoverage';
import type { Fact, WorkObject } from '../../domain/types';
import { FinanceWorkbench } from './FinanceWorkbench';
import { WarehouseCoverageCard } from './WarehouseCoverageCard';

const coverageApiMocks = vi.hoisted(() => ({
  read: vi.fn(),
  refresh: vi.fn(),
  decide: vi.fn(),
  requestRecheck: vi.fn(),
}));

vi.mock('../../api/finance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/finance')>();
  return {
    ...actual,
    financeCoverageApi: coverageApiMocks,
  };
});

function coverageRoll(
  rollCode: string,
  positionId: string,
  overrides: Partial<FinanceWarehouseCoverageRollView> = {},
): FinanceWarehouseCoverageRollView {
  return {
    rollCode,
    positionId,
    source: 'platform',
    locationLabel: 'Свободный резерв',
    availability: 'available',
    batchCode: 'ПАРТИЯ-08-06',
    receivedAt: '2026-08-06T01:00:00.000Z',
    grossKg: 41.9,
    spoolKg: 0.7,
    requested: {
      filmType: 'Рукав',
      actualThicknessMicron: 80,
      accountingThicknessMicron: 78,
      widthMm: 1_200,
      plannedLengthM: 800,
      netKg: 41,
      spoolType: 'Тонкая',
      birka: 'ГОСТ',
      materialLabel: 'ПВД первичный',
    },
    matched: {
      filmType: 'рукав',
      actualThicknessMicron: 80,
      accountingThicknessMicron: 78,
      widthMm: 1_200,
      plannedLengthM: 800,
      netKg: 41.2,
      spoolType: 'Тонкая',
      birka: 'гост',
      materialLabel: 'ПВД первичный',
    },
    ...overrides,
  };
}

function coverage(
  overrides: Partial<FinanceWarehouseCoverageView> = {},
): FinanceWarehouseCoverageView {
  return {
    workflowVersion: 2,
    state: 'awaiting_finance',
    stateVersion: 4,
    generation: 3,
    availability: 'verified_full',
    reasonCodes: ['full_cover_available'],
    nextOwner: 'finance',
    availableActions: ['use_warehouse', 'produce_all', 'request_recheck'],
    requiredRollCount: 2,
    matchedRollCount: 2,
    uncertainRollCount: 0,
    calculatedAt: '2026-07-25T08:00:00.000Z',
    stale: false,
    financeRolls: [coverageRoll('ROLL-001', 'position-1'), coverageRoll('ROLL-002', 'position-2')],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  const found = root.findAllByType('button').find((item) => nodeText(item) === label);
  if (!found) throw new Error(`Button "${label}" was not found`);
  return found;
}

function FactList({ facts }: { facts: Fact[] }) {
  return <div>{facts.map((fact) => `${fact.label}: ${fact.value}`).join(' · ')}</div>;
}

function factValue(object: WorkObject, label: string) {
  return object.facts.find((fact) => fact.label === label)?.value;
}

describe('WarehouseCoverageCard', () => {
  beforeEach(() => {
    coverageApiMocks.read.mockReset();
    coverageApiMocks.refresh.mockReset();
    coverageApiMocks.decide.mockReset();
    coverageApiMocks.requestRecheck.mockReset();
  });

  it('renders the exact verified rolls and only the actions allowed by the server', () => {
    const markup = renderToStaticMarkup(
      <WarehouseCoverageCard
        financeOrderId="finance-order-1"
        coverage={coverage({ availableActions: ['use_warehouse', 'request_recheck'] })}
        busyAction={null}
        onCoverageChanged={vi.fn()}
      />,
    );

    expect(markup).toContain('Складское покрытие');
    expect(markup).toContain('Подтверждено 2 из 2 рулонов');
    expect(markup.match(/data-coverage-roll=/g)).toHaveLength(2);
    expect(markup).toContain('ROLL-001');
    expect(markup).toContain('ROLL-002');
    expect(markup).toContain('Запрошено');
    expect(markup).toContain('Найдено');
    expect(markup).toContain('1 200 мм × 800 м');
    expect(markup).toContain('Нетто 41,2 кг');
    expect(markup).toContain('Брутто 41,9 кг');
    expect(markup).toContain('Шпуля 0,7 кг');
    expect(markup).toContain('ПВД первичный');
    expect(markup).toContain('ПАРТИЯ-08-06');
    expect(markup).toContain('Свободный резерв');
    expect(markup).toContain('Использовать рулоны со склада');
    expect(markup).toContain('Отправить на перепроверку склада');
    expect(markup).not.toContain('Произвести весь заказ');
  });

  it('renders the terminal production message without inventing finance actions', () => {
    const markup = renderToStaticMarkup(
      <WarehouseCoverageCard
        financeOrderId="finance-order-1"
        coverage={coverage({
          state: 'production_required',
          availability: 'unavailable',
          reasonCodes: ['no_compatible_rolls'],
          nextOwner: 'system',
          availableActions: [],
          matchedRollCount: 0,
          financeRolls: [],
        })}
        busyAction={null}
        onCoverageChanged={vi.fn()}
      />,
    );

    expect(markup).toContain('Заказ полностью направлен в производство');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('data-coverage-roll');
  });

  it('fails closed for future reason codes and unsupported policies', () => {
    const markup = renderToStaticMarkup(
      <WarehouseCoverageCard
        financeOrderId="finance-order-1"
        coverage={coverage({
          state: 'unknown',
          availability: 'unknown',
          reasonCodes: [
            'future_reason' as WarehouseCoverageReasonCode,
            'unsupported_policy_version',
          ],
          availableActions: [],
          financeRolls: [],
        })}
        busyAction={null}
        onCoverageChanged={vi.fn()}
      />,
    );

    expect(markup).toContain('Требуется безопасная проверка данных');
    expect(markup).not.toContain('Отправить на перепроверку склада');
    expect(markup).not.toContain('<button');
  });

  it('serializes mutually exclusive decisions and keeps the prior projection until confirmation', async () => {
    const pending = deferred<FinanceWarehouseCoverageView>();
    coverageApiMocks.decide.mockReturnValue(pending.promise);
    const onCoverageChanged = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <WarehouseCoverageCard
          financeOrderId="finance-order-1"
          coverage={coverage()}
          busyAction={null}
          onCoverageChanged={onCoverageChanged}
        />,
      );
    });

    const useWarehouse = button(renderer.root, 'Использовать рулоны со склада');
    const produceAll = button(renderer.root, 'Произвести весь заказ');
    act(() => {
      useWarehouse.props.onClick();
      produceAll.props.onClick();
    });

    expect(coverageApiMocks.decide).toHaveBeenCalledTimes(1);
    expect(coverageApiMocks.decide).toHaveBeenCalledWith(
      'finance-order-1',
      expect.objectContaining({
        expectedGeneration: 3,
        expectedStateVersion: 4,
        decision: 'use_warehouse',
        clientRequestId: expect.any(String),
      }),
    );
    expect(onCoverageChanged).not.toHaveBeenCalled();
    expect(button(renderer.root, 'Использовать рулоны со склада').props.disabled).toBe(true);
    expect(button(renderer.root, 'Произвести весь заказ').props.disabled).toBe(true);

    await act(async () => {
      pending.resolve(
        coverage({
          state: 'warehouse_reserved',
          nextOwner: 'warehouse',
          availableActions: [],
        }),
      );
      await pending.promise;
    });

    expect(onCoverageChanged).toHaveBeenCalledTimes(1);
  });

  it('removes produce-all actions only after the confirmed server projection arrives', async () => {
    const pending = deferred<FinanceWarehouseCoverageView>();
    coverageApiMocks.decide.mockReturnValue(pending.promise);
    const initial = coverage();

    function Harness() {
      const [current, setCurrent] = useState(initial);
      return (
        <WarehouseCoverageCard
          financeOrderId="finance-order-1"
          coverage={current}
          busyAction={null}
          onCoverageChanged={setCurrent}
        />
      );
    }

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<Harness />);
    });
    act(() => {
      button(renderer.root, 'Произвести весь заказ').props.onClick();
    });

    expect(button(renderer.root, 'Произвести весь заказ').props.disabled).toBe(true);
    expect(renderer.root.findAllByProps({ role: 'status' })).not.toHaveLength(0);

    await act(async () => {
      pending.resolve(
        coverage({
          state: 'production_required',
          availability: 'unavailable',
          reasonCodes: ['no_compatible_rolls'],
          nextOwner: 'system',
          availableActions: [],
          matchedRollCount: 0,
          financeRolls: [],
        }),
      );
      await pending.promise;
    });

    expect(renderer.root.findAllByType('button')).toHaveLength(0);
    expect(nodeText(renderer.root)).toContain('Заказ полностью направлен в производство');
  });

  it('retains the current projection and exposes a safe retry message after an error', async () => {
    coverageApiMocks.decide.mockRejectedValue(new TypeError('network detail'));
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <WarehouseCoverageCard
          financeOrderId="finance-order-1"
          coverage={coverage()}
          busyAction={null}
          onCoverageChanged={vi.fn()}
        />,
      );
    });

    await act(async () => {
      button(renderer.root, 'Использовать рулоны со склада').props.onClick();
      await Promise.resolve();
    });

    expect(nodeText(renderer.root)).toContain('ROLL-001');
    expect(nodeText(renderer.root)).toContain('Не удалось обновить складское покрытие');
    expect(nodeText(renderer.root)).not.toContain('network detail');
    expect(renderer.root.findAllByProps({ role: 'alert' })).toHaveLength(1);
  });

  it('submits a validated recheck reason against the current generation', async () => {
    coverageApiMocks.requestRecheck.mockResolvedValue({
      ...coverage({
        state: 'recheck_requested',
        nextOwner: 'warehouse',
        availableActions: [],
      }),
      caseId: 'coverage-case-1',
    });
    const onCoverageChanged = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <WarehouseCoverageCard
          financeOrderId="finance-order-1"
          coverage={coverage()}
          busyAction={null}
          onCoverageChanged={onCoverageChanged}
        />,
      );
    });
    act(() => {
      button(renderer.root, 'Отправить на перепроверку склада').props.onClick();
    });

    const textarea = renderer.root.findByType('textarea');
    act(() => {
      textarea.props.onChange({ target: { value: 'Перепроверьте остаток после инвентаризации' } });
    });
    await act(async () => {
      button(renderer.root, 'Подтвердить перепроверку').props.onClick();
      await Promise.resolve();
    });

    expect(coverageApiMocks.requestRecheck).toHaveBeenCalledWith(
      'finance-order-1',
      expect.objectContaining({
        expectedGeneration: 3,
        expectedStateVersion: 4,
        reason: 'Перепроверьте остаток после инвентаризации',
        clientRequestId: expect.any(String),
      }),
    );
    expect(onCoverageChanged).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'recheck_requested' }),
    );
  });

  it('automatically refreshes one stale generation and does not loop after confirmation', async () => {
    const fresh = coverage({
      stateVersion: 5,
      generation: 4,
      stale: false,
      availableActions: ['use_warehouse', 'produce_all', 'request_recheck'],
    });
    coverageApiMocks.refresh.mockResolvedValue(fresh);

    function Harness() {
      const [current, setCurrent] = useState(
        coverage({
          state: 'stale',
          stale: true,
          reasonCodes: ['inventory_changed'],
          availableActions: ['refresh'],
        }),
      );
      return (
        <WarehouseCoverageCard
          financeOrderId="finance-order-1"
          coverage={current}
          busyAction={null}
          onCoverageChanged={setCurrent}
        />
      );
    }

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Harness />);
      await Promise.resolve();
    });

    expect(coverageApiMocks.refresh).toHaveBeenCalledTimes(1);
    expect(coverageApiMocks.refresh).toHaveBeenCalledWith(
      'finance-order-1',
      expect.objectContaining({
        expectedGeneration: 3,
        expectedStateVersion: 4,
        clientRequestId: expect.any(String),
      }),
    );
    expect(nodeText(renderer.root)).toContain('Использовать рулоны со склада');

    await act(async () => {
      renderer.update(<Harness />);
      await Promise.resolve();
    });
    expect(coverageApiMocks.refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps an amended order visible and refreshes its invalidated specification', async () => {
    coverageApiMocks.refresh.mockResolvedValue(
      coverage({
        state: 'production_required',
        stateVersion: 6,
        generation: 4,
        availability: 'unavailable',
        reasonCodes: ['no_compatible_rolls'],
        nextOwner: 'system',
        availableActions: [],
        matchedRollCount: 0,
        stale: false,
        financeRolls: [],
      }),
    );
    const onCoverageChanged = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseCoverageCard
          financeOrderId="finance-order-amended"
          coverage={coverage({
            state: 'order_spec_changed',
            stateVersion: 5,
            stale: true,
            nextOwner: 'system',
            availableActions: ['refresh'],
          })}
          busyAction={null}
          onCoverageChanged={onCoverageChanged}
        />,
      );
      await Promise.resolve();
    });

    expect(nodeText(renderer.root)).toContain('Параметры заказа изменились — обновляем расчёт');
    expect(coverageApiMocks.refresh).toHaveBeenCalledWith(
      'finance-order-amended',
      expect.objectContaining({
        expectedGeneration: 3,
        expectedStateVersion: 5,
        clientRequestId: expect.any(String),
      }),
    );
    expect(onCoverageChanged).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'production_required', generation: 4 }),
    );
  });
});

describe('FinanceWorkbench warehouse coverage integration', () => {
  beforeEach(() => {
    coverageApiMocks.read.mockReset();
    coverageApiMocks.refresh.mockReset();
    coverageApiMocks.decide.mockReset();
    coverageApiMocks.requestRecheck.mockReset();
  });

  it('refreshes external warehouse results without remounting the decision form', async () => {
    const pending = deferred<FinanceWarehouseCoverageView>();
    coverageApiMocks.read
      .mockResolvedValueOnce(coverage({ state: 'recheck_requested' }))
      .mockReturnValueOnce(pending.promise);
    const object = { ...financeWorkObjects[0], warehouseCoverageWorkflowVersion: 2 as const };
    const view = (coverageRefreshGeneration: number) => (
      <FinanceWorkbench
        object={object}
        factValue={factValue}
        FactList={FactList}
        coverageRefreshGeneration={coverageRefreshGeneration}
      />
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(view(0));
    });
    const card = renderer.root.findByType(WarehouseCoverageCard);
    await act(async () => {
      renderer.update(view(1));
    });
    expect(coverageApiMocks.read).toHaveBeenCalledTimes(2);
    expect(renderer.root.findByType(WarehouseCoverageCard)).toBe(card);
    await act(async () => {
      pending.resolve(coverage({ stateVersion: 8, state: 'awaiting_finance' }));
    });
    expect(renderer.root.findByType(WarehouseCoverageCard).props.coverage.state).toBe(
      'awaiting_finance',
    );
    act(() => renderer.unmount());
  });

  it('does not overwrite a successful reservation with an older background read', async () => {
    const pending = deferred<FinanceWarehouseCoverageView>();
    coverageApiMocks.read
      .mockResolvedValueOnce(coverage({ stateVersion: 5 }))
      .mockReturnValueOnce(pending.promise);
    coverageApiMocks.decide.mockResolvedValue(
      coverage({ state: 'warehouse_reserved', stateVersion: 6, availableActions: [] }),
    );
    const object = { ...financeWorkObjects[0], warehouseCoverageWorkflowVersion: 2 as const };
    const view = (coverageRefreshGeneration: number) => (
      <FinanceWorkbench
        object={object}
        factValue={factValue}
        FactList={FactList}
        coverageRefreshGeneration={coverageRefreshGeneration}
      />
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(view(0));
    });
    await act(async () => {
      renderer.update(view(1));
    });
    await act(async () => {
      button(renderer.root, 'Использовать рулоны со склада').props.onClick();
    });
    await act(async () => {
      pending.resolve(coverage({ stateVersion: 5 }));
    });
    expect(nodeText(renderer.root)).toContain('Рулоны со склада зарезервированы');
    act(() => renderer.unmount());
  });

  it('offers verified stock in finance detail and preserves the reservation result', async () => {
    const object = {
      ...financeWorkObjects[0],
      id: 'finance-selected-1',
      warehouseCoverageWorkflowVersion: 2 as const,
    };
    coverageApiMocks.read.mockResolvedValue(coverage());
    coverageApiMocks.decide.mockResolvedValue(
      coverage({ state: 'warehouse_reserved', nextOwner: 'warehouse', availableActions: [] }),
    );
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <FinanceWorkbench
          object={object}
          factValue={factValue}
          FactList={FactList}
          activeSection="Рассрочка"
        />,
      );
      await Promise.resolve();
    });

    expect(coverageApiMocks.read).toHaveBeenCalledWith(object.id);
    expect(nodeText(renderer.root)).toContain('Подтверждено 2 из 2 рулонов');
    expect(nodeText(renderer.root)).toContain('График платежей');

    await act(async () => {
      button(renderer.root, 'Использовать рулоны со склада').props.onClick();
    });
    expect(coverageApiMocks.decide).toHaveBeenCalledWith(
      object.id,
      expect.objectContaining({ decision: 'use_warehouse' }),
    );
    expect(nodeText(renderer.root)).toContain('Рулоны со склада зарезервированы');
    act(() => renderer.unmount());
  });

  it.each([
    { version: 1 as const, registry: false },
    { version: 2 as const, registry: true },
  ])('does not fetch coverage for $version / registry=$registry', async ({ version, registry }) => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <FinanceWorkbench
          object={{ ...financeWorkObjects[0], warehouseCoverageWorkflowVersion: version }}
          factValue={factValue}
          FactList={FactList}
          isRegistryPage={registry}
        />,
      );
    });
    expect(coverageApiMocks.read).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType(WarehouseCoverageCard)).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('keeps a late response from a previous selection out of the current order', async () => {
    const firstRead = deferred<FinanceWarehouseCoverageView>();
    coverageApiMocks.read
      .mockReturnValueOnce(firstRead.promise)
      .mockResolvedValueOnce(coverage({ matchedRollCount: 1 }))
      .mockResolvedValueOnce(coverage({ matchedRollCount: 2 }));
    const view = (id: string) => (
      <FinanceWorkbench
        object={{ ...financeWorkObjects[0], id, warehouseCoverageWorkflowVersion: 2 }}
        factValue={factValue}
        FactList={FactList}
      />
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(view('order-a'));
    });
    await act(async () => {
      renderer.update(view('order-b'));
    });
    await act(async () => {
      renderer.update(view('order-a'));
    });
    await act(async () => {
      firstRead.resolve(coverage({ matchedRollCount: 0 }));
    });
    expect(nodeText(renderer.root)).toContain('Подтверждено 2 из 2 рулонов');
    expect(coverageApiMocks.read.mock.calls.map(([id]) => id)).toEqual([
      'order-a',
      'order-b',
      'order-a',
    ]);
    act(() => renderer.unmount());
  });

  it('shows a failed coverage read and retries without hiding the financial detail', async () => {
    coverageApiMocks.read
      .mockRejectedValueOnce(new Error('Temporary API failure'))
      .mockResolvedValueOnce(coverage());
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <FinanceWorkbench
          object={{ ...financeWorkObjects[0], warehouseCoverageWorkflowVersion: 2 }}
          factValue={factValue}
          FactList={FactList}
        />,
      );
    });
    expect(nodeText(renderer.root)).toContain('Не удалось загрузить складское покрытие');
    expect(nodeText(renderer.root)).toContain('График платежей');
    await act(async () => {
      button(renderer.root, 'Повторить загрузку').props.onClick();
    });
    expect(coverageApiMocks.read).toHaveBeenCalledTimes(2);
    expect(nodeText(renderer.root)).toContain('Подтверждено 2 из 2 рулонов');
    act(() => renderer.unmount());
  });
});
