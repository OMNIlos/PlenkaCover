import { describe, expect, it } from 'vitest';

import { FINANCE_SECTIONS, normalizeFinanceSection } from './financeSections';
import { roleAccessPolicies } from './accessPolicy';
import { roleConfigs, roleTemplates } from './fixtures/access';
import { financeWorkObjects } from './fixtures/finance';
import { financeObjectBelongsToSection } from './selectors';

describe('finance sections', () => {
  it('exposes exactly the four task-oriented sections', () => {
    expect(FINANCE_SECTIONS).toEqual(['Счета', 'Рассрочка', 'Сырьё', 'Просрочки']);
    expect(roleConfigs.find(({ id }) => id === 'finance')?.nav).toEqual(FINANCE_SECTIONS);
    expect(roleAccessPolicies.finance.visibleSections).toEqual(FINANCE_SECTIONS);
    expect(roleTemplates.find(({ role }) => role === 'finance')?.visibleSections).toEqual(
      FINANCE_SECTIONS,
    );
  });

  it.each([
    ['Обзор', 'Счета'],
    ['Оплаты', 'Счета'],
    ['История', 'Счета'],
    ['Сверка источников', 'Счета'],
    ['Исключения', 'Просрочки'],
    ['Сырье', 'Сырьё'],
    ['неизвестный раздел', 'Счета'],
  ])('redirects legacy deep link %s to %s', (legacy, canonical) => {
    expect(normalizeFinanceSection(legacy)).toBe(canonical);
  });

  it('uses task contracts rather than legacy finance tags for section membership', () => {
    const installment = financeWorkObjects.find(({ id }) => id === 'FIN-2606-023');
    expect(installment).toBeDefined();
    expect(financeObjectBelongsToSection(installment!, 'Счета')).toBe(true);
    expect(financeObjectBelongsToSection(installment!, 'Рассрочка')).toBe(true);
    expect(financeObjectBelongsToSection(installment!, 'Сырьё')).toBe(false);

    const fullInstallment = financeWorkObjects.find(({ id }) => id === 'FIN-2606-020');
    expect(fullInstallment?.paymentSchedules).toHaveLength(1);
    expect(financeObjectBelongsToSection(fullInstallment!, 'Рассрочка')).toBe(true);

    const staleStoredOverdue = {
      ...installment!,
      statusLabel: 'Просрочка',
      financeBusinessPayment: {
        businessDate: '2026-08-11',
        status: 'paid' as const,
        isOverdue: false,
        paidAmount: '780000.00',
        remainingAmount: '0.00',
        overdueAmount: '0.00',
      },
    };
    expect(financeObjectBelongsToSection(staleStoredOverdue, 'Просрочки')).toBe(false);
    expect(
      financeObjectBelongsToSection(
        {
          ...staleStoredOverdue,
          financeBusinessPayment: {
            ...staleStoredOverdue.financeBusinessPayment,
            status: 'overdue',
            isOverdue: true,
            remainingAmount: '780000.00',
            overdueAmount: '780000.00',
          },
        },
        'Просрочки',
      ),
    ).toBe(true);

    const overdueFixture = financeWorkObjects.find(({ id }) => id === 'FIN-2606-021');
    expect(overdueFixture?.financeBusinessPayment?.isOverdue).toBe(true);
    expect(financeObjectBelongsToSection(overdueFixture!, 'Просрочки')).toBe(true);
  });
});
