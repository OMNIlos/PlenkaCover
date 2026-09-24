import { ForbiddenException } from '@nestjs/common';
import {
  CAPABILITIES,
  ROLES,
  ROLE_CAPABILITIES,
  type Capability,
  type Role,
} from '@plenka/contracts';
import { Prisma } from '@prisma/client';
import { AccessPolicyService } from '../../common/auth/access-policy.service';
import { AdminAccessService } from './admin-access.service';
import { AdminPrivilegeCeilingService } from './admin-privilege-ceiling.service';

const actor = {
  userId: 'admin-1',
  role: 'admin' as const,
  capabilities: ROLE_CAPABILITIES.admin,
};

type CapabilityCatalogItem = {
  key: Capability;
  label: string;
  description: string;
  group: string;
  baseRoles: Role[];
  grantable: boolean;
};

function denials(...capabilities: Capability[]) {
  return capabilities.map((capability) => ({
    capability,
    effect: 'deny',
    reason: 'Restricted authority',
  }));
}

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    externalId: null,
    login: 'operator',
    identityProvider: 'local',
    displayName: 'Operator',
    role: 'operator' as const,
    isActive: true,
    mustChangePassword: false,
    passwordChangedAt: null,
    lastLoginAt: null,
    createdAt: new Date('2026-07-17T00:00:00.000Z'),
    updatedAt: new Date('2026-07-17T00:00:00.000Z'),
    capabilityOverrides: [],
    sessions: [],
    ...overrides,
  };
}

function adminRow(id = 'admin-1', capabilityOverrides: ReturnType<typeof denials> = []) {
  return userRow({
    id,
    login: id,
    displayName: id,
    role: 'admin',
    capabilityOverrides,
  });
}

function templateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tpl-1',
    name: 'Operator review',
    role: 'operator' as const,
    setupStatus: 'active',
    capabilityGrants: ['finance_order:read'],
    capabilityDenials: [],
    version: 1,
    isSystem: false,
    createdAt: new Date('2026-07-17T00:00:00.000Z'),
    updatedAt: new Date('2026-07-17T00:00:00.000Z'),
    ...overrides,
  };
}

interface SetupOptions {
  authority?: ReturnType<typeof userRow> | null;
  target?: ReturnType<typeof userRow>;
  template?: ReturnType<typeof templateRow>;
  auditFailure?: Error;
}

