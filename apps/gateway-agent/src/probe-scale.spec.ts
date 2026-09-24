import type { ScaleDevice } from './devices/scale';
import { log } from './logger';
import { probeScale, runProbeScale } from './probe-scale';

const UNSAFE_VALUE = 'f855ce0123456789 at /dev/serial/by-id/private token=platform-secret';
const DOCUMENTED_PARAMETERS = {
  maximum: 'Max 6/15 кг',
  minimum: 'Min 0,04 кг',
  verificationInterval: 'e = 2/5 г',
  maximumTare: 'T = - 6 кг',
  fixation: 'Fix = 0',
  calibrationCode: 'Code = 012345',
  softwareVersion: 'V3',
  softwareChecksum: 'F855CE01',
};
const PHYSICAL_IDENTITY = {
  manufacturer: 'MASSA-K',
  scaleId: -12345,
  name: 'Line A / 01',
};

function untrustedProbe(value: Record<string, unknown>): ScaleDevice['probe'] {
  return async () => value as unknown as Awaited<ReturnType<ScaleDevice['probe']>>;
}

function physicalScale(overrides: Partial<ScaleDevice> = {}): ScaleDevice {
  return {
    probe: async () => ({
      ok: true,
      status: 'ready',
      protocol: 'massa-k-protocol-100',
      simulated: false,
      identity: PHYSICAL_IDENTITY,
      parameters: DOCUMENTED_PARAMETERS,
    }),
    read: async () => ({
      status: 'ready',
      stable: true,
      grossKg: 43.4,
      divisionKg: 0.01,
      raw: 'f855ce-secret-frame',
    }),
    status: () => 'ready',
    close: async () => {},
    ...overrides,
  };
}

