import { decodePollCommand, parseScaleFrame } from './scale-frame';

describe('parseScaleFrame — typical ASCII scale frames', () => {
  it.each([
    ['ST,GS,+  43.40kg', 43.4, true],
    ['ST,GS,+00043.40 kg', 43.4, true],
    ['st,gs,2.00kg', 2.0, true],
    ['ST,NT,   2.00 kg', 2.0, true],
    ['ST,GS,+ 1250 g', 1.25, true],
    ['US,GS,+  43.52kg', 43.52, false],
    ['US,NT,0.00kg', 0, false],
  ])('parses marked frame %s → %skg stable=%s', (raw, kg, stable) => {
    const r = parseScaleFrame(raw);
    expect(r).toEqual({ ok: true, frame: { weightKg: kg, stable } });
  });

  it.each([
    ['43.40 kg', 43.4],
    ['+43,40', 43.4],
    ['2.00', 2.0],
    ['1250 г', 1.25],
  ])('parses bare frame %s with UNKNOWN stability (stable: null)', (raw, kg) => {
    const r = parseScaleFrame(raw);
    expect(r).toEqual({ ok: true, frame: { weightKg: kg, stable: null } });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['READY', 'unknown'],
    ['OL,GS,+9999.99kg', 'overload'],
    ['ST,GS,ERR', 'unknown'],
    ['-1.5 kg', 'negative'],
    ['ST,GS,-0.20kg', 'negative'],
  ])('rejects %s (never fakes a ready reading)', (raw) => {
    const r = parseScaleFrame(raw);
    expect(r.ok).toBe(false);
  });
});

describe('decodePollCommand', () => {
  it('decodes hex form', () => {
    expect(decodePollCommand('hex:0D0A')).toEqual(Buffer.from([0x0d, 0x0a]));
    expect(decodePollCommand('hex:05')).toEqual(Buffer.from([0x05]));
  });

  it('decodes literal text with escapes', () => {
    expect(decodePollCommand('P\\r\\n')).toEqual(Buffer.from('P\r\n', 'ascii'));
  });
});
