import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Actor } from '../../common/auth/actor';
import { PrismaService } from '../../common/prisma/prisma.service';

type BrowserSessionClient = Pick<Prisma.TransactionClient, 'session'>;

@Injectable()
export class WarehouseBrowserSessionService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(actor: Actor, client: BrowserSessionClient = this.prisma) {
    const identity = this.requireIdentity(actor);
    const session = await client.session.findFirst({
      where: {
        id: identity.sessionId,
        userId: identity.userId,
        purpose: 'full',
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!session) throw this.sessionRequired();
    return { session };
  }

  private requireIdentity(actor: Actor) {
    if (!actor.userId || !actor.sessionId || actor.sessionPurpose !== 'full') {
      throw this.sessionRequired();
    }
    return { userId: actor.userId, sessionId: actor.sessionId };
  }

  private sessionRequired() {
    return new UnauthorizedException({
      code: 'WAREHOUSE_SESSION_REQUIRED',
      message: 'Для складской операции нужна действующая полная сессия пользователя.',
    });
  }
}