describe('probeScale', () => {
  it('returns physical identity and normalized reading without raw bytes', async () => {
    const scale: ScaleDevice = {
      probe: async () => ({
        ok: true,
        status: 'ready',
        protocol: 'massa-k-protocol-100',
        simulated: false,
        identity: PHYSICAL_IDENTITY,
        parameters: DOCUMENTED_PARAMETERS,
      }),
      read: async () => ({
        status: 'ready',
        stable: true,
        grossKg: 43.4,
        divisionKg: 0.01,
        raw: 'f855ce-secret-frame',
      }),
      status: () => 'ready',
      close: async () => {},
    };
    const output = await probeScale(scale);
    expect(output).toMatchObject({
      probe: { ok: true, simulated: false },
      reading: { status: 'ready', stable: true, grossKg: 43.4, divisionKg: 0.01 },
    });
    expect(JSON.stringify(output)).not.toContain('f855ce-secret-frame');
  });

  it('projects probe diagnostics without extra raw, credential, or serial-path fields', async () => {
    const scale = physicalScale({
      probe: async () => ({
        ok: false,
        status: 'offline',
        protocol: 'massa-k-protocol-100',
        simulated: false,
        error: 'open /dev/serial/by-id/private: token=platform-secret',
        raw: 'f855ce-secret-frame',
        serialPath: '/dev/serial/by-id/private',
        token: 'platform-secret',
      }),
    });

    const serialized = JSON.stringify(await probeScale(scale));

    expect(serialized).toContain('device_probe_failed');
    expect(serialized).not.toContain('f855ce-secret-frame');
    expect(serialized).not.toContain('/dev/serial');
    expect(serialized).not.toContain('platform-secret');
  });

  it('categorizes an unsafe reading error without returning its raw diagnostic text', async () => {
    const scale = physicalScale({
      read: async () => ({
        status: 'unstable',
        stable: false,
        grossKg: 0,
        errorCode: 'f855ce-secret-frame at /dev/serial/by-id/private token=platform-secret',
      }),
    });

    const serialized = JSON.stringify(await probeScale(scale));

    expect(serialized).toContain('device_read_failed');
    expect(serialized).not.toContain('f855ce-secret-frame');
    expect(serialized).not.toContain('/dev/serial');
    expect(serialized).not.toContain('platform-secret');
  });

  it.each([
    ['manufacturer', { manufacturer: 'OTHER', scaleId: -12345, name: 'Line A / 01' }],
    ['name with path', { manufacturer: 'MASSA-K', scaleId: -12345, name: '/dev/ttyUSB0' }],
    ['credential name', { manufacturer: 'MASSA-K', scaleId: -12345, name: 'token=secret' }],
    ['control byte', { manufacturer: 'MASSA-K', scaleId: -12345, name: 'Line\tA' }],
    ['C1 control byte', { manufacturer: 'MASSA-K', scaleId: -12345, name: 'Line\u0080A' }],
    ['name above wire bound', { manufacturer: 'MASSA-K', scaleId: -12345, name: 'A'.repeat(26) }],
    ['non-string name', { manufacturer: 'MASSA-K', scaleId: -12345, name: 12345 }],
    [
      'scale ID above signed int32',
      { manufacturer: 'MASSA-K', scaleId: 2_147_483_648, name: 'Line A / 01' },
    ],
    [
      'scale ID below signed int32',
      { manufacturer: 'MASSA-K', scaleId: -2_147_483_649, name: 'Line A / 01' },
    ],
  ])('rejects a malformed physical identity: %s', async (_condition, identity) => {
    const output = await probeScale(
      physicalScale({
        probe: untrustedProbe({
          ok: true,
          status: 'ready',
          protocol: 'massa-k-protocol-100',
          simulated: false,
          identity,
        }),
      }),
    );

    expect(output.probe).toMatchObject({
      ok: false,
      status: 'offline',
      error: 'invalid_probe_identity',
    });
    expect(output.probe.identity).toBeUndefined();
    expect(output.reading).toBeUndefined();
  });

  it.each([
    ['custom non-model name', { ...PHYSICAL_IDENTITY, name: 'Operator post #1' }],
    ['raw-like semantic name', { ...PHYSICAL_IDENTITY, name: 'f855ce0123456789' }],
    ['empty bounded wire name', { ...PHYSICAL_IDENTITY, name: '' }],
    ['printable redacted text', { ...PHYSICAL_IDENTITY, name: '[redacted]' }],
    ['minimum signed ScalesID', { ...PHYSICAL_IDENTITY, scaleId: -2_147_483_648 }],
  ])('accepts a safe official identity with %s', async (_case, identity) => {
    const output = await probeScale(
      physicalScale({
        probe: untrustedProbe({
          ok: true,
          status: 'ready',
          protocol: 'massa-k-protocol-100',
          simulated: false,
          identity,
        }),
      }),
    );

    expect(output.probe).toMatchObject({ ok: true, identity });
    expect(output.reading).toMatchObject({ status: 'ready', stable: true });
  });

  it.each([
    ['maximum', 'Max\u00806'],
    ['fixation', 'AUTO\nsecret'],
    ['calibrationCode', '/dev/serial/by-id/private'],
    ['softwareVersion', 'token=platform-secret'],
  ])('rejects unsafe content in the %s parameter', async (key, value) => {
    const output = await probeScale(
      physicalScale({
        probe: untrustedProbe({
          ok: true,
          status: 'ready',
          protocol: 'massa-k-protocol-100',
          simulated: false,
          identity: PHYSICAL_IDENTITY,
          parameters: { ...DOCUMENTED_PARAMETERS, [key]: value },
        }),
      }),
    );

    expect(output.probe).toMatchObject({
      ok: false,
      status: 'offline',
      error: 'invalid_probe_parameters',
    });
    expect(output.reading).toBeUndefined();
    expect(JSON.stringify(output)).not.toContain(value);
  });

  it.each([
    ['line separator in identity', 'Line\u2028separator-marker', undefined],
    ['paragraph separator in identity', 'Line\u2029paragraph-marker', undefined],
    ['bidi control in identity', 'Line\u202Ebidi-marker', undefined],
    ['unpaired surrogate in identity', 'Line\ud800surrogate-marker', undefined],
    ['line separator in parameter', PHYSICAL_IDENTITY.name, 'Max\u2028parameter-marker'],
    ['bidi control in parameter', PHYSICAL_IDENTITY.name, 'Max\u202Ebidi-marker'],
  ])('rejects unsafe Unicode: %s', async (_case, identityName, maximum) => {
    const lines: string[] = [];
    const probe = untrustedProbe({
      ok: true,
      status: 'ready',
      protocol: 'massa-k-protocol-100',
      simulated: false,
      identity: { ...PHYSICAL_IDENTITY, name: identityName },
      parameters:
        maximum === undefined ? DOCUMENTED_PARAMETERS : { ...DOCUMENTED_PARAMETERS, maximum },
    });

    const code = await runProbeScale(physicalScale({ probe }), (line) => lines.push(line));

    expect(code).toBe(2);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).probe).toMatchObject({ ok: false, status: 'offline' });
    expect(lines[0]).not.toContain('separator-marker');
    expect(lines[0]).not.toContain('paragraph-marker');
    expect(lines[0]).not.toContain('bidi-marker');
    expect(lines[0]).not.toContain('surrogate-marker');
    expect(lines[0]).not.toContain('parameter-marker');
  });

  it.each([
    ['maximum', 'A'.repeat(21)],
    ['minimum', 'A'],
    ['verificationInterval', 'A'.repeat(11)],
    ['maximumTare', 'A'],
    ['fixation', 'A'.repeat(8)],
    ['calibrationCode', 'A'.repeat(14)],
    ['softwareVersion', 'A'],
    ['softwareChecksum', 'A'.repeat(9)],
  ])('rejects an out-of-bounds %s parameter', async (key, value) => {
    const output = await probeScale(
      physicalScale({
        probe: untrustedProbe({
          ok: true,
          status: 'ready',
          protocol: 'massa-k-protocol-100',
          simulated: false,
          identity: PHYSICAL_IDENTITY,
          parameters: { ...DOCUMENTED_PARAMETERS, [key]: value },
        }),
      }),
    );

    expect(output.probe).toMatchObject({
      ok: false,
      status: 'offline',
      error: 'invalid_probe_parameters',
    });
    expect(output.reading).toBeUndefined();
  });
});

