import { DirectorAnalyticsService } from './director-analytics.service';
import { PayrollTariffResolver } from '../../common/payroll-tariffs/payroll-tariff-resolver';

/**
 * A Big-Bag released and re-taken inside one session leaves the stable
 * ShiftBagUsage row holding only the latest leg. Measured consumption has to
 * aggregate the immutable episodes, or a shift that really burned material
 * reports zero — and the operator is paid nothing for it.
 */
const bag = {
  id: 'bag-1',
  code: 'BB-ПВД-АЙКА-02',
  materialId: null,
  material: 'ПВД Айка',
  status: 'in_use',
  currentKg: 4_000,
  lastMeasuredKg: 4_000,
  lastMeasuredAt: new Date('2026-08-11T18:57:59.950Z'),
  initialKg: 5_000,
  priceKopecksPerKg: 2_500,
  priceEffectiveAt: new Date('2026-08-01T12:00:00.000Z'),
  rawPayload: { forbidden: true },
};

const episode = (sequence: number, startKg: number, endKg: number | null) => ({
  id: `episode-${sequence}`,
  usageId: 'usage-1',
  sequence,
  startKg,
  endKg,
  closeKind: sequence === 5 ? 'shift_closed' : 'released',
  openedAt: new Date('2026-08-07T15:38:54.808Z'),
  closedAt: new Date('2026-08-11T18:57:59.950Z'),
});

const usage = {
  id: 'usage-1',
  sessionId: 'session-1',
  bigBagId: 'bag-1',
  // The stable row only remembers the final leg: 4000 → 4000, i.e. nothing.
  startKg: 4_000,
  endKg: 4_000,
  releasedReason: null,
  createdAt: new Date('2026-08-07T15:38:54.808Z'),
  closedAt: new Date('2026-08-11T18:57:59.950Z'),
  episodes: [
    episode(1, 5_000, 5_000),
    episode(2, 5_000, 4_000),
    episode(3, 4_000, 4_000),
    episode(4, 4_000, 4_000),
    episode(5, 4_000, 4_000),
  ],
  bigBag: bag,
};

const session = {
  id: 'session-1',
  status: 'closed',
  startedAt: new Date('2026-08-07T15:38:54.808Z'),
  endedAt: new Date('2026-08-11T18:57:59.950Z'),
  operator: { id: 'operator-1', displayName: 'Хабибулин Руслан', passwordHash: 'forbidden' },
  post: { id: 'post-1', code: 'POST-1', name: 'Бегемот', gatewayTokenHash: 'forbidden' },
  shift: { id: 'shift-1', label: 'Смена 1' },
  bagUsages: [usage],
};

function setup() {
  const prisma = {
    operatorPostSession: { findMany: jest.fn().mockResolvedValue([session]) },
    shiftBagUsage: {
      findMany: jest.fn().mockResolvedValue([{ ...usage, session }]),
    },
    weightCapture: { findMany: jest.fn().mockResolvedValue([]) },
    defectRecord: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return new DirectorAnalyticsService(
    prisma as never,
    { loadPublishedSchedule: jest.fn() } as never,
    new PayrollTariffResolver(),
  ) as unknown as {
    getShiftBalanceEvidence(
      query: unknown,
    ): Promise<{ items: Array<{ actualUsageKg: number | null }> }>;
  };
}

describe('shift balance evidence reads consumption from Big-Bag episodes', () => {
  it('totals every episode instead of the stable row that holds only the last leg', async () => {
    const page = await setup().getShiftBalanceEvidence({
      from: '2026-08-01',
      to: '2026-08-12',
      bucket: 'day',
    });

    expect(page.items[0]!.actualUsageKg).toBe(1_000);
  });
});
