import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Role, SessionPurpose } from '@plenka/contracts';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RUNTIME_CONFIG } from '../runtime-config.module';
import type { RuntimeConfig } from '../runtime-config';

export interface SessionActor {
  userId: string;
  role: Role;
}

export interface SessionPrincipal extends SessionActor {
  sessionId: string;
  purpose: SessionPurpose;
  overrides: Array<{ capability: string; effect: string }>;
}

type SessionClient = Pick<Prisma.TransactionClient, 'session'>;

export interface SessionMetadata {
  id: string;
  purpose: SessionPurpose;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  lastSeenAt: Date | null;
  userAgent: string | null;
  ip: string | null;
}

const SESSION_METADATA_SELECT = {
  id: true,
  purpose: true,
  createdAt: true,
  expiresAt: true,
  revokedAt: true,
  lastSeenAt: true,
  userAgent: true,
  ip: true,
} as const;

/**
 * Opaque, revocable server sessions (V2 S1). The raw token never lives in the DB —
 * we store only its sha256 hash, so a DB dump cannot be replayed. A session is valid
 * iff it exists AND is not revoked AND is not expired AND its user is active.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async issue(
    userId: string,
    meta: { userAgent?: string; ip?: string } = {},
    purpose: SessionPurpose = 'full',
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('hex');
    const ttl =
      purpose === 'password_setup'
        ? this.config.passwordSetupTtlSeconds
        : this.config.sessionTtlSeconds;
    const expiresAt = new Date(Date.now() + ttl * 1000);
    await this.prisma.session.create({
      data: {
        userId,
        tokenHash: this.hashToken(token),
        expiresAt,
        lastSeenAt: new Date(),
        userAgent: meta.userAgent,
        ip: meta.ip,
        purpose,
      },
    });
    return { token, expiresAt };
  }

  async validate(token: string): Promise<SessionPrincipal | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: this.hashToken(token) },
      include: { user: { include: { capabilityOverrides: true } } },
    });
    if (!session || session.revokedAt) return null;
    if (session.expiresAt.getTime() <= Date.now()) return null;
    if (!session.user.isActive) return null;
    if (session.purpose === 'full' && session.user.mustChangePassword) return null;
    if (session.purpose === 'password_setup' && !session.user.mustChangePassword) return null;
    if (session.purpose !== 'full' && session.purpose !== 'password_setup') return null;

    const lastSeenAt = session.lastSeenAt?.getTime() ?? 0;
    if (Date.now() - lastSeenAt > 300_000) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: { lastSeenAt: new Date() },
      });
    }

    return {
      sessionId: session.id,
      userId: session.userId,
      role: session.user.role,
      purpose: session.purpose,
      overrides: session.user.capabilityOverrides.map(({ capability, effect }) => ({
        capability,
        effect,
      })),
    };
  }

  async revoke(token: string): Promise<SessionActor | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: this.hashToken(token) },
      include: { user: true },
    });
    if (!session || session.revokedAt) return null;
    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
    return { userId: session.userId, role: session.user.role };
  }

  revokeAllForUser(
    userId: string,
    client: SessionClient = this.prisma,
  ): Promise<{ count: number }> {
    return client.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeById(
    userId: string,
    sessionId: string,
    client: SessionClient = this.prisma,
  ): Promise<boolean> {
    const result = await client.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count > 0;
  }

  listForUser(userId: string): Promise<SessionMetadata[]> {
    return this.prisma.session.findMany({
      where: { userId },
      select: SESSION_METADATA_SELECT,
      orderBy: { createdAt: 'desc' },
    }) as Promise<SessionMetadata[]>;
  }
}
