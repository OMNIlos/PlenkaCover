import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ROLE_CAPABILITIES, type Capability } from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import { AccessPolicyService } from '../../common/auth/access-policy.service';
import {
  AdminPrivilegeCeilingService,
  type AdminAccessState,
  type AdminAuthority,
} from './admin-privilege-ceiling.service';

const requestActor: Actor = {
  userId: 'actor-1',
  role: 'admin',
  capabilities: ROLE_CAPABILITIES.admin,
};

function overrideDenials(...capabilities: Capability[]) {
  return capabilities.map((capability) => ({ capability, effect: 'deny' }));
}

function actorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'actor-1',
    role: 'admin' as const,
    isActive: true,
    mustChangePassword: false,
    capabilityOverrides: [],
    ...overrides,
  };
}

function setup(row: ReturnType<typeof actorRow> | null = actorRow()) {
  const client = { user: { findUnique: jest.fn().mockResolvedValue(row) } };
  const service = new AdminPrivilegeCeilingService(new AccessPolicyService());
  return { service, client };
}

function state(denials: Capability[] = []): AdminAccessState {
  return { role: 'admin', overrides: overrideDenials(...denials) };
}

function expectCeilingDenied(work: () => void): void {
  try {
    work();
    throw new Error('Expected privilege ceiling denial.');
  } catch (error) {
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error).toMatchObject({
      response: expect.objectContaining({ code: 'ADMIN_PRIVILEGE_CEILING' }),
    });
  }
}

describe('AdminPrivilegeCeilingService', () => {
  it('uses fresh DB authority instead of a stale full-capability request actor', async () => {
    const { service, client } = setup(
      actorRow({ capabilityOverrides: overrideDenials('admin:role_templates') }),
    );

    await expect(service.loadAuthority(client as never, requestActor)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ADMIN_PRIVILEGE_CEILING' }),
    });
  });

  it.each([
    ['missing', null],
    ['inactive', actorRow({ isActive: false })],
    ['password setup', actorRow({ mustChangePassword: true })],
  ])('rejects a %s database actor', async (_label, row) => {
    const { service, client } = setup(row);
    await expect(service.loadAuthority(client as never, requestActor)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('requires a persisted actor identity', async () => {
    const { service, client } = setup();
    await expect(
      service.loadAuthority(client as never, { ...requestActor, userId: null }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(client.user.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    [
      'only users',
      overrideDenials(...ROLE_CAPABILITIES.admin.filter((cap) => cap !== 'admin:users')),
    ],
    [
      'only templates',
      overrideDenials(...ROLE_CAPABILITIES.admin.filter((cap) => cap !== 'admin:role_templates')),
    ],
  ])('rejects an actor with %s mutation authority', async (_label, capabilityOverrides) => {
    const { service, client } = setup(actorRow({ capabilityOverrides }));
    await expect(service.loadAuthority(client as never, requestActor)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ADMIN_PRIVILEGE_CEILING' }),
    });
  });

  it('lets a restricted actor administer equal and lower-capability peers only', async () => {
    const { service, client } = setup(
      actorRow({ capabilityOverrides: overrideDenials('admin:diagnostics') }),
    );
    const authority = await service.loadAuthority(client as never, requestActor);

    expect(() =>
      service.assertCanAdministerTarget(authority, 'peer-1', state(['admin:diagnostics'])),
    ).not.toThrow();
    expect(() =>
      service.assertCanAdministerTarget(
        authority,
        'peer-2',
        state(['admin:diagnostics', 'admin:source_health']),
      ),
    ).not.toThrow();
    expectCeilingDenied(() => service.assertCanAdministerTarget(authority, 'superior', state()));
    expectCeilingDenied(() =>
      service.assertCanAdministerTarget(authority, 'operator', {
        role: 'operator',
        overrides: [],
      }),
    );
  });

  it('enforces the prospective subset rule for self even when adding or removing denials', async () => {
    const { service, client } = setup(
      actorRow({ capabilityOverrides: overrideDenials('admin:diagnostics') }),
    );
    const authority = await service.loadAuthority(client as never, requestActor);

    expect(() =>
      service.assertCanAdministerTarget(
        authority,
        authority.actorId,
        state(['admin:diagnostics']),
        state(['admin:diagnostics', 'admin:source_health']),
      ),
    ).not.toThrow();
    expectCeilingDenied(() =>
      service.assertCanAdministerTarget(
        authority,
        authority.actorId,
        state(['admin:diagnostics']),
        state(),
      ),
    );
  });

  it('lets a full admin manage full-admin and business-role peers', async () => {
    const { service, client } = setup();
    const authority = await service.loadAuthority(client as never, requestActor);

    expect(authority.isFullControlAdmin).toBe(true);
    expect(() => service.assertCanAdministerTarget(authority, 'admin-peer', state())).not.toThrow();
    expect(() =>
      service.assertCanAdministerTarget(authority, 'operator-peer', {
        role: 'operator',
        overrides: [],
      }),
    ).not.toThrow();
  });

  it('does not let a full admin self-switch to an incomparable business policy', async () => {
    const { service, client } = setup();
    const authority = await service.loadAuthority(client as never, requestActor);

    expectCeilingDenied(() =>
      service.assertCanAdministerTarget(authority, authority.actorId, state(), {
        role: 'operator',
        overrides: [],
      }),
    );
  });

  it('checks both current and prospective template policies for restricted actors', async () => {
    const { service, client } = setup(
      actorRow({ capabilityOverrides: overrideDenials('admin:diagnostics') }),
    );
    const authority: AdminAuthority = await service.loadAuthority(client as never, requestActor);

    expect(() =>
      service.assertCanAdministerPolicy(
        authority,
        state(['admin:diagnostics']),
        state(['admin:diagnostics', 'admin:source_health']),
      ),
    ).not.toThrow();
    expectCeilingDenied(() =>
      service.assertCanAdministerPolicy(authority, state(), state(['admin:diagnostics'])),
    );
    expectCeilingDenied(() =>
      service.assertCanAdministerPolicy(authority, state(['admin:diagnostics']), state()),
    );
  });
});
