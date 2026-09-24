import { Protocol100FrameError } from './protocol-100-frame';
import { Protocol100StreamDecoder } from './protocol-100-stream';

const MASS = Buffer.from('f855ce090024f410000002010000df40', 'hex');
const NAME = Buffer.from('f855ce0b00213930000054562d4d0d0a080e', 'hex');

describe('Protocol100StreamDecoder', () => {
  it('keeps a split header/body and discards leading noise', () => {
    const decoder = new Protocol100StreamDecoder();
    expect(decoder.push(Buffer.from([0x00, 0xff, 0xf8]))).toEqual([]);
    expect(decoder.push(Buffer.from([0x55]))).toEqual([]);
    const events = decoder.push(MASS.subarray(2));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ok: true, frame: { body: MASS.subarray(5, 14) } });
  });

  it('returns two concatenated frames', () => {
    const events = new Protocol100StreamDecoder().push(Buffer.concat([MASS, NAME]));
    expect(events.filter((event) => event.ok)).toHaveLength(2);
  });

  it('reports a bad CRC and resynchronizes to the following valid frame', () => {
    const corrupt = Buffer.from(MASS);
    corrupt[corrupt.length - 1] ^= 0xff;
    const events = new Protocol100StreamDecoder().push(Buffer.concat([corrupt, NAME]));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ ok: false, error: { reason: 'crc' } });
    expect(events[1]).toMatchObject({ ok: true, frame: { body: NAME.subarray(5, 16) } });
  });

  it('recovers a following frame overlapped by an inflated in-range length', () => {
    const corrupt = Buffer.from(MASS);
    corrupt.writeUInt16LE(11, 3);

    const events = new Protocol100StreamDecoder().push(Buffer.concat([corrupt, NAME]));

    expect(events).toHaveLength(2);
    const [failure, recovered] = events;
    expect(failure?.ok).toBe(false);
    if (!failure || failure.ok) throw new Error('expected a frame error');
    expect(failure.error).toBeInstanceOf(Protocol100FrameError);
    expect(failure.error.reason).toBe('crc');
    expect(recovered).toMatchObject({ ok: true, frame: { body: NAME.subarray(5, 16) } });
  });

  it('recovers a valid frame hidden behind an incomplete inflated length', () => {
    const corrupt = Buffer.from(MASS);
    corrupt.writeUInt16LE(90, 3);

    const events = new Protocol100StreamDecoder().push(Buffer.concat([corrupt, NAME]));

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ ok: false, error: { reason: 'length' }, raw: corrupt });
    expect(events[1]).toMatchObject({ ok: true, frame: { body: NAME.subarray(5, 16) } });
  });

  it('does not resynchronize to an invalid header inside an incomplete body', () => {
    const corrupt = Buffer.from(MASS);
    corrupt.writeUInt16LE(90, 3);
    const invalidNestedFrame = Buffer.from(NAME);
    invalidNestedFrame[invalidNestedFrame.length - 1] ^= 0xff;
    const decoder = new Protocol100StreamDecoder();
    const incomplete = Buffer.concat([corrupt, invalidNestedFrame]);

    expect(decoder.push(incomplete)).toEqual([]);
    expect(decoder.bufferedBytes()).toBe(incomplete.length);

    const events = decoder.push(NAME);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ ok: false, error: { reason: 'length' }, raw: incomplete });
    expect(events[1]).toMatchObject({ ok: true, frame: { body: NAME.subarray(5, 16) } });
  });

  it('never grows beyond its explicit buffer limit under noise', () => {
    const decoder = new Protocol100StreamDecoder(64);
    expect(decoder.push(Buffer.alloc(1_000, 0x01))).toEqual([]);
    expect(decoder.bufferedBytes()).toBeLessThanOrEqual(2);
  });
});
