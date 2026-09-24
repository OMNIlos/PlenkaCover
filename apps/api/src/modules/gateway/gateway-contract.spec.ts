import {
  GATEWAY_CAPABILITIES,
  GATEWAY_PROTOCOL_VERSION,
  gatewayCapabilityForPrinterPayload,
  isGatewayCapability,
  isGatewayCommandEnvelopeV2,
  isGatewayHeartbeatV2,
  type GatewayHeartbeatV2,
} from '@plenka/contracts';

const heartbeat = (overrides: Partial<GatewayHeartbeatV2> = {}): GatewayHeartbeatV2 => ({
  protocolVersion: GATEWAY_PROTOCOL_VERSION,
  agent: {
    packageVersion: '1:0.0.1+git788.1785844317.1b5005b4660f',
    releaseCommit: '1b5005b4660f5997c956b718958e5ee3a3516d94',
    bootId: '7f620c8e-2bbf-4ef8-9e91-b094611229c7',
    startedAt: '2026-08-04T12:45:00.000Z',
    capabilities: [...GATEWAY_CAPABILITIES],
  },
  devices: [
    {
      deviceId: 'SCALE-1',
      kind: 'scale',
      status: 'ready',
      driver: 'massa-k-protocol-100',
      driverVersion: '1',
      configFingerprint: 'a'.repeat(64),
      lastProbeAt: '2026-08-04T12:46:00.000Z',
    },
  ],
  ...overrides,
});

const palletLabelCommand = (templateVersion: string) => ({
  protocolVersion: GATEWAY_PROTOCOL_VERSION,
  kind: 'label.print.v1',
  payload: {
    printerId: 'PRINTER-1',
    label: {
      schemaVersion: 1,
      kind: 'pallet_label',
      documentId: 'PALLET-DOCUMENT-1',
      templateVersion,
      widthMm: 100,
      heightMm: 150,
      dpi: 203,
      widthDots: 800,
      heightDots: 1200,
      bitmapBase64: Buffer.alloc(120_000, 0xa5).toString('base64'),
      copies: 1,
    },
  },
});

