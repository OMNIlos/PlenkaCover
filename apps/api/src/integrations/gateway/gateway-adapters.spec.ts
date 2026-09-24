import { GatewayScaleAdapter } from './gateway-scale.adapter';
import { GatewayPrinterAdapter } from './gateway-printer.adapter';
import { GatewayCommandTimeoutError } from '../../modules/gateway/gateway.service';

function scaleSetup(deviceRow: unknown, dispatch: jest.Mock) {
  const prisma = {
    post: {
      findUnique: jest.fn().mockResolvedValue({
        agentCompatibility: 'compatible',
        agentCapabilities: ['scale.read.v1'],
      }),
    },
    deviceRuntime: { findFirst: jest.fn().mockResolvedValue(deviceRow) },
  };
  const gateway = { dispatchCommand: dispatch };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { prisma, gateway, adapter: new GatewayScaleAdapter(prisma as any, gateway as any) };
}

function printerSetup(deviceRow: unknown, dispatch: jest.Mock) {
  const prisma = {
    post: {
      findUnique: jest.fn().mockResolvedValue({
        agentCompatibility: 'compatible',
        agentCapabilities: [
          'printer.roll-label.v1',
          'printer.big-bag-label.v1',
          'printer.pallet-label.v1',
        ],
      }),
    },
    deviceRuntime: { findFirst: jest.fn().mockResolvedValue(deviceRow) },
  };
  const gateway = { dispatchCommand: dispatch };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { prisma, gateway, adapter: new GatewayPrinterAdapter(prisma as any, gateway as any) };
}

