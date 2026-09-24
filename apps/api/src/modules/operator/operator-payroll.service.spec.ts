import { UnauthorizedException } from '@nestjs/common';
import type { DirectorPayrollPreview } from '@plenka/contracts';
import { LEGACY_PAYROLL_TARIFF_MATRIX_V1 } from '../../common/payroll-tariffs/payroll-tariff-engine';
import { OperatorPayrollService } from './operator-payroll.service';

const query = { from: '2026-07-01', to: '2026-07-31' };

function preview(): DirectorPayrollPreview {
  return {
    status: 'complete',
    appliedTariffOrders: [
      {
        id: 'payroll-tariff-order-8-09-25-2025-09-29',
        name: 'Приказ № 8-09/25',
        effectiveFrom: '2025-09-29',
        currency: 'RUB',
        matrix: structuredClone(LEGACY_PAYROLL_TARIFF_MATRIX_V1),
      },
    ],
    range: {
      fromDate: query.from,
      toDate: query.to,
      timezone: 'Europe/Moscow',
      generatedAt: '2026-08-06T00:00:00.000Z',
    },
    summary: {
      payableAmountKopecks: 40_000,
      payableKg: 100,
      machineShiftCount: 1,
      operatorCount: 1,
      unresolvedKg: 0,
      unresolvedFactCount: 0,
      excludedDefectKg: 0,
      excludedDefectRollCount: 0,
    },
    operators: [
      {
        operatorId: 'operator-a',
        operatorName: 'Анна',
        payableKg: 100,
        amountKopecks: 40_000,
        machineShiftCount: 1,
        unresolvedFactCount: 0,
      },
    ],
    breakdown: [
      {
        id: 'payroll:operator-a',
        tariffOrderId: 'payroll-tariff-order-8-09-25-2025-09-29',
        operatorId: 'operator-a',
        operatorName: 'Анна',
        shiftId: 'shift-1',
        shiftLabel: 'Смена 1',
        shiftDate: '2026-07-01',
        postId: 'post-1',
        postCode: 'URP',
        postName: 'УРП',
        machineFamily: 'urp',
        shiftDuration: '24h',
        shiftOutputKg: 100,
        payableKg: 100,
        rateKopecksPerKg: 400,
        amountKopecks: 40_000,
        tariffRule: 'primary',
        basisLabel: 'УРП · 24 ч · primary · переработано 100.000 кг',
        materialClass: 'primary',
        filmClass: null,
        specialCustomer: false,
      },
    ],
    unresolved: [],
  };
}