describe('gateway V2 contracts', () => {
  it('accepts a complete bounded V2 heartbeat', () => {
    expect(isGatewayHeartbeatV2(heartbeat())).toBe(true);
  });

  it('rejects legacy, unknown and oversized agent metadata', () => {
    expect(isGatewayHeartbeatV2({ devices: [] })).toBe(false);
    expect(
      isGatewayHeartbeatV2(
        heartbeat({
          agent: {
            ...heartbeat().agent,
            capabilities: ['printer.future-label.v9'] as never,
          },
        }),
      ),
    ).toBe(false);
    expect(
      isGatewayHeartbeatV2(
        heartbeat({
          agent: {
            ...heartbeat().agent,
            packageVersion: 'v'.repeat(129),
          },
        }),
      ),
    ).toBe(false);
  });

  it('keeps the capability vocabulary closed', () => {
    expect(isGatewayCapability('printer.big-bag-label.v1')).toBe(true);
    expect(isGatewayCapability('printer.future-label.v9')).toBe(false);
  });

  it.each([
    ['roll_label', 'printer.roll-label.v1'],
    ['big_bag_label', 'printer.big-bag-label.v1'],
    ['pallet_label', 'printer.pallet-label.v1'],
  ] as const)('maps %s to its exact capability', (kind, expected) => {
    expect(gatewayCapabilityForPrinterPayload(kind)).toBe(expected);
  });

  it.each([
    {
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      kind: 'scale.read.v1',
      payload: { deviceId: 'SCALE-1', sample: 'roll' },
    },
    {
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      kind: 'label.print.v1',
      payload: {
        printerId: 'PRINTER-1',
        label: {
          schemaVersion: 1,
          kind: 'roll_label',
          rollCode: 'ROLL-1',
          qrCode: `prt_${'a'.repeat(64)}`,
        },
      },
    },
    {
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      kind: 'device.test.v1',
      payload: { deviceId: 'SCANNER-1', kind: 'scanner' },
    },
  ])('accepts a bounded V2 command envelope', (command) => {
    expect(isGatewayCommandEnvelopeV2(command)).toBe(true);
  });

  it('keeps the byte-exact v1 pallet label payload accepted under schema version 1', () => {
    const command = palletLabelCommand('pallet-100x150-v1');

    expect(isGatewayCommandEnvelopeV2(command)).toBe(true);
    expect(command.payload.label).toEqual({
      schemaVersion: 1,
      kind: 'pallet_label',
      documentId: 'PALLET-DOCUMENT-1',
      templateVersion: 'pallet-100x150-v1',
      widthMm: 100,
      heightMm: 150,
      dpi: 203,
      widthDots: 800,
      heightDots: 1200,
      bitmapBase64: Buffer.alloc(120_000, 0xa5).toString('base64'),
      copies: 1,
    });
  });

  it('uses schema v2 with an explicit destination for every Big-Bag label', () => {
    const label = {
      kind: 'big_bag_label',
      destination: 'operator',
      bigBagCode: 'DEFECT-BAG-1',
      material: 'Бракованная плёнка',
      qrCode: `bbt_${'b'.repeat(64)}`,
    };
    const command = (schemaVersion: number, destination?: string) => ({
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      kind: 'label.print.v1',
      payload: {
        printerId: 'PRINTER-1',
        label: { ...label, destination, schemaVersion },
      },
    });

    expect(isGatewayCommandEnvelopeV2(command(2, 'operator'))).toBe(true);
    expect(isGatewayCommandEnvelopeV2(command(2, 'warehouse'))).toBe(true);
    expect(isGatewayCommandEnvelopeV2(command(2, undefined))).toBe(false);
    expect(isGatewayCommandEnvelopeV2(command(1, 'operator'))).toBe(false);
    expect(isGatewayCommandEnvelopeV2(command(1, 'warehouse'))).toBe(false);
    expect(isGatewayCommandEnvelopeV2(command(1, undefined))).toBe(false);
  });

  it('accepts compact v2 as an additive pallet profile under the same schema', () => {
    expect(isGatewayCommandEnvelopeV2(palletLabelCommand('pallet-100x150-compact-v2'))).toBe(true);
  });

  it('rejects browser-only square v4 at the unchanged physical transport boundary', () => {
    const command = palletLabelCommand('pallet-100x100-square-v4');

    expect(isGatewayCommandEnvelopeV2(command)).toBe(false);
  });

  it('rejects browser-only safe v5 at the unchanged physical transport boundary', () => {
    const command = palletLabelCommand('pallet-100x100-safe-v5');

    expect(isGatewayCommandEnvelopeV2(command)).toBe(false);
  });

  it('rejects browser-only extended v6 at the unchanged physical transport boundary', () => {
    const command = palletLabelCommand('pallet-100x100-extended-v6');

    expect(isGatewayCommandEnvelopeV2(command)).toBe(false);
  });

  it('rejects an unknown pallet label profile', () => {
    expect(isGatewayCommandEnvelopeV2(palletLabelCommand('pallet-100x150-future-v4'))).toBe(false);
  });

  it.each([
    {
      protocolVersion: 3,
      kind: 'scale.read.v1',
      payload: { deviceId: 'SCALE-1', sample: 'roll' },
    },
    {
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      kind: 'label.print.v1',
      payload: {
        printerId: 'PRINTER-1',
        label: {
          schemaVersion: 2,
          kind: 'roll_label',
          rollCode: 'ROLL-1',
          qrCode: `prt_${'a'.repeat(64)}`,
        },
      },
    },
    {
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      kind: 'device.test.v1',
      payload: { deviceId: 'SCANNER-1', kind: 'future-device' },
    },
  ])('rejects an unsupported or malformed V2 command envelope', (command) => {
    expect(isGatewayCommandEnvelopeV2(command)).toBe(false);
  });
});
