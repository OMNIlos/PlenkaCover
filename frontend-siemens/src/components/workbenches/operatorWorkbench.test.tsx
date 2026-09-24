import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { initialOperatorRuntime } from '../../domain/operator/fixtures';
import {
  operatorActionsForOrder,
  operatorWorkbenchForOrder,
} from '../../domain/operator/selectors';
import {
  OperatorMachineChangePanel,
  OperatorShiftStrip,
  OperatorShiftSurface,
  OperatorWorkbenchView,
} from './operatorWorkbench';

function prePrintOrder() {
  const source = initialOperatorRuntime.orders[0];
  return {
    ...source,
    status: 'qr_print' as const,
    state: 'in_progress' as const,
    rolls: source.rolls.map((roll, index) =>
      index === 0
        ? {
            ...roll,
            status: 'вес зафиксирован',
            grossKg: 43,
            netKg: 41.2,
            actualNetKg: 41.2,
            toleranceState: 'within' as const,
            labelState: 'not_printed' as const,
          }
        : roll,
    ),
  };
}

function spoolWeightOrder() {
  const source = initialOperatorRuntime.orders[0];
  return {
    ...source,
    status: 'spool_weight' as const,
    state: 'in_progress' as const,
    rolls: source.rolls.map((roll, index) =>
      index === 0 ? { ...roll, status: 'принят', spoolScaleActivated: true } : roll,
    ),
  };
}

