import {
  PROTOCOL_100_HEADER,
  PROTOCOL_100_MAX_BODY_BYTES,
  Protocol100FrameError,
  decodeProtocol100Frame,
  type DecodedProtocol100Frame,
} from './protocol-100-frame';

export type Protocol100DecodeEvent =
  | { ok: true; frame: DecodedProtocol100Frame }
  | { ok: false; error: Protocol100FrameError; raw: Buffer };

export class Protocol100StreamDecoder {
  private buffer = Buffer.alloc(0);

  constructor(private readonly maxBufferedBytes = 4_096) {}

  bufferedBytes(): number {
    return this.buffer.length;
  }

  push(chunk: Buffer): Protocol100DecodeEvent[] {
    if (chunk.length === 0) return [];
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.maxBufferedBytes) {
      this.buffer = this.buffer.subarray(-this.maxBufferedBytes);
    }

    const events: Protocol100DecodeEvent[] = [];
    while (this.buffer.length > 0) {
      const headerAt = this.buffer.indexOf(PROTOCOL_100_HEADER);
      if (headerAt < 0) {
        this.keepPossibleHeaderPrefix();
        break;
      }
      if (headerAt > 0) this.buffer = this.buffer.subarray(headerAt);
      if (this.buffer.length < 5) break;

      const bodyLength = this.buffer.readUInt16LE(3);
      if (bodyLength < 1 || bodyLength > PROTOCOL_100_MAX_BODY_BYTES) {
        const raw = Buffer.from(this.buffer.subarray(0, 5));
        events.push({
          ok: false,
          error: new Protocol100FrameError('length', `invalid body length ${bodyLength}`),
          raw,
        });
        this.buffer = this.buffer.subarray(1);
        continue;
      }

      const frameLength = 3 + 2 + bodyLength + 2;
      if (this.buffer.length < frameLength) {
        const nestedFrameAt = this.findCompleteValidFrame();
        if (nestedFrameAt === undefined) break;
        const raw = Buffer.from(this.buffer.subarray(0, nestedFrameAt));
        events.push({
          ok: false,
          error: new Protocol100FrameError(
            'length',
            `incomplete body length ${bodyLength} masks a following valid frame`,
          ),
          raw,
        });
        this.buffer = this.buffer.subarray(nestedFrameAt);
        continue;
      }
      const candidate = Buffer.from(this.buffer.subarray(0, frameLength));
      try {
        events.push({ ok: true, frame: decodeProtocol100Frame(candidate) });
        this.buffer = this.buffer.subarray(frameLength);
      } catch (error) {
        if (!(error instanceof Protocol100FrameError)) throw error;
        events.push({ ok: false, error, raw: candidate });
        this.buffer = this.buffer.subarray(1);
      }
    }
    return events;
  }

  private findCompleteValidFrame(): number | undefined {
    let headerAt = this.buffer.indexOf(PROTOCOL_100_HEADER, 1);
    while (headerAt >= 0) {
      const remaining = this.buffer.length - headerAt;
      if (remaining < 5) return undefined;
      const bodyLength = this.buffer.readUInt16LE(headerAt + 3);
      if (bodyLength >= 1 && bodyLength <= PROTOCOL_100_MAX_BODY_BYTES) {
        const frameLength = 3 + 2 + bodyLength + 2;
        if (remaining >= frameLength) {
          const candidate = Buffer.from(this.buffer.subarray(headerAt, headerAt + frameLength));
          try {
            decodeProtocol100Frame(candidate);
            return headerAt;
          } catch (error) {
            if (!(error instanceof Protocol100FrameError)) throw error;
          }
        }
      }
      headerAt = this.buffer.indexOf(PROTOCOL_100_HEADER, headerAt + 1);
    }
    return undefined;
  }

  private keepPossibleHeaderPrefix(): void {
    const maxPrefix = Math.min(PROTOCOL_100_HEADER.length - 1, this.buffer.length);
    for (let length = maxPrefix; length > 0; length -= 1) {
      if (this.buffer.subarray(-length).equals(PROTOCOL_100_HEADER.subarray(0, length))) {
        this.buffer = this.buffer.subarray(-length);
        return;
      }
    }
    this.buffer = Buffer.alloc(0);
  }
}
