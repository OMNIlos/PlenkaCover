import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ChangePasswordDto } from './change-password.dto';

describe('ChangePasswordDto', () => {
  it('accepts a four-character new password', async () => {
    const errors = await validate(
      plainToInstance(ChangePasswordDto, {
        newPassword: '4826',
      }),
    );

    expect(errors).toHaveLength(0);
  });

  it('rejects a three-character new password', async () => {
    const errors = await validate(
      plainToInstance(ChangePasswordDto, {
        newPassword: '482',
      }),
    );

    expect(errors).not.toHaveLength(0);
  });
});
