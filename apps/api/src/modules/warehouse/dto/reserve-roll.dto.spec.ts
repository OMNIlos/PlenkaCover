import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateWarehouseReserveRollDto } from './reserve-roll.dto';

const valid = {
  operationKey: '018f0b6a-7094-4b54-8c88-cb44c92807eb',
  rollCode: 'RES-001',
  batchCode: 'ПАРТИЯ-1',
  filmType: 'Рукав',
  actualThicknessMicron: 80,
  accountingThicknessMicron: 78,
  widthMm: 1_200,
  plannedLengthM: 800,
  grossKg: 41.9,
  spoolKg: 0.7,
  plannedNetKg: 41,
  spoolType: 'Тонкая',
  birka: 'ГОСТ',
  baseRawMaterialDefinitionId: 'material-1',
};

describe('CreateWarehouseReserveRollDto', () => {
  it('accepts bounded physical facts and a material selector', async () => {
    await expect(
      validate(plainToInstance(CreateWarehouseReserveRollDto, valid)),
    ).resolves.toEqual([]);
  });

  it.each([
    ['operationKey', 'not-a-uuid'],
    ['rollCode', ''],
    ['actualThicknessMicron', 0],
    ['widthMm', Number.NaN],
    ['plannedLengthM', 10_000_001],
    ['grossKg', 100_001],
    ['spoolKg', -1],
  ])('rejects invalid %s', async (field, value) => {
    const errors = await validate(
      plainToInstance(CreateWarehouseReserveRollDto, { ...valid, [field]: value }),
    );

    expect(errors.some((error) => error.property === field)).toBe(true);
  });
});
