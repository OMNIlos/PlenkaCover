import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AssignmentCancellationDto } from './assignment-cancellation.dto';

describe('AssignmentCancellationDto', () => {
  it('normalizes a valid idempotent cancellation command', async () => {
    const dto = plainToInstance(AssignmentCancellationDto, {
      operationKey: ' 27C8446A-9F62-4FEF-B1CA-FB8B2F67EC79 ',
      reason: '  Оператор назначен на другой пост  ',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto).toEqual({
      operationKey: '27c8446a-9f62-4fef-b1ca-fb8b2f67ec79',
      reason: 'Оператор назначен на другой пост',
    });
  });

  it.each([
    { operationKey: 'not-a-uuid', reason: 'Причина' },
    { operationKey: '27c8446a-9f62-4fef-b1ca-fb8b2f67ec79', reason: '   ' },
    {
      operationKey: '27c8446a-9f62-4fef-b1ca-fb8b2f67ec79',
      reason: 'x'.repeat(501),
    },
  ])('rejects an unsafe cancellation payload', async (value) => {
    const dto = plainToInstance(AssignmentCancellationDto, value);
    expect(await validate(dto)).not.toHaveLength(0);
  });
});
