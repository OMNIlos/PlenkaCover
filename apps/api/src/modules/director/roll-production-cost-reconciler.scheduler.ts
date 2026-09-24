import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { RuntimeConfig } from '../../common/runtime-config';
import { RUNTIME_CONFIG } from '../../common/runtime-config.module';
import {
  RollProductionCostSnapshotReconciler,
  RollProductionCostSnapshotService,
} from './roll-production-cost-snapshot.service';

type ReconcilerConfig = Pick<
  RuntimeConfig,
  | 'productionCostReconcilerEnabled'
  | 'productionCostReconcilerIntervalMs'
  | 'productionCostReconcilerBatchSize'
>;

@Injectable()
export class RollProductionCostReconcilerScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RollProductionCostReconcilerScheduler.name);
  private readonly reconciler: RollProductionCostSnapshotReconciler;
  private readonly pending = new Set<Promise<unknown>>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    snapshots: RollProductionCostSnapshotService,
    @Inject(RUNTIME_CONFIG) private readonly config: ReconcilerConfig,
  ) {
    this.reconciler = new RollProductionCostSnapshotReconciler(
      snapshots,
      config.productionCostReconcilerBatchSize,
    );
  }

  onModuleInit(): void {
    if (!this.config.productionCostReconcilerEnabled || this.timer) return;
    this.timer = setInterval(
      () => this.runInBackground(),
      this.config.productionCostReconcilerIntervalMs,
    );
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await Promise.allSettled(this.pending);
  }

  runNow(generatedAt = new Date()) {
    if (!this.config.productionCostReconcilerEnabled) {
      return Promise.resolve({ skipped: true as const, reason: 'disabled' as const });
    }
    return this.reconciler.reconcileNow(generatedAt);
  }

  private runInBackground(): void {
    const operation = this.runNow()
      .catch(() => {
        this.logger.error('Production-cost snapshot reconciliation failed.');
      })
      .finally(() => this.pending.delete(operation));
    this.pending.add(operation);
  }
}
