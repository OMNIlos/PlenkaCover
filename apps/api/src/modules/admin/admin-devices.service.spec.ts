import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminDevicesService } from './admin-devices.service';

const actor = { userId: 'admin-1', role: 'admin' as const };
const physicalIdentity = { manufacturer: 'MASSA-K', scaleId: -12345, name: 'Line A / 01' };
const physicalParameters = {
  maximum: 'Max=150/300 kg',
  minimum: 'Min=1 kg',
  verificationInterval: 'e=50/100 g',
  maximumTare: 'T=-150 kg',
  fixation: 'Fix=0',
  calibrationCode: 'Code=634089',
  softwareVersion: 'U 38.1.6',
  softwareChecksum: '17F379',
};
const device = {
  id: 'device-1',
  code: 'SCALE-1',
  label: 'Весы 1',
  kind: 'scale',
  connectionKind: 'usb',
  isEnabled: true,
  status: 'ready',
  ownerRole: 'admin',
  lastSeenAt: new Date(),
  lastProbeAt: new Date(),
  lastTestAt: null,
  driverName: 'massa-k-protocol-100',
  driverVersion: '1',
  parsedPayload: null,
  recovery: null,
  postId: 'post-1',
  post: { id: 'post-1', code: 'POST-1', name: 'Станок 1', status: 'active' },
  createdAt: new Date(),
  updatedAt: new Date(),
};

