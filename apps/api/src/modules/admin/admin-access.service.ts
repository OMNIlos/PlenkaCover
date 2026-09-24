import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Role } from '@plenka/contracts';
import type { Prisma } from '@prisma/client';
import {
  AccessPolicyService,
  type NormalizedAccessPolicy,
} from '../../common/auth/access-policy.service';
import type { Actor } from '../../common/auth/actor';
import { SessionService } from '../../common/auth/session.service';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  AdminPrivilegeCeilingService,
  type AdminAccessState,
  type AdminAuthority,
} from './admin-privilege-ceiling.service';
import { buildAdminCapabilityCatalog } from './admin-capability-catalog';
import { ADMIN_USER_SELECT, projectAdminUser, type AdminUserRow } from './admin-projection';
import { AdminSafetyService } from './admin-safety.service';
import { withSerializableRetry } from './admin-transaction';
import type {
  ApplyAccessTemplateDto,
  CreateAccessTemplateDto,
  ReplaceUserAccessDto,
  UpdateAccessTemplateDto,
} from './dto/admin-access.dto';

const TEMPLATE_SELECT = {
  id: true,
  name: true,
  role: true,
  setupStatus: true,
  capabilityGrants: true,
  capabilityDenials: true,
  version: true,
  isSystem: true,
  createdAt: true,
  updatedAt: true,
} as const;

type TemplateRow = Prisma.AccessTemplateGetPayload<{ select: typeof TEMPLATE_SELECT }>;

type SourceTemplate = {
  templateId: string;
  templateVersion: number;
};

