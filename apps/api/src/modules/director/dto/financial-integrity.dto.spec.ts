import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PaymentOperationDto } from '../../finance/dto/payment-operation.dto';
import { PaymentUpdateDto } from '../../finance/dto/payment-update.dto';
import { SourceRetryDto } from '../../finance/dto/source-retry.dto';
import { ResolveDecisionDto } from './decision.dto';
import { FinanceOverrideDto, ProductionOverrideDto } from './override.dto';

async function validationErrors<T extends object>(type: new () => T, value: object) {
  return validate(plainToInstance(type, value));
}

async function validateHttpPayload<T extends object>(type: new () => T, value: object) {
  return new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }).transform(value, { type: 'body', metatype: type });
}

async function httpValidationMessages<T extends object>(type: new () => T, value: object) {
  try {
    await validateHttpPayload(type, value);
    return [];
  } catch (error) {
    const response = (error as BadRequestException).getResponse() as { message: string[] };
    return response.message;
  }
}

const OPERATION_KEY = '5d974d96-c03d-4d3e-a690-60a65c031886';

describe('financial and director disputed-action DTOs', () => {
  it.each([
    { reason: '   ', evidence: 'source document', value: 'paid' },
    { reason: 'approved exception', evidence: '   ', value: 'paid' },
    { reason: 'approved exception', evidence: 'source document', value: 'arbitrary' },
  ])('rejects an invalid finance override %#', async (value) => {
    await expect(validationErrors(FinanceOverrideDto, value)).resolves.not.toHaveLength(0);
  });

  it('accepts a bounded finance status and trims audited provenance', async () => {
    const value = plainToInstance(FinanceOverrideDto, {
      reason: '  approved exception  ',
      evidence: '  signed decision  ',
      value: 'paid',
    });

    await expect(validate(value)).resolves.toHaveLength(0);
    expect(value).toMatchObject({
      reason: 'approved exception',
      evidence: 'signed decision',
      value: 'paid',
    });
  });

  it('rejects the server-derived stock payment status at user mutation boundaries', async () => {
    await expect(
      validationErrors(PaymentUpdateDto, {
        operationKey: OPERATION_KEY,
        paymentStatus: 'not_applicable',
      }),
    ).resolves.not.toHaveLength(0);
    await expect(
      validationErrors(FinanceOverrideDto, {
        reason: 'approved exception',
        evidence: 'signed decision',
        value: 'not_applicable',
      }),
    ).resolves.not.toHaveLength(0);
  });

  it('rejects an arbitrary production indicator', async () => {
    await expect(
      validationErrors(ProductionOverrideDto, {
        reason: 'approved exception',
        evidence: 'signed decision',
        value: 'finished_somehow',
      }),
    ).resolves.not.toHaveLength(0);
  });

  it('requires a concrete return reason for a director decision', async () => {
    await expect(validationErrors(ResolveDecisionDto, {})).resolves.not.toHaveLength(0);
    await expect(validationErrors(ResolveDecisionDto, { note: '   ' })).resolves.not.toHaveLength(
      0,
    );
    await expect(
      validationErrors(ResolveDecisionDto, { note: '  missing evidence  ' }),
    ).resolves.toHaveLength(0);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.001])(
    'rejects a non-positive, non-finite, or over-precise payment amount %p',
    async (amount) => {
      await expect(
        validationErrors(PaymentOperationDto, {
          operationKey: OPERATION_KEY,
          operationType: 'cash',
          amount,
        }),
      ).resolves.not.toHaveLength(0);
    },
  );

  it.each(['1C', 'mock_1C', 'warehouse_runtime', 'manual_platform'])(
    'rejects client-asserted payment provenance %s at the HTTP boundary',
    async (source) => {
      await expect(
        httpValidationMessages(PaymentOperationDto, {
          operationKey: OPERATION_KEY,
          operationType: 'cash',
          amount: 10,
          source,
        }),
      ).resolves.toContain('property source should not exist');
    },
  );

  it.each([undefined, 'not-a-uuid', '5d974d96-c03d-1d3e-a690-60a65c031886'])(
    'requires a v4 UUID payment operation key (%p)',
    async (operationKey) => {
      await expect(
        validationErrors(PaymentOperationDto, {
          operationKey,
          operationType: 'cash',
          amount: 10,
        }),
      ).resolves.not.toHaveLength(0);
    },
  );

  it('rejects a payment amount above the safe business boundary', async () => {
    await expect(
      validationErrors(PaymentOperationDto, {
        operationKey: OPERATION_KEY,
        operationType: 'cash',
        amount: 1_000_000_000_000.01,
      }),
    ).resolves.not.toHaveLength(0);
  });

  it('accepts a keyed positive two-decimal payment operation without client provenance', async () => {
    await expect(
      validationErrors(PaymentOperationDto, {
        operationKey: OPERATION_KEY,
        operationType: 'cash',
        amount: 10.25,
      }),
    ).resolves.toHaveLength(0);
  });

  it('canonicalizes an uppercase payment UUID at the HTTP boundary', async () => {
    const value = await validateHttpPayload(PaymentOperationDto, {
      operationKey: OPERATION_KEY.toUpperCase(),
      operationType: 'cash',
      amount: 10.25,
    });

    expect(value.operationKey).toBe(OPERATION_KEY);
  });

  it.each([undefined, 'not-a-uuid', '5d974d96-c03d-1d3e-a690-60a65c031886'])(
    'requires a v4 UUID source retry key (%p)',
    async (operationKey) => {
      await expect(validationErrors(SourceRetryDto, { operationKey })).resolves.not.toHaveLength(0);
    },
  );

  it('accepts a v4 UUID source retry key', async () => {
    await expect(
      validationErrors(SourceRetryDto, { operationKey: OPERATION_KEY }),
    ).resolves.toHaveLength(0);
  });

  it('canonicalizes an uppercase source retry UUID at the HTTP boundary', async () => {
    const value = await validateHttpPayload(SourceRetryDto, {
      operationKey: OPERATION_KEY.toUpperCase(),
    });

    expect(value.operationKey).toBe(OPERATION_KEY);
  });
});
