import { Prisma, PrismaClient, Role } from '@prisma/client';
import { seedCanonicalPilotTemplates } from './canonical-pilot-templates';

export const PILOT_DEMO_RESET_CONFIRMATION = 'RESET_PILOT_DEMO_DATA';

export const PILOT_RUNTIME_ADVISORY_LOCK_QUERY =
  "WITH advisory_lock AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtextextended('plenka:pilot-demo-reset', 0))) SELECT 1::int AS locked FROM advisory_lock";

export const PILOT_RUNTIME_MAINTENANCE_STATEMENTS = [
  "SET LOCAL lock_timeout = '5s'",
  "SET LOCAL statement_timeout = '115s'",
  "SET LOCAL idle_in_transaction_session_timeout = '115s'",
] as const;

export const PILOT_RUNTIME_PREPARE_STATEMENTS = [
  'UPDATE "warehouse_rolls" SET "currentCoverageFactId" = NULL WHERE "currentCoverageFactId" IS NOT NULL',
  'UPDATE "roll_dispatch_items" SET "replacesDispatchItemId" = NULL WHERE "replacesDispatchItemId" IS NOT NULL',
  'UPDATE "weight_captures" SET "supersedesCaptureId" = NULL WHERE "supersedesCaptureId" IS NOT NULL',
] as const;

/**
 * Runtime projections only. Reference catalogs, topology, accounts, access policy, warehouse
 * raw-material facts and the append-only DomainEvent ledger are deliberately absent.
 *
 * Ordering is child-before-parent for every Restrict FK in schema.prisma. The one optional
 * warehouse-roll ↔ coverage-fact cycle is broken by PILOT_RUNTIME_PREPARE_STATEMENTS.
 */
export const PILOT_RUNTIME_DELETE_TABLES = [
  'notification_receipts',
  'big_bag_label_print_jobs',
  'big_bag_movements',
  'big_bag_scan_tokens',
  'warehouse_coverage_commands',
  'warehouse_coverage_recheck_memberships',
  'warehouse_coverage_matches',
  'warehouse_cover_matches',
  'order_resolution_cases',
  'production_problems',
  'roll_scan_tokens',
  'label_print_reconciliations',
  'defect_records',
  'warehouse_roll_coverage_facts',
  'weight_captures',
  'label_print_jobs',
  'operator_roll_operations',
  'warehouse_operations',
  'shift_bag_usages',
  'pallet_print_reconciliations',
  'pallet_print_jobs',
  'pallet_scan_tokens',
  'pallet_list_documents',
  'warehouse_pallet_commands',
  'warehouse_pallet_items',
  'warehouse_pallets',
  'scan_rows',
  'warehouse_acceptance_tasks',
  'operator_roll_lines',
  'roll_dispatch_items',
  'machine_assignments',
  'operator_machine_changes',
  'operator_shift_machine_assignment_cancellation_commands',
  'operator_shift_machine_assignments',
  'operator_post_sessions',
  'shifts',
  'big_bag_units',
  'warehouse_rolls',
  'warehouse_cover_proposals',
  'warehouse_coverage_states',
  'production_orders',
  'warehouse_coverage_decisions',
  'warehouse_coverage_calculations',
  'recipe_snapshot_versions',
  'recipe_snapshots',
  'commercial_order_positions',
  'payment_operations',
  'payment_schedules',
  'payment_policy_stages',
  'payment_policies',
  'finance_payment_update_commands',
  'finance_payment_correction_commands',
  'source_snapshots',
  'sync_journals',
  'finance_orders',
  'commercial_order_amendment_commands',
  'commercial_orders',
  'counterparty_order_template_versions',
  'stock_production_template_versions',
  'counterparty_order_templates',
  'stock_production_templates',
  'onec_stock_push_operations',
  'director_decisions',
  'penalties',
  'operational_checks',
  'operational_incidents',
  'gateway_commands',
  'gateway_events',
  'sessions',
] as const;

