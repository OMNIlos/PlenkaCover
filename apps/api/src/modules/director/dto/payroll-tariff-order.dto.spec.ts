import { ValidationPipe } from '@nestjs/common';
import { LEGACY_PAYROLL_TARIFF_MATRIX_V1 } from '../../../common/payroll-tariffs/payroll-tariff-engine';
import {
  CreatePayrollTariffOrderDto,
  PublishPayrollTariffOrderDto,
  ReviewPayrollTariffOrderDto,
  UpdatePayrollTariffOrderDto,
} from './payroll-tariff-order.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
});
const operationKey = '123e4567-e89b-42d3-a456-426614174000';

function createPayload() {
  return {
    operationKey,
    name: 'Приказ № 9-08/26',
    effectiveFrom: '2026-08-21',
    matrix: structuredClone(LEGACY_PAYROLL_TARIFF_MATRIX_V1),
  };
}

describe('payroll tariff order DTOs', () => {
  it('accepts strict integer matrix commands and creates nested class instances', async () => {
    const created = await pipe.transform(createPayload(), {
      type: 'body',
      metatype: CreatePayrollTariffOrderDto,
    });
    expect(created).toBeInstanceOf(CreatePayrollTariffOrderDto);
    expect(created.matrix.ladders.urp12h[0]!.maxInclusiveGrams).toBe(750_000);

    await expect(
      pipe.transform({ ...createPayload(), expectedRevision: 3 }, {
        type: 'body',
        metatype: UpdatePayrollTariffOrderDto,
      }),
    ).resolves.toBeInstanceOf(UpdatePayrollTariffOrderDto);
    await expect(
      pipe.transform({ expectedRevision: 3 }, {
        type: 'body',
        metatype: ReviewPayrollTariffOrderDto,
      }),
    ).resolves.toBeInstanceOf(ReviewPayrollTariffOrderDto);
    await expect(
      pipe.transform(
        { operationKey, expectedRevision: 3, reviewedMatrixHash: 'a'.repeat(64) },
        { type: 'body', metatype: PublishPayrollTariffOrderDto },
      ),
    ).resolves.toBeInstanceOf(PublishPayrollTariffOrderDto);
  });

  it.each([
    ['root', (value: ReturnType<typeof createPayload>) => Object.assign(value, { rawPayload: {} })],
    [
      'ladders',
      (value: ReturnType<typeof createPayload>) =>
        Object.assign(value.matrix.ladders, { deviceStatus: 'online' }),
    ],
    [
      'band',
      (value: ReturnType<typeof createPayload>) =>
        Object.assign(value.matrix.ladders.urp12h[0]!, { rubles: 4 }),
    ],
    [
      'special rule',
      (value: ReturnType<typeof createPayload>) =>
        Object.assign(value.matrix.specialRules.alabuga, { oneCRef: 'secret' }),
    ],
  ])('rejects unknown %s keys through the global whitelist boundary', async (_name, mutate) => {
    const value = createPayload();
    mutate(value);
    await expect(
      pipe.transform(value, { type: 'body', metatype: CreatePayrollTariffOrderDto }),
    ).rejects.toThrow();
  });

  it.each([
    ['non-v4 operation key', { operationKey: 'not-a-uuid' }],
    ['blank name', { name: '' }],
    ['invalid date', { effectiveFrom: '2026-02-30' }],
    ['wrong schema', { matrix: { ...createPayload().matrix, schemaVersion: 2 } }],
    [
      'floating threshold',
      (() => {
        const value = createPayload().matrix;
        value.ladders.urp12h[0]!.maxInclusiveGrams = 1.5;
        return { matrix: value };
      })(),
    ],
    [
      'negative rate',
      (() => {
        const value = createPayload().matrix;
        value.ladders.abc12h[0]!.standardRateKopecksPerKg = -1;
        return { matrix: value };
      })(),
    ],
  ])('rejects %s', async (_name, override) => {
    await expect(
      pipe.transform({ ...createPayload(), ...override }, {
        type: 'body',
        metatype: CreatePayrollTariffOrderDto,
      }),
    ).rejects.toThrow();
  });
});
