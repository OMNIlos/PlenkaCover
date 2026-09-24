import { AccessPolicyService } from '../../common/auth/access-policy.service';
import { projectAdminUser } from './admin-projection';

describe('admin account projection', () => {
  it('never projects password hashes or session token hashes', () => {
    const row = {
      id: 'u1',
      externalId: null,
      login: 'operator',
      displayName: 'Operator',
      role: 'operator',
      isActive: true,
      mustChangePassword: false,
      passwordChangedAt: null,
      lastLoginAt: null,
      createdAt: new Date('2026-07-13T00:00:00Z'),
      updatedAt: new Date('2026-07-13T00:00:00Z'),
      capabilityOverrides: [],
      sessions: [
        {
          id: 's1',
          tokenHash: 'secret',
          purpose: 'full',
          createdAt: new Date('2026-07-13T00:00:00Z'),
          expiresAt: new Date('2099-01-01T00:00:00Z'),
          revokedAt: null,
          lastSeenAt: null,
        },
      ],
      passwordHash: 'secret',
    } as never;

    const result = projectAdminUser(row, new AccessPolicyService());
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.status).toBe('active');
    expect(result.activeSessionCount).toBe(1);
  });

  it('derives blocked before password_setup and resolves effective capabilities', () => {
    const base = {
      id: 'u1',
      externalId: null,
      login: 'operator',
      displayName: 'Operator',
      role: 'operator',
      isActive: false,
      mustChangePassword: true,
      passwordChangedAt: null,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      capabilityOverrides: [{ capability: 'operator_task:read', effect: 'deny', reason: 'test' }],
      sessions: [],
    } as never;
    const result = projectAdminUser(base, new AccessPolicyService());
    expect(result.status).toBe('blocked');
    expect(result.capabilities).not.toContain('operator_task:read');
  });
});
