import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { GatewayAuthGuard } from './gateway-auth.guard';

const sha = (t: string) => createHash('sha256').update(t).digest('hex');

function contextWith(headers: Record<string, string>) {
  const req: Record<string, unknown> = { headers };
  const exec = {
    switchToHttp: () => ({ getRequest: () => req }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { req, exec };
}

describe('GatewayAuthGuard', () => {
  it('attaches the post for a valid agent token', async () => {
    const post = { id: 'post-1', code: 'POST-1', status: 'active' };
    const prisma = { post: { findUnique: jest.fn().mockResolvedValue(post) } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = new GatewayAuthGuard(prisma as any);
    const { req, exec } = contextWith({ 'x-agent-token': 'tok' });
    await expect(guard.canActivate(exec)).resolves.toBe(true);
    expect(prisma.post.findUnique).toHaveBeenCalledWith({ where: { agentTokenHash: sha('tok') } });
    expect(req.post).toBe(post);
  });

  it('rejects a missing agent token (no DB hit)', async () => {
    const prisma = { post: { findUnique: jest.fn() } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = new GatewayAuthGuard(prisma as any);
    const { exec } = contextWith({});
    await expect(guard.canActivate(exec)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.post.findUnique).not.toHaveBeenCalled();
  });

  it('rejects an unknown agent token', async () => {
    const prisma = { post: { findUnique: jest.fn().mockResolvedValue(null) } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = new GatewayAuthGuard(prisma as any);
    const { exec } = contextWith({ 'x-agent-token': 'bad' });
    await expect(guard.canActivate(exec)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a valid token belonging to a disabled post', async () => {
    const prisma = {
      post: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'post-1',
          code: 'POST-1',
          status: 'inactive',
        }),
      },
    };
    const guard = new GatewayAuthGuard(prisma as never);
    const { exec } = contextWith({ 'x-agent-token': 'tok' });
    await expect(guard.canActivate(exec)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
