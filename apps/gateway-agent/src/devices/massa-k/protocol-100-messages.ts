import {
  PROTOCOL_100_COMMAND,
  Protocol100FrameError,
  type DecodedProtocol100Frame,
} from './protocol-100-frame';

const DIVISION_KG = [0.0001, 0.001, 0.01, 0.1, 1] as const;
const CR = 0x0d;
const LF = 0x0a;

export const PROTOCOL_100_NAME_WIRE_BYTE_BOUNDS = { min: 2, max: 27 } as const;

export const PROTOCOL_100_PARAMETER_BYTE_BOUNDS = {
  maximum: { wireName: 'P_Max', min: 2, max: 20 },
  minimum: { wireName: 'P_Min', min: 2, max: 20 },
  verificationInterval: { wireName: 'P_e', min: 2, max: 10 },
  maximumTare: { wireName: 'P_T', min: 2, max: 10 },
  // Firmware omits spaces (`Fix=0`); the manual example uses `Fix = 0`.
  fixation: { wireName: 'Fix', min: 5, max: 7 },
  // Firmware emits `Code=634089`; manual revisions show spaced 12/13-byte variants.
  calibrationCode: { wireName: 'Calcode', min: 11, max: 13 },
  softwareVersion: { wireName: 'PO_Ver', min: 2, max: 9 },
  softwareChecksum: { wireName: 'PO_Summ', min: 2, max: 8 },
} as const;

const SCALE_PARAMETER_ORDER = [
  'maximum',
  'minimum',
  'verificationInterval',
  'maximumTare',
  'fixation',
  'calibrationCode',
  'softwareVersion',
  'softwareChecksum',
] as const;

const DEVICE_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  0x07: 'command_not_supported',
  0x08: 'overload',
  0x09: 'not_in_weighing_mode',
  0x0a: 'invalid_input',
  0x0b: 'save_failed',
  0x10: 'wifi_not_supported',
  0x11: 'ethernet_not_supported',
  0x15: 'zero_not_possible',
  0x17: 'weighing_module_unreachable',
  0x18: 'loaded_during_startup',
  0x19: 'device_fault',
  0xf0: 'unknown_error',
};

export interface Protocol100MassResponse {
  kind: 'mass';
  weightKg: number;
  divisionKg: number;
  stable: boolean;
  net: boolean;
  zero: boolean;
  tareKg: number | null;
}

export interface Protocol100NameResponse {
  kind: 'name';
  scaleId: number;
  name: string;
}

export interface Protocol100ScaleParametersResponse {
  kind: 'scale_parameters';
  maximum: string;
  minimum: string;
  verificationInterval: string;
  maximumTare: string;
  fixation: string;
  calibrationCode: string;
  softwareVersion: string;
  softwareChecksum: string;
}

export interface Protocol100DeviceErrorResponse {
  kind: 'device_error';
  code: number | null;
  message: string;
}

export type Protocol100Response =
  | Protocol100MassResponse
  | Protocol100NameResponse
  | Protocol100ScaleParametersResponse
  | Protocol100DeviceErrorResponse
  | { kind: 'nack' };

const roundKg = (value: number) => Math.round(value * 10_000) / 10_000;

function binaryFlag(name: string, value: number): boolean {
  if (value !== 0 && value !== 1) {
    throw new Protocol100FrameError('length', `${name} flag must be 0 or 1`);
  }
  return value === 1;
}

function assertByteLength(bytes: Buffer, name: string, min: number, max: number): void {
  if (bytes.length < min || bytes.length > max) {
    throw new Protocol100FrameError(
      'length',
      `${name} byte length ${bytes.length} is outside ${min}..${max}`,
    );
  }
}

function assertControlFree(bytes: Buffer, name: string): void {
  for (const byte of bytes) {
    if (byte < 0x20 || (byte >= 0x7f && byte <= 0x9f)) {
      throw new Protocol100FrameError('length', `${name} contains a control byte`);
    }
  }
}