const PILOT_RUNTIME_TRIGGER_TABLES = [
  'roll_scan_tokens',
  'pallet_scan_tokens',
  'pallet_print_reconciliations',
  'label_print_reconciliations',
  'production_problems',
  'defect_records',
  'warehouse_roll_coverage_facts',
  'warehouse_coverage_calculations',
  'warehouse_coverage_matches',
  'warehouse_coverage_decisions',
  'warehouse_coverage_commands',
  'warehouse_coverage_recheck_memberships',
  'warehouse_pallet_commands',
  'warehouse_rolls',
  'warehouse_acceptance_tasks',
  'scan_rows',
] as const;

export const PILOT_RUNTIME_DISABLE_TRIGGER_STATEMENTS = PILOT_RUNTIME_TRIGGER_TABLES.map(
  (table) => `ALTER TABLE "${table}" DISABLE TRIGGER USER`,
);

export const PILOT_RUNTIME_ENABLE_TRIGGER_STATEMENTS = [...PILOT_RUNTIME_TRIGGER_TABLES]
  .reverse()
  .map((table) => `ALTER TABLE "${table}" ENABLE TRIGGER USER`);

export const PILOT_RUNTIME_FINALIZE_STATEMENTS = [
  'UPDATE "warehouse_coverage_inventory_epochs" SET "epoch" = "epoch" + 1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 1',
] as const;

const DEMO_ORDER_ID = 'demo-order-001';
const DEMO_POSITION_ID = 'demo-position-001';
const DEMO_PRODUCTION_ID = 'demo-production-001';
const DEMO_FINANCE_ID = 'demo-finance-001';
const DEMO_SHIFT_ID = 'demo-shift-001';
const DEMO_ASSIGNMENT_ID = 'demo-assignment-001';
const DEMO_DISPATCH_ID = 'demo-dispatch-001';
const DEMO_OPERATOR_LINE_ID = 'demo-operator-line-001';
const PREFERRED_COUNTERPARTY_ID = 'pilot-test-counterparty';
const DEMO_ORDER_NUMBER = 'DEMO-001';
const DEMO_FILM_NAME = 'Пленка полиэтиленовая полотно 80 мкм 1700 мм 275 м';
const PREFERRED_MATERIAL_ID = 'pilot-rm-pvd-15803';
const DEMO_OPERATOR_EXTERNAL_ID = 'seed-operator-2';
const DEMO_POST_CODE = 'POST-1';

type ResetClient = Pick<PrismaClient, '$transaction'>;

export type PilotDemoResetResult = {
  resetEventId: string;
  orderId: string;
  orderNumber: string;
  rollCount: number;
  removedRows: number;
};

export class PilotDemoResetError extends Error {
  constructor(message: string) {
    super(`Pilot demo reset: ${message}`);
    this.name = 'PilotDemoResetError';
  }
}