describe('runProbeScale', () => {
  it('keeps device-log suppression scoped across overlapping probes', async () => {
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const firstStarted = deferred();
    const secondStarted = deferred();
    const finishFirst = deferred();
    const finishSecond = deferred();
    const firstLines: string[] = [];
    const secondLines: string[] = [];
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const firstScale = physicalScale({
      probe: async () => {
        firstStarted.resolve();
        await finishFirst.promise;
        return physicalScale().probe();
      },
    });
    const secondScale = physicalScale({
      probe: async () => {
        secondStarted.resolve();
        await finishSecond.promise;
        log.warn('unsafe overlapping device log', {
          raw: 'f855ce-secret-frame',
          serialPath: '/dev/serial/by-id/private',
          token: 'platform-secret',
        });
        return physicalScale().probe();
      },
    });

    try {
      const firstRun = runProbeScale(firstScale, (line) => firstLines.push(line));
      await firstStarted.promise;
      const secondRun = runProbeScale(secondScale, (line) => secondLines.push(line));
      await secondStarted.promise;

      log.info('external log while both probes run', { marker: 'outside-both' });
      finishFirst.resolve();
      await firstRun;
      log.info('external log while second probe runs', { marker: 'outside-second' });
      finishSecond.resolve();
      await secondRun;
      log.info('external log after probes finish', { marker: 'outside-after' });

      const stdoutText = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(stdoutText).toContain('outside-both');
      expect(stdoutText).toContain('outside-second');
      expect(stdoutText).toContain('outside-after');
      expect(stdoutText).not.toContain('f855ce-secret-frame');
      expect(stdoutText).not.toContain('/dev/serial');
      expect(stdoutText).not.toContain('platform-secret');
      expect(firstLines).toHaveLength(1);
      expect(secondLines).toHaveLength(1);
    } finally {
      finishFirst.resolve();
      finishSecond.resolve();
      stdout.mockRestore();
    }
  });

  it('exits zero only for an authoritative physical Protocol 100 reading and closes the scale', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const lines: string[] = [];

    const code = await runProbeScale(physicalScale({ close }), (line) => lines.push(line));

    expect(code).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      probe: { ok: true, protocol: 'massa-k-protocol-100', simulated: false },
      reading: { status: 'ready', stable: true, grossKg: 43.4, divisionKg: 0.01 },
    });
  });

  it('preserves the documented MASSA-K identity and parameter example', async () => {
    const lines: string[] = [];
    const scale = physicalScale({
      probe: untrustedProbe({
        ok: true,
        status: 'ready',
        protocol: 'massa-k-protocol-100',
        simulated: false,
        identity: PHYSICAL_IDENTITY,
        parameters: DOCUMENTED_PARAMETERS,
      }),
    });

    const code = await runProbeScale(scale, (line) => lines.push(line));

    expect(code).toBe(0);
    expect(JSON.parse(lines[0])).toMatchObject({
      probe: {
        identity: PHYSICAL_IDENTITY,
        parameters: DOCUMENTED_PARAMETERS,
      },
    });
  });

  it('accepts documented printable Cyrillic identity and units', async () => {
    const lines: string[] = [];
    const identity = { ...PHYSICAL_IDENTITY, name: 'Весы МК-15.2' };
    const scale = physicalScale({
      probe: untrustedProbe({
        ok: true,
        status: 'ready',
        protocol: 'massa-k-protocol-100',
        simulated: false,
        identity,
        parameters: DOCUMENTED_PARAMETERS,
      }),
    });

    const code = await runProbeScale(scale, (line) => lines.push(line));

    expect(code).toBe(0);
    expect(JSON.parse(lines[0]).probe).toMatchObject({
      identity,
      parameters: DOCUMENTED_PARAMETERS,
    });
  });

  it('accepts bounded raw-like hexadecimal values as semantic fields', async () => {
    const lines: string[] = [];
    const rawLikeMaximum = 'f855ce0123456789';
    const checksum = 'F855CE01';
    const scale = physicalScale({
      probe: untrustedProbe({
        ok: true,
        status: 'ready',
        protocol: 'massa-k-protocol-100',
        simulated: false,
        identity: PHYSICAL_IDENTITY,
        parameters: {
          ...DOCUMENTED_PARAMETERS,
          maximum: rawLikeMaximum,
          softwareChecksum: checksum,
        },
      }),
    });

    const code = await runProbeScale(scale, (line) => lines.push(line));

    expect(code).toBe(0);
    expect(JSON.parse(lines[0]).probe.parameters.maximum).toBe(rawLikeMaximum);
    expect(JSON.parse(lines[0]).probe.parameters.softwareChecksum).toBe(checksum);
  });

  it.each([
    [
      'protocol',
      {
        ok: true,
        status: 'ready',
        protocol: UNSAFE_VALUE,
        simulated: false,
        identity: PHYSICAL_IDENTITY,
      },
    ],
    [
      'identity name',
      {
        ok: true,
        status: 'ready',
        protocol: 'massa-k-protocol-100',
        simulated: false,
        identity: { ...PHYSICAL_IDENTITY, name: UNSAFE_VALUE },
      },
    ],
    [
      'allowed parameter',
      {
        ok: true,
        status: 'ready',
        protocol: 'massa-k-protocol-100',
        simulated: false,
        identity: PHYSICAL_IDENTITY,
        parameters: { ...DOCUMENTED_PARAMETERS, maximum: UNSAFE_VALUE },
      },
    ],
  ])('emits one safe non-success JSON line for malicious %s content', async (_field, probe) => {
    const lines: string[] = [];
    const code = await runProbeScale(physicalScale({ probe: untrustedProbe(probe) }), (line) =>
      lines.push(line),
    );

    expect(code).toBe(2);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).probe.ok).toBe(false);
    expect(lines[0]).not.toContain('f855ce0123456789');
    expect(lines[0]).not.toContain('/dev/serial');
    expect(lines[0]).not.toContain('platform-secret');
  });

  it.each([
    [
      'a simulated reading',
      physicalScale({
        probe: async () => ({
          ok: true,
          status: 'ready',
          protocol: 'simulated',
          simulated: true,
        }),
      }),
    ],
    [
      'an offline probe',
      physicalScale({
        probe: async () => ({
          ok: false,
          status: 'offline',
          protocol: 'massa-k-protocol-100',
          simulated: false,
          error: 'transport_unavailable',
        }),
      }),
    ],
    [
      'a legacy ASCII reading',
      physicalScale({
        probe: async () => ({
          ok: true,
          status: 'ready',
          protocol: 'legacy-ascii',
          simulated: false,
        }),
      }),
    ],
    [
      'an unstable physical reading',
      physicalScale({
        read: async () => ({ status: 'unstable', stable: false, grossKg: 43.4, divisionKg: 0.01 }),
      }),
    ],
    [
      'a physical reading without a verified division',
      physicalScale({
        read: async () => ({ status: 'ready', stable: true, grossKg: 43.4 }),
      }),
    ],
    [
      'a physical probe without parameters',
      physicalScale({
        probe: untrustedProbe({
          ok: true,
          status: 'ready',
          protocol: 'massa-k-protocol-100',
          simulated: false,
          identity: PHYSICAL_IDENTITY,
        }),
      }),
    ],
    [
      'a physical probe with empty parameters',
      physicalScale({
        probe: untrustedProbe({
          ok: true,
          status: 'ready',
          protocol: 'massa-k-protocol-100',
          simulated: false,
          identity: PHYSICAL_IDENTITY,
          parameters: {},
        }),
      }),
    ],
    [
      'a physical probe with partial parameters',
      physicalScale({
        probe: untrustedProbe({
          ok: true,
          status: 'ready',
          protocol: 'massa-k-protocol-100',
          simulated: false,
          identity: PHYSICAL_IDENTITY,
          parameters: { maximum: DOCUMENTED_PARAMETERS.maximum },
        }),
      }),
    ],
  ])('exits two for %s', async (_condition, scale) => {
    const code = await runProbeScale(scale, () => {});

    expect(code).toBe(2);
  });

  it('closes after a probe exception and emits one generic JSON error without unsafe logs', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const lines: string[] = [];
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const scale = physicalScale({
      probe: async () => {
        log.warn('unsafe device log', {
          serialPath: '/dev/serial/by-id/private',
          token: 'platform-secret',
        });
        throw new Error('f855ce-secret-frame at /dev/serial/by-id/private token=platform-secret');
      },
      close,
    });

    try {
      const code = await runProbeScale(scale, (line) => lines.push(line));

      expect(code).toBe(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(stdout).not.toHaveBeenCalled();
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({
        probe: { ok: false, status: 'offline', error: 'scale_probe_failed' },
      });
      expect(lines[0]).not.toContain('f855ce-secret-frame');
      expect(lines[0]).not.toContain('/dev/serial');
      expect(lines[0]).not.toContain('platform-secret');
    } finally {
      stdout.mockRestore();
    }
  });

  it('turns a cleanup exception into a safe non-success result', async () => {
    const lines: string[] = [];
    const scale = physicalScale({
      close: async () => {
        throw new Error('close /dev/serial/by-id/private token=platform-secret');
      },
    });

    const code = await runProbeScale(scale, (line) => lines.push(line));

    expect(code).toBe(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      probe: { ok: false, status: 'offline', error: 'scale_cleanup_failed' },
    });
    expect(lines[0]).not.toContain('/dev/serial');
    expect(lines[0]).not.toContain('platform-secret');
  });
});
