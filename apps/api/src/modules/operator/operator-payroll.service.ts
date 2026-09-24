import { Injectable, UnauthorizedException } from '@nestjs/common';
import type {
  OperatorPayrollPreview,
  OperatorPayrollQuery,
  OperatorShiftCloseResult,
  OperatorShiftClosingPayroll,
} from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import { PayrollTariffOrderRepository } from '../../common/payroll-tariffs/payroll-tariff-order.repository';
import type { DirectorPayrollFactsClient } from '../director/director-payroll-facts.service';
import {
  DirectorPayrollService,
  type DirectorPayrollCalculation,
} from '../director/director-payroll.service';
import {
  parseOperatorShiftCloseResult,
  referencedPayrollTariffOrderIds,
  type OperatorShiftCloseResultOwnership,
} from './operator-shift-close-result';

export type OperatorClosingPayrollScope = {
  operatorId: string;
  sessionId: string;
  shiftId: string;
  postId: string;
  generatedAt: Date;
};

type OperatorPayrollRows = Pick<
  DirectorPayrollCalculation,
  'appliedTariffOrders' | 'summary' | 'breakdown' | 'unresolved'
>;

@Injectable()
export class OperatorPayrollService {
  constructor(
    private readonly payroll: DirectorPayrollService,
    private readonly tariffOrders: PayrollTariffOrderRepository,
  ) {}

  async getSelf(actor: Actor, query: OperatorPayrollQuery): Promise<OperatorPayrollPreview> {
    if (!actor.userId) {
      throw new UnauthorizedException('A real user session is required');
    }

    const preview = await this.payroll.getOperatorPreview(query, actor.userId);
    const projected = this.projectRows(preview);

    return {
      status: preview.status,
      range: preview.range,
      ...projected,
    };
  }

  async getClosingPayroll(
    client: DirectorPayrollFactsClient,
    scope: OperatorClosingPayrollScope,
  ): Promise<OperatorShiftClosingPayroll> {
    const calculation = await this.payroll.getOperatorRootSessionCalculation(
      {
        operatorId: scope.operatorId,
        rootSessionId: scope.sessionId,
        shiftId: scope.shiftId,
        postId: scope.postId,
      },
      scope.generatedAt,
      client,
    );
    return {
      sessionId: scope.sessionId,
      shiftId: scope.shiftId,
      status: calculation.status,
      ...this.projectRows(calculation),
    };
  }

  async parseClosingResult(
    client: DirectorPayrollFactsClient,
    value: unknown,
    ownership: OperatorShiftCloseResultOwnership,
  ): Promise<OperatorShiftCloseResult> {
    const orderIds = referencedPayrollTariffOrderIds(value);
    const schedule = await this.tariffOrders.loadPublishedOrdersByIds(orderIds, client);
    return parseOperatorShiftCloseResult(value, ownership, schedule);
  }

  private projectRows(preview: OperatorPayrollRows) {
    const { operatorCount: _operatorCount, ...summary } = preview.summary;
    return {
      appliedTariffOrders: preview.appliedTariffOrders.map(
        ({ matrix: _matrix, ...reference }) => reference,
      ),
      summary,
      breakdown: preview.breakdown.map(
        ({ id: _id, operatorId: _operatorId, operatorName: _operatorName, ...row }) => ({
          ...row,
          id: [
            'self-payroll',
            row.shiftId,
            row.postId,
            ...(row.tariffOrderId === undefined ? [] : [row.tariffOrderId]),
            row.tariffRule,
            row.rateKopecksPerKg,
            row.materialClass ?? '',
            row.filmClass ?? '',
            row.specialCustomer ? 1 : 0,
          ]
            .map((part) => encodeURIComponent(String(part)))
            .join(':'),
        }),
      ),
      unresolved: preview.unresolved.map(({ operatorId: _id, operatorName: _name, ...row }) => row),
    };
  }
}
