import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import type { AuditService } from '../src/common/audit/audit.service';
import { OrderFulfillmentHandoffService } from '../src/common/order-fulfillment/order-fulfillment-handoff.service';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import { OperatorPhysicalService } from '../src/modules/operator/operator-physical.service';
import { WarehouseIntakeIntegrityService } from '../src/modules/warehouse/warehouse-intake-integrity.service';
import { WarehouseOperationService } from '../src/modules/warehouse/warehouse-operation.service';
import { WarehouseService } from '../src/modules/warehouse/warehouse.service';
import { createSealedPhysicalPalletEvidenceFixture } from './warehouse-pallet-e2e-fixture';
import {
  canonicalizeRollCoverageSpec,
  fingerprintRollFact,
} from '../src/modules/warehouse-coverage/warehouse-coverage-canonical';
import { WarehouseRollCoverageFactService } from '../src/modules/warehouse-coverage/warehouse-roll-coverage-fact.service';

const FINGERPRINT = 'a'.repeat(64);
const SYSTEM_ACTOR = 'warehouse_coverage_engine';

describe('Warehouse production-handover coverage fact (e2e, PostgreSQL)', () => {
  jest.setTimeout(60_000);

  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('links V2 handover provenance, freezes recipes, and rejects ambiguous evidence', async () => {
    const suffix = randomUUID();
    const operator = await prisma.user.findFirstOrThrow({
      where: { role: 'operator', isActive: true },
      select: { id: true },
    });
    const warehouse = await prisma.user.findFirstOrThrow({
      where: { role: 'warehouse', isActive: true },
      select: { id: true },
    });
    const warehouseActor = {
      userId: warehouse.id,
      role: 'warehouse',
      capabilities: ['warehouse_coverage:resolve_recheck'],
    } as const;
    const counterparty = await prisma.counterparty.create({
      data: {
        displayName: `Coverage handover ${suffix}`,
      },
    });
    const order = await prisma.commercialOrder.create({
      data: {
        orderNumber: `COVERAGE-HANDOVER-${suffix}`,
        creatorRole: 'commercial',
        counterpartyId: counterparty.id,
        warehouseCoverageWorkflowVersion: 2,
        positions: {
          create: {
            rollCount: 1,
            filmType: 'Полотно',
            actualThickness: '80 мкм',
            accountingThickness: '80 мкм',
            widthMm: 1_000,
            plannedLengthM: 100,
            spoolType: '76 мм',
            birka: 'Бирка 1',
            plannedWeightKg: 275,
            recipe: {
              create: {
                parameters: {},
                source: 'commercial_form',
                createdBy: operator.id,
                version: 'v7',
                recipeDefinitionId: `recipe-definition-${suffix}`,
                recipeDefinitionVersionId: `recipe-definition-version-${suffix}`,
                recipeVersionNumber: 7,
                ingredients: [
                  { rawMaterialDefinitionId: 'material-a', shareBasisPoints: 8_000 },
                  { rawMaterialDefinitionId: 'material-b', shareBasisPoints: 2_000 },
                ],
              },
            },
          },
        },
      },
      include: { positions: { include: { recipe: true } } },
    });
    const position = order.positions[0]!;
    const [{ epoch }] = await prisma.$queryRaw<Array<{ epoch: bigint }>>`
      SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1
    `;
    const calculationId = `coverage-handover-calculation-${suffix}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "warehouse_coverage_calculations" (
         "id", "orderId", "generation", "orderVersion", "positionVersions",
         "orderFingerprint", "inventoryEpoch", "inventoryFingerprint", "inputFingerprint",
         "algorithmVersion", "policyVersion", "availability", "reasonCodes",
         "requiredRollCount", "matchedRollCount", "uncertainRollCount",
         "verifiedCandidateRollIds", "uncertainCandidateRollIds", "systemActorKey"
       ) VALUES (
         $1, $2, 1, 1, $3::jsonb, $4, $5, $4, $4,
         'warehouse-coverage-matching/v1', 'warehouse-coverage-policy/v1',
         'unavailable', '["no_compatible_rolls"]'::jsonb,
         1, 0, 0, '[]'::jsonb, '[]'::jsonb, $6
       )`,
      calculationId,
      order.id,
      JSON.stringify([{ positionId: position.id, version: 1 }]),
      FINGERPRINT,
      epoch,
      SYSTEM_ACTOR,
    );
    const decisionId = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "warehouse_coverage_decisions" (
         "id", "orderId", "calculationId", "generation", "kind",
         "inputFingerprint", "sourceInventoryEpoch", "expectedRollCount",
         "actorKind", "systemActorKey"
       ) VALUES (
         $1::uuid, $2, $3, 1, 'auto_produce_all', $4, $5, 0, 'system', $6
       )`,
      decisionId,
      order.id,
      calculationId,
      FINGERPRINT,
      epoch,
      SYSTEM_ACTOR,
    );
    await prisma.warehouseCoverageState.create({
      data: {
        orderId: order.id,
        state: 'production_required',
        stateVersion: 1,
        generation: 1,
        currentCalculationId: calculationId,
        currentDecisionId: decisionId,
      },
    });
    const production = await prisma.productionOrder.create({
      data: {
        commercialOrderId: order.id,
        approvalState: 'approved',
        sourceCoverageCalculationId: calculationId,
        sourceCoverageDecisionId: decisionId,
        sourceCoverageInputFingerprint: FINGERPRINT,
        sourceCoverageGeneration: 1,
      },
    });
    const rollCode = `COVERAGE-HANDOVER-ROLL-${suffix}`;
    const dispatch = await prisma.rollDispatchItem.create({
      data: {
        rollCode,
        productionOrderId: production.id,
        orderLineId: position.id,
        recipeVersion: 'v7',
        plannedWeightKg: 275,
        status: 'assigned',
        characteristicsSnapshot: {
          filmType: 'Полотно',
          actualThickness: '80 мкм',
          accountingThickness: '80 мкм',
          widthMm: 1_000,
          plannedLengthM: 100,
          birka: 'Бирка 1',
          spoolType: '76 мм',
          recipeId: position.recipe!.id,
          recipeDefinitionId: `recipe-definition-${suffix}`,
          recipeDefinitionVersionId: `recipe-definition-version-${suffix}`,
          recipeVersionNumber: 7,
          ingredients: [
            { rawMaterialDefinitionId: 'material-a', shareBasisPoints: 8_000 },
            { rawMaterialDefinitionId: 'material-b', shareBasisPoints: 2_000 },
          ],
        },
        operatorLine: {
          create: {
            step: 'handover',
            labelState: 'verified',
            warehouseState: 'not_ready',
            planKg: 275,
          },
        },
      },
      include: {
        productionOrder: {
          include: { commercialOrder: { include: { counterparty: true } } },
        },
        operatorLine: true,
      },
    });
    const line = dispatch.operatorLine!;
    const capture = await prisma.weightCapture.create({
      data: {
        operatorRollLineId: line.id,
        kind: 'roll',
        stable: true,
        grossKg: 276,
        spoolKg: 1,
        netKg: 275,
        actorRole: 'operator',
        actorId: operator.id,
      },
    });
    const lockedLine = {
      ...line,
      rollDispatchItem: dispatch,
    };
    const audit = {
      record: jest.fn().mockResolvedValue({ id: 'not-persisted-by-this-focused-proof' }),
    } as unknown as AuditService;
    const factService = new WarehouseRollCoverageFactService(
      prisma as unknown as PrismaService,
      audit,
    );
    const operatorOperations = {
      claim: jest.fn().mockResolvedValue({
        kind: 'claimed',
        operation: { id: `operation-${suffix}` },
      }),
      complete: jest.fn(),
    };
    const service = new OperatorPhysicalService(
      prisma as unknown as PrismaService,
      audit,
      {
        lockOwned: jest.fn().mockResolvedValue({
          session: { id: `session-${suffix}`, postId: `post-${suffix}` },
          line: lockedLine,
        }),
      } as never,
      {} as never,
      operatorOperations as never,
      {} as never,
      factService,
      { returnDefectSpool: jest.fn() } as never,
      {} as never,
      {} as never,
      { report: jest.fn() } as never,
    );

    const receivingTask = await service.handover(
      { userId: operator.id, role: 'operator' },
      rollCode,
      {
        operationKey: randomUUID(),
      },
    );
    expect(receivingTask).toEqual(
      expect.objectContaining({ orderId: order.id, mode: 'receiving' }),
    );

    const warehouseRoll = await prisma.warehouseRoll.findUniqueOrThrow({
      where: { rollCode },
      include: { currentCoverageFact: true },
    });
    expect(warehouseRoll).toMatchObject({
      producedForOrderId: order.id,
      producedForPositionId: position.id,
      producedByCoverageDecisionId: decisionId,
      reservedForOrderId: null,
      reservedForPositionId: null,
      reservedByCoverageDecisionId: null,
      currentCoverageFact: {
        source: 'production_handover',
        sourceDispatchItemId: dispatch.id,
        sourceWeightCaptureId: capture.id,
      },
    });
    const frozenFact = warehouseRoll.currentCoverageFact!;
    await expect(
      prisma.warehouseRoll.update({
        where: { id: warehouseRoll.id },
        data: { producedForPositionId: null },
      }),
    ).rejects.toThrow();

    const warehousePost = await prisma.post.create({
      data: {
        code: `COVERAGE-WAREHOUSE-${suffix}`,
        name: 'Coverage warehouse e2e',
        status: 'active',
      },
    });
    const warehouseSession = await prisma.session.create({
      data: {
        userId: warehouse.id,
        tokenHash: `coverage-session-${suffix}`,
        expiresAt: new Date(Date.now() + 60_000),
        warehousePostId: warehousePost.id,
        warehousePostBoundAt: new Date(),
      },
    });
    const scannerDevice = await prisma.deviceRuntime.create({
      data: {
        code: `COVERAGE-SCANNER-${suffix}`,
        label: 'Coverage scanner e2e',
        kind: 'scanner',
        ownerRole: 'warehouse',
        status: 'ready',
        postId: warehousePost.id,
      },
    });
    const warehouseOperations = new WarehouseOperationService();
    const warehousePallets = {
      prepareOpenPallet: jest.fn().mockResolvedValue({
        id: `coverage-pallet-${suffix}`,
        palletCode: `PAL-COVERAGE-${suffix}`,
        orderId: order.id,
        sequenceNo: 1,
      }),
      attachAcceptedRoll: jest.fn().mockResolvedValue({ position: 1 }),
      assertNoOpenItems: jest.fn(),
    };
    const warehouseIntegrity = new WarehouseIntakeIntegrityService(
      prisma as unknown as PrismaService,
      audit,
      {
        findExact: jest.fn().mockResolvedValue({ rollCode }),
      } as never,
      {
        resolveSession: jest.fn().mockResolvedValue({
          session: warehouseSession,
          post: warehousePost,
        }),
        resolve: jest.fn().mockResolvedValue({
          session: warehouseSession,
          post: warehousePost,
          device: scannerDevice,
        }),
      } as never,
      warehouseOperations,
      {
        projectTaskById: jest.fn().mockResolvedValue({ id: receivingTask.id }),
      } as never,
      {} as never,
      {
        parse: jest.fn().mockReturnValue({ token: `coverage-token-${suffix}`, valid: true }),
      },
      { read: jest.fn() },
      {
        signal: jest.fn(),
        resolve: jest.fn(),
      } as never,
      warehousePallets as never,
      { setSelection: jest.fn() } as never,
    );
    await expect(
      warehouseIntegrity.scan(
        {
          userId: warehouse.id,
          role: 'warehouse',
          sessionId: warehouseSession.id,
          sessionPurpose: 'full',
          capabilities: ['warehouse:scan'],
        },
        receivingTask.id,
        {
          operationKey: randomUUID(),
          payload: `coverage-token-${suffix}`,
        },
      ),
    ).resolves.toMatchObject({
      taskId: receivingTask.id,
      rollCode,
      mode: 'receiving',
      scanStatus: 'accepted',
    });
    const acceptedRow = await prisma.scanRow.findFirstOrThrow({
      where: { taskId: receivingTask.id, rollCode },
      select: { id: true, rollCode: true, lastScanAt: true },
    });
    await createSealedPhysicalPalletEvidenceFixture(
      prisma,
      { id: receivingTask.id, orderId: order.id, rows: [acceptedRow] },
      warehouse.id,
    );

    const fulfillment = new OrderFulfillmentHandoffService(
      prisma as unknown as PrismaService,
      audit,
    );
    const warehouseService = new WarehouseService(
      prisma as unknown as PrismaService,
      audit,
      {
        activatePostDeliveryPayments: jest.fn(),
      } as never,
      fulfillment,
      warehouseOperations,
      warehousePallets as never,
    );
    await expect(
      warehouseService.closeTask({ userId: warehouse.id, role: 'warehouse' }, receivingTask.id, {
        mode: 'full',
      }),
    ).resolves.toEqual(expect.objectContaining({ id: receivingTask.id, status: 'closed' }));
    await expect(
      prisma.commercialOrder.findUniqueOrThrow({
        where: { id: order.id },
        select: { readyForShipmentAt: true },
      }),
    ).resolves.toEqual({ readyForShipmentAt: expect.any(Date) });
    await expect(
      prisma.warehouseAcceptanceTask.findFirst({
        where: { orderId: order.id, mode: 'delivery' },
        select: { id: true, status: true },
      }),
    ).resolves.toEqual(expect.objectContaining({ id: expect.any(String), status: 'open' }));
    await expect(
      prisma.warehouseRoll.findUniqueOrThrow({
        where: { id: warehouseRoll.id },
        select: {
          warehouseStatus: true,
          producedForOrderId: true,
          producedForPositionId: true,
          producedByCoverageDecisionId: true,
        },
      }),
    ).resolves.toEqual({
      warehouseStatus: 'received',
      producedForOrderId: order.id,
      producedForPositionId: position.id,
      producedByCoverageDecisionId: decisionId,
    });

    await prisma.recipeSnapshot.update({
      where: { id: position.recipe!.id },
      data: {
        version: 'v8',
        recipeVersionNumber: 8,
        ingredients: [{ rawMaterialDefinitionId: 'material-c', shareBasisPoints: 10_000 }],
      },
    });

    const afterCorrection = await prisma.warehouseRollCoverageFact.findUniqueOrThrow({
      where: { id: frozenFact.id },
    });
    expect(afterCorrection).toEqual(frozenFact);
    await expect(
      prisma.$transaction((tx) =>
        factService.appendProductionHandoverFact(tx, {
          rollId: warehouseRoll.id,
          sourceDispatchItemId: dispatch.id,
          sourceWeightCaptureId: capture.id,
        }),
      ),
    ).resolves.toEqual({ factId: frozenFact.id, version: 1 });
    await expect(
      prisma.warehouseRollCoverageFact.count({
        where: { sourceDispatchItemId: dispatch.id },
      }),
    ).resolves.toBe(1);

    const ambiguousRollCode = `COVERAGE-HANDOVER-AMBIGUOUS-${suffix}`;
    const ambiguousDispatch = await prisma.rollDispatchItem.create({
      data: {
        rollCode: ambiguousRollCode,
        productionOrderId: production.id,
        orderLineId: position.id,
        recipeVersion: 'v7',
        plannedWeightKg: 275,
        status: 'assigned',
        characteristicsSnapshot: dispatch.characteristicsSnapshot!,
        operatorLine: {
          create: {
            step: 'handover',
            labelState: 'verified',
            warehouseState: 'not_ready',
            planKg: 275,
          },
        },
      },
      include: {
        productionOrder: {
          include: { commercialOrder: { include: { counterparty: true } } },
        },
        operatorLine: true,
      },
    });
    const ambiguousLine = ambiguousDispatch.operatorLine!;
    await prisma.weightCapture.createMany({
      data: [
        {
          operatorRollLineId: ambiguousLine.id,
          kind: 'roll',
          stable: true,
          netKg: 275,
          actorRole: 'operator',
          actorId: operator.id,
          createdAt: new Date('2026-07-25T08:00:00.000Z'),
        },
        {
          operatorRollLineId: ambiguousLine.id,
          kind: 'roll',
          stable: true,
          netKg: 276,
          actorRole: 'operator',
          actorId: operator.id,
          createdAt: new Date('2026-07-25T08:01:00.000Z'),
        },
      ],
    });
    const ambiguousWarehouseRoll = await prisma.warehouseRoll.create({
      data: {
        rollCode: ambiguousRollCode,
        warehouseStatus: 'not_ready',
        ownerCounterpartyId: counterparty.id,
      },
    });
    const staleSpec = canonicalizeRollCoverageSpec({
      rollCode: ambiguousRollCode,
      sourceOrderId: null,
      sourcePositionId: null,
      ownerCounterpartyId: counterparty.id,
      filmType: 'Полотно',
      actualThicknessMilliMicron: 80_000,
      accountingThicknessMilliMicron: 80_000,
      widthMilliMm: 1_000_000,
      plannedLengthMilliM: 100_000,
      birka: 'Бирка 1',
      spoolType: '76 мм',
      actualWeightMilliKg: 274_000,
      plannedWeightMilliKg: 275_000,
      ingredients: [
        { rawMaterialDefinitionId: 'material-a', shareBasisPoints: 8_000 },
        { rawMaterialDefinitionId: 'material-b', shareBasisPoints: 2_000 },
      ],
      recipeId: null,
      recipeVersion: null,
      recipeDefinitionId: null,
      recipeDefinitionVersionId: null,
      recipeVersionNumber: null,
      policyVersion: 'warehouse-coverage-policy/v2',
    });
    const staleFact = await prisma.warehouseRollCoverageFact.create({
      data: {
        rollId: ambiguousWarehouseRoll.id,
        version: 1,
        source: 'migration_backfill',
        specVersion: 'warehouse-roll-coverage/v1',
        specFingerprint: fingerprintRollFact(staleSpec),
        spec: staleSpec as unknown as Prisma.InputJsonValue,
        actorKind: 'system',
        systemActorKey: SYSTEM_ACTOR,
      },
    });
    await prisma.warehouseRoll.update({
      where: { id: ambiguousWarehouseRoll.id },
      data: { currentCoverageFactId: staleFact.id },
    });
    const ambiguousService = new OperatorPhysicalService(
      prisma as unknown as PrismaService,
      audit,
      {
        lockOwned: jest.fn().mockResolvedValue({
          session: { id: `session-ambiguous-${suffix}`, postId: `post-${suffix}` },
          line: {
            ...ambiguousLine,
            rollDispatchItem: ambiguousDispatch,
          },
        }),
      } as never,
      {} as never,
      {
        claim: jest.fn().mockResolvedValue({
          kind: 'claimed',
          operation: { id: `operation-ambiguous-${suffix}` },
        }),
        complete: jest.fn(),
      } as never,
      {} as never,
      factService,
      { returnDefectSpool: jest.fn() } as never,
      {} as never,
      {} as never,
      { report: jest.fn() } as never,
    );

    await expect(
      ambiguousService.handover({ userId: operator.id, role: 'operator' }, ambiguousRollCode, {
        operationKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'OPERATOR_V2_HANDOVER_PROVENANCE_REQUIRED',
      }),
    });
    await expect(
      prisma.warehouseRoll.findUniqueOrThrow({
        where: { id: ambiguousWarehouseRoll.id },
        select: {
          currentCoverageFactId: true,
          producedForOrderId: true,
          warehouseStatus: true,
        },
      }),
    ).resolves.toEqual({
      currentCoverageFactId: staleFact.id,
      producedForOrderId: null,
      warehouseStatus: 'not_ready',
    });
    await expect(
      prisma.warehouseRollCoverageFact.count({
        where: {
          rollId: ambiguousWarehouseRoll.id,
          source: 'production_handover',
        },
      }),
    ).resolves.toBe(0);

    const correctedSpec = canonicalizeRollCoverageSpec({
      ...staleSpec,
      actualWeightMilliKg: 273_500,
    });
    const correction = {
      rollId: ambiguousWarehouseRoll.id,
      expectedFactVersion: 1,
      nextSpec: correctedSpec,
      reason: 'Склад повторно проверил полный состав рулона',
    };
    const corrected = await prisma.$transaction((tx) =>
      factService.appendWarehouseCorrection(tx, correction, warehouseActor),
    );
    expect(corrected.version).toBe(2);
    await expect(
      prisma.warehouseRoll.findUniqueOrThrow({
        where: { id: ambiguousWarehouseRoll.id },
        select: {
          currentCoverageFactId: true,
          currentCoverageFact: { select: { id: true, version: true, spec: true } },
        },
      }),
    ).resolves.toEqual({
      currentCoverageFactId: corrected.factId,
      currentCoverageFact: {
        id: corrected.factId,
        version: 2,
        spec: correctedSpec,
      },
    });
    await expect(
      prisma.warehouseRollCoverageFact.findMany({
        where: { rollId: ambiguousWarehouseRoll.id },
        orderBy: { version: 'asc' },
        select: { id: true, version: true, source: true },
      }),
    ).resolves.toEqual([
      { id: staleFact.id, version: 1, source: 'migration_backfill' },
      { id: corrected.factId, version: 2, source: 'warehouse_recheck' },
    ]);

    await expect(
      prisma.$transaction((tx) =>
        factService.appendWarehouseCorrection(tx, correction, warehouseActor),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      prisma.warehouseRollCoverageFact.count({
        where: { rollId: ambiguousWarehouseRoll.id },
      }),
    ).resolves.toBe(2);
  });
});
