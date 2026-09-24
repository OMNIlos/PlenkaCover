import { createHash, randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, type GatewayCommand, type GatewayEvent } from '@prisma/client';
import {
  GATEWAY_CAPABILITIES,
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  isGatewayHeartbeatV2,
  isPrinterPayload,
  type GatewayCapability,
  type GatewayCommandEnvelopeV2,
  type GatewayHeartbeatDeviceV2,
  type GatewayHeartbeatV2,
} from '@plenka/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { gatewayConnectionState } from '../../common/gateway-liveness';
import {
  gatewayCommandFingerprint,
  gatewayCommandIncident,
} from '../../common/operational-incidents/device-incident-signals';
import { GatewayIncidentReconciler } from '../../common/operational-incidents/gateway-incident-reconciler.service';
import { OperationalIncidentReporter } from '../../common/operational-incidents/operational-incident-reporter.service';
import { RUNTIME_CONFIG } from '../../common/runtime-config.module';
import type { RuntimeConfig } from '../../common/runtime-config';
import { reconcileFailedGatewayPrints } from '../../common/printing/gateway-print-failure-reconciliation';

export type GatewayCommandKind = 'read_scale' | 'print' | 'device_test' | 'device_recover';
export type GatewayResponder = (
  kind: GatewayCommandKind,
  payload: unknown,
) => Promise<Record<string, unknown>>;

export class GatewayCommandTimeoutError extends Error {
  constructor(
    readonly commandId: string,
    readonly outcome: 'expired' | 'delivery_unknown',
  ) {
    super(`gateway command ${commandId} timed out`);
    this.name = 'GatewayCommandTimeoutError';
  }
}

export interface IngestInput {
  eventId: string;
  kind: 'weight' | 'scan' | 'status' | 'heartbeat';
  payload?: Record<string, unknown>;
  rawPayload?: unknown;
}

interface ReconciledCommand {
  id: string;
  postId: string;
  kind: string;
  status: string;
}

type LegacyHeartbeatDevice = { deviceId?: string; status?: string };

type NormalizedHeartbeat = {
  compatibility: 'compatible' | 'upgrade_required' | 'unsupported';
  accepted: boolean;
  pollAllowed: boolean;
  protocolVersion: number | null;
  agent: GatewayHeartbeatV2['agent'] | null;
  capabilities: readonly GatewayCapability[];
  devices: readonly (LegacyHeartbeatDevice | GatewayHeartbeatDeviceV2)[];
  version: 'legacy' | 'v2' | 'unsupported';
};

export interface PolledGatewayCommand extends GatewayCommand {
  serverTime: Date;
  executionBudgetMs: number;
}

type PolledGatewayCommandV2 = PolledGatewayCommand & GatewayCommandEnvelopeV2;

type TimeoutStatus = 'expired' | 'delivery_unknown';
const RECOVERY_TERMINAL_STATUSES = ['done', 'failed', 'expired', 'delivery_unknown'] as const;
const RECOVERY_FAILURE_STATUSES = ['failed', 'expired', 'delivery_unknown'] as const;
const RECOVERY_REPAIR_BATCH_SIZE = 32;
// Gateway command timestamps are stored as UTC-naive PostgreSQL `timestamp` values. Always use
// the same UTC wall clock in raw SQL so a non-UTC database session cannot expire a fresh command.
const GATEWAY_UTC_CLOCK = Prisma.sql`(clock_timestamp() AT TIME ZONE 'UTC')`;

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

