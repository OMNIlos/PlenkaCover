import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Actor } from '../../common/auth/actor';
import { AccessPolicyService } from '../../common/auth/access-policy.service';
import { SessionService } from '../../common/auth/session.service';
import { AuditService } from '../../common/audit/audit.service';
import { generateTemporaryPassword, normalizeLogin } from '../../common/auth/password-policy';
import { hashPassword } from '../../common/auth/password';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ADMIN_USER_SELECT, projectAdminUser } from './admin-projection';
import { AdminSafetyService } from './admin-safety.service';
import { AdminPrivilegeCeilingService } from './admin-privilege-ceiling.service';
import { withSerializableRetry } from './admin-transaction';
import type { CreateAdminUserDto, UpdateAdminUserDto } from './dto/admin-account.dto';
import type { AdminUserQueryDto } from './dto/admin-query.dto';
import type { RevokeAdminSessionsDto } from './dto/admin-session.dto';

@Injectable()
export class AdminAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly accessPolicy: AccessPolicyService,
    private readonly sessions: SessionService,
    private readonly safety: AdminSafetyService,
    private readonly privilegeCeiling: AdminPrivilegeCeilingService,
  ) {}

  async list(query: AdminUserQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const where: Prisma.UserWhereInput = {
      ...(query.role ? { role: query.role } : {}),
      ...(query.search
        ? {
            OR: [
              { login: { contains: query.search.trim(), mode: 'insensitive' } },
              { displayName: { contains: query.search.trim(), mode: 'insensitive' } },
            ],
          }
        : {}),
      ...this.statusWhere(query.status),
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: ADMIN_USER_SELECT,
        orderBy: [{ role: 'asc' }, { displayName: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);
    return {
      items: rows.map((row) => projectAdminUser(row, this.accessPolicy)),
      page,
      pageSize,
      total,
    };
  }

  async get(userId: string) {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: ADMIN_USER_SELECT,
    });
    if (!row) throw new NotFoundException(`User ${userId} not found`);
    return projectAdminUser(row, this.accessPolicy);
  }

  async create(actor: Actor, dto: CreateAdminUserDto) {
    const login = normalizeLogin(dto.login);
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = hashPassword(temporaryPassword);

    try {
      const row = await withSerializableRetry(this.prisma, async (tx) => {
        const authority = await this.privilegeCeiling.loadAuthority(tx, actor);
        this.privilegeCeiling.assertCanAdministerPolicy(authority, undefined, {
          role: dto.role,
          overrides: [],
        });
        const created = await tx.user.create({
          data: {
            login,
            displayName: dto.displayName.trim(),
            role: dto.role,
            identityProvider: 'local',
            passwordHash,
            mustChangePassword: true,
          },
          select: ADMIN_USER_SELECT,
        });
        await this.audit.record(
          {
            type: 'admin.user.created',
            actorRole: authority.actorRole,
            actorId: authority.actorId,
            objectId: created.id,
            newValue: {
              login,
              displayName: created.displayName,
              role: created.role,
              identityProvider: created.identityProvider,
              isActive: created.isActive,
              mustChangePassword: created.mustChangePassword,
            },
            reason: 'account provisioning',
          },
          tx,
        );
        return created;
      });
      return { user: projectAdminUser(row, this.accessPolicy), temporaryPassword };
    } catch (error) {
      this.rethrowLoginConflict(error);
      throw error;
    }
  }

  async updateProfile(actor: Actor, userId: string, dto: UpdateAdminUserDto) {
    const login = dto.login === undefined ? undefined : normalizeLogin(dto.login);
    try {
      const row = await withSerializableRetry(this.prisma, async (tx) => {
        const authority = await this.privilegeCeiling.loadAuthority(tx, actor);
        const current = await tx.user.findUnique({
          where: { id: userId },
          select: ADMIN_USER_SELECT,
        });
        if (!current) throw new NotFoundException(`User ${userId} not found`);
        this.privilegeCeiling.assertCanAdministerTarget(authority, userId, {
          role: current.role,
          overrides: current.capabilityOverrides,
        });
        const updated = await tx.user.update({
          where: { id: userId },
          data: {
            ...(login !== undefined ? { login } : {}),
            ...(dto.displayName !== undefined ? { displayName: dto.displayName.trim() } : {}),
          },
          select: ADMIN_USER_SELECT,
        });
        await this.audit.record(
          {
            type: 'admin.user.profile_updated',
            actorRole: authority.actorRole,
            actorId: authority.actorId,
            objectId: userId,
            oldValue: { login: current.login, displayName: current.displayName },
            newValue: { login: updated.login, displayName: updated.displayName },
            reason: dto.reason,
          },
          tx,
        );
        return updated;
      });
      return projectAdminUser(row, this.accessPolicy);
    } catch (error) {
      this.rethrowLoginConflict(error);
      throw error;
    }
  }

  async block(actor: Actor, userId: string, reason: string) {
    const row = await withSerializableRetry(this.prisma, async (tx) => {
      const authority = await this.privilegeCeiling.loadAuthority(tx, actor);
      const current = await tx.user.findUnique({
        where: { id: userId },
        select: ADMIN_USER_SELECT,
      });
      if (!current) throw new NotFoundException(`User ${userId} not found`);
      this.privilegeCeiling.assertCanAdministerTarget(authority, userId, {
        role: current.role,
        overrides: current.capabilityOverrides,
      });
      await this.safety.assertControlAdminRemains(tx, userId, {
        role: current.role,
        isActive: false,
        overrides: current.capabilityOverrides,
      });
      const updated = await tx.user.update({
        where: { id: userId },
        data: { isActive: false },
        select: ADMIN_USER_SELECT,
      });
      const revoked = await this.sessions.revokeAllForUser(userId, tx);
      await this.audit.record(
        {
          type: 'admin.user.blocked',
          actorRole: authority.actorRole,
          actorId: authority.actorId,
          objectId: userId,
          oldValue: { isActive: current.isActive },
          newValue: { isActive: false, revokedSessions: revoked.count },
          reason,
        },
        tx,
      );
      return updated;
    });
    return projectAdminUser(row, this.accessPolicy);
  }

  async reactivate(actor: Actor, userId: string, reason: string) {
    const row = await withSerializableRetry(this.prisma, async (tx) => {
      const authority = await this.privilegeCeiling.loadAuthority(tx, actor);
      const current = await tx.user.findUnique({
        where: { id: userId },
        select: ADMIN_USER_SELECT,
      });
      if (!current) throw new NotFoundException(`User ${userId} not found`);
      this.privilegeCeiling.assertCanAdministerTarget(authority, userId, {
        role: current.role,
        overrides: current.capabilityOverrides,
      });
      const updated = await tx.user.update({
        where: { id: userId },
        data: { isActive: true },
        select: ADMIN_USER_SELECT,
      });
      await this.audit.record(
        {
          type: 'admin.user.reactivated',
          actorRole: authority.actorRole,
          actorId: authority.actorId,
          objectId: userId,
          oldValue: { isActive: current.isActive },
          newValue: { isActive: true },
          reason,
        },
        tx,
      );
      return updated;
    });
    return projectAdminUser(row, this.accessPolicy);
  }

  async resetPassword(actor: Actor, userId: string, reason: string) {
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = hashPassword(temporaryPassword);
    const row = await withSerializableRetry(this.prisma, async (tx) => {
      const authority = await this.privilegeCeiling.loadAuthority(tx, actor);
      const current = await tx.user.findUnique({
        where: { id: userId },
        select: ADMIN_USER_SELECT,
      });
      if (!current) throw new NotFoundException(`User ${userId} not found`);
      this.privilegeCeiling.assertCanAdministerTarget(authority, userId, {
        role: current.role,
        overrides: current.capabilityOverrides,
      });
      const updated = await tx.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          identityProvider: 'local',
          mustChangePassword: true,
          passwordChangedAt: null,
        },
        select: ADMIN_USER_SELECT,
      });
      const revoked = await this.sessions.revokeAllForUser(userId, tx);
      await this.audit.record(
        {
          type: 'admin.user.password_reset',
          actorRole: authority.actorRole,
          actorId: authority.actorId,
          objectId: userId,
          detail: { revokedSessions: revoked.count },
          oldValue: {
            identityProvider: current.identityProvider,
            mustChangePassword: current.mustChangePassword,
            passwordChangedAt: current.passwordChangedAt?.toISOString() ?? null,
          },
          newValue: {
            identityProvider: 'local',
            mustChangePassword: true,
            passwordChangedAt: null,
          },
          reason,
        },
        tx,
      );
      return updated;
    });
    return {
      user: projectAdminUser(row, this.accessPolicy),
      temporaryPassword,
    };
  }

  async listSessions(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException(`User ${userId} not found`);
    return this.sessions.listForUser(userId);
  }

  async revokeSessions(actor: Actor, userId: string, dto: RevokeAdminSessionsDto) {
    const revokedCount = await withSerializableRetry(this.prisma, async (tx) => {
      const authority = await this.privilegeCeiling.loadAuthority(tx, actor);
      const current = await tx.user.findUnique({
        where: { id: userId },
        select: ADMIN_USER_SELECT,
      });
      if (!current) throw new NotFoundException(`User ${userId} not found`);
      this.privilegeCeiling.assertCanAdministerTarget(authority, userId, {
        role: current.role,
        overrides: current.capabilityOverrides,
      });
      let count: number;
      if (dto.sessionId) {
        const revoked = await this.sessions.revokeById(userId, dto.sessionId, tx);
        if (!revoked) throw new NotFoundException(`Active session ${dto.sessionId} not found`);
        count = 1;
      } else {
        count = (await this.sessions.revokeAllForUser(userId, tx)).count;
      }
      await this.audit.record(
        {
          type: 'audit:session_revoked',
          actorRole: authority.actorRole,
          actorId: authority.actorId,
          objectId: userId,
          detail: { sessionId: dto.sessionId ?? null, revokedCount: count },
          reason: dto.reason,
        },
        tx,
      );
      return count;
    });
    return { ok: true as const, revokedCount };
  }

  private statusWhere(status: AdminUserQueryDto['status']): Prisma.UserWhereInput {
    if (status === 'blocked') return { isActive: false };
    if (status === 'password_setup') return { isActive: true, mustChangePassword: true };
    if (status === 'active') return { isActive: true, mustChangePassword: false };
    return {};
  }

  private rethrowLoginConflict(error: unknown): void {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException({
        code: 'ADMIN_LOGIN_CONFLICT',
        message: 'An account with this login already exists.',
      });
    }
  }
}