function splitCrlfFields(bytes: Buffer): Buffer[] {
  if (bytes.length < 2 || bytes.at(-2) !== CR || bytes.at(-1) !== LF) {
    throw new Protocol100FrameError('length', 'text fields must end with CRLF');
  }

  const fields: Buffer[] = [];
  let fieldStart = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte === CR && bytes[index + 1] === LF) {
      fields.push(bytes.subarray(fieldStart, index));
      fieldStart = index + 2;
      index += 1;
      continue;
    }
    if (byte === CR || byte === LF) {
      throw new Protocol100FrameError('length', 'text field contains a control byte');
    }
  }
  return fields;
}

export function parseProtocol100Response(frame: DecodedProtocol100Frame): Protocol100Response {
  const { body } = frame;
  if (body.length === 0) {
    throw new Protocol100FrameError('length', 'response body must not be empty');
  }
  const command = body[0];
  if (command === PROTOCOL_100_COMMAND.ackMass) {
    if (body.length !== 9 && body.length !== 13) {
      throw new Protocol100FrameError('length', `ACK_MASSA length ${body.length} is invalid`);
    }
    const division = body[5];
    if (division >= DIVISION_KG.length) {
      throw new Protocol100FrameError('length', `division ${division} is invalid`);
    }
    const divisionKg = DIVISION_KG[division];
    return {
      kind: 'mass',
      weightKg: roundKg(body.readInt32LE(1) * divisionKg),
      divisionKg,
      stable: binaryFlag('stable', body[6]),
      net: binaryFlag('net', body[7]),
      zero: binaryFlag('zero', body[8]),
      tareKg: body.length === 13 ? roundKg(body.readInt32LE(9) * divisionKg) : null,
    };
  }
  if (command === PROTOCOL_100_COMMAND.ackName) {
    const wireName = body.subarray(5);
    assertByteLength(
      wireName,
      'ACK_NAME Name field',
      PROTOCOL_100_NAME_WIRE_BYTE_BOUNDS.min,
      PROTOCOL_100_NAME_WIRE_BYTE_BOUNDS.max,
    );
    if (wireName.at(-2) !== CR || wireName.at(-1) !== LF) {
      throw new Protocol100FrameError('length', 'ACK_NAME Name field must end with CRLF');
    }
    const nameBytes = wireName.subarray(0, -2);
    assertControlFree(nameBytes, 'ACK_NAME Name field');
    const scaleId = body.readInt32LE(1);
    return { kind: 'name', scaleId, name: nameBytes.toString('latin1') };
  }
  if (command === PROTOCOL_100_COMMAND.ackScaleParameters) {
    const fields = splitCrlfFields(body.subarray(1));
    if (fields.length !== 8) {
      throw new Protocol100FrameError('length', 'ACK_SCALE_PAR must contain eight fields');
    }
    for (let index = 0; index < fields.length; index += 1) {
      const bounds = PROTOCOL_100_PARAMETER_BYTE_BOUNDS[SCALE_PARAMETER_ORDER[index]];
      assertByteLength(fields[index], bounds.wireName, bounds.min, bounds.max);
      assertControlFree(fields[index], bounds.wireName);
    }
    const [
      maximum,
      minimum,
      verificationInterval,
      maximumTare,
      fixation,
      calibrationCode,
      softwareVersion,
      softwareChecksum,
    ] = fields.map((field) => field.toString('latin1'));
    return {
      kind: 'scale_parameters',
      maximum,
      minimum,
      verificationInterval,
      maximumTare,
      fixation,
      calibrationCode,
      softwareVersion,
      softwareChecksum,
    };
  }
  if (command === PROTOCOL_100_COMMAND.error) {
    if (body.length !== 1 && body.length !== 2) {
      throw new Protocol100FrameError('length', 'CMD_ERROR length must be one or two');
    }
    const code = body.length === 2 ? body[1] : null;
    return {
      kind: 'device_error',
      code,
      message:
        code === null
          ? 'device_error_without_code'
          : (DEVICE_ERROR_MESSAGES[code] ?? 'unknown_error'),
    };
  }
  if (command === PROTOCOL_100_COMMAND.nack && body.length === 1) return { kind: 'nack' };
  throw new Protocol100FrameError(
    'length',
    `unexpected response command 0x${command.toString(16)}`,
  );
}
