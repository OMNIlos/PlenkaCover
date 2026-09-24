import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  LEGACY_PAYROLL_TARIFF_MATRIX_V1,
  type PayrollRollRateInput,
  type PayrollShiftRateInput,
} from './payroll-tariff-engine';
import {
  PayrollTariffOrderRepository,
  type PayrollTariffSchedule,
  type PublishedPayrollTariffOrder,
} from './payroll-tariff-order.repository';
import { parsePayrollTariffMatrix } from './payroll-tariff-matrix.parser';
import { PayrollTariffResolver } from './payroll-tariff-resolver';

const at = (value: string) => new Date(value);

function order(
  id: string,
  effectiveFrom: string,
  primaryRateKopecksPerKg = 400,
): PublishedPayrollTariffOrder {
  const source = JSON.parse(JSON.stringify(LEGACY_PAYROLL_TARIFF_MATRIX_V1)) as Record<
    string,
    unknown
  >;
  const ladders = source.ladders as {
    urp12h: Array<{ primaryRateKopecksPerKg: number }>;
  };
  ladders.urp12h[0]!.primaryRateKopecksPerKg = primaryRateKopecksPerKg;
  const matrix = parsePayrollTariffMatrix(source);
  return Object.freeze({
    reference: Object.freeze({
      id,
      name: `Приказ ${id}`,
      effectiveFrom,
      currency: 'RUB' as const,
    }),
    effectiveFromMs: Date.parse(`${effectiveFrom}T00:00:00+03:00`),
    revision: 1,
    matrix,
    matrixHash: id.padEnd(64, '0').slice(0, 64),
  });
}

function shift(overrides: Partial<PayrollShiftRateInput> = {}): PayrollShiftRateInput {
  return {
    postName: 'УРП',
    startedAt: at('2026-08-05T00:00:00.000Z'),
    endedAt: at('2026-08-05T06:00:00.000Z'),
    processedGrams: 750_000,
    materialNames: ['ПВД Айка'],
    ...overrides,
  };
}

function roll(overrides: Partial<PayrollRollRateInput> = {}): PayrollRollRateInput {
  return {
    producedAt: at('2026-08-05T05:00:00.000Z'),
    postName: 'УРП',
    shiftStartedAt: at('2026-08-05T00:00:00.000Z'),
    shiftEndedAt: at('2026-08-05T06:00:00.000Z'),
    shiftOutputGrams: 750_000,
    rollGrams: 40_000,
    materialNames: ['ПВД Айка'],
    filmType: 'Прозрачная',
    counterpartyLegalName: 'ООО ПОКУПАТЕЛЬ',
    ...overrides,
  };
}

describe('payroll tariff resolver', () => {
  const resolver = new PayrollTariffResolver();
  const legacy = order('legacy', '2025-09-29');

  it('selects the order inclusively at its exact Moscow effective instant', () => {
    expect(
      resolver.resolveShift(
        [legacy],
        shift({
          startedAt: at('2025-09-28T15:00:00.000Z'),
          endedAt: at('2025-09-28T21:00:00.000Z'),
        }),
      ),
    ).toMatchObject({
      kind: 'resolved',
      tariffOrder: legacy.reference,
      matrixHash: legacy.matrixHash,
      rateKopecksPerKg: 400,
      amountKopecks: 300_000,
    });
  });

  it('does not apply an order one millisecond early or before a future order', () => {
    expect(
      resolver.resolveShift(
        [legacy],
        shift({
          startedAt: at('2025-09-28T15:00:00.000Z'),
          endedAt: at('2025-09-28T20:59:59.999Z'),
        }),
      ),
    ).toEqual({
      kind: 'unresolved',
      reasons: ['before_policy_effective_date'],
      machineFamily: 'urp',
      shiftDuration: '12h',
    });
    const future = order('future', '2026-09-01', 777);
    expect(resolver.resolveShift([legacy, future], shift())).toMatchObject({
      kind: 'resolved',
      tariffOrder: legacy.reference,
      rateKopecksPerKg: 400,
    });
  });

  it('prices rows on both sides of a period boundary with their exact orders', () => {
    const next = order('next', '2026-08-10', 777);
    const schedule = [legacy, next];
    expect(
      resolver.resolveShift(
        schedule,
        shift({
          startedAt: at('2026-08-09T15:00:00.000Z'),
          endedAt: at('2026-08-09T20:59:59.999Z'),
        }),
      ),
    ).toMatchObject({ tariffOrder: legacy.reference, rateKopecksPerKg: 400 });
    expect(
      resolver.resolveShift(
        schedule,
        shift({
          startedAt: at('2026-08-09T15:00:00.000Z'),
          endedAt: at('2026-08-09T21:00:00.000Z'),
        }),
      ),
    ).toMatchObject({ tariffOrder: next.reference, rateKopecksPerKg: 777 });
  });

  it('requires a closed shift basis before selecting a schedule version', () => {
    expect(resolver.resolveShift([legacy], shift({ endedAt: null }))).toEqual({
      kind: 'unresolved',
      reasons: ['shift_duration_unresolved'],
      machineFamily: 'urp',
      shiftDuration: null,
    });
  });

  it('selects roll tariffs by producedAt and returns the roll amount', () => {
    const next = order('next', '2026-08-10', 777);
    expect(
      resolver.resolveRoll(
        [legacy, next],
        roll({
          producedAt: at('2026-08-09T21:00:00.000Z'),
          shiftStartedAt: at('2026-08-09T15:00:00.000Z'),
          shiftEndedAt: at('2026-08-09T20:59:59.999Z'),
        }),
      ),
    ).toMatchObject({
      kind: 'resolved',
      tariffOrder: next.reference,
      matrixHash: next.matrixHash,
      rateKopecksPerKg: 777,
      amountKopecks: 31_080,
    });
  });

  it('loads one schedule and reuses it for one hundred facts without N+1 queries', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'legacy',
        name: 'Приказ legacy',
        effectiveFrom: at('2025-09-28T21:00:00.000Z'),
        currency: 'RUB',
        matrix: JSON.parse(
          JSON.stringify(LEGACY_PAYROLL_TARIFF_MATRIX_V1),
        ) as Prisma.InputJsonValue,
        revision: 1,
      },
    ]);
    const repository = new PayrollTariffOrderRepository({
      payrollTariffOrder: { findMany },
    } as unknown as PrismaService);
    const schedule: PayrollTariffSchedule = await repository.loadPublishedSchedule(
      at('2026-08-31T20:59:59.999Z'),
    );

    const results = Array.from({ length: 100 }, (_, index) =>
      resolver.resolveShift(
        schedule,
        shift({ processedGrams: index, endedAt: at('2026-08-05T06:00:00.000Z') }),
      ),
    );

    expect(results).toHaveLength(100);
    expect(results.every((result) => result.kind === 'resolved')).toBe(true);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