describe('GatewayScaleAdapter (drop-in, ScaleAdapter interface)', () => {
  const binding = {
    deviceId: 'dev-scale-1',
    expectedPostId: 'post-1',
    expectedKind: 'scale' as const,
  };

  it('dispatches read_scale to the device post and maps a stable reading', async () => {
    const dispatch = jest.fn().mockResolvedValue({
      ok: true,
      deviceId: 'dev-scale-1',
      status: 'ready',
      stable: true,
      grossKg: 2,
    });
    const { adapter, gateway, prisma } = scaleSetup(
      { id: 'dev-scale-1', postId: 'post-1', kind: 'scale', isEnabled: true, status: 'ready' },
      dispatch,
    );
    const r = await adapter.read(binding, 'spool');
    expect(prisma.deviceRuntime.findFirst).toHaveBeenCalledWith({
      where: {
        id: binding.deviceId,
        postId: binding.expectedPostId,
        kind: binding.expectedKind,
        isEnabled: true,
        status: 'ready',
      },
      select: { id: true },
    });
    expect(gateway.dispatchCommand).toHaveBeenCalledWith('post-1', 'read_scale', {
      deviceId: 'dev-scale-1',
      kind: 'spool',
    });
    expect(r).toMatchObject({ deviceId: 'dev-scale-1', status: 'ready', stable: true, grossKg: 2 });
  });

  it('maps an agent failure (`ok: false`) to an offline reading — never a fake ready', async () => {
    const dispatch = jest.fn().mockResolvedValue({ ok: false, error: 'serial port not available' });
    const { adapter } = scaleSetup(
      { id: 'dev-scale-1', postId: 'post-1', kind: 'scale', isEnabled: true, status: 'ready' },
      dispatch,
    );
    await expect(adapter.read(binding, 'roll')).resolves.toMatchObject({
      status: 'offline',
      stable: false,
      grossKg: 0,
    });
  });

  it.each([undefined, 'other-post-scale'])(
    'rejects a successful-looking response with untrusted device identity (%s)',
    async (deviceId) => {
      const dispatch = jest
        .fn()
        .mockResolvedValue({ ok: true, deviceId, status: 'ready', stable: true, grossKg: 12 });
      const { adapter } = scaleSetup(
        {
          id: 'dev-scale-1',
          postId: 'post-1',
          kind: 'scale',
          isEnabled: true,
          status: 'ready',
        },
        dispatch,
      );

      await expect(adapter.read(binding, 'roll')).resolves.toMatchObject({
        deviceId: 'dev-scale-1',
        status: 'offline',
        stable: false,
        grossKg: 0,
      });
    },
  );

  it('returns an offline reading when the gateway times out (→ operator 503 path)', async () => {
    const dispatch = jest.fn().mockRejectedValue(new Error('timed out'));
    const { adapter } = scaleSetup(
      { id: 'dev-scale-1', postId: 'post-1', kind: 'scale', isEnabled: true, status: 'ready' },
      dispatch,
    );
    await expect(adapter.read(binding, 'spool')).resolves.toMatchObject({
      status: 'offline',
      stable: false,
    });
  });

  it('returns offline (no dispatch) when the device is not bound to a post', async () => {
    const dispatch = jest.fn();
    const { adapter } = scaleSetup(null, dispatch);
    const r = await adapter.read(binding, 'spool');
    expect(r.status).toBe('offline');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('fails closed when the scale is rebound after dispatch and never changes destination', async () => {
    const dispatch = jest.fn().mockResolvedValue({
      ok: true,
      deviceId: 'dev-scale-1',
      status: 'ready',
      stable: true,
      grossKg: 12,
    });
    const { adapter, prisma } = scaleSetup(
      { id: 'dev-scale-1', postId: 'post-1', kind: 'scale', isEnabled: true, status: 'ready' },
      dispatch,
    );
    prisma.deviceRuntime.findFirst
      .mockResolvedValueOnce({
        id: 'dev-scale-1',
        postId: 'post-1',
        kind: 'scale',
        isEnabled: true,
        status: 'ready',
      })
      .mockResolvedValueOnce(null);

    await expect(adapter.read(binding, 'roll')).resolves.toMatchObject({
      status: 'offline',
      stable: false,
    });
    expect(dispatch).toHaveBeenCalledWith('post-1', 'read_scale', expect.any(Object));
  });
});

describe('GatewayPrinterAdapter (drop-in, PrinterAdapter interface)', () => {
  const binding = {
    deviceId: 'dev-printer-1',
    expectedPostId: 'post-1',
    expectedKind: 'printer' as const,
  };

  it('dispatches print and maps a printed job', async () => {
    const dispatch = jest.fn().mockResolvedValue({
      ok: true,
      jobId: 'sim-1',
      status: 'printed',
      gatewayCommandId: 'gateway-command-1',
    });
    const { adapter, gateway } = printerSetup(
      { id: 'dev-printer-1', postId: 'post-1', kind: 'printer', isEnabled: true, status: 'ready' },
      dispatch,
    );
    const payload = { kind: 'roll_label' as const, rollCode: 'A-1024-roll-1', qrCode: 'QR-x' };
    const r = await adapter.print(binding, payload);
    expect(gateway.dispatchCommand).toHaveBeenCalledWith('post-1', 'print', {
      printerId: 'dev-printer-1',
      ...payload,
    });
    expect(r).toMatchObject({
      jobId: 'sim-1',
      printerId: 'dev-printer-1',
      status: 'printed',
      gatewayCommandId: 'gateway-command-1',
    });
  });

  it('preserves an acknowledged physical transport submission as submitted', async () => {
    const dispatch = jest.fn().mockResolvedValue({
      ok: true,
      jobId: 'tcp-1',
      status: 'submitted',
      gatewayCommandId: 'gateway-command-submitted',
    });
    const { adapter } = printerSetup(
      { id: 'dev-printer-1', postId: 'post-1', kind: 'printer', isEnabled: true, status: 'ready' },
      dispatch,
    );

    await expect(
      adapter.print(binding, { kind: 'roll_label', rollCode: 'x', qrCode: 'QR-x' }),
    ).resolves.toMatchObject({
      jobId: 'tcp-1',
      printerId: 'dev-printer-1',
      status: 'submitted',
      gatewayCommandId: 'gateway-command-submitted',
    });
  });

  it('does not create a Big-Bag print command when the exact capability is absent', async () => {
    const dispatch = jest.fn();
    const { adapter, prisma } = printerSetup({ id: 'dev-printer-1' }, dispatch);
    prisma.post.findUnique.mockResolvedValue({
      agentCompatibility: 'compatible',
      agentCapabilities: ['printer.roll-label.v1'],
    });

    await expect(
      adapter.print(binding, {
        kind: 'big_bag_label',
        destination: 'warehouse',
        bigBagCode: 'BB-1',
        material: 'ПВД',
        qrCode: `bbt_${'a'.repeat(64)}`,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'gateway_agent_upgrade_required',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('maps an agent print failure to a categorical reason without exposing driver details', async () => {
    const dispatch = jest.fn().mockResolvedValue({
      ok: false,
      status: 'failed',
      error: '192.168.10.25 token=private-printer-token',
    });
    const { adapter } = printerSetup(
      { id: 'dev-printer-1', postId: 'post-1', kind: 'printer', isEnabled: true, status: 'ready' },
      dispatch,
    );
    await expect(
      adapter.print(binding, { kind: 'roll_label', rollCode: 'x', qrCode: 'QR-x' }),
    ).resolves.toMatchObject({ status: 'failed', failureReason: 'printer_transport_failed' });
  });

  it('returns delivery_unknown on gateway timeout because physical submission may have happened', async () => {
    const dispatch = jest
      .fn()
      .mockRejectedValue(
        new GatewayCommandTimeoutError('gateway-command-timeout', 'delivery_unknown'),
      );
    const { adapter } = printerSetup(
      { id: 'dev-printer-1', postId: 'post-1', kind: 'printer', isEnabled: true, status: 'ready' },
      dispatch,
    );
    await expect(
      adapter.print(binding, { kind: 'roll_label', rollCode: 'x', qrCode: 'y' }),
    ).resolves.toMatchObject({
      status: 'delivery_unknown',
      failureReason: 'gateway_transport_outcome_unknown',
      gatewayCommandId: 'gateway-command-timeout',
    });
  });

  it('returns a safe failure when the agent never claimed the print command', async () => {
    const dispatch = jest
      .fn()
      .mockRejectedValue(new GatewayCommandTimeoutError('gateway-command-expired', 'expired'));
    const { adapter } = printerSetup(
      { id: 'dev-printer-1', postId: 'post-1', kind: 'printer', isEnabled: true, status: 'ready' },
      dispatch,
    );

    await expect(
      adapter.print(binding, { kind: 'roll_label', rollCode: 'x', qrCode: 'y' }),
    ).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'gateway_command_not_dispatched',
      gatewayCommandId: 'gateway-command-expired',
    });
  });

  it('preserves delivery_unknown reported by the on-post printer driver', async () => {
    const dispatch = jest.fn().mockResolvedValue({
      ok: false,
      status: 'delivery_unknown',
      error: 'printer connection closed after bytes were submitted',
      gatewayCommandId: 'gateway-command-1',
    });
    const { adapter } = printerSetup(
      { id: 'dev-printer-1', postId: 'post-1', kind: 'printer', isEnabled: true, status: 'ready' },
      dispatch,
    );

    await expect(
      adapter.print(binding, { kind: 'roll_label', rollCode: 'x', qrCode: 'y' }),
    ).resolves.toMatchObject({
      status: 'delivery_unknown',
      failureReason: 'printer_delivery_outcome_unknown',
      gatewayCommandId: 'gateway-command-1',
    });
  });

  it('treats a contradictory printed/error response as delivery_unknown', async () => {
    const dispatch = jest.fn().mockResolvedValue({
      ok: false,
      status: 'printed',
      error: 'contradictory agent result',
      jobId: 'device-job-contradictory',
      gatewayCommandId: 'gateway-command-contradictory',
    });
    const { adapter } = printerSetup(
      { id: 'dev-printer-1', postId: 'post-1', kind: 'printer', isEnabled: true, status: 'ready' },
      dispatch,
    );

    await expect(
      adapter.print(binding, { kind: 'roll_label', rollCode: 'x', qrCode: 'y' }),
    ).resolves.toMatchObject({
      status: 'delivery_unknown',
      failureReason: 'printer_delivery_outcome_unknown',
      gatewayCommandId: 'gateway-command-contradictory',
    });
  });

  it('treats a malformed post-dispatch status as delivery_unknown', async () => {
    const dispatch = jest.fn().mockResolvedValue({
      ok: false,
      status: 'unexpected_runtime_status',
      error: 'malformed agent result',
      gatewayCommandId: 'gateway-command-malformed',
    });
    const { adapter } = printerSetup(
      { id: 'dev-printer-1', postId: 'post-1', kind: 'printer', isEnabled: true, status: 'ready' },
      dispatch,
    );

    await expect(
      adapter.print(binding, { kind: 'roll_label', rollCode: 'x', qrCode: 'y' }),
    ).resolves.toMatchObject({
      status: 'delivery_unknown',
      failureReason: 'printer_result_status_unknown',
      gatewayCommandId: 'gateway-command-malformed',
    });
  });

  it('returns delivery_unknown when binding changes after an acknowledged print', async () => {
    const dispatch = jest.fn().mockResolvedValue({
      ok: true,
      jobId: 'job-1',
      status: 'printed',
      gatewayCommandId: 'gateway-command-1',
    });
    const { adapter, prisma } = printerSetup(
      { id: 'dev-printer-1', postId: 'post-1', kind: 'printer', isEnabled: true, status: 'ready' },
      dispatch,
    );
    prisma.deviceRuntime.findFirst
      .mockResolvedValueOnce({
        id: 'dev-printer-1',
        postId: 'post-1',
        kind: 'printer',
        isEnabled: true,
        status: 'ready',
      })
      .mockResolvedValueOnce(null);

    await expect(
      adapter.print(binding, { kind: 'roll_label', rollCode: 'x', qrCode: 'QR-x' }),
    ).resolves.toMatchObject({
      status: 'delivery_unknown',
      failureReason: 'binding_changed_after_acknowledged_print',
      gatewayCommandId: 'gateway-command-1',
    });
    expect(dispatch).toHaveBeenCalledWith('post-1', 'print', expect.any(Object));
  });

  it('returns delivery_unknown when binding verification errors after an acknowledged print', async () => {
    const dispatch = jest.fn().mockResolvedValue({
      ok: true,
      jobId: 'job-1',
      status: 'printed',
      gatewayCommandId: 'gateway-command-1',
    });
    const { adapter, prisma } = printerSetup(
      { id: 'dev-printer-1', postId: 'post-1', kind: 'printer', isEnabled: true, status: 'ready' },
      dispatch,
    );
    prisma.deviceRuntime.findFirst
      .mockResolvedValueOnce({ id: 'dev-printer-1' })
      .mockRejectedValueOnce(new Error('database unavailable after acknowledgement'));

    await expect(
      adapter.print(binding, { kind: 'roll_label', rollCode: 'x', qrCode: 'QR-x' }),
    ).resolves.toMatchObject({
      status: 'delivery_unknown',
      failureReason: 'binding_verification_unavailable_after_acknowledged_print',
      gatewayCommandId: 'gateway-command-1',
    });
  });
});