describe('OperatorWorkbenchView reweigh state', () => {
  it('places the order mass region directly between the current-roll weight and current step', () => {
    const order = prePrintOrder();
    const shift = { ...initialOperatorRuntime.shift, status: 'active' as const };
    const markup = renderToStaticMarkup(
      <OperatorWorkbenchView
        workbench={operatorWorkbenchForOrder(order, shift)}
        actions={operatorActionsForOrder(order, shift)}
        hideRollTable
        onAction={vi.fn()}
      />,
    );

    const currentWeight = markup.indexOf('aria-label="Вес текущего рулона"');
    const orderMass = markup.indexOf('aria-label="Масса заказа"');
    const currentStep = markup.indexOf('class="operator-focus operator-focus-compact');
    expect(currentWeight).toBeGreaterThan(-1);
    expect(orderMass).toBeGreaterThan(currentWeight);
    expect(currentStep).toBeGreaterThan(orderMass);
  });

  it('renders an explicit defect weighing button for the current roll', () => {
    const source = initialOperatorRuntime.orders[0];
    const order = {
      ...source,
      status: 'roll_weight' as const,
      state: 'in_progress' as const,
    };
    const shift = { ...initialOperatorRuntime.shift, status: 'active' as const };
    const markup = renderToStaticMarkup(
      <OperatorWorkbenchView
        workbench={operatorWorkbenchForOrder(order, shift)}
        actions={operatorActionsForOrder(order, shift)}
        hideRollTable
        onAction={vi.fn()}
      />,
    );

    expect(markup).toContain('Взвесить брак');
    expect(markup).toContain('aria-label="Взвесить брак');
  });

  it('shows the exact reweigh action as disabled and busy while its request is pending', () => {
    const order = prePrintOrder();
    const shift = { ...initialOperatorRuntime.shift, status: 'active' as const };
    const markup = renderToStaticMarkup(
      <OperatorWorkbenchView
        workbench={operatorWorkbenchForOrder(order, shift)}
        actions={operatorActionsForOrder(order, shift)}
        pendingActionId="operator-reweigh-roll"
        hideRollTable
        onAction={vi.fn()}
      />,
    );

    expect(markup).toContain('Перевзвешиваем…');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toMatch(/<button(?=[^>]*aria-busy="true")(?=[^>]*disabled="")[^>]*>/);
    expect(markup).toMatch(/<button(?=[^>]*disabled="")(?=[^>]*aria-label="Напечатайте QR)[^>]*>/);
  });

  it('renders the previous-step action as a large secondary recovery control', () => {
    const order = prePrintOrder();
    const shift = { ...initialOperatorRuntime.shift, status: 'active' as const };
    const markup = renderToStaticMarkup(
      <OperatorWorkbenchView
        workbench={operatorWorkbenchForOrder(order, shift)}
        actions={operatorActionsForOrder(order, shift)}
        pendingActionId="operator-step-back-roll-weight"
        hideRollTable
        onAction={vi.fn()}
      />,
    );

    expect(markup).toContain('Назад к весу рулона');
    expect(markup).toContain('operator-row-secondary-action action-secondary is-step-back');
    expect(markup).toContain('<ix-icon name="chevron-left-small"');
    expect(markup).toContain('Возвращаем…');
    expect(markup).toMatch(
      /<button(?=[^>]*class="[^"]*is-step-back)(?=[^>]*aria-busy="true")(?=[^>]*disabled="")[^>]*>/,
    );
  });

  it('blocks only the recommended action during the post-transition cooldown', () => {
    const order = prePrintOrder();
    const shift = { ...initialOperatorRuntime.shift, status: 'active' as const };
    const markup = renderToStaticMarkup(
      <OperatorWorkbenchView
        workbench={operatorWorkbenchForOrder(order, shift)}
        actions={operatorActionsForOrder(order, shift)}
        pendingActionId="operator-stage-cooldown"
        hideRollTable
        onAction={vi.fn()}
      />,
    );
    const primaryButton = markup.match(/<button(?=[^>]*aria-label="Напечатайте QR)[^>]*>/)?.[0];
    const stepBackButton = markup.match(
      /<button(?=[^>]*aria-label="Назад к весу рулона)[^>]*>/,
    )?.[0];

    expect(primaryButton).toContain('disabled=""');
    expect(stepBackButton).toBeDefined();
    expect(stepBackButton).not.toContain('disabled=""');
  });

  it('renders the compact table counter from rollProgress instead of the loaded row count', () => {
    const order = prePrintOrder();
    const shift = { ...initialOperatorRuntime.shift, status: 'active' as const };
    const workbench = {
      ...operatorWorkbenchForOrder(order, shift),
      rollProgress: { current: 1, completed: 0, total: 1 },
    };
    const markup = renderToStaticMarkup(
      <OperatorWorkbenchView workbench={workbench} actions={[]} onAction={vi.fn()} />,
    );

    expect(markup).toContain('0/1 закрыто');
    expect(markup).not.toContain('>0/3 закрыто<');
    expect(markup).not.toContain('operator-table-summary');
  });

  it('keeps the physical roll step compact without the crossed-out context and route blocks', () => {
    const order = spoolWeightOrder();
    const shift = { ...initialOperatorRuntime.shift, status: 'active' as const };
    const markup = renderToStaticMarkup(
      <OperatorWorkbenchView
        workbench={operatorWorkbenchForOrder(order, shift)}
        actions={operatorActionsForOrder(order, shift)}
        hideRollTable
        onAction={vi.fn()}
      />,
    );

    expect(markup).not.toContain('operator-table-summary');
    expect(markup).not.toContain('operator-step-ladder');
    expect(markup).not.toContain('Маршрут рулона');
    expect(markup).toContain('<h3>Зафиксируйте вес шпули</h3>');
  });

  it('keeps only the operator details requested for the compact roll screen', () => {
    const order = spoolWeightOrder();
    const shift = { ...initialOperatorRuntime.shift, status: 'active' as const };
    const markup = renderToStaticMarkup(
      <OperatorWorkbenchView
        workbench={operatorWorkbenchForOrder(order, shift)}
        actions={operatorActionsForOrder(order, shift)}
        hideRollTable
        onAction={vi.fn()}
      />,
    );

    expect(markup).toContain('<h3>Зафиксируйте вес шпули</h3>');
    expect(markup).not.toContain('Зафиксируйте вес шпули · рулон');
    expect(markup).not.toContain('operator-machine-value');
    expect(markup).not.toContain('operator-current-roll');
    expect(markup).not.toContain('<span>Рулон</span><strong>1</strong>');
    expect(markup).not.toContain('<span>Готово</span>');
    expect(markup).toContain('class="operator-roll-product-summary"');
    expect(markup).toContain('Параметры рулона');
    expect(markup).toContain('<dt>Тип рулона</dt><dd>Рукав</dd>');
    expect(markup).toContain('<dt>Факт. толщина</dt><dd>80 мкм</dd>');
    expect(markup).toContain('<dt>Бух. толщина</dt><dd>Не указана</dd>');
    expect(markup).toContain('<dt>Ширина</dt><dd>1,2 м</dd>');
    expect(markup).toMatch(/<dt>Метраж<\/dt><dd>1(?: | )200 м<\/dd>/u);
    expect(markup).toContain('<dt>Вес</dt><dd>41,2 кг</dd>');
    expect(markup).not.toContain('operator-roll-fact-line');
    expect(markup).toContain('<span>Брутто</span><strong>ждет весы</strong>');
    expect(markup).toContain('<span>Нетто</span><strong>ждет весы</strong>');
    expect(markup).not.toContain('Детали рулона и QR');
    expect(markup).not.toContain('operator-roll-detail-drawer');
    expect(markup).not.toContain(`<em>${order.rolls[0]?.id}</em>`);
  });

  it('renders the current roll recipe as a named composition with separate ingredients', () => {
    const order = spoolWeightOrder();
    const shift = { ...initialOperatorRuntime.shift, status: 'active' as const };
    const baseWorkbench = operatorWorkbenchForOrder(order, shift);
    const workbench = {
      ...baseWorkbench,
      currentRollGroup: baseWorkbench.currentRollGroup
        ? {
            ...baseWorkbench.currentRollGroup,
            recipeName: 'Синяя смесь',
            recipeVersionNumber: 3,
            recipeIngredients: [
              { name: 'Первичное', shareBasisPoints: 8000 },
              { name: 'Синий краситель', shareBasisPoints: 2000 },
            ],
          }
        : undefined,
    };

    const markup = renderToStaticMarkup(
      <OperatorWorkbenchView
        workbench={workbench}
        actions={operatorActionsForOrder(order, shift)}
        hideRollTable
        onAction={vi.fn()}
      />,
    );

    expect(markup).toContain('<dt>Рецептура</dt>');
    expect(markup).toContain('Синяя смесь');
    expect(markup).toContain('Версия 3');
    expect(markup).toContain('Первичное · 80%');
    expect(markup).toContain('Синий краситель · 20%');
    expect(markup).toContain('aria-label="Состав рецептуры"');
  });

  it('shows measured gross and net without mixing the spool into net weight', () => {
    const order = prePrintOrder();
    const shift = { ...initialOperatorRuntime.shift, status: 'active' as const };
    const markup = renderToStaticMarkup(
      <OperatorWorkbenchView
        workbench={operatorWorkbenchForOrder(order, shift)}
        actions={operatorActionsForOrder(order, shift)}
        hideRollTable
        onAction={vi.fn()}
      />,
    );

    expect(markup).toContain('<span>Брутто</span><strong>43,0 кг</strong>');
    expect(markup).toContain('<span>Нетто</span><strong>41,2 кг</strong>');
    expect(markup).toContain('<dt>Вес</dt><dd>41,2 кг</dd>');
  });

  it('opens the commercial order comment in an accessible modal without exposing a customer', () => {
    const order = spoolWeightOrder();
    const shift = { ...initialOperatorRuntime.shift, status: 'active' as const };
    const baseWorkbench = operatorWorkbenchForOrder(order, shift);
    const workbench = {
      ...baseWorkbench,
      customerAlias: undefined,
      currentRollGroup: baseWorkbench.currentRollGroup
        ? {
            ...baseWorkbench.currentRollGroup,
            rawMaterialLabel: 'ПВД 15803-020',
            recipeVersion: 'v7',
            commercialComment: 'Позвонить перед запуском',
            comment: 'Использовать маркировку А-17',
          }
        : undefined,
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <OperatorWorkbenchView
          workbench={workbench}
          actions={operatorActionsForOrder(order, shift)}
          hideRollTable
          onAction={vi.fn()}
        />,
      );
    });

    const commentTrigger = renderer.root
      .findAllByType('button')
      .find((candidate) => candidate.children.join('') === 'Комментарий');
    expect(commentTrigger?.props['aria-haspopup']).toBe('dialog');
    act(() => commentTrigger?.props.onClick());
    const dialog = renderer.root.findByProps({
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Комментарий коммерции',
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('Позвонить перед запуском');
    expect(JSON.stringify(renderer.toJSON())).toContain('Комментарий к заявке');
    expect(JSON.stringify(renderer.toJSON())).toContain('Комментарий к позиции');
    expect(JSON.stringify(renderer.toJSON())).toContain('Использовать маркировку А-17');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Клиент');

    act(() => dialog.findByProps({ 'aria-label': 'Закрыть' }).props.onClick());
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });
});

describe('OperatorShiftSurface scheduled state', () => {
  const activeBag = {
    bagId: 'bag-1',
    code: 'BB-1',
    material: 'ПВД',
    materialId: 'material-1',
    warehouseKg: 500,
    startKg: 480,
    endKg: null,
    addedReason: null,
    releasedReason: null,
    active: true,
    releasedAt: null,
    sequence: 1,
  };

  it('shows cancel only during final weighing', () => {
    const closePending = {
      ...initialOperatorRuntime,
      shift: {
        ...initialOperatorRuntime.shift,
        status: 'close_pending' as const,
        bags: [activeBag],
      },
    };
    const active = {
      ...closePending,
      shift: { ...closePending.shift, status: 'active' as const },
    };
    const closed = {
      ...closePending,
      shift: { ...closePending.shift, status: 'closed' as const },
    };
    const props = {
      draft: { startKg: '480', endKg: '', bagEndKg: { 'bag-1': '417.2' } },
      onDraftChange: vi.fn(),
      onAction: vi.fn(),
      bigBags: [],
    };

    expect(
      renderToStaticMarkup(<OperatorShiftSurface {...props} runtime={closePending} />),
    ).toContain('Отменить сдачу');
    expect(
      renderToStaticMarkup(<OperatorShiftSurface {...props} runtime={active} />),
    ).not.toContain('Отменить сдачу');
    expect(
      renderToStaticMarkup(<OperatorShiftSurface {...props} runtime={closed} />),
    ).not.toContain('Отменить сдачу');

    const onAction = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <OperatorShiftSurface {...props} runtime={closePending} onAction={onAction} />,
      );
    });
    const cancel = renderer.root
      .findAllByType('button')
      .find((button) => button.props['aria-label']?.startsWith('Отменить сдачу'));
    expect(cancel).toBeDefined();
    act(() => cancel?.props.onClick());
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith('operator-close-shift-cancel');
  });

  it('disables cancel while the actual close command is pending', () => {
    const runtime = {
      ...initialOperatorRuntime,
      shift: {
        ...initialOperatorRuntime.shift,
        status: 'close_pending' as const,
        bags: [activeBag],
      },
    };
    const markup = renderToStaticMarkup(
      <OperatorShiftSurface
        runtime={runtime}
        draft={{ startKg: '480', endKg: '', bagEndKg: { 'bag-1': '417.2' } }}
        onDraftChange={vi.fn()}
        onAction={vi.fn()}
        bigBags={[]}
        pendingActionId="operator-close-shift"
      />,
    );

    expect(markup).toMatch(
      /<button(?=[^>]*disabled="")(?=[^>]*aria-label="Отменить сдачу[^"]*")[^>]*>/,
    );
  });

  it('labels uncertain close verification and keeps cancel disabled', () => {
    const runtime = {
      ...initialOperatorRuntime,
      shift: {
        ...initialOperatorRuntime.shift,
        status: 'close_pending' as const,
        bags: [activeBag],
      },
    };
    const markup = renderToStaticMarkup(
      <OperatorShiftSurface
        runtime={runtime}
        draft={{ startKg: '480', endKg: '', bagEndKg: { 'bag-1': '417.2' } }}
        onDraftChange={vi.fn()}
        onAction={vi.fn()}
        bigBags={[]}
        pendingActionId="operator-close-shift-uncertain"
      />,
    );

    expect(markup).toContain('Статус сдачи проверяется');
    expect(markup).toMatch(
      /<button(?=[^>]*disabled="")(?=[^>]*aria-label="Статус сдачи проверяется[^"]*")[^>]*>/,
    );
    expect(markup).toMatch(
      /<button(?=[^>]*disabled="")(?=[^>]*aria-label="Отменить сдачу[^"]*")[^>]*>/,
    );
  });

  it('disables the close action while the idempotent close command is pending', () => {
    const runtime = {
      ...initialOperatorRuntime,
      shift: {
        ...initialOperatorRuntime.shift,
        status: 'close_pending' as const,
        bags: [],
      },
    };
    const markup = renderToStaticMarkup(
      <OperatorShiftSurface
        runtime={runtime}
        draft={{ startKg: '', endKg: '' }}
        onDraftChange={vi.fn()}
        onAction={vi.fn()}
        bigBags={[]}
        pendingActionId="operator-close-shift"
      />,
    );

    expect(markup).toContain('Сохраняем смену');
    expect(markup).toMatch(/<button(?=[^>]*disabled="")(?=[^>]*aria-label="Сохраняем смену)[^>]*>/);
  });

  it('lets the backend decide close eligibility when a runtime roll still looks in progress', () => {
    const source = initialOperatorRuntime.orders[0];
    const runtime = {
      ...initialOperatorRuntime,
      shift: { ...initialOperatorRuntime.shift, status: 'active' as const },
      orders: [
        {
          ...source,
          status: 'qr_check' as const,
          rolls: source.rolls.map((roll, index) =>
            index === 0 ? { ...roll, status: 'qr_check' } : roll,
          ),
        },
      ],
    };
    const onAction = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <OperatorShiftSurface
          runtime={runtime}
          draft={{ startKg: '', endKg: '' }}
          onDraftChange={vi.fn()}
          onAction={onAction}
          bigBags={[]}
        />,
      );
    });

    const close = renderer.root
      .findAllByType('button')
      .find((button) => button.props['aria-label'] === 'Сдать смену');
    expect(close).toBeDefined();
    expect(close?.props.disabled).toBe(false);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Завершите и передайте рулон');
    act(() => close?.props.onClick());
    expect(onAction).toHaveBeenCalledWith('operator-close-shift-request');
  });

  it('shows the upcoming shift without rendering controls that can open it early', () => {
    const runtime = {
      ...initialOperatorRuntime,
      shift: {
        ...initialOperatorRuntime.shift,
        status: 'scheduled' as const,
        plannedStartAt: '2026-07-23T15:22:32.000Z',
        plannedEndAt: '2026-07-23T23:22:32.000Z',
      },
    };
    const markup = renderToStaticMarkup(
      <OperatorShiftSurface
        runtime={runtime}
        draft={{ startKg: '700', endKg: '' }}
        onDraftChange={vi.fn()}
        onAction={vi.fn()}
        onBackToOrders={vi.fn()}
        bigBags={[]}
      />,
    );

    expect(markup).toContain('Смена запланирована');
    expect(markup).toContain('23.07.2026');
    expect(markup).not.toContain('operator-start-bigbag');
    expect(markup).not.toContain('bigbag-picker-search');
    expect(markup).not.toContain('bigbag-start-weight');
  });
});

