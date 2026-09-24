import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { productionOperators } from '../../domain/operators';
import type { ProductionRollDispatchItem } from '../../domain/types';
import { ProductionDispatchPanel, ProductionOperatorLoadSurface } from './productionDispatchPanel';

function nodeText(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

const assignedDraftRoll: ProductionRollDispatchItem = {
  id: 'dispatch-a13-1',
  productionOrderId: 'production-a13',
  orderId: 'production-a13',
  orderNumber: 'A-13',
  orderLineId: 'position-a13',
  rollId: 'A-13-roll-1',
  sequenceNumber: 1,
  customerAlias: 'Клиент A-13',
  operatorId: 'operator-sergey',
  operatorLabel: 'Сергей Волков',
  machineId: 'POST-1',
  machineLabel: 'Станок 1',
  machineAssignedBy: 'Зав. производства',
  machineAssignedAt: '2026-07-22T14:16:00.000Z',
  machineAssignmentRequired: true,
  publicationState: 'draft',
  priority: 'обычный',
  plannedNetKg: 40,
  characteristics: 'Плёнка 80 мкм',
  filmType: 'Плёнка',
  micron: '80',
  sizeMeters: '275 м',
  status: 'queued',
  auditEvent: 'audit:roll_dispatch_assigned',
};

describe('ProductionDispatchPanel assignment publication', () => {
  it('selects only rolls that can still be reassigned', () => {
    const rolls = [
      ...Array.from({ length: 10 }, (_, index) => ({
        ...assignedDraftRoll,
        id: `remaining-${index + 1}`,
        rollId: `A-13-roll-${index + 1}`,
        sequenceNumber: index + 1,
      })),
      ...Array.from({ length: 10 }, (_, index) => ({
        ...assignedDraftRoll,
        id: `completed-${index + 1}`,
        rollId: `A-13-roll-${index + 11}`,
        sequenceNumber: index + 11,
        status: 'handover_ready' as const,
      })),
    ];
    const renderer = TestRenderer.create(
      <ProductionDispatchPanel
        viewMode="rolls"
        selectedOperatorId=""
        selectedPriority="обычный"
        rollDispatchItems={rolls}
        operators={productionOperators}
        machineOptions={[{ value: 'POST-1', label: 'Станок 1' }]}
      />,
    );

    act(() => renderer.root.findByProps({ 'aria-label': 'Выбрать все рулоны' }).props.onChange());

    expect(nodeText(renderer.root)).toContain('10 выбрано');
    expect(
      renderer.root.findByProps({ 'aria-label': 'Выбрать рулон A-13-roll-11' }).props.disabled,
    ).toBe(true);
  });

  it('renders at most 100 all-roll rows and keeps page selections by exact roll id', () => {
    const rolls = Array.from({ length: 101 }, (_, index) => ({
      ...assignedDraftRoll,
      id: `dispatch-${index + 1}`,
      rollId: `A-13-roll-${index + 1}`,
      sequenceNumber: index + 1,
    }));
    const renderer = TestRenderer.create(
      <ProductionDispatchPanel
        viewMode="rolls"
        selectedOperatorId=""
        selectedPriority="обычный"
        rollDispatchItems={rolls}
        operators={[]}
        machineOptions={[{ value: 'POST-1', label: 'Станок 1' }]}
      />,
    );
    const renderedRows = () =>
      renderer.root
        .findAllByProps({ role: 'row' })
        .filter((row) => row.props.className?.includes('status-queued'));

    expect(renderedRows()).toHaveLength(100);
    act(() => renderer.root.findByProps({ 'aria-label': 'Выбрать все рулоны' }).props.onChange());
    expect(nodeText(renderer.root)).toContain('100 выбрано');

    act(() =>
      renderer.root.findByProps({ 'aria-label': 'Следующая страница рулонов' }).props.onClick(),
    );
    expect(renderedRows()).toHaveLength(1);
    expect(nodeText(renderedRows()[0])).toContain('A-13-roll-101');
    expect(nodeText(renderer.root)).toContain('100 выбрано');

    act(() => renderer.root.findByProps({ 'aria-label': 'Выбрать все рулоны' }).props.onChange());
    expect(nodeText(renderer.root)).toContain('101 выбрано');
  });

  it('keeps the queue header and editable controls without duplicate row labels', () => {
    const operator = productionOperators[0];
    const roll = {
      ...assignedDraftRoll,
      operatorId: operator.id,
      operatorLabel: operator.name,
      machineId: operator.defaultMachineId,
      machineLabel: operator.defaultMachineLabel,
    };
    const renderer = TestRenderer.create(
      <ProductionDispatchPanel
        viewMode="order"
        selectedOperatorId=""
        selectedPriority="обычный"
        rollDispatchItems={[roll]}
        operators={[operator]}
        machineOptions={[{ value: operator.defaultMachineId, label: operator.defaultMachineLabel }]}
      />,
    );

    const row = renderer.root
      .findAllByProps({ role: 'row' })
      .find((candidate) => candidate.props.className?.includes('status-queued'));
    if (!row) throw new Error('Expected a roll dispatch row.');

    expect(JSON.stringify(renderer.toJSON())).not.toContain('Рулоны в работу');
    for (const label of ['Оператор', 'Станок', 'Приоритет']) {
      const cell = row.findByProps({ 'data-label': label });
      expect(cell.findAllByType('select')).toHaveLength(1);
      expect(cell.findAllByType('strong')).toHaveLength(0);
    }
  });

  it('does not render the crossed-out status column', () => {
    const html = renderToStaticMarkup(
      <ProductionDispatchPanel
        viewMode="order"
        selectedOperatorId=""
        selectedPriority="обычный"
        rollDispatchItems={[assignedDraftRoll]}
        operators={[]}
        machineOptions={[{ value: 'POST-1', label: 'Станок 1' }]}
      />,
    );

    expect(html).not.toContain('Сортировать рулоны: Статус');
    expect(html).not.toContain('data-label="Статус"');
    expect(html).not.toContain('Черновик назначения');
    expect(html).not.toContain('согласуйте заказ, чтобы он появился у оператора');
  });

  it('renders the complete roll specification without duplicate metrage or duration noise', () => {
    const specifiedRoll = {
      ...assignedDraftRoll,
      plannedNetKg: 41.2,
      filmType: 'Рукав',
      actualThickness: '78 мкм',
      accountingThickness: '80 мкм',
      widthMm: 1700,
      plannedLengthM: 275,
      characteristics: 'Рукав · 78 мкм',
    } as ProductionRollDispatchItem;
    const html = renderToStaticMarkup(
      <ProductionDispatchPanel
        viewMode="order"
        selectedOperatorId=""
        selectedPriority="обычный"
        rollDispatchItems={[specifiedRoll]}
        operators={[]}
        machineOptions={[{ value: 'POST-1', label: 'Станок 1' }]}
      />,
    );

    expect(html).toContain('Рукав · 78 мкм (80 мкм) · 1700 мм · 275 м · 41.2 кг');
    expect(html).not.toContain('275 м · 41.2 кг · 275 м');
    expect(html).not.toContain('0 мин');
    expect(html).not.toContain('нет данных');
  });

  it('renders a missing planned weight as unavailable instead of a fake zero', () => {
    const html = renderToStaticMarkup(
      <ProductionDispatchPanel
        viewMode="order"
        selectedOperatorId=""
        selectedPriority="обычный"
        rollDispatchItems={[{ ...assignedDraftRoll, plannedNetKg: undefined, status: 'blocked' }]}
        operators={[]}
        machineOptions={[{ value: 'POST-1', label: 'Станок 1' }]}
      />,
    );

    expect(html).toContain('План не указан');
    expect(html).not.toContain(' · 0 кг');
  });
});

describe('ProductionOperatorLoadSurface', () => {
  it('opens complete operator details from an explicit disclosure and switches detail views', () => {
    const operator = productionOperators[0];
    const roll = {
      ...assignedDraftRoll,
      operatorId: operator.id,
      operatorLabel: operator.name,
      machineId: operator.defaultMachineId,
      machineLabel: operator.defaultMachineLabel,
    };
    const renderer = TestRenderer.create(
      <ProductionOperatorLoadSurface rollDispatchItems={[roll]} operators={[operator]} />,
    );

    expect(
      renderer.root
        .findAllByType('h4')
        .some((heading) => nodeText(heading) === 'Загрузка операторов'),
    ).toBe(false);
    const disclosure = renderer.root.findByProps({
      'aria-label': `Показать загрузку: ${operator.name}`,
    });
    expect(disclosure.props['aria-expanded']).toBe(false);

    act(() => disclosure.props.onClick());
    expect(renderer.root.findByProps({ 'aria-label': `Заказы ${operator.name}` })).toBeDefined();

    act(() =>
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.join('') === 'По очереди')
        ?.props.onClick(),
    );
    expect(renderer.root.findByProps({ 'aria-label': `Очередь ${operator.name}` })).toBeDefined();

    const collapse = renderer.root.findByProps({
      'aria-label': `Скрыть загрузку: ${operator.name}`,
    });
    act(() => collapse.props.onClick());
    expect(
      renderer.root.findAllByProps({ className: 'production-operator-load-detail' }),
    ).toHaveLength(0);
  });
});
