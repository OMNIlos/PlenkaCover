import { ServiceUnavailableException } from '@nestjs/common';
import { GATEWAY_CAPABILITIES } from '@plenka/contracts';
import { PostDeviceReadinessService, type PhysicalWorkflow } from './post-device-readiness.service';

const NOW = new Date('2026-08-04T13:30:00.000Z');
const FRESH = new Date('2026-08-04T13:29:30.000Z');

function readyPost() {
  return {
    id: 'post-1',
    code: 'POST-1',
    status: 'active',
    commissioningState: 'commissioned',
    commissionedAt: FRESH,
    agentStatus: 'online',
    lastSeenAt: FRESH,
    agentCompatibility: 'compatible',
    agentCapabilities: [...GATEWAY_CAPABILITIES],
    devices: [
      {
        id: 'scale-1',
        kind: 'scale',
        connectionKind: 'usb-rs232',
        status: 'ready',
        isEnabled: true,
        lastSeenAt: FRESH,
        lastProbeAt: FRESH,
      },
      {
        id: 'printer-1',
        kind: 'printer',
        connectionKind: 'usb-or-tcp',
        status: 'ready',
        isEnabled: true,
        lastSeenAt: FRESH,
        lastProbeAt: FRESH,
      },
      {
        id: 'scanner-1',
        kind: 'scanner',
        connectionKind: 'usb-hid',
        status: 'ready',
        isEnabled: true,
        lastSeenAt: FRESH,
        lastProbeAt: FRESH,
      },
    ],
  };
}

function setup(post: ReturnType<typeof readyPost> | null) {
  const prisma = {
    post: {
      findUnique: jest.fn().mockResolvedValue(post),
    },
  };
  return {
    prisma,
    service: new PostDeviceReadinessService(prisma as never),
  };
}

