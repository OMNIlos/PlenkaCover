import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { instanceToPlain, plainToInstance } from 'class-transformer';
import {
  BusinessOperationalProblemPageResponseDto,
  BusinessPerformanceRollPageResponseDto,
  CommercialPerformanceControlQueryDto,
  CommercialPerformancePageQueryDto,
} from './commercial-performance.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
});

function validateControl(value: unknown) {
  return pipe.transform(value, {
    type: 'query',
    metatype: CommercialPerformanceControlQueryDto,
  });
}

function validatePage(value: unknown) {
  return pipe.transform(value, {
    type: 'query',
    metatype: CommercialPerformancePageQueryDto,
  });
}

async function messages(validation: Promise<unknown>) {
  try {
    await validation;
    return [];
  } catch (error) {
    return ((error as BadRequestException).getResponse() as { message: string[] }).message;
  }
}

describe('commercial performance query boundary', () => {
  it('does not serialize an internal post id from the roll drilldown', () => {
    const dto = plainToInstance(BusinessPerformanceRollPageResponseDto, {
      items: [
        {
          id: 'dispatch-1',
          rollName: 'Рукав 60 мкм',
          rollCode: 'ROLL-1',
          orderNumber: 'A-5',
          parameters: {
            filmType: 'Рукав',
            actualThicknessUm: 60,
            accountingThicknessUm: 58,
            widthMm: 1700,
            plannedLengthM: 275,
            weightKg: 42.3,
            rawPayload: 'must-not-leak',
            devicePayload: 'must-not-leak',
            gatewayPayload: 'must-not-leak',
          },
          operatorName: 'Оператор 1',
          machineName: 'Экструдер 1',
          priority: 2,
          status: 'completed',
          actorId: 'must-not-leak',
          postId: 'must-not-leak',
          sessionId: 'must-not-leak',
          rawPayload: 'must-not-leak',
          devicePayload: 'must-not-leak',
          gatewayPayload: 'must-not-leak',
          productionCost: {
            kind: 'actual_snapshot',
            status: 'complete',
            calculationVersion: 'production-cost-v1',
            snapshotId: 'snapshot-1',
            version: 1,
            producedAt: '2026-08-02T10:00:00.000Z',
            closedAt: '2026-08-02T18:00:00.000Z',
            createdAt: '2026-08-02T18:00:01.000Z',
            basis: { kind: 'actual', weightGrams: 10_000 },
            materialAmountKopecks: 20_000,
            spoolAmountKopecks: 9_000,
            payrollAmountKopecks: 4_000,
            payrollSource: {
              tariffOrderId: 'payroll-order-1',
              tariffOrderName: 'Приказ № 1',
              effectiveFrom: '2026-08-01',
              rateKopecksPerKg: 400,
              basisLabel: 'УРП · 12 ч · primary',
              rawPayload: 'must-not-leak',
            },
            additionalAmountKopecks: 0,
            totalAmountKopecks: 33_000,
            totalKopecksPerKg: 3_300,
            unresolvedReasons: [],
          },
        },
      ],
      nextCursor: null,
    });

    const plain = instanceToPlain(dto);
    expect(plain).not.toHaveProperty('items.0.actorId');
    expect(plain).not.toHaveProperty('items.0.postId');
    expect(plain).not.toHaveProperty('items.0.sessionId');
    expect(plain).not.toHaveProperty('items.0.rawPayload');
    expect(plain).not.toHaveProperty('items.0.devicePayload');
    expect(plain).not.toHaveProperty('items.0.gatewayPayload');
    expect(plain).not.toHaveProperty('items.0.parameters.rawPayload');
    expect(plain).not.toHaveProperty('items.0.parameters.devicePayload');
    expect(plain).not.toHaveProperty('items.0.parameters.gatewayPayload');
    expect(plain).toHaveProperty('items.0.productionCost.payrollSource', {
      tariffOrderId: 'payroll-order-1',
      tariffOrderName: 'Приказ № 1',
      effectiveFrom: '2026-08-01',
      rateKopecksPerKg: 400,
      basisLabel: 'УРП · 12 ч · primary',
    });
    expect(plain).not.toHaveProperty('items.0.productionCost.payrollSource.rawPayload');
  });

  it('does not serialize raw operational-problem evidence', () => {
    const dto = plainToInstance(BusinessOperationalProblemPageResponseDto, {
      items: [
        {
          id: 'problem-1',
          kind: 'weight_deviation',
          status: 'open',
          label: 'Превышение веса',
          createdAt: '2026-08-07T10:00:00.000Z',
          orderNumber: 'A-5',
          rollCode: 'ROLL-1',
          machineName: 'Экструдер 1',
          reason: 'Превышен допустимый вес',
          detail: { rawPayload: 'must-not-leak' },
          actorId: 'must-not-leak',
          postId: 'must-not-leak',
          sessionId: 'must-not-leak',
        },
      ],
      nextCursor: null,
    });

    const plain = instanceToPlain(dto);
    expect(plain).not.toHaveProperty('items.0.detail');
    expect(plain).not.toHaveProperty('items.0.actorId');
    expect(plain).not.toHaveProperty('items.0.postId');
    expect(plain).not.toHaveProperty('items.0.sessionId');
  });

  it('accepts a bounded control range', async () => {
    await expect(
      validateControl({ from: '2026-07-01', to: '2026-07-31', bucket: 'week' }),
    ).resolves.toEqual({
      from: '2026-07-01',
      to: '2026-07-31',
      bucket: 'week',
    });
  });

  it('rejects an invalid or oversized control range', async () => {
    await expect(
      messages(validateControl({ from: '2025-01-01', to: '2026-07-31', bucket: 'day' })),
    ).resolves.not.toHaveLength(0);
  });

  it('defaults and caps list pagination through validation', async () => {
    await expect(validatePage({ from: '2026-07-01', to: '2026-07-31' })).resolves.toEqual({
      from: '2026-07-01',
      to: '2026-07-31',
      limit: 20,
    });
    await expect(
      messages(validatePage({ from: '2026-07-01', to: '2026-07-31', limit: 101 })),
    ).resolves.not.toHaveLength(0);
  });

  it('rejects unknown fields at the safe commercial boundary', async () => {
    await expect(
      messages(
        validatePage({
          from: '2026-07-01',
          to: '2026-07-31',
          rawPayload: 'must-not-pass',
        }),
      ),
    ).resolves.toContain('property rawPayload should not exist');
  });
});
