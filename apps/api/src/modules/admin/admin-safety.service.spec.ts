import { AccessPolicyService } from '../../common/auth/access-policy.service';
import { AdminSafetyService } from './admin-safety.service';

const adminState = (overrides: Array<{ capability: string; effect: string }> = []) => ({
  id: 'admin-1',
  role: 'admin',
  isActive: true,
  capabilityOverrides: overrides,
});

describe('AdminSafetyService', () => {
  const service = new AdminSafetyService(new AccessPolicyService());

  it('rejects removal of the last active control admin', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(adminState()),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    await expect(
      service.assertControlAdminRemains(prisma as never, 'admin-1', {
        role: 'admin',
        isActive: false,
        overrides: [],
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ADMIN_LAST_ACTIVE_ADMIN' }),
    });
  });

  it('allows removal when another control admin remains', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(adminState()),
        findMany: jest.fn().mockResolvedValue([{ ...adminState(), id: 'admin-2' }]),
      },
    };
    await expect(
      service.assertControlAdminRemains(prisma as never, 'admin-1', {
        role: 'admin',
        isActive: false,
        overrides: [],
      }),
    ).resolves.toBeUndefined();
  });
});
