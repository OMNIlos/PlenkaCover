import { createHash } from 'node:crypto';
import { reconcilePilotTopology, type PilotTopologyClient } from './pilot-seed';
import { PILOT_AGENT_TOKEN_KEYS, type PilotSeedProfile } from './seed-profile';

interface PostRow {
  agentCompatibility: string;
  agentStatus: string;
  agentTokenHash: string | null;
  code: string;
  commissionedAt: Date | null;
  commissioningState: string;
  id: string;
  lastSeenAt: Date | null;
}

interface DeviceRow {
  code: string | null;
  id: string;
  kind: string;
  lastProbeAt: Date | null;
  lastSeenAt: Date | null;
  postId: string | null;
  status: string;
}

function config(): PilotSeedProfile {
  return {
    profile: 'pilot',
    shortPasswordsEnabled: false,
    passwords: {} as PilotSeedProfile['passwords'],
    agentTokens: Object.fromEntries(
      PILOT_AGENT_TOKEN_KEYS.map((key, index) => [key, `unique-agent-token-${index + 1}`]),
    ) as PilotSeedProfile['agentTokens'],
  };
}

function devicesFor(postNumber: number, postId: string): DeviceRow[] {
  return [
    {
      id: `scale-post-${postNumber}`,
      code: `SCALE-${postNumber}`,
      kind: 'scale',
      postId,
      status: 'ready',
      lastSeenAt: new Date('2026-08-04T09:00:00.000Z'),
      lastProbeAt: new Date('2026-08-04T09:00:01.000Z'),
    },
    {
      id: `scanner-post-${postNumber}`,
      code: `SCANNER-${postNumber}`,
      kind: 'scanner',
      postId,
      status: 'ready',
      lastSeenAt: new Date('2026-08-04T09:00:02.000Z'),
      lastProbeAt: new Date('2026-08-04T09:00:03.000Z'),
    },
    {
      id: `printer-post-${postNumber}`,
      code: `PRINTER-${postNumber}`,
      kind: 'printer',
      postId,
      status: 'ready',
      lastSeenAt: new Date('2026-08-04T09:00:04.000Z'),
      lastProbeAt: new Date('2026-08-04T09:00:05.000Z'),
    },
  ];
}

function createHarness(initialPosts: PostRow[] = [], initialDevices: DeviceRow[] = []) {
  const posts = new Map(initialPosts.map((post) => [post.code, { ...post }]));
  const devices = new Map(initialDevices.map((device) => [device.id, { ...device }]));
  const postCreate = jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
    const row: PostRow = {
      id: `post-${String(data.code)}`,
      code: String(data.code),
      agentTokenHash: String(data.agentTokenHash),
      agentStatus: String(data.agentStatus),
      commissioningState: String(data.commissioningState),
      commissionedAt: null,
      agentCompatibility: String(data.agentCompatibility),
      lastSeenAt: null,
    };
    posts.set(row.code, row);
    return row;
  });
  const postUpdate = jest.fn(
    async ({ where, data }: { where: { id: string }; data: { agentTokenHash: string } }) => {
      const row = [...posts.values()].find((candidate) => candidate.id === where.id);
      if (!row) throw new Error('post not found');
      row.agentTokenHash = data.agentTokenHash;
      return row;
    },
  );
  const deviceCreate = jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
    const row: DeviceRow = {
      id: String(data.id),
      code: String(data.code),
      kind: String(data.kind),
      postId: String(data.postId),
      status: String(data.status),
      lastSeenAt: null,
      lastProbeAt: null,
    };
    devices.set(row.id, row);
    return row;
  });
  const deviceUpdate = jest.fn(
    async ({
      where,
      data,
    }: {
      where: { id: string };
      data: { id?: string; code?: string; post?: { connect: { id: string } } };
    }) => {
      const row = devices.get(where.id);
      if (!row) throw new Error('device not found');
      devices.delete(where.id);
      if (data.id) row.id = data.id;
      if (data.code) row.code = data.code;
      if (data.post) row.postId = data.post.connect.id;
      devices.set(row.id, row);
      return row;
    },
  );
  const client = {
    post: {
      findUnique: jest.fn(
        async ({ where }: { where: { code: string } }) => posts.get(where.code) ?? null,
      ),
      create: postCreate,
      update: postUpdate,
    },
    deviceRuntime: {
      findUnique: jest.fn(async ({ where }: { where: { code?: string; id?: string } }) => {
        if (where.id) return devices.get(where.id) ?? null;
        return [...devices.values()].find((candidate) => candidate.code === where.code) ?? null;
      }),
      create: deviceCreate,
      update: deviceUpdate,
    },
  } as unknown as PilotTopologyClient;

  return { client, deviceCreate, deviceUpdate, devices, postCreate, postUpdate, posts };
}

