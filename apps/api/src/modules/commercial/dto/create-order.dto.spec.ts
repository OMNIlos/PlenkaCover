import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateOrderDto, CreatePositionDto } from './create-order.dto';
import { UpdatePositionDto } from './update-position.dto';

const PLANNED_WEIGHT_ERROR =
  'Введите вес от 0,001 до 100 000 кг, не более трёх знаков после запятой.';

const validPosition = {
  rollCount: 1,
  filmType: 'Рукав',
  actualThickness: '80',
  accountingThickness: '80',
  widthMm: 1700,
  plannedLengthM: 275,
  recipeParameters: [],
};

async function errors(value: object) {
  return validate(plainToInstance(CreatePositionDto, value), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

async function orderErrors(value: object) {
  return validate(plainToInstance(CreateOrderDto, value), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('CreatePositionDto material selector', () => {
  it.each([{ baseRawMaterialDefinitionId: 'm-base' }, { recipeDefinitionVersionId: 'recipe-v1' }])(
    'accepts exactly one structured selector: %o',
    async (selector) => {
      await expect(errors({ ...validPosition, ...selector })).resolves.toHaveLength(0);
    },
  );

  it('accepts a structured selector when legacy recipeParameters are omitted', async () => {
    const { recipeParameters: _legacyRecipeParameters, ...positionWithoutLegacyFields } =
      validPosition;

    await expect(
      errors({
        ...positionWithoutLegacyFields,
        baseRawMaterialDefinitionId: 'm-base',
      }),
    ).resolves.toHaveLength(0);
  });

  it.each([
    { recipeParameters: 'legacy-string' },
    { recipeParameters: [{ label: '', value: 'ПВД' }] },
  ])('retains validation when legacy recipeParameters are supplied: %o', async (legacyFields) => {
    await expect(
      errors({
        ...validPosition,
        ...legacyFields,
        baseRawMaterialDefinitionId: 'm-base',
      }),
    ).resolves.not.toHaveLength(0);
  });

  it('rejects an order position without exactly one structured selector', async () => {
    const dto = plainToInstance(CreatePositionDto, validPosition);

    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rejects an order position with both structured selectors', async () => {
    await expect(
      errors({
        ...validPosition,
        baseRawMaterialDefinitionId: 'm-base',
        recipeDefinitionVersionId: 'recipe-v1',
      }),
    ).resolves.not.toHaveLength(0);
  });

  it('does not accept legacy rawMaterialId as public input', async () => {
    await expect(
      errors({
        ...validPosition,
        rawMaterialId: 'legacy-material',
      }),
    ).resolves.not.toHaveLength(0);
    await expect(
      errors({
        ...validPosition,
        rawMaterialId: 'legacy-material',
        baseRawMaterialDefinitionId: 'm-base',
      }),
    ).resolves.not.toHaveLength(0);
  });

  it('rejects blank structured selector ids', async () => {
    await expect(
      errors({
        ...validPosition,
        baseRawMaterialDefinitionId: '',
      }),
    ).resolves.not.toHaveLength(0);
  });

  it('does not count null as a structured selector', async () => {
    await expect(
      errors({
        ...validPosition,
        baseRawMaterialDefinitionId: null,
      }),
    ).resolves.not.toHaveLength(0);
    await expect(
      errors({
        ...validPosition,
        recipeDefinitionVersionId: null,
      }),
    ).resolves.not.toHaveLength(0);
  });
});

describe('CreatePositionDto roll dimensions', () => {
  const position = {
    ...validPosition,
    baseRawMaterialDefinitionId: 'm-base',
  };

  it('accepts positive width and planned length with at most three decimal places', async () => {
    await expect(
      errors({
        ...position,
        widthMm: 1699.125,
        plannedLengthM: 275.375,
      }),
    ).resolves.toHaveLength(0);
  });

  it('accepts a separate optional manual label', async () => {
    await expect(
      errors({
        ...position,
        birka: 'ГОСТ',
        manualBirka: 'Маркировка А-17',
      }),
    ).resolves.toHaveLength(0);
  });

  it.each(['widthMm', 'plannedLengthM'] as const)(
    'rejects a position without %s',
    async (field) => {
      const invalid = { ...position };
      delete invalid[field];

      await expect(errors(invalid)).resolves.not.toHaveLength(0);
    },
  );

  it.each([
    ['zero width', { widthMm: 0 }],
    ['negative width', { widthMm: -1 }],
    ['non-finite width', { widthMm: Number.POSITIVE_INFINITY }],
    ['over-precise width', { widthMm: 1700.0001 }],
    ['zero planned length', { plannedLengthM: 0 }],
    ['negative planned length', { plannedLengthM: -1 }],
    ['non-finite planned length', { plannedLengthM: Number.NaN }],
    ['over-precise planned length', { plannedLengthM: 275.0001 }],
  ])('rejects %s', async (_label, dimensions) => {
    await expect(errors({ ...position, ...dimensions })).resolves.not.toHaveLength(0);
  });
});

describe('commercial planned weight precision', () => {
  const position = {
    ...validPosition,
    baseRawMaterialDefinitionId: 'm-base',
  };

  it.each([38, 37.5, 37.001, 0.001, 100_000])('accepts exact kg value %p', async (value) => {
    await expect(errors({ ...position, plannedWeightKg: value })).resolves.toHaveLength(0);
    await expect(
      validate(
        plainToInstance(UpdatePositionDto, {
          expectedVersion: 1,
          plannedWeightKg: value,
        }),
      ),
    ).resolves.toHaveLength(0);
  });

  it.each([0, -1, 37.0001, 100_000.001])(
    'rejects invalid kg value %p with the public message',
    async (value) => {
      for (const dto of [
        plainToInstance(CreatePositionDto, { ...position, plannedWeightKg: value }),
        plainToInstance(UpdatePositionDto, { expectedVersion: 1, plannedWeightKg: value }),
      ]) {
        const validationErrors = await validate(dto);
        expect(validationErrors).not.toHaveLength(0);
        expect(
          validationErrors.flatMap((error) => Object.values(error.constraints ?? {})),
        ).toContain(PLANNED_WEIGHT_ERROR);
      }
    },
  );
});

describe('CreateOrderDto request semantics', () => {
  const position = {
    ...validPosition,
    baseRawMaterialDefinitionId: 'm-base',
  };

  it('keeps a counterparty mandatory for a client order', async () => {
    await expect(
      orderErrors({
        clientRequestId: '00000000-0000-4000-8000-000000000061',
        requestType: 'client_order',
        positions: [position],
      }),
    ).resolves.not.toHaveLength(0);
  });

  it('accepts stock production without a fake counterparty', async () => {
    await expect(
      orderErrors({
        clientRequestId: '00000000-0000-4000-8000-000000000062',
        requestType: 'stock_reserve',
        positions: [position],
      }),
    ).resolves.toHaveLength(0);
  });

  it('accepts a free-form finance note up to 2000 characters', async () => {
    await expect(
      orderErrors({
        clientRequestId: '00000000-0000-4000-8000-000000000065',
        requestType: 'client_order',
        counterpartyId: 'counterparty-1',
        commercialFinanceNote: '1200 за 20 рулонов',
        positions: [position],
      }),
    ).resolves.toHaveLength(0);
    await expect(
      orderErrors({
        clientRequestId: '00000000-0000-4000-8000-000000000066',
        requestType: 'client_order',
        counterpartyId: 'counterparty-1',
        commercialFinanceNote: 'x'.repeat(2001),
        positions: [position],
      }),
    ).resolves.not.toHaveLength(0);
  });

  it('accepts paired immutable stock production template identifiers', async () => {
    await expect(
      orderErrors({
        clientRequestId: '00000000-0000-4000-8000-000000000064',
        requestType: 'stock_reserve',
        stockProductionTemplateId: 'stock-template-1',
        stockProductionTemplateVersionId: 'stock-template-version-2',
        positions: [position],
      }),
    ).resolves.toHaveLength(0);
  });

  it.each([false, 0, ''])(
    'rejects a supplied fake stock counterparty: %p',
    async (counterpartyId) => {
      await expect(
        orderErrors({
          clientRequestId: '00000000-0000-4000-8000-000000000063',
          requestType: 'stock_reserve',
          counterpartyId,
          positions: [position],
        }),
      ).resolves.not.toHaveLength(0);
    },
  );
});
