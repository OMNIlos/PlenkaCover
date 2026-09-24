import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DOMAIN_EVENTS,
  PAYMENT_STATUSES,
  PAYMENT_UPDATE_STATUSES,
  SHIPMENT_STATUSES,
  SHIPMENT_UPDATE_STATUSES,
  type CreateIndividualShiftInput,
  type CommercialRequestSemantics,
  type MachineChangeRequestInput,
  type MachineChangeView,
  type SafeInventoryItem,
  type SafeInventoryPage,
  type TraceabilityContext,
  type TraceabilityProductionFact,
  type TraceabilitySearchPage,
  type TraceabilityWarehouseFact,
} from '@plenka/contracts';

type HasForbiddenKey<T, K extends PropertyKey> = T extends (...args: never[]) => unknown
  ? false
  : T extends readonly (infer Item)[]
    ? HasForbiddenKey<Item, K>
    : T extends object
      ? K extends keyof T
        ? true
        : true extends {
              [P in keyof T]-?: HasForbiddenKey<NonNullable<T[P]>, K>;
            }[keyof T]
          ? true
          : false
      : false;

type AssertFalse<T extends false> = T;

describe('shift and safe projection contracts', () => {
  it('persists nullable legacy-compatible individual-shift idempotency fields', () => {
    const schema = readFileSync(resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8');
    const migration = readFileSync(
      resolve(
        __dirname,
        '../../../prisma/migrations/20260727140000_individual_shift_idempotency/migration.sql',
      ),
      'utf8',
    );

    expect(schema).toContain('operationKey       String?   @unique @db.Uuid');
    expect(schema).toContain('requestFingerprint String?   @db.Char(64)');
    expect(schema).toContain('commandResult      Json?');
    expect(migration).toContain('ADD COLUMN "operationKey" UUID');
    expect(migration).toContain('ADD COLUMN "requestFingerprint" CHAR(64)');
    expect(migration).toContain('ADD COLUMN "commandResult" JSONB');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "shifts_operationKey_key" ON "shifts"("operationKey")',
    );
  });

  it('supports individual shifts and persistent intentional machine changes', () => {
    const shift = {
      operatorId: 'operator-1',
      postId: 'post-1',
      operationKey: 'shift-operation-1',
    } satisfies CreateIndividualShiftInput;
    const request = {
      postId: 'post-2',
      reason: 'Плановая переналадка',
      operationKey: 'machine-change-operation-1',
    } satisfies MachineChangeRequestInput;
    const view = {
      id: 'change-1',
      assignmentId: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'operator-1',
      fromPostId: 'post-1',
      toPostId: 'post-2',
      fromPost: { id: 'post-1', code: 'POST-1', name: 'Экструдер 1' },
      toPost: { id: 'post-2', code: 'POST-2', name: 'Экструдер 2' },
      needsFinalWeight: true,
      pendingBigBags: [{ id: 'bag-1', code: 'BAG-1' }],
      reason: request.reason,
      status: 'awaiting_final_weight',
      operationKey: request.operationKey,
      requestedAt: '2026-07-27T09:00:00.000Z',
      readyAt: null,
      completedAt: null,
      cancelledAt: null,
      updatedAt: '2026-07-27T09:00:00.000Z',
    } satisfies MachineChangeView;

    expect(shift).not.toHaveProperty('dispatchItemIds');
    expect(view.status).toBe('awaiting_final_weight');
  });

  it('exports safe inventory and traceability pages without raw payload fields', () => {
    const inventoryBoundary: AssertFalse<
      HasForbiddenKey<SafeInventoryPage | SafeInventoryItem, 'rawPayload'>
    > = false;
    const traceabilityBoundary: AssertFalse<
      HasForbiddenKey<
        | TraceabilitySearchPage
        | TraceabilityContext
        | TraceabilityProductionFact
        | TraceabilityWarehouseFact,
        'rawPayload'
      >
    > = false;
    const inventory = {
      items: [],
      nextCursor: null,
      sourceUnavailable: false,
      generatedAt: '2026-07-27T09:00:00.000Z',
    } satisfies SafeInventoryPage;
    const search = {
      items: [],
      nextCursor: null,
    } satisfies TraceabilitySearchPage;
    const context = {
      objectType: 'roll',
      objectId: 'roll-1',
      displayName: 'ROLL-1',
      statuses: [],
      links: [],
      timeline: [],
      problems: [],
      defects: [],
      productionFacts: [],
      warehouseFacts: [],
    } satisfies TraceabilityContext;

    expect([inventoryBoundary, traceabilityBoundary]).toEqual([false, false]);
    expect(JSON.stringify({ inventory, search, context })).not.toMatch(/rawPayload/i);
  });

  it('defines stock semantics and durable event vocabulary', () => {
    const clientOrder = {
      requestType: 'client_order',
      counterpartyId: 'counterparty-1',
      paymentStatus: 'unpaid',
      shipmentStatus: 'not_shipped',
    } satisfies CommercialRequestSemantics;
    const stockOrder = {
      requestType: 'stock_reserve',
      paymentStatus: 'not_applicable',
      shipmentStatus: 'not_applicable',
    } satisfies CommercialRequestSemantics;

    expect(clientOrder.paymentStatus).toBe('unpaid');
    expect(stockOrder.paymentStatus).toBe('not_applicable');
    expect(PAYMENT_STATUSES).toContain('not_applicable');
    expect(SHIPMENT_STATUSES).toContain('not_applicable');
    expect(PAYMENT_UPDATE_STATUSES).not.toContain('not_applicable');
    expect(SHIPMENT_UPDATE_STATUSES).not.toContain('not_applicable');
    expect(DOMAIN_EVENTS).toEqual(
      expect.arrayContaining([
        'audit:operator_machine_change_requested',
        'audit:operator_machine_change_completed',
        'notification:commercial_correction_applied',
        'audit:finished_stock_reserved',
      ]),
    );
  });
});
