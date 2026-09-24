import { validate } from 'class-validator';
import { CreatePenaltyDto } from './penalty.dto';

describe('CreatePenaltyDto', () => {
  it('rejects zero amount and blank disputed-action fields', async () => {
    const dto = Object.assign(new CreatePenaltyDto(), {
      targetRole: 'operator',
      amount: 0,
      reason: '',
      employeeId: '',
    });

    const errors = await validate(dto);

    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['amount', 'reason', 'employeeId']),
    );
  });

  it('accepts a positive penalty for an allowed active-role target shape', async () => {
    const dto = Object.assign(new CreatePenaltyDto(), {
      targetRole: 'production_lead',
      amount: 0.01,
      reason: 'Подтверждённое нарушение регламента',
      employeeId: 'production-lead-1',
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });
});
