import type { Actor } from '../../common/auth/actor';
import { WarehouseBrowserSessionService } from './warehouse-browser-session.service';

const ACTOR: Actor = {
  userId: 'warehouse-user',
  role: 'warehouse',
  capabilities: ['warehouse:scan'],
  sessionId: 'session-1',
  sessionPurpose: 'full',
};

describe('WarehouseBrowserSessionService', () => {
  it('resolves a full browser session without any production-post lookup', async () => {
    const prisma = {
      session: { findFirst: jest.fn().mockResolvedValue({ id: 'session-1' }) },
    };
    const service = new WarehouseBrowserSessionService(prisma as never);

    await expect(service.resolve(ACTOR)).resolves.toEqual({ session: { id: 'session-1' } });
    expect(prisma.session.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'session-1',
        userId: 'warehouse-user',
        purpose: 'full',
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      select: { id: true },
    });
    expect(prisma).not.toHaveProperty('post');
  });

  it('rejects a missing durable session', async () => {
    const prisma = { session: { findFirst: jest.fn().mockResolvedValue(null) } };
    const service = new WarehouseBrowserSessionService(prisma as never);

    await expect(service.resolve(ACTOR)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WAREHOUSE_SESSION_REQUIRED' }),
    });
  });

  it.each([
    { sessionId: undefined },
    { userId: null },
    { sessionPurpose: 'password_setup' as const },
  ])('rejects non-full browser identity %# before querying persistence', async (change) => {
    const prisma = { session: { findFirst: jest.fn() } };
    const service = new WarehouseBrowserSessionService(prisma as never);

    await expect(service.resolve({ ...ACTOR, ...change })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WAREHOUSE_SESSION_REQUIRED' }),
    });
    expect(prisma.session.findFirst).not.toHaveBeenCalled();
  });
});