describe('PostDeviceReadinessService', () => {
  it.each([
    ['production.assignment', ['scale', 'printer', 'scanner']],
    ['operator.shift.open', ['scale', 'printer', 'scanner']],
    ['operator.weight.capture', ['scale']],
    ['operator.roll-label.print', ['printer']],
    ['operator.qr.verify', ['scanner']],
    ['warehouse.scan', ['scanner']],
    ['warehouse.weight.capture', ['scale']],
    ['warehouse.big-bag.print', ['printer']],
    ['warehouse.pallet.print', ['printer']],
  ] as Array<[PhysicalWorkflow, string[]]>)(
    'returns the exact ready device projection for %s',
    async (workflow, kinds) => {
      const { service } = setup(readyPost());

      await expect(service.require('post-1', workflow, undefined, NOW)).resolves.toMatchObject({
        ready: true,
        code: 'READY',
        workflow,
        post: { id: 'post-1', code: 'POST-1' },
        devices: kinds.map((kind) => expect.objectContaining({ kind })),
      });
    },
  );

  it('allows the browser-owned warehouse USB-HID scanner without gateway liveness', async () => {
    const post = readyPost();
    post.agentStatus = 'offline';
    post.lastSeenAt = new Date(NOW.getTime() - 91_000);
    post.agentCompatibility = 'unsupported';
    post.agentCapabilities = [];
    post.devices[2] = {
      ...post.devices[2],
      status: 'offline',
      lastSeenAt: new Date(NOW.getTime() - 91_000),
      lastProbeAt: new Date(NOW.getTime() - 91_000),
    };
    const { service } = setup(post);

    await expect(service.require('post-1', 'warehouse.scan', undefined, NOW)).resolves.toEqual({
      ready: true,
      code: 'READY',
      message: 'Физический пост готов.',
      workflow: 'warehouse.scan',
      post: { id: 'post-1', code: 'POST-1' },
      devices: [{ id: 'scanner-1', kind: 'scanner', status: 'offline' }],
    });
  });

  it.each([
    ['POST_NOT_ACTIVE', { status: 'offline' }],
    ['POST_NOT_COMMISSIONED', { commissioningState: 'uncommissioned', commissionedAt: null }],
  ])('keeps the warehouse USB-HID exception behind post topology: %s', async (code, patch) => {
    const post = {
      ...readyPost(),
      agentStatus: 'offline',
      agentCapabilities: [],
      ...patch,
    } as ReturnType<typeof readyPost>;
    const { service } = setup(post);

    await expect(service.require('post-1', 'warehouse.scan', undefined, NOW)).rejects.toMatchObject(
      {
        response: expect.objectContaining({ code }),
      },
    );
  });

  it('does not apply the warehouse USB-HID exception to duplicate enabled scanners', async () => {
    const post = readyPost();
    post.agentStatus = 'offline';
    post.devices.push({ ...post.devices[2], id: 'scanner-2' });
    const { service } = setup(post);

    await expect(service.require('post-1', 'warehouse.scan', undefined, NOW)).rejects.toMatchObject(
      {
        response: expect.objectContaining({ code: 'POST_AGENT_OFFLINE' }),
      },
    );
  });

  it('does not treat a disabled USB-HID scanner as warehouse-ready', async () => {
    const post = readyPost();
    post.agentStatus = 'offline';
    post.devices[2] = { ...post.devices[2], isEnabled: false };
    const { service } = setup(post);

    await expect(service.require('post-1', 'warehouse.scan', undefined, NOW)).rejects.toMatchObject(
      {
        response: expect.objectContaining({ code: 'POST_AGENT_OFFLINE' }),
      },
    );
  });

  it('does not apply the warehouse exception to a non-HID scanner', async () => {
    const post = readyPost();
    post.agentStatus = 'offline';
    post.devices[2] = { ...post.devices[2], connectionKind: 'serial' };
    const { service } = setup(post);

    await expect(service.require('post-1', 'warehouse.scan', undefined, NOW)).rejects.toMatchObject(
      {
        response: expect.objectContaining({ code: 'POST_AGENT_OFFLINE' }),
      },
    );
  });

  it.each<PhysicalWorkflow>(['operator.qr.verify', 'warehouse.pallet.print'])(
    'does not apply the warehouse USB-HID exception to %s',
    async (workflow) => {
      const post = readyPost();
      post.agentStatus = 'offline';
      const { service } = setup(post);

      await expect(service.require('post-1', workflow, undefined, NOW)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'POST_AGENT_OFFLINE' }),
      });
    },
  );

  it.each([
    ['POST_NOT_COMMISSIONED', { commissioningState: 'uncommissioned', commissionedAt: null }],
    ['POST_AGENT_OFFLINE', { agentStatus: 'offline' }],
    ['POST_AGENT_HEARTBEAT_STALE', { lastSeenAt: new Date(NOW.getTime() - 91_000) }],
    ['GATEWAY_AGENT_UPGRADE_REQUIRED', { agentCompatibility: 'upgrade_required' }],
    ['POST_CAPABILITY_MISSING', { agentCapabilities: ['scale.read.v1'] }],
  ])('fails closed with %s', async (code, patch) => {
    const { service } = setup({ ...readyPost(), ...patch } as ReturnType<typeof readyPost>);

    await expect(
      service.require('post-1', 'operator.shift.open', undefined, NOW),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code }),
    });
  });

  it('rejects an active post without a commissioned physical topology', async () => {
    const post = readyPost();
    post.devices = post.devices.filter((device) => device.kind !== 'scale');
    const { service } = setup(post);

    await expect(
      service.require('post-1', 'operator.shift.open', undefined, NOW),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'POST_DEVICE_BINDING_UNAVAILABLE' }),
    });
  });

  it('rejects duplicate enabled bindings for the same device kind', async () => {
    const post = readyPost();
    post.devices.push({ ...post.devices[0], id: 'scale-2' });
    const { service } = setup(post);

    await expect(
      service.require('post-1', 'operator.weight.capture', undefined, NOW),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'POST_DEVICE_BINDING_UNAVAILABLE' }),
    });
  });

  it.each([
    ['POST_DEVICE_NOT_READY', { status: 'offline' }],
    ['POST_DEVICE_HEARTBEAT_STALE', { lastSeenAt: new Date(NOW.getTime() - 91_000) }],
    ['POST_DEVICE_PROBE_STALE', { lastProbeAt: new Date(NOW.getTime() - 91_000) }],
  ])('rejects an unusable bound device with %s', async (code, patch) => {
    const post = readyPost();
    post.devices[0] = { ...post.devices[0], ...patch };
    const { service } = setup(post);

    await expect(
      service.require('post-1', 'operator.weight.capture', undefined, NOW),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code }),
    });
  });

  it('returns a structured result without throwing from check()', async () => {
    const { service } = setup(null);

    await expect(service.check('missing', 'warehouse.scan', undefined, NOW)).resolves.toEqual({
      ready: false,
      code: 'POST_NOT_FOUND',
      message: 'Физический пост не найден.',
      workflow: 'warehouse.scan',
      post: null,
      devices: [],
    });
    await expect(
      service.require('missing', 'warehouse.scan', undefined, NOW),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
