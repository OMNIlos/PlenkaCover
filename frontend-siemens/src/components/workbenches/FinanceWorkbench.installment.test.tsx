import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { financeWorkObjects } from '../../domain/fixtures/finance';
import type { Fact, WorkObject } from '../../domain/types';
import { FinanceWorkbench } from './FinanceWorkbench';

function FactList({ facts }: { facts: Fact[] }) {
  return <div>{facts.map((fact) => `${fact.label}: ${fact.value}`).join(' · ')}</div>;
}

describe('FinanceWorkbench installment entry point', () => {
  it('keeps the due-date tie-breaker in the exception registry priority order', () => {
    const source = financeWorkObjects[0];
    const overdueObject = (id: string, dueDateIso: string): WorkObject => ({
      ...source,
      id,
      title: `Финансы ${id}`,
      statusLabel: 'Ожидает оплаты',
      severity: 'info',
      filterTags: [],
      facts: [
        { label: 'Номер', value: id },
        { label: 'Заказчик', value: 'Тест' },
        { label: 'Статус счета', value: 'Счет отправлен' },
        { label: 'Статус оплаты', value: 'Ожидает оплаты' },
        { label: 'Источник данных', value: 'Данные актуальны' },
      ],
      sections: [],
      problems: [],
      paymentSchedule: undefined,
      financeBusinessPayment: {
        businessDate: '2026-08-01',
        status: 'overdue',
        isOverdue: true,
        paidAmount: '0.00',
        remainingAmount: '100000.00',
        overdueAmount: '100000.00',
      },
      paymentSchedules: [
        {
          id: `${id}-schedule`,
          dueDateIso,
          dueDateLabel: dueDateIso,
          amountLabel: '100 000 ₽',
          status: 'scheduled',
          source: 'manual_platform',
        },
      ],
    });
    const later = overdueObject('a-later', '2026-07-31');
    const earlier = overdueObject('z-earlier', '2026-07-30');

    const markup = renderToStaticMarkup(
      <FinanceWorkbench
        object={later}
        siblingObjects={[later, earlier]}
        factValue={(item, label) => item.facts.find((fact) => fact.label === label)?.value}
        FactList={FactList}
        activeSection="Просрочки"
        isRegistryPage
        businessNow={new Date('2026-07-31T21:00:00.000Z')}
      />,
    );

    expect(markup.indexOf('data-object-id="z-earlier"')).toBeLessThan(
      markup.indexOf('data-object-id="a-later"'),
    );
  });

  it('does not expose source freshness in the accountant header', () => {
    const source = financeWorkObjects[0];
    const markup = renderToStaticMarkup(
      <FinanceWorkbench
        object={source}
        factValue={(item, label) => item.facts.find((fact) => fact.label === label)?.value}
        FactList={FactList}
        businessNow={new Date('2026-07-31T21:00:00.000Z')}
      />,
    );

    expect(markup).toContain('<h3>Счета</h3>');
    expect(markup).not.toContain('Срез данных:');
  });

  it('keeps the order composition visible next to the selected invoice', () => {
    const source = financeWorkObjects[0];
    const object: WorkObject = {
      ...source,
      rollGroups: undefined,
      commercialOrder: {
        id: 'commercial-1',
        createdBy: 'Коммерция',
        creatorRole: 'commercial',
        requestType: 'клиентский заказ',
        status: 'in_work',
        productionStatus: 'needs_production',
        warehouseCoverStatus: 'not_checked',
        paymentStatus: 'не оплачен',
        shipmentStatus: 'не отгружено',
        createdAt: '2026-08-01T08:00:00.000Z',
        positions: [
          {
            id: 'position-1',
            draftId: 'commercial-1',
            rollCount: 4,
            filmType: 'ПВД',
            actualThickness: '80 мкм',
            accountingThickness: '75 мкм',
            plannedWeightKg: 25,
            widthMm: 1_200,
            plannedLengthM: 800,
            rawMaterialLabel: 'Не указано',
            spoolType: '76 мм',
            birka: 'Белая',
            recipeSnapshot: {
              id: 'position-1-finance',
              positionId: 'position-1',
              recipeOwnerRole: 'commercial',
              parameters: [],
              source: 'commercial_form',
              createdBy: 'Коммерция',
              createdAt: '2026-08-01T08:00:00.000Z',
              version: 'v1',
            },
            warehouseCoverStatus: 'not_checked',
          },
        ],
      },
    };

    const markup = renderToStaticMarkup(
      <FinanceWorkbench
        object={object}
        factValue={(item, label) => item.facts.find((fact) => fact.label === label)?.value}
        FactList={FactList}
      />,
    );

    expect(markup).toContain('<h4>Состав заказа</h4>');
    expect(markup).toContain('ПВД · факт. 80 мкм · учёт. 75 мкм');
    expect(markup).toContain('1 200 мм × 800 м');
    expect(markup).toContain('4 шт. · 25 кг/рулон');
    expect(markup).toContain('76 мм');
    expect(markup).toContain('Белая');
    expect(markup).not.toContain(
      '<details class="finance-panel finance-collapsed-panel finance-order-table-panel">',
    );
  });

  it('shows the payment-terms wizard next to the selected order schedule', () => {
    const source = financeWorkObjects[0];
    const object: WorkObject = {
      ...source,
      actions: [
        ...source.actions,
        {
          id: `finance-payment-terms:${source.id}`,
          label: 'Изменить условия оплаты',
          level: 'secondary',
          enabled: true,
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <FinanceWorkbench
        object={object}
        factValue={(item, label) => item.facts.find((fact) => fact.label === label)?.value}
        FactList={FactList}
        activeSection="Рассрочка"
      />,
    );

    expect(markup).toContain('aria-label="Открыть визард условий оплаты"');
    expect(markup).toContain('Изменить условия оплаты');
  });

  it('opens the selected order calendar on the first scheduled payment month', () => {
    const source = financeWorkObjects[0];
    const object: WorkObject = {
      ...source,
      paymentSchedules: [
        {
          id: 'payment-july',
          dueDateIso: '2026-07-15',
          dueDateLabel: '15.07.2026',
          amountLabel: '30 000 ₽',
          status: 'scheduled',
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <FinanceWorkbench
        object={object}
        factValue={(item, label) => item.facts.find((fact) => fact.label === label)?.value}
        FactList={FactList}
        activeSection="Рассрочка"
      />,
    );

    expect(markup).toContain('Июль 2026 · выплаты по');
    expect(markup).toContain('15 июля: 1 заказ ожидает выплату');
  });

  it('shows every persisted payment date on the all-invoice landing', () => {
    const source = financeWorkObjects[0];
    const scheduled = (id: string, dueDateIso: string): WorkObject => ({
      ...source,
      id,
      paymentSchedules: [
        {
          id: `${id}-payment`,
          dueDateIso,
          dueDateLabel: new Date(dueDateIso).toLocaleDateString('ru-RU'),
          amountLabel: '30 000 ₽',
          status: 'scheduled',
        },
      ],
    });
    const objects = [scheduled('finance-1', '2026-08-15'), scheduled('finance-2', '2026-08-21')];
    const markup = renderToStaticMarkup(
      <FinanceWorkbench
        object={objects[0]}
        siblingObjects={objects}
        factValue={(item, label) => item.facts.find((fact) => fact.label === label)?.value}
        FactList={FactList}
        activeSection="Счета"
        isRegistryPage
        businessNow={new Date('2026-08-11T09:00:00.000Z')}
      />,
    );

    expect(markup).toContain('<h3>Счета</h3>');
    expect(markup).toContain('Реестр: Счета');
    expect(markup).toContain('aria-label="Платежный календарь"');
    expect(markup).toContain('15 августа: 1 заказ ожидает выплату');
    expect(markup).toContain('21 августа: 1 заказ ожидает выплату');
    expect(markup).not.toContain('Полный график рассрочки');
  });

  it('does not select a sibling payment day for an undated order detail', () => {
    const source = financeWorkObjects[0];
    const selected: WorkObject = {
      ...source,
      id: 'finance-undated-selected',
      paymentSchedules: [
        {
          id: 'undated-stage',
          dueDateLabel: 'дата не задана',
          amountLabel: '600 ₽',
          status: 'scheduled',
          dateKind: 'unavailable',
        },
      ],
    };
    const sibling: WorkObject = {
      ...source,
      id: 'finance-dated-sibling',
      paymentSchedules: [
        {
          id: 'sibling-stage',
          dueDateIso: '2026-06-15',
          dueDateLabel: '15.06.2026',
          amountLabel: '900 ₽',
          status: 'scheduled',
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <FinanceWorkbench
        object={selected}
        siblingObjects={[selected, sibling]}
        factValue={(item, label) => item.facts.find((fact) => fact.label === label)?.value}
        FactList={FactList}
        activeSection="Рассрочка"
      />,
    );

    expect(markup).toContain('день не выбран');
    expect(markup).not.toContain('aria-pressed="true"');
  });

  it('renders an undated shipment condition with its percentage and offset', () => {
    const source = financeWorkObjects[0];
    const object: WorkObject = {
      ...source,
      paymentSchedules: [
        {
          id: 'condition-payment',
          trigger: 'full_shipment',
          offsetDays: 30,
          dueDateLabel: 'через 30 дней после полной отгрузки',
          amountLabel: '600 ₽',
          percentageBasisPoints: 5000,
          status: 'scheduled',
          dateKind: 'condition',
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <FinanceWorkbench
        object={object}
        factValue={(item, label) => item.facts.find((fact) => fact.label === label)?.value}
        FactList={FactList}
        activeSection="Рассрочка"
      />,
    );

    expect(markup).toContain('Условия после полной отгрузки');
    expect(markup).toContain('50,00% · 600 ₽');
    expect(markup).toContain('через 30 дней после полной отгрузки');
  });

  it('does not place an unavailable canonical stage in the calendar', () => {
    const source = financeWorkObjects[0];
    const object: WorkObject = {
      ...source,
      paymentSchedules: [
        {
          id: 'undated-payment',
          dueDateLabel: 'дата не задана',
          amountLabel: '700 ₽',
          percentageBasisPoints: 2500,
          status: 'scheduled',
          dateKind: 'unavailable',
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <FinanceWorkbench
        object={object}
        factValue={(item, label) => item.facts.find((fact) => fact.label === label)?.value}
        FactList={FactList}
        activeSection="Рассрочка"
      />,
    );

    expect(markup).toContain('0 дат');
    expect(markup).not.toContain('25,00% · 700 ₽');
  });
});
