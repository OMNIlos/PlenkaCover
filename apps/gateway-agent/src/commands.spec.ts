import {
  GATEWAY_PROTOCOL_VERSION,
  PALLET_LABEL_PROFILE,
  type PrinterPayload,
} from '@plenka/contracts';
import { handleCommand, type AgentDevices } from './commands';
import type { PrinterDevice, PrintResult } from './devices/printer';
import type { ScaleDevice, ScaleReadResult } from './devices/scale';

const UNSAFE_PROBE_VALUE = 'f855ce0123456789 at /dev/serial/by-id/private token=platform-secret';
const SAFE_PROBE_PARAMETERS = {
  maximum: 'Max 6/15 кг',
  minimum: 'Min 0,04 кг',
  verificationInterval: 'e = 2/5 г',
  maximumTare: 'T = - 6 кг',
  fixation: 'Fix = 0',
  calibrationCode: 'Code = 012345',
  softwareVersion: 'V3',
  softwareChecksum: 'F855CE01',
};
const SAFE_PHYSICAL_IDENTITY = {
  manufacturer: 'MASSA-K',
  scaleId: -12345,
  name: 'Line A / 01',
};
const ROLL_SCAN_TOKEN = `prt_${'a'.repeat(64)}`;

function devices(overrides?: {
  scaleProbe?: ScaleDevice['probe'];
  scaleRead?: () => Promise<ScaleReadResult>;
  print?: (payload: PrinterPayload) => Promise<PrintResult>;
  printerMode?: 'simulated' | 'tcp9100' | 'windows-command';
}): AgentDevices {
  const scale: ScaleDevice = {
    probe:
      overrides?.scaleProbe ??
      (async () => ({
        ok: true,
        status: 'ready',
        protocol: 'simulated',
        simulated: true,
      })),
    read:
      overrides?.scaleRead ??
      (async () => ({ status: 'ready', stable: true, grossKg: 43.4, raw: 'ST,GS,+43.40kg' })),
    status: () => 'ready',
    close: async () => {},
  };
  const printer: PrinterDevice = {
    print: overrides?.print ?? (async () => ({ ok: true, jobId: 'job-1', status: 'printed' })),
    status: () => 'ready',
  };
  return {
    scale,
    scaleDeviceId: 'dev-scale-1',
    printer,
    printerDeviceId: 'dev-printer-1',
    printerMode: overrides?.printerMode ?? 'simulated',
    scanner: { status: () => 'ready' },
    scannerDeviceId: 'dev-scanner-1',
  };
}

describe('handleCommand — read_scale', () => {
  it('executes a validated V2 scale envelope', async () => {
    const scaleRead = jest.fn().mockResolvedValue({ status: 'ready', stable: true, grossKg: 43.4 });
    const { result } = await handleCommand(
      {
        id: 'c1-v2',
        protocolVersion: GATEWAY_PROTOCOL_VERSION,
        kind: 'scale.read.v1',
        payload: { deviceId: 'dev-scale-1', sample: 'roll' },
      },
      devices({ scaleRead }),
    );

    expect(scaleRead).toHaveBeenCalledWith('roll');
    expect(result).toMatchObject({ ok: true, status: 'ready', grossKg: 43.4 });
  });

  it('maps a stable reading to the GatewayScaleAdapter contract', async () => {
    const { result } = await handleCommand(
      { id: 'c1', kind: 'read_scale', payload: { deviceId: 'dev-scale-1', kind: 'roll' } },
      devices(),
    );
    expect(result).toEqual({
      ok: true,
      deviceId: 'dev-scale-1',
      status: 'ready',
      stable: true,
      grossKg: 43.4,
    });
  });

  it('keeps the RAW frame OUT of the command result — raw goes to ingest events only', async () => {
    const { result, events } = await handleCommand(
      { id: 'c1', kind: 'read_scale', payload: { deviceId: 'dev-scale-1', kind: 'spool' } },
      devices(),
    );
    expect(JSON.stringify(result)).not.toContain('ST,GS');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'weight',
      payload: { deviceId: 'dev-scale-1', kind: 'spool', grossKg: 43.4 },
      rawPayload: { frame: 'ST,GS,+43.40kg' },
    });
  });

  it('reports an offline scale honestly (ok true + status offline → backend 503 path)', async () => {
    const { result } = await handleCommand(
      { id: 'c1', kind: 'read_scale', payload: { deviceId: 'dev-scale-1', kind: 'roll' } },
      devices({ scaleRead: async () => ({ status: 'offline', stable: false, grossKg: 0 }) }),
    );
    expect(result).toEqual({
      ok: true,
      deviceId: 'dev-scale-1',
      status: 'offline',
      stable: false,
      grossKg: 0,
    });
  });

  it('maps a device exception to ok:false (backend marks the command failed)', async () => {
    const { result } = await handleCommand(
      { id: 'c1', kind: 'read_scale', payload: { deviceId: 'dev-scale-1' } },
      devices({
        scaleRead: async () => {
          throw new Error('COM3 gone');
        },
      }),
    );
    expect(result).toEqual({
      ok: false,
      status: 'failed',
      reasonCode: 'device_command_failed',
    });
    expect(JSON.stringify(result)).not.toContain('COM3');
  });

  it.each([undefined, 'other-post-scale'])(
    'rejects an unbound scale id (%s) without touching hardware',
    async (deviceId) => {
      const scaleRead = jest.fn().mockResolvedValue({
        status: 'ready',
        stable: true,
        grossKg: 43.4,
      });
      const payload = deviceId === undefined ? { kind: 'roll' } : { deviceId, kind: 'roll' };

      const { result, events } = await handleCommand(
        { id: 'c1', kind: 'read_scale', payload },
        devices({ scaleRead }),
      );

      expect(result).toEqual({
        ok: false,
        status: 'misconfigured',
        error: 'scale is not configured on this post agent',
      });
      expect(events).toEqual([]);
      expect(scaleRead).not.toHaveBeenCalled();
    },
  );
});

