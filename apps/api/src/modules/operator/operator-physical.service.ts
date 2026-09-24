import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { OperatorRollReweighResult, OperatorWeightProjection } from '@plenka/contracts';
import { AuditService } from '../../common/audit/audit.service';
import type { ReadinessCode } from '../../common/device-readiness/post-device-readiness.service';
import {
  bindingIncident,
  bindingIncidentFingerprint,
  deviceConnectionFingerprint,
  deviceConnectionIncident,
  gatewayCommandIncident,
  type PhysicalDeviceKind,
} from '../../common/operational-incidents/device-incident-signals';
import { OperationalIncidentReporter } from '../../common/operational-incidents/operational-incident-reporter.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RollTokenService } from '../../common/roll-token/roll-token.service';
import { resolveCanonicalRollCaptureEvidence } from '../../common/weight-capture/canonical-roll-capture';
import {
  normalizePrintDeliveryUnknownReason,
  PRINTER_ADAPTER,
  type PrinterAdapter,
} from '../../integrations/printer/printer.adapter';
import { SCALE_ADAPTER, type ScaleAdapter } from '../../integrations/scale/scale.adapter';
import { projectCounterparty } from '../commercial/projection';
import { WarehouseRollCoverageFactService } from '../warehouse-coverage/warehouse-roll-coverage-fact.service';
import { WarehouseSpoolStockService } from '../warehouse/warehouse-spool-stock.service';
import type { RecordDefectDto } from './dto/defect.dto';
import type { DeferRollDto } from './dto/defer.dto';
import type { OperatorOperationDto } from './dto/operation.dto';
import type { QrPrintDto, QrVerifyAndHandoverDto, QrVerifyDto } from './dto/qr.dto';
import type { WeightCaptureDto } from './dto/weight.dto';
import type { ReweighRollDto } from './dto/reweigh.dto';
import { OperatorDeviceBindingService } from './operator-device-binding.service';
import { OperatorOperationService } from './operator-operation.service';
import type { OperatorActor } from './operator.service';
import { OperatorRollOwnershipService } from './operator-roll-ownership.service';
import { resolveSpoolPolicy } from './operator-spool-policy';
import {
  assertOperatorRollMutable,
  assertOperatorRollReweighTransition,
  assertOperatorRollTransition,
} from './operator-roll-state';

const TOLERANCE = 0.05;
const WEIGHED_DEFECT_AUDIT_REASON = 'Брак зафиксирован взвешиванием';

type ClaimedPhysicalOperation = {
  operationId: string;
  leaseToken: string;
  deviceId: string;
  sessionId: string;
  postId: string;
  lineId: string;
  predecessor: string;
  recoveryFromId: string | null;
};

type BindingFailureCode =
  | 'OPERATOR_DEVICE_BINDING_UNAVAILABLE'
  | 'OPERATOR_DEVICE_NOT_READY'
  | Exclude<ReadinessCode, 'READY'>;

type ExpiredPhysicalClaimInput = {
  operationKey: string;
  action: 'spool_weight' | 'roll_weight' | 'roll_reweigh' | 'defect' | 'qr_print';
  fingerprintInput: unknown | ((expectedStep: string, requestFingerprint: string) => unknown);
};

const EXPIRED_PHYSICAL_OPERATION_SELECT = {
  id: true,
  action: true,
  actorId: true,
  requestFingerprint: true,
  status: true,
  leaseToken: true,
  leaseExpiresAt: true,
  expectedStep: true,
  deviceId: true,
  postId: true,
  postSessionId: true,
  operatorRollLineId: true,
  line: { select: { rollDispatchItem: { select: { rollCode: true } } } },
  labelPrintJob: { select: { id: true } },
} satisfies Prisma.OperatorRollOperationSelect;

type ExpiredPhysicalOperation = Prisma.OperatorRollOperationGetPayload<{
  select: typeof EXPIRED_PHYSICAL_OPERATION_SELECT;
}>;

const REWEIGH_CAPTURE_SELECT = {
  id: true,
  operatorRollLineId: true,
  kind: true,
  stable: true,
  grossKg: true,
  netKg: true,
  toleranceOk: true,
  supersedesCaptureId: true,
  createdAt: true,
} as const satisfies Prisma.WeightCaptureSelect;

type ReweighCapture = Prisma.WeightCaptureGetPayload<{ select: typeof REWEIGH_CAPTURE_SELECT }>;

type ReweighEligibility = {
  capture: ReweighCapture;
  resultStep: 'qr_print' | 'handover';
  reason:
    | 'operator_requested_before_qr_print'
    | 'operator_recovered_invalid_weight_before_handover';
};

type DispatchCompletionFact = {
  id: string;
  rollCode: string;
  status: string;
  replacesDispatchItemId: string | null;
};

function canonicalDispatchLeaves(
  rows: readonly DispatchCompletionFact[],
): DispatchCompletionFact[] | null {
  const current = rows.filter((row) => row.status !== 'cancelled');
  if (current.length === 0) return null;
  const byId = new Map(current.map((row) => [row.id, row]));
  const childByParent = new Map<string, DispatchCompletionFact>();
  for (const row of current) {
    if (!row.replacesDispatchItemId) continue;
    if (!byId.has(row.replacesDispatchItemId) || childByParent.has(row.replacesDispatchItemId)) {
      return null;
    }
    childByParent.set(row.replacesDispatchItemId, row);
  }

  const roots = current
    .filter((row) => row.replacesDispatchItemId === null)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (roots.length === 0) return null;
  const visited = new Set<string>();
  const leaves: DispatchCompletionFact[] = [];
  for (const root of roots) {
    let cursor = root;
    while (true) {
      if (visited.has(cursor.id)) return null;
      visited.add(cursor.id);
      const child = childByParent.get(cursor.id);
      if (!child) {
        leaves.push(cursor);
        break;
      }
      cursor = child;
    }
  }
  return visited.size === current.length ? leaves : null;
}

