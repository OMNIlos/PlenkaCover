import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateIndividualShiftDto } from './shift.dto';

function shiftWith(operationKey: string) {
  return plainToInstance(CreateIndividualShiftDto, {
    operatorId: 'operator-1',
    postId: 'post-1',
    operationKey,
  });
}

describe('CreateIndividualShiftDto', () => {
  it('rejects a non-v4 UUID operation key', async () => {
    const errors = await validate(shiftWith('6ba7b810-9dad-11d1-80b4-00c04fd430c8'));

    expect(errors).toEqual([
      expect.objectContaining({
        property: 'operationKey',
        constraints: expect.objectContaining({ isUuid: expect.any(String) }),
      }),
    ]);
  });

  it('accepts a v4 UUID operation key', async () => {
    await expect(validate(shiftWith('311f7d31-cf3d-4a51-af22-a961bc84e24a'))).resolves.toEqual([]);
  });
});
