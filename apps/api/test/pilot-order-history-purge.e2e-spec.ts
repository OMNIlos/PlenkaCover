import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { POST_CATALOG_MIGRATION_SYSTEM_ACTOR_KEY } from '../src/common/audit/audit-actor';
import { InventoryProjectionService } from '../src/common/inventory/inventory-projection.service';
import {
  PALLET_LABEL_LAYOUT_CONTROL_SOURCE_ID,
  PALLET_LABEL_LAYOUT_CONTROL_SOURCE_LABEL,
} from '../src/common/pallet-label-layout/pallet-label-layout-validation-source';
import { ConfigurablePalletLabelRenderer } from '../src/common/pallet-label-layout/configurable-pallet-label.renderer';
import { PalletLabelLayoutPublicationService } from '../src/common/pallet-label-layout/pallet-label-layout-publication.service';
import {
  PILOT_ACCUMULATED_RUNTIME_EVENT_TYPES,
  PILOT_ACCUMULATED_RUNTIME_PURGE_CONFIRMATION,
  PILOT_ORDER_HISTORY_PURGE_CONFIRMATION,
  PILOT_ROLE_INBOX_EVENT_TYPES,
  purgePilotOrderHistory,
} from '../src/common/seed/pilot-order-history-purge';
import { PalletLabelLayoutEditorRenderer } from '../src/modules/admin/pallet-label-layout-editor.renderer';
import { PalletLabelLayoutEditorService } from '../src/modules/admin/pallet-label-layout-editor.service';
import { PUBLISHED_PALLET_LABEL_LAYOUT } from '../src/modules/admin/pallet-label-layout-editor.validator';
import {
  assertDisposableDatabaseTarget,
  assertSchemaDestructionTarget,
  createE2eSchemaName,
} from './e2e-database';

const API_ROOT = resolve(__dirname, '..');
const PRISMA_SCHEMA = resolve(API_ROOT, 'prisma/schema.prisma');
const NOW = new Date('2026-08-12T09:00:00.000Z');

function databaseUrlForSchema(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  const options = url.searchParams.getAll('options').filter(Boolean);
  url.searchParams.set('options', [...options, '-c timezone=UTC'].join(' '));
  return url.toString();
}

function migrate(databaseUrl: string): void {
  const result = spawnSync(
    process.execPath,
    [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', PRISMA_SCHEMA],
    {
      cwd: API_ROOT,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    },
  );
  if (result.status !== 0) {
    throw new Error(`isolated purge migration failed: ${result.stderr || result.stdout}`);
  }
}

async function deleteDisposableEvents(prisma: PrismaClient, ids: readonly string[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE "domain_events" DISABLE TRIGGER USER');
    try {
      await tx.domainEvent.deleteMany({ where: { id: { in: [...ids] } } });
    } finally {
      await tx.$executeRawUnsafe('ALTER TABLE "domain_events" ENABLE TRIGGER USER');
    }
  });
}

async function stableOneCFingerprint(prisma: PrismaClient): Promise<unknown> {
  const [row] = await prisma.$queryRawUnsafe<Array<{ fingerprint: unknown }>>(`
    SELECT jsonb_build_object(
      'snapshots', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM source_snapshots t
        WHERE t.id IN ('snapshot-reference-invoice', 'snapshot-subject-collision', 'snapshot-stock-reference')), '[]'),
      'runs', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM onec_sync_runs t), '[]'),
      'pushes', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM onec_stock_push_operations t), '[]'),
      'invoices', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t."externalId") FROM onec_invoices t WHERE t."externalId" IN ('invoice-reference', 'invoice-subject-reference')), '[]'),
      'invoiceLines', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM onec_invoice_lines t WHERE t."invoiceExternalId" IN ('invoice-reference', 'invoice-subject-reference')), '[]'),
      'payments', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t."externalId") FROM onec_payments t WHERE t."externalId" IN ('payment-reference', 'payment-subject-collision')), '[]'),
      'shipments', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t."externalId") FROM onec_shipments t WHERE t."externalId" IN ('shipment-reference', 'shipment-subject-collision')), '[]'),
      'shipmentLines', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM onec_shipment_lines t WHERE t."shipmentExternalId" IN ('shipment-reference', 'shipment-subject-collision')), '[]'),
      'production', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t."externalId") FROM onec_production_reports t), '[]'),
      'productionOutputs', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM onec_production_output_lines t), '[]'),
      'productionMaterials', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM onec_production_material_lines t), '[]'),
      'nomenclature', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t."externalId") FROM onec_nomenclature_items t), '[]'),
      'organizations', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t."externalId") FROM onec_organizations t), '[]'),
      'warehouses', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t."externalId") FROM onec_warehouses t), '[]'),
      'stock', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM onec_stock_balances t), '[]'),
      'journals', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM sync_journals t WHERE t.id = 'journal-reference'), '[]')
    ) AS fingerprint
  `);
  return row?.fingerprint;
}

