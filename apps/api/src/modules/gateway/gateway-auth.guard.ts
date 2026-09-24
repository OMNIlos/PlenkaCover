import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Machine authentication for the gateway routes (V2 S4): resolves the calling Post from its
 * agent token (`x-agent-token` header → sha256 → Post.agentTokenHash) and attaches it to the
 * request. This is NOT the user CapabilityGuard — the agent is a device, not a person; gateway
 * routes carry no @RequireCapabilities and are gated solely by this guard.
 */
@Injectable()
export class GatewayAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined>; post?: unknown }>();
    const token = req.headers['x-agent-token'];
    if (!token) throw new UnauthorizedException('Missing agent token.');
    const agentTokenHash = createHash('sha256').update(token).digest('hex');
    const post = await this.prisma.post.findUnique({ where: { agentTokenHash } });
    if (!post || post.status !== 'active') throw new UnauthorizedException('Invalid agent token.');
    req.post = post;
    return true;
  }
}
