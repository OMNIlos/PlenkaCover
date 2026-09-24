import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { RuntimeConfig } from '../../common/runtime-config';
import { RUNTIME_CONFIG } from '../../common/runtime-config.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OneCSyncService } from './onec-sync.service';

function isExpectedOverlap(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('getResponse' in error)) return false;
  const getResponse = (error as { getResponse?: unknown }).getResponse;
  if (typeof getResponse !== 'function') return false;
  const response = getResponse.call(error);
  return (
    typeof response === 'object' &&
    response !== null &&
    'code' in response &&
    response.code === 'ONEC_SYNC_IN_PROGRESS'
  );
}

@Injectable()
export class OneCSyncScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OneCSyncScheduler.name);
  private readonly pending = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(RUNTIME_CONFIG)
    private readonly config: Pick<RuntimeConfig, 'onecSyncEnabled' | 'onecSyncIntervalMs'>,
    private readonly sync: OneCSyncService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    if (!this.config.onecSyncEnabled) return;
    this.timer = setInterval(() => {
      const operation = this.runNow().finally(() => this.pending.delete(operation));
      this.pending.add(operation);
    }, this.config.onecSyncIntervalMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await Promise.allSettled(this.pending);
  }

  async runNow(): Promise<void> {
    try {
      const initialApply = await this.prisma.oneCSyncRun.findFirst({
        where: { mode: 'apply', status: 'completed' },
        select: { id: true },
        orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      });
      if (!initialApply) return;
      await this.sync.run({ userId: null, role: 'admin' }, 'scheduled');
    } catch (error) {
      if (isExpectedOverlap(error)) return;
      this.logger.error('Scheduled 1С synchronization failed.');
    }
  }
}
