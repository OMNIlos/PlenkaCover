import { describe, expect, it } from 'vitest';

import { formatPayrollTariffRule } from './directorAnalyticsFormatters';

describe('director analytics payroll labels', () => {
  it('names the dedicated ABC tariff as Falz', () => {
    const label = formatPayrollTariffRule('abc_black_white');

    expect(label).toBe('АВС · фальц');
    expect(label).not.toMatch(/ч[её]рно-бел/u);
  });
});
