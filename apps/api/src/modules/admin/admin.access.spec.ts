import { Reflector } from '@nestjs/core';
import { DECORATORS } from '@nestjs/swagger';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { AdminController } from './admin.controller';
import { AdminOneCController } from './admin-onec.controller';
import { AdminDevicesController } from './admin-devices.controller';
import { AdminPostsController } from './admin-posts.controller';
import { AdminNotificationsController } from './admin-notifications.controller';
import { capabilitiesForRole, type Capability, type Role } from '@plenka/contracts';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';

type AdminHandler = (...args: never[]) => unknown;

function ctxForActor(
  handler: AdminHandler,
  actor: { userId: string | null; role: Role; capabilities: readonly Capability[] },
) {
  return {
    getHandler: () => handler,
    getClass: () => AdminController,
    switchToHttp: () => ({
      getRequest: () => ({ actor }),
    }),
  } as never;
}

function ctxFor(handler: AdminHandler, role: Role) {
  return ctxForActor(handler, {
    userId: null,
    role,
    capabilities: capabilitiesForRole(role),
  });
}

describe('admin role-leakage', () => {
  const guard = new CapabilityGuard(new Reflector());
  const proto = AdminController.prototype;

  it('director cannot reach admin diagnostics (raw payloads, ТЗ §8)', () => {
    expect(() => guard.canActivate(ctxFor(proto.diagnostic, 'director'))).toThrow();
  });

  it('operator cannot manage users', () => {
    expect(() => guard.canActivate(ctxFor(proto.users, 'operator'))).toThrow();
    expect(() => guard.canActivate(ctxFor(proto.createUser, 'operator'))).toThrow();
    expect(() => guard.canActivate(ctxFor(proto.replaceUserAccess, 'director'))).toThrow();
    expect(() => guard.canActivate(ctxFor(proto.accessEvents, 'finance'))).toThrow();
  });

  it('admin CAN read diagnostics', () => {
    expect(guard.canActivate(ctxFor(proto.diagnostic, 'admin'))).toBe(true);
  });

  it('every admin route declares a capability', () => {
    const reflector = new Reflector();
    const capabilities = (proto as unknown as { capabilities: AdminHandler }).capabilities;
    for (const handler of [
      proto.users,
      proto.createUser,
      proto.user,
      proto.updateUser,
      proto.blockUser,
      proto.reactivateUser,
      proto.resetUserPassword,
      proto.userSessions,
      proto.revokeUserSessions,
      proto.replaceUserAccess,
      proto.roleTemplates,
      proto.setRoleTemplate,
      proto.createTemplate,
      proto.updateTemplate,
      capabilities,
      proto.accessEvents,
      proto.diagnostic,
    ]) {
      const caps = reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler);
      expect(caps && caps.length).toBeTruthy();
    }
  });

  it('protects and documents the capability catalog for full access administrators', () => {
    const handler = (proto as unknown as { capabilities: AdminHandler }).capabilities;

    expect(typeof handler).toBe('function');
    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([
      'admin:users',
      'admin:role_templates',
    ]);
    expect(
      guard.canActivate(
        ctxForActor(handler, {
          userId: 'full-admin',
          role: 'admin',
          capabilities: capabilitiesForRole('admin'),
        }),
      ),
    ).toBe(true);
    expect(() =>
      guard.canActivate(
        ctxForActor(handler, {
          userId: 'restricted-admin',
          role: 'admin',
          capabilities: ['admin:role_templates'],
        }),
      ),
    ).toThrow();
    expect(Reflect.getMetadata(DECORATORS.API_SECURITY, handler)).toEqual([{ session: [] }]);
    const responses = Reflect.getMetadata(DECORATORS.API_RESPONSE, handler) ?? {};
    expect(Object.keys(responses)).toEqual(expect.arrayContaining(['200', '401', '403']));
    expect(responses['200']).toMatchObject({ isArray: true });
    expect(responses['200'].type.name).toBe('AdminCapabilityCatalogItemResponseDto');
  });

  it('gates dedicated device and post controllers', () => {
    const reflector = new Reflector();
    const devices = AdminDevicesController.prototype;
    const posts = AdminPostsController.prototype;
    for (const handler of [
      devices.list,
      devices.create,
      devices.get,
      devices.update,
      devices.test,
      devices.recover,
      devices.quality,
    ]) {
      expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toContain('admin:devices');
    }
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, devices.bind)).toEqual([
      'admin:devices',
      'admin:posts',
    ]);
    for (const handler of [
      posts.list,
      posts.create,
      posts.get,
      posts.update,
      posts.rotateToken,
      posts.commission,
      posts.quality,
    ]) {
      expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual(['admin:posts']);
    }
    for (const role of [
      'commercial',
      'production_lead',
      'operator',
      'warehouse',
      'finance',
      'director',
    ] as const) {
      expect(() => guard.canActivate(ctxFor(devices.list, role))).toThrow();
      expect(() => guard.canActivate(ctxFor(posts.list, role))).toThrow();
    }
  });

  it('gates the dedicated OneC controller', () => {
    const reflector = new Reflector();
    const onec = AdminOneCController.prototype;
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, onec.overview)).toEqual([
      'admin:onec',
    ]);
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, onec.rawSnapshot)).toEqual([
      'admin:diagnostics',
    ]);
  });

  it('gates both admin notification routes with platform-health authority', () => {
    const reflector = new Reflector();
    const notifications = AdminNotificationsController.prototype;
    for (const handler of [notifications.list, notifications.markRead]) {
      expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([
        'admin:platform_health',
      ]);
      expect(guard.canActivate(ctxFor(handler, 'admin'))).toBe(true);
      for (const role of [
        'commercial',
        'production_lead',
        'operator',
        'warehouse',
        'finance',
        'director',
      ] as const) {
        expect(() => guard.canActivate(ctxFor(handler, role))).toThrow();
      }
    }
  });

  it('requires both user and template administration to apply a preset', () => {
    const caps = new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, proto.setRoleTemplate);
    expect(caps).toEqual(['admin:users', 'admin:role_templates']);
  });

  it('requires both account and template authority for every account/access mutation', () => {
    const reflector = new Reflector();
    for (const handler of [
      proto.createUser,
      proto.updateUser,
      proto.blockUser,
      proto.reactivateUser,
      proto.resetUserPassword,
      proto.revokeUserSessions,
      proto.replaceUserAccess,
      proto.createTemplate,
      proto.updateTemplate,
      proto.setRoleTemplate,
    ]) {
      expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([
        'admin:users',
        'admin:role_templates',
      ]);
    }
  });

  it('lets an admin:users-only actor read users but rejects every mutation', () => {
    const restricted = {
      userId: 'restricted-admin',
      role: 'admin' as const,
      capabilities: ['admin:users'] as const,
    };
    for (const handler of [proto.users, proto.user, proto.userSessions, proto.accessEvents]) {
      expect(guard.canActivate(ctxForActor(handler, restricted))).toBe(true);
    }
    for (const handler of [
      proto.createUser,
      proto.updateUser,
      proto.blockUser,
      proto.reactivateUser,
      proto.resetUserPassword,
      proto.revokeUserSessions,
      proto.replaceUserAccess,
      proto.createTemplate,
      proto.updateTemplate,
      proto.setRoleTemplate,
    ]) {
      expect(() => guard.canActivate(ctxForActor(handler, restricted))).toThrow();
    }
  });

  it('lets a full canonical admin invoke every account/access mutation', () => {
    const fullAdmin = {
      userId: 'full-admin',
      role: 'admin' as const,
      capabilities: capabilitiesForRole('admin'),
    };
    for (const handler of [
      proto.createUser,
      proto.updateUser,
      proto.blockUser,
      proto.reactivateUser,
      proto.resetUserPassword,
      proto.revokeUserSessions,
      proto.replaceUserAccess,
      proto.createTemplate,
      proto.updateTemplate,
      proto.setRoleTemplate,
    ]) {
      expect(guard.canActivate(ctxForActor(handler, fullAdmin))).toBe(true);
    }
  });
});
