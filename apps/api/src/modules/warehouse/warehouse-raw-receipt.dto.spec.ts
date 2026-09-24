import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RawMaterialStockResponseDto, RawReceiptDto } from './dto/raw-receipt.dto';
import { RawAdjustDto } from './dto/raw-adjust.dto';

const operationKey = '11111111-1111-4111-8111-111111111111';

async function errors(value: object) {
  return validate(plainToInstance(RawReceiptDto, value), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('RawReceiptDto', () => {
  it('accepts a positive receipt with an audited reason and canonical UUID', async () => {
    const dto = plainToInstance(RawReceiptDto, {
      operationKey: operationKey.toUpperCase(),
      receivedQty: 25.5,
      reason: '  Накладная № 42  ',
    });

    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto).toMatchObject({
      operationKey,
      receivedQty: 25.5,
      reason: 'Накладная № 42',
    });
  });

  it.each([0, -1, 0.0001, 1.0001])(
    'rejects an unsupported received quantity %s',
    async (receivedQty) => {
      await expect(
        errors({ operationKey, receivedQty, reason: 'Накладная № 42' }),
      ).resolves.not.toEqual([]);
    },
  );

  it('rejects invalid identifiers, blank reasons, and unknown fields', async () => {
    await expect(
      errors({ operationKey: 'not-a-uuid', receivedQty: 1, reason: 'Накладная' }),
    ).resolves.not.toEqual([]);
    await expect(errors({ operationKey, receivedQty: 1, reason: '   ' })).resolves.not.toEqual([]);
    await expect(
      errors({ operationKey, receivedQty: 1, reason: 'Накладная', actualQty: 500 }),
    ).resolves.not.toEqual([]);
  });
});

describe('RawMaterialStockResponseDto', () => {
  it('keeps an explicit OpenAPI response model for the receipt endpoint', () => {
    expect(RawMaterialStockResponseDto).toBeDefined();
  });
});

describe('RawAdjustDto', () => {
  async function adjustmentErrors(actualQty: number) {
    return validate(
      plainToInstance(RawAdjustDto, {
        operationKey,
        actualQty,
        reason: 'Инвентаризация',
      }),
    );
  }

  it.each([0, 1_000_000])('accepts a bounded correction quantity %s', async (actualQty) => {
    await expect(adjustmentErrors(actualQty)).resolves.toEqual([]);
  });

  it.each([1_000_000.001, 1.0001, Number.POSITIVE_INFINITY])(
    'rejects an unsafe correction quantity %s',
    async (actualQty) => {
      await expect(adjustmentErrors(actualQty)).resolves.not.toEqual([]);
    },
  );
});
