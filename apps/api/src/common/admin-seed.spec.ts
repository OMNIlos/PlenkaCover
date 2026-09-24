import { ROLES } from '@plenka/contracts';
import { seedSystemAccessTemplates } from './seed/admin-access-seed';

describe('admin access seed', () => {
  it('upserts one stable active system preset for every role', async () => {
    const prisma = { accessTemplate: { upsert: jest.fn().mockResolvedValue({}) } };
    await seedSystemAccessTemplates(prisma as never);
    expect(prisma.accessTemplate.upsert).toHaveBeenCalledTimes(ROLES.length);
    for (const role of ROLES) {
      expect(prisma.accessTemplate.upsert).toHaveBeenCalledWith({
        where: { id: `tpl-${role}` },
        update: expect.objectContaining({
          name: expect.any(String),
          role,
          isSystem: true,
          capabilityGrants: [],
          capabilityDenials: [],
          version: 1,
        }),
        create: expect.objectContaining({
          id: `tpl-${role}`,
          name: expect.any(String),
          role,
          setupStatus: 'active',
          assignments: [],
          isSystem: true,
          capabilityGrants: [],
          capabilityDenials: [],
          version: 1,
        }),
      });
    }
  });

  it('uses create-only upserts for pilot bootstrap', async () => {
    const prisma = { accessTemplate: { upsert: jest.fn().mockResolvedValue({}) } };

    await seedSystemAccessTemplates(prisma as never, { createOnly: true });

    expect(prisma.accessTemplate.upsert).toHaveBeenCalledTimes(ROLES.length);
    for (const call of prisma.accessTemplate.upsert.mock.calls) {
      expect(call[0].update).toEqual({});
    }
  });
});
