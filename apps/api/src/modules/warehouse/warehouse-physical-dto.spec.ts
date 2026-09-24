import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DECORATORS } from '@nestjs/swagger';
import { ControlWeightDto, RollDamagedDto, ScanDto } from './dto/scan.dto';
import {
  WarehouseQrInspectDto,
  WarehouseQrPalletResponseDto,
} from './dto/warehouse-qr-inspection.dto';

const TOKEN = `prt_${'a'.repeat(64)}`;
const BIG_BAG_TOKEN = `bbt_${'b'.repeat(64)}`;
const PALLET_TOKEN = `plt_${'c'.repeat(64)}`;
const KEY = '123e4567-e89b-42d3-a456-426614174000';

function errors<T extends object>(type: new () => T, value: object) {
  return validate(plainToInstance(type, value), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('warehouse physical DTO boundary', () => {
  it('documents the complete pallet roll composition as a required string array', () => {
    const fields = (
      Reflect.getMetadata(
        DECORATORS.API_MODEL_PROPERTIES_ARRAY,
        WarehouseQrPalletResponseDto.prototype,
      ) ?? []
    ).map((field: string) => field.slice(1));
    const rollCodes = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      WarehouseQrPalletResponseDto.prototype,
      'rollCodes',
    );

    expect(fields).toContain('rollCodes');
    expect(rollCodes).toMatchObject({ isArray: true });
    expect(rollCodes.required).not.toBe(false);
    expect(rollCodes.type).toBe(String);
  });

  it.each([TOKEN, BIG_BAG_TOKEN, PALLET_TOKEN])(
    'accepts each supported QR format for read-only inspection',
    async (payload) => {
      await expect(errors(WarehouseQrInspectDto, { payload })).resolves.toEqual([]);
    },
  );

  it.each([
    `prt_${'a'.repeat(63)}`,
    `bbt_${'b'.repeat(65)}`,
    `plt_${'c'.repeat(63)}`,
    ` ${TOKEN}`,
    `${BIG_BAG_TOKEN}\n`,
    `${PALLET_TOKEN}\n`,
    'ROLL-1',
  ])('rejects an unsafe inspection payload %#', async (payload) => {
    expect(await errors(WarehouseQrInspectDto, { payload })).not.toHaveLength(0);
  });

  it('accepts an exact token and UUID operation key', async () => {
    await expect(errors(ScanDto, { operationKey: KEY, payload: TOKEN })).resolves.toEqual([]);
  });

  it.each([
    { operationKey: KEY, payload: 'QR-A-1024-roll-1' },
    { operationKey: KEY, payload: ` ${TOKEN}` },
    { operationKey: KEY, payload: `${TOKEN}\n` },
    { operationKey: 'not-a-uuid', payload: TOKEN },
    { payload: TOKEN },
    { operationKey: KEY, payload: TOKEN, deviceId: 'foreign-scanner' },
    { operationKey: KEY, payload: TOKEN, postId: 'foreign-post' },
  ])('rejects unsafe scan input %#', async (value) => {
    expect(await errors(ScanDto, value)).not.toHaveLength(0);
  });

  it('does not accept browser-supplied kilograms or topology for control weight', async () => {
    await expect(
      errors(ControlWeightDto, { operationKey: KEY, rollCode: 'ROLL-1' }),
    ).resolves.toEqual([]);
    for (const extra of [
      { kg: 41 },
      { deviceId: 'foreign-scale' },
      { postId: 'foreign-post' },
      { stable: true },
    ]) {
      expect(
        await errors(ControlWeightDto, { operationKey: KEY, rollCode: 'ROLL-1', ...extra }),
      ).not.toHaveLength(0);
    }
  });

  it('requires a bounded reason and operation key for damage', async () => {
    await expect(
      errors(RollDamagedDto, {
        operationKey: KEY,
        rollCode: 'ROLL-1',
        reason: 'Повреждение подтверждено после приёмки',
      }),
    ).resolves.toEqual([]);
    expect(await errors(RollDamagedDto, { rollCode: 'ROLL-1' })).not.toHaveLength(0);
    expect(
      await errors(RollDamagedDto, {
        operationKey: KEY,
        rollCode: 'ROLL-1',
        reason: '   ',
      }),
    ).not.toHaveLength(0);
    expect(
      await errors(RollDamagedDto, {
        operationKey: KEY,
        rollCode: '   ',
        reason: 'Повреждение',
      }),
    ).not.toHaveLength(0);
  });
});
