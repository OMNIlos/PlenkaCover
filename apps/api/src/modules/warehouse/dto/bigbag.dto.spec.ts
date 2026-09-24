import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateBigBagDto, MoveBigBagDto } from './bigbag.dto';

async function errors(value: object) {
  return validate(plainToInstance(CreateBigBagDto, value), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('CreateBigBagDto', () => {
  it.each([
    { materialId: 'rm-aika', weightKg: 25 },
    { baseRawMaterialDefinitionId: 'material-aika', weightKg: 25, batchCode: ' ПАРТИЯ-25 ' },
    { recipeDefinitionVersionId: 'recipe-film-v3', weightKg: 100 },
  ])('accepts a supported material selector: %o', async (command) => {
    await expect(errors(command)).resolves.toHaveLength(0);
  });

  it('rejects a blank or oversized optional batch code', async () => {
    await expect(
      errors({ baseRawMaterialDefinitionId: 'material-aika', weightKg: 25, batchCode: '   ' }),
    ).resolves.not.toHaveLength(0);
    await expect(
      errors({
        baseRawMaterialDefinitionId: 'material-aika',
        weightKg: 25,
        batchCode: 'x'.repeat(121),
      }),
    ).resolves.not.toHaveLength(0);
  });

  it('accepts and normalizes an authoritative optional supplier snapshot', async () => {
    const dto = plainToInstance(CreateBigBagDto, {
      baseRawMaterialDefinitionId: 'material-aika',
      weightKg: 25,
      supplierName: '  ООО Поставщик  ',
    });

    await expect(
      validate(dto, { whitelist: true, forbidNonWhitelisted: true }),
    ).resolves.toHaveLength(0);
    expect(dto.supplierName).toBe('ООО Поставщик');

    await expect(
      errors({
        baseRawMaterialDefinitionId: 'material-aika',
        weightKg: 25,
        supplierName: '   ',
      }),
    ).resolves.not.toHaveLength(0);
    await expect(
      errors({
        baseRawMaterialDefinitionId: 'material-aika',
        weightKg: 25,
        supplierName: 'x'.repeat(201),
      }),
    ).resolves.not.toHaveLength(0);
  });

  it.each([0, -1, 1.0001, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects unsupported weight %s',
    async (weightKg) => {
      await expect(
        errors({ baseRawMaterialDefinitionId: 'material-aika', weightKg }),
      ).resolves.not.toHaveLength(0);
    },
  );

  it('rejects blank identities and unknown fields', async () => {
    await expect(
      errors({ recipeDefinitionVersionId: '', weightKg: 100 }),
    ).resolves.not.toHaveLength(0);
    await expect(
      errors({
        baseRawMaterialDefinitionId: 'material-aika',
        weightKg: 100,
        composition: [],
      }),
    ).resolves.not.toHaveLength(0);
  });
});

describe('MoveBigBagDto', () => {
  const operationKey = '123e4567-e89b-42d3-a456-426614174000';
  const qrCode = `bbt_${'a'.repeat(64)}`;

  it.each([
    { operationKey, qrCode, destination: 'warehouse' },
    { operationKey, qrCode, destination: 'production' },
    { operationKey, qrCode, destination: 'warehouse', warehouseWeightKg: 12.345 },
  ])('accepts an explicit lifecycle command: %o', async (command) => {
    await expect(
      validate(plainToInstance(MoveBigBagDto, command), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    ).resolves.toHaveLength(0);
  });

  it.each([
    { operationKey: 'not-a-uuid', qrCode, destination: 'warehouse' },
    { operationKey, qrCode: 'BB-01', destination: 'warehouse' },
    { operationKey, qrCode, destination: 'toggle' },
    { operationKey, qrCode, destination: 'warehouse', warehouseWeightKg: -1 },
  ])('rejects an ambiguous or malformed lifecycle command: %o', async (command) => {
    await expect(
      validate(plainToInstance(MoveBigBagDto, command), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    ).resolves.not.toHaveLength(0);
  });
});
