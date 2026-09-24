import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { financeWorkObjects } from '../../domain/fixtures/finance';
import type { Fact, WorkObject } from '../../domain/types';
import { FinanceWorkbench } from './FinanceWorkbench';

function FactList({ facts }: { facts: Fact[] }) {
  return <div>{facts.map((fact) => `${fact.label}: ${fact.value}`).join(' · ')}</div>;
}

const factValue = (object: WorkObject, label: string) =>
  object.facts.find((fact) => fact.label === label)?.value;

const source = financeWorkObjects[0];
const financeCss = readFileSync(
  new URL('../../styles/116-finance-accounting.css', import.meta.url),
  'utf8',
);
const financeWorkbenchCss = readFileSync(
  new URL('../../styles/33-finance-workbench.css', import.meta.url),
  'utf8',
);

describe('FinanceWorkbench consolidated accountant flow', () => {
  it('keeps payment corrections without restoring the visible account-history list', () => {
    const object: WorkObject = {
      ...source,
      financePaymentCorrections: [
        {
          id: 'correction-1',
          targetKind: 'payment_operation',
          reason: 'Дублирующее поступление',
          actorRole: 'Бухгалтерия',
          resultingStatus: 'partial',
          createdAt: '2026-08-10T10:00:00.000Z',
        },
      ],
      audit: [
        {
          id: 'event-1',
          objectId: source.id,
          time: '10.08.2026, 15:30',
          actorLabel: 'Олег Петров · Коммерция',
          actionLabel: 'Комментарий коммерции изменён',
          detail: 'Комментарий',
          oldValue: 'Самовывоз',
          newValue: 'Доставка',
          reason: 'Клиент уточнил условия',
        },
      ],
    };

    const markup = renderToStaticMarkup(
      <FinanceWorkbench
        object={object}
        factValue={factValue}
        FactList={FactList}
        activeSection="Счета"
      />,
    );

    expect(markup).toContain('История выплат заказа');
    expect(markup).toContain('Оплата скорректирована');
    expect(markup).toContain('Дублирующее поступление');
    expect(markup).not.toContain('История счёта');
    expect(markup).not.toContain('Комментарий коммерции изменён');
    expect(markup).not.toContain('Сверка источников');
    expect(markup).not.toContain('<h4>Источник</h4>');
  });

  it('never renders technical payment source codes in the invoice history', () => {
    const object: WorkObject = {
      ...source,
      paymentOperations: [
        { id: '1c', label: 'Оплата', amountLabel: '1 ₽', source: '1C' },
        { id: 'mock-1c', label: 'Оплата', amountLabel: '2 ₽', source: 'mock_1C' },
        { id: 'manual', label: 'Оплата', amountLabel: '3 ₽', source: 'manual_platform' },
        { id: 'warehouse', label: 'Оплата', amountLabel: '4 ₽', source: 'warehouse_runtime' },
        { id: 'unknown', label: 'Оплата', amountLabel: '5 ₽', source: 'partner_bank_api_v2' },
        { id: 'missing', label: 'Оплата', amountLabel: '6 ₽' },
      ],
      financePaymentTimeline: [],
      financePaymentCorrections: [],
      audit: [],
    };

    const markup = renderToStaticMarkup(
      <FinanceWorkbench
        object={object}
        factValue={factValue}
        FactList={FactList}
        activeSection="Счета"
      />,
    );

    expect(markup).toContain('Учётный источник');
    expect(markup).toContain('Внесено вручную');
    expect(markup).toContain('Подтверждено складом');
    expect(markup).toContain('Другой источник');
    expect(markup).toContain('Источник не указан');
    expect(markup).not.toMatch(
      /mock_1C|manual_platform|warehouse_runtime|partner_bank_api_v2/u,
    );
  });

  it('uses legacy payment audit as a bounded payment-history fallback', () => {
    const object: WorkObject = {
      ...source,
      audit: [
        {
          id: 'legacy-payment-import',
          objectId: source.id,
          time: '10.08.2026, 15:30',
          actorLabel: 'снимок 1С',
          actionLabel: 'audit:payment_status_imported',
          detail: 'payment_status_imported: partial',
          oldValue: 'unpaid',
          newValue: 'partial',
        },
        {
          id: 'unknown-internal-event',
          objectId: source.id,
          time: '10.08.2026, 15:29',
          actorLabel: 'Система',
          actionLabel: 'audit:unknown_internal_event',
          detail: 'raw_payload: forbidden',
          newValue: 'unknown_internal_status',
        },
      ],
    };

    const markup = renderToStaticMarkup(
      <FinanceWorkbench
        object={object}
        factValue={factValue}
        FactList={FactList}
        activeSection="Счета"
      />,
    );

    expect(markup).toContain('Платёж подтверждён');
    expect(markup).toContain('Система · Финансы');
    expect(markup).not.toContain('Неизвестное событие');
    expect(markup).not.toContain('История счёта');
    expect(markup).not.toMatch(/audit:|payment_status|raw_payload|unknown_internal/u);
  });

  it('shows the complete installment schedule with server paid and remaining values', () => {
    const object: WorkObject = {
      ...source,
      paymentSchedules: [
        {
          id: 'stage-1',
          sequence: 1,
          dueDateLabel: '10.08.2026',
          amountLabel: '1 000 ₽',
          paidAmountLabel: '400 ₽',
          remainingAmountLabel: '600 ₽',
          status: 'overdue',
          isOverdue: true,
        },
      ],
    };

    const markup = renderToStaticMarkup(
      <FinanceWorkbench
        object={object}
        factValue={factValue}
        FactList={FactList}
        activeSection="Рассрочка"
      />,
    );

    expect(markup).toContain('Полный график рассрочки');
    expect(markup).toContain('Этап 1');
    expect(markup).toContain('400 ₽');
    expect(markup).toContain('600 ₽');
    expect(markup).toContain('Просрочен');
  });

  it('uses only backend overdue facts for the overdue registry', () => {
    const current: WorkObject = {
      ...source,
      id: 'current-invoice',
      financeBusinessPayment: {
        businessDate: '2026-08-11',
        status: 'partial',
        isOverdue: false,
        paidAmount: '400.00',
        remainingAmount: '600.00',
        overdueAmount: '0.00',
      },
    };
    const overdue: WorkObject = {
      ...source,
      id: 'overdue-invoice',
      financeBusinessPayment: {
        businessDate: '2026-08-11',
        status: 'overdue',
        isOverdue: true,
        paidAmount: '400.00',
        remainingAmount: '600.00',
        overdueAmount: '600.00',
      },
    };

    const markup = renderToStaticMarkup(
      <FinanceWorkbench
        object={overdue}
        siblingObjects={[current, overdue]}
        factValue={factValue}
        FactList={FactList}
        activeSection="Просрочки"
        isRegistryPage
      />,
    );

    expect(markup).toContain('data-object-id="overdue-invoice"');
    expect(markup).not.toContain('data-object-id="current-invoice"');
  });

  it('keeps the 16/14 typography floor and card fallbacks for narrow screens', () => {
    expect(financeCss).toMatch(/\.finance-workbench[^{}]*\{[^}]*font-size:\s*16px/su);
    expect(financeCss).toMatch(/\.finance-workbench[^{}]*small[^{}]*\{[^}]*font-size:\s*14px/su);
    expect(financeCss).toContain('@media (max-width: 1100px)');
    expect(financeWorkbenchCss).toMatch(
      /@media \(max-width: 760px\)[\s\S]*?\.finance-record-nav\.has-back\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/su,
    );
    expect(financeWorkbenchCss).toMatch(
      /@media \(max-width: 760px\)[\s\S]*?\.finance-record-current\s*\{[^}]*display:\s*none/su,
    );
    expect(financeWorkbenchCss).toMatch(
      /\.finance-command-grid\.is-registry-page\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.45fr\) minmax\(320px, 0\.75fr\)/su,
    );
    expect(financeWorkbenchCss).toMatch(
      /\.finance-command-grid\.is-registry-page > \.finance-payment-calendar-band\s*\{[^}]*grid-column:\s*2/su,
    );
    expect(financeCss).toMatch(
      /@media \(max-width: 1100px\)[\s\S]*?\.finance-command-grid\.is-registry-page\s*>\s*\.finance-payment-calendar-band[^{}]*\{[^}]*grid-column:\s*1/su,
    );
    expect(financeCss).toMatch(/\.finance-ledger-table thead[^{}]*\{[^}]*display:\s*none/su);
    expect(financeCss).toMatch(/\.finance-raw-material-table thead[^{}]*\{[^}]*display:\s*none/su);
    expect(financeCss).not.toContain('.finance-context-history-list');
  });
});
