import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { capabilitiesForRole } from '@plenka/contracts';
import request from 'supertest';
import { SessionService } from '../src/common/auth/session.service';
import { AuditService } from '../src/common/audit/audit.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AdminAccountsService } from '../src/modules/admin/admin-accounts.service';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';
import { runE2eWithCleanup } from './e2e-database';

describe('Admin accounts and access (e2e, real DB)', () => {
  let app: INestApplication;
  const uniq = `${Date.now()}.${Math.floor(Math.random() * 10_000)}`;
  const login = `e2e.operator.${uniq}`;
  const newPassword = `e2e secure passphrase ${uniq}`;
  const previousDevActor = process.env.AUTH_DEV_XROLE;

  beforeAll(async () => {
    process.env.AUTH_DEV_XROLE = 'off';
    // AppModule reads authentication flags during module loading.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useLogger(false);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);
  });

  afterAll(async () => {
    await runE2eWithCleanup(
      async () => undefined,
      [
        { label: 'admin accounts application', run: async () => app?.close() },
        {
          label: 'admin accounts auth environment',
          run: () => {
            if (previousDevActor === undefined) delete process.env.AUTH_DEV_XROLE;
            else process.env.AUTH_DEV_XROLE = previousDevActor;
          },
        },
      ],
    );
  });

  it('provisions, sets up, customizes and blocks an account through Bearer auth', async () => {
    const http = () => request(app.getHttpServer());
    const adminLogin = await http()
      .post('/api/auth/login')
      .send({ login: e2eSeedLogin('admin'), password: e2eSeedPassword() })
      .expect(201);
    const asAdmin = { Authorization: `Bearer ${adminLogin.body.token as string}` };

    const created = await http()
      .post('/api/admin/users')
      .set(asAdmin)
      .send({ login, displayName: 'E2E Operator', role: 'operator' })
      .expect(201);
    expect(created.headers['cache-control']).toContain('no-store');
    expect(created.body.temporaryPassword).toHaveLength(24);
    expect(created.body.user.status).toBe('password_setup');
    expect(JSON.stringify(created.body)).not.toMatch(/passwordHash|tokenHash/);
    const userId = created.body.user.id as string;

    const setupLogin = await http()
      .post('/api/auth/login')
      .send({ login: login.toUpperCase(), password: created.body.temporaryPassword })
      .expect(201);
    expect(setupLogin.body.passwordChangeRequired).toBe(true);
    const asSetup = { Authorization: `Bearer ${setupLogin.body.token as string}` };
    const setupMe = await http().get('/api/auth/me').set(asSetup).expect(200);
    expect(setupMe.body).toMatchObject({
      sessionPurpose: 'password_setup',
      passwordChangeRequired: true,
      capabilities: [],
    });
    await http().get('/api/operator/runtime').set(asSetup).expect(403);

    await http().post('/api/auth/change-password').set(asSetup).send({ newPassword }).expect(201);
    await http().get('/api/auth/me').set(asSetup).expect(401);

    const fullLogin = await http()
      .post('/api/auth/login')
      .send({ login, password: newPassword })
      .expect(201);
    expect(fullLogin.body.passwordChangeRequired).toBe(false);
    const asOperator = { Authorization: `Bearer ${fullLogin.body.token as string}` };
    await http().get('/api/admin/users').set(asOperator).expect(403);

    const prisma = app.get(PrismaService);
    const audit = app.get(AuditService);
    const originalRecord = audit.record.bind(audit);
    const beforeAccessRollback = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { capabilityOverrides: true },
    });
    const sessionsBeforeAccessRollback = await prisma.session.count({
      where: { userId, revokedAt: null },
    });
    const accessEventsBeforeRollback = await prisma.domainEvent.count({
      where: { objectId: userId, type: 'admin.user.access_updated' },
    });
    const accessAuditSpy = jest.spyOn(audit, 'record').mockImplementation(async (input, client) => {
      if (input.type === 'admin.user.access_updated') throw new Error('forced audit failure');
      return originalRecord(input, client);
    });
    try {
      await http()
        .put(`/api/admin/users/${userId}/access`)
        .set(asAdmin)
        .send({
          role: 'operator',
          grants: ['finance_order:read'],
          denials: ['operator_task:read'],
          reason: 'E2E access rollback proof',
        })
        .expect(500);
    } finally {
      accessAuditSpy.mockRestore();
    }
    const afterAccessRollback = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { capabilityOverrides: true },
    });
    expect(afterAccessRollback.role).toBe(beforeAccessRollback.role);
    expect(afterAccessRollback.capabilityOverrides).toEqual(
      beforeAccessRollback.capabilityOverrides,
    );
    await expect(prisma.session.count({ where: { userId, revokedAt: null } })).resolves.toBe(
      sessionsBeforeAccessRollback,
    );
    await expect(
      prisma.domainEvent.count({
        where: { objectId: userId, type: 'admin.user.access_updated' },
      }),
    ).resolves.toBe(accessEventsBeforeRollback);

    const passwordBeforeRollback = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true },
    });
    const passwordEventsBeforeRollback = await prisma.domainEvent.count({
      where: { objectId: userId, type: 'admin.user.password_reset' },
    });
    const passwordAuditSpy = jest
      .spyOn(audit, 'record')
      .mockImplementation(async (input, client) => {
        if (input.type === 'admin.user.password_reset') throw new Error('forced audit failure');
        return originalRecord(input, client);
      });
    try {
      await http()
        .post(`/api/admin/users/${userId}/reset-password`)
        .set(asAdmin)
        .send({ reason: 'E2E password rollback proof' })
        .expect(500);
    } finally {
      passwordAuditSpy.mockRestore();
    }
    const passwordAfterRollback = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true },
    });
    expect(passwordAfterRollback.passwordHash).toBe(passwordBeforeRollback.passwordHash);
    await expect(prisma.session.count({ where: { userId, revokedAt: null } })).resolves.toBe(
      sessionsBeforeAccessRollback,
    );
    await expect(
      prisma.domainEvent.count({
        where: { objectId: userId, type: 'admin.user.password_reset' },
      }),
    ).resolves.toBe(passwordEventsBeforeRollback);

    const access = await http()
      .put(`/api/admin/users/${userId}/access`)
      .set(asAdmin)
      .send({
        role: 'operator',
        grants: ['finance_order:read'],
        denials: ['operator_task:read'],
        reason: 'E2E temporary cross-contour review',
      })
      .expect(200);
    expect(access.body.capabilities).toContain('finance_order:read');
    expect(access.body.capabilities).not.toContain('operator_task:read');
    await http().get('/api/auth/me').set(asOperator).expect(401);

    const relogin = await http()
      .post('/api/auth/login')
      .send({ login, password: newPassword })
      .expect(201);
    expect(relogin.body.passwordChangeRequired).toBe(false);
    const current = await http().get(`/api/admin/users/${userId}`).set(asAdmin).expect(200);
    expect(JSON.stringify(current.body)).not.toMatch(/passwordHash|tokenHash/);
    expect(current.body.capabilities).toContain('finance_order:read');

    const originalDisplayName = current.body.displayName as string;
    const auditSpy = jest.spyOn(audit, 'record').mockImplementation(async (input, client) => {
      if (input.type === 'admin.user.profile_updated') throw new Error('forced audit failure');
      return originalRecord(input, client);
    });
    try {
      await http()
        .patch(`/api/admin/users/${userId}`)
        .set(asAdmin)
        .send({ displayName: 'Must Roll Back', reason: 'E2E audit rollback proof' })
        .expect(500);
    } finally {
      auditSpy.mockRestore();
    }
    const afterAuditFailure = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(afterAuditFailure.displayName).toBe(originalDisplayName);

    const reset = await http()
      .post(`/api/admin/users/${userId}/reset-password`)
      .set(asAdmin)
      .send({ reason: 'E2E full-admin credential reset' })
      .expect(201);
    expect(reset.body.temporaryPassword).toHaveLength(24);
    await http()
      .post(`/api/admin/users/${userId}/block`)
      .set(asAdmin)
      .send({ reason: 'E2E full-admin lifecycle block' })
      .expect(200);
    await http()
      .post(`/api/admin/users/${userId}/reactivate`)
      .set(asAdmin)
      .send({ reason: 'E2E full-admin lifecycle reactivate' })
      .expect(200);
    await http()
      .post(`/api/admin/users/${userId}/role-template`)
      .set(asAdmin)
      .send({ role: 'operator', reason: 'E2E full-admin exact template apply' })
      .expect(200);

    const events = await http()
      .get('/api/admin/access-events')
      .query({ targetUserId: userId })
      .set(asAdmin)
      .expect(200);
    expect(events.body.items.map((event: { type: string }) => event.type)).toEqual(
      expect.arrayContaining([
        'admin.user.created',
        'audit:password_changed',
        'admin.user.access_updated',
        'admin.user.password_reset',
        'admin.user.blocked',
        'admin.user.reactivated',
      ]),
    );
    const applied = events.body.items.find(
      (event: { type: string; newValue?: { sourceTemplate?: unknown } }) =>
        event.type === 'admin.user.access_updated' && event.newValue?.sourceTemplate,
    );
    expect(applied?.newValue.sourceTemplate).toMatchObject({
      templateId: expect.any(String),
      templateVersion: expect.any(Number),
    });
    const storedCredential = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true },
    });
    const serializedEvents = JSON.stringify(events.body);
    expect(serializedEvents).not.toMatch(/passwordHash|tokenHash|temporaryPassword/);
    expect(serializedEvents.includes(created.body.temporaryPassword as string)).toBe(false);
    expect(serializedEvents.includes(reset.body.temporaryPassword as string)).toBe(false);
    expect(serializedEvents.includes(storedCredential.passwordHash ?? '')).toBe(false);
    expect(serializedEvents.includes(relogin.body.token as string)).toBe(false);

    await http()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${relogin.body.token}`)
      .expect(401);
    await http().post('/api/auth/login').send({ login, password: newPassword }).expect(401);
  });

  it('enforces the paired guard and fresh privilege ceiling for restricted administrators', async () => {
    const http = () => request(app.getHttpServer());
    const prisma = app.get(PrismaService);
    const accounts = app.get(AdminAccountsService);
    const sessions = app.get(SessionService);
    const seededAdmin = await prisma.user.findUniqueOrThrow({
      where: { login: e2eSeedLogin('admin') },
    });
    const adminSession = await sessions.issue(seededAdmin.id);
    const asAdmin = { Authorization: `Bearer ${adminSession.token}` };

    const provisionRestrictedAdmin = async (suffix: string, capabilityDenials: string[]) => {
      const restrictedLogin = `e2e.admin.${suffix}.${uniq}`;
      const created = await http()
        .post('/api/admin/users')
        .set(asAdmin)
        .send({ login: restrictedLogin, displayName: `E2E ${suffix}`, role: 'admin' })
        .expect(201);
      await prisma.user.update({
        where: { id: created.body.user.id as string },
        data: { mustChangePassword: false, passwordChangedAt: new Date() },
      });
      const beforeRestriction = await sessions.issue(created.body.user.id as string);
      await http()
        .put(`/api/admin/users/${created.body.user.id as string}/access`)
        .set(asAdmin)
        .send({
          role: 'admin',
          grants: [],
          denials: capabilityDenials,
          reason: `E2E restrict ${suffix} administrator`,
        })
        .expect(200);
      await http()
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${beforeRestriction.token}`)
        .expect(401);
      const restrictedSession = await sessions.issue(created.body.user.id as string);
      return {
        id: created.body.user.id as string,
        login: restrictedLogin,
        authorization: {
          Authorization: `Bearer ${restrictedSession.token}`,
        },
      };
    };

    const onlyUsers = await provisionRestrictedAdmin(
      'only-users',
      capabilitiesForRole('admin').filter((capability) => capability !== 'admin:users'),
    );
    await http().get('/api/admin/users').set(onlyUsers.authorization).expect(200);
    const onlyUsersEvents = await prisma.domainEvent.count({
      where: { actorId: onlyUsers.id },
    });
    const onlyUsersForbiddenLogin = `e2e.forbidden.only-users.${uniq}`;
    await http()
      .post('/api/admin/users')
      .set(onlyUsers.authorization)
      .send({ login: onlyUsersForbiddenLogin, displayName: 'Forbidden', role: 'admin' })
      .expect(403);
    await http()
      .post(`/api/admin/users/${seededAdmin.id}/reset-password`)
      .set(onlyUsers.authorization)
      .send({ reason: 'Forbidden stronger reset' })
      .expect(403);
    await http()
      .post(`/api/admin/users/${seededAdmin.id}/reactivate`)
      .set(onlyUsers.authorization)
      .send({ reason: 'Forbidden stronger reactivate' })
      .expect(403);
    await http()
      .put(`/api/admin/users/${onlyUsers.id}/access`)
      .set(onlyUsers.authorization)
      .send({
        role: 'admin',
        grants: [],
        denials: [],
        reason: 'Forbidden self escalation',
      })
      .expect(403);
    await http()
      .post(`/api/admin/users/${onlyUsers.id}/role-template`)
      .set(onlyUsers.authorization)
      .send({ role: 'admin', reason: 'Forbidden template escalation' })
      .expect(403);
    await expect(prisma.user.count({ where: { login: onlyUsersForbiddenLogin } })).resolves.toBe(0);
    await expect(prisma.domainEvent.count({ where: { actorId: onlyUsers.id } })).resolves.toBe(
      onlyUsersEvents,
    );

    let staleActorDenied = false;
    try {
      await accounts.create(
        {
          userId: onlyUsers.id,
          role: 'admin',
          capabilities: capabilitiesForRole('admin'),
        },
        {
          login: `e2e.forbidden.stale.${uniq}`,
          displayName: 'Forbidden stale actor',
          role: 'operator',
        },
      );
    } catch (error) {
      staleActorDenied = (error as { status?: number }).status === 403;
    }
    expect(staleActorDenied).toBe(true);
    await expect(
      prisma.user.count({ where: { login: `e2e.forbidden.stale.${uniq}` } }),
    ).resolves.toBe(0);

    const restricted = await provisionRestrictedAdmin('restricted', ['admin:diagnostics']);
    const restrictedEvents = await prisma.domainEvent.count({
      where: { actorId: restricted.id },
    });
    const restrictedForbiddenLogin = `e2e.forbidden.restricted.${uniq}`;
    await http()
      .post('/api/admin/users')
      .set(restricted.authorization)
      .send({ login: restrictedForbiddenLogin, displayName: 'Forbidden', role: 'admin' })
      .expect(403);
    await http()
      .post(`/api/admin/users/${seededAdmin.id}/reset-password`)
      .set(restricted.authorization)
      .send({ reason: 'Forbidden superior reset' })
      .expect(403);
    await http()
      .post(`/api/admin/users/${seededAdmin.id}/reactivate`)
      .set(restricted.authorization)
      .send({ reason: 'Forbidden superior reactivate' })
      .expect(403);
    await http()
      .put(`/api/admin/users/${restricted.id}/access`)
      .set(restricted.authorization)
      .send({
        role: 'admin',
        grants: [],
        denials: [],
        reason: 'Forbidden self denial removal',
      })
      .expect(403);
    await http()
      .post(`/api/admin/users/${restricted.id}/role-template`)
      .set(restricted.authorization)
      .send({ role: 'admin', reason: 'Forbidden stronger template' })
      .expect(403);
    await expect(prisma.user.count({ where: { login: restrictedForbiddenLogin } })).resolves.toBe(
      0,
    );
    await expect(prisma.domainEvent.count({ where: { actorId: restricted.id } })).resolves.toBe(
      restrictedEvents,
    );
  });

  it('keeps one control admin when two admins are blocked concurrently', async () => {
    const prisma = app.get(PrismaService);
    const accounts = app.get(AdminAccountsService);
    const snapshots = await prisma.user.findMany({
      where: { role: 'admin' },
      select: { id: true, isActive: true },
    });
    const firstId = `e2e-admin-a-${uniq}`;
    const secondId = `e2e-admin-b-${uniq}`;

    try {
      await prisma.user.createMany({
        data: [
          {
            id: firstId,
            login: `e2e.admin.a.${uniq}`,
            displayName: 'E2E Admin A',
            role: 'admin',
          },
          {
            id: secondId,
            login: `e2e.admin.b.${uniq}`,
            displayName: 'E2E Admin B',
            role: 'admin',
          },
        ],
      });
      await prisma.user.updateMany({
        where: { role: 'admin', id: { notIn: [firstId, secondId] } },
        data: { isActive: false },
      });

      const firstActor = {
        userId: firstId,
        role: 'admin' as const,
        capabilities: capabilitiesForRole('admin'),
      };
      const secondActor = {
        userId: secondId,
        role: 'admin' as const,
        capabilities: capabilitiesForRole('admin'),
      };
      const results = await Promise.allSettled([
        accounts.block(firstActor, firstId, 'E2E concurrent safety proof'),
        accounts.block(secondActor, secondId, 'E2E concurrent safety proof'),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      expect(rejected?.reason).toMatchObject({
        response: expect.objectContaining({ code: 'ADMIN_LAST_ACTIVE_ADMIN' }),
      });
      const survivors = await prisma.user.count({
        where: { id: { in: [firstId, secondId] }, isActive: true, role: 'admin' },
      });
      expect(survivors).toBe(1);
    } finally {
      for (const snapshot of snapshots) {
        await prisma.user.update({
          where: { id: snapshot.id },
          data: { isActive: snapshot.isActive },
        });
      }
      await prisma.userCapabilityOverride.deleteMany({
        where: { userId: { in: [firstId, secondId] } },
      });
      await prisma.session.deleteMany({ where: { userId: { in: [firstId, secondId] } } });
      await prisma.user.updateMany({
        where: { id: { in: [firstId, secondId] } },
        data: { isActive: false },
      });
      // Audited, retired admin actors remain until guarded isolated-schema teardown.
    }
  });
});
