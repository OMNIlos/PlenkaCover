import { createHash } from 'node:crypto';
import { GATEWAY_CAPABILITIES, isCanonicalPilotAgentToken } from '@plenka/contracts';
import { AdminPostsService } from './admin-posts.service';

const actor = { userId: 'admin-1', role: 'admin' as const };
const post = {
  id: 'post-1',
  code: 'POST-1',
  name: 'Станок 1',
  status: 'active',
  commissioningState: 'uncommissioned',
  commissionedAt: null,
  agentStatus: 'online',
  lastSeenAt: new Date(),
  agentProtocolVersion: 2,
  agentPackageVersion: '1:0.0.1',
  agentReleaseCommit: 'a'.repeat(40),
  agentCapabilities: [...GATEWAY_CAPABILITIES],
  agentCompatibility: 'compatible',
  createdAt: new Date(),
  updatedAt: new Date(),
  devices: ['scale', 'printer', 'scanner'].map((kind) => ({
    id: `${kind}-1`,
    kind,
    isEnabled: true,
    status: 'ready',
    lastSeenAt: new Date(),
    lastProbeAt: new Date(),
  })),
};

function setup() {
  const tx = {
    post: {
      create: jest.fn().mockResolvedValue(post),
      update: jest.fn().mockResolvedValue(post),
      findUnique: jest.fn().mockResolvedValue(post),
    },
    domainEvent: { create: jest.fn() },
  };
  const prisma = {
    post: {
      findMany: jest.fn().mockResolvedValue([post]),
      findUnique: jest.fn().mockResolvedValue(post),
    },
    operationalCheck: { findMany: jest.fn().mockResolvedValue([]) },
    operationalIncident: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((work) => work(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new AdminPostsService(prisma as never, audit as never);
  return { service, prisma, tx, audit };
}

describe('AdminPostsService', () => {
  it('lists safe post projections without agentTokenHash', async () => {
    const { service, prisma } = setup();
    const result = await service.list();
    const serialized = JSON.stringify(result);
    const select = prisma.post.findMany.mock.calls[0][0].select;
    expect(serialized).not.toContain('agentTokenHash');
    expect(serialized).not.toContain('rawPayload');
    expect(select.agentTokenHash).toBeUndefined();
    expect(select.devices.select.rawPayload).toBeUndefined();
    expect(select.devices.select.configFingerprint).toBeUndefined();
    expect(select.devices.select.driverName).toBe(true);
    expect(select.devices.select.driverVersion).toBe(true);
    expect(result[0]).toMatchObject({
      connectionState: 'online',
      online: true,
      deviceCount: 3,
      commissioningState: 'uncommissioned',
      agentProtocolVersion: 2,
      agentPackageVersion: '1:0.0.1',
      agentReleaseCommit: 'a'.repeat(40),
      agentCompatibility: 'compatible',
      capabilityReady: true,
      missingCapabilities: [],
      requiredCapabilityCount: GATEWAY_CAPABILITIES.length,
    });
  });

  it('sanitizes malformed capability JSON instead of projecting arbitrary values', async () => {
    const { service, prisma } = setup();
    prisma.post.findMany.mockResolvedValue([
      {
        ...post,
        agentCapabilities: {
          raw: 'SERIAL-FRAME-MUST-NOT-LEAK',
          token: 'TOKEN-MUST-NOT-LEAK',
        },
      },
    ]);

    const [result] = await service.list();

    expect(result.agentCapabilities).toEqual([]);
    expect(result.capabilityReady).toBe(false);
    expect(result.missingCapabilities).toEqual(GATEWAY_CAPABILITIES);
    expect(JSON.stringify(result)).not.toContain('SERIAL-FRAME-MUST-NOT-LEAK');
    expect(JSON.stringify(result)).not.toContain('TOKEN-MUST-NOT-LEAK');
  });

  it('creates a new machine as data and audits the configuration', async () => {
    const { service, tx, audit } = setup();
    await service.create(actor, { code: 'POST-6', name: 'Станок 6' });
    expect(tx.post.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          code: 'POST-6',
          name: 'Станок 6',
          status: 'active',
          commissioningState: 'uncommissioned',
          commissionedAt: null,
          agentStatus: 'unknown',
          agentCompatibility: 'unknown',
          lastSeenAt: null,
        },
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'admin.post.created' }),
      tx,
    );
  });

  it('returns a token once and persists only its sha256 hash transactionally', async () => {
    const { service, tx, audit } = setup();

    const result = await service.rotateToken(actor, 'post-1', 'Плановая ротация');

    expect(isCanonicalPilotAgentToken(result.token)).toBe(true);
    expect(result.token).toMatch(/^ptk_[A-Za-z0-9_-]+$/);
    expect(Buffer.from(result.token.slice(4), 'base64url')).toHaveLength(32);
    const stored = tx.post.update.mock.calls[0][0].data.agentTokenHash;
    expect(stored).toBe(createHash('sha256').update(result.token).digest('hex'));
    expect(stored).not.toBe(result.token);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'admin.post.token_rotated', reason: 'Плановая ротация' }),
      tx,
    );
  });

  it('commissions only a fresh compatible complete topology and audits the transition', async () => {
    const { service, tx, audit } = setup();
    tx.post.update.mockResolvedValue({
      ...post,
      commissioningState: 'commissioned',
      commissionedAt: new Date(),
    });

    await expect(
      service.commission(actor, 'post-1', 'Физическая приёмка POST-1'),
    ).resolves.toMatchObject({ commissioningState: 'commissioned' });
    expect(tx.post.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'post-1' },
        data: {
          commissioningState: 'commissioned',
          commissionedAt: expect.any(Date),
        },
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'admin.post.commissioned',
        reason: 'Физическая приёмка POST-1',
      }),
      tx,
    );
  });
});