function setup() {
  const tx = {
    deviceRuntime: {
      create: jest.fn().mockResolvedValue(device),
      update: jest.fn().mockResolvedValue(device),
    },
    domainEvent: { create: jest.fn() },
  };
  const prisma = {
    deviceRuntime: {
      findMany: jest.fn().mockResolvedValue([device]),
      findUnique: jest.fn().mockResolvedValue(device),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue(device),
    },
    post: { findUnique: jest.fn().mockResolvedValue(device.post) },
    operationalCheck: { findMany: jest.fn().mockResolvedValue([]) },
    operationalIncident: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((work) => work(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const gateway = {
    dispatchCommand: jest.fn().mockResolvedValue({
      ok: true,
      deviceId: 'device-1',
      status: 'ready',
      protocol: 'simulated',
      simulated: true,
      evidenceKind: 'simulated',
      physicalPass: false,
      message: 'responded',
    }),
  };
  const checks = { record: jest.fn().mockResolvedValue({ id: 'check-1' }) };
  const incidents = {
    signal: jest.fn().mockResolvedValue({ id: 'incident-1' }),
    resolveByFingerprint: jest.fn().mockResolvedValue(null),
  };
  const service = new AdminDevicesService(
    prisma as never,
    audit as never,
    gateway as never,
    checks as never,
    incidents as never,
  );
  return { service, prisma, tx, audit, gateway, checks, incidents };
}

describe('AdminDevicesService', () => {
  it('uses explicit safe selects for list and never exposes raw payload', async () => {
    const { service, prisma } = setup();
    const result = await service.list();
    expect(JSON.stringify(result)).not.toContain('rawPayload');
    const select = prisma.deviceRuntime.findMany.mock.calls[0][0].select;
    expect(select.parsedPayload).toBe(true);
    expect(select.driverName).toBe(true);
    expect(select.driverVersion).toBe(true);
    expect(select.rawPayload).toBeUndefined();
    expect(select.configFingerprint).toBeUndefined();
  });

  it('creates a bound device offline until a physical probe succeeds', async () => {
    const { service, tx, audit } = setup();

    await service.create(actor, {
      code: ' SCALE-6 ',
      label: ' Весы станка 6 ',
      kind: 'scale',
      connectionKind: ' usb-rs232 ',
      postId: 'post-1',
    });

    expect(tx.deviceRuntime.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          code: 'SCALE-6',
          label: 'Весы станка 6',
          kind: 'scale',
          connectionKind: 'usb-rs232',
          isEnabled: true,
          status: 'offline',
          ownerRole: 'admin',
          postId: 'post-1',
        },
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'admin.device.created',
        newValue: expect.objectContaining({ kind: 'scale', postId: 'post-1' }),
      }),
      tx,
    );
  });

  it('rejects an unknown, unbound, disabled or inactive-post device', async () => {
    const { service, prisma } = setup();
    prisma.deviceRuntime.findUnique.mockResolvedValueOnce(null);
    await expect(service.test(actor, 'missing')).rejects.toBeInstanceOf(NotFoundException);

    prisma.deviceRuntime.findUnique.mockResolvedValueOnce({ ...device, postId: null, post: null });
    await expect(service.test(actor, 'device-1')).rejects.toBeInstanceOf(ConflictException);

    prisma.deviceRuntime.findUnique.mockResolvedValueOnce({ ...device, isEnabled: false });
    await expect(service.test(actor, 'device-1')).rejects.toBeInstanceOf(ConflictException);

    prisma.deviceRuntime.findUnique.mockResolvedValueOnce({
      ...device,
      post: { ...device.post, status: 'inactive' },
    });
    await expect(service.test(actor, 'device-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('dispatches a gateway test, records quality fact and audit, and resolves its incident', async () => {
    const { service, gateway, checks, audit, incidents, prisma } = setup();

    const result = await service.test(actor, 'device-1');

    expect(result.status).toBe('ready');
    expect(gateway.dispatchCommand).toHaveBeenCalledWith('post-1', 'device_test', {
      deviceId: 'device-1',
      kind: 'scale',
    });
    expect(checks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'device',
        targetId: 'device-1',
        status: 'passed',
        summary: expect.objectContaining({ evidenceKind: 'simulated', physicalPass: false }),
      }),
    );
    expect(prisma.deviceRuntime.update).toHaveBeenCalledWith({
      where: { id: 'device-1' },
      data: expect.objectContaining({ status: 'ready', lastTestAt: expect.any(Date) }),
      select: expect.any(Object),
    });
    expect(incidents.resolveByFingerprint).toHaveBeenCalledWith(
      actor,
      'device:device-1:connection',
      'Device verification passed.',
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'admin.device.test_requested' }),
    );
  });

  it('does not mark recovery ready until verification succeeds', async () => {
    const { service, gateway, prisma } = setup();
    gateway.dispatchCommand
      .mockResolvedValueOnce({ ok: true, deviceId: 'device-1', status: 'recovering' })
      .mockResolvedValueOnce({ ok: false, deviceId: 'device-1', status: 'offline' });
    prisma.deviceRuntime.update.mockImplementation(({ data }) =>
      Promise.resolve({ ...device, ...data }),
    );

    const result = await service.recover(actor, 'device-1', 'Переподключён кабель');

    expect(gateway.dispatchCommand).toHaveBeenNthCalledWith(1, 'post-1', 'device_recover', {
      deviceId: 'device-1',
      kind: 'scale',
    });
    expect(gateway.dispatchCommand).toHaveBeenNthCalledWith(2, 'post-1', 'device_test', {
      deviceId: 'device-1',
      kind: 'scale',
    });
    expect(result.status).toBe('offline');
  });

  it('retains complete safe Protocol 100 evidence before granting physical PASS', async () => {
    const { service, gateway, checks } = setup();
    gateway.dispatchCommand.mockResolvedValue({
      ok: true,
      deviceId: 'device-1',
      status: 'ready',
      protocol: 'massa-k-protocol-100',
      simulated: false,
      evidenceKind: 'physical',
      physicalPass: true,
      stable: true,
      identity: physicalIdentity,
      parameters: physicalParameters,
    });

    await service.test(actor, 'device-1');

    expect(checks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.objectContaining({
          physicalPass: true,
          identity: physicalIdentity,
          parameters: physicalParameters,
        }),
      }),
    );
  });

  it('keeps physical confirmation pending separate from transport connectivity', async () => {
    const { service, gateway, checks, incidents, prisma } = setup();
    const printer = { ...device, kind: 'printer', code: 'PRINTER-1', label: 'Принтер 1' };
    prisma.deviceRuntime.findUnique.mockResolvedValue(printer);
    prisma.deviceRuntime.update.mockImplementation(({ data }) =>
      Promise.resolve({ ...printer, ...data }),
    );
    gateway.dispatchCommand.mockResolvedValue({
      ok: true,
      deviceId: printer.id,
      status: 'ready',
      evidenceKind: 'physical_pending',
      physicalPass: false,
      confirmationRequired: true,
      message: 'untrusted agent text',
    });

    const result = await service.test(actor, printer.id);

    expect(result.status).toBe('unstable');
    expect(checks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'degraded',
        summary: expect.objectContaining({
          ok: false,
          connectivityReady: true,
          evidenceKind: 'physical_pending',
          physicalPass: false,
          confirmationRequired: true,
        }),
      }),
    );
    expect(prisma.deviceRuntime.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'unstable',
          parsedPayload: expect.objectContaining({
            connectivityReady: true,
            confirmationRequired: true,
          }),
        }),
      }),
    );
    expect(incidents.resolveByFingerprint).not.toHaveBeenCalled();
    expect(incidents.signal).not.toHaveBeenCalled();
  });

  it('never promotes an agent-authored message into the persisted admin test projection', async () => {
    const { service, gateway, checks } = setup();
    gateway.dispatchCommand.mockResolvedValue({
      ok: false,
      deviceId: 'device-1',
      status: 'offline',
      message: '01 03 00 00 FF AA raw controller frame',
    });

    await service.test(actor, 'device-1');

    const summary = checks.record.mock.calls[0][0].summary;
    expect(JSON.stringify(summary)).not.toContain('01 03 00 00 FF AA');
    expect(summary.message).toBe('Device test failed (offline).');
  });

  it.each([
    ['missing', undefined],
    ['empty', {}],
    ['partial', { maximum: physicalParameters.maximum }],
    ['malformed', { ...physicalParameters, fixation: 'bad' }],
  ])('rejects agent physical PASS with %s Protocol 100 parameters', async (_case, parameters) => {
    const { service, gateway, checks, incidents, prisma } = setup();
    prisma.deviceRuntime.update.mockImplementation(({ data }) =>
      Promise.resolve({ ...device, ...data }),
    );
    gateway.dispatchCommand.mockResolvedValue({
      ok: true,
      deviceId: 'device-1',
      status: 'ready',
      protocol: 'massa-k-protocol-100',
      simulated: false,
      evidenceKind: 'physical',
      physicalPass: true,
      stable: true,
      identity: physicalIdentity,
      parameters,
    });

    await service.test(actor, 'device-1');

    expect(checks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.objectContaining({ physicalPass: false }),
      }),
    );
    expect(checks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'degraded',
        summary: expect.objectContaining({
          connectivityReady: true,
          physicalPass: false,
        }),
      }),
    );
    expect(prisma.deviceRuntime.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'unstable' }) }),
    );
    expect(incidents.resolveByFingerprint).not.toHaveBeenCalled();
  });

  it('binds a device to an existing post transactionally with audit', async () => {
    const { service, tx, audit } = setup();
    await service.bind(actor, 'device-1', { postId: 'post-2', reason: 'Перенос на станок 2' });
    expect(tx.deviceRuntime.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'device-1' }, data: { postId: 'post-2' } }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'admin.device.bound', reason: 'Перенос на станок 2' }),
      tx,
    );
  });
});
