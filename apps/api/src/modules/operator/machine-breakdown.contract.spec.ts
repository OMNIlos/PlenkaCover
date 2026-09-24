import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as contracts from '@plenka/contracts';
import { MachineBreakdownDto } from './dto/problem.dto';

const EXPECTED_TYPES = [
  'screw_jam',
  'extruder_stopped',
  'drive_stopped',
  'belt_break',
  'other',
] as const;

const EXPECTED_LABELS = {
  screw_jam: 'Клин шнека',
  extruder_stopped: 'Экструдер остановился',
  drive_stopped: 'Остановка привода',
  belt_break: 'Обрыв ремня',
  other: 'Другая поломка',
} as const;

describe('machine breakdown contract', () => {
  it('publishes the closed type vocabulary and Russian labels', () => {
    expect(contracts.MACHINE_BREAKDOWN_TYPES).toEqual(EXPECTED_TYPES);
    expect(contracts.MACHINE_BREAKDOWN_TYPE_LABELS).toEqual(EXPECTED_LABELS);
  });

  it.each(EXPECTED_TYPES)('accepts %s without optional details', async (type) => {
    const errors = await validate(plainToInstance(MachineBreakdownDto, { type }));

    expect(errors).toEqual([]);
  });

  it('accepts a non-empty optional detail', async () => {
    const errors = await validate(
      plainToInstance(MachineBreakdownDto, {
        type: 'screw_jam',
        details: 'Шнек не вращается после запуска',
      }),
    );

    expect(errors).toEqual([]);
  });

  it('accepts 500 detail characters and rejects 501', async () => {
    const atLimit = await validate(
      plainToInstance(MachineBreakdownDto, { type: 'other', details: 'А'.repeat(500) }),
    );
    const overLimit = await validate(
      plainToInstance(MachineBreakdownDto, { type: 'other', details: 'А'.repeat(501) }),
    );

    expect(atLimit).toEqual([]);
    expect(overLimit.map((error) => error.property)).toContain('details');
  });

  it.each(['machine_breakdown', 'device_offline', 'unknown', ''])(
    'rejects an unknown or dedicated system type %s',
    async (type) => {
      const errors = await validate(plainToInstance(MachineBreakdownDto, { type }));

      expect(errors.map((error) => error.property)).toContain('type');
    },
  );

  it('documents type as required and details as optional', () => {
    const type = Reflect.getMetadata(
      'swagger/apiModelProperties',
      MachineBreakdownDto.prototype,
      'type',
    );
    const details = Reflect.getMetadata(
      'swagger/apiModelProperties',
      MachineBreakdownDto.prototype,
      'details',
    );

    expect(type?.required).not.toBe(false);
    expect(type?.enum).toEqual(EXPECTED_TYPES);
    expect(details?.required).toBe(false);
    expect(details?.maxLength).toBe(500);
  });
});
