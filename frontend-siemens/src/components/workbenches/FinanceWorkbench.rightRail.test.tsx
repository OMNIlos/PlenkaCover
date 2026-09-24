import { readFileSync } from 'node:fs';

import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { financeWorkObjects } from '../../domain/fixtures/finance';
import { financeObjectBelongsToSection } from '../../domain/selectors';
import type { Fact, WorkObject } from '../../domain/types';
import { FinanceWorkbench } from './FinanceWorkbench';

const css = readFileSync(new URL('../../styles/33-finance-workbench.css', import.meta.url), 'utf8');

function FactList({ facts }: { facts: Fact[] }) {
  return (
    <ul data-finance-fact-list="true">
      {facts.map((fact) => (
        <li key={fact.label} data-finance-fact-label={fact.label}>
          {fact.label}: {fact.value}
        </li>
      ))}
    </ul>
  );
}

function factValue(item: WorkObject, label: string) {
  return item.facts.find((fact) => fact.label === label)?.value;
}

const financeFixture = financeWorkObjects.find((item) => item.id === 'FIN-2606-014');

if (!financeFixture) throw new Error('Finance fixture FIN-2606-014 was not found');

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

function elementChildren(node: ReactTestInstance): ReactTestInstance[] {
  return node.children.filter((child): child is ReactTestInstance => typeof child !== 'string');
}

function factLabels(panel: ReactTestInstance): string[] {
  const factList = panel.findByProps({ 'data-finance-fact-list': 'true' });
  return elementChildren(factList).map((fact) => fact.props['data-finance-fact-label'] as string);
}

function financeRightRail(root: ReactTestInstance): ReactTestInstance {
  return root.find(
    (node) => node.type === 'aside' && node.props.className === 'finance-evidence-column',
  );
}

