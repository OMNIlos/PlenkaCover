import { LEGACY_PAYROLL_TARIFF_MATRIX_V1 } from '../../common/payroll-tariffs/payroll-tariff-engine';
import type { PublishedPayrollTariffOrder } from '../../common/payroll-tariffs/payroll-tariff-order.repository';
import { parseOperatorShiftCloseResult } from './operator-shift-close-result';

const OWNERSHIP = { sessionId: 'session-1', shiftId: 'shift-1', postId: 'post-1' };
const LEGACY_ORDER: PublishedPayrollTariffOrder = {
  reference: {
    id: 'payroll-tariff-order-8-09-25-2025-09-29',
    name: 'Приказ № 8-09/25',
    effectiveFrom: '2025-09-29',
    currency: 'RUB',
  },
  effectiveFromMs: Date.parse('2025-09-28T21:00:00.000Z'),
  revision: 1,
  matrix: LEGACY_PAYROLL_TARIFF_MATRIX_V1,
  matrixHash: 'a'.repeat(64),
};

function validResult(): any {
  return {
    balance: {
      producedKg: 41,
      defectKg: 1,
      expectedUsageKg: 41,
      actualUsageKg: 41,
      deviationPercent: 0,
      status: 'ok',
    },
    problemId: null,
    releasedRollIds: ['ROLL-RELEASED'],
    closingPayroll: {
      sessionId: 'session-1',
      shiftId: 'shift-1',
      status: 'partial',
      summary: {
        payableAmountKopecks: 16_400,
        payableKg: 41,
        machineShiftCount: 1,
        unresolvedKg: 2,
        unresolvedFactCount: 1,
        excludedDefectKg: 1,
        excludedDefectRollCount: 1,
      },
      breakdown: [
        {
          id: 'self-payroll:shift-1:post-1:primary:400:primary::0',
          shiftId: 'shift-1',
          shiftLabel: 'Смена 1',
          shiftDate: '2026-08-08',
          postId: 'post-1',
          postCode: 'POST-1',
          postName: 'УРП',
          machineFamily: 'urp',
          shiftDuration: '12h',
          shiftOutputKg: 60,
          payableKg: 41,
          rateKopecksPerKg: 400,
          amountKopecks: 16_400,
          tariffRule: 'primary',
          basisLabel: 'УРП · 12 ч · первичка · выработка 60.000 кг',
          materialClass: 'primary',
          filmClass: null,
          specialCustomer: false,
        },
      ],
      unresolved: [
        {
          rollId: 'roll-2',
          rollCode: 'ROLL-2',
          orderId: 'order-1',
          orderNumber: 'ORDER-1',
          producedAt: '2026-08-08T10:00:00.000Z',
          netKg: 2,
          shiftId: 'shift-1',
          shiftLabel: 'Смена 1',
          postId: 'post-1',
          postCode: 'POST-1',
          postName: 'УРП',
          reasons: ['shift_not_closed'],
        },
      ],
    },
  };
}