describe('OperatorShiftSurface defect-bag gate', () => {
  const closePendingRuntime = {
    ...initialOperatorRuntime,
    shift: {
      ...initialOperatorRuntime.shift,
      status: 'close_pending' as const,
      bags: [
        {
          bagId: 'bag-1',
          code: 'BB-1',
          material: 'ПВД',
          materialId: 'rm-1',
          warehouseKg: 500,
          startKg: 500,
          endKg: null,
          addedReason: null,
          releasedReason: null,
          active: true,
          releasedAt: null,
          sequence: 1,
        },
      ],
    },
  };
  const closeDraft = {
    startKg: '',
    endKg: '',
    bagEndKg: { 'bag-1': '450' },
  };

  it('accepts zero without a defect type, hides QR printing and enables shift close', () => {
    const onAction = vi.fn();
    const weighing = TestRenderer.create(
      <OperatorShiftSurface runtime={closePendingRuntime}
        draft={{ ...closeDraft, defectBagKg: '0' }} onAction={onAction} bigBags={[]} />,
    );
    const save = weighing.root.findByProps({ 'aria-label': 'Зафиксировать вес мешка брака' });
    expect(save.props.disabled).toBe(false);
    act(() => save.props.onClick());
    expect(onAction).toHaveBeenCalledWith('operator-weigh-defect-bag:none:0');

    const zeroBag = {
      id: 'zero-defect', code: 'DEF-zero', status: 'weighed' as const,
      defectType: null, weightKg: 0, recordedDefectKg: 0, differenceKg: 0,
      labelState: 'not_printed' as const, weighedAt: '2026-09-17T10:00:00.000Z',
    };
    const runtime = { ...closePendingRuntime, shift: {
      ...closePendingRuntime.shift, defectBags: [zeroBag], defectBag: zeroBag,
    } };
    const ready = TestRenderer.create(
      <OperatorShiftSurface runtime={runtime} draft={closeDraft} onAction={onAction} bigBags={[]} />,
    );
    expect(JSON.stringify(ready.toJSON())).toContain('QR не требуется');
    expect(ready.root.findAllByProps({ 'aria-label': 'Напечатать QR мешка Брак отсутствует' })).toHaveLength(0);
    expect(ready.root.findAllByType('button').find((button) =>
      button.props['aria-label']?.startsWith('Закрыть смену'),
    )?.props.disabled).toBe(false);
  });

  it('keeps multiple bags visible, targets printing and opens a separate bag draft', () => {
    const onAction = vi.fn();
    const onDraftChange = vi.fn();
    const first = {
      id: 'bag-defect-1', code: 'BR-001', status: 'ready_for_warehouse' as const,
      defectType: 'secondary' as const, weightKg: 12.4, recordedDefectKg: 0,
      differenceKg: 12.4, labelState: 'submitted' as const, weighedAt: '2026-09-11T15:00:00Z',
    };
    const second = { ...first, id: 'bag-defect-2', code: 'BR-002', status: 'weighed' as const, labelState: 'not_printed' as const };
    const runtime = { ...closePendingRuntime, shift: { ...closePendingRuntime.shift, defectBag: first, defectBags: [first, second] } };
    const renderer = TestRenderer.create(<OperatorShiftSurface runtime={runtime} draft={closeDraft} onDraftChange={onDraftChange} onAction={onAction} bigBags={[]} />);
    expect(JSON.stringify(renderer.toJSON())).toContain('BR-002');
    const print = renderer.root.findByProps({ 'aria-label': 'Напечатать QR мешка BR-002' });
    TestRenderer.act(() => print.props.onClick());
    expect(onAction).toHaveBeenCalledWith('operator-print-defect-bag:bag-defect-2');
    const add = renderer.root.findByProps({ 'aria-label': 'Добавить биг-бег брака' });
    TestRenderer.act(() => add.props.onClick());
    expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({ defectBagDraftId: expect.any(String), defectBagKg: '', defectBagType: undefined }));
    const allReady = { ...runtime, shift: { ...runtime.shift, defectBags: [first, { ...second, status: 'ready_for_warehouse' as const }] } };
    const markup = renderToStaticMarkup(<OperatorShiftSurface runtime={allReady} draft={{ ...closeDraft, defectBagDraftId: 'new-bag' }} onDraftChange={onDraftChange} onAction={onAction} bigBags={[]} />);
    expect(markup).toMatch(/<button(?=[^>]*aria-label="Закрыть)(?=[^>]*disabled)[^>]*>/);
    expect(markup).toContain('Вес мешка брака, кг');
    const closing = TestRenderer.create(<OperatorShiftSurface runtime={allReady} draft={closeDraft} onDraftChange={onDraftChange} onAction={onAction} bigBags={[]} pendingActionId="operator-close-shift-uncertain" />);
    expect(closing.root.findByProps({ 'aria-label': 'Добавить биг-бег брака' }).props.disabled).toBe(true);
  });

  it('requires a manual defect-bag weight and submits the keyboard value', () => {
    const onAction = vi.fn();
    const onDraftChange = vi.fn();
    const renderer = TestRenderer.create(
      <OperatorShiftSurface
        runtime={closePendingRuntime}
        draft={{ ...closeDraft, defectBagKg: '12,4', defectBagType: 'aika' }}
        onDraftChange={onDraftChange}
        onAction={onAction}
        bigBags={[]}
      />,
    );

    const input = renderer.root.findByProps({ 'aria-label': 'Вес мешка брака, кг' });
    expect(input.props.type).toBe('number');
    expect(input.props.inputMode).toBe('decimal');
    act(() => input.props.onChange({ target: { value: '12,5' } }));
    expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({ defectBagKg: '12,5' }));
    const typeButton = renderer.root.findByProps({ 'aria-label': 'Тип брака: Айка' });
    expect(typeButton.props['aria-pressed']).toBe(true);
    act(() =>
      renderer.root.findByProps({ 'aria-label': 'Тип брака: Вторичка' }).props.onClick(),
    );
    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({ defectBagType: 'secondary' }),
    );

    const button = renderer.root.findByProps({
      'aria-label': 'Зафиксировать вес мешка брака',
    });
    expect(button?.props.disabled).toBe(false);
    act(() => button?.props.onClick());
    expect(onAction).toHaveBeenCalledWith('operator-weigh-defect-bag:aika:12.4');
  });

  it('requires a defect type before submitting a valid weight', () => {
    const renderer = TestRenderer.create(
      <OperatorShiftSurface
        runtime={closePendingRuntime}
        draft={{ ...closeDraft, defectBagKg: '12,4' }}
        onDraftChange={vi.fn()}
        onAction={vi.fn()}
        bigBags={[]}
      />,
    );

    expect(renderer.root.findByProps({ 'aria-label': 'Тип брака' })).toBeDefined();
    expect(
      renderer.root.findByProps({ 'aria-label': 'Зафиксировать вес мешка брака' }).props.disabled,
    ).toBe(true);
  });

  it('blocks shift close until the defect bag is weighed', () => {
    const markup = renderToStaticMarkup(
      <OperatorShiftSurface
        runtime={closePendingRuntime}
        draft={closeDraft}
        onDraftChange={vi.fn()}
        onAction={vi.fn()}
        bigBags={[]}
      />,
    );

    expect(markup).toContain('Биг-беги брака');
    expect(markup).toContain('Вес мешка брака, кг');
    expect(markup).toMatch(/<button(?=[^>]*disabled="")(?=[^>]*Завершите ввод и печать всех мешков брака)[^>]*>/);
  });

  it('shows a readable name instead of a legacy defect-bag session hash', () => {
    const markup = renderToStaticMarkup(
      <OperatorShiftSurface
        runtime={{
          ...closePendingRuntime,
          shift: {
            ...closePendingRuntime.shift,
            defectBag: {
              id: 'defect-bag-1',
              code: 'DEF-cmtqqlje4004pqw07tgb9ptot',
              status: 'weighed',
              defectType: null,
              weightKg: 12.4,
              recordedDefectKg: 12.1,
              differenceKg: 0.3,
              labelState: 'not_printed',
              weighedAt: '2026-09-06T15:00:00.000Z',
            },
          },
        }}
        draft={closeDraft}
        onDraftChange={vi.fn()}
        onAction={vi.fn()}
        bigBags={[]}
      />,
    );

    expect(markup).toContain('Мешок брака 06.09.2026');
    expect(markup).not.toContain('cmtqqlje4004pqw07tgb9ptot');
  });

  it('offers QR printing after weighing and unlocks close only after handoff', () => {
    const weighed = renderToStaticMarkup(
      <OperatorShiftSurface
        runtime={{
          ...closePendingRuntime,
          shift: {
            ...closePendingRuntime.shift,
            defectBag: {
              id: 'defect-bag-1',
              code: 'BR-0609-001',
              status: 'weighed',
              defectType: 'primary',
              weightKg: 12.4,
              recordedDefectKg: 12.1,
              differenceKg: 0.3,
              labelState: 'not_printed',
              weighedAt: '2026-09-06T15:00:00.000Z',
            },
          },
        }}
        draft={closeDraft}
        onDraftChange={vi.fn()}
        onAction={vi.fn()}
        bigBags={[]}
      />,
    );
    const ready = renderToStaticMarkup(
      <OperatorShiftSurface
        runtime={{
          ...closePendingRuntime,
          shift: {
            ...closePendingRuntime.shift,
            defectBag: {
              id: 'defect-bag-1',
              code: 'BR-0609-001',
              status: 'ready_for_warehouse',
              defectType: 'primary',
              weightKg: 12.4,
              recordedDefectKg: 12.1,
              differenceKg: 0.3,
              labelState: 'submitted',
              weighedAt: '2026-09-06T15:00:00.000Z',
            },
          },
        }}
        draft={closeDraft}
        onDraftChange={vi.fn()}
        onAction={vi.fn()}
        bigBags={[]}
      />,
    );

    expect(weighed).toContain('Напечатать QR мешка');
    expect(weighed).toContain('Первичка');
    expect(weighed).toContain('12,4 кг');
    expect(ready).toContain('Готов к передаче на склад');
    expect(ready).toMatch(/<button(?=[^>]*aria-label="Закрыть смену)(?![^>]*disabled)[^>]*>/);
  });
});

describe('OperatorShiftSurface Big-Bag release lifecycle', () => {
  it('keeps the core close controls but removes the noisy current summary and order disclosure', () => {
    const runtime = {
      ...initialOperatorRuntime,
      shift: { ...initialOperatorRuntime.shift, status: 'active' as const },
    };
    const markup = renderToStaticMarkup(
      <OperatorShiftSurface
        runtime={runtime}
        draft={{ startKg: '', endKg: '' }}
        onDraftChange={vi.fn()}
        onAction={vi.fn()}
        bigBags={[]}
      />,
    );

    expect(markup).toContain('Смена открыта');
    expect(markup).toContain('Ожидаемый остаток');
    expect(markup).toContain('Сдать смену');
    expect(markup).not.toContain('На сейчас');
    expect(markup).not.toContain('Заказы смены');
    expect(markup).not.toContain('shift-day-summary');
  });

  it('shows required additional material instead of a negative Big-Bag remainder', () => {
    const runtime = {
      ...initialOperatorRuntime,
      shift: {
        ...initialOperatorRuntime.shift,
        status: 'active' as const,
        expectedEndKg: 0,
        plannedShortageKg: 5_405.95,
      },
    };

    const strip = renderToStaticMarkup(<OperatorShiftStrip runtime={runtime} />);
    const surface = renderToStaticMarkup(
      <OperatorShiftSurface
        runtime={runtime}
        draft={{ startKg: '', endKg: '' }}
        onDraftChange={vi.fn()}
        onAction={vi.fn()}
        bigBags={[]}
      />,
    );

    expect(strip).toContain('5405.95');
    expect(strip).toContain('кг нужно добавить');
    expect(surface).toContain('Нужно добавить');
    expect(surface).toContain('5405.95 кг');
    expect(`${strip}${surface}`).not.toContain('-5405.95');
  });

  it('keeps the shift open for adding a new bag after all prior bags were released', () => {
    const runtime = {
      ...initialOperatorRuntime,
      shift: {
        ...initialOperatorRuntime.shift,
        status: 'bag_missing' as const,
        bigBagId: 'Не назначен',
        bags: [
          {
            bagId: 'bag-1',
            code: 'BB-01',
            material: 'ПВД Первичное',
            materialId: 'material-primary',
            warehouseKg: 500,
            startKg: 500,
            endKg: 120,
            addedReason: null,
            releasedReason: 'Остаток не нужен',
            active: false,
            releasedAt: '2026-08-03T12:00:00.000Z',
            sequence: 1,
          },
        ],
      },
    };
    const markup = renderToStaticMarkup(
      <OperatorShiftSurface
        runtime={runtime}
        draft={{ startKg: '', endKg: '' }}
        onDraftChange={vi.fn()}
        onAction={vi.fn()}
        onReleaseBag={vi.fn()}
        bigBags={[
          {
            id: 'bag-2',
            code: 'BB-02',
            material: 'ПВД Вторичное',
            materialId: 'material-secondary',
            warehouseKg: 400,
            currentKg: 400,
            status: 'available',
          },
        ]}
      />,
    );

    expect(markup).toContain('Нужен Big-Bag');
    expect(markup).toContain('Нет активного Big-Bag');
    expect(markup).toContain('Добавить Big-bag');
    expect(markup).toContain('aria-label="Доступные Big-Bag для добавления"');
    expect(markup).toContain('role="option"');
    expect(markup).not.toContain('Причина добавления');
    expect(markup).not.toContain('bigbag-add-select');
    expect(markup).toContain('Сдать смену');
    expect(markup).toContain('Уже сданы (1)');
  });

  it('allows selecting a previously returned available bag and adding it back', () => {
    const runtime = {
      ...initialOperatorRuntime,
      shift: {
        ...initialOperatorRuntime.shift,
        status: 'bag_missing' as const,
        bags: [],
      },
    };
    const onDraftChange = vi.fn();
    const onAction = vi.fn();
    const draft = { startKg: '', endKg: '', addBagId: 'bag-returned', addKg: '450' };
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <OperatorShiftSurface
          runtime={runtime}
          draft={draft}
          onDraftChange={onDraftChange}
          onAction={onAction}
          bigBags={[
            {
              id: 'bag-returned',
              code: 'BB-RETURNED',
              material: 'ПВД Первичное',
              materialId: 'material-primary',
              warehouseKg: 500,
              currentKg: 450,
              status: 'available',
            },
          ]}
        />,
      );
    });
    const addButton = renderer.root
      .findAllByType('button')
      .find((candidate) =>
        candidate
          .findAllByType('span')
          .some((span) => span.children.join('') === 'Добавить в смену'),
      );

    expect(addButton?.props.disabled).toBe(false);
    act(() => addButton?.props.onClick());
    expect(onAction).toHaveBeenCalledWith('operator-add-bigbag:450');
  });

  it('uses the canonical current weight after release and pre-fills a returned bag re-add', () => {
    const runtime = {
      ...initialOperatorRuntime,
      shift: { ...initialOperatorRuntime.shift, status: 'bag_missing' as const, bags: [] },
    };
    const onDraftChange = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <OperatorShiftSurface
          runtime={runtime}
          draft={{ startKg: '', endKg: '' }}
          onDraftChange={onDraftChange}
          onAction={vi.fn()}
          bigBags={[
            {
              id: 'bag-returned',
              code: 'BB-RETURNED',
              material: 'ПВД',
              materialId: 'material-primary',
              warehouseKg: 5000,
              currentKg: 4000,
              status: 'available',
            },
          ]}
        />,
      );
    });

    expect(renderer.root.findAllByType('em').map((node) => node.children.join(''))).toContain(
      '4000 кг',
    );
    expect(renderer.root.findAllByType('em').map((node) => node.children.join(''))).not.toContain(
      '5000 кг',
    );
    const option = renderer.root.findByProps({ role: 'option' });
    act(() => option.props.onClick());
    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({ addBagId: 'bag-returned', addKg: '4000' }),
    );
  });
});

