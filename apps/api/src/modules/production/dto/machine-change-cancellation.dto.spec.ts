import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CancelMachineChangeDto } from './machine-change.dto';

describe('CancelMachineChangeDto', () => {
  it('normalizes the command key and mandatory reason', async () => {
    const dto = plainToInstance(CancelMachineChangeDto, {
      operationKey: ' 27C8446A-9F62-4FEF-B1CA-FB8B2F67EC79 ',
      reason: '  Назначение исправлено  ',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto).toEqual({
      operationKey: '27c8446a-9f62-4fef-b1ca-fb8b2f67ec79',
      reason: 'Назначение исправлено',
    });
  });

  it.each([
    { operationKey: 'invalid', reason: 'Причина' },
    { operationKey: '27c8446a-9f62-4fef-b1ca-fb8b2f67ec79', reason: ' ' },
    {
      operationKey: '27c8446a-9f62-4fef-b1ca-fb8b2f67ec79',
      reason: 'x'.repeat(501),
    },
  ])('rejects an unsafe cancellation payload', async (value) => {
    expect(await validate(plainToInstance(CancelMachineChangeDto, value))).not.toHaveLength(0);
  });
});