function setup(options: SetupOptions = {}) {
  const authority = options.authority === undefined ? adminRow() : options.authority;
  const target = options.target ?? userRow();
  const template = options.template ?? templateRow();
  const rows = new Map<string, ReturnType<typeof userRow>>();
  if (authority) rows.set(authority.id, authority);
  rows.set(target.id, target);
  const templates = new Map([[template.id, template]]);

  const tx = {
    user: {
      findUnique: jest.fn().mockImplementation(({ where }) => rows.get(where.id) ?? null),
      update: jest.fn().mockImplementation(({ where, data }) => {
        const current = rows.get(where.id);
        if (!current) return null;
        const updated = { ...current, ...data, updatedAt: new Date() };
        rows.set(where.id, updated);
        return updated;
      }),
      updateMany: jest.fn(),
    },
    userCapabilityOverride: {
      deleteMany: jest.fn().mockImplementation(({ where }) => {
        const current = rows.get(where.userId);
        if (current) rows.set(where.userId, { ...current, capabilityOverrides: [] });
        return { count: current?.capabilityOverrides.length ?? 0 };
      }),
      createMany: jest.fn().mockImplementation(({ data }) => {
        const current = rows.get(data[0]?.userId);
        if (current) {
          rows.set(data[0].userId, {
            ...current,
            capabilityOverrides: data.map(
              (item: { capability: string; effect: string; reason: string }) => ({
                capability: item.capability,
                effect: item.effect,
                reason: item.reason,
              }),
            ),
          });
        }
        return { count: data.length };
      }),
      updateMany: jest.fn(),
    },
    session: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    accessTemplate: {
      findUnique: jest.fn().mockImplementation(({ where }) => templates.get(where.id) ?? null),
      findFirst: jest
        .fn()
        .mockImplementation(({ where }) =>
          [...templates.values()].find(
            (item) => item.role === where.role && item.isSystem === where.isSystem,
          ),
        ),
      updateMany: jest.fn().mockImplementation(({ where, data }) => {
        const current = templates.get(where.id);
        if (!current || current.version !== where.version) return { count: 0 };
        templates.set(where.id, {
          ...current,
          name: data.name,
          role: data.role,
          setupStatus: data.setupStatus,
          capabilityGrants: data.capabilityGrants,
          capabilityDenials: data.capabilityDenials,
          version: current.version + 1,
          updatedAt: new Date(),
        });
        return { count: 1 };
      }),
      create: jest.fn().mockImplementation(({ data }) => {
        const created = templateRow({ id: 'created-template', ...data });
        templates.set(created.id, created);
        return created;
      }),
    },
  };
  const prisma = {
    $transaction: jest.fn((work: (client: typeof tx) => unknown, _options?: unknown) => work(tx)),
    user: tx.user,
    accessTemplate: {
      findMany: jest.fn().mockResolvedValue([template]),
      findUnique: jest.fn().mockResolvedValue(template),
      findFirst: jest.fn().mockResolvedValue(template),
    },
  };
  const audit = {
    record: options.auditFailure
      ? jest.fn().mockRejectedValue(options.auditFailure)
      : jest.fn().mockResolvedValue({ id: 'event-1' }),
  };
  const sessions = {
    revokeAllForUser: jest.fn().mockImplementation((_id, client) =>
      client.session.updateMany({
        where: { userId: target.id, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      }),
    ),
  };
  const safety = { assertControlAdminRemains: jest.fn().mockResolvedValue(undefined) };
  const accessPolicy = new AccessPolicyService();
  const ceiling = new AdminPrivilegeCeilingService(accessPolicy);
  const service = new AdminAccessService(
    prisma as never,
    audit as never,
    accessPolicy,
    sessions as never,
    safety as never,
    ceiling,
  );
  return { service, prisma, tx, audit, sessions, safety, rows, templates };
}

describe('AdminAccessService', () => {
  it('returns every contract capability in canonical order with complete Russian metadata', async () => {
    const { service, prisma } = setup();

    const catalog = (await service.listCapabilities(actor)) as CapabilityCatalogItem[];

    expect(catalog.map((item) => item.key)).toEqual([...CAPABILITIES]);
    expect(catalog).toHaveLength(CAPABILITIES.length);
    for (const item of catalog) {
      expect(item.label).toMatch(/[А-Яа-яЁё]/);
      expect(item.description).toMatch(/[А-Яа-яЁё]/);
      expect(item.group).toMatch(/[А-Яа-яЁё]/);
      expect(item.baseRoles).toEqual(
        ROLES.filter((role) => ROLE_CAPABILITIES[role].includes(item.key)),
      );
      expect(typeof item.grantable).toBe('boolean');
    }
    expect(catalog.find(({ key }) => key === 'roll:weigh')).toEqual({
      key: 'roll:weigh',
      label: 'Взвешивание рулона',
      description: 'Фиксировать подтвержденный вес рулона в операторском процессе.',
      group: 'Оператор',
      baseRoles: ['operator'],
      grantable: true,
    });
    expect(catalog.find(({ key }) => key === 'admin:users')).toMatchObject({
      baseRoles: ['admin'],
      grantable: false,
    });
    expect(catalog.find(({ key }) => key === 'override:finance')).toMatchObject({
      baseRoles: ['director'],
      grantable: false,
    });
    expect(catalog.find(({ key }) => key === 'payroll_tariff:manage')).toEqual({
      key: 'payroll_tariff:manage',
      label: 'Управление приказами по тарифам',
      description: 'Создавать, проверять и публиковать версии приказов по сдельным тарифам.',
      group: 'Директор',
      baseRoles: ['director'],
      grantable: true,
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'admin-1' },
        select: expect.objectContaining({
          id: true,
          role: true,
          isActive: true,
          mustChangePassword: true,
          capabilityOverrides: { select: { capability: true, effect: true } },
        }),
      }),
    );
  });

  it('derives grantability from fresh persisted authority instead of request claims', async () => {
    const { service } = setup({
      authority: adminRow('admin-1', denials('admin:diagnostics')),
    });

    const catalog = (await service.listCapabilities(actor)) as CapabilityCatalogItem[];

    expect(catalog.find(({ key }) => key === 'finance_order:read')).toMatchObject({
      grantable: false,
    });
  });

  it('returns the same deterministic catalog for repeated reads by unchanged authority', async () => {
    const { service } = setup();

    const first = await service.listCapabilities(actor);
    const second = await service.listCapabilities(actor);

    expect(first).toEqual(second);
  });

  it('atomically replaces role/overrides, revokes sessions and audits old/new policy', async () => {
    const { service, prisma, tx, audit } = setup();
    const result = await service.replaceUserAccess(actor, 'u1', {
      role: 'operator',
      grants: ['finance_order:read'],
      denials: ['operator_task:read'],
      reason: 'Temporary cross-contour review',
    });
    expect(tx.userCapabilityOverride.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(tx.userCapabilityOverride.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ capability: 'finance_order:read', effect: 'allow' }),
          expect.objectContaining({ capability: 'operator_task:read', effect: 'deny' }),
        ]),
      }),
    );
    expect(tx.session.updateMany).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'admin.user.access_updated', actorRole: 'admin' }),
      tx,
    );
    expect(result.capabilities).toContain('finance_order:read');
    expect(prisma.$transaction.mock.calls[0][1]).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  });

  it.each([
    [
      'replace user access',
      (service: AdminAccessService) =>
        service.replaceUserAccess(actor, 'u1', {
          role: 'operator',
          grants: [],
          denials: [],
          reason: 'Access review',
        }),
    ],
    [
      'apply template',
      (service: AdminAccessService) =>
        service.applyTemplate(actor, 'u1', { templateId: 'tpl-1', reason: 'Access review' }),
    ],
    [
      'create template',
      (service: AdminAccessService) =>
        service.createTemplate(actor, {
          name: 'Operator',
          role: 'operator',
          grants: [],
          denials: [],
          reason: 'Template review',
        }),
    ],
    [
      'update template',
      (service: AdminAccessService) =>
        service.updateTemplate(actor, 'tpl-1', {
          expectedVersion: 1,
          name: 'Updated',
          reason: 'Template review',
        }),
    ],
  ])('rejects %s when fresh DB authority has only admin:users', async (_label, operation) => {
    const onlyUsers = denials(
      ...ROLE_CAPABILITIES.admin.filter((capability) => capability !== 'admin:users'),
    );
    const { service, tx, audit } = setup({ authority: adminRow('admin-1', onlyUsers) });

    await expect(operation(service)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.accessTemplate.create).not.toHaveBeenCalled();
    expect(tx.accessTemplate.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects template mutation when fresh DB authority has only admin:role_templates', async () => {
    const onlyTemplates = denials(
      ...ROLE_CAPABILITIES.admin.filter((capability) => capability !== 'admin:role_templates'),
    );
    const { service, tx, audit } = setup({ authority: adminRow('admin-1', onlyTemplates) });

    await expect(
      service.createTemplate(actor, {
        name: 'Operator',
        role: 'operator',
        grants: [],
        denials: [],
        reason: 'Template review',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.accessTemplate.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('does not let a restricted actor remove its own denial', async () => {
    const restricted = denials('admin:diagnostics');
    const { service, tx, audit } = setup({
      authority: adminRow('admin-1', restricted),
      target: adminRow('admin-1', restricted),
    });

    await expect(
      service.replaceUserAccess(actor, 'admin-1', {
        role: 'admin',
        grants: [],
        denials: [],
        reason: 'Attempted self escalation',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('does not let a restricted actor downgrade a superior current target', async () => {
    const restricted = denials('admin:diagnostics');
    const { service, tx } = setup({
      authority: adminRow('admin-1', restricted),
      target: adminRow('peer-admin'),
    });

    await expect(
      service.replaceUserAccess(actor, 'peer-admin', {
        role: 'admin',
        grants: [],
        denials: ['admin:diagnostics'],
        reason: 'Attempted superior downgrade',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('does not let a restricted actor grant a prospective superset to an equal peer', async () => {
    const restricted = denials('admin:diagnostics');
    const { service, tx } = setup({
      authority: adminRow('admin-1', restricted),
      target: adminRow('peer-admin', restricted),
    });

    await expect(
      service.replaceUserAccess(actor, 'peer-admin', {
        role: 'admin',
        grants: [],
        denials: [],
        reason: 'Attempted peer escalation',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('lets a restricted actor further restrict an equal peer', async () => {
    const restricted = denials('admin:diagnostics');
    const { service } = setup({
      authority: adminRow('admin-1', restricted),
      target: adminRow('peer-admin', restricted),
    });

    await expect(
      service.replaceUserAccess(actor, 'peer-admin', {
        role: 'admin',
        grants: [],
        denials: ['admin:diagnostics', 'admin:source_health'],
        reason: 'Narrow peer authority',
      }),
    ).resolves.toMatchObject({ id: 'peer-admin' });
  });

  it('lets a full admin replace and apply full-admin peer access', async () => {
    const replace = setup({ target: adminRow('peer-admin') });
    await expect(
      replace.service.replaceUserAccess(actor, 'peer-admin', {
        role: 'admin',
        grants: [],
        denials: [],
        reason: 'Full peer review',
      }),
    ).resolves.toMatchObject({ id: 'peer-admin', role: 'admin' });

    const apply = setup({
      target: adminRow('peer-admin'),
      template: templateRow({
        role: 'admin',
        capabilityGrants: [],
        capabilityDenials: [],
      }),
    });
    await expect(
      apply.service.applyTemplate(actor, 'peer-admin', {
        templateId: 'tpl-1',
        reason: 'Apply full peer preset',
      }),
    ).resolves.toMatchObject({ id: 'peer-admin', role: 'admin' });
  });

  it('checks both current and prospective template policy even while draft', async () => {
    const restricted = denials('admin:diagnostics');
    const currentSuperior = setup({
      authority: adminRow('admin-1', restricted),
      template: templateRow({
        role: 'admin',
        setupStatus: 'draft',
        capabilityGrants: [],
        capabilityDenials: [],
      }),
    });
    await expect(
      currentSuperior.service.updateTemplate(actor, 'tpl-1', {
        expectedVersion: 1,
        denials: ['admin:diagnostics'],
        reason: 'Attempted superior template downgrade',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const prospectiveSuperior = setup({
      authority: adminRow('admin-1', restricted),
      template: templateRow({
        role: 'admin',
        setupStatus: 'draft',
        capabilityGrants: [],
        capabilityDenials: ['admin:diagnostics'],
      }),
    });
    await expect(
      prospectiveSuperior.service.updateTemplate(actor, 'tpl-1', {
        expectedVersion: 1,
        denials: [],
        reason: 'Attempted template escalation',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('reads and applies an exact template version inside one transaction with provenance', async () => {
    const { service, prisma, tx, audit } = setup();

    await service.applyTemplate(actor, 'u1', {
      templateId: 'tpl-1',
      reason: 'Apply reviewed preset',
    });

    expect(tx.accessTemplate.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'tpl-1' } }),
    );
    expect(prisma.accessTemplate.findUnique).not.toHaveBeenCalled();
    expect(prisma.accessTemplate.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'admin.user.access_updated',
        newValue: expect.objectContaining({
          sourceTemplate: { templateId: 'tpl-1', templateVersion: 1 },
        }),
      }),
      tx,
    );
  });

  it('updates a template version transactionally without silently mutating assigned users', async () => {
    const { service, prisma, tx, audit } = setup();
    await service.updateTemplate(actor, 'tpl-1', {
      expectedVersion: 1,
      grants: ['finance_order:read'],
      denials: [],
      reason: 'Prepare a new preset version',
    });
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(tx.userCapabilityOverride.updateMany).not.toHaveBeenCalled();
    expect(tx.accessTemplate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'tpl-1', version: 1 } }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'admin.access_template.updated' }),
      tx,
    );
    expect(prisma.$transaction.mock.calls[0][1]).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  });

  it.each(['update', 'apply'])('propagates %s audit failure from the transaction', async (kind) => {
    const { service, tx } = setup({ auditFailure: new Error('forced audit failure') });
    const operation =
      kind === 'update'
        ? service.updateTemplate(actor, 'tpl-1', {
            expectedVersion: 1,
            name: 'Must Roll Back',
            reason: 'Audit rollback proof',
          })
        : service.applyTemplate(actor, 'u1', {
            templateId: 'tpl-1',
            reason: 'Audit rollback proof',
          });

    await expect(operation).rejects.toThrow('forced audit failure');
    if (kind === 'update') expect(tx.accessTemplate.updateMany).toHaveBeenCalled();
    else expect(tx.user.update).toHaveBeenCalled();
  });

  it('keeps access/template audit values free of credential and token material', async () => {
    const { service, audit, tx } = setup();
    await service.createTemplate(actor, {
      name: 'Safe template',
      role: 'operator',
      grants: [],
      denials: [],
      reason: 'Template provisioning',
    });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'admin.access_template.created' }),
      tx,
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toMatch(
      /password|passwordHash|temporaryPassword|token|tokenHash/i,
    );
  });

  it('rejects a create payload that grants and denies the same capability', async () => {
    const { service, prisma, tx, audit } = setup();

    await expect(
      service.createTemplate(actor, {
        name: 'Conflicting template',
        role: 'operator',
        grants: ['finance_order:read'],
        denials: ['finance_order:read'],
        reason: 'Conflict regression',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ADMIN_ACCESS_INVALID' }),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.accessTemplate.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects an edit that leaves one capability in both grants and denials', async () => {
    const { service, tx, audit } = setup();

    await expect(
      service.updateTemplate(actor, 'tpl-1', {
        expectedVersion: 1,
        denials: ['finance_order:read'],
        reason: 'Conflict regression',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ADMIN_ACCESS_INVALID' }),
    });
    expect(tx.accessTemplate.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects applying a persisted template with conflicting grants and denials', async () => {
    const { service, tx, audit } = setup({
      template: templateRow({
        capabilityGrants: ['finance_order:read'],
        capabilityDenials: ['finance_order:read'],
      }),
    });

    await expect(
      service.applyTemplate(actor, 'u1', {
        templateId: 'tpl-1',
        reason: 'Conflict regression',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ADMIN_ACCESS_INVALID' }),
    });
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