describe('FinanceWorkbench right rail', () => {
  it('keeps selected payment details without source freshness or the state badge', () => {
    const renderer = TestRenderer.create(
      <FinanceWorkbench
        object={financeFixture}
        factValue={factValue}
        FactList={FactList}
        activeSection="Счета"
      />,
    );

    expect(renderer.root.findAllByProps({ 'aria-label': 'Счет, клиент и дело' })).toHaveLength(0);
    expect(
      renderer.root.findAll(
        (node) =>
          node.type === 'span' && String(node.props.className).includes('finance-state-badge'),
      ),
    ).toHaveLength(0);
    expect(renderer.root.findAllByProps({ className: 'finance-command-source' })).toHaveLength(0);
    expect(nodeText(renderer.root)).not.toContain('Срез данных');
  });

  it('uses compact consistent right-rail spacing without rebuilding the grid', () => {
    expect(css).toMatch(
      /\.finance-evidence-column\s*\{[^}]*gap:\s*12px;[^}]*align-content:\s*start;/su,
    );
    expect(css).toMatch(
      /\.finance-evidence-column \.finance-panel\s*\{[^}]*padding:\s*12px 14px;/su,
    );
    expect(css).toMatch(
      /\.finance-rail-panel \.fact-row\s*\{[^}]*grid-template-columns:\s*minmax\(96px,\s*0\.42fr\) minmax\(0,\s*1fr\);[^}]*column-gap:\s*12px;[^}]*padding:\s*7px 0;/su,
    );
    expect(css).toMatch(
      /\.finance-rail-panel \.fact-row dd\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/su,
    );
    expect(css).toMatch(
      /\.finance-command-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.35fr\) minmax\(340px,\s*0\.8fr\);/su,
    );
    expect(css).toContain('@media (max-width: 1400px)');
  });

  it('keeps only the invoice totals and payment facts requested by accounting', () => {
    const renderer = TestRenderer.create(
      <FinanceWorkbench object={financeFixture} factValue={factValue} FactList={FactList} />,
    );
    const rail = financeRightRail(renderer.root);
    const panels = elementChildren(rail);

    expect(rail.props['aria-label']).toBe('Сведения выбранного счёта');
    expect(rail.children).toHaveLength(2);
    expect(panels).toHaveLength(2);
    expect(panels.every((panel) => panel.type === 'section')).toBe(true);
    expect(panels.map((panel) => nodeText(panel.findByType('h4')))).toEqual([
      'Счет и сумма',
      'Оплата и рассрочка',
    ]);
    expect(factLabels(panels[0])).toEqual(['Статус счета', 'Сумма', 'Остаток']);
    expect(factLabels(panels[1])).toEqual(['Оплачено', 'Дата оплаты', 'Рассрочка']);
    expect(nodeText(rail)).not.toContain('Номер счета');
    expect(nodeText(rail)).not.toContain('Тип операции');
    expect(nodeText(rail)).not.toContain('Статус оплаты');
    expect(nodeText(rail)).not.toContain('Оплата и выдача');
    expect(nodeText(rail)).not.toContain('Выдача');
    expect(nodeText(rail)).not.toContain('Связь');
    expect(nodeText(rail)).not.toContain('История счёта');
    expect(nodeText(rail)).not.toContain('Источник:');
    expect(
      renderer.root.findAllByType('button').filter((item) => nodeText(item) === 'К списку счетов'),
    ).toHaveLength(0);
  });

  it('does not render the long production-lead caption from fixtures', () => {
    const renderer = TestRenderer.create(
      <FinanceWorkbench object={financeFixture} factValue={factValue} FactList={FactList} />,
    );

    expect(nodeText(renderer.root)).not.toContain('Согласован зав. производства');
    expect(JSON.stringify(financeWorkObjects)).not.toContain('Согласован зав. производства');
  });

  it('opens the payment history locally instead of dispatching a dead paid action', () => {
    const onAction = vi.fn();
    const paidObject: WorkObject = {
      ...financeFixture,
      statusLabel: 'Оплачено',
      financePaymentStatus: 'paid',
      actions: [
        {
          id: `finance-view-payments:${financeFixture.id}`,
          label: 'Показать выплаты',
          level: 'recommended',
          enabled: true,
        },
      ],
      paymentOperations: [
        {
          id: 'paid-operation',
          label: 'Оплата по счету',
          amountLabel: '120 000 ₽',
          source: 'manual_platform',
        },
      ],
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <FinanceWorkbench
          object={paidObject}
          factValue={factValue}
          FactList={FactList}
          onAction={onAction}
        />,
      );
    });

    const paymentPanel = renderer.root.find(
      (node) =>
        node.type === 'details' && node.props.className?.includes('finance-payment-history-panel'),
    );
    const viewPayments = renderer.root
      .findAllByType('button')
      .find((item) => nodeText(item) === 'Показать выплаты');

    expect(viewPayments).toBeDefined();
    expect(paymentPanel.props.open).toBeFalsy();
    act(() => viewPayments?.props.onClick());
    expect(paymentPanel.props.open).toBe(true);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('keeps the detail stepper inside the active finance section', () => {
    const overdueObjects = financeWorkObjects.filter((item) =>
      financeObjectBelongsToSection(item, 'Просрочки'),
    );
    expect(overdueObjects).toHaveLength(1);
    const onSelectObject = vi.fn();
    const onBackToRegistry = vi.fn();
    const renderer = TestRenderer.create(
      <FinanceWorkbench
        object={overdueObjects[0]}
        siblingObjects={financeWorkObjects}
        factValue={factValue}
        FactList={FactList}
        activeSection="Просрочки"
        onSelectObject={onSelectObject}
        onBackToRegistry={onBackToRegistry}
      />,
    );
    const navigation = renderer.root.findByProps({
      'aria-label': 'Навигация выбранного финансового дела',
    });

    expect(nodeText(navigation)).toContain('К списку просрочек');
    expect(nodeText(navigation)).toContain('1/1');
    expect(
      navigation.findByProps({ 'aria-label': 'Предыдущее дело недоступно' }).props.disabled,
    ).toBe(true);
    expect(
      navigation.findByProps({ 'aria-label': 'Следующее дело недоступно' }).props.disabled,
    ).toBe(true);
    expect(onSelectObject).not.toHaveBeenCalled();
  });
});