@Injectable()
export class AdminAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly accessPolicy: AccessPolicyService,
    private readonly sessions: SessionService,
    private readonly safety: AdminSafetyService,
    private readonly privilegeCeiling: AdminPrivilegeCeilingService,
  ) {}

  async replaceUserAccess(actor: Actor, userId: string, dto: ReplaceUserAccessDto) {
    const policy = this.accessPolicy.validate(dto.role, dto.grants, dto.denials);
    const row = await withSerializableRetry(this.prisma, async (tx) => {
      const authority = await this.privilegeCeiling.loadAuthority(tx, actor);
      const current = await this.findUser(tx, userId);
      return this.replaceUserAccessInTransaction(
        tx,
        authority,
        userId,
        current,
        dto.role,
        policy,
        dto.reason,
      );
    });
    return projectAdminUser(row, this.accessPolicy);
  }

  async listTemplates() {
    const rows = await this.prisma.accessTemplate.findMany({
      select: TEMPLATE_SELECT,
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });
    return rows.map((row) => this.projectTemplate(row));
  }

  async listCapabilities(actor: Actor) {
    const authority = await this.privilegeCeiling.loadAuthority(this.prisma, actor);
    return buildAdminCapabilityCatalog((capability) =>
      this.privilegeCeiling.canGrantCapability(authority, capability),
    );
  }

  async createTemplate(actor: Actor, dto: CreateAccessTemplateDto) {
    const policy = this.accessPolicy.validate(dto.role, dto.grants, dto.denials);
    const row = await withSerializableRetry(this.prisma, async (tx) => {
      const authority = await this.privilegeCeiling.loadAuthority(tx, actor);
      this.privilegeCeiling.assertCanAdministerPolicy(
        authority,
        undefined,
        this.accessState(dto.role, policy),
      );
      const created = await tx.accessTemplate.create({
        data: {
          name: dto.name.trim(),
          role: dto.role,
          setupStatus: dto.setupStatus ?? 'draft',
          capabilityGrants: policy.grants,
          capabilityDenials: policy.denials,
          assignments: [],
          isSystem: false,
        },
        select: TEMPLATE_SELECT,
      });
      await this.audit.record(
        {
          type: 'admin.access_template.created',
          actorRole: authority.actorRole,
          actorId: authority.actorId,
          objectId: created.id,
          newValue: this.policySnapshot(created),
          reason: dto.reason,
        },
        tx,
      );
      return created;
    });
    return this.projectTemplate(row);
  }

  async updateTemplate(actor: Actor, templateId: string, dto: UpdateAccessTemplateDto) {
    const row = await withSerializableRetry(this.prisma, async (tx) => {
      const authority = await this.privilegeCeiling.loadAuthority(tx, actor);
      const current = await tx.accessTemplate.findUnique({
        where: { id: templateId },
        select: TEMPLATE_SELECT,
      });
      if (!current) throw new NotFoundException(`Template ${templateId} not found`);

      const role = dto.role ?? current.role;
      const currentPolicy = {
        grants: this.stringArray(current.capabilityGrants),
        denials: this.stringArray(current.capabilityDenials),
      };
      const policy = this.accessPolicy.validate(
        role,
        dto.grants ?? currentPolicy.grants,
        dto.denials ?? currentPolicy.denials,
      );
      this.privilegeCeiling.assertCanAdministerPolicy(
        authority,
        this.accessState(current.role, currentPolicy),
        this.accessState(role, policy),
      );

      const next = {
        name: dto.name?.trim() ?? current.name,
        role,
        setupStatus: dto.setupStatus ?? current.setupStatus,
        grants: policy.grants,
        denials: policy.denials,
        version: current.version + 1,
      };
      const updated = await tx.accessTemplate.updateMany({
        where: { id: templateId, version: dto.expectedVersion },
        data: {
          name: next.name,
          role: next.role,
          setupStatus: next.setupStatus,
          capabilityGrants: next.grants,
          capabilityDenials: next.denials,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException({
          code: 'ADMIN_TEMPLATE_VERSION_CONFLICT',
          message: 'The access template changed; reload it and retry.',
        });
      }
      await this.audit.record(
        {
          type: 'admin.access_template.updated',
          actorRole: authority.actorRole,
          actorId: authority.actorId,
          objectId: templateId,
          oldValue: this.policySnapshot(current),
          newValue: next,
          reason: dto.reason,
        },
        tx,
      );
      return {
        ...current,
        name: next.name,
        role: next.role,
        setupStatus: next.setupStatus,
        capabilityGrants: next.grants,
        capabilityDenials: next.denials,
        version: next.version,
        updatedAt: new Date(),
      };
    });
    return this.projectTemplate(row);
  }

  async applyTemplate(actor: Actor, userId: string, dto: ApplyAccessTemplateDto) {
    if (!!dto.templateId === !!dto.role) {
      throw new BadRequestException({
        code: 'ADMIN_ACCESS_INVALID',
        message: 'Provide exactly one of templateId or role.',
      });
    }

    const row = await withSerializableRetry(this.prisma, async (tx) => {
      const authority = await this.privilegeCeiling.loadAuthority(tx, actor);
      const template = dto.templateId
        ? await tx.accessTemplate.findUnique({
            where: { id: dto.templateId },
            select: TEMPLATE_SELECT,
          })
        : await tx.accessTemplate.findFirst({
            where: { role: dto.role, isSystem: true },
            select: TEMPLATE_SELECT,
          });
      if (!template) throw new NotFoundException('Access template not found');
      if (template.setupStatus !== 'active') {
        throw new BadRequestException({
          code: 'ADMIN_ACCESS_INVALID',
          message: 'Only an active access template can be applied.',
        });
      }

      const policy = this.accessPolicy.validate(
        template.role,
        this.stringArray(template.capabilityGrants),
        this.stringArray(template.capabilityDenials),
      );
      const current = await this.findUser(tx, userId);
      return this.replaceUserAccessInTransaction(
        tx,
        authority,
        userId,
        current,
        template.role,
        policy,
        dto.reason,
        { templateId: template.id, templateVersion: template.version },
      );
    });
    return projectAdminUser(row, this.accessPolicy);
  }

  private async replaceUserAccessInTransaction(
    tx: Prisma.TransactionClient,
    authority: AdminAuthority,
    userId: string,
    current: AdminUserRow,
    role: Role,
    policy: NormalizedAccessPolicy,
    reason: string,
    sourceTemplate?: SourceTemplate,
  ): Promise<AdminUserRow> {
    const prospectiveOverrides = this.policyOverrides(policy);
    this.privilegeCeiling.assertCanAdministerTarget(
      authority,
      userId,
      { role: current.role, overrides: current.capabilityOverrides },
      { role, overrides: prospectiveOverrides },
    );
    await this.safety.assertControlAdminRemains(tx, userId, {
      role,
      isActive: current.isActive,
      overrides: prospectiveOverrides,
    });
    await tx.user.update({ where: { id: userId }, data: { role } });
    await tx.userCapabilityOverride.deleteMany({ where: { userId } });
    if (prospectiveOverrides.length > 0) {
      await tx.userCapabilityOverride.createMany({
        data: prospectiveOverrides.map(({ capability, effect }) => ({
          userId,
          capability,
          effect,
          reason,
          createdById: authority.actorId,
          updatedById: authority.actorId,
        })),
      });
    }
    const revoked = await this.sessions.revokeAllForUser(userId, tx);
    await this.audit.record(
      {
        type: 'admin.user.access_updated',
        actorRole: authority.actorRole,
        actorId: authority.actorId,
        objectId: userId,
        oldValue: {
          role: current.role,
          grants: current.capabilityOverrides
            .filter((item) => item.effect === 'allow')
            .map((item) => item.capability),
          denials: current.capabilityOverrides
            .filter((item) => item.effect === 'deny')
            .map((item) => item.capability),
        },
        newValue: {
          role,
          grants: policy.grants,
          denials: policy.denials,
          revokedSessions: revoked.count,
          ...(sourceTemplate ? { sourceTemplate } : {}),
        },
        reason,
      },
      tx,
    );
    return this.findUser(tx, userId);
  }

  private async findUser(tx: Prisma.TransactionClient, userId: string): Promise<AdminUserRow> {
    const row = await tx.user.findUnique({
      where: { id: userId },
      select: ADMIN_USER_SELECT,
    });
    if (!row) throw new NotFoundException(`User ${userId} not found`);
    return row;
  }

  private accessState(
    role: Role,
    policy: { grants: readonly string[]; denials: readonly string[] },
  ): AdminAccessState {
    return { role, overrides: this.policyOverrides(policy) };
  }

  private policyOverrides(policy: { grants: readonly string[]; denials: readonly string[] }) {
    return [
      ...policy.grants.map((capability) => ({ capability, effect: 'allow' as const })),
      ...policy.denials.map((capability) => ({ capability, effect: 'deny' as const })),
    ];
  }

  private projectTemplate(row: TemplateRow) {
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      setupStatus: row.setupStatus,
      capabilityGrants: this.stringArray(row.capabilityGrants),
      capabilityDenials: this.stringArray(row.capabilityDenials),
      version: row.version,
      isSystem: row.isSystem,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private policySnapshot(row: TemplateRow) {
    return {
      name: row.name,
      role: row.role,
      setupStatus: row.setupStatus,
      grants: this.stringArray(row.capabilityGrants),
      denials: this.stringArray(row.capabilityDenials),
      version: row.version,
    };
  }

  private stringArray(value: Prisma.JsonValue): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  }
}