describe('production pilot topology reconciliation', () => {
  it('creates fail-closed posts and devices without runtime readiness or raw tokens', async () => {
    const seedConfig = config();
    const harness = createHarness();

    await reconcilePilotTopology(harness.client, seedConfig);

    expect(harness.postCreate).toHaveBeenCalledTimes(PILOT_AGENT_TOKEN_KEYS.length);
    expect(harness.deviceCreate).toHaveBeenCalledTimes(PILOT_AGENT_TOKEN_KEYS.length * 3);
    for (const post of harness.posts.values()) {
      expect(post).toMatchObject({
        agentStatus: 'unknown',
        commissioningState: 'uncommissioned',
        commissionedAt: null,
        agentCompatibility: 'unknown',
        lastSeenAt: null,
      });
    }
    for (const device of harness.devices.values()) {
      expect(device).toMatchObject({
        status: 'offline',
        lastSeenAt: null,
        lastProbeAt: null,
      });
    }

    const writes = JSON.stringify([harness.postCreate.mock.calls, harness.deviceCreate.mock.calls]);
    for (const token of Object.values(seedConfig.agentTokens)) {
      expect(writes).not.toContain(token);
    }
  });

  it('preserves commissioned runtime state and device probes on repeat seed', async () => {
    const seedConfig = config();
    const posts = PILOT_AGENT_TOKEN_KEYS.map(
      (_, index): PostRow => ({
        id: `post-${index + 1}`,
        code: `POST-${index + 1}`,
        agentTokenHash: createHash('sha256')
          .update(`enrolled-token-${index + 1}`)
          .digest('hex'),
        agentStatus: 'online',
        commissioningState: 'commissioned',
        commissionedAt: new Date('2026-08-03T10:00:00.000Z'),
        agentCompatibility: 'compatible',
        lastSeenAt: new Date('2026-08-04T09:00:00.000Z'),
      }),
    );
    const devices = posts.flatMap((post, index) => devicesFor(index + 1, post.id));
    const harness = createHarness(posts, devices);
    const before = JSON.stringify({
      posts: [...harness.posts.values()],
      devices: [...harness.devices.values()],
    });

    await reconcilePilotTopology(harness.client, seedConfig);

    expect(harness.postCreate).not.toHaveBeenCalled();
    expect(harness.postUpdate).not.toHaveBeenCalled();
    expect(harness.deviceCreate).not.toHaveBeenCalled();
    expect(harness.deviceUpdate).not.toHaveBeenCalled();
    expect(
      JSON.stringify({
        posts: [...harness.posts.values()],
        devices: [...harness.devices.values()],
      }),
    ).toBe(before);
  });

  it('fails instead of stealing an existing device binding from another post', async () => {
    const seedConfig = config();
    const existingPost: PostRow = {
      id: 'post-1',
      code: 'POST-1',
      agentTokenHash: createHash('sha256').update('enrolled-token').digest('hex'),
      agentStatus: 'online',
      commissioningState: 'commissioned',
      commissionedAt: new Date('2026-08-03T10:00:00.000Z'),
      agentCompatibility: 'compatible',
      lastSeenAt: new Date('2026-08-04T09:00:00.000Z'),
    };
    const scale = devicesFor(1, 'another-post')[0]!;
    const harness = createHarness([existingPost], [scale]);

    await expect(reconcilePilotTopology(harness.client, seedConfig)).rejects.toThrow(
      'device SCALE-1 is bound to another post',
    );
    expect(harness.deviceUpdate).not.toHaveBeenCalled();
  });
});
