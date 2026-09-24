import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { warehouseCoverageApi } from '../../api/warehouse';
import type {
  WarehouseCoverageDecisionTaskView,
  WarehouseCoverageRecheckItem,
  WarehouseCoverageView,
  WarehouseCoverageWithCaseView,
} from '../../domain/warehouseCoverage';
import type {
  ActionDescriptor,
  WarehouseCoverFreeRoll,
  WarehouseCoverTask,
  WarehouseCoverTaskPosition,
  WarehouseWorkbench,
} from '../../domain/types';
import {
  compatibleWarehouseCoverRolls,
  executeWarehouseCoverProposal,
  nextWarehouseCoverPositionId,
  reconcileWarehouseCoverTaskSelection,
  warehouseCoverObjectId,
  warehouseCoverPrimaryAction,
  WarehouseCoverTasksPanel,
  WarehouseCoverTasksPanelView,
} from './WarehouseCoverTasksPanel';
import { warehouseCoverageDecisionTaskId, WarehouseWorkbenchView } from './warehouseWorkbench';

const position: WarehouseCoverTaskPosition = {
  id: 'position-1',
  rollCount: 3,
  filmType: 'Рукав',
  actualThickness: '80 мкм',
  accountingThickness: '78 мкм',
  rawMaterialId: 'rm-pvd',
  spoolType: 'Шпуля 76 мм',
  birka: 'ГОСТ',
  plannedWeightKg: 41.2,
  warehouseCoverStatus: 'not_checked',
};

const task: WarehouseCoverTask = {
  caseId: 'case-1',
  orderId: 'order-1',
  orderNumber: 'A-1001',
  customerAlias: 'Клиент 12',
  state: 'open',
  requestedAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-15T08:05:00.000Z',
  positions: [position],
};

function roll(id: string, overrides: Partial<WarehouseCoverFreeRoll> = {}): WarehouseCoverFreeRoll {
  return {
    id,
    rollCode: `STK-${id}`,
    warehouseStatus: 'received',
    facts: {
      filmType: 'рукав',
      actualThickness: '80 мкм',
      birka: 'Гост',
      spoolType: '76 мм',
      plannedWeightKg: 41.2,
    },
    ...overrides,
  };
}

function v2Recheck(
  caseId = 'case-real-id',
  membershipId = 'membership-real-id',
  rollCode = 'ROLL-001',
): WarehouseCoverageRecheckItem {
  return {
    caseId,
    coverageOrigin: 'finance_request',
    caseVersion: 2,
    stateVersion: 5,
    generation: 3,
    reasonCodes: ['roll_ownership_unverified'],
    members: [
      {
        membershipId,
        rollCode,
        sourceKind: 'uncertain_candidate',
        reasonCodes: ['roll_ownership_unverified'],
        currentFactVersion: 4,
        ownerVerified: false,
        currentSpec: {
          filmType: 'пленка полиэтиленовая',
          actualThickness: '80 мкм',
          accountingThickness: '80 мкм',
          widthMm: 1000,
          plannedLengthM: 100,
          birka: 'полотно',
          spoolType: '76 мм',
          actualWeightKg: '275',
          plannedWeightKg: '275',
          recipeId: null,
          recipeVersion: null,
          recipeDefinitionId: null,
          recipeDefinitionVersionId: null,
          recipeVersionNumber: null,
          ingredients: [
            {
              rawMaterialDefinitionId: 'raw-material-real-id',
              shareBasisPoints: 10_000,
            },
          ],
        },
      },
    ],
  };
}

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  const result = root.findAllByType('button').find((candidate) => nodeText(candidate) === label);
  if (!result) throw new Error(`Button not found: ${label}`);
  return result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('warehouse cover compatibility and one-action contract', () => {
  it('offers only received rolls matching all five server criteria', () => {
    const compatible = compatibleWarehouseCoverRolls(position, [
      roll('1'),
      roll('2'),
      roll('wrong-thickness', {
        facts: { ...roll('x').facts, actualThickness: '100 мкм' },
      }),
      roll('not-ready', { warehouseStatus: 'not_ready' }),
    ]);

    expect(compatible.map((item) => item.id)).toEqual(['1', '2']);
  });

  it('does not treat two missing compatibility facts as a match', () => {
    const positionWithoutBirka = { ...position, birka: null };
    const rollWithoutBirka = roll('missing-birka', {
      facts: { ...roll('x').facts, birka: null },
    });

    expect(compatibleWarehouseCoverRolls(positionWithoutBirka, [rollWithoutBirka])).toEqual([]);
  });

  it('keeps one stable CTA id while its truthful route follows the exact selection', () => {
    expect(warehouseCoverPrimaryAction(task, position, [])).toEqual({
      id: 'warehouse-cover-propose:order-1:position-1',
      label: 'Предложить производство без резерва',
      rollIds: [],
      route: 'production_only',
    });
    expect(warehouseCoverPrimaryAction(task, position, ['1'])).toEqual({
      id: 'warehouse-cover-propose:order-1:position-1',
      label: 'Предложить покрытие',
      rollIds: ['1'],
      route: 'partial_cover',
    });
    expect(warehouseCoverPrimaryAction(task, position, ['1', '2', '3'])).toEqual({
      id: 'warehouse-cover-propose:order-1:position-1',
      label: 'Предложить покрытие',
      rollIds: ['1', '2', '3'],
      route: 'full_cover',
    });
  });

  it('advances within the retained case until every position has a proposal', () => {
    const secondPosition = { ...position, id: 'position-2', rollCount: 1 };
    const multiPositionTask = { ...task, positions: [position, secondPosition] };

    expect(
      nextWarehouseCoverPositionId(multiPositionTask, position.id, new Set([position.id])),
    ).toBe(secondPosition.id);
    expect(
      nextWarehouseCoverPositionId(
        multiPositionTask,
        secondPosition.id,
        new Set([position.id, secondPosition.id]),
      ),
    ).toBe(secondPosition.id);
  });
});