describe('handleCommand — print', () => {
  it('validates and executes a V2 label envelope', async () => {
    const print = jest.fn().mockResolvedValue({ ok: true, jobId: 'job-v2', status: 'printed' });
    const { result } = await handleCommand(
      {
        id: 'c2-v2',
        protocolVersion: GATEWAY_PROTOCOL_VERSION,
        kind: 'label.print.v1',
        payload: {
          printerId: 'dev-printer-1',
          label: {
            schemaVersion: 1,
            kind: 'roll_label',
            rollCode: 'A-1024-roll-1',
            qrCode: ROLL_SCAN_TOKEN,
          },
        },
      },
      devices({ print }),
    );

    expect(print).toHaveBeenCalledWith({
      kind: 'roll_label',
      rollCode: 'A-1024-roll-1',
      qrCode: ROLL_SCAN_TOKEN,
    });
    expect(result).toEqual({ ok: true, jobId: 'job-v2', status: 'printed' });
  });

  it('rejects an unknown protocol before touching the printer', async () => {
    const print = jest
      .fn()
      .mockResolvedValue({ ok: true, jobId: 'must-not-run', status: 'printed' });
    const { result } = await handleCommand(
      {
        id: 'c2-future',
        protocolVersion: 99,
        kind: 'label.print.v1',
        payload: {
          printerId: 'dev-printer-1',
          label: {
            schemaVersion: 1,
            kind: 'roll_label',
            rollCode: 'ROLL-1',
            qrCode: ROLL_SCAN_TOKEN,
          },
        },
      },
      devices({ print }),
    );

    expect(result).toEqual({
      ok: false,
      status: 'failed',
      reasonCode: 'gateway_command_protocol_unsupported',
    });
    expect(print).not.toHaveBeenCalled();
  });

  it('executes explicitly routed Big-Bag labels only under schema v2', async () => {
    const print = jest.fn().mockResolvedValue({ ok: true, jobId: 'defect-v2', status: 'printed' });
    const label = {
      kind: 'big_bag_label',
      destination: 'operator',
      bigBagCode: 'DEFECT-BAG-1',
      material: 'Бракованная плёнка',
      qrCode: `bbt_${'b'.repeat(64)}`,
    };

    const accepted = await handleCommand(
      {
        id: 'defect-v2',
        protocolVersion: GATEWAY_PROTOCOL_VERSION,
        kind: 'label.print.v1',
        payload: {
          printerId: 'dev-printer-1',
          label: { schemaVersion: 2, ...label },
        },
      },
      devices({ print }),
    );
    const acceptedWarehouse = await handleCommand(
      {
        id: 'warehouse-v2',
        protocolVersion: GATEWAY_PROTOCOL_VERSION,
        kind: 'label.print.v1',
        payload: {
          printerId: 'dev-printer-1',
          label: { schemaVersion: 2, ...label, destination: 'warehouse' },
        },
      },
      devices({ print }),
    );
    const rejected = await handleCommand(
      {
        id: 'defect-v1',
        protocolVersion: GATEWAY_PROTOCOL_VERSION,
        kind: 'label.print.v1',
        payload: {
          printerId: 'dev-printer-1',
          label: {
            schemaVersion: 1,
            kind: 'big_bag_label',
            bigBagCode: 'DEFECT-BAG-1',
            material: 'Бракованная плёнка',
            qrCode: `bbt_${'b'.repeat(64)}`,
          },
        },
      },
      devices({ print }),
    );

    expect(accepted.result).toEqual({ ok: true, jobId: 'defect-v2', status: 'printed' });
    expect(acceptedWarehouse.result).toEqual({
      ok: true,
      jobId: 'defect-v2',
      status: 'printed',
    });
    expect(rejected.result).toEqual({
      ok: false,
      status: 'failed',
      reasonCode: 'gateway_command_envelope_invalid',
    });
    expect(print).toHaveBeenCalledTimes(2);
    expect(print).toHaveBeenCalledWith(label);
    expect(print).toHaveBeenCalledWith({ ...label, destination: 'warehouse' });
  });

  it('maps a successful print to the GatewayPrinterAdapter contract', async () => {
    const { result } = await handleCommand(
      {
        id: 'c2',
        kind: 'print',
        payload: {
          printerId: 'dev-printer-1',
          kind: 'roll_label',
          rollCode: 'A-1024-roll-1',
          qrCode: ROLL_SCAN_TOKEN,
        },
      },
      devices(),
    );
    expect(result).toEqual({ ok: true, jobId: 'job-1', status: 'printed' });
  });

  it('preserves physical transport submission without promoting it to printed', async () => {
    const { result } = await handleCommand(
      {
        id: 'c-submitted',
        kind: 'print',
        payload: {
          printerId: 'dev-printer-1',
          kind: 'roll_label',
          rollCode: 'A-1024-roll-1',
          qrCode: ROLL_SCAN_TOKEN,
        },
      },
      devices({
        printerMode: 'tcp9100',
        print: async () => ({ ok: true, jobId: 'tcp-1', status: 'submitted' }),
      }),
    );

    expect(result).toEqual({ ok: true, jobId: 'tcp-1', status: 'submitted' });
  });

  it('maps a printer failure to a categorical business-safe reason', async () => {
    const { result } = await handleCommand(
      {
        id: 'c2',
        kind: 'print',
        payload: {
          printerId: 'dev-printer-1',
          kind: 'roll_label',
          rollCode: 'x',
          qrCode: ROLL_SCAN_TOKEN,
        },
      },
      devices({
        print: async () => ({
          ok: false,
          status: 'failed',
          error: '192.168.10.25 token=private-printer-token',
        }),
      }),
    );
    expect(result).toEqual({
      ok: false,
      status: 'failed',
      reasonCode: 'printer_transport_failed',
    });
  });

  it('preserves an uncertain physical delivery instead of making it safely retryable', async () => {
    const deliveryUnknown = {
      ok: false,
      status: 'delivery_unknown',
      error: 'tcp connection closed after label bytes were submitted',
    } satisfies PrintResult;
    const { result } = await handleCommand(
      {
        id: 'c2',
        kind: 'print',
        payload: {
          printerId: 'dev-printer-1',
          kind: 'roll_label',
          rollCode: 'x',
          qrCode: ROLL_SCAN_TOKEN,
        },
      },
      devices({ print: async () => deliveryUnknown }),
    );

    expect(result).toEqual({
      ok: false,
      status: 'delivery_unknown',
      reasonCode: 'printer_delivery_outcome_unknown',
    });
  });

  it('treats a thrown printer driver result as delivery_unknown after invocation', async () => {
    const { result } = await handleCommand(
      {
        id: 'c2',
        kind: 'print',
        payload: {
          printerId: 'dev-printer-1',
          kind: 'roll_label',
          rollCode: 'x',
          qrCode: ROLL_SCAN_TOKEN,
        },
      },
      devices({
        print: async () => {
          throw new Error('custom driver lost acknowledgement');
        },
      }),
    );

    expect(result).toEqual({
      ok: false,
      status: 'delivery_unknown',
      reasonCode: 'printer_delivery_outcome_unknown',
    });
  });

  it('rejects an incomplete print payload', async () => {
    const { result } = await handleCommand({ id: 'c2', kind: 'print', payload: {} }, devices());
    expect(result.ok).toBe(false);
  });

  it('rejects a printer id that is not bound to this post without touching hardware', async () => {
    const print = jest
      .fn()
      .mockResolvedValue({ ok: true, jobId: 'must-not-run', status: 'printed' });
    const { result, events } = await handleCommand(
      {
        id: 'c2',
        kind: 'print',
        payload: {
          printerId: 'other-post-printer',
          kind: 'roll_label',
          rollCode: 'x',
          qrCode: ROLL_SCAN_TOKEN,
        },
      },
      devices({ print }),
    );

    expect(result).toMatchObject({ ok: false, status: 'failed' });
    expect(events).toEqual([]);
    expect(print).not.toHaveBeenCalled();
  });

  it('validates and forwards one pallet payload without printerId or bitmap echo', async () => {
    const print = jest
      .fn()
      .mockResolvedValue({ ok: true, jobId: 'pallet-job-1', status: 'printed' });
    const bitmapBase64 = Buffer.alloc(PALLET_LABEL_PROFILE.bitmapBytes).toString('base64');
    const payload = {
      printerId: 'dev-printer-1',
      kind: 'pallet_label' as const,
      documentId: 'document-1',
      templateVersion: PALLET_LABEL_PROFILE.templateVersion,
      widthMm: PALLET_LABEL_PROFILE.widthMm,
      heightMm: PALLET_LABEL_PROFILE.heightMm,
      dpi: PALLET_LABEL_PROFILE.dpi,
      widthDots: PALLET_LABEL_PROFILE.widthDots,
      heightDots: PALLET_LABEL_PROFILE.heightDots,
      bitmapBase64,
      copies: PALLET_LABEL_PROFILE.copies,
    };

    const { result, events } = await handleCommand(
      { id: 'c2', kind: 'print', payload },
      devices({ print }),
    );

    expect(print).toHaveBeenCalledTimes(1);
    const forwarded = print.mock.calls[0][0] as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty('printerId');
    expect(result).toEqual({ ok: true, jobId: 'pallet-job-1', status: 'printed' });
    expect(JSON.stringify(result)).not.toContain(bitmapBase64);
    expect(events).toEqual([]);
  });

  it('rejects a pallet request for more than one copy before hardware access', async () => {
    const print = jest
      .fn()
      .mockResolvedValue({ ok: true, jobId: 'must-not-run', status: 'printed' });
    const { result } = await handleCommand(
      {
        id: 'c2',
        kind: 'print',
        payload: {
          printerId: 'dev-printer-1',
          kind: 'pallet_label',
          documentId: 'document-1',
          templateVersion: PALLET_LABEL_PROFILE.templateVersion,
          widthMm: PALLET_LABEL_PROFILE.widthMm,
          heightMm: PALLET_LABEL_PROFILE.heightMm,
          dpi: PALLET_LABEL_PROFILE.dpi,
          widthDots: PALLET_LABEL_PROFILE.widthDots,
          heightDots: PALLET_LABEL_PROFILE.heightDots,
          bitmapBase64: Buffer.alloc(PALLET_LABEL_PROFILE.bitmapBytes).toString('base64'),
          copies: 2,
        },
      },
      devices({ print }),
    );

    expect(result).toMatchObject({ ok: false, status: 'failed' });
    expect(print).not.toHaveBeenCalled();
  });
});