@Injectable()
export class OperatorPhysicalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ownership: OperatorRollOwnershipService,
    private readonly bindings: OperatorDeviceBindingService,
    private readonly operations: OperatorOperationService,
    private readonly tokens: RollTokenService,
    private readonly coverageFacts: WarehouseRollCoverageFactService,
    private readonly spoolStock: WarehouseSpoolStockService,
    @Inject(SCALE_ADAPTER) private readonly scale: ScaleAdapter,
    @Inject(PRINTER_ADAPTER) private readonly printer: PrinterAdapter,
    private readonly incidents: OperationalIncidentReporter,
  ) {}

  async accept(actor: OperatorActor, rollCode: string, dto: OperatorOperationDto) {
    const actorId = this.requireActorId(actor);
    const outcome = await this.transaction(async (tx) => {
      const { session, line } = await this.ownership.lockOwned(tx, actor, rollCode);
      const claim = await this.operations.claim(tx, {
        operationKey: dto.operationKey,
        action: 'accept',
        actorId,
        operatorRollLineId: line.id,
        postId: session.postId,
        postSessionId: session.id,
        expectedStep: line.step,
        fingerprintInput: {},
      });
      if (claim.kind === 'replay') return 'replay' as const;
      assertOperatorRollMutable('accept', line);
      const resultStep = assertOperatorRollTransition('accept', line.step);
      await tx.operatorRollLine.update({ where: { id: line.id }, data: { step: resultStep } });
      await this.audit.record(
        {
          type: 'audit:operator_roll_accepted',
          actorRole: actor.role,
          actorId,
          objectId: rollCode,
          oldValue: { step: line.step },
          newValue: { step: resultStep },
          detail: {
            operationId: claim.operation.id,
            postId: session.postId,
            sessionId: session.id,
          },
        },
        tx,
      );
      await this.operations.complete(tx, claim.operation.id, { resultStep, httpStatus: 200 });
      return 'completed' as const;
    });
    void outcome;
    return this.getLine(rollCode);
  }

  async captureSpoolWeight(actor: OperatorActor, rollCode: string, dto: WeightCaptureDto) {
    const standardApplied = await this.captureStandardSpoolWeight(actor, rollCode, dto);
    if (standardApplied) return this.getLine(rollCode);
    return this.captureWeight(actor, rollCode, dto, 'spool_weight', 'spool');
  }

  captureRollWeight(actor: OperatorActor, rollCode: string, dto: WeightCaptureDto) {
    return this.captureWeight(actor, rollCode, dto, 'roll_weight', 'roll');
  }

  async reweighRoll(
    actor: OperatorActor,
    rollCode: string,
    dto: ReweighRollDto,
  ): Promise<OperatorRollReweighResult> {
    const actorId = this.requireActorId(actor);
    const pendingClaim = this.transaction(async (tx) => {
      const { session, line } = await this.ownership.lockOwned(tx, actor, rollCode);
      const operation = await this.operations.claim(tx, {
        operationKey: dto.operationKey,
        action: 'roll_reweigh',
        actorId,
        operatorRollLineId: line.id,
        postId: session.postId,
        postSessionId: session.id,
        deviceId: null,
        expectedStep: line.step,
        fingerprintInput: {},
      });
      if (operation.kind === 'replay') {
        return {
          kind: 'replay' as const,
          result: await this.replayReweigh(
            tx,
            line.id,
            rollCode,
            operation.operation.resultRef,
            operation.operation.resultStep,
          ),
        };
      }
      const leaseToken = this.physicalLeaseToken(operation.operation);
      const eligibility = await this.assertReweighAllowed(tx, line);
      let device: Awaited<ReturnType<OperatorDeviceBindingService['resolve']>>;
      try {
        device = await this.bindings.resolve(session.postId, 'scale', tx);
      } catch (error) {
        const errorCode = this.bindingFailureCode(error);
        if (!errorCode) throw error;
        await this.operations.fail(
          tx,
          operation.operation.id,
          { httpStatus: 503, errorCode },
          leaseToken,
        );
        await this.audit.record(
          {
            type: 'device.scale.offline',
            actorRole: actor.role,
            actorId,
            objectId: rollCode,
            detail: {
              operationId: operation.operation.id,
              postId: session.postId,
              sessionId: session.id,
              reasonCode: errorCode,
            },
          },
          tx,
        );
        return {
          kind: 'binding_failure' as const,
          errorCode,
          postId: session.postId,
          deviceId: this.exceptionDeviceId(error),
        };
      }
      await this.operations.bindDevice(tx, operation.operation.id, device.id, leaseToken);
      return {
        kind: 'claimed' as const,
        operationId: operation.operation.id,
        leaseToken,
        deviceId: device.id,
        sessionId: session.id,
        postId: session.postId,
        lineId: line.id,
        predecessor: eligibility.resultStep,
        recoveryFromId: operation.recoveryFromId,
      };
    });
    const claim = await this.claimWithExpiredSettlement(
      actor,
      rollCode,
      {
        operationKey: dto.operationKey,
        action: 'roll_reweigh',
        fingerprintInput: {},
      },
      pendingClaim,
    );
    if (claim.kind === 'replay') return claim.result;
    if (claim.kind === 'binding_failure') {
      await this.reportUnavailableBinding(claim.postId, 'scale', claim.deviceId);
      throw this.deviceBindingUnavailable(claim.errorCode);
    }
    await this.reportBindingReady(claim.postId, 'scale');

    let reading: Awaited<ReturnType<ScaleAdapter['read']>>;
    try {
      reading = await this.scale.read(
        {
          deviceId: claim.deviceId,
          expectedPostId: claim.postId,
          expectedKind: 'scale',
        },
        'roll',
      );
    } catch {
      await this.failScale(actor, rollCode, claim, 'error');
      throw this.scaleUnavailable();
    }
    if (reading.status !== 'ready' || !reading.stable) {
      await this.failScale(actor, rollCode, claim, reading.status);
      throw this.scaleUnavailable();
    }

    try {
      const result = await this.transaction(async (tx) => {
        const { session, line } = await this.ownership.lockOwned(tx, actor, rollCode);
        await this.operations.assertCurrentLease(tx, claim.operationId, claim.leaseToken);
        if (session.id !== claim.sessionId || line.id !== claim.lineId) {
          throw new ConflictException({
            code: 'OPERATOR_PHYSICAL_FINALIZATION_CONFLICT',
            message: 'Сессия поста изменилась до фиксации результата.',
          });
        }
        const finalDevice = await this.bindings.resolve(session.postId, 'scale', tx);
        if (finalDevice.id !== claim.deviceId) {
          throw new ConflictException({
            code: 'OPERATOR_DEVICE_BINDING_CHANGED',
            message: 'Привязка весов поста изменилась до фиксации результата.',
          });
        }
        const eligibility = await this.assertReweighAllowed(tx, line);
        const previous = eligibility.capture;
        const spoolKg = line.spoolKg;
        if (spoolKg == null) throw this.reweighWeightRequired();
        const resultStep = eligibility.resultStep;
        const currentWeight = this.validatedRollWeightProjection(
          reading.grossKg,
          spoolKg,
          line.planKg,
        );
        const previousWeight = this.captureProjection(previous);
        const capture = await tx.weightCapture.create({
          data: {
            operatorRollLineId: line.id,
            operationId: claim.operationId,
            kind: 'roll',
            deviceId: claim.deviceId,
            deviceStatus: reading.status,
            stable: reading.stable,
            grossKg: currentWeight.grossKg,
            spoolKg,
            netKg: currentWeight.netKg,
            toleranceOk: currentWeight.toleranceOk,
            actorRole: actor.role,
            actorId,
            postId: session.postId,
            postSessionId: session.id,
            supersedesCaptureId: previous.id,
          },
        });
        await tx.operatorRollLine.update({
          where: { id: line.id },
          data: {
            grossKg: currentWeight.grossKg,
            netKg: currentWeight.netKg,
            toleranceOk: currentWeight.toleranceOk,
          },
        });
        await this.operations.complete(
          tx,
          claim.operationId,
          {
            resultStep,
            resultRef: capture.id,
            httpStatus: 200,
          },
          claim.leaseToken,
        );
        await this.audit.record(
          {
            type: 'audit:operator_roll_reweighed',
            actorRole: actor.role,
            actorId,
            objectId: rollCode,
            reason: eligibility.reason,
            oldValue: previousWeight,
            newValue: currentWeight,
            detail: {
              operationId: claim.operationId,
              previousEvidenceId: previous.id,
              evidenceId: capture.id,
              deviceId: claim.deviceId,
              postId: session.postId,
              sessionId: session.id,
            },
          },
          tx,
        );
        await this.auditRecovery(tx, actor, rollCode, claim, capture.id);
        return { rollCode, step: resultStep, previousWeight, currentWeight };
      });
      await this.reportDeviceReady(claim.deviceId);
      return result;
    } catch (error) {
      await this.failWeightFinalization(actor, rollCode, claim, 'roll', error);
      throw error;
    }
  }

  async verifyQr(actor: OperatorActor, rollCode: string, dto: QrVerifyDto) {
    const actorId = this.requireActorId(actor);
    const outcome = await this.transaction(async (tx) => {
      const { session, line } = await this.ownership.lockOwned(tx, actor, rollCode);
      const label = await this.tokens.findExact(dto.payload, tx);
      const matches = label?.rollCode === rollCode;
      const claim = await this.operations.claim(tx, {
        operationKey: dto.operationKey,
        action: 'qr_verify',
        actorId,
        operatorRollLineId: line.id,
        postId: session.postId,
        postSessionId: session.id,
        expectedStep: line.step,
        fingerprintInput: { matches },
      });
      if (claim.kind === 'replay') return { kind: 'replay' as const };
      assertOperatorRollMutable('qr_verify', line);
      assertOperatorRollTransition('qr_verify', line.step);
      const leaseToken = this.physicalLeaseToken(claim.operation);
      let device: Awaited<ReturnType<OperatorDeviceBindingService['resolve']>>;
      try {
        device = await this.bindings.resolve(session.postId, 'scanner', tx);
      } catch (error) {
        const errorCode = this.bindingFailureCode(error);
        if (!errorCode) throw error;
        await this.operations.fail(
          tx,
          claim.operation.id,
          { httpStatus: 503, errorCode },
          leaseToken,
        );
        await this.audit.record(
          {
            type: 'device.scan.offline',
            actorRole: actor.role,
            actorId,
            objectId: rollCode,
            detail: {
              operationId: claim.operation.id,
              postId: session.postId,
              sessionId: session.id,
              reasonCode: errorCode,
            },
          },
          tx,
        );
        return {
          kind: 'binding_failure' as const,
          code: errorCode,
          postId: session.postId,
          deviceId: this.exceptionDeviceId(error),
        };
      }
      await this.operations.bindDevice(tx, claim.operation.id, device.id, leaseToken);
      if (!matches) {
        await this.operations.fail(
          tx,
          claim.operation.id,
          {
            httpStatus: 400,
            errorCode: 'OPERATOR_QR_MISMATCH',
          },
          leaseToken,
        );
        await this.audit.record(
          {
            type: 'device.scan.mismatch',
            actorRole: actor.role,
            actorId,
            objectId: rollCode,
            detail: {
              operationId: claim.operation.id,
              deviceId: device.id,
              postId: session.postId,
              sessionId: session.id,
              reasonCode: 'exact_bytes_mismatch',
            },
          },
          tx,
        );
        return {
          kind: 'mismatch' as const,
          deviceId: device.id,
          postId: session.postId,
        };
      }
      const resultStep = assertOperatorRollTransition('qr_verify', line.step);
      await tx.operatorRollLine.update({
        where: { id: line.id },
        data: { labelState: 'verified', step: resultStep },
      });
      await this.operations.complete(
        tx,
        claim.operation.id,
        { resultStep, httpStatus: 200 },
        leaseToken,
      );
      await this.audit.record(
        {
          type: 'audit:operator_qr_verified',
          actorRole: actor.role,
          actorId,
          objectId: rollCode,
          oldValue: { step: line.step },
          newValue: { step: resultStep, labelState: 'verified' },
          detail: {
            operationId: claim.operation.id,
            deviceId: device.id,
            postId: session.postId,
            sessionId: session.id,
          },
        },
        tx,
      );
      if (claim.recoveryFromId) {
        await this.audit.record(
          {
            type: 'audit:operator_physical_operation_recovered',
            actorRole: actor.role,
            actorId,
            objectId: rollCode,
            detail: {
              operationId: claim.operation.id,
              recoveredOperationId: claim.recoveryFromId,
              deviceId: device.id,
              postId: session.postId,
              sessionId: session.id,
            },
          },
          tx,
        );
      }
      return {
        kind: 'completed' as const,
        deviceId: device.id,
        postId: session.postId,
      };
    });
    if (outcome.kind === 'binding_failure') {
      await this.reportUnavailableBinding(outcome.postId, 'scanner', outcome.deviceId);
      throw this.deviceBindingUnavailable(outcome.code);
    }
    if (outcome.kind !== 'replay') {
      await Promise.all([
        this.reportBindingReady(outcome.postId, 'scanner'),
        this.reportDeviceReady(outcome.deviceId),
      ]);
    }
    if (outcome.kind === 'mismatch') {
      throw new BadRequestException({
        code: 'OPERATOR_QR_MISMATCH',
        message: 'Отсканированная метка не совпадает с напечатанной.',
      });
    }
    return this.getLine(rollCode);
  }

  async verifyQrAndHandover(actor: OperatorActor, rollCode: string, dto: QrVerifyAndHandoverDto) {
    if (dto.operationKey === dto.handoverOperationKey) {
      throw new BadRequestException({
        code: 'OPERATOR_OPERATION_KEYS_MUST_DIFFER',
        message: 'Проверка QR и передача требуют разных ключей операции.',
      });
    }
    const verified = await this.verifyQr(actor, rollCode, dto);
    if (verified.step === 'warehouse') return verified;
    return this.handover(actor, rollCode, { operationKey: dto.handoverOperationKey });
  }

  private async captureStandardSpoolWeight(
    actor: OperatorActor,
    rollCode: string,
    dto: WeightCaptureDto,
  ): Promise<boolean> {
    const candidate = await this.prisma.operatorRollLine.findFirst({
      where: { rollDispatchItem: { rollCode } },
      select: { rollDispatchItem: { select: { characteristicsSnapshot: true } } },
    });
    const candidatePolicy = resolveSpoolPolicy({
      spoolType: this.snapshotString(
        candidate?.rollDispatchItem.characteristicsSnapshot ?? null,
        'spoolType',
      ),
    });
    if (candidatePolicy.mode !== 'standard_700g') return false;

    const actorId = this.requireActorId(actor);
    const claim = this.transaction(async (tx) => {
      const { session, line } = await this.ownership.lockOwned(tx, actor, rollCode);
      const policy = resolveSpoolPolicy({
        spoolType: this.snapshotString(line.rollDispatchItem.characteristicsSnapshot, 'spoolType'),
      });
      if (policy.mode !== 'standard_700g') return false;

      const operation = await this.operations.claim(tx, {
        operationKey: dto.operationKey,
        action: 'spool_weight',
        actorId,
        operatorRollLineId: line.id,
        postId: session.postId,
        postSessionId: session.id,
        deviceId: null,
        expectedStep: line.step,
        fingerprintInput: { kind: 'spool' },
      });
      if (operation.kind === 'replay') return true;

      assertOperatorRollMutable('spool_weight', line);
      const resultStep = assertOperatorRollTransition('spool_weight', line.step);
      const leaseToken = this.physicalLeaseToken(operation.operation);
      const capture = await tx.weightCapture.create({
        data: {
          operatorRollLineId: line.id,
          operationId: operation.operation.id,
          kind: 'spool',
          deviceId: null,
          deviceStatus: 'standard',
          stable: true,
          grossKg: policy.kg,
          spoolKg: policy.kg,
          netKg: null,
          toleranceOk: null,
          actorRole: actor.role,
          actorId,
          postId: session.postId,
          postSessionId: session.id,
        },
      });
      await tx.operatorRollLine.update({
        where: { id: line.id },
        data: { spoolKg: policy.kg, step: resultStep },
      });
      await this.operations.complete(
        tx,
        operation.operation.id,
        {
          resultStep,
          resultRef: capture.id,
          httpStatus: 200,
        },
        leaseToken,
      );
      await this.audit.record(
        {
          type: 'audit:operator_weight_captured',
          actorRole: actor.role,
          actorId,
          objectId: rollCode,
          oldValue: { step: line.step },
          newValue: { step: resultStep, spoolKg: policy.kg },
          detail: {
            operationId: operation.operation.id,
            evidenceId: capture.id,
            deviceId: null,
            kind: 'spool',
            postId: session.postId,
            sessionId: session.id,
            weightSource: 'standard_700g',
          },
        },
        tx,
      );
      if (operation.recoveryFromId) {
        await this.audit.record(
          {
            type: 'audit:operator_physical_operation_recovered',
            actorRole: actor.role,
            actorId,
            objectId: rollCode,
            detail: {
              operationId: operation.operation.id,
              recoveredOperationId: operation.recoveryFromId,
              evidenceId: capture.id,
              postId: session.postId,
              sessionId: session.id,
            },
          },
          tx,
        );
      }
      return true;
    });
    return this.claimWithExpiredSettlement(
      actor,
      rollCode,
      {
        operationKey: dto.operationKey,
        action: 'spool_weight',
        fingerprintInput: { kind: 'spool' },
      },
      claim,
    );
  }

  private async captureWeight(
    actor: OperatorActor,
    rollCode: string,
    dto: WeightCaptureDto,
    action: 'spool_weight' | 'roll_weight',
    kind: 'spool' | 'roll',
  ) {
    const actorId = this.requireActorId(actor);
    const claim = await this.claimDeviceOperation(actor, rollCode, dto.operationKey, action, kind);
    if (claim === 'replay') return this.getLine(rollCode);
    if ('bindingFailure' in claim) {
      await this.reportUnavailableBinding(claim.postId, 'scale', claim.deviceId);
      throw this.deviceBindingUnavailable(claim.bindingFailure);
    }
    await this.reportBindingReady(claim.postId, 'scale');

    let reading: Awaited<ReturnType<ScaleAdapter['read']>>;
    try {
      reading = await this.scale.read(
        {
          deviceId: claim.deviceId,
          expectedPostId: claim.postId,
          expectedKind: 'scale',
        },
        kind,
      );
    } catch {
      await this.failScale(actor, rollCode, claim, 'error');
      throw this.scaleUnavailable();
    }
    if (reading.status !== 'ready' || !reading.stable) {
      await this.failScale(actor, rollCode, claim, reading.status);
      throw this.scaleUnavailable();
    }

    try {
      await this.transaction(async (tx) => {
        const { session, line } = await this.ownership.lockOwned(tx, actor, rollCode);
        await this.operations.assertCurrentLease(tx, claim.operationId, claim.leaseToken);
        if (session.id !== claim.sessionId || line.id !== claim.lineId) {
          throw new ConflictException({
            code: 'OPERATOR_PHYSICAL_FINALIZATION_CONFLICT',
            message: 'Сессия поста изменилась до фиксации результата.',
          });
        }
        assertOperatorRollMutable(action, line);
        const resultStep = assertOperatorRollTransition(action, line.step);
        const spoolKg = line.spoolKg;
        let rollWeight: OperatorWeightProjection | null = null;
        if (kind === 'roll') {
          if (spoolKg == null) {
            throw new ConflictException({
              code: 'OPERATOR_STEP_CONFLICT',
              message: 'Сначала зафиксируйте вес шпули.',
            });
          }
          rollWeight = this.validatedRollWeightProjection(reading.grossKg, spoolKg, line.planKg);
        }
        const previousRollCapture =
          kind === 'roll' ? await this.correctionRollCapture(tx, line.id) : null;
        const netKg = rollWeight?.netKg ?? null;
        const toleranceOk = rollWeight?.toleranceOk ?? null;
        const capture = await tx.weightCapture.create({
          data: {
            operatorRollLineId: line.id,
            operationId: claim.operationId,
            kind,
            deviceId: claim.deviceId,
            deviceStatus: reading.status,
            stable: reading.stable,
            grossKg: rollWeight?.grossKg ?? reading.grossKg,
            spoolKg: kind === 'spool' ? reading.grossKg : spoolKg,
            netKg,
            toleranceOk,
            actorRole: actor.role,
            actorId,
            postId: session.postId,
            postSessionId: session.id,
            ...(previousRollCapture ? { supersedesCaptureId: previousRollCapture.id } : {}),
          },
        });
        await tx.operatorRollLine.update({
          where: { id: line.id },
          data:
            kind === 'spool'
              ? { spoolKg: reading.grossKg, step: resultStep }
              : {
                  grossKg: rollWeight?.grossKg ?? reading.grossKg,
                  netKg,
                  toleranceOk,
                  step: resultStep,
                },
        });
        await this.operations.complete(
          tx,
          claim.operationId,
          {
            resultStep,
            resultRef: capture.id,
            httpStatus: 200,
          },
          claim.leaseToken,
        );
        if (previousRollCapture && rollWeight) {
          await this.audit.record(
            {
              type: 'audit:operator_roll_reweighed',
              actorRole: actor.role,
              actorId,
              objectId: rollCode,
              reason: 'operator_reopened_previous_step',
              oldValue: this.captureProjection(previousRollCapture),
              newValue: rollWeight,
              detail: {
                operationId: claim.operationId,
                previousEvidenceId: previousRollCapture.id,
                evidenceId: capture.id,
                deviceId: claim.deviceId,
                postId: session.postId,
                sessionId: session.id,
              },
            },
            tx,
          );
        } else {
          await this.audit.record(
            {
              type: 'audit:operator_weight_captured',
              actorRole: actor.role,
              actorId,
              objectId: rollCode,
              oldValue: { step: line.step },
              newValue: { step: resultStep },
              detail: {
                operationId: claim.operationId,
                evidenceId: capture.id,
                deviceId: claim.deviceId,
                kind,
                postId: session.postId,
                sessionId: session.id,
              },
            },
            tx,
          );
        }
        await this.auditRecovery(tx, actor, rollCode, claim, capture.id);
      });
    } catch (error) {
      await this.failWeightFinalization(actor, rollCode, claim, kind, error);
      throw error;
    }
    await this.reportDeviceReady(claim.deviceId);
    return this.getLine(rollCode);
  }

  private async claimDeviceOperation(
    actor: OperatorActor,
    rollCode: string,
    operationKey: string,
    action: 'spool_weight' | 'roll_weight',
    kind: 'spool' | 'roll',
  ): Promise<
    | ClaimedPhysicalOperation
    | { bindingFailure: BindingFailureCode; postId: string; deviceId: string | null }
    | 'replay'
  > {
    const actorId = this.requireActorId(actor);
    const pendingClaim = this.transaction(async (tx) => {
      const { session, line } = await this.ownership.lockOwned(tx, actor, rollCode);
      const existing = await tx.operatorRollOperation.findUnique({
        where: { operationKey },
        select: { deviceId: true },
      });
      const claim = await this.operations.claim(tx, {
        operationKey,
        action,
        actorId,
        operatorRollLineId: line.id,
        postId: session.postId,
        postSessionId: session.id,
        deviceId: existing?.deviceId ?? null,
        expectedStep: line.step,
        fingerprintInput: { kind },
      });
      if (claim.kind === 'replay') return 'replay' as const;
      assertOperatorRollMutable(action, line);
      assertOperatorRollTransition(action, line.step);
      const leaseToken = this.physicalLeaseToken(claim.operation);
      let device: Awaited<ReturnType<OperatorDeviceBindingService['resolve']>>;
      try {
        device = await this.bindings.resolve(session.postId, 'scale', tx);
      } catch (error) {
        const errorCode = this.bindingFailureCode(error);
        if (!errorCode) throw error;
        await this.operations.fail(
          tx,
          claim.operation.id,
          { httpStatus: 503, errorCode },
          leaseToken,
        );
        await this.audit.record(
          {
            type: 'device.scale.offline',
            actorRole: actor.role,
            actorId,
            objectId: rollCode,
            detail: {
              operationId: claim.operation.id,
              postId: session.postId,
              sessionId: session.id,
              reasonCode: errorCode,
            },
          },
          tx,
        );
        return {
          bindingFailure: errorCode,
          postId: session.postId,
          deviceId: this.exceptionDeviceId(error),
        };
      }
      await this.operations.bindDevice(tx, claim.operation.id, device.id, leaseToken);
      return {
        operationId: claim.operation.id,
        leaseToken,
        deviceId: device.id,
        sessionId: session.id,
        postId: session.postId,
        lineId: line.id,
        predecessor: line.step,
        recoveryFromId: claim.recoveryFromId,
      };
    });
    return this.claimWithExpiredSettlement(
      actor,
      rollCode,
      { operationKey, action, fingerprintInput: { kind } },
      pendingClaim,
    );
  }

  private async failScale(
    actor: OperatorActor,
    rollCode: string,
    claim: ClaimedPhysicalOperation,
    status: string,
  ) {
    await this.transaction(async (tx) => {
      await this.operations.fail(
        tx,
        claim.operationId,
        {
          httpStatus: 503,
          errorCode: 'OPERATOR_SCALE_UNAVAILABLE',
        },
        claim.leaseToken,
      );
      await this.audit.record(
        {
          type: 'device.scale.offline',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: rollCode,
          detail: {
            operationId: claim.operationId,
            deviceId: claim.deviceId,
            kind: claim.predecessor === 'spool_weight' ? 'spool' : 'roll',
            postId: claim.postId,
            sessionId: claim.sessionId,
            status: this.safeDeviceStatus(status),
          },
        },
        tx,
      );
    });
    await this.reportDeviceFailure(claim.deviceId, 'scale');
  }

  private async failDefectWeightNotAboveSpool(claim: ClaimedPhysicalOperation) {
    await this.transaction((tx) =>
      this.operations.fail(
        tx,
        claim.operationId,
        {
          httpStatus: 409,
          errorCode: 'OPERATOR_DEFECT_WEIGHT_NOT_ABOVE_SPOOL',
        },
        claim.leaseToken,
      ),
    );
    await this.reportDeviceReady(claim.deviceId);
  }

  private async failWeightFinalization(
    actor: OperatorActor,
    rollCode: string,
    claim: ClaimedPhysicalOperation,
    kind: 'spool' | 'roll',
    error: unknown,
  ) {
    const failure = this.finalizationFailure(error);
    await this.transaction(async (tx) => {
      const operation = await tx.operatorRollOperation.findFirst({
        where: {
          id: claim.operationId,
          status: 'in_progress',
          leaseToken: claim.leaseToken,
          leaseExpiresAt: { gt: new Date() },
        },
        select: { id: true },
      });
      if (!operation) return;
      await this.operations.fail(tx, operation.id, failure, claim.leaseToken);
      await this.audit.record(
        {
          type: 'audit:operator_weight_capture_failed',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: rollCode,
          detail: {
            operationId: operation.id,
            deviceId: claim.deviceId,
            kind,
            postId: claim.postId,
            sessionId: claim.sessionId,
            reasonCode: failure.errorCode,
          },
        },
        tx,
      );
    });
  }

  private finalizationFailure(error: unknown): { httpStatus: number; errorCode: string } {
    const fallback = {
      httpStatus: 503,
      errorCode: 'OPERATOR_WEIGHT_FINALIZATION_FAILED',
    };
    if (!(error instanceof HttpException)) return fallback;
    const response = error.getResponse();
    if (typeof response !== 'object' || response === null || !('code' in response)) {
      return { ...fallback, httpStatus: error.getStatus() };
    }
    const code = response.code;
    return {
      httpStatus: error.getStatus(),
      errorCode:
        typeof code === 'string' && /^OPERATOR_[A-Z0-9_]+$/u.test(code) ? code : fallback.errorCode,
    };
  }

  private async auditRecovery(
    tx: Prisma.TransactionClient,
    actor: OperatorActor,
    rollCode: string,
    claim: ClaimedPhysicalOperation,
    evidenceId: string,
  ) {
    if (!claim.recoveryFromId) return;
    await this.audit.record(
      {
        type: 'audit:operator_physical_operation_recovered',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: rollCode,
        detail: {
          operationId: claim.operationId,
          recoveredOperationId: claim.recoveryFromId,
          evidenceId,
          postId: claim.postId,
          sessionId: claim.sessionId,
        },
      },
      tx,
    );
  }

  private requireActorId(actor: OperatorActor): string {
    if (!actor.userId) throw new UnauthorizedException('Требуется полная пользовательская сессия.');
    return actor.userId;
  }

  private bindingFailureCode(error: unknown): BindingFailureCode | null {
    if (!(error instanceof ServiceUnavailableException)) return null;
    const response = error.getResponse();
    const code =
      response && typeof response === 'object' && 'code' in response
        ? (response as { code?: unknown }).code
        : null;
    return typeof code === 'string' &&
      (code === 'OPERATOR_DEVICE_BINDING_UNAVAILABLE' ||
        code === 'OPERATOR_DEVICE_NOT_READY' ||
        code.startsWith('POST_') ||
        code.startsWith('GATEWAY_'))
      ? (code as BindingFailureCode)
      : null;
  }

  private deviceBindingUnavailable(code: BindingFailureCode) {
    return new ServiceUnavailableException({
      code,
      message:
        code === 'OPERATOR_DEVICE_NOT_READY' ||
        code === 'POST_DEVICE_NOT_READY' ||
        code === 'POST_AGENT_OFFLINE' ||
        code === 'POST_AGENT_HEARTBEAT_STALE'
          ? 'Оборудование поста сейчас недоступно.'
          : 'Оборудование поста настроено неоднозначно или отсутствует.',
    });
  }

  private safeDeviceStatus(status: string) {
    return ['offline', 'unstable', 'stale', 'error'].includes(status) ? status : 'unavailable';
  }

  private reportBindingFailure(postId: string, kind: PhysicalDeviceKind): Promise<void> {
    return this.incidents.signal(bindingIncident(postId, kind));
  }

  private async reportUnavailableBinding(
    postId: string,
    kind: PhysicalDeviceKind,
    deviceId: string | null,
  ): Promise<void> {
    if (!deviceId) {
      await this.reportBindingFailure(postId, kind);
      return;
    }
    await Promise.all([
      this.reportBindingReady(postId, kind),
      this.reportDeviceFailure(deviceId, kind),
    ]);
  }

  private reportBindingReady(postId: string, kind: PhysicalDeviceKind): Promise<void> {
    return this.incidents.resolve(
      bindingIncidentFingerprint(postId, kind),
      'Post device binding verified.',
    );
  }

  private reportDeviceFailure(deviceId: string, kind: PhysicalDeviceKind): Promise<void> {
    return this.incidents.signal(deviceConnectionIncident(deviceId, kind));
  }

  private reportDeviceReady(deviceId: string): Promise<void> {
    return this.incidents.resolve(
      deviceConnectionFingerprint(deviceId),
      'Physical device operation succeeded.',
    );
  }

  private exceptionDeviceId(error: unknown): string | null {
    if (!error || typeof error !== 'object') return null;
    const source = error as { response?: unknown; getResponse?: () => unknown };
    const response =
      typeof source.getResponse === 'function' ? source.getResponse() : source.response;
    if (!response || typeof response !== 'object') return null;
    const deviceId = (response as { deviceId?: unknown }).deviceId;
    return typeof deviceId === 'string' && deviceId.length > 0 ? deviceId : null;
  }

  private reportPrintUnknown(postId: string): Promise<void> {
    return this.incidents.signal(gatewayCommandIncident(postId, 'print_delivery_unknown'));
  }

  private scaleUnavailable() {
    return new ServiceUnavailableException({
      code: 'OPERATOR_SCALE_UNAVAILABLE',
      message: 'Весы поста не вернули стабильное измерение.',
    });
  }

  private defectWeightNotAboveSpool(grossKg: number, spoolKg: number) {
    return new ConflictException({
      code: 'OPERATOR_DEFECT_WEIGHT_NOT_ABOVE_SPOOL',
      message: `На весах ${grossKg} кг — масса не превышает вес шпули ${spoolKg} кг. Положите бракованный рулон на весы и повторите.`,
    });
  }

  private rollWeightNotAboveSpool() {
    return new ConflictException({
      code: 'OPERATOR_ROLL_WEIGHT_NOT_ABOVE_SPOOL',
      message:
        'Вес рулона должен быть больше веса шпули. Проверьте весы и повторите взвешивание с новым ключом операции.',
    });
  }

  private reweighWeightRequired() {
    return new ConflictException({
      code: 'OPERATOR_REWEIGH_WEIGHT_REQUIRED',
      message: 'Сначала зафиксируйте первичный стабильный вес рулона.',
    });
  }

  private reweighPrintAlreadyStarted() {
    return new ConflictException({
      code: 'OPERATOR_REWEIGH_PRINT_ALREADY_STARTED',
      message: 'Перевзвешивание недоступно после запуска печати QR.',
    });
  }

  private reweighHandoverWeightValid() {
    return new ConflictException({
      code: 'OPERATOR_REWEIGH_HANDOVER_WEIGHT_VALID',
      message: 'Вес рулона уже корректен. Перевзвешивание на этапе передачи не требуется.',
    });
  }

  private async assertReweighAllowed(
    tx: Prisma.TransactionClient,
    line: {
      id: string;
      step: string;
      labelState: string;
      spoolKg: number | null;
      warehouseState: string;
      rollDispatchItem: { status: string };
    },
  ): Promise<ReweighEligibility> {
    assertOperatorRollMutable('roll_reweigh', line);
    const resultStep = assertOperatorRollReweighTransition(line.step);
    if (line.spoolKg == null) throw this.reweighWeightRequired();
    const capture = await this.canonicalRollCapture(tx, line.id);

    if (resultStep === 'qr_print') {
      if (line.labelState !== 'not_printed') throw this.reweighPrintAlreadyStarted();
      const printJob = await tx.labelPrintJob.findFirst({
        where: { operatorRollLineId: line.id },
        select: { id: true },
      });
      if (printJob) throw this.reweighPrintAlreadyStarted();
      return {
        capture,
        resultStep,
        reason: 'operator_requested_before_qr_print',
      };
    }

    if (line.labelState !== 'verified') {
      throw new ConflictException({
        code: 'OPERATOR_LABEL_NOT_VERIFIED',
        message: 'Перед восстановлением веса подтвердите существующую QR-метку.',
      });
    }
    const invalidWeight =
      capture.netKg != null && Number.isFinite(capture.netKg) && capture.netKg <= 0;
    if (!invalidWeight) throw this.reweighHandoverWeightValid();
    return {
      capture,
      resultStep,
      reason: 'operator_recovered_invalid_weight_before_handover',
    };
  }

  private async canonicalRollCapture(
    tx: Prisma.TransactionClient,
    operatorRollLineId: string,
  ): Promise<ReweighCapture> {
    const captures = await tx.weightCapture.findMany({
      where: {
        operatorRollLineId,
        kind: 'roll',
        stable: true,
        netKg: { not: null },
      },
      select: REWEIGH_CAPTURE_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const canonical = resolveCanonicalRollCaptureEvidence(captures).find(
      (capture) => capture.operatorRollLineId === operatorRollLineId,
    );
    if (!canonical || canonical.grossKg == null || canonical.netKg == null) {
      throw this.reweighWeightRequired();
    }
    return canonical;
  }

  private async correctionRollCapture(
    tx: Prisma.TransactionClient,
    operatorRollLineId: string,
  ): Promise<ReweighCapture | null> {
    const captures = await tx.weightCapture.findMany({
      where: {
        operatorRollLineId,
        kind: 'roll',
        stable: true,
        netKg: { not: null },
      },
      select: REWEIGH_CAPTURE_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (captures.length === 0) return null;

    const roots = captures.filter((capture) => capture.supersedesCaptureId === null);
    if (roots.length !== 1) throw this.correctionEvidenceAmbiguous();

    let current = roots[0];
    const visited = new Set([current.id]);
    while (true) {
      const successors = captures.filter((capture) => capture.supersedesCaptureId === current.id);
      if (successors.length === 0) break;
      if (successors.length !== 1 || visited.has(successors[0].id)) {
        throw this.correctionEvidenceAmbiguous();
      }
      current = successors[0];
      visited.add(current.id);
    }
    if (visited.size !== captures.length || current.grossKg === null || current.netKg === null) {
      throw this.correctionEvidenceAmbiguous();
    }
    return current;
  }

  private correctionEvidenceAmbiguous() {
    return new ConflictException({
      code: 'OPERATOR_CORRECTION_EVIDENCE_AMBIGUOUS',
      message: 'История измерений рулона неоднозначна. Обратитесь к заведующему производством.',
    });
  }

  private captureProjection(capture: ReweighCapture): OperatorWeightProjection {
    if (capture.grossKg == null || capture.netKg == null) throw this.reweighWeightRequired();
    return {
      grossKg: capture.grossKg,
      netKg: capture.netKg,
      toleranceOk: capture.toleranceOk,
    };
  }

  private rollWeightProjection(
    grossKg: number,
    spoolKg: number,
    planKg: number | null,
  ): OperatorWeightProjection {
    const normalizedGrossKg = this.normalizeWeightKg(grossKg);
    const normalizedSpoolKg = this.normalizeWeightKg(spoolKg);
    const netKg = this.normalizeWeightKg(normalizedGrossKg - normalizedSpoolKg);
    const toleranceOk = planKg ? Math.abs(netKg - planKg) / planKg <= TOLERANCE : null;
    return { grossKg: normalizedGrossKg, netKg, toleranceOk };
  }

  private validatedRollWeightProjection(
    grossKg: number,
    spoolKg: number,
    planKg: number | null,
  ): OperatorWeightProjection {
    const projection = this.rollWeightProjection(grossKg, spoolKg, planKg);
    const normalizedSpoolKg = this.normalizeWeightKg(spoolKg);
    if (
      !Number.isFinite(projection.grossKg) ||
      !Number.isFinite(normalizedSpoolKg) ||
      !Number.isFinite(projection.netKg) ||
      projection.grossKg <= normalizedSpoolKg ||
      projection.netKg <= 0
    ) {
      throw this.rollWeightNotAboveSpool();
    }
    return projection;
  }

  private normalizeWeightKg(value: number): number {
    return Math.round(value * 1_000) / 1_000;
  }

  private async replayReweigh(
    tx: Prisma.TransactionClient,
    operatorRollLineId: string,
    rollCode: string,
    resultRef: string | null,
    resultStep: string | null,
  ): Promise<OperatorRollReweighResult> {
    const current = resultRef
      ? await tx.weightCapture.findUnique({
          where: { id: resultRef },
          select: {
            ...REWEIGH_CAPTURE_SELECT,
            supersedesCapture: { select: REWEIGH_CAPTURE_SELECT },
          },
        })
      : null;
    const previous = current?.supersedesCapture;
    if (
      !current ||
      !previous ||
      current.operatorRollLineId !== operatorRollLineId ||
      previous.operatorRollLineId !== operatorRollLineId ||
      current.supersedesCaptureId !== previous.id ||
      current.kind !== 'roll' ||
      previous.kind !== 'roll' ||
      !current.stable ||
      !previous.stable
    ) {
      throw new ConflictException({
        code: 'OPERATOR_REWEIGH_REPLAY_UNAVAILABLE',
        message: 'Результат перевзвешивания недоступен. Обновите рабочую очередь.',
      });
    }
    if (resultStep !== 'qr_print' && resultStep !== 'handover') {
      throw new ConflictException({
        code: 'OPERATOR_REWEIGH_REPLAY_UNAVAILABLE',
        message: 'Результат перевзвешивания недоступен. Обновите рабочую очередь.',
      });
    }
    return {
      rollCode,
      step: resultStep,
      previousWeight: this.captureProjection(previous),
      currentWeight: this.captureProjection(current),
    };
  }

  private async getLine(rollCode: string) {
    const line = await this.prisma.operatorRollLine.findFirst({
      where: { rollDispatchItem: { rollCode } },
      include: {
        rollDispatchItem: {
          include: {
            productionOrder: {
              include: { commercialOrder: { include: { counterparty: true } } },
            },
          },
        },
      },
    });
    if (!line) {
      throw new ConflictException({
        code: 'OPERATOR_ROLL_STATE_UNAVAILABLE',
        message: 'Не удалось прочитать обновлённое состояние рулона.',
      });
    }
    const commercial = line.rollDispatchItem.productionOrder?.commercialOrder;
    return {
      rollCode,
      orderNumber: commercial?.orderNumber ?? null,
      customerAlias: commercial
        ? (projectCounterparty(commercial.counterparty, 'operator')?.displayName ?? null)
        : null,
      step: line.step,
      planKg: line.planKg,
      spoolKg: line.spoolKg,
      netKg: line.netKg,
      toleranceOk: line.toleranceOk,
      labelState: line.labelState,
      warehouseState: line.warehouseState,
    };
  }

  private async claimWithExpiredSettlement<T>(
    actor: OperatorActor,
    rollCode: string,
    input: ExpiredPhysicalClaimInput,
    claim: Promise<T>,
  ): Promise<T> {
    try {
      return await claim;
    } catch (error) {
      await this.settleExpiredAfterSceneFailure(actor, rollCode, input, error);
      throw error;
    }
  }

  private async settleExpiredAfterSceneFailure(
    actor: OperatorActor,
    rollCode: string,
    input: ExpiredPhysicalClaimInput,
    error: unknown,
  ): Promise<boolean> {
    const actorId = this.requireActorId(actor);
    const failure = this.finalizationFailure(error);
    const now = new Date();
    return this.transaction(async (tx) => {
      const keyedOperation: ExpiredPhysicalOperation | null =
        await tx.operatorRollOperation.findUnique({
          where: { operationKey: input.operationKey },
          select: EXPIRED_PHYSICAL_OPERATION_SELECT,
        });
      const operation: ExpiredPhysicalOperation | null =
        keyedOperation ??
        (await tx.operatorRollOperation.findFirst({
          where: {
            action: input.action,
            actorId,
            status: 'in_progress',
            leaseExpiresAt: { lte: now },
            line: { rollDispatchItem: { rollCode } },
          },
          select: EXPIRED_PHYSICAL_OPERATION_SELECT,
          orderBy: { createdAt: 'asc' },
        }));
      if (!operation) return false;
      const fingerprintInput =
        typeof input.fingerprintInput === 'function'
          ? input.fingerprintInput(operation.expectedStep, operation.requestFingerprint)
          : input.fingerprintInput;
      if (
        operation.status !== 'in_progress' ||
        !operation.leaseToken ||
        !operation.leaseExpiresAt ||
        operation.leaseExpiresAt.getTime() > now.getTime() ||
        operation.action !== input.action ||
        operation.actorId !== actorId ||
        operation.line.rollDispatchItem.rollCode !== rollCode ||
        operation.requestFingerprint !== OperatorOperationService.fingerprint(fingerprintInput)
      ) {
        return false;
      }

      const print = input.action === 'qr_print';
      const resultRef = print ? (operation.labelPrintJob?.id ?? null) : null;
      const terminal = print
        ? { httpStatus: 409, errorCode: 'OPERATOR_PRINT_DELIVERY_UNKNOWN', resultRef }
        : failure;
      const settled = await this.operations.settleExpired(
        tx,
        operation.id,
        operation.leaseToken,
        terminal,
        now,
      );
      if (!settled) return false;

      if (print) {
        if (operation.labelPrintJob) {
          await tx.labelPrintJob.update({
            where: { id: operation.labelPrintJob.id },
            data: {
              status: 'delivery_unknown',
              completedAt: now,
              failureReason: 'operator_lease_expired_context_changed',
            },
          });
          await tx.operatorRollLine.updateMany({
            where: {
              id: operation.operatorRollLineId,
              warehouseState: 'not_ready',
              rollDispatchItem: { status: { notIn: ['ready_for_warehouse', 'done'] } },
            },
            data: { labelState: 'delivery_unknown' },
          });
        }
        await this.audit.record(
          {
            type: 'audit:operator_label_print_delivery_unknown',
            actorRole: actor.role,
            actorId,
            objectId: rollCode,
            detail: {
              operationId: operation.id,
              jobId: operation.labelPrintJob?.id ?? null,
              deviceId: operation.deviceId,
              postId: operation.postId,
              sessionId: operation.postSessionId,
              status: 'delivery_unknown',
              reasonCode: 'operator_lease_expired_context_changed',
              lineMarkedUnknown: Boolean(operation.labelPrintJob),
            },
          },
          tx,
        );
        return true;
      }

      await this.audit.record(
        {
          type: 'audit:operator_weight_capture_failed',
          actorRole: actor.role,
          actorId,
          objectId: rollCode,
          detail: {
            operationId: operation.id,
            deviceId: operation.deviceId,
            kind: input.action === 'spool_weight' ? 'spool' : 'roll',
            postId: operation.postId,
            sessionId: operation.postSessionId,
            reasonCode: failure.errorCode,
            leaseExpired: true,
          },
        },
        tx,
      );
      return true;
    });
  }

  private async transaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const serializationFailure =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2034' || (error.code === 'P2010' && error.meta?.code === '40001'));
        if (serializationFailure && attempt < 3) continue;
        if (serializationFailure) {
          throw new ConflictException({
            code: 'OPERATOR_CONCURRENT_STATE_CONFLICT',
            message: 'Состояние рулона изменилось конкурентно. Обновите очередь.',
          });
        }
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ConflictException({
            code: 'OPERATOR_CONCURRENT_STATE_CONFLICT',
            message: 'Уникальное состояние рулона изменилось конкурентно. Обновите очередь.',
          });
        }
        throw error;
      }
    }
  }

  // Remaining roll mutations are implemented below in the same service so every controller path
  // shares actor/session/post ownership and the operation journal.
  async defer(actor: OperatorActor, rollCode: string, dto: DeferRollDto) {
    const actorId = this.requireActorId(actor);
    const reason = dto.reason.trim();
    await this.transaction(async (tx) => {
      const { session, line } = await this.ownership.lockOwned(tx, actor, rollCode);
      const claim = await this.operations.claim(tx, {
        operationKey: dto.operationKey,
        action: 'defer',
        actorId,
        operatorRollLineId: line.id,
        postId: session.postId,
        postSessionId: session.id,
        expectedStep: line.step,
        fingerprintInput: { reason },
        reason,
      });
      if (claim.kind === 'replay') return;
      assertOperatorRollMutable('defer', line);
      if (line.step === 'warehouse' || line.step === 'deferred') {
        throw new ConflictException({
          code: 'OPERATOR_STEP_CONFLICT',
          message: 'Рулон нельзя отложить в текущем состоянии.',
        });
      }
      await tx.operatorRollLine.update({
        where: { id: line.id },
        data: { step: 'deferred', deferredFromStep: line.step },
      });
      await tx.rollDispatchItem.update({
        where: { id: line.rollDispatchItemId },
        data: { status: 'deferred' },
      });
      await this.audit.record(
        {
          type: 'audit:roll_deferred',
          actorRole: actor.role,
          actorId,
          objectId: rollCode,
          reason,
          oldValue: { step: line.step },
          newValue: { step: 'deferred' },
          detail: {
            operationId: claim.operation.id,
            postId: session.postId,
            sessionId: session.id,
          },
        },
        tx,
      );
      await this.operations.complete(tx, claim.operation.id, {
        resultStep: 'deferred',
        httpStatus: 200,
      });
    });
    return this.getLine(rollCode);
  }

  async resume(actor: OperatorActor, rollCode: string, dto: OperatorOperationDto) {
    const actorId = this.requireActorId(actor);
    await this.transaction(async (tx) => {
      const { session, line } = await this.ownership.lockOwned(tx, actor, rollCode);
      const claim = await this.operations.claim(tx, {
        operationKey: dto.operationKey,
        action: 'resume',
        actorId,
        operatorRollLineId: line.id,
        postId: session.postId,
        postSessionId: session.id,
        expectedStep: line.step,
        fingerprintInput: {},
      });
      if (claim.kind === 'replay') return;
      assertOperatorRollMutable('resume', line);
      const restoredStep = line.deferredFromStep;
      if (
        line.step !== 'deferred' ||
        line.rollDispatchItem.status !== 'deferred' ||
        !restoredStep ||
        !['assigned', 'spool_weight', 'roll_weight', 'qr_print', 'qr_check', 'handover'].includes(
          restoredStep,
        )
      ) {
        throw new ConflictException({
          code: 'OPERATOR_STEP_CONFLICT',
          message: 'Отложенный рулон не содержит допустимого шага возврата.',
        });
      }
      await tx.operatorRollLine.update({
        where: { id: line.id },
        data: { step: restoredStep, deferredFromStep: null },
      });
      await tx.rollDispatchItem.update({
        where: { id: line.rollDispatchItemId },
        data: { status: 'assigned' },
      });
      await this.audit.record(
        {
          type: 'audit:roll_resumed',
          actorRole: actor.role,
          actorId,
          objectId: rollCode,
          oldValue: { step: 'deferred' },
          newValue: { step: restoredStep },
          detail: {
            operationId: claim.operation.id,
            postId: session.postId,
            sessionId: session.id,
          },
        },
        tx,
      );
      await this.operations.complete(tx, claim.operation.id, {
        resultStep: restoredStep,
        httpStatus: 200,
      });
    });
    return this.getLine(rollCode);
  }

  async printQr(actor: OperatorActor, rollCode: string, dto: QrPrintDto) {
    const actorId = this.requireActorId(actor);
    const reason = dto.reason?.trim() ?? null;
    const pendingClaim = this.transaction(async (tx) => {
      const { session, line } = await this.ownership.lockOwned(tx, actor, rollCode);
      const existing = await tx.operatorRollOperation.findUnique({
        where: { operationKey: dto.operationKey },
        select: { deviceId: true, expectedStep: true, requestFingerprint: true },
      });
      if (!existing) {
        const uncertain = await tx.labelPrintJob.findFirst({
          where: { operatorRollLineId: line.id, status: 'delivery_unknown' },
          select: { id: true },
        });
        if (uncertain) throw this.printDeliveryUnknown(uncertain.id);
        const active = await tx.labelPrintJob.findFirst({
          where: {
            operatorRollLineId: line.id,
            status: { in: ['queued', 'reprint_requested'] },
          },
          select: { id: true },
        });
        if (active) {
          throw new ConflictException({
            code: 'OPERATOR_PRINT_IN_PROGRESS',
            message: 'Предыдущее задание печати ещё выполняется.',
            printJobId: active.id,
          });
        }
      }
      const priorPrint =
        !existing && line.step === 'qr_print' && line.labelState === 'reprint_requested'
          ? await tx.labelPrintJob.findFirst({
              where: {
                operatorRollLineId: line.id,
                status: { in: ['submitted', 'printed'] },
              },
              orderBy: { createdAt: 'desc' },
              select: { id: true },
            })
          : null;
      const reprint = existing
        ? existing.expectedStep !== 'qr_print' ||
          existing.requestFingerprint ===
            OperatorOperationService.fingerprint({ reprint: true, reason })
        : (line.step === 'qr_print' &&
            line.labelState === 'reprint_requested' &&
            priorPrint !== null) ||
          (['qr_check', 'handover'].includes(line.step) &&
            ['submitted', 'printed', 'verified', 'reprint_requested'].includes(line.labelState));
      if (!existing) assertOperatorRollMutable('qr_print', line);
      if (!existing && reprint && !reason) {
        throw new BadRequestException({
          code: 'OPERATOR_REPRINT_REASON_REQUIRED',
          message: 'Для повторной печати укажите фактическую причину.',
        });
      }
      if (!existing && !reprint) assertOperatorRollTransition('qr_print', line.step);
      const claim = await this.operations.claim(tx, {
        operationKey: dto.operationKey,
        action: 'qr_print',
        actorId,
        operatorRollLineId: line.id,
        postId: session.postId,
        postSessionId: session.id,
        deviceId: existing?.deviceId ?? null,
        expectedStep: line.step,
        fingerprintInput: { reprint, reason },
        reason,
      });
      if (claim.kind === 'replay') return { kind: 'replay' as const };
      const leaseToken = this.physicalLeaseToken(claim.operation);
      if (claim.recoveryFromId === claim.operation.id) {
        const staleJob = await tx.labelPrintJob.findFirst({
          where: { operationId: claim.operation.id },
          select: { id: true },
        });
        if (staleJob) {
          await tx.labelPrintJob.update({
            where: { id: staleJob.id },
            data: {
              status: 'delivery_unknown',
              completedAt: new Date(),
              failureReason: 'operator_lease_expired_outcome_unknown',
            },
          });
          await tx.operatorRollLine.updateMany({
            where: {
              id: line.id,
              warehouseState: 'not_ready',
              rollDispatchItem: { status: { notIn: ['ready_for_warehouse', 'done'] } },
            },
            data: { labelState: 'delivery_unknown' },
          });
        }
        await this.operations.fail(
          tx,
          claim.operation.id,
          {
            httpStatus: 409,
            errorCode: 'OPERATOR_PRINT_DELIVERY_UNKNOWN',
            resultRef: staleJob?.id ?? null,
          },
          leaseToken,
        );
        await this.audit.record(
          {
            type: 'audit:operator_label_print_delivery_unknown',
            actorRole: actor.role,
            actorId,
            objectId: rollCode,
            detail: {
              operationId: claim.operation.id,
              jobId: staleJob?.id ?? null,
              deviceId: claim.operation.deviceId,
              postId: session.postId,
              sessionId: session.id,
              status: 'delivery_unknown',
              reasonCode: 'operator_lease_expired_outcome_unknown',
              lineMarkedUnknown: Boolean(staleJob),
            },
          },
          tx,
        );
        return {
          kind: 'delivery_unknown' as const,
          jobId: staleJob?.id ?? '',
          postId: session.postId,
        };
      }
      assertOperatorRollMutable('qr_print', line);
      let device: Awaited<ReturnType<OperatorDeviceBindingService['resolve']>>;
      try {
        device = await this.bindings.resolve(session.postId, 'printer', tx);
      } catch (error) {
        const errorCode = this.bindingFailureCode(error);
        if (!errorCode) throw error;
        await this.operations.fail(
          tx,
          claim.operation.id,
          { httpStatus: 503, errorCode },
          leaseToken,
        );
        await this.audit.record(
          {
            type: 'audit:operator_label_print_failed',
            actorRole: actor.role,
            actorId,
            objectId: rollCode,
            detail: {
              operationId: claim.operation.id,
              postId: session.postId,
              sessionId: session.id,
              reasonCode: errorCode,
            },
          },
          tx,
        );
        return {
          kind: 'binding_failure' as const,
          errorCode,
          postId: session.postId,
          deviceId: this.exceptionDeviceId(error),
        };
      }
      await this.operations.bindDevice(tx, claim.operation.id, device.id, leaseToken);
      await tx.warehouseRoll.upsert({
        where: { rollCode },
        update: {},
        create: { rollCode, warehouseStatus: 'not_ready' },
      });
      const label = await this.tokens.getOrCreate(rollCode, tx);
      const replaced =
        priorPrint ??
        (reprint
          ? await tx.labelPrintJob.findFirst({
              where: { operatorRollLineId: line.id, status: { in: ['submitted', 'printed'] } },
              orderBy: { createdAt: 'desc' },
              select: { id: true },
            })
          : null);
      const job = await tx.labelPrintJob.create({
        data: {
          operatorRollLineId: line.id,
          operationId: claim.operation.id,
          printerId: device.id,
          status: reprint ? 'reprint_requested' : 'queued',
          reason,
          replacesJobId: replaced?.id ?? null,
          actorId,
          postSessionId: session.id,
          postId: session.postId,
        },
      });
      await this.audit.record(
        {
          type: reprint ? 'audit:label_reprint_requested' : 'audit:operator_label_print_requested',
          actorRole: actor.role,
          actorId,
          objectId: rollCode,
          reason: reason ?? undefined,
          detail: {
            operationId: claim.operation.id,
            jobId: job.id,
            labelKind: 'roll_label',
            deviceId: device.id,
            postId: session.postId,
            sessionId: session.id,
          },
        },
        tx,
      );
      return {
        kind: 'claimed' as const,
        operationId: claim.operation.id,
        leaseToken,
        jobId: job.id,
        deviceId: device.id,
        lineId: line.id,
        sessionId: session.id,
        postId: session.postId,
        predecessor: line.step,
        qrCode: label.token,
        recoveryFromId: claim.recoveryFromId,
      };
    });
    const claimed = await this.claimWithExpiredSettlement(
      actor,
      rollCode,
      {
        operationKey: dto.operationKey,
        action: 'qr_print',
        fingerprintInput: (expectedStep: string, requestFingerprint: string) => ({
          reprint:
            expectedStep !== 'qr_print' ||
            requestFingerprint === OperatorOperationService.fingerprint({ reprint: true, reason }),
          reason,
        }),
      },
      pendingClaim,
    );
    if (claimed.kind === 'replay') return this.getLine(rollCode);
    if (claimed.kind === 'delivery_unknown') {
      await this.reportPrintUnknown(claimed.postId);
      throw this.printDeliveryUnknown(claimed.jobId);
    }
    if (claimed.kind === 'binding_failure') {
      await this.reportUnavailableBinding(claimed.postId, 'printer', claimed.deviceId);
      throw this.deviceBindingUnavailable(claimed.errorCode);
    }
    await this.reportBindingReady(claimed.postId, 'printer');

    let result: Awaited<ReturnType<PrinterAdapter['print']>>;
    try {
      result = await this.printer.print(
        {
          deviceId: claimed.deviceId,
          expectedPostId: claimed.postId,
          expectedKind: 'printer',
        },
        {
          kind: 'roll_label',
          rollCode,
          qrCode: claimed.qrCode,
        },
      );
    } catch {
      await this.markPrintDeliveryUnknown(actor, rollCode, claimed, {
        jobId: '',
        printerId: claimed.deviceId,
        status: 'delivery_unknown',
        failureReason: 'printer_adapter_rejection_outcome_unknown',
      });
      throw this.printDeliveryUnknown(claimed.jobId);
    }
    const printStatus: unknown = result.status;
    if (printStatus === 'delivery_unknown') {
      await this.markPrintDeliveryUnknown(actor, rollCode, claimed, result);
      throw this.printDeliveryUnknown(claimed.jobId);
    }
    if (printStatus === 'failed') {
      await this.failPrint(actor, rollCode, claimed);
      throw this.printerUnavailable();
    }
    if (!['printed', 'submitted'].includes(String(printStatus))) {
      await this.markPrintDeliveryUnknown(actor, rollCode, claimed, {
        ...result,
        status: 'delivery_unknown',
        failureReason: 'printer_result_status_unknown',
      });
      throw this.printDeliveryUnknown(claimed.jobId);
    }

    let finalized = false;
    try {
      finalized = await this.transaction(async (tx) => {
        const { session, line } = await this.ownership.lockOwned(tx, actor, rollCode);
        await this.operations.assertCurrentLease(tx, claimed.operationId, claimed.leaseToken);
        if (
          session.id !== claimed.sessionId ||
          line.id !== claimed.lineId ||
          line.step !== claimed.predecessor
        ) {
          return false;
        }
        try {
          assertOperatorRollMutable('qr_print', line);
        } catch (error) {
          if (error instanceof ConflictException) return false;
          throw error;
        }
        await tx.labelPrintJob.update({
          where: { id: claimed.jobId },
          data: {
            status: 'submitted',
            gatewayCommandId: result.gatewayCommandId ?? result.jobId,
            completedAt: new Date(),
            failureReason: null,
          },
        });
        const labelState = printStatus === 'submitted' ? 'submitted' : 'printed';
        await tx.operatorRollLine.update({
          where: { id: line.id },
          data: { labelState, step: 'qr_check' },
        });
        await this.operations.complete(
          tx,
          claimed.operationId,
          {
            resultStep: 'qr_check',
            resultRef: claimed.jobId,
            httpStatus: 200,
          },
          claimed.leaseToken,
        );
        await this.audit.record(
          {
            type: 'audit:operator_label_print_submitted',
            actorRole: actor.role,
            actorId,
            objectId: rollCode,
            oldValue: { step: line.step },
            newValue: { step: 'qr_check', labelState },
            detail: {
              operationId: claimed.operationId,
              jobId: claimed.jobId,
              gatewayCommandId: result.gatewayCommandId ?? result.jobId,
              labelKind: 'roll_label',
              deviceId: claimed.deviceId,
              postId: session.postId,
              sessionId: session.id,
            },
          },
          tx,
        );
        await this.auditRecovery(tx, actor, rollCode, claimed, claimed.jobId);
        return true;
      });
    } catch {
      finalized = false;
    }
    if (!finalized) {
      await this.markPrintDeliveryUnknown(actor, rollCode, claimed, {
        ...result,
        status: 'delivery_unknown',
        failureReason: 'operator_finalization_conflict_after_acknowledged_print',
      });
      throw this.printDeliveryUnknown(claimed.jobId);
    }
    await Promise.all([this.reportDeviceReady(claimed.deviceId)]);
    return this.getLine(rollCode);
  }

  async recordDefect(actor: OperatorActor, rollCode: string, dto: RecordDefectDto) {
    const actorId = this.requireActorId(actor);
    const comment = WEIGHED_DEFECT_AUDIT_REASON;
    const pendingClaim = this.transaction(async (tx) => {
      const { session, line } = await this.ownership.lockOwned(tx, actor, rollCode);
      const operation = await this.operations.claim(tx, {
        operationKey: dto.operationKey,
        action: 'defect',
        actorId,
        operatorRollLineId: line.id,
        postId: session.postId,
        postSessionId: session.id,
        expectedStep: line.step,
        fingerprintInput: {},
        reason: comment,
      });
      if (operation.kind === 'replay') return { kind: 'replay' as const };
      const leaseToken = this.physicalLeaseToken(operation.operation);
      assertOperatorRollMutable('defect', line);
      if (line.step !== 'roll_weight') {
        throw new ConflictException({
          code: 'OPERATOR_DEFECT_CAPTURE_STAGE_CONFLICT',
          message:
            'Новый операторский брак фиксируется только до первичного взвешивания рулона. Обратитесь к заведующему производством.',
        });
      }
      const openProblem = await tx.productionProblem.findFirst({
        where: { type: 'defect', status: 'open', rollId: rollCode },
        select: { id: true },
      });
      if (openProblem) {
        throw new ConflictException({
          code: 'OPERATOR_OPEN_DEFECT_EXISTS',
          message: 'По рулону уже открыт дефект. Обновите рабочую очередь.',
        });
      }
      const existingRollCapture = await tx.weightCapture.findFirst({
        where: { operatorRollLineId: line.id, kind: 'roll', stable: true },
        select: { id: true },
      });
      if (existingRollCapture) {
        throw new ConflictException({
          code: 'OPERATOR_DEFECT_EXISTING_ROLL_CAPTURE',
          message:
            'Первичный вес рулона уже существует. Брак должен зафиксировать заведующий производством.',
        });
      }
      const spoolCapture = await tx.weightCapture.findFirst({
        where: {
          operatorRollLineId: line.id,
          kind: 'spool',
          stable: true,
          deviceStatus: 'ready',
          postId: session.postId,
          postSessionId: session.id,
          grossKg: { not: null },
        },
        select: {
          id: true,
          deviceId: true,
          grossKg: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      if (
        !spoolCapture ||
        spoolCapture.deviceId == null ||
        spoolCapture.grossKg == null ||
        !Number.isFinite(spoolCapture.grossKg) ||
        spoolCapture.grossKg <= 0
      ) {
        throw new ConflictException({
          code: 'OPERATOR_DEFECT_SPOOL_EVIDENCE_REQUIRED',
          message: 'Для брака нужен стабильный вес шпули из текущей сессии.',
        });
      }
      let device: Awaited<ReturnType<OperatorDeviceBindingService['resolve']>>;
      try {
        device = await this.bindings.resolve(session.postId, 'scale', tx);
      } catch (error) {
        const errorCode = this.bindingFailureCode(error);
        if (!errorCode) throw error;
        await this.operations.fail(
          tx,
          operation.operation.id,
          { httpStatus: 503, errorCode },
          leaseToken,
        );
        await this.audit.record(
          {
            type: 'device.scale.offline',
            actorRole: actor.role,
            actorId,
            objectId: rollCode,
            detail: {
              operationId: operation.operation.id,
              postId: session.postId,
              sessionId: session.id,
              reasonCode: errorCode,
            },
          },
          tx,
        );
        return {
          kind: 'binding_failure' as const,
          errorCode,
          postId: session.postId,
          deviceId: this.exceptionDeviceId(error),
        };
      }
      if (spoolCapture.deviceId !== device.id) {
        throw new ConflictException({
          code: 'OPERATOR_DEFECT_SPOOL_DEVICE_CHANGED',
          message: 'Весы поста изменились после взвешивания шпули. Повторите подготовку рулона.',
        });
      }
      await this.operations.bindDevice(tx, operation.operation.id, device.id, leaseToken);
      return {
        kind: 'claimed' as const,
        operationId: operation.operation.id,
        leaseToken,
        recoveryFromId: operation.recoveryFromId,
        lineId: line.id,
        sessionId: session.id,
        postId: session.postId,
        deviceId: device.id,
        predecessor: 'roll_weight',
        spoolCaptureId: spoolCapture.id,
        spoolKg: spoolCapture.grossKg,
      };
    });
    const claim = await this.claimWithExpiredSettlement(
      actor,
      rollCode,
      {
        operationKey: dto.operationKey,
        action: 'defect',
        fingerprintInput: {},
      },
      pendingClaim,
    );
    if (claim.kind === 'replay') return this.getLine(rollCode);
    if (claim.kind === 'binding_failure') {
      await this.reportUnavailableBinding(claim.postId, 'scale', claim.deviceId);
      throw this.deviceBindingUnavailable(claim.errorCode);
    }
    await this.reportBindingReady(claim.postId, 'scale');

    let reading: Awaited<ReturnType<ScaleAdapter['read']>>;
    try {
      reading = await this.scale.read(
        {
          deviceId: claim.deviceId,
          expectedPostId: claim.postId,
          expectedKind: 'scale',
        },
        'roll',
      );
    } catch {
      await this.failScale(actor, rollCode, claim, 'error');
      throw this.scaleUnavailable();
    }
    if (
      reading.deviceId !== claim.deviceId ||
      reading.status !== 'ready' ||
      !reading.stable ||
      !Number.isFinite(reading.grossKg)
    ) {
      await this.failScale(actor, rollCode, claim, reading.status);
      throw this.scaleUnavailable();
    }
    const defectWeight = this.rollWeightProjection(reading.grossKg, claim.spoolKg, null);
    if (
      !Number.isFinite(defectWeight.grossKg) ||
      !Number.isFinite(defectWeight.netKg) ||
      defectWeight.netKg <= 0
    ) {
      await this.failDefectWeightNotAboveSpool(claim);
      throw this.defectWeightNotAboveSpool(defectWeight.grossKg, claim.spoolKg);
    }

    try {
      await this.transaction(async (tx) => {
        const { session, line } = await this.ownership.lockOwned(tx, actor, rollCode);
        await this.operations.assertCurrentLease(tx, claim.operationId, claim.leaseToken);
        if (
          session.id !== claim.sessionId ||
          session.postId !== claim.postId ||
          line.id !== claim.lineId
        ) {
          throw new ConflictException({
            code: 'OPERATOR_PHYSICAL_FINALIZATION_CONFLICT',
            message: 'Сессия поста изменилась до фиксации результата.',
          });
        }
        assertOperatorRollMutable('defect', line);
        if (line.step !== claim.predecessor) {
          throw new ConflictException({
            code: 'OPERATOR_DEFECT_CAPTURE_STAGE_CONFLICT',
            message: 'Состояние рулона изменилось до фиксации брака.',
          });
        }
        const finalDevice = await this.bindings.resolve(session.postId, 'scale', tx);
        if (finalDevice.id !== claim.deviceId) {
          throw new ConflictException({
            code: 'OPERATOR_DEVICE_BINDING_CHANGED',
            message: 'Привязка весов поста изменилась до фиксации результата.',
          });
        }
        const openProblem = await tx.productionProblem.findFirst({
          where: { type: 'defect', status: 'open', rollId: rollCode },
          select: { id: true },
        });
        if (openProblem) {
          throw new ConflictException({
            code: 'OPERATOR_OPEN_DEFECT_EXISTS',
            message: 'По рулону уже открыт дефект. Обновите рабочую очередь.',
          });
        }
        const existingRollCapture = await tx.weightCapture.findFirst({
          where: { operatorRollLineId: line.id, kind: 'roll', stable: true },
          select: { id: true },
        });
        if (existingRollCapture) {
          throw new ConflictException({
            code: 'OPERATOR_DEFECT_EXISTING_ROLL_CAPTURE',
            message:
              'Первичный вес рулона уже существует. Брак должен зафиксировать заведующий производством.',
          });
        }
        const spoolCapture = await tx.weightCapture.findFirst({
          where: {
            id: claim.spoolCaptureId,
            operatorRollLineId: line.id,
            kind: 'spool',
            stable: true,
            deviceStatus: 'ready',
            deviceId: claim.deviceId,
            postId: session.postId,
            postSessionId: session.id,
            grossKg: claim.spoolKg,
          },
          select: { id: true, grossKg: true },
        });
        if (!spoolCapture || spoolCapture.grossKg !== claim.spoolKg) {
          throw new ConflictException({
            code: 'OPERATOR_DEFECT_SPOOL_EVIDENCE_CHANGED',
            message: 'Вес шпули изменился до фиксации брака.',
          });
        }
        const orderId = line.rollDispatchItem.productionOrder?.commercialOrderId;
        if (!orderId) {
          throw new ConflictException({
            code: 'OPERATOR_DEFECT_ORDER_REQUIRED',
            message: 'Рулон не связан с производственным заказом.',
          });
        }
        const weight = this.rollWeightProjection(reading.grossKg, claim.spoolKg, line.planKg);
        const capture = await tx.weightCapture.create({
          data: {
            operatorRollLineId: line.id,
            operationId: claim.operationId,
            kind: 'roll',
            deviceId: claim.deviceId,
            deviceStatus: reading.status,
            stable: reading.stable,
            grossKg: reading.grossKg,
            spoolKg: claim.spoolKg,
            netKg: weight.netKg,
            toleranceOk: weight.toleranceOk,
            actorRole: actor.role,
            actorId,
            postId: session.postId,
            postSessionId: session.id,
          },
        });
        const defect = await tx.defectRecord.create({
          data: {
            operatorRollLineId: line.id,
            weightCaptureId: capture.id,
            sourceRole: actor.role,
            weightKg: weight.netKg,
            comment,
            blocking: true,
          },
        });
        await this.spoolStock.returnDefectSpool(actor, defect.id, tx);
        const problem = await tx.productionProblem.create({
          data: {
            type: 'defect',
            orderId,
            rollId: rollCode,
            actorRole: actor.role,
            reason: comment,
            defectRecordId: defect.id,
          },
        });
        if (!session.shiftId) {
          throw new ConflictException({
            code: 'OPERATOR_ACTIVE_SESSION_SHIFT_REQUIRED',
            message: 'Активная сессия оператора не связана со сменой.',
          });
        }
        let replacementRollCode: string | null = null;
        for (let attempt = 1; attempt <= 49; attempt += 1) {
          const candidate = `${rollCode}-R${attempt}`;
          const exists = await tx.rollDispatchItem.findUnique({
            where: { rollCode: candidate },
            select: { id: true },
          });
          if (!exists) {
            replacementRollCode = candidate;
            break;
          }
        }
        if (!replacementRollCode) {
          throw new ConflictException({
            code: 'OPERATOR_REPLACEMENT_CODE_EXHAUSTED',
            message: 'Не удалось создать код новой попытки рулона.',
          });
        }
        const queue = await tx.rollDispatchItem.aggregate({
          where: {
            assignedOperatorId: actorId,
            plannedShiftId: session.shiftId,
            postId: session.postId,
          },
          _max: { queueRank: true },
        });
        const sourceDispatch = line.rollDispatchItem;
        const replacement = await tx.rollDispatchItem.create({
          data: {
            rollCode: replacementRollCode,
            productionOrderId: sourceDispatch.productionOrderId,
            replacesDispatchItemId: line.rollDispatchItemId,
            orderLineId: sourceDispatch.orderLineId,
            positionSequence: sourceDispatch.positionSequence,
            rawMaterialId: sourceDispatch.rawMaterialId,
            recipeVersion: sourceDispatch.recipeVersion,
            filmType: sourceDispatch.filmType,
            plannedWeightKg: sourceDispatch.plannedWeightKg,
            plannedLengthM: sourceDispatch.plannedLengthM,
            characteristicsSnapshot:
              sourceDispatch.characteristicsSnapshot == null
                ? Prisma.JsonNull
                : sourceDispatch.characteristicsSnapshot,
            assignedOperatorId: actorId,
            machineId: sourceDispatch.machineId,
            workplaceId: sourceDispatch.workplaceId,
            postId: session.postId,
            plannedShiftId: session.shiftId,
            queueRank: (queue._max.queueRank ?? sourceDispatch.queueRank) + 1,
            priority: sourceDispatch.priority,
            bulkGroupId: sourceDispatch.bulkGroupId,
            status: 'assigned',
          },
        });
        await tx.operatorRollLine.create({
          data: {
            rollDispatchItemId: replacement.id,
            sequence: line.sequence + 1,
            groupId: line.groupId,
            ...(sourceDispatch.plannedWeightKg == null
              ? {}
              : { planKg: sourceDispatch.plannedWeightKg }),
            step: 'assigned',
          },
        });
        await tx.operatorRollLine.update({
          where: { id: line.id },
          data: {
            spoolKg: claim.spoolKg,
            grossKg: reading.grossKg,
            netKg: weight.netKg,
            toleranceOk: weight.toleranceOk,
            warehouseState: 'not_ready',
            step: 'defect',
            deferredFromStep: null,
          },
        });
        await tx.rollDispatchItem.update({
          where: { id: line.rollDispatchItemId },
          data: { status: 'defect' },
        });
        const detail = {
          operationId: claim.operationId,
          evidenceId: capture.id,
          defectId: defect.id,
          problemId: problem.id,
          orderId,
          productionOrderId: sourceDispatch.productionOrderId,
          ...(sourceDispatch.orderLineId == null ? {} : { positionId: sourceDispatch.orderLineId }),
          rollId: rollCode,
          deviceId: claim.deviceId,
          postId: session.postId,
          sessionId: session.id,
          replacementRollId: replacement.id,
          replacementRollCode,
        };
        await this.audit.record(
          {
            type: 'audit:operator_weight_captured',
            actorRole: actor.role,
            actorId,
            objectId: rollCode,
            oldValue: { step: line.step },
            newValue: { step: 'defect', grossKg: reading.grossKg, netKg: weight.netKg },
            detail: { ...detail, kind: 'roll' },
          },
          tx,
        );
        await this.audit.record(
          {
            type: 'audit:defect_recorded',
            actorRole: actor.role,
            actorId,
            objectId: rollCode,
            reason: comment,
            detail: { ...detail, blocking: true },
          },
          tx,
        );
        await this.audit.record(
          {
            type: 'problem:operator_defect_reported',
            actorRole: actor.role,
            actorId,
            objectId: orderId,
            reason: comment,
            detail: {
              ...detail,
              notificationKey: `operator-defect:${claim.operationId}:reported`,
              recipientRoles: ['operator', 'production_lead', 'director'],
              recipientUserIds: [actorId],
            },
          },
          tx,
        );
        await this.audit.record(
          {
            type: 'audit:replacement_roll_created',
            actorRole: actor.role,
            actorId,
            objectId: replacementRollCode,
            reason: comment,
            detail: {
              notificationKey: `operator-defect:${claim.operationId}:replacement-created`,
              recipientRoles: ['operator', 'production_lead', 'warehouse', 'director'],
              recipientUserIds: [actorId],
              operationId: claim.operationId,
              problemId: problem.id,
              orderId,
              ...(sourceDispatch.orderLineId == null
                ? {}
                : { positionId: sourceDispatch.orderLineId }),
              rollId: replacementRollCode,
              rollIds: [rollCode, replacementRollCode],
              sourceRollCode: rollCode,
              sourceDispatchItemId: line.rollDispatchItemId,
              replacementDispatchItemId: replacement.id,
              replacementRollCode,
              productionOrderId: sourceDispatch.productionOrderId,
              assignedOperatorId: actorId,
              postId: session.postId,
              shiftId: session.shiftId,
            },
          },
          tx,
        );
        await this.operations.complete(
          tx,
          claim.operationId,
          {
            resultStep: 'defect',
            resultRef: defect.id,
            httpStatus: 200,
          },
          claim.leaseToken,
        );
      });
    } catch (error) {
      await this.failWeightFinalization(actor, rollCode, claim, 'roll', error);
      throw error;
    }
    await this.reportDeviceReady(claim.deviceId);
    return this.getLine(rollCode);
  }

  async handover(actor: OperatorActor, rollCode: string, dto: OperatorOperationDto) {
    const actorId = this.requireActorId(actor);
    return this.transaction(async (tx) => {
      const { session, line } = await this.ownership.lockOwned(tx, actor, rollCode);
      const claim = await this.operations.claim(tx, {
        operationKey: dto.operationKey,
        action: 'handover',
        actorId,
        operatorRollLineId: line.id,
        postId: session.postId,
        postSessionId: session.id,
        expectedStep: line.step,
        fingerprintInput: {},
      });
      if (claim.kind === 'replay') {
        const taskId = claim.operation.resultRef;
        const task = taskId
          ? await tx.warehouseAcceptanceTask.findUnique({ where: { id: taskId } })
          : null;
        if (!task) {
          throw new ConflictException({
            code: 'OPERATOR_OPERATION_RESULT_UNAVAILABLE',
            message: 'Сохранённый результат передачи недоступен для безопасного повтора.',
          });
        }
        return task;
      }
      assertOperatorRollMutable('handover', line);
      if (line.labelState !== 'verified') {
        throw new ConflictException({
          code: 'OPERATOR_LABEL_NOT_VERIFIED',
          message: 'Перед передачей на склад отсканируйте и подтвердите напечатанную метку.',
        });
      }
      const resultStep = assertOperatorRollTransition('handover', line.step);
      const blocking = await tx.defectRecord.count({
        where: { operatorRollLineId: line.id, blocking: true },
      });
      if (blocking > 0) {
        throw new ConflictException({
          code: 'OPERATOR_BLOCKING_DEFECT',
          message: 'Рулон с блокирующим дефектом нельзя передать на склад.',
        });
      }
      const canonicalCapture = await this.canonicalHandoverCapture(tx, line.id);
      if (
        canonicalCapture &&
        (canonicalCapture.netKg == null ||
          !Number.isFinite(canonicalCapture.netKg) ||
          canonicalCapture.netKg <= 0)
      ) {
        throw this.handoverWeightInvalid();
      }
      const commercial = line.rollDispatchItem.productionOrder?.commercialOrder;
      if (
        commercial?.warehouseCoverageWorkflowVersion === 2 &&
        commercial.requestType !== 'stock_reserve' &&
        (!canonicalCapture ||
          !line.rollDispatchItem.orderLineId ||
          !line.rollDispatchItem.productionOrder?.sourceCoverageDecisionId)
      ) {
        throw this.v2HandoverProvenanceRequired();
      }
      if (!commercial) {
        throw new ConflictException({
          code: 'OPERATOR_ORDER_LINK_REQUIRED',
          message: 'Для передачи рулона отсутствует связь с заказом.',
        });
      }
      await tx.operatorRollLine.update({
        where: { id: line.id },
        data: { warehouseState: 'sent', step: resultStep },
      });
      await tx.rollDispatchItem.update({
        where: { id: line.rollDispatchItemId },
        data: { status: 'ready_for_warehouse' },
      });
      const receiving = await this.ensureWarehouseReceivingTask(tx, rollCode, line);
      const task = receiving.task;
      const coverageFact = await this.coverageFacts.appendProductionHandoverFact(tx, {
        rollId: receiving.warehouseRoll.id,
        sourceDispatchItemId: line.rollDispatchItemId,
        sourceWeightCaptureId: canonicalCapture?.id ?? null,
      });
      const productionProvenance = await this.linkV2ProductionProvenance(tx, {
        warehouseRollId: receiving.warehouseRoll.id,
        currentCoverageFactId: coverageFact?.factId ?? null,
        commercialOrderId: commercial.id,
        workflowVersion: commercial.warehouseCoverageWorkflowVersion,
        requestType: commercial.requestType,
        positionId: line.rollDispatchItem.orderLineId,
        coverageDecisionId: line.rollDispatchItem.productionOrder?.sourceCoverageDecisionId ?? null,
      });
      if (commercial.cancellationStatus === 'cancelled') {
        await this.coverageFacts.releaseCancelledOrderRolls(
          tx,
          commercial.id,
          actor,
          commercial.cancellationReason ?? 'Заказ отменён',
          rollCode,
        );
      }
      await this.audit.record(
        {
          type: 'audit:operator_roll_handed_over',
          actorRole: actor.role,
          actorId,
          objectId: commercial.id,
          oldValue: { step: line.step, warehouseState: line.warehouseState },
          newValue: { step: resultStep, warehouseState: 'sent' },
          detail: {
            operationId: claim.operation.id,
            productionOrderId: line.rollDispatchItem.productionOrderId,
            taskId: task.id,
            rollId: rollCode,
            postId: session.postId,
            sessionId: session.id,
            ...(productionProvenance
              ? {
                  sourcePositionId: productionProvenance.positionId,
                  sourceCoverageDecisionId: productionProvenance.coverageDecisionId,
                }
              : {}),
          },
        },
        tx,
      );
      await this.recordCompletedOrderHandover(tx, actor, {
        commercialOrderId: commercial.id,
        orderNumber: commercial.orderNumber,
        productionOrderId: line.rollDispatchItem.productionOrderId,
      });
      await this.operations.complete(tx, claim.operation.id, {
        resultStep,
        resultRef: task.id,
        httpStatus: 200,
      });
      return task;
    });
  }

  private async recordCompletedOrderHandover(
    tx: Prisma.TransactionClient,
    actor: OperatorActor,
    input: {
      commercialOrderId: string;
      orderNumber: string;
      productionOrderId: string;
    },
  ): Promise<void> {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "production_orders" WHERE "id" = ${input.productionOrderId} FOR UPDATE`,
    );
    const rows = await tx.rollDispatchItem.findMany({
      where: { productionOrderId: input.productionOrderId },
      select: {
        id: true,
        rollCode: true,
        status: true,
        replacesDispatchItemId: true,
      },
      orderBy: { id: 'asc' },
    });
    const leaves = canonicalDispatchLeaves(rows);
    if (
      !leaves ||
      leaves.some((leaf) => leaf.status !== 'ready_for_warehouse' && leaf.status !== 'done')
    ) {
      return;
    }

    const leafIds = leaves.map((leaf) => leaf.id).sort();
    const notificationKey = `production-order-fully-handed-over:${input.productionOrderId}:${leafIds.join(',')}`;
    const existing = await tx.domainEvent.findFirst({
      where: {
        type: 'notification:production_order_fully_handed_over',
        objectId: input.commercialOrderId,
        detail: { path: ['notificationKey'], equals: notificationKey },
      },
      select: { id: true },
    });
    if (existing) return;

    await this.audit.record(
      {
        type: 'notification:production_order_fully_handed_over',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: input.commercialOrderId,
        detail: {
          notificationKey,
          recipientRoles: ['production_lead'],
          recipientUserIds: [],
          orderId: input.commercialOrderId,
          orderNumber: input.orderNumber,
          productionOrderId: input.productionOrderId,
          rollCount: leaves.length,
          rollIds: leaves.map((leaf) => leaf.rollCode),
        },
      },
      tx,
    );
  }

  private async ensureWarehouseReceivingTask(
    tx: Prisma.TransactionClient,
    rollCode: string,
    line: {
      rollDispatchItem: {
        productionOrderId: string;
        orderLineId: string | null;
        productionOrder?: {
          commercialOrder?: {
            id: string;
            orderNumber: string;
            counterpartyId: string | null;
            requestType: string;
            stockBatchCode: string | null;
            warehouseCoverageWorkflowVersion: number;
          } | null;
        } | null;
      };
    },
  ) {
    const commercial = line.rollDispatchItem.productionOrder?.commercialOrder ?? null;
    const orderId = commercial?.id ?? null;
    const positionId = line.rollDispatchItem.orderLineId;
    const fromOrderId = commercial?.orderNumber ?? line.rollDispatchItem.productionOrderId;
    const linked = await tx.scanRow.findFirst({
      where: {
        rollCode,
        scanStatus: { in: ['expected', 'accepted', 'reserved', 'damaged'] },
        task: { mode: 'receiving', status: { in: ['open', 'partial'] } },
      },
      include: { task: true },
      orderBy: [{ task: { createdAt: 'asc' } }, { id: 'asc' }],
    });
    if (linked) {
      const warehouseRoll = await this.ensureWarehouseRoll(tx, rollCode, commercial);
      return { task: linked.task, warehouseRoll };
    }
    const task = orderId
      ? await this.canonicalOrderReceivingTask(tx, orderId)
      : await this.legacyReceivingTask(tx, fromOrderId, positionId);
    await tx.scanRow.create({
      data: { taskId: task.id, rollCode, fromOrderId, scanStatus: 'expected' },
    });
    const warehouseRoll = await this.ensureWarehouseRoll(tx, rollCode, commercial);
    return { task, warehouseRoll };
  }

  private async canonicalOrderReceivingTask(tx: Prisma.TransactionClient, orderId: string) {
    const receivingScopeKey = `commercial-order:${orderId}`;
    await tx.$queryRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(
        hashtextextended(${`warehouse-receiving:${receivingScopeKey}`}, 0)
      )::text AS "lock"`,
    );

    const scoped = await tx.warehouseAcceptanceTask.findUnique({
      where: { receivingScopeKey },
    });
    if (scoped) {
      if (['open', 'partial'].includes(scoped.status)) return scoped;
      throw new ConflictException({
        code: 'OPERATOR_RECEIVING_TASK_CLOSED',
        message: 'Приёмка этого заказа уже закрыта. Обновите складскую очередь.',
      });
    }

    const legacy = await tx.warehouseAcceptanceTask.findFirst({
      where: {
        mode: 'receiving',
        status: { in: ['open', 'partial'] },
        orderId,
        receivingScopeKey: null,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (legacy) {
      const claimed = await tx.warehouseAcceptanceTask.updateMany({
        where: { id: legacy.id, receivingScopeKey: null },
        data: { receivingScopeKey },
      });
      if (claimed.count === 1) return legacy;
      const winner = await tx.warehouseAcceptanceTask.findUnique({
        where: { receivingScopeKey },
      });
      if (winner && ['open', 'partial'].includes(winner.status)) return winner;
      throw new ConflictException({
        code: 'OPERATOR_RECEIVING_TASK_CONFLICT',
        message: 'Складская приёмка заказа изменилась конкурентно. Обновите очередь.',
      });
    }

    return this.createReceivingTask(tx, orderId, null, receivingScopeKey);
  }

  private async legacyReceivingTask(
    tx: Prisma.TransactionClient,
    fromOrderId: string,
    positionId: string | null,
  ) {
    const existing = await tx.warehouseAcceptanceTask.findFirst({
      where: {
        mode: 'receiving',
        status: { in: ['open', 'partial'] },
        rows: { some: { fromOrderId } },
        ...(positionId ? { positionId } : {}),
      },
    });
    return existing ?? this.createReceivingTask(tx, null, positionId, null);
  }

  private async canonicalHandoverCapture(tx: Prisma.TransactionClient, operatorRollLineId: string) {
    const captures = await tx.weightCapture.findMany({
      where: { operatorRollLineId, kind: 'roll', stable: true, netKg: { not: null } },
      select: {
        id: true,
        operatorRollLineId: true,
        kind: true,
        stable: true,
        netKg: true,
        supersedesCaptureId: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const eligibleRoots = captures.filter((capture) => capture.supersedesCaptureId === null);
    if (eligibleRoots.length !== 1) return null;
    const canonical = resolveCanonicalRollCaptureEvidence(captures).filter(
      (capture) => capture.operatorRollLineId === operatorRollLineId,
    );
    return canonical.length === 1 ? canonical[0] : null;
  }

  private ensureWarehouseRoll(
    tx: Prisma.TransactionClient,
    rollCode: string,
    commercial: {
      id: string;
      counterpartyId: string | null;
      requestType: string;
      stockBatchCode: string | null;
      warehouseCoverageWorkflowVersion: number;
    } | null,
  ) {
    const isStockProduction = commercial?.requestType === 'stock_reserve';
    const legacyReservation =
      commercial && !isStockProduction && commercial.warehouseCoverageWorkflowVersion === 1
        ? { reservedForOrderId: commercial.id }
        : {};
    const stockProvenance =
      commercial && isStockProduction ? { producedForStockOrderId: commercial.id } : {};
    return tx.warehouseRoll.upsert({
      where: { rollCode },
      update: {
        warehouseStatus: 'sent',
        ownerCounterpartyId: isStockProduction ? null : (commercial?.counterpartyId ?? undefined),
        ...legacyReservation,
        ...stockProvenance,
      },
      create: {
        rollCode,
        warehouseStatus: 'sent',
        ownerCounterpartyId: isStockProduction ? null : (commercial?.counterpartyId ?? undefined),
        ...legacyReservation,
        ...stockProvenance,
      },
    });
  }

  private async linkV2ProductionProvenance(
    tx: Prisma.TransactionClient,
    input: {
      warehouseRollId: string;
      currentCoverageFactId: string | null;
      commercialOrderId: string;
      workflowVersion: number;
      requestType: string;
      positionId: string | null;
      coverageDecisionId: string | null;
    },
  ): Promise<{ positionId: string; coverageDecisionId: string } | null> {
    if (input.workflowVersion !== 2 || input.requestType === 'stock_reserve') return null;
    if (!input.currentCoverageFactId || !input.positionId || !input.coverageDecisionId) {
      throw this.v2HandoverProvenanceRequired();
    }
    const linked = await tx.warehouseRoll.updateMany({
      where: {
        id: input.warehouseRollId,
        currentCoverageFactId: input.currentCoverageFactId,
        producedForOrderId: null,
        producedForPositionId: null,
        producedByCoverageDecisionId: null,
      },
      data: {
        producedForOrderId: input.commercialOrderId,
        producedForPositionId: input.positionId,
        producedByCoverageDecisionId: input.coverageDecisionId,
      },
    });
    if (linked.count !== 1) {
      throw new ConflictException({
        code: 'OPERATOR_V2_HANDOVER_PROVENANCE_CONFLICT',
        message: 'Связь произведённого рулона изменилась конкурентно.',
      });
    }
    return {
      positionId: input.positionId,
      coverageDecisionId: input.coverageDecisionId,
    };
  }

  private v2HandoverProvenanceRequired() {
    return new ConflictException({
      code: 'OPERATOR_V2_HANDOVER_PROVENANCE_REQUIRED',
      message:
        'QR считан, но передача на склад остановлена: не удалось подтвердить вес и связь рулона с позицией заказа.',
    });
  }

  private handoverWeightInvalid() {
    return new ConflictException({
      code: 'OPERATOR_HANDOVER_WEIGHT_INVALID',
      message: 'Вес рулона некорректен. Перевзвесьте рулон перед передачей на склад.',
      recoveryAction: 'reweigh',
      recoveryLabel: 'Перевзвесить',
    });
  }

  private async createReceivingTask(
    tx: Prisma.TransactionClient,
    orderId: string | null,
    positionId: string | null,
    receivingScopeKey: string | null,
  ) {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const sequence =
      (await tx.warehouseAcceptanceTask.count({
        where: { mode: 'receiving', createdAt: { gte: start } },
      })) + 1;
    return tx.warehouseAcceptanceTask.create({
      data: {
        mode: 'receiving',
        status: 'open',
        operationCode: `ПР-${String(now.getDate()).padStart(2, '0')}${String(
          now.getMonth() + 1,
        ).padStart(2, '0')}-${String(sequence).padStart(2, '0')}`,
        ...(orderId ? { orderId } : {}),
        ...(positionId ? { positionId } : {}),
        ...(receivingScopeKey ? { receivingScopeKey } : {}),
      },
    });
  }

  private async failPrint(
    actor: OperatorActor,
    rollCode: string,
    claim: ClaimedPhysicalOperation & { jobId: string },
  ) {
    await this.transaction(async (tx) => {
      await tx.labelPrintJob.update({
        where: { id: claim.jobId },
        data: { status: 'failed', failureReason: 'device_unavailable', completedAt: new Date() },
      });
      await this.operations.fail(
        tx,
        claim.operationId,
        {
          httpStatus: 503,
          errorCode: 'OPERATOR_PRINTER_UNAVAILABLE',
          resultRef: claim.jobId,
        },
        claim.leaseToken,
      );
      await this.audit.record(
        {
          type: 'audit:operator_label_print_failed',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: rollCode,
          detail: {
            operationId: claim.operationId,
            jobId: claim.jobId,
            deviceId: claim.deviceId,
            postId: claim.postId,
            sessionId: claim.sessionId,
            status: 'failed',
          },
        },
        tx,
      );
    });
    await this.reportDeviceFailure(claim.deviceId, 'printer');
  }

  private async markPrintDeliveryUnknown(
    actor: OperatorActor,
    rollCode: string,
    claim: ClaimedPhysicalOperation & { jobId: string; qrCode: string },
    result: Awaited<ReturnType<PrinterAdapter['print']>>,
  ) {
    const gatewayCommandId = result.gatewayCommandId || result.jobId || null;
    const failureReason = normalizePrintDeliveryUnknownReason(result.failureReason);
    await this.transaction(async (tx) => {
      await tx.labelPrintJob.update({
        where: { id: claim.jobId },
        data: {
          status: 'delivery_unknown',
          gatewayCommandId,
          completedAt: new Date(),
          failureReason,
        },
      });
      const lineUpdate = await tx.operatorRollLine.updateMany({
        where: {
          id: claim.lineId,
          step: claim.predecessor,
          warehouseState: 'not_ready',
          rollDispatchItem: { status: { notIn: ['ready_for_warehouse', 'done'] } },
        },
        data: {
          labelState: 'delivery_unknown',
          step: claim.predecessor,
        },
      });
      await this.operations.fail(
        tx,
        claim.operationId,
        {
          httpStatus: 409,
          errorCode: 'OPERATOR_PRINT_DELIVERY_UNKNOWN',
          resultRef: claim.jobId,
        },
        claim.leaseToken,
      );
      await this.audit.record(
        {
          type: 'audit:operator_label_print_delivery_unknown',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: rollCode,
          detail: {
            operationId: claim.operationId,
            jobId: claim.jobId,
            deviceId: claim.deviceId,
            postId: claim.postId,
            sessionId: claim.sessionId,
            gatewayCommandId,
            status: 'delivery_unknown',
            reasonCode: failureReason,
            lineMarkedUnknown: lineUpdate.count === 1,
          },
        },
        tx,
      );
    });
    await this.reportPrintUnknown(claim.postId);
  }

  private printDeliveryUnknown(printJobId: string) {
    return new ConflictException({
      code: 'OPERATOR_PRINT_DELIVERY_UNKNOWN',
      message: 'Результат печати неизвестен. Нужна сверка этикетки администратором.',
      printJobId,
    });
  }

  private printerUnavailable() {
    return new ServiceUnavailableException({
      code: 'OPERATOR_PRINTER_UNAVAILABLE',
      message: 'Принтер поста не подтвердил отправку задания.',
    });
  }

  private physicalLeaseToken(operation: { leaseToken?: string | null }): string {
    if (operation.leaseToken) return operation.leaseToken;
    throw new ServiceUnavailableException({
      code: 'OPERATOR_OPERATION_RECOVERY_UNAVAILABLE',
      message: 'Физическая операция не получила защитную аренду. Повторите после проверки поста.',
    });
  }

  private snapshotString(snapshot: Prisma.JsonValue, key: string): string | null {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
    const value = (snapshot as Prisma.JsonObject)[key];
    return typeof value === 'string' ? value : null;
  }
}
