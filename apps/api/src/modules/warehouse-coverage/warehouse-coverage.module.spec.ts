import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { AuditModule } from '../../common/audit/audit.module';
import { OrderFulfillmentModule } from '../../common/order-fulfillment/order-fulfillment.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AdminModule } from '../admin/admin.module';
import { OperatorModule } from '../operator/operator.module';
import {
  COVERAGE_TERMINAL_CONFLICT_HOOK,
  WarehouseCoverageTransaction,
} from './warehouse-coverage-transaction';
import { WarehouseCoverageConflictCounter } from './warehouse-coverage-conflict-counter';
import { WarehouseCoverageMetricsService } from './warehouse-coverage-metrics.service';
import { WarehouseCoverageCommandService } from './warehouse-coverage-command.service';
import { WarehouseCoverageProjectionService } from './warehouse-coverage-projection.service';
import { WarehouseCoverageModule } from './warehouse-coverage.module';
import { WarehouseRollCoverageFactService } from './warehouse-roll-coverage-fact.service';
import { WarehouseCoverageCalculationService } from './warehouse-coverage-calculation.service';
import { WarehouseCoverageProductionHandoffService } from './warehouse-coverage-production-handoff.service';
import { WarehouseCoverageDecisionService } from './warehouse-coverage-decision.service';
import { WarehouseCoverageRecheckService } from './warehouse-coverage-recheck.service';
import { WarehouseCoverageReservationRecoveryService } from './warehouse-coverage-reservation-recovery.service';
import { WarehouseCoverageOrderChangeService } from './warehouse-coverage-order-change.service';
import { CommercialModule } from '../commercial/commercial.module';
import { FinanceModule } from '../finance/finance.module';
import { WarehouseModule } from '../warehouse/warehouse.module';
import { WarehouseCoverageRecheckController } from '../warehouse/warehouse-coverage-recheck.controller';
import { ProductionModule } from '../production/production.module';

function metadata<T>(target: object, key: string): T[] {
  return (Reflect.getMetadata(key, target) ?? []) as T[];
}

describe('WarehouseCoverageModule', () => {
  it('wires one private counter and one admin-facing metrics export', async () => {
    expect(metadata(WarehouseCoverageModule, MODULE_METADATA.IMPORTS)).toEqual([
      PrismaModule,
      AuditModule,
      OrderFulfillmentModule,
    ]);
    expect(metadata(WarehouseCoverageModule, MODULE_METADATA.PROVIDERS)).toEqual([
      WarehouseRollCoverageFactService,
      WarehouseCoverageCommandService,
      WarehouseCoverageTransaction,
      WarehouseCoverageProjectionService,
      WarehouseCoverageCalculationService,
      WarehouseCoverageProductionHandoffService,
      WarehouseCoverageDecisionService,
      WarehouseCoverageRecheckService,
      WarehouseCoverageReservationRecoveryService,
      WarehouseCoverageOrderChangeService,
      WarehouseCoverageConflictCounter,
      {
        provide: COVERAGE_TERMINAL_CONFLICT_HOOK,
        useExisting: WarehouseCoverageConflictCounter,
      },
      WarehouseCoverageMetricsService,
    ]);
    expect(metadata(WarehouseCoverageModule, MODULE_METADATA.EXPORTS)).toEqual([
      WarehouseRollCoverageFactService,
      WarehouseCoverageCommandService,
      WarehouseCoverageTransaction,
      WarehouseCoverageProjectionService,
      WarehouseCoverageCalculationService,
      WarehouseCoverageProductionHandoffService,
      WarehouseCoverageDecisionService,
      WarehouseCoverageRecheckService,
      WarehouseCoverageReservationRecoveryService,
      WarehouseCoverageOrderChangeService,
      WarehouseCoverageMetricsService,
    ]);
    expect(metadata(AdminModule, MODULE_METADATA.IMPORTS)).toContain(WarehouseCoverageModule);
    expect(metadata(AdminModule, MODULE_METADATA.PROVIDERS)).not.toContain(
      WarehouseCoverageConflictCounter,
    );
    expect(metadata(OperatorModule, MODULE_METADATA.IMPORTS)).toContain(WarehouseCoverageModule);
    expect(metadata(CommercialModule, MODULE_METADATA.IMPORTS)).toContain(WarehouseCoverageModule);
    expect(metadata(FinanceModule, MODULE_METADATA.IMPORTS)).toContain(WarehouseCoverageModule);
    expect(metadata(WarehouseModule, MODULE_METADATA.IMPORTS)).toContain(WarehouseCoverageModule);
    expect(metadata(ProductionModule, MODULE_METADATA.IMPORTS)).toContain(WarehouseCoverageModule);
    expect(metadata(WarehouseModule, MODULE_METADATA.CONTROLLERS)).toContain(
      WarehouseCoverageRecheckController,
    );
    expect(metadata(OperatorModule, MODULE_METADATA.PROVIDERS)).not.toContain(
      WarehouseRollCoverageFactService,
    );

    const graph = await compileAdminGraph();
    const coverageGraph = graph.select(WarehouseCoverageModule);
    const counter = coverageGraph.get(WarehouseCoverageConflictCounter, { strict: true });
    expect(coverageGraph.get(COVERAGE_TERMINAL_CONFLICT_HOOK, { strict: true })).toBe(counter);
    expect(
      (
        coverageGraph.get(WarehouseCoverageTransaction, { strict: true }) as unknown as {
          terminalConflictHook: unknown;
        }
      ).terminalConflictHook,
    ).toBe(counter);
    expect(
      (
        coverageGraph.get(WarehouseCoverageMetricsService, { strict: true }) as unknown as {
          conflicts: unknown;
        }
      ).conflicts,
    ).toBe(counter);
    await graph.close();
  });

  it('publishes a terminal transaction conflict through that same counter', async () => {
    const graph = await compileAdminGraph();
    const coverageGraph = graph.select(WarehouseCoverageModule);
    const transaction = coverageGraph.get(WarehouseCoverageTransaction, { strict: true });

    await expect(
      transaction.run(jest.fn(), {
        sleep: jest.fn().mockResolvedValue(undefined),
        random: jest.fn().mockReturnValue(0),
      }),
    ).rejects.toMatchObject({
      response: { code: 'warehouse_coverage_concurrent_state_conflict' },
    });
    await expect(
      coverageGraph.get(WarehouseCoverageMetricsService, { strict: true }).snapshot(),
    ).resolves.toMatchObject({
      processConflicts: {
        total: 1,
        byCode: expect.objectContaining({ '40P01': 1 }),
      },
    });
    await graph.close();
  });
});

async function compileAdminGraph() {
  const terminalConflict = Object.assign(new Error('deadlock'), { code: '40P01' });
  const prisma = {
    $transaction: jest.fn().mockRejectedValue(terminalConflict),
    warehouseCoverageState: { groupBy: jest.fn().mockResolvedValue([]) },
    warehouseCoverageCalculation: { groupBy: jest.fn().mockResolvedValue([]) },
    orderResolutionCase: { groupBy: jest.fn().mockResolvedValue([]) },
  };
  return Test.createTestingModule({ imports: [AdminModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();
}