describe('WarehouseCoverTasksPanel surface', () => {
  it('shows a focused reserve queue with safe task/fact copy and exactly one primary CTA', () => {
    const markup = renderToStaticMarkup(
      createElement(WarehouseCoverTasksPanel, {
        tasks: [task],
        freeRolls: [roll('1')],
        coverageRechecks: [],
        onPropose: vi.fn(),
        onRefresh: vi.fn(),
      }),
    );

    expect(markup).toContain('Проверки покрытия');
    expect(markup).toContain('1 требует действия');
    expect(markup).not.toContain('<span class="eyebrow">Запасы / резерв</span>');
    expect(markup).toContain('A-1001');
    expect(markup).toContain('Клиент 12');
    expect(markup).toContain('15.07.2026');
    expect(markup).toContain('Рукав');
    expect(markup).toContain('80 мкм');
    expect(markup).toContain('STK-1');
    expect(markup.match(/data-cover-primary-action/g)).toHaveLength(1);
    expect(markup).toContain('Предложить производство без резерва');
    expect(markup).not.toMatch(/legalName|ИНН|финанс|rawPayload|scanner|1C-secret/);
  });

  it('hides a successfully loaded empty queue', () => {
    const markup = renderToStaticMarkup(
      createElement(WarehouseCoverTasksPanel, {
        tasks: [],
        freeRolls: [],
        coverageRechecks: [],
        onPropose: vi.fn(),
        onRefresh: vi.fn(),
      }),
    );

    expect(markup).toBe('');
  });

  it('honors the selected Control task instead of falling back to the first task', () => {
    const secondTask: WarehouseCoverTask = {
      ...task,
      caseId: 'case-2',
      orderId: 'order-2',
      orderNumber: 'A-2002',
    };
    const onSelectObject = vi.fn();
    const markup = renderToStaticMarkup(
      createElement(WarehouseCoverTasksPanel, {
        tasks: [task, secondTask],
        freeRolls: [],
        coverageRechecks: [],
        selectedObjectId: 'WH-COVER-order-2',
        onSelectObject,
        onPropose: vi.fn(),
        onRefresh: vi.fn(),
      }),
    );

    expect(markup).toContain('data-selected-task="case-2"');
    expect(warehouseCoverObjectId(secondTask)).toBe('WH-COVER-order-2');
    expect(reconcileWarehouseCoverTaskSelection('case-2', [task, secondTask])).toBe('case-2');
  });

  it('renders accessible busy, error and success feedback beside the retained task', () => {
    const common = {
      tasks: [task],
      selectedTaskId: task.caseId,
      selectedPositionId: position.id,
      selectedRollIds: [] as string[],
      freeRolls: [roll('1')],
      comment: '',
      onSelectTask: vi.fn(),
      onSelectPosition: vi.fn(),
      onToggleRoll: vi.fn(),
      onCommentChange: vi.fn(),
      onSubmit: vi.fn(),
    };
    const busy = renderToStaticMarkup(
      createElement(WarehouseCoverTasksPanelView, {
        ...common,
        feedback: { status: 'submitting', message: 'Отправляем предложение…' },
      }),
    );
    const failed = renderToStaticMarkup(
      createElement(WarehouseCoverTasksPanelView, {
        ...common,
        feedback: { status: 'error', message: 'Предложение изменилось' },
      }),
    );
    const success = renderToStaticMarkup(
      createElement(WarehouseCoverTasksPanelView, {
        ...common,
        feedback: { status: 'success', message: 'Предложение отправлено' },
      }),
    );

    expect(busy).toContain('aria-busy="true"');
    expect((busy.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Предложение изменилось');
    expect(success).toContain('role="status"');
    expect(success).toContain('data-selected-task="case-1"');
  });
});

describe('warehouse cover submission lifecycle', () => {
  it('blocks double submit, refreshes immediately after success, and keeps task selection', async () => {
    const lock = { current: null };
    let resolve!: () => void;
    const propose = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const refresh = vi.fn().mockResolvedValue(undefined);
    const first = executeWarehouseCoverProposal(
      { orderId: 'order-1', positionId: 'position-1', rollIds: ['1'] },
      propose,
      refresh,
      lock,
    );
    const second = executeWarehouseCoverProposal(
      { orderId: 'order-1', positionId: 'position-1', rollIds: ['1'] },
      propose,
      refresh,
      lock,
    );

    expect(first).toBe(second);
    expect(propose).toHaveBeenCalledTimes(1);
    resolve();
    await expect(first).resolves.toEqual({
      status: 'success',
      message: 'Предложение отправлено',
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(reconcileWarehouseCoverTaskSelection('case-1', [task])).toBe('case-1');
  });

  it('returns an accessible error and does not refresh a failed proposal', async () => {
    const refresh = vi.fn();
    await expect(
      executeWarehouseCoverProposal(
        { orderId: 'order-1', positionId: 'position-1', rollIds: [] },
        vi.fn().mockRejectedValue(new Error('Конфликт покрытия')),
        refresh,
        { current: null },
      ),
    ).resolves.toEqual({ status: 'error', message: 'Конфликт покрытия' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps concurrent submissions from different panel instances isolated', async () => {
    const firstPropose = vi.fn().mockResolvedValue({ id: 'proposal-1' });
    const secondPropose = vi.fn().mockRejectedValue(new Error('Конфликт второй панели'));
    const firstRefresh = vi.fn().mockResolvedValue(undefined);
    const secondRefresh = vi.fn().mockResolvedValue(undefined);

    const [first, second] = await Promise.all([
      executeWarehouseCoverProposal(
        { orderId: 'order-1', positionId: 'position-1', rollIds: ['1'] },
        firstPropose,
        firstRefresh,
        { current: null },
      ),
      executeWarehouseCoverProposal(
        { orderId: 'order-2', positionId: 'position-2', rollIds: [] },
        secondPropose,
        secondRefresh,
        { current: null },
      ),
    ]);

    expect(firstPropose).toHaveBeenCalledWith('order-1', {
      positionId: 'position-1',
      rollIds: ['1'],
    });
    expect(secondPropose).toHaveBeenCalledWith('order-2', {
      positionId: 'position-2',
      rollIds: [],
    });
    expect(first).toEqual({ status: 'success', message: 'Предложение отправлено' });
    expect(second).toEqual({ status: 'error', message: 'Конфликт второй панели' });
    expect(firstRefresh).toHaveBeenCalledTimes(1);
    expect(secondRefresh).not.toHaveBeenCalled();
  });
});

describe('warehouse coverage V2 recovery surfaces', () => {
  it('loads new external rechecks after an initially empty live queue is refreshed', async () => {
    const listSpy = vi
      .spyOn(warehouseCoverageApi, 'listRechecks')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([v2Recheck()]);
    const view = (refreshGeneration: number) => (
      <WarehouseCoverTasksPanel
        tasks={[]}
        freeRolls={[]}
        onPropose={vi.fn()}
        onRefresh={vi.fn()}
        liveCoverageEnabled
        refreshGeneration={refreshGeneration}
      />
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(view(0));
    });
    expect(nodeText(renderer.root)).toBe('');
    await act(async () => {
      renderer.update(view(1));
    });
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(nodeText(renderer.root)).toContain('ROLL-001');
    act(() => renderer.unmount());
    listSpy.mockRestore();
  });

  it.each(['success', 'error'])(
    'keeps a correction draft while the live queue refreshes: %s',
    async (outcome) => {
      const pending = deferred<ReturnType<typeof v2Recheck>[]>();
      const listSpy = vi
        .spyOn(warehouseCoverageApi, 'listRechecks')
        .mockResolvedValueOnce([v2Recheck()])
        .mockReturnValueOnce(pending.promise);
      const view = (refreshGeneration: number) => (
        <WarehouseCoverTasksPanel
          tasks={[]}
          freeRolls={[]}
          onPropose={vi.fn()}
          onRefresh={vi.fn()}
          liveCoverageEnabled
          refreshGeneration={refreshGeneration}
        />
      );
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(view(0));
      });
      act(() => {
        renderer.root
          .findByProps({ 'aria-label': 'Причина исправления' })
          .props.onChange({ currentTarget: { value: 'Проверяю рулон' } });
      });
      await act(async () => {
        renderer.update(view(1));
      });
      expect(listSpy).toHaveBeenCalledTimes(2);
      expect(renderer.root.findByProps({ 'aria-label': 'Причина исправления' }).props.value).toBe(
        'Проверяю рулон',
      );
      await act(async () => {
        if (outcome === 'success') pending.resolve([v2Recheck()]);
        else pending.reject(new Error('Temporary network failure'));
      });
      expect(renderer.root.findByProps({ 'aria-label': 'Причина исправления' }).props.value).toBe(
        'Проверяю рулон',
      );
      act(() => renderer.unmount());
      listSpy.mockRestore();
    },
  );

  it('keeps both legacy proposals and V2 rechecks reachable when both queues have work', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <WarehouseCoverTasksPanel
          tasks={[task]}
          freeRolls={[roll('1')]}
          coverageRechecks={[v2Recheck()]}
          onPropose={vi.fn()}
          onRefresh={vi.fn()}
        />,
      );
    });
    expect(nodeText(renderer.root)).toContain('Перепроверка покрытия');
    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => nodeText(button).startsWith('Проверки заказов'))!
        .props.onClick();
    });
    expect(
      renderer.root.findAllByProps({ 'aria-label': 'Проверки покрытия заказов' }),
    ).toHaveLength(1);
    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => nodeText(button).startsWith('Перепроверки ('))!
        .props.onClick();
    });
    expect(
      renderer.root.findAllByProps({ 'aria-label': 'Перепроверки покрытия заказов' }),
    ).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('does not request live rechecks when the warehouse contour is disabled', async () => {
    const listSpy = vi.spyOn(warehouseCoverageApi, 'listRechecks').mockResolvedValueOnce([]);
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseCoverTasksPanel
          tasks={[task]}
          freeRolls={[roll('1')]}
          onPropose={vi.fn()}
          onRefresh={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(listSpy).not.toHaveBeenCalled();
    expect(nodeText(renderer.root)).toContain('Проверки покрытия');
    listSpy.mockRestore();
  });

  it('shows only explicit live rechecks and keeps routine proposal controls out of V2', () => {
    const markup = renderToStaticMarkup(
      createElement(WarehouseCoverTasksPanel, {
        tasks: [task],
        freeRolls: [roll('1')],
        coverageRechecks: [v2Recheck()],
        onPropose: vi.fn(),
        onRefresh: vi.fn(),
      }),
    );

    expect(markup).toContain('Перепроверка покрытия');
    expect(markup).toContain('ROLL-001');
    expect(markup).not.toContain('Предложить покрытие');
    expect(markup).not.toContain('Предложить производство без резерва');
    expect(markup).not.toContain('Подтвердить покрытие');
  });

  it('removes a resolved case only after the server confirms it', async () => {
    const response = deferred<WarehouseCoverageView>();
    const resolveSpy = vi
      .spyOn(warehouseCoverageApi, 'resolve')
      .mockReturnValueOnce(response.promise);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <WarehouseCoverTasksPanel
          tasks={[task]}
          freeRolls={[roll('1')]}
          coverageRechecks={[v2Recheck()]}
          onPropose={vi.fn()}
          onRefresh={vi.fn()}
        />,
      );
    });

    act(() => {
      renderer.root.findByProps({ 'aria-label': 'ID владельца ROLL-001' }).props.onChange({
        currentTarget: { value: 'owner-real-id' },
      });
      renderer.root.findByProps({ 'aria-label': 'Причина исправления' }).props.onChange({
        currentTarget: { value: 'Факт проверен на складе' },
      });
    });
    act(() => {
      button(renderer.root, 'Подтвердить перепроверку').props.onClick();
    });
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(
      renderer.root.findAllByProps({ 'data-recheck-case-id': 'case-real-id' }),
    ).not.toHaveLength(0);

    const serverResult: WarehouseCoverageView = {
      workflowVersion: 2,
      state: 'awaiting_finance',
      stateVersion: 6,
      generation: 4,
      availability: 'verified_full',
      reasonCodes: ['full_cover_available'],
      nextOwner: 'finance',
      availableActions: ['use_warehouse'],
      requiredRollCount: 1,
      matchedRollCount: 1,
      uncertainRollCount: 0,
      calculatedAt: '2026-07-24T10:05:00.000Z',
      stale: false,
    };
    await act(async () => {
      response.resolve(serverResult);
      await response.promise;
    });

    expect(renderer.root.findAllByProps({ 'data-recheck-case-id': 'case-real-id' })).toHaveLength(
      0,
    );
    resolveSpy.mockRestore();
  });

  it('clears stale correction detail when the selected live case changes', () => {
    const renderer = TestRenderer.create(
      <WarehouseCoverTasksPanel
        tasks={[]}
        freeRolls={[]}
        coverageRechecks={[
          v2Recheck('case-1', 'membership-1', 'ROLL-001'),
          v2Recheck('case-2', 'membership-2', 'ROLL-002'),
        ]}
        onPropose={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    act(() => {
      renderer.root.findByProps({ 'aria-label': 'Причина исправления' }).props.onChange({
        currentTarget: { value: 'Черновик первой карточки' },
      });
      renderer.root.findByProps({ 'data-recheck-case-id': 'case-2' }).props.onClick();
    });

    expect(renderer.root.findByProps({ 'aria-label': 'Причина исправления' }).props.value).toBe('');
    expect(nodeText(renderer.root)).toContain('ROLL-002');
    expect(nodeText(renderer.root)).not.toContain('Черновик первой карточки');
  });

  it('fails closed instead of exposing V1 route controls when the live queue is unavailable', async () => {
    const listSpy = vi
      .spyOn(warehouseCoverageApi, 'listRechecks')
      .mockRejectedValueOnce(new Error('Сеть недоступна'));
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseCoverTasksPanel
          tasks={[task]}
          freeRolls={[roll('1')]}
          onPropose={vi.fn()}
          onRefresh={vi.fn()}
          liveCoverageEnabled
        />,
      );
      await Promise.resolve();
    });

    expect(nodeText(renderer.root)).toContain('Не удалось загрузить перепроверки покрытия');
    expect(nodeText(renderer.root)).not.toContain('Предложить производство без резерва');
    listSpy.mockRestore();
  });
});

