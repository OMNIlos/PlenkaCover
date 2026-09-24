import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AdminPalletPrintReconciliationDto,
  AdminPalletPrintReconciliationQueryDto,
} from './admin-pallet-print-reconciliation.dto';

const operationKey = '6ae53c5c-8649-44b9-aeb7-32ebeadc4937';

describe('AdminPalletPrintReconciliationDto', () => {
  it('defaults the unresolved-list limit to 25 and accepts the upper bound', async () => {
    const defaults = plainToInstance(AdminPalletPrintReconciliationQueryDto, {});
    const maximum = plainToInstance(AdminPalletPrintReconciliationQueryDto, { limit: '50' });

    await expect(validate(defaults)).resolves.toHaveLength(0);
    await expect(validate(maximum)).resolves.toHaveLength(0);
    expect(defaults.limit).toBe(25);
    expect(maximum.limit).toBe(50);
  });

  it.each(['0', '51', '1.5', 'not-a-number'])(
    'rejects an unsafe unresolved-list limit of %s',
    async (limit) => {
      const dto = plainToInstance(AdminPalletPrintReconciliationQueryDto, { limit });
      expect(await validate(dto)).not.toHaveLength(0);
    },
  );

  it('accepts and trims the exact reconciliation contract', async () => {
    const dto = plainToInstance(AdminPalletPrintReconciliationDto, {
      operationKey,
      outcome: 'label_observed',
      reason: '  Этикетка видна  ',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.reason).toBe('Этикетка видна');
  });

  it.each([
    [{ operationKey: 'not-a-uuid', outcome: 'label_observed', reason: 'Этикетка видна' }],
    [{ operationKey, outcome: 'retry', reason: 'Этикетка видна' }],
    [{ operationKey, outcome: 'not_printed', reason: '  x  ' }],
    [{ operationKey, outcome: 'not_printed', reason: 'x'.repeat(501) }],
  ])('rejects an invalid decision payload', async (input) => {
    const dto = plainToInstance(AdminPalletPrintReconciliationDto, input);
    expect(await validate(dto)).not.toHaveLength(0);
  });
});