describe('handleCommand — admin device operations', () => {
  it('tests a local scale without returning a raw frame', async () => {
    const { result, events } = await handleCommand(
      {
        id: 'c-test',
        kind: 'device_test',
        payload: { deviceId: 'dev-scale-1', kind: 'scale' },
      },
      devices(),
    );
    expect(result).toMatchObject({ ok: true, deviceId: 'dev-scale-1', status: 'ready' });
    expect(result).toMatchObject({ evidenceKind: 'simulated', physicalPass: false });
    expect(events).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('ST,GS');
  });

  it('physically probes a bound scale and returns no raw frame', async () => {
    const scaleProbe = jest.fn().mockResolvedValue({
      ok: true,
      status: 'ready',
      protocol: 'massa-k-protocol-100',
      simulated: false,
      identity: {
        ...SAFE_PHYSICAL_IDENTITY,
        raw: 'f855ce-secret-frame',
        serialPath: '/dev/serial/by-id/private',
        token: 'platform-secret',
      },
      parameters: SAFE_PROBE_PARAMETERS,
      raw: 'f855ce-secret-frame',
    });
    const scaleRead = jest.fn().mockResolvedValue({
      status: 'ready',
      stable: true,
      grossKg: 5,
      divisionKg: 0.01,
      raw: 'private-frame',
    });
    const { result, events } = await handleCommand(
      {
        id: 'c-test',
        kind: 'device_test',
        payload: { deviceId: 'dev-scale-1', kind: 'scale' },
      },
      devices({ scaleProbe, scaleRead }),
    );
    expect(scaleProbe).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      status: 'ready',
      protocol: 'massa-k-protocol-100',
      simulated: false,
      evidenceKind: 'physical',
      physicalPass: true,
      stable: true,
      parameters: SAFE_PROBE_PARAMETERS,
    });
    expect(scaleRead).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('raw');
    expect(JSON.stringify(result)).not.toContain('f855ce-secret-frame');
    expect(events).toEqual([]);
  });

  it.each([
    ['missing', undefined],
    ['empty', {}],
    ['partial', { maximum: SAFE_PROBE_PARAMETERS.maximum }],
  ])('keeps Protocol 100 physical PASS false for %s parameters', async (_case, parameters) => {
    const { result } = await handleCommand(
      {
        id: 'c-test-parameters',
        kind: 'device_test',
        payload: { deviceId: 'dev-scale-1', kind: 'scale' },
      },
      devices({
        scaleProbe: async () => ({
          ok: true,
          status: 'ready',
          protocol: 'massa-k-protocol-100',
          simulated: false,
          identity: SAFE_PHYSICAL_IDENTITY,
          parameters,
        }),
        scaleRead: async () => ({
          status: 'ready',
          stable: true,
          grossKg: 5,
          divisionKg: 0.01,
        }),
      }),
    );

    expect(result).toMatchObject({ evidenceKind: 'physical', physicalPass: false });
  });

  it('prints a dedicated setup label but keeps printer physical evidence pending', async () => {
    const print = jest.fn().mockResolvedValue({
      ok: false,
      status: 'delivery_unknown',
      error: 'submitted without paper acknowledgement',
    });

    const { result } = await handleCommand(
      {
        id: 'c-printer-test',
        kind: 'device_test',
        payload: { deviceId: 'dev-printer-1', kind: 'printer' },
      },
      devices({ print, printerMode: 'tcp9100' }),
    );

    expect(print).toHaveBeenCalledWith({
      kind: 'roll_label',
      rollCode: 'PLENKA-SETUP-TEST',
      qrCode: `prt_${'0'.repeat(64)}`,
    });
    expect(result).toMatchObject({
      ok: true,
      status: 'ready',
      evidenceKind: 'physical_pending',
      physicalPass: false,
      confirmationRequired: true,
    });
  });

  it('does not pass a printer setup test when CUPS rejects the job before submission', async () => {
    const print = jest.fn().mockResolvedValue({
      ok: false,
      status: 'failed',
      error: 'lp executable is unavailable',
    });

    const { result } = await handleCommand(
      {
        id: 'c-printer-test-failed',
        kind: 'device_test',
        payload: { deviceId: 'dev-printer-1', kind: 'printer' },
      },
      devices({ print, printerMode: 'tcp9100' }),
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'offline',
      evidenceKind: 'physical_pending',
      physicalPass: false,
      confirmationRequired: true,
    });
  });

  it('reports scanner receiver presence as pending evidence that still needs a browser scan', async () => {
    const { result } = await handleCommand(
      {
        id: 'c-scanner-test',
        kind: 'device_test',
        payload: { deviceId: 'dev-scanner-1', kind: 'scanner' },
      },
      devices(),
    );

    expect(result).toMatchObject({
      ok: true,
      deviceId: 'dev-scanner-1',
      status: 'ready',
      evidenceKind: 'physical_pending',
      physicalPass: false,
      confirmationRequired: true,
      message: expect.stringMatching(/HID receiver.*browser scan.*Enter/iu),
    });
    expect(String(result.message)).not.toContain('responded');
  });

  it('sanitizes an unsafe failed-probe diagnostic returned by the scale', async () => {
    const scaleProbe = jest.fn().mockResolvedValue({
      ok: false,
      status: 'offline',
      protocol: 'massa-k-protocol-100',
      simulated: false,
      error: 'open /dev/serial/by-id/private: token=platform-secret f855ce-secret-frame',
    });

    const { result, events } = await handleCommand(
      {
        id: 'c-test',
        kind: 'device_test',
        payload: { deviceId: 'dev-scale-1', kind: 'scale' },
      },
      devices({ scaleProbe }),
    );

    expect(result).toMatchObject({ ok: false, status: 'offline', error: 'device_probe_failed' });
    expect(JSON.stringify(result)).not.toContain('/dev/serial');
    expect(JSON.stringify(result)).not.toContain('platform-secret');
    expect(JSON.stringify(result)).not.toContain('f855ce-secret-frame');
    expect(events).toEqual([]);
  });

  it.each([
    [
      'protocol',
      'invalid_probe_metadata',
      {
        ok: true,
        status: 'ready',
        protocol: UNSAFE_PROBE_VALUE,
        simulated: false,
        identity: SAFE_PHYSICAL_IDENTITY,
      },
    ],
    [
      'identity name',
      'invalid_probe_identity',
      {
        ok: true,
        status: 'ready',
        protocol: 'massa-k-protocol-100',
        simulated: false,
        identity: { ...SAFE_PHYSICAL_IDENTITY, name: UNSAFE_PROBE_VALUE },
      },
    ],
    [
      'allowed parameter',
      'invalid_probe_parameters',
      {
        ok: true,
        status: 'ready',
        protocol: 'massa-k-protocol-100',
        simulated: false,
        identity: SAFE_PHYSICAL_IDENTITY,
        parameters: { ...SAFE_PROBE_PARAMETERS, maximum: UNSAFE_PROBE_VALUE },
      },
    ],
  ])('returns a safe non-success result for malicious %s content', async (_field, error, probe) => {
    const scaleProbe = jest.fn().mockResolvedValue(probe);

    const { result, events } = await handleCommand(
      {
        id: 'c-test',
        kind: 'device_test',
        payload: { deviceId: 'dev-scale-1', kind: 'scale' },
      },
      devices({ scaleProbe }),
    );

    expect(scaleProbe).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, status: 'offline', error });
    expect(JSON.stringify(result)).not.toContain('f855ce0123456789');
    expect(JSON.stringify(result)).not.toContain('/dev/serial');
    expect(JSON.stringify(result)).not.toContain('platform-secret');
    expect(events).toEqual([]);
  });

  it('rejects a device that is not local to this agent', async () => {
    const scaleProbe = jest.fn().mockResolvedValue({
      ok: true,
      status: 'ready',
      protocol: 'massa-k-protocol-100',
      simulated: false,
    });
    const { result } = await handleCommand(
      {
        id: 'c-test',
        kind: 'device_test',
        payload: { deviceId: 'other-post-scale', kind: 'scale' },
      },
      devices({ scaleProbe }),
    );
    expect(result).toMatchObject({ ok: false, status: 'misconfigured' });
    expect(scaleProbe).not.toHaveBeenCalled();
  });

  it('does not leak a local serial path when the physical probe throws', async () => {
    const scaleProbe = jest
      .fn()
      .mockRejectedValue(
        new Error('open /dev/serial/by-id/private: token=platform-secret f855ce-secret-frame'),
      );
    const { result, events } = await handleCommand(
      {
        id: 'c-test',
        kind: 'device_test',
        payload: { deviceId: 'dev-scale-1', kind: 'scale' },
      },
      devices({ scaleProbe }),
    );

    expect(scaleProbe).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: false,
      deviceId: 'dev-scale-1',
      status: 'offline',
      error: 'scale probe failed',
    });
    expect(JSON.stringify(result)).not.toContain('/dev/serial');
    expect(JSON.stringify(result)).not.toContain('platform-secret');
    expect(JSON.stringify(result)).not.toContain('f855ce-secret-frame');
    expect(events).toEqual([]);
  });

  it('reports recovery as verified only when the local device is currently ready', async () => {
    const { result } = await handleCommand(
      {
        id: 'c-recover',
        kind: 'device_recover',
        payload: { deviceId: 'dev-printer-1', kind: 'printer' },
      },
      devices(),
    );
    expect(result).toMatchObject({ ok: true, deviceId: 'dev-printer-1', status: 'recovering' });
  });
});

describe('handleCommand — unknown kind', () => {
  it('answers ok:false without crashing the agent', async () => {
    const { result } = await handleCommand({ id: 'c3', kind: 'reboot' }, devices());
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('unknown command');
  });
});