describe('decision-linked warehouse physical exception', () => {
  const decisionTask: WarehouseCoverageDecisionTaskView = {
    taskId: 'task-real-id',
    status: 'open',
    generation: 3,
    stateVersion: 5,
    updatedAt: '2026-07-24T10:00:00.000Z',
    rows: [
      {
        scanRowId: 'scan-row-real-id',
        rollCode: 'ROLL-001',
        scanStatus: 'expected',
      },
    ],
  };
  const workbench: WarehouseWorkbench = {
    type: 'warehouse',
    mode: 'receiving',
    prompt: 'Сканируйте QR',
    expected: 1,
    scanned: 0,
    missing: ['ROLL-001'],
    excess: [],
    accepted: [],
    lastScan: '—',
    scanSeverity: 'info',
    expectedRolls: [],
  };
  const actions: ActionDescriptor[] = [
    {
      id: 'warehouse.scan:task-real-id',
      label: 'Сканировать QR',
      level: 'recommended',
      enabled: true,
    },
  ];

  it('does not hydrate a live decision task when the warehouse contour is disabled', async () => {
    const readSpy = vi
      .spyOn(warehouseCoverageApi, 'readDecisionTask')
      .mockResolvedValueOnce(decisionTask);
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseWorkbenchView workbench={workbench} actions={actions} />,
      );
      await Promise.resolve();
    });

    expect(readSpy).not.toHaveBeenCalled();
    expect(
      renderer.root.findAllByProps({ 'data-coverage-task-id': decisionTask.taskId }),
    ).toHaveLength(0);
    readSpy.mockRestore();
  });

  it('reports the exact damaged scan row without offering a business route', async () => {
    const reportResult: WarehouseCoverageWithCaseView = {
      caseId: 'physical-case-real-id',
      workflowVersion: 2,
      state: 'recheck_requested',
      stateVersion: 6,
      generation: 4,
      availability: 'unknown',
      reasonCodes: ['warehouse_recheck_pending'],
      nextOwner: 'warehouse',
      availableActions: ['resolve_recheck'],
      requiredRollCount: 1,
      matchedRollCount: 0,
      uncertainRollCount: 1,
      calculatedAt: '2026-07-24T10:05:00.000Z',
      stale: false,
    };
    const reportSpy = vi
      .spyOn(warehouseCoverageApi, 'reportPhysicalException')
      .mockResolvedValueOnce(reportResult);
    expect(warehouseCoverageDecisionTaskId(actions)).toBe('task-real-id');
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <WarehouseWorkbenchView
          workbench={workbench}
          actions={actions}
          coverageDecisionTask={decisionTask}
        />,
      );
    });

    act(() => button(renderer.root, 'Рулон повреждён').props.onClick());
    act(() => {
      renderer.root
        .findByProps({ 'aria-label': 'Причина физического расхождения' })
        .props.onChange({
          currentTarget: { value: '  Повреждение подтверждено при сканировании  ' },
        });
    });
    await act(async () => {
      button(renderer.root, 'Сообщить о расхождении').props.onClick();
      await Promise.resolve();
    });

    expect(reportSpy).toHaveBeenCalledWith(
      'task-real-id',
      expect.objectContaining({
        expectedGeneration: 3,
        expectedStateVersion: 5,
        expectedTaskUpdatedAt: '2026-07-24T10:00:00.000Z',
        scanRowId: 'scan-row-real-id',
        kind: 'damaged',
        reason: 'Повреждение подтверждено при сканировании',
      }),
    );
    expect(nodeText(renderer.root)).not.toMatch(/Использовать склад|Произвести весь заказ/u);
    reportSpy.mockRestore();
  });

  it('clears open exception detail when the selected operation changes', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <WarehouseWorkbenchView
          workbench={workbench}
          actions={actions}
          coverageDecisionTask={decisionTask}
          selectedOperation={{
            id: 'intake-task-real-id',
            title: 'Первая операция',
            status: 'Открыта',
            mode: 'Приемка',
            counter: '0/1',
          }}
        />,
      );
    });

    act(() => button(renderer.root, 'Рулон отсутствует').props.onClick());
    expect(
      renderer.root.findAllByProps({ 'aria-label': 'Причина физического расхождения' }),
    ).toHaveLength(1);

    act(() => {
      renderer.update(
        <WarehouseWorkbenchView
          workbench={workbench}
          actions={[]}
          coverageDecisionTask={null}
          selectedOperation={{
            id: 'intake-another-real-id',
            title: 'Другая операция',
            status: 'Открыта',
            mode: 'Приемка',
            counter: '0/1',
          }}
        />,
      );
    });

    expect(
      renderer.root.findAllByProps({ 'aria-label': 'Причина физического расхождения' }),
    ).toHaveLength(0);
  });
});
