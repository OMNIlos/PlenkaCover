import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';

function setup() {
  const prisma: any = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: 'u1', role: 'operator' }),
      update: jest.fn().mockResolvedValue({ id: 'u1', role: 'warehouse' }),
      findMany: jest.fn(),
    },
    accessTemplate: { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn() },
    deviceRuntime: {
      findUnique: jest.fn().mockResolvedValue({ id: 'dev1', kind: 'scale' }),
      update: jest.fn().mockResolvedValue({ id: 'dev1' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    syncJournal: {
      findUnique: jest.fn().mockResolvedValue({ id: 'sj1', entity: 'finance_order' }),
      update: jest.fn().mockResolvedValue({ id: 'sj1' }),
      findMany: jest.fn(),
    },
    sourceSnapshot: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'snap-1', parsed: { ok: true }, rawPayload: { secret: true } }),
    },
    post: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'p1', code: 'POST-6', name: 'Станок 6' }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
  const audit = { record: jest.fn() };
  return { prisma, audit };
}

async function build(prisma: any, audit: any): Promise<AdminService> {
  const mod = await Test.createTestingModule({
    providers: [
      AdminService,
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: audit },
    ],
  }).compile();
  return mod.get(AdminService);
}

const actor = { userId: 'admin1', role: 'admin' as const };

describe('AdminService', () => {
  it('testDevice audits admin.device.test_requested', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);
    await service.testDevice(actor, 'dev1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'admin.device.test_requested' }),
    );
  });

  it('retrySourceHealth audits sync_retry_requested', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);
    await service.retrySourceHealth(actor, 'sj1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:sync_retry_requested' }),
    );
  });

  it('getDiagnostic EXPOSES rawPayload (the admin-only §8 exception)', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);
    const result: any = await service.getDiagnostic('snap-1');
    expect(result.rawPayload).toEqual({ secret: true });
    expect(result.diagnosticType).toBe('source_snapshot');
  });

  it('listDevices select omits rawPayload', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);
    await service.listDevices();
    const arg = prisma.deviceRuntime.findMany.mock.calls[0][0];
    expect(arg.select.parsedPayload).toBe(true);
    expect(arg.select.rawPayload).toBeUndefined();
  });
});

describe('AdminService — posts (V2 S2)', () => {
  it('listPosts returns posts with online state, devices and a device count', async () => {
    const { prisma, audit } = setup();
    prisma.post.findMany.mockResolvedValue([
      {
        id: 'p1',
        code: 'POST-1',
        name: 'Станок 1',
        status: 'active',
        agentStatus: 'online',
        lastSeenAt: new Date(),
        _count: { devices: 3 },
        devices: [{ id: 'dev-scale-1', kind: 'scale', status: 'ready', lastSeenAt: null }],
      },
    ]);
    const service = await build(prisma, audit);
    const res = await service.listPosts();
    expect(res[0]).toMatchObject({
      code: 'POST-1',
      deviceCount: 3,
      connectionState: 'online',
      online: true,
    });
    expect(res[0].devices[0]).toMatchObject({ id: 'dev-scale-1', kind: 'scale' });
    // Device select stays raw-free — rawPayload is admin *diagnostics* only (ТЗ §8).
    const arg = prisma.post.findMany.mock.calls[0][0];
    expect(arg.include.devices.select.rawPayload).toBeUndefined();
    expect(arg.include.devices.select.parsedPayload).toBeUndefined();
  });

  it('createPost creates a machine-post from data (new станок = no code change)', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);
    const res = await service.createPost(actor, { code: 'POST-6', name: 'Станок 6' });
    expect(prisma.post.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ code: 'POST-6', name: 'Станок 6' }),
      }),
    );
    expect(res.code).toBe('POST-6');
  });

  it('getPost projects online state + devices WITHOUT rawPayload', async () => {
    const { prisma, audit } = setup();
    prisma.post.findUnique.mockResolvedValue({
      id: 'p1',
      code: 'POST-1',
      name: 'Станок 1',
      status: 'active',
      agentStatus: 'online',
      lastSeenAt: null,
      devices: [{ id: 'd1', kind: 'scale', status: 'ready', parsedPayload: { v: 1 } }],
    });
    const service = await build(prisma, audit);
    const res: any = await service.getPost('p1');
    expect(res).toMatchObject({ online: false, connectionState: 'unknown' });
    expect(res.devices[0].kind).toBe('scale');
    const arg = prisma.post.findUnique.mock.calls[0][0];
    expect(arg.include.devices.select.parsedPayload).toBe(true);
    expect(arg.include.devices.select.rawPayload).toBeUndefined();
  });

  it('getPost throws NotFound for an unknown id', async () => {
    const { prisma, audit } = setup();
    prisma.post.findUnique.mockResolvedValue(null);
    const service = await build(prisma, audit);
    await expect(service.getPost('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
