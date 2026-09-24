import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ReplaceUserAccessDto } from './admin-access.dto';
import { AdminReasonDto, CreateAdminUserDto } from './admin-account.dto';

describe('admin DTO normalization', () => {
  it('rejects whitespace-only audit reasons', async () => {
    const lifecycle = plainToInstance(AdminReasonDto, { reason: '   ' });
    const access = plainToInstance(ReplaceUserAccessDto, {
      role: 'operator',
      grants: [],
      denials: [],
      reason: '   ',
    });
    expect(await validate(lifecycle)).not.toHaveLength(0);
    expect(await validate(access)).not.toHaveLength(0);
  });

  it('trims display names and reasons before validation', async () => {
    const user = plainToInstance(CreateAdminUserDto, {
      login: 'operator.2',
      displayName: '   ',
      role: 'operator',
    });
    const reason = plainToInstance(AdminReasonDto, { reason: '  Valid reason  ' });
    expect(await validate(user)).not.toHaveLength(0);
    expect(await validate(reason)).toHaveLength(0);
    expect(reason.reason).toBe('Valid reason');
  });
});
