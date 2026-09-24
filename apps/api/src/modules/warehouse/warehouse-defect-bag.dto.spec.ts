import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DefectBagQueryDto, DefectBagScanDto } from './dto/defect-bag.dto';

const operationKey = '123e4567-e89b-42d3-a456-426614174000';
const payload = `bbt_${'a'.repeat(64)}`;

const errors = <T extends object>(type: new () => T, value: object) =>
  validate(plainToInstance(type, value), { whitelist: true, forbidNonWhitelisted: true });

describe('warehouse defect-bag DTO boundary', () => {
  it('accepts only one queue mode', async () => {
    await expect(errors(DefectBagQueryDto, { mode: 'receiving' })).resolves.toEqual([]);
    await expect(errors(DefectBagQueryDto, { mode: 'shipping' })).resolves.toEqual([]);
    expect(await errors(DefectBagQueryDto, { mode: 'all' })).not.toHaveLength(0);
    expect(await errors(DefectBagQueryDto, {})).not.toHaveLength(0);
  });

  it('accepts only a UUID-v4 and exact private token with no browser topology', async () => {
    await expect(errors(DefectBagScanDto, { operationKey, payload })).resolves.toEqual([]);
    for (const value of [
      { operationKey: 'not-a-uuid', payload },
      { operationKey, payload: ` ${payload}` },
      { operationKey, payload: `${payload}\n` },
      { operationKey, payload, deviceId: 'foreign-scanner' },
    ]) {
      expect(await errors(DefectBagScanDto, value)).not.toHaveLength(0);
    }
  });
});
