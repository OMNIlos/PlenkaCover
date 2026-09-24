import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { OneCHealthResult, OperationalActor } from '@plenka/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { gatewayHeartbeatIsFresh, gatewayStaleAfterSec } from '../../common/gateway-liveness';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ONEC_ADAPTER, type OneCAdapter } from '../../integrations/onec/onec.adapter';
import { AdminDevicesService } from './admin-devices.service';
import { AdminOneCService } from './admin-onec.service';
import type { OperationalIncidentQueryDto } from './dto/platform-health.dto';
import { OperationalChecksService } from './operational-checks.service';
import { OperationalIncidentsService } from '../../common/operational-incidents/operational-incidents.service';
import { WarehouseCoverageMetricsService } from '../warehouse-coverage/warehouse-coverage-metrics.service';

type ComponentStatus = 'ready' | 'degraded' | 'unavailable';

interface ComponentResult {
  status: ComponentStatus;
  latencyMs: number;
  summary: Record<string, unknown>;
}

@Injectable()
export class PlatformHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(ONEC_ADAPTER) private readonly onec: OneCAdapter,
    private readonly checks: OperationalChecksService,
    private readonly incidents: OperationalIncidentsService,
    private readonly adminOneC: AdminOneCService,
    private readonly devices: AdminDevicesService,
    private readonly warehouseCoverage: WarehouseCoverageMetricsService,
  ) {}

  async snapshot() {
    const [lastCheck, incidents, warehouseCoverage] = await Promise.all([
      this.prisma.operationalCheck.findFirst({
        where: { scope: 'platform', targetType: 'aggregate' },
        orderBy: { completedAt: 'desc' },
      }),
      this.incidents.list({ status: 'open' }),
      this.warehouseCoverage.snapshot(),
    ]);
    if (!lastCheck) {
      return {
        status: 'unknown' as const,
        lastCheck,
        incidents,
        warehouseCoverage,
      };
    }
    const summary = isRecord(lastCheck.summary) ? lastCheck.summary : {};
    return {
      ...summary,
      status: isComponentStatus(summary.status)
        ? summary.status
        : this.aggregateStatus(lastCheck.status),
      checkedAt: lastCheck.completedAt.toISOString(),
      lastCheck,
      incidents,
      warehouseCoverage,
    };
  }

  async check(actor: OperationalActor) {
    const startedAt = new Date();
    const [database, onec, gateway, background, warehouseCoverage] = await Promise.all([
      this.databaseComponent(),
      this.oneCComponent(),
      this.gatewayComponent(),
      this.backgroundComponent(),
      this.warehouseCoverage.snapshot(),
    ]);
    const components = { database, onec, gateway, background };
    const status: ComponentStatus =
      database.status === 'unavailable'
        ? 'unavailable'
        : Object.values(components).some((component) => component.status !== 'ready')
          ? 'degraded'
          : 'ready';
    const completedAt = new Date();
    const serializedComponents = {
      database: this.serializeComponent(database),
      onec: this.serializeComponent(onec),
      gateway: this.serializeComponent(gateway),
      background: this.serializeComponent(background),
    };
    const response = {
      status,
      service: 'plenka-api',
      version: process.env.npm_package_version ?? '0.0.1',
      uptimeSec: Math.floor(process.uptime()),
      checkedAt: completedAt.toISOString(),
      components: serializedComponents,
      warehouseCoverage,
    };

    await Promise.allSettled([
      ...Object.entries(components).map(([targetType, component]) =>
        this.checks.record({
          scope: 'platform',
          targetType,
          status:
            component.status === 'ready'
              ? 'passed'
              : component.status === 'degraded'
                ? 'degraded'
                : 'failed',
          summary: component.summary,
          actorId: actor.userId,
          startedAt,
          completedAt,
        }),
      ),
      this.checks.record({
        scope: 'platform',
        targetType: 'aggregate',
        status: status === 'ready' ? 'passed' : status === 'degraded' ? 'degraded' : 'failed',
        summary: response,
        actorId: actor.userId,
        startedAt,
        completedAt,
      }),
    ]);

    await this.reconcileIncidents(actor, components);
    try {
      await this.audit.record({
        type: 'admin.platform.check_requested',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: 'platform',
        detail: { status },
      });
    } catch (error) {
      if (database.status !== 'unavailable') throw error;
    }

    return response;
  }

  listIncidents(query: OperationalIncidentQueryDto) {
    return this.incidents.list(query);
  }

  acknowledgeIncident(actor: OperationalActor, incidentId: string, reason: string) {
    return this.incidents.acknowledge(actor, incidentId, reason);
  }

  resolveIncident(actor: OperationalActor, incidentId: string, reason: string) {
    return this.incidents.resolve(actor, incidentId, reason);
  }

  async recheckIncident(actor: OperationalActor, incidentId: string) {
    const incident = await this.prisma.operationalIncident.findUnique({
      where: { id: incidentId },
    });
    if (!incident) throw new NotFoundException(`Operational incident ${incidentId} not found`);
    if (incident.scope === 'onec') return this.adminOneC.check(actor);
    if (incident.scope === 'device' && incident.targetId) {
      return this.devices.test(actor, incident.targetId);
    }
    return this.check(actor);
  }

  private async databaseComponent(): Promise<ComponentResult> {
    const startedAt = Date.now();
    try {
      await this.prisma.$queryRaw(Prisma.sql`SELECT 1`);
      return { status: 'ready', latencyMs: Date.now() - startedAt, summary: { query: 'ok' } };
    } catch {
      return {
        status: 'unavailable',
        latencyMs: Date.now() - startedAt,
        summary: { errorCategory: 'connection', message: 'Database check failed.' },
      };
    }
  }

  private async oneCComponent(): Promise<ComponentResult> {
    const startedAt = Date.now();
    let result: OneCHealthResult;
    try {
      result = await this.onec.checkHealth();
    } catch {
      result = {
        mode: 'http',
        status: 'unavailable',
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        errorCategory: 'network',
        message: '1С connection check failed.',
      };
    }
    return {
      status: result.status,
      latencyMs: result.latencyMs,
      summary: {
        mode: result.mode,
        checkedAt: result.checkedAt,
        endpointLabel: result.endpointLabel ?? null,
        errorCategory: result.errorCategory ?? null,
        message: result.message ?? null,
      },
    };
  }

  private async gatewayComponent(): Promise<ComponentResult> {
    const startedAt = Date.now();
    try {
      const posts = await this.prisma.post.findMany({
        where: { status: 'active' },
        select: { id: true, agentStatus: true, lastSeenAt: true },
      });
      const thresholdSec = gatewayStaleAfterSec();
      const now = new Date();
      const fresh = posts.filter(
        (post) => post.agentStatus === 'online' && gatewayHeartbeatIsFresh(post.lastSeenAt, now),
      ).length;
      const stale = posts.length - fresh;
      return {
        status: posts.length > 0 && stale === 0 ? 'ready' : 'degraded',
        latencyMs: Date.now() - startedAt,
        summary: { activePosts: posts.length, freshPosts: fresh, stalePosts: stale, thresholdSec },
      };
    } catch {
      return {
        status: 'unavailable',
        latencyMs: Date.now() - startedAt,
        summary: { errorCategory: 'database', message: 'Gateway state check failed.' },
      };
    }
  }

  private async backgroundComponent(): Promise<ComponentResult> {
    const startedAt = Date.now();
    const agedBefore = new Date(Date.now() - 5 * 60 * 1000);
    try {
      const [agedCommands, sourceErrors] = await Promise.all([
        this.prisma.gatewayCommand.count({
          where: { status: { in: ['queued', 'in_flight'] }, createdAt: { lt: agedBefore } },
        }),
        this.prisma.syncJournal.count({
          where: {
            OR: [
              { status: { in: ['error', 'manual_review'] } },
              { status: 'waiting', updatedAt: { lt: agedBefore } },
            ],
          },
        }),
      ]);
      return {
        status: agedCommands + sourceErrors === 0 ? 'ready' : 'degraded',
        latencyMs: Date.now() - startedAt,
        summary: { agedCommands, sourceErrors, agedAfterSec: 300 },
      };
    } catch {
      return {
        status: 'unavailable',
        latencyMs: Date.now() - startedAt,
        summary: { errorCategory: 'database', message: 'Background work check failed.' },
      };
    }
  }

  private async reconcileIncidents(
    actor: OperationalActor,
    components: Record<string, ComponentResult>,
  ) {
    await Promise.allSettled(
      Object.entries(components).map(async ([component, result]) => {
        const fingerprint = component === 'onec' ? 'onec:connection' : `platform:${component}`;
        if (result.status === 'ready') {
          await this.incidents.resolveByFingerprint(
            actor,
            fingerprint,
            'Platform component verification passed.',
          );
          return;
        }
        await this.incidents.signal({
          fingerprint,
          scope: component === 'onec' ? 'onec' : 'platform',
          targetType: component,
          severity: result.status === 'unavailable' ? 'critical' : 'warning',
          title: `Проблема компонента: ${component}`,
          message: String(result.summary.message ?? `${component} is degraded.`),
          recovery: 'Проверить компонент и повторить platform health check.',
        });
      }),
    );
  }

  private serializeComponent(component: ComponentResult) {
    return {
      status: component.status,
      latencyMs: component.latencyMs,
      ...component.summary,
    };
  }

  private aggregateStatus(status: string): ComponentStatus {
    if (status === 'passed') return 'ready';
    if (status === 'degraded') return 'degraded';
    return 'unavailable';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isComponentStatus(value: unknown): value is ComponentStatus {
  return value === 'ready' || value === 'degraded' || value === 'unavailable';
}