describe('OperatorMachineChangePanel persistent continuation', () => {
  it('keeps the roll queue visible while all pending Big-Bags await final weight', () => {
    const order = prePrintOrder();
    const shift = { ...initialOperatorRuntime.shift, status: 'active' as const };
    const markup = renderToStaticMarkup(
      <>
        <OperatorMachineChangePanel
          change={{
            id: 'change-1',
            assignmentId: 'assignment-1',
            shiftId: 'shift-1',
            operatorId: 'operator-1',
            fromPostId: 'post-1',
            toPostId: 'post-2',
            fromPost: { id: 'post-1', code: 'POST-1', name: 'Станок 1' },
            toPost: { id: 'post-2', code: 'POST-2', name: 'Станок 2' },
            needsFinalWeight: true,
            pendingBigBags: [
              { id: 'bag-1', code: 'BB-1' },
              { id: 'bag-2', code: 'BB-2' },
            ],
            reason: 'Плановый переход',
            status: 'awaiting_final_weight',
            operationKey: '22222222-2222-4222-8222-222222222222',
            requestedAt: '2026-07-27T09:00:00.000Z',
            readyAt: null,
            completedAt: null,
            cancelledAt: null,
            updatedAt: '2026-07-27T09:00:00.000Z',
          }}
          busy={false}
          onFinalize={vi.fn()}
        />
        <OperatorWorkbenchView
          workbench={operatorWorkbenchForOrder(order, shift)}
          actions={operatorActionsForOrder(order, shift)}
          onAction={vi.fn()}
        />
      </>,
    );

    expect(markup).toContain('Зафиксируйте конечный вес Big-Bag');
    expect(markup).toContain('BB-1');
    expect(markup).toContain('BB-2');
    expect(markup).toContain('operator-roll-table');
    expect(markup).toContain(order.rolls[0]?.id);
  });
});