function resultFingerprint(result: unknown): string {
  return createHash('sha256').update(canonicalJson(result)).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isTerminal(status: string): boolean {
  return ['done', 'failed', 'expired', 'delivery_unknown'].includes(status);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function completionStatus(result: Record<string, unknown>): string {
  if (result.status === 'delivery_unknown') return 'delivery_unknown';
  return result.ok === false ? 'failed' : 'done';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validLegacyHeartbeatDevices(value: unknown): value is LegacyHeartbeatDevice[] {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every(
      (device) =>
        isRecord(device) &&
        (device.deviceId === undefined ||
          (typeof device.deviceId === 'string' &&
            device.deviceId.length > 0 &&
            device.deviceId.length <= 200)) &&
        (device.status === undefined ||
          (typeof device.status === 'string' &&
            ['ready', 'offline', 'unstable', 'misconfigured'].includes(device.status))),
    )
  );
}

function invalidHeartbeat(): never {
  throw new UnprocessableEntityException({
    code: 'GATEWAY_HEARTBEAT_INVALID',
    message: 'Gateway heartbeat does not match the supported bounded contract.',
  });
}

function normalizeHeartbeat(input: unknown): NormalizedHeartbeat {
  if (Array.isArray(input)) {
    if (!validLegacyHeartbeatDevices(input)) return invalidHeartbeat();
    return {
      compatibility: 'upgrade_required',
      accepted: true,
      pollAllowed: true,
      protocolVersion: null,
      agent: null,
      capabilities: [],
      devices: input,
      version: 'legacy',
    };
  }
  if (!isRecord(input)) return invalidHeartbeat();
  if (input.protocolVersion === undefined) {
    const devices = input.devices ?? [];
    if (!validLegacyHeartbeatDevices(devices)) return invalidHeartbeat();
    return {
      compatibility: 'upgrade_required',
      accepted: true,
      pollAllowed: true,
      protocolVersion: null,
      agent: null,
      capabilities: [],
      devices,
      version: 'legacy',
    };
  }
  if (
    typeof input.protocolVersion !== 'number' ||
    !Number.isInteger(input.protocolVersion) ||
    input.protocolVersion < 1 ||
    input.protocolVersion > 2_147_483_647
  ) {
    return invalidHeartbeat();
  }
  if (input.protocolVersion !== GATEWAY_PROTOCOL_VERSION) {
    const devices = input.devices ?? [];
    if (!validLegacyHeartbeatDevices(devices)) return invalidHeartbeat();
    return {
      compatibility: 'unsupported',
      accepted: false,
      pollAllowed: false,
      protocolVersion: input.protocolVersion,
      agent: null,
      capabilities: [],
      devices,
      version: 'unsupported',
    };
  }
  if (!isGatewayHeartbeatV2(input)) return invalidHeartbeat();
  return {
    compatibility: 'compatible',
    accepted: true,
    pollAllowed: true,
    protocolVersion: input.protocolVersion,
    agent: input.agent,
    capabilities: input.agent.capabilities,
    devices: input.devices,
    version: 'v2',
  };
}

function validCommandResult(kind: string, result: Record<string, unknown>): boolean {
  if (typeof result.ok !== 'boolean' || !isNonEmptyString(result.status)) return false;
  const status = result.status;
  if (kind === 'print') {
    return result.ok
      ? ['printed', 'submitted'].includes(status) && isNonEmptyString(result.jobId)
      : ['failed', 'delivery_unknown'].includes(status);
  }
  if (kind === 'read_scale') {
    return result.ok
      ? ['ready', 'offline', 'unstable'].includes(status) &&
          isNonEmptyString(result.deviceId) &&
          typeof result.stable === 'boolean' &&
          isFiniteNonNegative(result.grossKg)
      : ['failed', 'misconfigured'].includes(status);
  }
  if (kind === 'device_test') {
    return result.ok
      ? status === 'ready'
      : ['offline', 'unstable', 'misconfigured', 'failed'].includes(status);
  }
  if (kind === 'device_recover') {
    return result.ok
      ? status === 'recovering'
      : ['offline', 'misconfigured', 'failed'].includes(status);
  }
  return false;
}

function assertCommandResult(kind: string, result: Record<string, unknown>): void {
  if (!validCommandResult(kind, result)) {
    throw new UnprocessableEntityException({
      code: 'GATEWAY_RESULT_INVALID',
      message: 'Gateway command result does not match the command contract.',
    });
  }
}

function timeoutFact(kind: string, commandStatus: string, reasonCode: string) {
  const dispatched = commandStatus === 'in_flight';
  const unsafe = ['print', 'device_recover'].includes(kind);
  const status: TimeoutStatus = dispatched && unsafe ? 'delivery_unknown' : 'expired';
  return {
    status,
    result: {
      ok: false,
      status,
      reasonCode:
        !dispatched && unsafe ? 'gateway_command_not_dispatched_before_deadline' : reasonCode,
    },
  };
}

function commandEnvelopeV2(
  command: Pick<GatewayCommand, 'kind' | 'payload'>,
): GatewayCommandEnvelopeV2 | null {
  const payload = isRecord(command.payload) ? command.payload : {};

  if (
    command.kind === 'read_scale' &&
    isNonEmptyString(payload.deviceId) &&
    (payload.kind === 'spool' || payload.kind === 'roll')
  ) {
    return {
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      kind: 'scale.read.v1',
      payload: { deviceId: payload.deviceId, sample: payload.kind },
    };
  }

  if (command.kind === 'print' && isNonEmptyString(payload.printerId)) {
    const { printerId, ...label } = payload;
    if (!isPrinterPayload(label)) return null;
    const versionedLabel =
      label.kind === 'big_bag_label'
        ? {
            ...label,
            schemaVersion: 2 as const,
          }
        : { ...label, schemaVersion: 1 as const };
    return {
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      kind: 'label.print.v1',
      payload: {
        printerId,
        label: versionedLabel,
      },
    };
  }

  if (
    (command.kind === 'device_test' || command.kind === 'device_recover') &&
    isNonEmptyString(payload.deviceId) &&
    typeof payload.kind === 'string' &&
    ['scale', 'printer', 'scanner'].includes(payload.kind)
  ) {
    return {
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      kind: command.kind === 'device_test' ? 'device.test.v1' : 'device.recover.v1',
      payload: {
        deviceId: payload.deviceId,
        kind: payload.kind as 'scale' | 'printer' | 'scanner',
      },
    };
  }

  return null;
}

/**
 * Server side of the post↔platform gateway protocol (V2 S4, Variant B / model C1).
 *
 * The database is the command source of truth. The in-memory map only lets an HTTP business
 * request wait synchronously; results are still accepted after an API restart. Polling claims
 * rows atomically with opaque leases, while result fingerprints make acknowledgements
 * idempotent and detect divergent replays.
 */
@Injectable()
export class GatewayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GatewayService.name);
  private readonly pending = new Map<
    string,
    {
      resolve: (v: Record<string, unknown>) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
      postId: string;
    }
  >();
  private readonly responders = new Map<string, GatewayResponder>();
  private sweeper?: NodeJS.Timeout;
  private reconciliation?: Promise<void>;
  // Each process completes its own finite, idempotent pass. The fixed high-water mark prevents
  // an append-only tail from postponing wraparound, while process-local cursors cannot interfere.
  private recoveryRepairCursor?: string;
  private recoveryRepairUpperBound?: string;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
    private readonly incidents: OperationalIncidentReporter,
    private readonly gatewayIncidents: GatewayIncidentReconciler,
  ) {}

  onModuleInit(): void {
    const intervalMs = Math.max(500, Math.min(this.config.gatewayCommandTimeoutMs, 5_000));
    this.sweeper = setInterval(() => {
      this.scheduleReconciliation('gateway command reconciliation failed');
    }, intervalMs);
    this.sweeper.unref();
    this.scheduleReconciliation('initial gateway command reconciliation failed');
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
    await this.reconciliation;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('gateway service stopped'));
    }
    this.pending.clear();
  }

  private scheduleReconciliation(errorMessage: string): void {
    if (this.stopping || this.reconciliation) return;
    const reconciliation = this.reconcileExpiredCommands()
      .catch((error: unknown) => {
        this.logger.error(errorMessage, error);
      })
      .finally(() => {
        if (this.reconciliation === reconciliation) this.reconciliation = undefined;
      });
    this.reconciliation = reconciliation;
  }

  /** Register an in-process agent (simulator) that answers this post's commands synchronously. */
  registerResponder(postId: string, responder: GatewayResponder): void {
    this.responders.set(postId, responder);
  }

  unregisterResponder(postId: string): void {
    this.responders.delete(postId);
  }

  async dispatchCommand(
    postId: string,
    kind: GatewayCommandKind,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const id = randomUUID();
    const deadlineAt = new Date(Date.now() + this.config.gatewayCommandTimeoutMs);
    await this.prisma.gatewayCommand.create({
      data: {
        id,
        postId,
        kind,
        payload: payload as Prisma.InputJsonValue,
        status: 'queued',
        deadlineAt,
      },
    });

    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          void this.handlePendingTimeout(id, kind);
        },
        Math.max(0, deadlineAt.getTime() - Date.now()),
      );
      this.pending.set(id, { resolve, reject, timer, postId });
    });

    // Activation and an optional in-process simulator must never delay attachment to the
    // timeout promise. A hung simulator is subject to the same durable deadline as a real post.
    void this.activateCommand(id, postId).catch((error: unknown) => {
      this.rejectPending(
        id,
        error instanceof Error ? error : new Error('gateway activation failed'),
      );
    });
    return promise.then((result) => ({ ...result, gatewayCommandId: id }));
  }

  private async activateCommand(id: string, postId: string): Promise<void> {
    // A very fast remote agent can commit its result between CREATE and pending registration.
    const persisted = await this.prisma.gatewayCommand.findUnique({ where: { id } });
    if (persisted && isTerminal(persisted.status) && isRecord(persisted.result)) {
      this.resolvePending(id, persisted.result);
      return;
    }

    await this.activateNextSimulatorCommand(postId);
  }

  private async activateNextSimulatorCommand(postId: string): Promise<void> {
    const responder = this.responders.get(postId);
    if (!responder) return;
    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "posts"
        WHERE "id" = ${postId}
        FOR UPDATE
      `);
      const terminal = await this.reconcileWithClient(tx, postId);
      const active = await tx.gatewayCommand.findFirst({
        where: { postId, status: 'in_flight' },
        select: { id: true },
      });
      if (active) return { terminal };

      const candidate = await tx.gatewayCommand.findFirst({
        where: { postId, status: 'queued' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          postId: true,
          kind: true,
          payload: true,
          deadlineAt: true,
        },
      });
      if (!candidate || candidate.deadlineAt.getTime() <= Date.now()) return { terminal };
      if (!isRecord(candidate.payload)) {
        throw new Error(`gateway command ${candidate.id} has an invalid simulator payload`);
      }

      const leaseToken = randomUUID();
      const leaseExpiresAt =
        candidate.kind === 'print' || candidate.kind === 'device_recover'
          ? candidate.deadlineAt
          : new Date(Math.min(candidate.deadlineAt.getTime(), Date.now() + this.commandLeaseMs()));
      const claim = await tx.gatewayCommand.updateMany({
        where: { id: candidate.id, postId, status: 'queued' },
        data: {
          status: 'in_flight',
          leaseToken,
          leaseExpiresAt,
          attempt: { increment: 1 },
        },
      });
      return claim.count === 1
        ? {
            terminal,
            claim: {
              ...candidate,
              kind: candidate.kind as GatewayCommandKind,
              payload: candidate.payload,
              leaseToken,
            },
          }
        : { terminal };
    });
    await this.reportCommandOutcomes(outcome.terminal, [postId]);
    if (!outcome.claim) return;

    void this.executeResponder(
      outcome.claim.id,
      postId,
      outcome.claim.kind,
      outcome.claim.payload,
      outcome.claim.leaseToken,
      responder,
    );
  }

  private async executeResponder(
    id: string,
    postId: string,
    kind: GatewayCommandKind,
    payload: Record<string, unknown>,
    leaseToken: string,
    responder: GatewayResponder,
  ): Promise<void> {
    let result: Record<string, unknown>;
    try {
      result = await responder(kind, payload);
    } catch {
      result = { ok: false, status: 'failed', reasonCode: 'gateway_responder_failed' };
    }
    try {
      await this.resolveCommand(id, result, postId, leaseToken);
    } catch {
      // The durable timeout/result transaction is authoritative. A late simulator reply is
      // expected to lose that race and must never become an unhandled rejection.
      this.logger.warn(`late simulated gateway result rejected for command ${id}`);
    } finally {
      this.scheduleNextSimulatorCommand(postId);
    }
  }

  private scheduleNextSimulatorCommand(postId: string): void {
    void this.activateNextSimulatorCommand(postId).catch((error: unknown) => {
      this.logger.error(`failed to activate the next simulated command for post ${postId}`, error);
    });
  }

  /** Atomically claim queued commands. Concurrent polls cannot receive the same row. */
  async pollCommands(
    postId: string,
  ): Promise<Array<PolledGatewayCommand | PolledGatewayCommandV2>> {
    const agent = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { agentProtocolVersion: true, agentCompatibility: true },
    });
    if (!agent || agent.agentCompatibility === 'unsupported') return [];
    const useV2 =
      agent.agentProtocolVersion === GATEWAY_PROTOCOL_VERSION &&
      agent.agentCompatibility === 'compatible';

    const outcome = await this.prisma.$transaction(async (tx) => {
      // One durable Post is the serialization owner for its command stream. Without this row
      // lock, concurrent polls can skip a locked head and lease the queued tail as a second
      // physical command for the same post.
      await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "posts"
        WHERE "id" = ${postId}
        FOR UPDATE
      `);
      const terminal = await this.reconcileWithClient(tx, postId);
      const leaseMs = this.commandLeaseMs();
      const commands = await tx.$queryRaw<PolledGatewayCommand[]>(Prisma.sql`
        WITH candidates AS (
          SELECT "id"
          FROM "gateway_commands"
          WHERE "postId" = ${postId}
            AND "status" = 'queued'
            AND "deadlineAt" > ${GATEWAY_UTC_CLOCK}
            AND NOT EXISTS (
              SELECT 1
              FROM "gateway_commands" AS active
              WHERE active."postId" = ${postId}
                AND active."status" = 'in_flight'
            )
          ORDER BY "createdAt" ASC, "id" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE "gateway_commands" AS command
        SET "status" = 'in_flight',
            "leaseToken" = gen_random_uuid()::text,
            "leaseExpiresAt" = CASE
              WHEN command."kind" IN ('print', 'device_recover') THEN command."deadlineAt"
              ELSE LEAST(
                command."deadlineAt",
                ${GATEWAY_UTC_CLOCK} + (${leaseMs} * INTERVAL '1 millisecond')
              )
            END,
            "attempt" = command."attempt" + 1
        FROM candidates
        WHERE command."id" = candidates."id"
        RETURNING command.*,
                  ${GATEWAY_UTC_CLOCK} AS "serverTime",
                  GREATEST(
                    0,
                    FLOOR(
                      EXTRACT(EPOCH FROM (command."deadlineAt" - ${GATEWAY_UTC_CLOCK})) * 1000
                    )
                  )::integer AS "executionBudgetMs"
      `);
      return {
        commands: commands.sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
        ),
        terminal,
      };
    });
    await this.reportCommandOutcomes(outcome.terminal, [postId]);
    if (!useV2) return outcome.commands;
    return outcome.commands.map((command) => {
      const envelope = commandEnvelopeV2(command);
      return envelope
        ? ({ ...command, ...envelope } satisfies PolledGatewayCommandV2)
        : { ...command, protocolVersion: GATEWAY_PROTOCOL_VERSION };
    });
  }

  /** Persist one leased result. Exact retries dedupe; divergent or stale replies are 409. */
  async resolveCommand(
    commandId: string,
    result: Record<string, unknown>,
    byPostId: string,
    leaseToken: string,
  ): Promise<{ ok: true; deduped: boolean; recovered?: true; status: string }> {
    const fingerprint = resultFingerprint(result);
    const resolution = await this.prisma.$transaction(async (tx) => {
      let transition: ReconciledCommand | undefined;
      let command = await tx.gatewayCommand.findFirst({
        where: { id: commandId, postId: byPostId },
      });
      if (!command) return { outcome: 'missing' as const };
      assertCommandResult(command.kind, result);

      if (!isTerminal(command.status) && command.deadlineAt.getTime() <= Date.now()) {
        const terminal = timeoutFact(
          command.kind,
          command.status,
          'gateway_command_deadline_exceeded',
        );
        const update = await tx.gatewayCommand.updateMany({
          where: { id: commandId, postId: byPostId, status: { in: ['queued', 'in_flight'] } },
          data: {
            status: terminal.status,
            result: terminal.result as Prisma.InputJsonValue,
            resultFingerprint: resultFingerprint(terminal.result),
            leaseExpiresAt: null,
            resolvedAt: new Date(),
          },
        });
        if (update.count === 1) {
          await this.recordCompletion(tx, command, terminal.status, terminal.result.reasonCode);
          transition = {
            id: command.id,
            postId: command.postId,
            kind: command.kind,
            status: terminal.status,
          };
        }
        command = await tx.gatewayCommand.findUniqueOrThrow({ where: { id: commandId } });
      }

      if (isTerminal(command.status)) {
        if (command.leaseToken !== leaseToken) {
          return { outcome: 'lease_conflict' as const, transition };
        }
        const storedFingerprint =
          command.resultFingerprint ??
          (command.result === null ? null : resultFingerprint(command.result));
        if (storedFingerprint === fingerprint) {
          return {
            outcome: 'deduped' as const,
            status: command.status,
            result: command.result,
            command,
            transition,
          };
        }
        const canRecoverLateResult =
          command.status === 'delivery_unknown' &&
          isRecord(command.result) &&
          [
            'gateway_command_deadline_exceeded',
            'gateway_command_lease_abandoned_after_invocation',
          ].includes(String(command.result.reasonCode)) &&
          completionStatus(result) !== 'delivery_unknown';
        if (canRecoverLateResult) {
          const status = completionStatus(result);
          const update = await tx.gatewayCommand.updateMany({
            where: {
              id: commandId,
              postId: byPostId,
              status: 'delivery_unknown',
              leaseToken,
              resultFingerprint: command.resultFingerprint,
            },
            data: {
              status,
              result: result as Prisma.InputJsonValue,
              resultFingerprint: fingerprint,
              leaseExpiresAt: null,
              resolvedAt: new Date(),
            },
          });
          if (update.count === 1) {
            await this.audit.record(
              {
                type: 'gateway:command_recovered',
                actorRole: 'admin',
                objectId: command.id,
                oldValue: { status: 'delivery_unknown' },
                newValue: { status },
                detail: { postId: command.postId, kind: command.kind },
              },
              tx,
            );
            return {
              outcome: 'recovered' as const,
              status,
              transition: {
                id: command.id,
                postId: command.postId,
                kind: command.kind,
                status,
              },
            };
          }
          const current = await tx.gatewayCommand.findUnique({ where: { id: commandId } });
          const currentFingerprint =
            current?.resultFingerprint ??
            (current?.result === null || current?.result === undefined
              ? null
              : resultFingerprint(current.result));
          if (current?.leaseToken === leaseToken && currentFingerprint === fingerprint) {
            return {
              outcome: 'deduped' as const,
              status: current.status,
              result: current.result,
              command: current,
              transition,
            };
          }
        }
        return {
          outcome: 'result_conflict' as const,
          status: command.status,
          transition,
        };
      }

      if (
        command.status !== 'in_flight' ||
        !command.leaseToken ||
        command.leaseToken !== leaseToken
      ) {
        return { outcome: 'lease_conflict' as const, transition };
      }

      const status = completionStatus(result);
      const update = await tx.gatewayCommand.updateMany({
        where: {
          id: commandId,
          postId: byPostId,
          status: 'in_flight',
          leaseToken,
        },
        data: {
          status,
          result: result as Prisma.InputJsonValue,
          resultFingerprint: fingerprint,
          leaseExpiresAt: null,
          resolvedAt: new Date(),
        },
      });
      if (update.count !== 1) {
        const current = await tx.gatewayCommand.findUnique({ where: { id: commandId } });
        if (current && isTerminal(current.status)) {
          if (current.leaseToken !== leaseToken) {
            return { outcome: 'lease_conflict' as const, transition };
          }
          const storedFingerprint =
            current.resultFingerprint ??
            (current.result === null ? null : resultFingerprint(current.result));
          if (storedFingerprint === fingerprint) {
            return {
              outcome: 'deduped' as const,
              status: current.status,
              result: current.result,
              command: current,
              transition,
            };
          }
          return {
            outcome: 'result_conflict' as const,
            status: current.status,
            transition,
          };
        }
        return { outcome: 'lease_conflict' as const, transition };
      }
      await this.recordCompletion(tx, command, status);
      return {
        outcome: 'accepted' as const,
        status,
        command,
        transition: {
          id: command.id,
          postId: command.postId,
          kind: command.kind,
          status,
        },
      };
    });

    if ('transition' in resolution && resolution.transition) {
      await this.reportCommandOutcome(resolution.transition);
    }
    if (resolution.outcome === 'missing') {
      throw new NotFoundException('gateway command not found');
    }
    if (resolution.outcome === 'lease_conflict') {
      throw new ConflictException('gateway command lease is stale or invalid');
    }
    if (resolution.outcome === 'result_conflict') {
      await this.audit.record({
        type: 'gateway:command_result_conflict',
        actorRole: 'admin',
        objectId: commandId,
        detail: { postId: byPostId, terminalStatus: resolution.status },
      });
      throw new ConflictException('gateway command already has a different terminal result');
    }

    const pendingResult =
      resolution.outcome === 'deduped' && isRecord(resolution.result) ? resolution.result : result;
    this.resolvePending(commandId, pendingResult);
    return {
      ok: true,
      deduped: resolution.outcome === 'deduped',
      ...(resolution.outcome === 'recovered' ? { recovered: true as const } : {}),
      status: resolution.status,
    };
  }

  private commandLeaseMs(): number {
    return Math.max(100, Math.floor(this.config.gatewayCommandTimeoutMs * 0.6));
  }

  private async handlePendingTimeout(commandId: string, kind: GatewayCommandKind): Promise<void> {
    let timeoutStatus = timeoutFact(kind, 'in_flight', 'gateway_command_deadline_exceeded').status;
    let drainPostId: string | null = null;
    try {
      const outcome = await this.prisma.$transaction(async (tx) => {
        const command = await tx.gatewayCommand.findUnique({ where: { id: commandId } });
        if (!command) return { changed: false, result: null, command: null };
        if (isTerminal(command.status)) {
          return { changed: false, result: command.result, command };
        }
        const terminal = timeoutFact(
          command.kind,
          command.status,
          'gateway_command_deadline_exceeded',
        );
        timeoutStatus = terminal.status;
        const update = await tx.gatewayCommand.updateMany({
          where: { id: commandId, status: command.status },
          data: {
            status: terminal.status,
            result: terminal.result as Prisma.InputJsonValue,
            resultFingerprint: resultFingerprint(terminal.result),
            leaseExpiresAt: null,
            resolvedAt: new Date(),
          },
        });
        if (update.count === 1) {
          await this.recordCompletion(tx, command, terminal.status, terminal.result.reasonCode);
          return {
            changed: true,
            result: terminal.result,
            command: { ...command, status: terminal.status },
          };
        }
        const current = await tx.gatewayCommand.findUnique({ where: { id: commandId } });
        return { changed: false, result: current?.result ?? null, command: current };
      });
      if (outcome.command && isTerminal(outcome.command.status)) {
        drainPostId = outcome.command.postId;
      }
      if (outcome.changed && outcome.command && isTerminal(outcome.command.status)) {
        await this.reportCommandOutcome(outcome.command);
      }
      const persistedStatus = outcome.command?.status;
      const reconciledTimeout =
        !outcome.changed &&
        (persistedStatus === 'expired' || persistedStatus === 'delivery_unknown');
      if (reconciledTimeout) {
        timeoutStatus = persistedStatus;
      } else if (!outcome.changed && isRecord(outcome.result)) {
        this.resolvePending(commandId, outcome.result);
        if (drainPostId) this.scheduleNextSimulatorCommand(drainPostId);
        return;
      }
    } catch (error) {
      this.logger.error(`failed to terminalize gateway command ${commandId}`, error);
    }

    const entry = this.pending.get(commandId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(commandId);
    entry.reject(new GatewayCommandTimeoutError(commandId, timeoutStatus));
    if (drainPostId) this.scheduleNextSimulatorCommand(drainPostId);
  }

  private resolvePending(commandId: string, result: Record<string, unknown>): void {
    const entry = this.pending.get(commandId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(commandId);
    entry.resolve(result);
  }

  private discardPending(commandId: string): void {
    const entry = this.pending.get(commandId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(commandId);
  }

  private rejectPending(commandId: string, error: Error): void {
    const entry = this.pending.get(commandId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(commandId);
    entry.reject(error);
  }

  private async reconcileExpiredCommands(): Promise<void> {
    const terminal = await this.prisma.$transaction((tx) => this.reconcileWithClient(tx));
    const repairPostIds = await this.nextRecoveryRepairPostIds();
    await this.reportCommandOutcomes(terminal ?? [], repairPostIds);
    await reconcileFailedGatewayPrints(this.prisma, this.audit);
  }

  private async nextRecoveryRepairPostIds(): Promise<string[]> {
    if (!this.recoveryRepairUpperBound) {
      const highWater = await this.prisma.post.findFirst({
        orderBy: { id: 'desc' },
        select: { id: true },
      });
      if (!highWater) return [];
      this.recoveryRepairUpperBound = highWater.id;
      this.recoveryRepairCursor = undefined;
    }

    const upperBound = this.recoveryRepairUpperBound;
    const posts = await this.prisma.post.findMany({
      where: {
        id: {
          ...(this.recoveryRepairCursor ? { gt: this.recoveryRepairCursor } : {}),
          lte: upperBound,
        },
        commands: {
          some: {
            kind: 'device_recover',
            status: { in: [...RECOVERY_TERMINAL_STATUSES] },
          },
        },
      },
      orderBy: { id: 'asc' },
      select: { id: true },
      take: RECOVERY_REPAIR_BATCH_SIZE,
    });
    const lastPostId = posts.at(-1)?.id;
    if (posts.length < RECOVERY_REPAIR_BATCH_SIZE || !lastPostId || lastPostId === upperBound) {
      this.recoveryRepairCursor = undefined;
      this.recoveryRepairUpperBound = undefined;
    } else {
      this.recoveryRepairCursor = lastPostId;
    }
    return posts.map((post) => post.id);
  }

  private async reconcileWithClient(
    tx: Prisma.TransactionClient,
    postId?: string,
  ): Promise<ReconciledCommand[]> {
    const scope = postId ? Prisma.sql`AND "postId" = ${postId}` : Prisma.sql``;
    const deadlineUnsafeQueued = timeoutFact(
      'print',
      'queued',
      'gateway_command_deadline_exceeded',
    );
    const deadlineUnsafe = timeoutFact('print', 'in_flight', 'gateway_command_deadline_exceeded');
    const deadlineOther = timeoutFact(
      'read_scale',
      'in_flight',
      'gateway_command_deadline_exceeded',
    );
    const abandoned = timeoutFact(
      'print',
      'in_flight',
      'gateway_command_lease_abandoned_after_invocation',
    );

    const timedOutUnsafe = await tx.$queryRaw<ReconciledCommand[]>(Prisma.sql`
      UPDATE "gateway_commands"
      SET "status" = CASE
            WHEN "status" = 'queued' THEN ${deadlineUnsafeQueued.status}
            ELSE ${deadlineUnsafe.status}
          END,
          "result" = CASE
            WHEN "status" = 'queued'
              THEN CAST(${JSON.stringify(deadlineUnsafeQueued.result)} AS JSONB)
            ELSE CAST(${JSON.stringify(deadlineUnsafe.result)} AS JSONB)
          END,
          "resultFingerprint" = CASE
            WHEN "status" = 'queued' THEN ${resultFingerprint(deadlineUnsafeQueued.result)}
            ELSE ${resultFingerprint(deadlineUnsafe.result)}
          END,
          "leaseExpiresAt" = NULL,
          "resolvedAt" = ${GATEWAY_UTC_CLOCK}
      WHERE "status" IN ('queued', 'in_flight')
        AND "kind" IN ('print', 'device_recover')
        AND "deadlineAt" <= ${GATEWAY_UTC_CLOCK}
        ${scope}
      RETURNING "id", "postId", "kind", "status"
    `);
    const timedOutOther = await tx.$queryRaw<ReconciledCommand[]>(Prisma.sql`
      UPDATE "gateway_commands"
      SET "status" = ${deadlineOther.status},
          "result" = CAST(${JSON.stringify(deadlineOther.result)} AS JSONB),
          "resultFingerprint" = ${resultFingerprint(deadlineOther.result)},
          "leaseExpiresAt" = NULL,
          "resolvedAt" = ${GATEWAY_UTC_CLOCK}
      WHERE "status" IN ('queued', 'in_flight')
        AND "kind" NOT IN ('print', 'device_recover')
        AND "deadlineAt" <= ${GATEWAY_UTC_CLOCK}
        ${scope}
      RETURNING "id", "postId", "kind", "status"
    `);
    const abandonedUnsafe = await tx.$queryRaw<ReconciledCommand[]>(Prisma.sql`
      UPDATE "gateway_commands"
      SET "status" = ${abandoned.status},
          "result" = CAST(${JSON.stringify(abandoned.result)} AS JSONB),
          "resultFingerprint" = ${resultFingerprint(abandoned.result)},
          "leaseExpiresAt" = NULL,
          "resolvedAt" = ${GATEWAY_UTC_CLOCK}
      WHERE "status" = 'in_flight'
        AND "kind" IN ('print', 'device_recover')
        AND "leaseExpiresAt" <= ${GATEWAY_UTC_CLOCK}
        AND "deadlineAt" > ${GATEWAY_UTC_CLOCK}
        ${scope}
      RETURNING "id", "postId", "kind", "status"
    `);

    await tx.$executeRaw(Prisma.sql`
      UPDATE "gateway_commands"
      SET "status" = 'queued',
          "leaseToken" = NULL,
          "leaseExpiresAt" = NULL
      WHERE "status" = 'in_flight'
        AND "kind" IN ('read_scale', 'device_test')
        AND "leaseExpiresAt" <= ${GATEWAY_UTC_CLOCK}
        AND "deadlineAt" > ${GATEWAY_UTC_CLOCK}
        ${scope}
    `);

    for (const command of timedOutUnsafe) {
      await this.recordCompletion(
        tx,
        command,
        command.status,
        command.status === 'expired'
          ? 'gateway_command_not_dispatched_before_deadline'
          : 'gateway_command_deadline_exceeded',
      );
    }
    for (const command of timedOutOther) {
      await this.recordCompletion(tx, command, command.status, 'gateway_command_deadline_exceeded');
    }
    for (const command of abandonedUnsafe) {
      await this.recordCompletion(
        tx,
        command,
        command.status,
        'gateway_command_lease_abandoned_after_invocation',
      );
    }
    return [...timedOutUnsafe, ...timedOutOther, ...abandonedUnsafe];
  }

  private async reportCommandOutcomes(
    commands: ReconciledCommand[],
    repairPostIds: readonly string[] = [],
  ): Promise<void> {
    const postIds = new Set(repairPostIds);
    for (const command of commands) {
      if (command.kind === 'device_recover') postIds.add(command.postId);
    }
    await Promise.all([...postIds].map((postId) => this.reconcileRecoveryIncident(postId)));
  }

  private async reportCommandOutcome(
    command: Pick<GatewayCommand, 'postId' | 'kind'>,
  ): Promise<void> {
    if (command.kind !== 'device_recover') return;
    await this.reconcileRecoveryIncident(command.postId);
  }

  private async reconcileRecoveryIncident(postId: string): Promise<void> {
    const fingerprints = RECOVERY_FAILURE_STATUSES.map((failureClass) =>
      gatewayCommandFingerprint(postId, `device_recover_${failureClass}`),
    );
    await this.incidents.reconcileFingerprints(fingerprints, async (tx) => {
      const latest = await tx.gatewayCommand.findFirst({
        where: {
          postId,
          kind: 'device_recover',
          status: { in: [...RECOVERY_TERMINAL_STATUSES] },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { status: true },
      });
      if (!latest)
        return fingerprints.map((fingerprint) => ({ kind: 'noop' as const, fingerprint }));

      return RECOVERY_FAILURE_STATUSES.map((failureClass) => {
        const fingerprint = gatewayCommandFingerprint(postId, `device_recover_${failureClass}`);
        if (latest.status === failureClass) {
          return {
            kind: 'signal' as const,
            signal: gatewayCommandIncident(postId, `device_recover_${failureClass}`),
          };
        }
        return {
          kind: 'resolve' as const,
          fingerprint,
          reason:
            latest.status === 'done'
              ? 'Device recovery command completed.'
              : 'A newer device recovery outcome superseded this failure class.',
        };
      });
    });
  }

  private recordCompletion(
    tx: Prisma.TransactionClient,
    command: Pick<GatewayCommand, 'id' | 'postId' | 'kind'>,
    status: string,
    reasonCode?: string,
  ) {
    return this.audit.record(
      {
        type: 'gateway:command_completed',
        actorRole: 'admin',
        objectId: command.id,
        detail: {
          postId: command.postId,
          kind: command.kind,
          status,
          ...(reasonCode ? { reasonCode } : {}),
        },
      },
      tx,
    );
  }

  private assertEventReplayCompatible(existing: GatewayEvent, input: IngestInput): void {
    const compatible =
      existing.kind === input.kind &&
      canonicalJson(existing.payload ?? null) === canonicalJson(input.payload ?? null) &&
      canonicalJson(existing.rawPayload ?? null) === canonicalJson(input.rawPayload ?? null);
    if (!compatible) {
      throw new ConflictException({
        code: 'GATEWAY_EVENT_ID_CONFLICT',
        message: 'Gateway event id is already bound to different data.',
      });
    }
  }

  /** Unsolicited event from the agent — idempotent by eventId (offline buffer dedupe). */
  async ingest(postId: string, input: IngestInput) {
    let outcome: { deduped: boolean; event: GatewayEvent };
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        // Dedupe and every side effect share one commit. A retry after any failure can therefore
        // never observe a journal row whose device transition was lost.
        const existing = await tx.gatewayEvent.findUnique({
          where: { postId_eventId: { postId, eventId: input.eventId } },
        });
        if (existing) {
          this.assertEventReplayCompatible(existing, input);
          return { deduped: true as const, event: existing };
        }

        const event = await tx.gatewayEvent.create({
          data: {
            postId,
            eventId: input.eventId,
            kind: input.kind,
            payload: input.payload as never,
            rawPayload: input.rawPayload as never,
          },
        });
        const deviceId = input.payload?.deviceId as string | undefined;
        if (input.kind !== 'status' || !deviceId) {
          return { deduped: false as const, event };
        }

        const nextStatus = (input.payload?.status as string) ?? 'ready';
        const before = await tx.deviceRuntime.findFirst({
          where: {
            id: deviceId,
            postId,
            isEnabled: true,
            post: { status: 'active' },
          },
          select: { id: true, status: true },
        });
        // Scope to devices that belong to THIS post — an agent cannot tamper with another
        // post's device status/raw (security review: cross-tenant device tampering).
        const update = await tx.deviceRuntime.updateMany({
          where: {
            id: deviceId,
            postId,
            isEnabled: true,
            post: { status: 'active' },
          },
          data: {
            status: nextStatus,
            lastSeenAt: new Date(),
            rawPayload: input.rawPayload as never,
          },
        });
        if (before && update.count === 1 && before.status !== nextStatus) {
          await this.audit.record(
            {
              type: 'gateway:device_status_changed',
              actorRole: 'admin',
              objectId: deviceId,
              oldValue: { status: before.status },
              newValue: { status: nextStatus },
              detail: { postId },
            },
            tx,
          );
        }
        return { deduped: false as const, event };
      });
    } catch (error) {
      // Two concurrent first deliveries can both miss the pre-insert read. The unique key is the
      // linearization point; the loser becomes the same stable deduped acknowledgement.
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.prisma.gatewayEvent.findUnique({
        where: { postId_eventId: { postId, eventId: input.eventId } },
      });
      if (!existing) throw error;
      this.assertEventReplayCompatible(existing, input);
      outcome = { deduped: true as const, event: existing };
    }
    await this.reportIngestedDeviceStatus(postId, input);
    return outcome;
  }

  private async reportIngestedDeviceStatus(postId: string, input: IngestInput): Promise<void> {
    const deviceId = input.kind === 'status' ? input.payload?.deviceId : null;
    if (!isNonEmptyString(deviceId)) return;
    await this.reconcileGatewayIncidentSource(postId, [deviceId]);
  }

  /** Agent liveness + safe compatibility/device projection. Commissioning stays explicit. */
  async heartbeat(postId: string, input: unknown = []) {
    const heartbeat = normalizeHeartbeat(input);
    const now = new Date();
    const devices = heartbeat.devices;
    const deviceById = new Map(
      devices
        .filter((device): device is { deviceId: string; status?: string } => !!device.deviceId)
        .map((device) => [device.deviceId, device]),
    );
    const missingCapabilities = GATEWAY_CAPABILITIES.filter(
      (capability) => !heartbeat.capabilities.includes(capability),
    );
    const outcome = await this.prisma.$transaction(async (tx) => {
      const before = await tx.post.findUnique({
        where: { id: postId },
        select: {
          id: true,
          code: true,
          status: true,
          agentStatus: true,
          lastSeenAt: true,
          agentCompatibility: true,
        },
      });
      const previousConnectionState = before
        ? gatewayConnectionState(before.agentStatus, before.lastSeenAt, now)
        : 'offline';
      const post = await tx.post.update({
        where: { id: postId },
        data: {
          agentStatus: 'online',
          lastSeenAt: now,
          agentProtocolVersion: heartbeat.protocolVersion,
          agentPackageVersion: heartbeat.agent?.packageVersion ?? null,
          agentReleaseCommit: heartbeat.agent?.releaseCommit ?? null,
          agentBootId: heartbeat.agent?.bootId ?? null,
          agentStartedAt: heartbeat.agent ? new Date(heartbeat.agent.startedAt) : null,
          agentCapabilities: [...heartbeat.capabilities] as Prisma.InputJsonValue,
          agentCompatibility: heartbeat.compatibility,
        },
        select: {
          id: true,
          code: true,
          agentStatus: true,
          lastSeenAt: true,
        },
      });

      const existingDevices =
        deviceById.size === 0
          ? []
          : await tx.deviceRuntime.findMany({
              where: {
                postId,
                id: { in: [...deviceById.keys()] },
                isEnabled: true,
                post: { status: 'active' },
              },
              select: { id: true, kind: true, status: true },
            });
      const statusById = new Map(existingDevices.map((device) => [device.id, device.status]));
      const kindById = new Map(existingDevices.map((device) => [device.id, device.kind]));
      const includedDevices: Array<{ id: string; kind: string; status: string }> = [];
      for (const [deviceId, device] of deviceById) {
        const nextStatus = device.status ?? 'ready';
        const v2Device = heartbeat.version === 'v2' ? (device as GatewayHeartbeatDeviceV2) : null;
        const update = await tx.deviceRuntime.updateMany({
          where: {
            id: deviceId,
            postId,
            ...(v2Device ? { kind: v2Device.kind } : {}),
            isEnabled: true,
            post: { status: 'active' },
          },
          data: {
            status: nextStatus,
            lastSeenAt: now,
            ...(v2Device
              ? {
                  driverName: v2Device.driver,
                  driverVersion: v2Device.driverVersion,
                  configFingerprint: v2Device.configFingerprint,
                  lastProbeAt: v2Device.lastProbeAt ? new Date(v2Device.lastProbeAt) : null,
                }
              : {}),
          },
        });
        const previousStatus = statusById.get(deviceId);
        if (update.count === 1 && previousStatus !== undefined) {
          includedDevices.push({
            id: deviceId,
            kind: kindById.get(deviceId) ?? 'device',
            status: nextStatus,
          });
        }
        if (update.count === 1 && previousStatus !== undefined && previousStatus !== nextStatus) {
          await this.audit.record(
            {
              type: 'gateway:device_status_changed',
              actorRole: 'admin',
              objectId: deviceId,
              oldValue: { status: previousStatus },
              newValue: { status: nextStatus },
              detail: { postId },
            },
            tx,
          );
        }
      }
      if (previousConnectionState !== 'online') {
        await this.audit.record(
          {
            type: 'gateway:post_online',
            actorRole: 'admin',
            objectId: post.code,
            detail: { postId, devices: deviceById.size, previousConnectionState },
          },
          tx,
        );
      }
      if (before?.agentCompatibility && before.agentCompatibility !== heartbeat.compatibility) {
        await this.audit.record(
          {
            type: 'gateway:agent_compatibility_changed',
            actorRole: 'admin',
            objectId: post.code,
            oldValue: { compatibility: before.agentCompatibility },
            newValue: { compatibility: heartbeat.compatibility },
            detail: {
              postId,
              protocolVersion: heartbeat.protocolVersion,
              missingCapabilities,
            },
          },
          tx,
        );
      }
      return {
        response: {
          ok: true as const,
          postId: post.id,
          code: post.code,
          agentStatus: post.agentStatus,
          lastSeenAt: post.lastSeenAt,
          accepted: heartbeat.accepted,
          compatibility: heartbeat.compatibility,
          serverProtocolVersion: GATEWAY_PROTOCOL_VERSION,
          minimumProtocolVersion: GATEWAY_MIN_PROTOCOL_VERSION,
          pollAllowed: heartbeat.pollAllowed,
          missingCapabilities,
          serverTime: now.toISOString(),
        },
        includedDevices,
        incidentsEnabled: before?.status === 'active',
      };
    });
    if (!outcome.incidentsEnabled) return outcome.response;
    await this.reconcileGatewayIncidentSource(
      postId,
      outcome.includedDevices.map((device) => device.id),
      now,
    );
    return outcome.response;
  }

  private async reconcileGatewayIncidentSource(
    postId: string,
    deviceIds: readonly string[],
    now?: Date,
  ): Promise<void> {
    try {
      if (now) await this.gatewayIncidents.reconcilePost(postId, deviceIds, now);
      else await this.gatewayIncidents.reconcilePost(postId, deviceIds);
    } catch {
      // The durable gateway status/heartbeat transaction is authoritative. Projection failures
      // are repaired by the periodic source reconciler and never turn the acknowledgement into 5xx.
      this.logger.error('Gateway source incident reconciliation failed.');
    }
  }
}
