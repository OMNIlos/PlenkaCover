import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuditService } from '../src/common/audit/audit.service';
import { loadRuntimeConfig } from '../src/common/runtime-config';
import { GatewayService } from '../src/modules/gateway/gateway.service';
import { OperatorOperationService } from '../src/modules/operator/operator-operation.service';

describe('Late printer rejection recovery (real PostgreSQL)', () => {
  const prisma = new PrismaService();
  const audit = new AuditService(prisma);
  const gateway = new GatewayService(
    prisma,
    audit,
    loadRuntimeConfig({ APP_ENV: 'test' }),
    { reconcileFingerprints: async () => undefined } as never,
    { reconcilePost: async () => undefined } as never,
  );
  const sweep = () =>
    (
      gateway as unknown as { reconcileExpiredCommands(): Promise<void> }
    ).reconcileExpiredCommands();
  let lineId: string;
  let dispatchId: string;
  let sessionId: string;
  let postId: string;
  let actorId: string;
  let printJobId: string;
  let commandId: string;
  const operationKey = randomUUID();
  const rollCode = `QR-RECOVERY-${randomUUID()}`;

  beforeAll(async () => {
    await prisma.$connect();
    const post = await prisma.post.findFirstOrThrow();
    const actor = await prisma.user.findFirstOrThrow({ where: { role: 'operator' } });
    const order = await prisma.productionOrder.findFirstOrThrow();
    postId = post.id;
    actorId = actor.id;
    const session = await prisma.operatorPostSession.create({
      data: { operatorId: actor.id, postId: post.id, status: 'closed' },
    });
    sessionId = session.id;
    const dispatch = await prisma.rollDispatchItem.create({
      data: {
        rollCode,
        productionOrderId: order.id,
        postId,
        assignedOperatorId: actorId,
        status: 'assigned',
        operatorLine: { create: { step: 'qr_print', labelState: 'delivery_unknown', netKg: 10.9 } },
      },
      include: { operatorLine: true },
    });
    dispatchId = dispatch.id;
    lineId = dispatch.operatorLine!.id;
    const command = await prisma.gatewayCommand.create({
      data: {
        id: randomUUID(),
        postId,
        kind: 'print',
        status: 'delivery_unknown',
        payload: { kind: 'roll_label', rollCode, printerId: 'recovery-printer' },
        result: {
          ok: false,
          status: 'delivery_unknown',
          reasonCode: 'gateway_command_deadline_exceeded',
        },
        createdAt: new Date(Date.now() - 30_000),
        deadlineAt: new Date(Date.now() - 10_000),
        leaseToken: randomUUID(),
      },
    });
    commandId = command.id;
    const operation = await prisma.operatorRollOperation.create({
      data: {
        operationKey,
        operatorRollLineId: lineId,
        action: 'qr_print',
        actorId,
        postSessionId: sessionId,
        postId,
        status: 'failed',
        expectedStep: 'qr_print',
        requestFingerprint: OperatorOperationService.fingerprint({ reprint: false, reason: null }),
        errorCode: 'OPERATOR_PRINT_DELIVERY_UNKNOWN',
        httpStatus: 409,
        attempt: 1,
        completedAt: new Date(),
      },
    });
    const job = await prisma.labelPrintJob.create({
      data: {
        operatorRollLineId: lineId,
        operationId: operation.id,
        postId,
        postSessionId: sessionId,
        actorId,
        printerId: 'recovery-printer',
        status: 'delivery_unknown',
        gatewayCommandId: commandId,
        failureReason: 'gateway_transport_outcome_unknown',
      },
    });
    printJobId = job.id;
  });

  afterAll(async () => {
    if (printJobId) await prisma.labelPrintJob.deleteMany({ where: { id: printJobId } });
    await prisma.operatorRollOperation.deleteMany({ where: { operationKey } });
    if (lineId) await prisma.operatorRollLine.deleteMany({ where: { id: lineId } });
    if (dispatchId) await prisma.rollDispatchItem.deleteMany({ where: { id: dispatchId } });
    if (sessionId) await prisma.operatorPostSession.deleteMany({ where: { id: sessionId } });
    if (commandId) await prisma.gatewayCommand.deleteMany({ where: { id: commandId } });
    await prisma.$disconnect();
  });

  it('keeps ambiguity, then accepts the exact late rejection and releases the saved browser key without printing', async () => {
    await sweep();
    expect(
      (await prisma.labelPrintJob.findUniqueOrThrow({ where: { id: printJobId } })).status,
    ).toBe('delivery_unknown');

    const command = await prisma.gatewayCommand.findUniqueOrThrow({ where: { id: commandId } });
    await gateway.resolveCommand(
      commandId,
      {
        ok: false,
        status: 'failed',
        reasonCode: 'gateway_command_deadline_elapsed_before_invocation',
      },
      postId,
      command.leaseToken!,
    );
    // Simulates the late result arriving before the business job stores its command link.
    await prisma.labelPrintJob.update({
      where: { id: printJobId },
      data: { gatewayCommandId: null },
    });
    await sweep();
    expect(
      (await prisma.labelPrintJob.findUniqueOrThrow({ where: { id: printJobId } })).status,
    ).toBe('delivery_unknown');
    await prisma.labelPrintJob.update({
      where: { id: printJobId },
      data: { gatewayCommandId: commandId },
    });
    for (const mismatch of [
      { printerId: 'another-printer' },
      { rollCode: 'another-roll' },
      { kind: 'big_bag_label' },
    ]) {
      await prisma.gatewayCommand.update({
        where: { id: commandId },
        data: {
          payload: { kind: 'roll_label', rollCode, printerId: 'recovery-printer', ...mismatch },
        },
      });
      await sweep();
      expect(
        (await prisma.labelPrintJob.findUniqueOrThrow({ where: { id: printJobId } })).status,
      ).toBe('delivery_unknown');
    }
    await prisma.gatewayCommand.update({
      where: { id: commandId },
      data: {
        payload: {
          kind: 'roll_label',
          rollCode,
          printerId: 'recovery-printer',
        },
      },
    });
    await prisma.rollDispatchItem.update({ where: { id: dispatchId }, data: { postId: null } });
    await sweep();
    expect(
      (await prisma.labelPrintJob.findUniqueOrThrow({ where: { id: printJobId } })).status,
    ).toBe('delivery_unknown');
    await prisma.rollDispatchItem.update({ where: { id: dispatchId }, data: { postId } });
    await sweep();
    expect(
      await prisma.operatorRollLine.findUniqueOrThrow({ where: { id: lineId } }),
    ).toMatchObject({ step: 'qr_print', labelState: 'not_printed', netKg: 10.9 });
    expect(
      (await prisma.labelPrintJob.findUniqueOrThrow({ where: { id: printJobId } })).status,
    ).toBe('failed');
    await expect(
      prisma.$transaction((tx) =>
        new OperatorOperationService().claim(tx, {
          operationKey,
          operatorRollLineId: lineId,
          actorId,
          postSessionId: sessionId,
          postId,
          action: 'qr_print',
          expectedStep: 'qr_print',
          fingerprintInput: { reprint: false, reason: null },
        }),
      ),
    ).rejects.toMatchObject({ response: { code: 'OPERATOR_PRINT_NOT_SENT' } });
    const auditCount = await prisma.domainEvent.count({ where: { objectId: rollCode } });
    await sweep();
    expect(await prisma.domainEvent.count({ where: { objectId: rollCode } })).toBe(auditCount);
    expect(await prisma.labelPrintJob.count({ where: { operatorRollLineId: lineId } })).toBe(1);
    expect(
      await prisma.gatewayCommand.count({
        where: { payload: { path: ['rollCode'], equals: rollCode } },
      }),
    ).toBe(1);
  });

  it('repairs linked defect-bag, warehouse-bag and pallet failures without claiming they were printed', async () => {
    const bag = await prisma.bigBagUnit.create({
      data: { code: `B-${randomUUID()}`, material: 'ПВД' },
    });
    const defect = await prisma.defectBag.create({
      data: {
        code: `DEF-${randomUUID()}`,
        postSessionId: sessionId,
        captureChannel: 'operator_manual',
        defectType: 'secondary',
        weightKg: 1,
        recordedDefectKg: 1,
        differenceKg: 0,
        weighOperationKey: randomUUID(),
      },
    });
    const document = await prisma.palletListDocument.create({
      data: {
        palletId: `P-${randomUUID()}`,
        generatedByRole: 'warehouse',
      },
    });
    const commandIds: string[] = [];
    const failedCommand = async (payload: Record<string, string>) => {
      const command = await prisma.gatewayCommand.create({
        data: {
          id: randomUUID(),
          postId,
          kind: 'print',
          status: 'failed',
          payload: { ...payload, printerId: 'recovery-printer' },
          result: {
            ok: false,
            status: 'failed',
            reasonCode: 'gateway_command_deadline_elapsed_before_invocation',
          },
        },
      });
      commandIds.push(command.id);
      return command.id;
    };
    try {
      const defectPrint = await prisma.defectBagLabelPrintJob.create({
        data: {
          operationKey: randomUUID(),
          defectBagId: defect.id,
          printerId: 'recovery-printer',
          status: 'delivery_unknown',
          actorId,
          postSessionId: sessionId,
          postId,
          leaseToken: randomUUID(),
          leaseExpiresAt: new Date(),
          gatewayCommandId: await failedCommand({ kind: 'big_bag_label', bigBagCode: defect.code }),
        },
      });
      const bagPrint = await prisma.bigBagLabelPrintJob.create({
        data: {
          requestId: randomUUID(),
          bigBagId: bag.id,
          printerId: 'recovery-printer',
          status: 'uncertain',
          requestedByRole: 'warehouse',
          gatewayCommandId: await failedCommand({ kind: 'big_bag_label', bigBagCode: bag.code }),
        },
      });
      const palletPrint = await prisma.palletPrintJob.create({
        data: {
          requestId: randomUUID(),
          palletListDocumentId: document.id,
          printerId: 'recovery-printer',
          status: 'delivery_unknown',
          gatewayCommandId: await failedCommand({ kind: 'pallet_label', documentId: document.id }),
        },
      });
      await sweep();
      expect(
        (await prisma.defectBagLabelPrintJob.findUniqueOrThrow({ where: { id: defectPrint.id } }))
          .status,
      ).toBe('failed');
      expect(
        (await prisma.bigBagLabelPrintJob.findUniqueOrThrow({ where: { id: bagPrint.id } })).status,
      ).toBe('failed');
      expect(
        (await prisma.palletPrintJob.findUniqueOrThrow({ where: { id: palletPrint.id } })).status,
      ).toBe('failed');
      expect((await prisma.defectBag.findUniqueOrThrow({ where: { id: defect.id } })).status).toBe(
        'weighed',
      );
    } finally {
      await prisma.defectBagLabelPrintJob.deleteMany({ where: { defectBagId: defect.id } });
      await prisma.bigBagLabelPrintJob.deleteMany({ where: { bigBagId: bag.id } });
      await prisma.palletPrintJob.deleteMany({ where: { palletListDocumentId: document.id } });
      await prisma.gatewayCommand.deleteMany({ where: { id: { in: commandIds } } });
      await prisma.defectBag.delete({ where: { id: defect.id } });
      await prisma.bigBagUnit.delete({ where: { id: bag.id } });
      // Immutable pallet token/document and audit facts remain until guarded schema teardown.
    }
  });
});