describe('pilot order-history purge boundary (e2e, real PostgreSQL)', () => {
  let baseDatabaseUrl: string;
  let isolatedDatabaseUrl: string;
  let isolatedSchema: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    baseDatabaseUrl = process.env.DATABASE_URL ?? '';
    if (!baseDatabaseUrl) throw new Error('E2E DATABASE_URL is not configured');
    await assertDisposableDatabaseTarget(baseDatabaseUrl);
    isolatedSchema = createE2eSchemaName();
    isolatedDatabaseUrl = databaseUrlForSchema(baseDatabaseUrl, isolatedSchema);
    assertSchemaDestructionTarget(isolatedSchema, isolatedDatabaseUrl);
    migrate(isolatedDatabaseUrl);
    prisma = new PrismaClient({ datasourceUrl: isolatedDatabaseUrl });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (!isolatedSchema || !isolatedDatabaseUrl) return;
    assertSchemaDestructionTarget(isolatedSchema, isolatedDatabaseUrl);
    const admin = new PrismaClient({ datasourceUrl: baseDatabaseUrl });
    try {
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${isolatedSchema}" CASCADE`);
    } finally {
      await admin.$disconnect();
    }
  });

  it('rejects invoice, payment and source retry claim combinations without writing', async () => {
    const orderId = 'claim-preflight-order';
    const financeOrderId = 'claim-preflight-finance';
    await prisma.commercialOrder.create({
      data: {
        id: orderId,
        orderNumber: 'CLAIM-PREFLIGHT-ORDER',
        creatorRole: 'commercial',
      },
    });
    await prisma.financeOrder.create({
      data: { id: financeOrderId, commercialOrderId: orderId },
    });

    const claimCases = [
      {
        id: 'claim-invoice-normal',
        entity: 'invoice',
        status: 'retry_requested',
        activeScopeKey: `finance-invoice-sync:${financeOrderId}`,
        leaseExpiresAt: new Date('2999-01-01T00:00:00.000Z'),
      },
      {
        id: 'claim-payment-scope-only',
        entity: 'payment',
        status: 'ready',
        activeScopeKey: 'finance-payment-source-sync',
        leaseExpiresAt: null,
      },
      {
        id: 'claim-payment-status-only',
        entity: 'payment',
        status: 'retry_requested',
        activeScopeKey: null,
        leaseExpiresAt: null,
      },
      {
        id: 'claim-source-lease-only',
        entity: 'finance_order',
        status: 'error',
        activeScopeKey: null,
        leaseExpiresAt: new Date('2020-01-01T00:00:00.000Z'),
      },
      {
        id: 'claim-source-status-only',
        entity: 'finance_order',
        status: 'manual_review',
        activeScopeKey: null,
        leaseExpiresAt: null,
      },
    ] as const;

    try {
      for (const claim of claimCases) {
        await prisma.syncJournal.create({
          data: {
            ...claim,
            financeOrderId: claim.entity === 'payment' ? null : financeOrderId,
            ownerRole: 'finance',
          },
        });
        const before = {
          order: await prisma.commercialOrder.findUniqueOrThrow({ where: { id: orderId } }),
          finance: await prisma.financeOrder.findUniqueOrThrow({
            where: { id: financeOrderId },
          }),
          journal: await prisma.syncJournal.findUniqueOrThrow({ where: { id: claim.id } }),
        };

        await expect(
          purgePilotOrderHistory(
            prisma,
            PILOT_ORDER_HISTORY_PURGE_CONFIRMATION,
            'pilot',
            'pilot',
            'yes',
          ),
        ).rejects.toThrow('active or unresolved 1C journal claims must be completed or recovered');
        expect(await prisma.commercialOrder.findUniqueOrThrow({ where: { id: orderId } })).toEqual(
          before.order,
        );
        expect(
          await prisma.financeOrder.findUniqueOrThrow({ where: { id: financeOrderId } }),
        ).toEqual(before.finance);
        expect(await prisma.syncJournal.findUniqueOrThrow({ where: { id: claim.id } })).toEqual(
          before.journal,
        );
        await prisma.syncJournal.delete({ where: { id: claim.id } });
      }
    } finally {
      await prisma.syncJournal.deleteMany({
        where: { id: { in: claimCases.map(({ id }) => id) } },
      });
      await prisma.financeOrder.deleteMany({ where: { id: financeOrderId } });
      await prisma.commercialOrder.deleteMany({ where: { id: orderId } });
    }
  }, 120_000);

  it('aborts on a local FinanceOrder id colliding with legitimate 1C invoice identities', async () => {
    const orderId = 'identity-collision-order';
    const financeOrderId = '11111111-2222-4333-8444-555555555555';
    const eventIds = ['identity-collision-manual-import', 'identity-collision-legacy-retry'];
    await prisma.commercialOrder.create({
      data: {
        id: orderId,
        orderNumber: 'IDENTITY-COLLISION-ORDER',
        creatorRole: 'commercial',
      },
    });
    await prisma.financeOrder.create({
      data: { id: financeOrderId, commercialOrderId: orderId },
    });
    await prisma.oneCInvoice.create({
      data: {
        externalId: financeOrderId,
        number: 'INV-IDENTITY-COLLISION',
        total: 1,
        capturedAt: NOW,
      },
    });
    await prisma.sourceSnapshot.create({
      data: {
        id: 'identity-collision-snapshot',
        subjectType: 'invoice',
        externalId: financeOrderId,
        sourceKind: '1C',
        ownerRole: 'admin',
        checkedAt: NOW,
        staleness: 'fresh',
        parsed: { number: 'INV-IDENTITY-COLLISION' },
        rawPayload: { redacted: true },
      },
    });
    await prisma.domainEvent.createMany({
      data: [
        {
          id: eventIds[0],
          family: 'integration',
          type: 'integration.onec_imported',
          label: 'onec_import_invoice',
          detail: { subjectType: 'invoice', externalId: financeOrderId },
          actorRole: 'admin',
        },
        {
          id: eventIds[1],
          family: 'admin',
          type: 'admin.onec.import_requested',
          objectId: financeOrderId,
          detail: { subjectType: 'invoice', externalId: financeOrderId },
          actorRole: 'admin',
        },
      ],
    });

    try {
      const before = {
        order: await prisma.commercialOrder.findUniqueOrThrow({ where: { id: orderId } }),
        finance: await prisma.financeOrder.findUniqueOrThrow({ where: { id: financeOrderId } }),
        invoice: await prisma.oneCInvoice.findUniqueOrThrow({
          where: { externalId: financeOrderId },
        }),
        snapshot: await prisma.sourceSnapshot.findUniqueOrThrow({
          where: { id: 'identity-collision-snapshot' },
        }),
        events: await prisma.domainEvent.findMany({
          where: { id: { in: eventIds } },
          orderBy: { id: 'asc' },
        }),
      };

      await expect(
        purgePilotOrderHistory(
          prisma,
          PILOT_ORDER_HISTORY_PURGE_CONFIRMATION,
          'pilot',
          'pilot',
          'yes',
        ),
      ).rejects.toThrow('PILOT_PURGE_ONEC_INVOICE_IDENTITY_COLLISION');
      expect(await prisma.commercialOrder.findUniqueOrThrow({ where: { id: orderId } })).toEqual(
        before.order,
      );
      expect(
        await prisma.financeOrder.findUniqueOrThrow({ where: { id: financeOrderId } }),
      ).toEqual(before.finance);
      expect(
        await prisma.oneCInvoice.findUniqueOrThrow({ where: { externalId: financeOrderId } }),
      ).toEqual(before.invoice);
      expect(
        await prisma.sourceSnapshot.findUniqueOrThrow({
          where: { id: 'identity-collision-snapshot' },
        }),
      ).toEqual(before.snapshot);
      expect(
        await prisma.domainEvent.findMany({
          where: { id: { in: eventIds } },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(before.events);
    } finally {
      await deleteDisposableEvents(prisma, eventIds);
      await prisma.sourceSnapshot.deleteMany({ where: { id: 'identity-collision-snapshot' } });
      await prisma.oneCInvoice.deleteMany({ where: { externalId: financeOrderId } });
      await prisma.financeOrder.deleteMany({ where: { id: financeOrderId } });
      await prisma.commercialOrder.deleteMany({ where: { id: orderId } });
    }
  }, 120_000);

  it('aborts on an untyped non-UUID manual invoice request that collides with a FinanceOrder id', async () => {
    const orderId = 'manual-request-collision-order';
    const financeOrderId = 'finance-order-manual-request';
    const eventId = 'manual-request-collision-event';
    await prisma.commercialOrder.create({
      data: {
        id: orderId,
        orderNumber: 'MANUAL-REQUEST-COLLISION-ORDER',
        creatorRole: 'commercial',
      },
    });
    await prisma.financeOrder.create({
      data: { id: financeOrderId, commercialOrderId: orderId },
    });
    await prisma.domainEvent.create({
      data: {
        id: eventId,
        family: 'admin',
        type: 'admin.onec.import_requested',
        objectId: financeOrderId,
        detail: { subjectType: 'invoice', externalId: financeOrderId },
        actorRole: 'admin',
      },
    });

    try {
      const before = {
        order: await prisma.commercialOrder.findUniqueOrThrow({ where: { id: orderId } }),
        finance: await prisma.financeOrder.findUniqueOrThrow({ where: { id: financeOrderId } }),
        event: await prisma.domainEvent.findUniqueOrThrow({ where: { id: eventId } }),
      };

      await expect(
        purgePilotOrderHistory(
          prisma,
          PILOT_ORDER_HISTORY_PURGE_CONFIRMATION,
          'pilot',
          'pilot',
          'yes',
        ),
      ).rejects.toThrow('PILOT_PURGE_ONEC_INVOICE_IDENTITY_COLLISION');
      expect(await prisma.commercialOrder.findUniqueOrThrow({ where: { id: orderId } })).toEqual(
        before.order,
      );
      expect(
        await prisma.financeOrder.findUniqueOrThrow({ where: { id: financeOrderId } }),
      ).toEqual(before.finance);
      expect(await prisma.domainEvent.findUniqueOrThrow({ where: { id: eventId } })).toEqual(
        before.event,
      );
    } finally {
      await deleteDisposableEvents(prisma, [eventId]);
      await prisma.financeOrder.deleteMany({ where: { id: financeOrderId } });
      await prisma.commercialOrder.deleteMany({ where: { id: orderId } });
    }
  }, 120_000);

  it('deletes only order-linked 1C and event evidence while preserving stock/reference freshness', async () => {
    const user = await prisma.user.create({
      data: {
        id: 'purge-user',
        login: 'purge-owner',
        displayName: 'Purge owner',
        role: 'admin',
      },
    });
    await prisma.rawMaterialDefinition.create({
      data: {
        id: 'raw-definition',
        name: 'Reference resin',
        normalizedName: 'reference resin',
        kind: 'base',
        createdByRole: 'admin',
        externalId: 'nomenclature-reference',
        sourceUnit: 'kg',
      },
    });
    await prisma.rawMaterialStock.create({
      data: {
        id: 'raw-stock',
        materialId: 'raw-reference',
        label: 'Reference resin',
        actualQty: 5,
        externalId: 'collision-external-id',
        rawMaterialDefinitionId: 'raw-definition',
      },
    });
    await prisma.oneCNomenclatureItem.create({
      data: {
        externalId: 'nomenclature-reference',
        code: 'N-REF',
        name: 'Reference resin',
        capturedAt: NOW,
        rawMaterialDefinitionId: 'raw-definition',
      },
    });
    await prisma.oneCOrganization.create({
      data: {
        externalId: 'organization-reference',
        code: 'ORG-REF',
        name: 'Reference organization',
        capturedAt: NOW,
      },
    });
    await prisma.oneCWarehouse.create({
      data: {
        externalId: 'warehouse-reference',
        code: 'WH-REF',
        name: 'Reference warehouse',
        capturedAt: NOW,
      },
    });
    await prisma.oneCStockBalance.create({
      data: {
        id: 'stock-balance-reference',
        accountExternalId: 'account-reference',
        accountCode: '10.01',
        organizationExternalId: 'organization-reference',
        nomenclatureExternalId: 'nomenclature-reference',
        quantity: 5,
        amount: 500,
        capturedAt: NOW,
      },
    });

    const order = await prisma.commercialOrder.create({
      data: {
        id: 'commercial-order-target',
        orderNumber: 'PILOT-ORDER-42',
        stockBatchCode: 'COLLISION-BATCH-42',
        externalId: 'collision-external-id',
        creatorRole: 'commercial',
      },
    });
    const productionOrder = await prisma.productionOrder.create({
      data: { id: 'production-order-target', commercialOrderId: order.id },
    });
    const dispatch = await prisma.rollDispatchItem.create({
      data: {
        id: 'dispatch-target',
        rollCode: 'ROLL-TARGET-42',
        productionOrderId: productionOrder.id,
      },
    });
    const line = await prisma.operatorRollLine.create({
      data: { id: 'operator-line-target', rollDispatchItemId: dispatch.id },
    });
    await prisma.labelPrintJob.create({
      data: {
        id: 'label-submitted',
        operatorRollLineId: line.id,
        status: 'submitted',
      },
    });

    const financeOrder = await prisma.financeOrder.create({
      data: {
        id: 'finance-order-target',
        commercialOrderId: order.id,
        externalId: 'invoice-target',
      },
    });
    await prisma.paymentPolicy.create({
      data: {
        id: 'payment-policy-target',
        financeOrderId: financeOrder.id,
        installmentDays: 14,
        invoiceExternalId: 'invoice-target',
      },
    });
    await prisma.paymentReceipt.create({
      data: {
        id: 'receipt-target',
        externalId: 'payment-target',
        number: 'PAY-TARGET',
        amount: 125,
        currency: 'RUB',
        orderReference: 'PLENKA_ORDER=PILOT-ORDER-42',
        capturedAt: NOW,
      },
    });

    await prisma.sourceSnapshot.createMany({
      data: [
        {
          id: 'snapshot-order-invoice',
          financeOrderId: financeOrder.id,
          subjectType: 'invoice',
          externalId: 'invoice-target',
          sourceKind: '1C',
          ownerRole: 'finance',
          capturedAt: NOW,
          importedAt: NOW,
          checkedAt: NOW,
          staleness: 'fresh',
          parsed: { orderReference: 'PLENKA_ORDER=PILOT-ORDER-42' },
          rawPayload: { redacted: true },
          sourceFingerprint: 'snapshot-order-invoice-fingerprint',
        },
        {
          id: 'snapshot-order-subject-only',
          financeOrderId: financeOrder.id,
          subjectType: 'invoice',
          subjectId: 'invoice-subject-reference',
          sourceKind: '1C',
          ownerRole: 'finance',
          checkedAt: NOW,
          staleness: 'unknown',
          parsed: { orderReference: 'PLENKA_ORDER=PILOT-ORDER-42' },
          rawPayload: { redacted: true },
          sourceFingerprint: 'snapshot-order-subject-only-fingerprint',
        },
        {
          id: 'snapshot-order-payment-parsed-link',
          subjectType: 'payment',
          sourceKind: '1C',
          ownerRole: 'finance',
          checkedAt: NOW,
          staleness: 'unknown',
          parsed: { invoiceExternalId: 'invoice-target' },
          rawPayload: { redacted: true },
          sourceFingerprint: 'snapshot-order-payment-parsed-link-fingerprint',
        },
        {
          id: 'snapshot-order-shipment-parsed-link',
          subjectType: 'shipment',
          sourceKind: '1C',
          ownerRole: 'finance',
          checkedAt: NOW,
          staleness: 'unknown',
          parsed: { invoiceExternalId: 'invoice-target' },
          rawPayload: { redacted: true },
          sourceFingerprint: 'snapshot-order-shipment-parsed-link-fingerprint',
        },
        {
          id: 'snapshot-reference-invoice',
          subjectType: 'invoice',
          externalId: 'invoice-reference',
          sourceKind: '1C',
          ownerRole: 'finance',
          capturedAt: NOW,
          importedAt: NOW,
          checkedAt: NOW,
          staleness: 'fresh',
          parsed: { orderReference: 'ERP-UNRELATED' },
          rawPayload: { redacted: true },
          sourceFingerprint: 'snapshot-reference-invoice-fingerprint',
        },
        {
          id: 'snapshot-subject-collision',
          subjectType: 'invoice',
          externalId: 'invoice-subject-reference',
          sourceKind: '1C',
          ownerRole: 'finance',
          capturedAt: NOW,
          importedAt: NOW,
          checkedAt: NOW,
          staleness: 'fresh',
          parsed: { orderReference: 'ERP-SUBJECT-COLLISION' },
          rawPayload: { redacted: true },
          sourceFingerprint: 'snapshot-subject-collision-fingerprint',
        },
        {
          id: 'snapshot-stock-reference',
          subjectType: 'stock',
          externalId: 'collision-external-id',
          sourceKind: '1C',
          ownerRole: 'warehouse',
          capturedAt: NOW,
          importedAt: NOW,
          checkedAt: NOW,
          staleness: 'fresh',
          parsed: { qty: 5, unrelatedOrderLikeText: order.orderNumber },
          rawPayload: { batch: order.stockBatchCode },
          sourceFingerprint: 'snapshot-stock-reference-fingerprint',
        },
      ],
    });
    await prisma.oneCSyncRun.create({
      data: {
        id: 'sync-run-reference',
        mode: 'apply',
        status: 'completed',
        counters: { stock: 1, reference: 3 },
        completedAt: NOW,
        startedAt: NOW,
      },
    });
    await prisma.oneCStockPushOperation.create({
      data: {
        id: 'stock-push-reference',
        operationKey: randomUUID(),
        actorId: user.id,
        snapshotHash: 'a'.repeat(64),
        status: 'succeeded',
        safeResult: { documentId: 'stock-document-reference' },
        completedAt: NOW,
      },
    });
    await prisma.syncJournal.createMany({
      data: [
        {
          id: 'journal-order',
          financeOrderId: financeOrder.id,
          operationKey: '11111111-1111-4111-8111-111111111111',
          entity: 'invoice',
          status: 'ready',
          ownerRole: 'finance',
          sourceSnapshotId: 'snapshot-order-invoice',
        },
        {
          id: 'journal-reference',
          entity: 'stock',
          status: 'ready',
          ownerRole: 'warehouse',
          sourceSnapshotId: 'snapshot-stock-reference',
        },
      ],
    });

    await prisma.oneCInvoice.createMany({
      data: [
        {
          externalId: 'invoice-target',
          number: 'INV-TARGET',
          orderReference: 'PLENKA_ORDER=PILOT-ORDER-42',
          total: 125,
          capturedAt: NOW,
        },
        {
          externalId: 'invoice-reference',
          number: 'INV-REFERENCE',
          orderReference: 'ERP-UNRELATED',
          total: 250,
          capturedAt: NOW,
        },
        {
          externalId: 'invoice-subject-reference',
          number: 'INV-SUBJECT-COLLISION',
          orderReference: 'ERP-SUBJECT-COLLISION',
          total: 375,
          capturedAt: NOW,
        },
      ],
    });
    await prisma.oneCInvoiceLine.createMany({
      data: [
        {
          id: 'invoice-line-target',
          invoiceExternalId: 'invoice-target',
          lineNumber: 1,
          quantity: 1,
          price: 125,
          amount: 125,
        },
        {
          id: 'invoice-line-reference',
          invoiceExternalId: 'invoice-reference',
          lineNumber: 1,
          nomenclatureExternalId: 'nomenclature-reference',
          quantity: 2,
          price: 125,
          amount: 250,
        },
        {
          id: 'invoice-line-subject-collision',
          invoiceExternalId: 'invoice-subject-reference',
          lineNumber: 1,
          nomenclatureExternalId: 'nomenclature-reference',
          quantity: 3,
          price: 125,
          amount: 375,
        },
      ],
    });
    await prisma.oneCPayment.createMany({
      data: [
        {
          externalId: 'payment-target',
          number: 'PAY-TARGET',
          amount: 125,
          orderReference: 'PLENKA_ORDER=PILOT-ORDER-42',
          invoiceExternalId: 'invoice-target',
          capturedAt: NOW,
        },
        {
          externalId: 'payment-reference',
          number: 'PAY-REFERENCE',
          amount: 250,
          invoiceExternalId: 'invoice-reference',
          capturedAt: NOW,
        },
        {
          externalId: 'payment-subject-collision',
          number: 'PAY-SUBJECT-COLLISION',
          amount: 375,
          invoiceExternalId: 'invoice-subject-reference',
          capturedAt: NOW,
        },
      ],
    });
    await prisma.oneCShipment.createMany({
      data: [
        {
          externalId: 'shipment-target',
          number: 'SHIP-TARGET',
          total: 125,
          invoiceExternalId: 'invoice-target',
          capturedAt: NOW,
        },
        {
          externalId: 'shipment-reference',
          number: 'SHIP-REFERENCE',
          total: 250,
          invoiceExternalId: 'invoice-reference',
          capturedAt: NOW,
        },
        {
          externalId: 'shipment-subject-collision',
          number: 'SHIP-SUBJECT-COLLISION',
          total: 375,
          invoiceExternalId: 'invoice-subject-reference',
          capturedAt: NOW,
        },
      ],
    });
    await prisma.oneCShipmentLine.createMany({
      data: [
        {
          id: 'shipment-line-target',
          shipmentExternalId: 'shipment-target',
          lineNumber: 1,
          quantity: 1,
          price: 125,
          amount: 125,
        },
        {
          id: 'shipment-line-reference',
          shipmentExternalId: 'shipment-reference',
          lineNumber: 1,
          nomenclatureExternalId: 'nomenclature-reference',
          quantity: 2,
          price: 125,
          amount: 250,
        },
        {
          id: 'shipment-line-subject-collision',
          shipmentExternalId: 'shipment-subject-collision',
          lineNumber: 1,
          nomenclatureExternalId: 'nomenclature-reference',
          quantity: 3,
          price: 125,
          amount: 375,
        },
      ],
    });
    await prisma.oneCProductionReport.create({
      data: {
        externalId: 'production-reference',
        number: 'PROD-REFERENCE',
        organizationExternalId: 'organization-reference',
        warehouseExternalId: 'warehouse-reference',
        capturedAt: NOW,
        outputLines: {
          create: {
            id: 'production-output-reference',
            lineNumber: 1,
            nomenclatureExternalId: 'nomenclature-reference',
            quantity: 3,
          },
        },
        materialLines: {
          create: {
            id: 'production-material-reference',
            lineNumber: 1,
            nomenclatureExternalId: 'nomenclature-reference',
            quantity: 4,
          },
        },
      },
    });

    await prisma.palletListDocument.create({
      data: {
        id: 'layout-source-document',
        palletId: 'legacy-pallet-source',
        generatedByRole: 'warehouse',
      },
    });
    await prisma.palletLabelLayoutVersion.create({
      data: {
        id: 'layout-reference',
        profile: 'pallet-100x100-configurable-v7',
        version: 1,
        definition: PUBLISHED_PALLET_LABEL_LAYOUT,
        contentHash: createHash('sha256')
          .update(JSON.stringify(PUBLISHED_PALLET_LABEL_LAYOUT), 'utf8')
          .digest('hex'),
        sourceDocumentId: 'layout-source-document',
        publishedById: user.id,
        reason: 'Reference layout',
        activatedAt: NOW,
      },
    });
    await prisma.palletLabelLayoutPublishCommand.create({
      data: {
        id: 'layout-command-reference',
        operationKey: randomUUID(),
        requestFingerprint: 'c'.repeat(64),
        profile: 'pallet-100x100-configurable-v7',
        sourceDocumentId: 'layout-source-document',
        actorId: user.id,
        resultPublicationId: 'layout-reference',
        resultSnapshot: { id: 'layout-reference', hash: 'b'.repeat(64) },
      },
    });
    await prisma.palletPrintJob.create({
      data: {
        id: 'pallet-print-submitted',
        palletListDocumentId: 'layout-source-document',
        requestId: 'pallet-print-request-submitted',
        printerId: 'printer-reference',
        status: 'submitted',
      },
    });
    await prisma.bigBagUnit.create({
      data: {
        id: 'bigbag-reference',
        code: 'BIGBAG-REFERENCE',
        material: 'Reference resin',
        currentKg: 5,
        initialKg: 5,
        createdByRole: 'warehouse',
      },
    });
    await prisma.bigBagLabelPrintJob.createMany({
      data: [
        {
          id: 'bigbag-print-submitted',
          requestId: randomUUID(),
          bigBagId: 'bigbag-reference',
          printerId: 'printer-reference',
          status: 'submitted',
          requestedByRole: 'warehouse',
        },
        {
          id: 'bigbag-print-intent',
          requestId: randomUUID(),
          bigBagId: 'bigbag-reference',
          channel: 'browser_system_print',
          status: 'intent_recorded',
          requestedByRole: 'warehouse',
        },
      ],
    });
    await prisma.operationalIncident.create({
      data: {
        id: 'incident-order-target',
        fingerprint: 'incident-order-target-fingerprint',
        scope: 'platform',
        targetType: 'order',
        targetId: order.id,
        severity: 'warning',
        title: 'Order incident',
        message: 'Order runtime needs attention',
        recovery: 'Resolve before purge',
      },
    });

    const events = [
      {
        id: 'event-order-object',
        family: 'audit',
        type: 'audit:commercial_order_comment_updated',
        objectId: order.id,
        detail: { orderNumber: order.orderNumber },
      },
      {
        id: 'event-order-detail',
        family: 'audit',
        type: 'audit:auth_login',
        objectId: user.id,
        detail: { orderId: order.id },
      },
      {
        id: 'event-order-snapshot',
        family: 'integration',
        type: 'integration.onec_imported',
        objectId: 'invoice-target',
        sourceSnapshotId: 'snapshot-order-invoice',
        detail: { subjectType: 'invoice', externalId: 'invoice-target' },
      },
      {
        id: 'event-order-onec-failure',
        family: 'integration',
        type: 'integration.onec_import_failed',
        objectId: financeOrder.id,
        detail: { operationKey: randomUUID(), code: 'source_unavailable' },
      },
      {
        id: 'event-order-sync-retry',
        family: 'audit',
        type: 'audit:sync_retry_requested',
        objectId: 'journal-order',
        detail: { entity: 'invoice' },
      },
      {
        id: 'event-order-additional-cost',
        family: 'audit',
        type: 'audit:additional_production_cost_recorded',
        objectId: dispatch.id,
        detail: { amount: 42, allocation: 'per_roll' },
      },
      {
        id: 'event-order-commercial-problem',
        family: 'notification',
        type: 'notification:commercial_problem_received',
        objectId: order.id,
      },
      {
        id: 'event-order-shortage-resolved',
        family: 'audit',
        type: 'audit:raw_material_shortage_resolved',
        objectId: order.id,
      },
      {
        id: 'event-order-recipe-notification',
        family: 'notification',
        type: 'notification:operator_recipe_changed',
        objectId: order.id,
      },
      {
        id: 'event-order-incident-resolved',
        family: 'admin',
        type: 'admin.incident.resolved',
        objectId: 'incident-order-target',
      },
      {
        id: 'event-order-scan-mismatch',
        family: 'device',
        type: 'device.scan.mismatch',
        objectId: dispatch.rollCode,
        detail: { taskId: null, reasonCode: 'WAREHOUSE_TASK_ROLL_MISMATCH' },
      },
      {
        id: 'event-role-inbox',
        family: 'notification',
        type: 'notification:commercial_order_amended',
        objectId: 'unrelated-object',
        detail: { unrelated: true },
      },
      {
        id: 'event-layout-object-collision',
        family: 'audit',
        type: 'audit:pallet_label_layout_published',
        objectId: order.id,
        detail: { diagnostics: { externalId: order.externalId } },
      },
      {
        id: 'event-layout-detail-collision',
        family: 'audit',
        type: 'audit:pallet_label_layout_published',
        objectId: 'layout-reference',
        detail: { diagnostics: { externalId: order.externalId } },
      },
      {
        id: 'event-device-collision',
        family: 'device',
        type: 'device.scale.offline',
        objectId: 'device-reference',
        detail: { telemetry: { batch: order.stockBatchCode } },
      },
      {
        id: 'event-raw-collision',
        family: 'audit',
        type: 'audit:raw_material_received',
        objectId: 'raw-definition',
        detail: { sample: { orderLike: order.orderNumber } },
      },
      {
        id: 'event-stock-import-collision',
        family: 'integration',
        type: 'integration.onec_imported',
        objectId: 'snapshot-stock-reference',
        detail: { subjectType: 'stock', externalId: order.externalId },
        label: 'onec_import_stock',
        createdAt: new Date(NOW.getTime() + 1_000),
      },
    ];
    await prisma.domainEvent.createMany({
      data: events.map((event) => ({ ...event, actorRole: 'admin' as const })),
    });
    await prisma.notificationReceipt.create({
      data: {
        id: 'receipt-role-inbox',
        userId: user.id,
        eventId: 'event-role-inbox',
      },
    });

    const runPurge = () =>
      purgePilotOrderHistory(
        prisma,
        PILOT_ORDER_HISTORY_PURGE_CONFIRMATION,
        'pilot',
        'pilot',
        'yes',
      );
    const runAccumulatedPurge = () =>
      purgePilotOrderHistory(
        prisma,
        PILOT_ORDER_HISTORY_PURGE_CONFIRMATION,
        'pilot',
        'pilot',
        'yes',
        PILOT_ACCUMULATED_RUNTIME_PURGE_CONFIRMATION,
      );
    const unsafePrintCases = [
      {
        unsafe: () =>
          prisma.labelPrintJob.update({
            where: { id: 'label-submitted' },
            data: { status: 'queued' },
          }),
        safe: () =>
          prisma.labelPrintJob.update({
            where: { id: 'label-submitted' },
            data: { status: 'submitted' },
          }),
      },
      {
        unsafe: () =>
          prisma.palletPrintJob.update({
            where: { id: 'pallet-print-submitted' },
            data: { status: 'delivery_unknown' },
          }),
        safe: () =>
          prisma.palletPrintJob.update({
            where: { id: 'pallet-print-submitted' },
            data: { status: 'submitted' },
          }),
      },
      {
        unsafe: () =>
          prisma.bigBagLabelPrintJob.update({
            where: { id: 'bigbag-print-submitted' },
            data: { status: 'uncertain' },
          }),
        safe: () =>
          prisma.bigBagLabelPrintJob.update({
            where: { id: 'bigbag-print-submitted' },
            data: { status: 'submitted' },
          }),
      },
    ];
    for (const printCase of unsafePrintCases) {
      await printCase.unsafe();
      await expect(runPurge()).rejects.toThrow('unsafe label print jobs must be resolved');
      expect(await prisma.commercialOrder.count()).toBe(1);
      await printCase.safe();
    }

    await prisma.oneCSyncRun.update({
      where: { id: 'sync-run-reference' },
      data: { status: 'running', activeScopeKey: null },
    });
    await expect(runPurge()).rejects.toThrow('active 1C synchronization must be completed');
    await prisma.oneCSyncRun.update({
      where: { id: 'sync-run-reference' },
      data: { status: 'completed', activeScopeKey: 'onec:full-sync' },
    });
    await expect(runPurge()).rejects.toThrow('active 1C synchronization must be completed');
    expect(await prisma.commercialOrder.count()).toBe(1);
    await prisma.oneCSyncRun.update({
      where: { id: 'sync-run-reference' },
      data: { activeScopeKey: null },
    });

    const post = await prisma.post.findFirstOrThrow({ orderBy: { id: 'asc' } });
    const ambiguousCommand = await prisma.gatewayCommand.create({
      data: {
        id: 'reconciled-delivery-unknown-command',
        postId: post.id,
        kind: 'print',
        status: 'delivery_unknown',
      },
    });
    await prisma.labelPrintJob.update({
      where: { id: 'label-submitted' },
      data: {
        status: 'failed',
        postId: post.id,
        gatewayCommandId: ambiguousCommand.id,
      },
    });
    await expect(runPurge()).rejects.toThrow(
      'queued, in-flight or delivery-unknown Gateway commands must be resolved',
    );
    await prisma.labelPrintReconciliation.create({
      data: {
        id: 'reconciled-delivery-unknown-decision',
        operationKey: randomUUID(),
        printJobId: 'label-submitted',
        operatorRollLineId: line.id,
        postId: post.id,
        actorId: user.id,
        outcome: 'not_printed',
        reason: 'Verified during purge rehearsal',
        result: { outcome: 'not_printed' },
      },
    });

    const shiftId = 'accumulated-runtime-shift';
    const postSessionId = 'accumulated-runtime-post-session';
    const assignmentId = 'accumulated-runtime-assignment';
    await prisma.shift.create({
      data: {
        id: shiftId,
        label: 'Accumulated runtime shift',
        status: 'closed',
        plannedStartAt: new Date(NOW.getTime() - 8 * 60 * 60 * 1_000),
        plannedEndAt: NOW,
        startedAt: new Date(NOW.getTime() - 8 * 60 * 60 * 1_000),
        endedAt: NOW,
      },
    });
    await prisma.operatorShiftMachineAssignment.create({
      data: {
        id: assignmentId,
        shiftId,
        operatorId: user.id,
        postId: post.id,
        status: 'completed',
        lockedAt: new Date(NOW.getTime() - 8 * 60 * 60 * 1_000),
      },
    });
    await prisma.operatorPostSession.create({
      data: {
        id: postSessionId,
        operatorId: user.id,
        postId: post.id,
        shiftId,
        status: 'closed',
        startedAt: new Date(NOW.getTime() - 8 * 60 * 60 * 1_000),
        endedAt: NOW,
      },
    });
    await prisma.shiftBagUsage.create({
      data: {
        id: 'accumulated-runtime-bag-usage',
        sessionId: postSessionId,
        bigBagId: 'bigbag-reference',
        startKg: 5,
        endKg: 4,
        closedAt: NOW,
      },
    });
    await prisma.shiftBagUsageEpisode.create({
      data: {
        id: 'accumulated-runtime-bag-episode',
        usageId: 'accumulated-runtime-bag-usage',
        sequence: 1,
        startKg: 5,
        endKg: 4,
        openedAt: new Date(NOW.getTime() - 8 * 60 * 60 * 1_000),
        closedAt: NOW,
        closeKind: 'shift_closed',
      },
    });
    await prisma.operatorShiftCloseCommand.create({
      data: {
        id: 'accumulated-runtime-close-command',
        operationKey: randomUUID(),
        requestFingerprint: 'd'.repeat(64),
        operatorId: user.id,
        sessionId: postSessionId,
        shiftId,
        postId: post.id,
        assignmentId,
        actorRole: 'operator',
        resultSnapshot: {
          balance: { status: 'ok' },
          problemId: null,
          releasedRollIds: [],
          closingPayroll: {
            sessionId: postSessionId,
            shiftId,
            status: 'empty',
            appliedTariffOrders: [],
            summary: { payableAmountKopecks: 0 },
            breakdown: [],
            unresolved: [],
          },
        },
      },
    });
    await prisma.defectBag.create({
      data: {
        id: 'accumulated-runtime-defect-bag',
        code: 'DEF-RUNTIME-1',
        postSessionId,
        status: 'received',
        weightKg: 1,
        recordedDefectKg: 1,
        differenceKg: 0,
        scaleDeviceId: 'scale-reference',
        scaleStatus: 'ready',
        scaleStable: true,
        weighOperationKey: randomUUID(),
        weighedAt: NOW,
      },
    });
    await prisma.defectBagScanToken.create({
      data: {
        defectBagId: 'accumulated-runtime-defect-bag',
        token: `bbt_${'e'.repeat(64)}`,
      },
    });
    await prisma.defectBagLabelPrintJob.create({
      data: {
        id: 'accumulated-runtime-defect-print',
        operationKey: randomUUID(),
        defectBagId: 'accumulated-runtime-defect-bag',
        printerId: 'printer-reference',
        status: 'submitted',
        actorId: user.id,
        postSessionId,
        postId: post.id,
        leaseToken: randomUUID(),
        leaseExpiresAt: NOW,
        completedAt: NOW,
      },
    });
    const warehouseSession = await prisma.session.create({
      data: {
        id: 'accumulated-runtime-warehouse-session',
        userId: user.id,
        tokenHash: 'f'.repeat(64),
        expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1_000),
      },
    });
    await prisma.defectBagMovement.create({
      data: {
        id: 'accumulated-runtime-defect-movement',
        operationKey: randomUUID(),
        defectBagId: 'accumulated-runtime-defect-bag',
        kind: 'receive',
        actorId: user.id,
        sessionId: warehouseSession.id,
        postId: post.id,
      },
    });
    await prisma.domainEvent.createMany({
      data: [
        {
          id: 'accumulated-runtime-shift-event',
          family: 'audit',
          type: 'audit:operator_shift_closed',
          objectId: shiftId,
          actorRole: 'operator',
        },
        {
          id: 'accumulated-runtime-defect-event',
          family: 'audit',
          type: 'audit:defect_bag_weighed',
          objectId: 'accumulated-runtime-defect-bag',
          actorRole: 'operator',
        },
      ],
    });

    const inventory = new InventoryProjectionService(prisma as never);
    const inventoryBefore = await inventory.list({ limit: 20 }, NOW);
    expect(inventoryBefore.sourceUnavailable).toBe(false);
    const oneCBefore = await stableOneCFingerprint(prisma);
    const layoutBefore = await prisma.palletLabelLayoutVersion.findUniqueOrThrow({
      where: { id: 'layout-reference' },
    });
    const postCatalogEventIds = (
      await prisma.domainEvent.findMany({
        where: { systemActorKey: POST_CATALOG_MIGRATION_SYSTEM_ACTOR_KEY },
        select: { id: true },
        orderBy: { id: 'asc' },
      })
    ).map(({ id }) => id);
    expect(postCatalogEventIds).toHaveLength(2);
    const payrollTariffBefore = {
      orders: await prisma.payrollTariffOrder.findMany({ orderBy: { id: 'asc' } }),
      commands: await prisma.payrollTariffOrderCommand.findMany({ orderBy: { id: 'asc' } }),
      events: await prisma.domainEvent.findMany({
        where: {
          type: {
            in: [
              'audit:payroll_tariff_order_created',
              'audit:payroll_tariff_order_draft_updated',
              'audit:payroll_tariff_order_published',
            ],
          },
        },
        orderBy: { id: 'asc' },
      }),
    };
    expect(payrollTariffBefore.orders.length).toBeGreaterThan(0);

    await runAccumulatedPurge();

    expect(await prisma.commercialOrder.count()).toBe(0);
    expect(await prisma.financeOrder.count()).toBe(0);
    expect(await prisma.notificationReceipt.count()).toBe(0);
    expect(
      await prisma.domainEvent.count({ where: { type: { in: PILOT_ROLE_INBOX_EVENT_TYPES } } }),
    ).toBe(0);
    expect(await prisma.oneCInvoice.count({ where: { externalId: 'invoice-target' } })).toBe(0);
    expect(await prisma.oneCPayment.count({ where: { externalId: 'payment-target' } })).toBe(0);
    expect(await prisma.oneCShipment.count({ where: { externalId: 'shipment-target' } })).toBe(0);
    expect(await prisma.sourceSnapshot.count({ where: { id: 'snapshot-order-invoice' } })).toBe(0);
    expect(
      await prisma.sourceSnapshot.count({
        where: {
          id: {
            in: [
              'snapshot-order-subject-only',
              'snapshot-order-payment-parsed-link',
              'snapshot-order-shipment-parsed-link',
            ],
          },
        },
      }),
    ).toBe(0);
    expect(await prisma.syncJournal.count({ where: { id: 'journal-order' } })).toBe(0);

    const survivingEventIds = (
      await prisma.domainEvent.findMany({ select: { id: true }, orderBy: { id: 'asc' } })
    ).map(({ id }) => id);
    expect(survivingEventIds).toEqual(
      [
        ...postCatalogEventIds,
        'event-device-collision',
        'event-layout-detail-collision',
        'event-layout-object-collision',
        'event-raw-collision',
        'event-stock-import-collision',
        'payroll-tariff-order-8-09-25-bootstrap-event',
      ].sort(),
    );
    expect(await stableOneCFingerprint(prisma)).toEqual(oneCBefore);
    expect(await inventory.list({ limit: 20 }, NOW)).toEqual(inventoryBefore);
    expect(
      await prisma.palletLabelLayoutVersion.findUniqueOrThrow({
        where: { id: 'layout-reference' },
      }),
    ).toEqual(layoutBefore);
    expect(await prisma.palletListDocument.count()).toBe(0);
    const publications = new PalletLabelLayoutPublicationService(
      prisma as never,
      {} as never,
      new ConfigurablePalletLabelRenderer(),
    );
    const editor = new PalletLabelLayoutEditorService(
      prisma as never,
      new PalletLabelLayoutEditorRenderer(),
      publications,
    );
    await expect(editor.bootstrap()).resolves.toMatchObject({
      activePublication: { id: 'layout-reference', version: 1 },
      sources: [
        {
          documentId: PALLET_LABEL_LAYOUT_CONTROL_SOURCE_ID,
          kind: 'control',
          label: PALLET_LABEL_LAYOUT_CONTROL_SOURCE_LABEL,
          rollCount: 24,
        },
      ],
    });
    await expect(
      editor.preview(PALLET_LABEL_LAYOUT_CONTROL_SOURCE_ID, PUBLISHED_PALLET_LABEL_LAYOUT),
    ).resolves.toMatchObject({ png: expect.any(Buffer) });
    expect(await prisma.bigBagLabelPrintJob.count()).toBe(2);
    expect(await prisma.bigBagUnit.count()).toBe(1);
    expect(await prisma.shiftBagUsage.count()).toBe(0);
    expect(await prisma.shiftBagUsageEpisode.count()).toBe(0);
    expect(await prisma.operatorShiftCloseCommand.count()).toBe(0);
    expect(await prisma.operatorPostSession.count()).toBe(0);
    expect(await prisma.operatorShiftMachineAssignment.count()).toBe(0);
    expect(await prisma.shift.count()).toBe(0);
    expect(await prisma.defectBagLabelPrintJob.count()).toBe(0);
    expect(await prisma.defectBagMovement.count()).toBe(0);
    expect(await prisma.defectBagScanToken.count()).toBe(0);
    expect(await prisma.defectBag.count()).toBe(0);
    expect(
      await prisma.domainEvent.count({
        where: { type: { in: [...PILOT_ACCUMULATED_RUNTIME_EVENT_TYPES] } },
      }),
    ).toBe(0);
    expect(await prisma.session.count({ where: { id: warehouseSession.id } })).toBe(1);
    expect({
      orders: await prisma.payrollTariffOrder.findMany({ orderBy: { id: 'asc' } }),
      commands: await prisma.payrollTariffOrderCommand.findMany({ orderBy: { id: 'asc' } }),
      events: await prisma.domainEvent.findMany({
        where: {
          type: {
            in: [
              'audit:payroll_tariff_order_created',
              'audit:payroll_tariff_order_draft_updated',
              'audit:payroll_tariff_order_published',
            ],
          },
        },
        orderBy: { id: 'asc' },
      }),
    }).toEqual(payrollTariffBefore);

    const [residue] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(`
      SELECT (
        (SELECT count(*) FROM source_snapshots WHERE "financeOrderId" IS NOT NULL) +
        (SELECT count(*) FROM sync_journals WHERE "financeOrderId" IS NOT NULL) +
        (SELECT count(*) FROM onec_invoice_lines WHERE "invoiceExternalId" = 'invoice-target') +
        (SELECT count(*) FROM onec_shipment_lines WHERE "shipmentExternalId" = 'shipment-target')
      ) AS count
    `);
    expect(Number(residue?.count)).toBe(0);
  }, 120_000);
});
