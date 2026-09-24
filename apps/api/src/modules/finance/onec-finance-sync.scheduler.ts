import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { RuntimeConfig } from '../../common/runtime-config';
import { RUNTIME_CONFIG } from '../../common/runtime-config.module';
import type { OneCFinanceActor } from './onec-finance-actor';
import { OneCInvoiceSyncService } from './onec-invoice-sync.service';
import { OneCPaymentSyncService } from './onec-payment-sync.service';

const AUTOMATION_ACTOR: OneCFinanceActor = {
  userId: null,
  role: 'finance',
};

@Injectable()
export class OneCFinanceSyncScheduler implements OnModuleDestroy {
  private readonly logger = new Logger(OneCFinanceSyncScheduler.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly invoiceSync: OneCInvoiceSyncService,
    private readonly paymentSync: OneCPaymentSyncService,
    @Inject(RUNTIME_CONFIG)
    private readonly config: Pick<
      RuntimeConfig,
      'onecFinanceSyncEnabled' | 'onecPaymentSyncEnabled' | 'onecFinanceSyncIntervalMs'
    >,
  ) {}

  isEnabled(): boolean {
    return this.config.onecFinanceSyncEnabled || this.config.onecPaymentSyncEnabled;
  }

  start(): void {
    if (!this.isEnabled() || this.timer) return;
    this.runInBackground();
    this.timer = setInterval(() => {
      this.runInBackground();
    }, this.config.onecFinanceSyncIntervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private runInBackground(): void {
    void this.runOnce().catch(() => {
      this.logger.error('1C finance background sync failed.');
    });
  }

  async runOnce() {
    if (!this.isEnabled() || this.running) {
      return { skipped: true, reason: this.running ? 'overlap' : 'disabled' };
    }
    this.running = true;
    try {
      let invoicesAttempted = 0;
      let invoiceFailures = 0;
      if (this.config.onecFinanceSyncEnabled) {
        const orders = await this.prisma.financeOrder.findMany({
          where: {
            commercialOrder: { sentToFinanceAt: { not: null } },
          },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
        });
        invoicesAttempted = orders.length;
        const outcomes = await Promise.allSettled(
          orders.map((order) =>
            this.invoiceSync.refresh(AUTOMATION_ACTOR, order.id, {
              operationKey: randomUUID(),
            }),
          ),
        );
        invoiceFailures = outcomes.filter((outcome) => outcome.status === 'rejected').length;
      }

      let paymentFailure = false;
      if (this.config.onecPaymentSyncEnabled) {
        try {
          await this.paymentSync.sync(AUTOMATION_ACTOR, { operationKey: randomUUID() });
        } catch {
          paymentFailure = true;
        }
      }
      return {
        skipped: false,
        invoicesAttempted,
        invoiceFailures,
        paymentsAttempted: this.config.onecPaymentSyncEnabled ? 1 : 0,
        paymentFailures: paymentFailure ? 1 : 0,
      };
    } finally {
      this.running = false;
    }
  }
}
