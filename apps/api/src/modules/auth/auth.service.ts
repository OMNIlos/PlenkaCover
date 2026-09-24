import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { SessionService } from '../../common/auth/session.service';
import { hashPassword, verifyLoginPassword, verifyPassword } from '../../common/auth/password';
import { assertPasswordPolicy, normalizeLogin } from '../../common/auth/password-policy';
import type { Actor } from '../../common/auth/actor';
import type { ChangePasswordDto } from './dto/change-password.dto';

const ANONYMOUS_LOGIN_FAILURE_AUDIT = {
  type: 'audit:auth_login_failed',
  actorRole: 'admin' as const,
  actorId: null,
  objectId: null,
  reason: 'invalid credentials',
  detail: { source: 'system', subject: 'anonymous_authentication_attempt' },
};

/**
 * Real identity for V2 S1: validates credentials, mints/revokes opaque sessions, and
 * audits auth facts (ТЗ §2 main vulnerability — replace the x-role mock). Capabilities
 * stay derived from role server-side; this service never widens a role's powers.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  async login(login: string, password: string, meta: { userAgent?: string; ip?: string } = {}) {
    let normalizedLogin: string;
    try {
      normalizedLogin = normalizeLogin(login);
    } catch {
      verifyLoginPassword(password, undefined);
      return this.rejectInvalidCredentials();
    }
    const user = await this.prisma.user.findUnique({ where: { login: normalizedLogin } });
    const localPasswordHash = user?.identityProvider === 'local' ? user.passwordHash : undefined;
    const passwordMatches = verifyLoginPassword(password, localPasswordHash);
    const ok =
      !!user &&
      user.isActive &&
      user.identityProvider === 'local' &&
      !!user.passwordHash &&
      passwordMatches;

    if (!ok) {
      return this.rejectInvalidCredentials();
    }

    const purpose = user.mustChangePassword ? 'password_setup' : 'full';
    const { token, expiresAt } = await this.sessions.issue(user.id, meta, purpose);
    if (purpose === 'full') {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });
    }
    await this.audit.record({
      type: 'audit:auth_login',
      actorRole: user.role,
      actorId: user.id,
      objectId: user.id,
    });
    return {
      token,
      expiresAt,
      passwordChangeRequired: purpose === 'password_setup',
      user: { id: user.id, role: user.role, displayName: user.displayName },
    };
  }

  private async rejectInvalidCredentials(): Promise<never> {
    try {
      await this.audit.record(ANONYMOUS_LOGIN_FAILURE_AUDIT);
    } catch {
      // Credential responses must not disclose whether the anonymous security-event write failed.
    }
    throw new UnauthorizedException('Invalid login or password.');
  }

  async logout(token: string): Promise<{ ok: true }> {
    const actor = await this.sessions.revoke(token);
    if (actor) {
      await this.audit.record({
        type: 'audit:auth_logout',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: actor.userId,
      });
    }
    return { ok: true };
  }

  async changePassword(
    actor: Actor,
    dto: ChangePasswordDto,
  ): Promise<{ ok: true; reauthenticationRequired: true }> {
    if (!actor.userId || !actor.sessionId || !actor.sessionPurpose) {
      throw new UnauthorizedException('Authentication required.');
    }
    const user = await this.prisma.user.findUnique({ where: { id: actor.userId } });
    if (!user?.isActive || user.identityProvider !== 'local' || !user.passwordHash) {
      throw new UnauthorizedException('Authentication required.');
    }
    if (actor.sessionPurpose === 'full') {
      if (!dto.currentPassword) {
        throw new BadRequestException({
          code: 'AUTH_CURRENT_PASSWORD_REQUIRED',
          message: 'Current password is required.',
        });
      }
      if (!verifyPassword(dto.currentPassword, user.passwordHash)) {
        throw new UnauthorizedException('Current password is invalid.');
      }
    }

    assertPasswordPolicy(dto.newPassword, user.login, dto.currentPassword);
    if (verifyPassword(dto.newPassword, user.passwordHash)) {
      throw new BadRequestException({
        code: 'AUTH_PASSWORD_POLICY',
        message: 'The new password must differ from the current password.',
      });
    }

    const passwordHash = hashPassword(dto.newPassword);
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: {
          id: user.id,
          isActive: true,
          identityProvider: 'local',
          mustChangePassword: actor.sessionPurpose === 'password_setup',
          passwordHash: user.passwordHash,
        },
        data: {
          passwordHash,
          mustChangePassword: false,
          passwordChangedAt: new Date(),
        },
      });
      if (updated.count !== 1) {
        throw new UnauthorizedException('Password state changed. Sign in again.');
      }
      await this.sessions.revokeAllForUser(user.id, tx);
      await this.audit.record(
        {
          type: 'audit:password_changed',
          actorRole: user.role,
          actorId: user.id,
          objectId: user.id,
        },
        tx,
      );
    });

    return { ok: true, reauthenticationRequired: true };
  }

  async me(actor: Actor) {
    if (!actor.userId) throw new UnauthorizedException();
    const user = await this.prisma.user.findUnique({ where: { id: actor.userId } });
    if (!user?.isActive) throw new UnauthorizedException();
    const session = actor.sessionId
      ? await this.prisma.session.findUnique({ where: { id: actor.sessionId } })
      : null;
    const sessionState = !session
      ? null
      : session.revokedAt
        ? 'revoked'
        : session.expiresAt.getTime() <= Date.now()
          ? 'expired'
          : 'active';
    return {
      userId: actor.userId,
      role: actor.role,
      capabilities: actor.capabilities,
      displayName: user.displayName,
      isActive: user.isActive,
      sessionPurpose: actor.sessionPurpose ?? null,
      session: session
        ? {
            id: session.id,
            purpose: session.purpose,
            state: sessionState,
            createdAt: session.createdAt,
            expiresAt: session.expiresAt,
            lastSeenAt: session.lastSeenAt,
          }
        : null,
      workContext: {
        kind: actor.role === 'operator' ? 'operator_post' : 'office',
        assignment: null,
      },
      passwordChangeRequired: user.mustChangePassword,
    };
  }
}