describe('operator shift close replay result', () => {
  it.each([
    ['primary', 'primary', 400, 180_000, 450],
    ['secondary', 'secondary', 400, 220_000, 550],
    ['thin_roll', null, 12, 7_800, 650],
  ])(
    'replays a grouped %s output using its saved tariff matrix',
    (rule, material, kg, amount, rate) => {
      const source = validResult();
      source.closingPayroll.appliedTariffOrders = [LEGACY_ORDER.reference];
      const row = source.closingPayroll.breakdown[0];
      Object.assign(row, {
        id: `self-payroll:shift-1:post-1:${LEGACY_ORDER.reference.id}:${rule}:${rate}:${material ?? ''}::0`,
        tariffOrderId: LEGACY_ORDER.reference.id,
        tariffRule: rule,
        materialClass: material,
        shiftOutputKg: 800,
        payableKg: kg,
        rateKopecksPerKg: rate,
        amountKopecks: amount,
        basisLabel: `УРП · 12 ч · ${material ?? 'тонкий рулон'} · переработано 800.000 кг`,
      });
      source.closingPayroll.summary.payableKg = kg;
      source.closingPayroll.summary.payableAmountKopecks = amount;
      expect(
        parseOperatorShiftCloseResult(source, OWNERSHIP, [LEGACY_ORDER]).closingPayroll
          .breakdown[0],
      ).toMatchObject({ amountKopecks: amount });
      row.rateKopecksPerKg = 600;
      row.amountKopecks = Number(kg) * 600;
      source.closingPayroll.summary.payableAmountKopecks = row.amountKopecks;
      row.id = row.id.replace(`:${rate}:`, ':600:');
      expect(() => parseOperatorShiftCloseResult(source, OWNERSHIP, [LEGACY_ORDER])).toThrow();
    },
  );
  it('normalizes a legacy singleton snapshot to the bootstrap order reference', () => {
    const source = validResult();

    const result = parseOperatorShiftCloseResult(source, OWNERSHIP, [LEGACY_ORDER]);

    expect(result.closingPayroll.appliedTariffOrders).toEqual([LEGACY_ORDER.reference]);
    expect(result.closingPayroll.breakdown[0]).toMatchObject({
      tariffOrderId: LEGACY_ORDER.reference.id,
    });
    expect(result.balance).toEqual(source.balance);
    expect(result.problemId).toBe(source.problemId);
    expect(result.releasedRollIds).toEqual(source.releasedRollIds);
    expect(result).not.toBe(source);
    expect(result.balance).not.toBe(source.balance);
    expect(result.closingPayroll.breakdown[0]).not.toBe(source.closingPayroll.breakdown[0]);
  });

  it('validates a referenced snapshot against its own matrix after a later publication', () => {
    const source = validResult();
    source.closingPayroll.appliedTariffOrders = [LEGACY_ORDER.reference];
    Object.assign(source.closingPayroll.breakdown[0], {
      id: `self-payroll:shift-1:post-1:${LEGACY_ORDER.reference.id}:abc_standard:450:primary::0`,
      tariffOrderId: LEGACY_ORDER.reference.id,
      postName: 'Бегемот',
      machineFamily: 'abc_old',
      shiftOutputKg: 50,
      payableKg: 50,
      rateKopecksPerKg: 450,
      amountKopecks: 22_500,
      tariffRule: 'abc_standard',
      basisLabel: 'Бегемот · 12 ч · ставка ABC · переработано 50.000 кг',
      materialClass: 'primary',
    });
    source.closingPayroll.summary.payableKg = 50;
    source.closingPayroll.summary.payableAmountKopecks = 22_500;
    const futureMatrix = structuredClone(LEGACY_PAYROLL_TARIFF_MATRIX_V1);
    futureMatrix.ladders.abc12h[0]!.standardRateKopecksPerKg = 999;
    const future: PublishedPayrollTariffOrder = {
      reference: {
        id: 'future-order',
        name: 'Будущий приказ',
        effectiveFrom: '2026-09-01',
        currency: 'RUB',
      },
      effectiveFromMs: Date.parse('2026-08-31T21:00:00.000Z'),
      revision: 1,
      matrix: futureMatrix,
      matrixHash: 'b'.repeat(64),
    };

    const result = parseOperatorShiftCloseResult(source, OWNERSHIP, [LEGACY_ORDER, future]);

    expect(result.closingPayroll.breakdown[0]).toMatchObject({
      tariffOrderId: LEGACY_ORDER.reference.id,
      rateKopecksPerKg: 450,
      amountKopecks: 22_500,
    });
  });

  it('preserves an explicit zero rate and zero consumption in a referenced snapshot', () => {
    const matrix = structuredClone(LEGACY_PAYROLL_TARIFF_MATRIX_V1);
    matrix.ladders.abc12h[0]!.standardRateKopecksPerKg = 0;
    const order: PublishedPayrollTariffOrder = {
      reference: {
        id: 'zero-order',
        name: 'Приказ с нулевой ставкой',
        effectiveFrom: '2026-08-01',
        currency: 'RUB',
      },
      effectiveFromMs: Date.parse('2026-07-31T21:00:00.000Z'),
      revision: 1,
      matrix,
      matrixHash: 'c'.repeat(64),
    };
    const source = validResult();
    source.closingPayroll.status = 'complete';
    source.closingPayroll.appliedTariffOrders = [order.reference];
    source.closingPayroll.unresolved = [];
    Object.assign(source.closingPayroll.breakdown[0], {
      id: 'self-payroll:shift-1:post-1:zero-order:abc_standard:0:primary::0',
      tariffOrderId: order.reference.id,
      postName: 'Бегемот',
      machineFamily: 'abc_old',
      shiftOutputKg: 0,
      payableKg: 0,
      rateKopecksPerKg: 0,
      amountKopecks: 0,
      tariffRule: 'abc_standard',
      basisLabel: 'Бегемот · 12 ч · ставка ABC · переработано 0.000 кг',
      materialClass: 'primary',
    });
    Object.assign(source.closingPayroll.summary, {
      payableAmountKopecks: 0,
      payableKg: 0,
      unresolvedKg: 0,
      unresolvedFactCount: 0,
    });

    const result = parseOperatorShiftCloseResult(source, OWNERSHIP, [order]);

    expect(result.closingPayroll.breakdown[0]).toMatchObject({
      payableKg: 0,
      rateKopecksPerKg: 0,
      amountKopecks: 0,
      tariffOrderId: order.reference.id,
    });
  });

  it.each([
    {
      name: 'secondary',
      machineFamily: 'urp',
      postName: 'УРП',
      tariffRule: 'secondary',
      rateKopecksPerKg: 500,
      materialClass: 'secondary',
      filmClass: null,
      specialCustomer: false,
      payableKg: 41,
      basisLabel: 'УРП · 12 ч · вторичка · выработка 60.000 кг',
    },
    {
      name: 'thin roll',
      machineFamily: 'urp',
      postName: 'УРП',
      tariffRule: 'thin_roll',
      rateKopecksPerKg: 650,
      materialClass: null,
      filmClass: null,
      specialCustomer: false,
      payableKg: 5,
      basisLabel: 'УРП · 12 ч · тонкий рулон · выработка 60.000 кг',
    },
    {
      name: 'ABC standard',
      machineFamily: 'abc_old',
      postName: 'АВС старая',
      tariffRule: 'abc_standard',
      rateKopecksPerKg: 450,
      materialClass: null,
      filmClass: 'standard',
      specialCustomer: false,
      payableKg: 41,
      basisLabel: 'АВС старая · 12 ч · стандартная плёнка · выработка 60.000 кг',
    },
    {
      name: 'ABC Falz',
      machineFamily: 'abc_new',
      postName: 'АВС новая',
      tariffRule: 'abc_black_white',
      rateKopecksPerKg: 500,
      materialClass: null,
      filmClass: 'black_white',
      specialCustomer: false,
      payableKg: 41,
      basisLabel: 'АВС новая · 12 ч · фальц · выработка 60.000 кг',
    },
    {
      name: 'Alabuga override',
      machineFamily: 'abc_new',
      postName: 'АВС новая',
      tariffRule: 'alabuga_override',
      rateKopecksPerKg: 400,
      materialClass: null,
      filmClass: null,
      specialCustomer: true,
      payableKg: 41,
      basisLabel: 'АВС новая · 12 ч · ОЭЗ ППТ АЛАБУГА АО · выработка 60.000 кг',
    },
  ])('accepts the canonical $name tariff tuple', (tariff) => {
    const source = validResult();
    const row = source.closingPayroll.breakdown[0];
    Object.assign(row, tariff);
    delete row.name;
    row.id = [
      'self-payroll',
      row.shiftId,
      row.postId,
      row.tariffRule,
      row.rateKopecksPerKg,
      row.materialClass ?? '',
      row.filmClass ?? '',
      row.specialCustomer ? 1 : 0,
    ]
      .map((part) => encodeURIComponent(String(part)))
      .join(':');
    row.amountKopecks = Math.round(row.payableKg * row.rateKopecksPerKg);
    source.closingPayroll.summary.payableKg = row.payableKg;
    source.closingPayroll.summary.payableAmountKopecks = row.amountKopecks;

    expect(() => parseOperatorShiftCloseResult(source, OWNERSHIP)).not.toThrow();
  });

  it('normalizes a legacy black-white replay label to Falz without changing its money', () => {
    const source = validResult();
    source.closingPayroll.unresolved = [];
    source.closingPayroll.status = 'complete';
    const row = source.closingPayroll.breakdown[0];
    Object.assign(row, {
      id: 'self-payroll:shift-1:post-1:abc_black_white:500::black_white:0',
      postName: 'АВС новая',
      machineFamily: 'abc_new',
      shiftOutputKg: 60,
      payableKg: 41,
      rateKopecksPerKg: 500,
      amountKopecks: 20_500,
      tariffRule: 'abc_black_white',
      basisLabel: 'АВС новая · 12 ч · чёрно-белая плёнка · выработка 60.000 кг',
      materialClass: null,
      filmClass: 'black_white',
      specialCustomer: false,
    });
    Object.assign(source.closingPayroll.summary, {
      payableAmountKopecks: 20_500,
      payableKg: 41,
      unresolvedKg: 0,
      unresolvedFactCount: 0,
    });

    const result = parseOperatorShiftCloseResult(source, OWNERSHIP);

    expect(result.closingPayroll.breakdown[0]).toMatchObject({
      amountKopecks: 20_500,
      basisLabel: 'АВС новая · 12 ч · фальц · выработка 60.000 кг',
    });
  });

  it('accepts the current shift-consumption payroll tuple returned at shift close', () => {
    const source = validResult();
    const row = source.closingPayroll.breakdown[0];
    Object.assign(row, {
      id: 'self-payroll:shift-1:post-1:abc_standard:450:primary::0',
      postName: 'Бегемот',
      machineFamily: 'abc_old',
      shiftDuration: '12h',
      shiftOutputKg: 50,
      payableKg: 50,
      rateKopecksPerKg: 450,
      amountKopecks: 22_500,
      tariffRule: 'abc_standard',
      basisLabel: 'Бегемот · 12 ч · ставка ABC · переработано 50.000 кг',
      materialClass: 'primary',
      filmClass: null,
      specialCustomer: false,
    });
    source.closingPayroll.summary.payableKg = 50;
    source.closingPayroll.summary.payableAmountKopecks = 22_500;

    expect(() => parseOperatorShiftCloseResult(source, OWNERSHIP)).not.toThrow();
  });

  it.each([
    ['an extra root key', (value: any) => (value.rawPayload = { secret: true })],
    [
      'an extra closing identity',
      (value: any) => (value.closingPayroll.operatorId = 'operator-secret'),
    ],
    [
      'an extra breakdown raw payload',
      (value: any) => (value.closingPayroll.breakdown[0].rawPayload = { frame: 'secret' }),
    ],
    [
      'an extra unresolved identity',
      (value: any) => (value.closingPayroll.unresolved[0].operatorId = 'operator-secret'),
    ],
    ['a negative summary', (value: any) => (value.closingPayroll.summary.payableKg = -1)],
    [
      'an unsafe integer amount',
      (value: any) =>
        (value.closingPayroll.summary.payableAmountKopecks = Number.MAX_SAFE_INTEGER + 1),
    ],
    [
      'an inconsistent payable total',
      (value: any) => (value.closingPayroll.summary.payableAmountKopecks = 12_301),
    ],
    [
      'an inconsistent unresolved count',
      (value: any) => (value.closingPayroll.summary.unresolvedFactCount = 0),
    ],
    ['an inconsistent payroll status', (value: any) => (value.closingPayroll.status = 'complete')],
    [
      'a duplicate breakdown identity',
      (value: any) => value.closingPayroll.breakdown.push(value.closingPayroll.breakdown[0]),
    ],
    [
      'a duplicate unresolved roll',
      (value: any) => value.closingPayroll.unresolved.push(value.closingPayroll.unresolved[0]),
    ],
    [
      'duplicate unresolved reasons',
      (value: any) => value.closingPayroll.unresolved[0].reasons.push('shift_not_closed'),
    ],
    [
      'non-canonical reason order',
      (value: any) =>
        (value.closingPayroll.unresolved[0].reasons = [
          'machine_family_unresolved',
          'shift_not_closed',
        ]),
    ],
    [
      'an unknown reason',
      (value: any) => (value.closingPayroll.unresolved[0].reasons = ['unknown']),
    ],
    [
      'a malformed produced instant',
      (value: any) => (value.closingPayroll.unresolved[0].producedAt = '2026-08-08'),
    ],
    [
      'a non-canonical breakdown id',
      (value: any) => (value.closingPayroll.breakdown[0].id = 'invented-rate'),
    ],
    [
      'a wrong breakdown amount',
      (value: any) => (value.closingPayroll.breakdown[0].amountKopecks = 12_301),
    ],
    [
      'an internally consistent invented tariff',
      (value: any) => {
        const row = value.closingPayroll.breakdown[0];
        row.rateKopecksPerKg = 999;
        row.amountKopecks = 40_959;
        row.id = 'self-payroll:shift-1:post-1:primary:999:primary::0';
        row.basisLabel = 'Придуманная ставка';
        value.closingPayroll.summary.payableAmountKopecks = 40_959;
      },
    ],
    ['a mismatched session', (value: any) => (value.closingPayroll.sessionId = 'session-other')],
    [
      'a mismatched row post',
      (value: any) => (value.closingPayroll.breakdown[0].postId = 'post-other'),
    ],
    ['an inconsistent balance denominator', (value: any) => (value.balance.expectedUsageKg = 40)],
    ['an inconsistent balance deviation', (value: any) => (value.balance.deviationPercent = 1)],
    [
      'a pending closing balance',
      (value: any) => {
        value.balance.actualUsageKg = null;
        value.balance.deviationPercent = null;
        value.balance.status = 'pending';
      },
    ],
    ['duplicate released roll ids', (value: any) => value.releasedRollIds.push('ROLL-RELEASED')],
  ])('rejects %s', async (_name, mutate) => {
    const source = validResult();
    mutate(source);

    expect(() => parseOperatorShiftCloseResult(source, OWNERSHIP)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'OPERATOR_SHIFT_CLOSE_REPLAY_INVALID' }),
      }),
    );
  });
});