describe('OperatorPayrollService', () => {
  it('requests only the authenticated operator projection and strips identity fields', async () => {
    const getOperatorPreview = jest.fn().mockResolvedValue(preview());
    const service = new OperatorPayrollService({ getOperatorPreview } as never, {} as never);

    const result = await service.getSelf(
      { userId: 'operator-a', role: 'operator', capabilities: ['operator_payroll:read_self'] },
      query,
    );

    expect(getOperatorPreview).toHaveBeenCalledWith(query, 'operator-a');
    expect(result.summary).not.toHaveProperty('operatorCount');
    expect(result.breakdown[0]).not.toHaveProperty('operatorId');
    expect(result.breakdown[0]).not.toHaveProperty('operatorName');
    expect(result.appliedTariffOrders).toEqual([
      {
        id: 'payroll-tariff-order-8-09-25-2025-09-29',
        name: 'Приказ № 8-09/25',
        effectiveFrom: '2025-09-29',
        currency: 'RUB',
      },
    ]);
    expect(result.appliedTariffOrders?.[0]).not.toHaveProperty('matrix');
    expect(JSON.stringify(result)).not.toContain('operator-a');
    expect(JSON.stringify(result)).not.toContain('Анна');
  });

  it('requires a real user identity even when a caller supplies a capability', async () => {
    const service = new OperatorPayrollService(
      { getOperatorPreview: jest.fn() } as never,
      {} as never,
    );

    await expect(
      service.getSelf(
        { userId: null, role: 'operator', capabilities: ['operator_payroll:read_self'] },
        query,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('builds the closing projection with the shared calculator and exact transaction scope', async () => {
    const source = preview();
    const calculation = {
      status: source.status,
      appliedTariffOrders: source.appliedTariffOrders,
      summary: source.summary,
      operators: source.operators,
      breakdown: source.breakdown,
      unresolved: source.unresolved,
    };
    const getOperatorRootSessionCalculation = jest.fn().mockResolvedValue(calculation);
    const service = new OperatorPayrollService(
      { getOperatorRootSessionCalculation } as never,
      {} as never,
    );
    const tx = { transaction: 'exact-client' };
    const generatedAt = new Date('2026-08-08T10:00:00.000Z');

    const result = await (service as any).getClosingPayroll(tx, {
      operatorId: 'operator-a',
      sessionId: 'session-a',
      shiftId: 'shift-1',
      postId: 'post-1',
      generatedAt,
    });

    expect(getOperatorRootSessionCalculation).toHaveBeenCalledWith(
      {
        operatorId: 'operator-a',
        rootSessionId: 'session-a',
        shiftId: 'shift-1',
        postId: 'post-1',
      },
      generatedAt,
      tx,
    );
    expect(result).toMatchObject({
      sessionId: 'session-a',
      shiftId: 'shift-1',
      status: 'complete',
      summary: {
        payableAmountKopecks: 40_000,
        payableKg: 100,
      },
      appliedTariffOrders: [
        {
          id: 'payroll-tariff-order-8-09-25-2025-09-29',
          name: 'Приказ № 8-09/25',
          effectiveFrom: '2025-09-29',
          currency: 'RUB',
        },
      ],
    });
    expect(result.summary).not.toHaveProperty('operatorCount');
    expect(result.breakdown[0]).not.toHaveProperty('operatorId');
    expect(result.breakdown[0]).not.toHaveProperty('operatorName');
    expect(result).not.toHaveProperty('rateKopecksPerKg');
    expect(result).not.toHaveProperty('basisLabel');
  });

  it('keeps GET and close projections arithmetically identical without penalty deductions', async () => {
    const source = preview();
    source.breakdown.push({
      ...source.breakdown[0]!,
      id: 'payroll:operator-a:secondary',
      tariffRule: 'secondary',
      basisLabel: 'УРП · вторичка',
      materialClass: 'secondary',
      payableKg: 20,
      rateKopecksPerKg: 550,
      amountKopecks: 11_000,
    });
    source.summary = {
      ...source.summary,
      payableKg: 120,
      payableAmountKopecks: 51_000,
    };
    const calculation = {
      status: source.status,
      appliedTariffOrders: source.appliedTariffOrders,
      summary: source.summary,
      operators: source.operators,
      breakdown: source.breakdown,
      unresolved: source.unresolved,
      penaltyAmountKopecks: 99_999,
    };
    const payroll = {
      getOperatorPreview: jest.fn().mockResolvedValue(source),
      getOperatorRootSessionCalculation: jest.fn().mockResolvedValue(calculation),
    };
    const service = new OperatorPayrollService(payroll as never, {} as never);
    const actor = {
      userId: 'operator-a',
      role: 'operator' as const,
      capabilities: ['operator_payroll:read_self' as const],
    };

    const [self, closing] = await Promise.all([
      service.getSelf(actor, query),
      service.getClosingPayroll({} as never, {
        operatorId: 'operator-a',
        sessionId: 'session-a',
        shiftId: 'shift-1',
        postId: 'post-1',
        generatedAt: new Date('2026-08-08T10:00:00.000Z'),
      }),
    ]);

    expect({
      status: closing.status,
      summary: closing.summary,
      breakdown: closing.breakdown,
      unresolved: closing.unresolved,
    }).toEqual({
      status: self.status,
      summary: self.summary,
      breakdown: self.breakdown,
      unresolved: self.unresolved,
    });
    expect(closing.breakdown).toHaveLength(2);
    expect(closing.breakdown.map(({ rateKopecksPerKg }) => rateKopecksPerKg)).toEqual([400, 550]);
    expect(closing).not.toHaveProperty('penaltyAmountKopecks');
    expect(closing.summary.payableAmountKopecks).toBe(51_000);
  });

  it('batch-loads the exact referenced immutable orders when replaying a close result', async () => {
    const source = preview();
    const calculation = {
      status: source.status,
      appliedTariffOrders: source.appliedTariffOrders,
      summary: source.summary,
      operators: source.operators,
      breakdown: source.breakdown,
      unresolved: source.unresolved,
    };
    const repository = {
      loadPublishedOrdersByIds: jest.fn().mockResolvedValue([
        {
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
        },
      ]),
    };
    const service = new OperatorPayrollService(
      { getOperatorRootSessionCalculation: jest.fn().mockResolvedValue(calculation) } as never,
      repository as never,
    );
    const tx = { transaction: 'replay-client' };
    const closingPayroll = await service.getClosingPayroll(tx as never, {
      operatorId: 'operator-a',
      sessionId: 'session-a',
      shiftId: 'shift-1',
      postId: 'post-1',
      generatedAt: new Date('2026-08-08T10:00:00.000Z'),
    });
    const snapshot = {
      balance: {
        producedKg: 100,
        defectKg: 0,
        expectedUsageKg: 100,
        actualUsageKg: 100,
        deviationPercent: 0,
        status: 'ok',
      },
      problemId: null,
      releasedRollIds: [],
      closingPayroll,
    };

    const result = await service.parseClosingResult(tx as never, snapshot, {
      sessionId: 'session-a',
      shiftId: 'shift-1',
      postId: 'post-1',
    });

    expect(repository.loadPublishedOrdersByIds).toHaveBeenCalledTimes(1);
    expect(repository.loadPublishedOrdersByIds).toHaveBeenCalledWith(
      ['payroll-tariff-order-8-09-25-2025-09-29'],
      tx,
    );
    expect(result.closingPayroll.breakdown[0]).toMatchObject({
      tariffOrderId: 'payroll-tariff-order-8-09-25-2025-09-29',
      amountKopecks: 40_000,
    });
  });
});