export async function resetPilotDemoData(
  prisma: ResetClient,
  confirmation: string | undefined,
  appEnvironment: string | undefined,
  seedProfile: string | undefined,
): Promise<PilotDemoResetResult> {
  if (appEnvironment !== 'pilot' || seedProfile !== 'pilot') {
    throw new PilotDemoResetError(
      'available only for the pilot profile (APP_ENV=pilot and SEED_PROFILE=pilot)',
    );
  }
  if (confirmation !== PILOT_DEMO_RESET_CONFIRMATION) {
    throw new PilotDemoResetError(`confirmation must equal ${PILOT_DEMO_RESET_CONFIRMATION}`);
  }

  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(PILOT_RUNTIME_ADVISORY_LOCK_QUERY);
      for (const statement of PILOT_RUNTIME_MAINTENANCE_STATEMENTS) {
        await tx.$executeRawUnsafe(statement);
      }
      const admin = await tx.user.findFirst({
        where: { role: Role.admin, isActive: true },
        orderBy: [{ id: 'asc' }],
        select: { id: true },
      });
      if (!admin) {
        throw new PilotDemoResetError(
          'an active admin account is required for the immutable audit marker',
        );
      }
      const operator = await tx.user.findFirst({
        where: {
          externalId: DEMO_OPERATOR_EXTERNAL_ID,
          role: Role.operator,
          isActive: true,
        },
        select: { id: true, displayName: true },
      });
      if (!operator) {
        throw new PilotDemoResetError(
          `active operator ${DEMO_OPERATOR_EXTERNAL_ID} is required for the test roll`,
        );
      }
      const post = await tx.post.findUnique({
        where: { code: DEMO_POST_CODE },
        select: { id: true, code: true, name: true, status: true },
      });
      if (!post || post.status !== 'active') {
        throw new PilotDemoResetError(
          `active post ${DEMO_POST_CODE} is required for the test roll`,
        );
      }
      const preferredMaterial = await tx.rawMaterialStock.findUnique({
        where: { materialId: PREFERRED_MATERIAL_ID },
        select: { materialId: true, label: true },
      });
      const material =
        preferredMaterial ??
        (await tx.rawMaterialStock.findFirst({
          orderBy: [{ materialId: 'asc' }],
          select: { materialId: true, label: true },
        }));
      if (!material) {
        throw new PilotDemoResetError(
          'warehouse raw-material catalog is empty; refusing to invent a stock fact',
        );
      }
      const preferredCounterparty = await tx.counterparty.findUnique({
        where: { id: PREFERRED_COUNTERPARTY_ID },
        select: { id: true },
      });
      const counterparty =
        preferredCounterparty ??
        (await tx.counterparty.findFirst({
          orderBy: [{ id: 'asc' }],
          select: { id: true },
        }));
      if (!counterparty) {
        throw new PilotDemoResetError(
          'counterparty catalog is empty; refusing to invent a reference object',
        );
      }

      // This command must run as the database owner with API/web stopped. USER triggers encode
      // runtime immutability and cross-row workflow checks; disabling only USER triggers keeps
      // PostgreSQL FK constraint triggers active. Every ALTER is transaction-scoped: any failure
      // rolls both the data and trigger state back.
      for (const statement of PILOT_RUNTIME_DISABLE_TRIGGER_STATEMENTS) {
        await tx.$executeRawUnsafe(statement);
      }
      for (const statement of PILOT_RUNTIME_PREPARE_STATEMENTS) {
        await tx.$executeRawUnsafe(statement);
      }

      let removedRows = 0;
      for (const table of PILOT_RUNTIME_DELETE_TABLES) {
        removedRows += await tx.$executeRawUnsafe(`DELETE FROM "${table}"`);
      }
      await seedCanonicalPilotTemplates(tx, {
        counterpartyId: counterparty.id,
        createdById: admin.id,
      });
      const order = await tx.commercialOrder.create({
        data: {
          id: DEMO_ORDER_ID,
          orderNumber: DEMO_ORDER_NUMBER,
          clientRequestId: '00000000-0000-4000-8000-00000000d001',
          title: 'Демонстрационный заказ клиента',
          creatorRole: Role.commercial,
          counterpartyId: counterparty.id,
          requestType: 'client_order',
          productionIndicator: 'in_production',
          warehouseCoverStatus: 'needs_production',
          paymentStatus: 'unpaid',
          shipmentStatus: 'not_shipped',
          commercialStage: 'sent_to_finance',
          sentToFinanceAt: new Date(),
          positions: {
            create: {
              id: DEMO_POSITION_ID,
              rollCount: 1,
              filmType: DEMO_FILM_NAME,
              actualThickness: '80 мкм',
              accountingThickness: '80 мкм',
              widthMm: 1700,
              plannedLengthM: 275,
              rawMaterialId: material.materialId,
              spoolType: 'Шпуля 76 мм',
              birka: 'DEMO',
              manualBirka: 'Маркировка А-17',
              comment: 'Заказ для демонстрации полного производственного контура',
              plannedWeightKg: 42.3,
              warehouseCoverStatus: 'needs_production',
              recipe: {
                create: {
                  parameters: [
                    { label: 'Номенклатура', value: DEMO_FILM_NAME },
                    { label: 'Сырьё', value: material.label },
                    { label: 'Ширина', value: '1700 мм' },
                    { label: 'Длина', value: '275 м' },
                  ],
                  source: 'commercial_form',
                  createdBy: 'pilot-demo-reset',
                },
              },
            },
          },
        },
        include: { positions: { select: { id: true } } },
      });
      const position = order.positions.find((candidate) => candidate.id === DEMO_POSITION_ID);
      if (!position) {
        throw new PilotDemoResetError('DEMO-001 position was not created');
      }

      const productionOrder = await tx.productionOrder.create({
        data: {
          id: DEMO_PRODUCTION_ID,
          commercialOrderId: order.id,
          indicator: 'in_production',
          approvalState: 'approved',
        },
      });

      const shift = await tx.shift.create({
        data: {
          id: DEMO_SHIFT_ID,
          label: 'Тест физических устройств',
          plannedStartAt: null,
          plannedEndAt: null,
          status: 'planned',
        },
      });
      await tx.operatorShiftMachineAssignment.create({
        data: {
          id: DEMO_ASSIGNMENT_ID,
          shiftId: shift.id,
          operatorId: operator.id,
          postId: post.id,
          status: 'planned',
          createdById: admin.id,
        },
      });

      const dispatchRows = [
        {
          id: DEMO_DISPATCH_ID,
          rollCode: `${DEMO_ORDER_NUMBER}-roll-1`,
          productionOrderId: productionOrder.id,
          orderLineId: position.id,
          positionSequence: 1,
          rawMaterialId: material.materialId,
          recipeVersion: 'v1',
          filmType: DEMO_FILM_NAME,
          widthMm: 1700,
          plannedLengthM: 275,
          plannedWeightKg: 42.3,
          characteristicsSnapshot: {
            nomenclature: DEMO_FILM_NAME,
            actualThickness: '80 мкм',
            accountingThickness: '80 мкм',
            widthMm: 1700,
            plannedLengthM: 275,
            manualBirka: 'Маркировка А-17',
            rawMaterial: material.label,
          },
          assignedOperatorId: operator.id,
          machineId: post.code,
          postId: post.id,
          plannedShiftId: shift.id,
          queueRank: 1,
          priority: 99,
          status: 'assigned',
        },
      ];
      await tx.rollDispatchItem.createMany({ data: dispatchRows });
      await tx.operatorRollLine.create({
        data: {
          id: DEMO_OPERATOR_LINE_ID,
          rollDispatchItemId: DEMO_DISPATCH_ID,
          sequence: 1,
          planKg: 42.3,
          step: 'assigned',
        },
      });

      await tx.financeOrder.create({
        data: {
          id: DEMO_FINANCE_ID,
          commercialOrderId: order.id,
          invoiceStatus: 'invoiced',
          paymentStatus: 'unpaid',
          amountValue: 250_000,
          amountLabel: '250 000 ₽',
          paymentTermsType: 'postpay_100_30d',
          invoiceIssuedAt: new Date(),
          sourceStatus: 'ready',
        },
      });

      for (const statement of PILOT_RUNTIME_FINALIZE_STATEMENTS) {
        const updated = await tx.$executeRawUnsafe(statement);
        if (updated !== 1) {
          throw new PilotDemoResetError('coverage inventory epoch singleton is missing');
        }
      }
      for (const statement of PILOT_RUNTIME_ENABLE_TRIGGER_STATEMENTS) {
        await tx.$executeRawUnsafe(statement);
      }

      const resetEvent = await tx.domainEvent.create({
        data: {
          family: 'audit',
          type: 'audit:pilot_demo_reset',
          objectId: DEMO_ORDER_NUMBER,
          actorKind: 'user',
          actorRole: Role.admin,
          actorId: admin.id,
          systemActorKey: null,
          label: 'Пилотные данные очищены и DEMO-001 создан',
          detail: {
            orderId: order.id,
            orderNumber: DEMO_ORDER_NUMBER,
            positionCount: 1,
            rollCount: dispatchRows.length,
            testOperatorId: operator.id,
            testOperatorName: operator.displayName,
            testPostCode: post.code,
            removedRows,
            immutableAuditPreserved: true,
          },
          reason: 'Подготовка чистого контура к демонстрации заказчику',
        },
      });

      return {
        resetEventId: resetEvent.id,
        orderId: order.id,
        orderNumber: DEMO_ORDER_NUMBER,
        rollCount: dispatchRows.length,
        removedRows,
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 120_000,
    },
  );
}
