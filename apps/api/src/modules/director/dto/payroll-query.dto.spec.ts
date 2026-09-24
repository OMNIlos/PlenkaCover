import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DirectorPayrollQueryDto } from './payroll-query.dto';

describe('DirectorPayrollQueryDto', () => {
  it.each([
    {},
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-08-01', to: '2026-07-01' },
    { from: '2025-01-01', to: '2026-01-02' },
  ])('rejects invalid payroll range %j', async (value) => {
    expect(await validate(plainToInstance(DirectorPayrollQueryDto, value))).not.toHaveLength(0);
  });

  it('accepts one through 366 inclusive Moscow dates', async () => {
    expect(
      await validate(
        plainToInstance(DirectorPayrollQueryDto, {
          from: '2024-01-01',
          to: '2024-12-31',
        }),
      ),
    ).toHaveLength(0);
  });
});
