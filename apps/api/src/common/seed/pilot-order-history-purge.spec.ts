import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Prisma } from '@prisma/client';
import { ROLE_INBOX_PRESENTATIONS } from '../role-inbox/role-inbox.registry';
import {
  PILOT_ACCUMULATED_RUNTIME_DELETE_TABLES,
  PILOT_ACCUMULATED_RUNTIME_DISABLE_TRIGGER_STATEMENTS,
  PILOT_ACCUMULATED_RUNTIME_ENABLE_TRIGGER_STATEMENTS,
  PILOT_ACCUMULATED_RUNTIME_EVENT_DELETE_STATEMENT,
  PILOT_ACCUMULATED_RUNTIME_PREFLIGHTS,
  PILOT_ACCUMULATED_RUNTIME_PURGE_CONFIRMATION,
  PILOT_ACCUMULATED_RUNTIME_PRESERVED_FINGERPRINT_QUERY,
  PILOT_ACCUMULATED_RUNTIME_ZERO_VALIDATION_QUERY,
  PILOT_ORDER_HISTORY_PURGE_CONFIRMATION,
  PILOT_ORDER_PURGE_ADVISORY_LOCK_QUERY,
  PILOT_ORDER_PURGE_DELETE_TABLES,
  PILOT_ORDER_PURGE_DISABLE_TRIGGER_STATEMENTS,
  PILOT_ORDER_PURGE_ENABLE_TRIGGER_STATEMENTS,
  PILOT_ORDER_PURGE_EVENT_DELETE_STATEMENT,
  PILOT_ORDER_PURGE_IDENTIFIER_SOURCES,
  PILOT_ORDER_PURGE_IDENTIFIER_CAPTURE_STATEMENTS,
  PILOT_ORDER_PURGE_MAINTENANCE_STATEMENTS,
  PILOT_ORDER_PURGE_OPERATIONAL_DELETE_STATEMENTS,
  PILOT_ORDER_PURGE_PREFLIGHTS,
  PILOT_ORDER_PURGE_PREPARE_STATEMENTS,
  PILOT_ORDER_PURGE_PRESERVED_FINGERPRINT_QUERY,
  PILOT_ORDER_PURGE_PRESERVED_TABLES,
  PILOT_ORDER_PURGE_SELECTIVE_DELETE_STATEMENTS,
  PILOT_ORDER_PURGE_TABLE_BOUNDARY,
  PILOT_ORDER_PURGE_TEMPLATE_RESET_STATEMENTS,
  PILOT_ORDER_PURGE_ZERO_VALIDATION_QUERY,
  PILOT_ROLE_INBOX_EVENT_TYPES,
  PilotOrderHistoryPurgeError,
  purgePilotOrderHistory,
} from './pilot-order-history-purge';

type FakeState = {
  disabledTriggers: Set<string>;
  deletedTables: Set<string>;
  defectRows: number;
  orderRows: number;
  spoolMovements: Array<{
    id: string;
    defectRecordId: string | null;
    tareKg: number;
    quantity: number;
    location: string;
  }>;
};

function cloneState(state: FakeState): FakeState {
  return {
    disabledTriggers: new Set(state.disabledTriggers),
    deletedTables: new Set(state.deletedTables),
    defectRows: state.defectRows,
    orderRows: state.orderRows,
    spoolMovements: state.spoolMovements.map((movement) => ({ ...movement })),
  };
}

function setup(
  options: {
    unsafePreflight?: string;
    failOnStatement?: (statement: string) => boolean;
    failOnQuery?: (statement: string) => boolean;
    transactionFailure?: Error;
    afterFingerprint?: unknown;
    remaining?: number;
  } = {},
) {
  const durableState: FakeState = {
    disabledTriggers: new Set(),
    deletedTables: new Set(),
    defectRows: 1,
    orderRows: 1,
    spoolMovements: [
      {
        id: 'movement-1',
        defectRecordId: 'defect-1',
        tareKg: 1.25,
        quantity: 2,
        location: 'warehouse',
      },
    ],
  };
  const transactionStates: FakeState[] = [];
  let fingerprintQueryCount = 0;
  const queryRawUnsafe = jest.fn(async (statement: string): Promise<unknown[]> => {
    if (options.failOnQuery?.(statement)) throw new Error('injected query failure');
    if (statement === PILOT_ORDER_PURGE_ADVISORY_LOCK_QUERY) return [{ locked: 1 }];
    const preflight = [
      ...PILOT_ORDER_PURGE_PREFLIGHTS,
      ...PILOT_ACCUMULATED_RUNTIME_PREFLIGHTS,
    ].find((candidate) => candidate.query === statement);
    if (preflight) {
      return [{ count: preflight.name === options.unsafePreflight ? 1 : 0 }];
    }
    if (
      statement === PILOT_ORDER_PURGE_PRESERVED_FINGERPRINT_QUERY ||
      statement === PILOT_ACCUMULATED_RUNTIME_PRESERVED_FINGERPRINT_QUERY
    ) {
      fingerprintQueryCount += 1;
      return [
        {
          fingerprint:
            fingerprintQueryCount === 1
              ? { users: 'users-hash', activeLayout: 'layout-hash', raw: 'raw-hash' }
              : (options.afterFingerprint ?? {
                  users: 'users-hash',
                  activeLayout: 'layout-hash',
                  raw: 'raw-hash',
                }),
        },
      ];
    }
    if (
      statement === PILOT_ORDER_PURGE_ZERO_VALIDATION_QUERY ||
      statement === PILOT_ACCUMULATED_RUNTIME_ZERO_VALIDATION_QUERY
    ) {
      return [{ remaining: options.remaining ?? 0 }];
    }
    return [];
  });
  const executeRawUnsafe = jest.fn(async (statement: string): Promise<number> => {
    if (options.failOnStatement?.(statement)) throw new Error('injected purge failure');
    const state = transactionStates.at(-1);
    if (!state) throw new Error('statement escaped transaction');
    const disable = statement.match(/^ALTER TABLE "([^"]+)" DISABLE TRIGGER USER$/u);
    if (disable) state.disabledTriggers.add(disable[1]);
    const enable = statement.match(/^ALTER TABLE "([^"]+)" ENABLE TRIGGER USER$/u);
    if (enable) state.disabledTriggers.delete(enable[1]);
    const deletion = statement.match(/^DELETE FROM "([^"]+)"/u);
    if (deletion) {
      state.deletedTables.add(deletion[1]);
      if (deletion[1] === 'commercial_orders') state.orderRows = 0;
      if (deletion[1] === 'defect_records') {
        state.defectRows = 0;
        state.spoolMovements = state.spoolMovements.map((movement) => ({
          ...movement,
          defectRecordId: null,
        }));
      }
    }
    return 1;
  });
  const tx = {
    $queryRawUnsafe: queryRawUnsafe,
    $executeRawUnsafe: executeRawUnsafe,
  };
  const prisma = {
    $transaction: jest.fn(
      async (callback: (client: typeof tx) => Promise<unknown>, transactionOptions: unknown) => {
        if (options.transactionFailure) throw options.transactionFailure;
        const state = cloneState(durableState);
        transactionStates.push(state);
        try {
          const result = await callback(tx);
          durableState.disabledTriggers = new Set(state.disabledTriggers);
          durableState.deletedTables = new Set(state.deletedTables);
          durableState.defectRows = state.defectRows;
          durableState.orderRows = state.orderRows;
          durableState.spoolMovements = state.spoolMovements.map((movement) => ({ ...movement }));
          return result;
        } finally {
          transactionStates.pop();
          void transactionOptions;
        }
      },
    ),
  };
  return { durableState, prisma, tx };
}

describe('purgePilotOrderHistory', () => {
  it('requires the second confirmation before deleting accumulated shifts and defect bags', async () => {
    const { prisma } = setup();

    await expect(
      purgePilotOrderHistory(
        prisma as never,
        PILOT_ORDER_HISTORY_PURGE_CONFIRMATION,
        'pilot',
        'pilot',
        'yes',
        'wrong',
      ),
    ).rejects.toThrow('accumulated runtime confirmation');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('deletes accumulated shift/payroll facts only in the explicitly confirmed mode', async () => {
    const normal = setup();
    await purgePilotOrderHistory(
      normal.prisma as never,
      PILOT_ORDER_HISTORY_PURGE_CONFIRMATION,
      'pilot',
      'pilot',
      'yes',
    );
    const normalStatements = normal.tx.$executeRawUnsafe.mock.calls.map(([statement]) =>
      String(statement),
    );
    expect(normalStatements).not.toEqual(
      expect.arrayContaining(
        PILOT_ACCUMULATED_RUNTIME_DELETE_TABLES.map((table) => `DELETE FROM "${table}"`),
      ),
    );

    const accumulated = setup();
    await purgePilotOrderHistory(
      accumulated.prisma as never,
      PILOT_ORDER_HISTORY_PURGE_CONFIRMATION,
      'pilot',
      'pilot',
      'yes',
      PILOT_ACCUMULATED_RUNTIME_PURGE_CONFIRMATION,
    );
    const accumulatedStatements = accumulated.tx.$executeRawUnsafe.mock.calls.map(([statement]) =>
      String(statement),
    );
    expect(accumulatedStatements).toEqual(
      expect.arrayContaining([
        ...PILOT_ACCUMULATED_RUNTIME_DISABLE_TRIGGER_STATEMENTS,
        ...PILOT_ACCUMULATED_RUNTIME_DELETE_TABLES.map((table) => `DELETE FROM "${table}"`),
        PILOT_ACCUMULATED_RUNTIME_EVENT_DELETE_STATEMENT,
        ...PILOT_ACCUMULATED_RUNTIME_ENABLE_TRIGGER_STATEMENTS,
      ]),
    );
    expect(accumulated.tx.$queryRawUnsafe).toHaveBeenCalledWith(
      PILOT_ACCUMULATED_RUNTIME_PRESERVED_FINGERPRINT_QUERY,
    );
    expect(accumulated.tx.$queryRawUnsafe).toHaveBeenCalledWith(
      PILOT_ACCUMULATED_RUNTIME_ZERO_VALIDATION_QUERY,
    );
  });

  it('rejects wrong confirmation/environment/gateway assertions before opening a transaction', async () => {
    const invalidInputs = [
      ['wrong', 'pilot', 'pilot', 'yes'],
      [PILOT_ORDER_HISTORY_PURGE_CONFIRMATION, 'production', 'pilot', 'yes'],
      [PILOT_ORDER_HISTORY_PURGE_CONFIRMATION, 'pilot', 'production', 'yes'],
      [PILOT_ORDER_HISTORY_PURGE_CONFIRMATION, 'pilot', 'pilot', 'no'],
    ] as const;

    for (const [confirmation, appEnvironment, seedProfile, gatewaysStopped] of invalidInputs) {
      const { prisma } = setup();
      await expect(
        purgePilotOrderHistory(
          prisma as never,
          confirmation,
          appEnvironment,
          seedProfile,
          gatewaysStopped,
        ),
      ).rejects.toBeInstanceOf(PilotOrderHistoryPurgeError);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    }
  });

  it('uses a dedicated advisory lock, local timeouts and one Serializable transaction', async () => {
    const { prisma, tx } = setup();

    await purgePilotOrderHistory(
      prisma as never,
      PILOT_ORDER_HISTORY_PURGE_CONFIRMATION,
      'pilot',
      'pilot',
      'yes',
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0]?.[1]).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 120_000,
    });
    expect(tx.$queryRawUnsafe).toHaveBeenNthCalledWith(1, PILOT_ORDER_PURGE_ADVISORY_LOCK_QUERY);
    expect(tx.$executeRawUnsafe.mock.calls.slice(0, 3).map(([statement]) => statement)).toEqual(
      PILOT_ORDER_PURGE_MAINTENANCE_STATEMENTS,
    );
  });

  it.each([
    {
      name: 'advisory-lock acquisition',
      options: {
        failOnQuery: (statement: string) => statement === PILOT_ORDER_PURGE_ADVISORY_LOCK_QUERY,
      },
    },
    {
      name: 'SET LOCAL timeout configuration',
      options: {
        failOnStatement: (statement: string) =>
          statement === PILOT_ORDER_PURGE_MAINTENANCE_STATEMENTS[0],
      },
    },
    {
      name: 'Serializable transaction acquisition',
      options: { transactionFailure: new Error('Serializable transaction unavailable') },
    },
  ])('keeps durable state unchanged when $name fails', async ({ options }) => {
    const { durableState, prisma, tx } = setup(options);

    await expect(
      purgePilotOrderHistory(
        prisma as never,
        PILOT_ORDER_HISTORY_PURGE_CONFIRMATION,
        'pilot',
        'pilot',
        'yes',
      ),
    ).rejects.toThrow();

    expect(durableState.deletedTables.size).toBe(0);
    expect(durableState.disabledTriggers.size).toBe(0);
    expect(tx.$executeRawUnsafe.mock.calls.map(([statement]) => statement)).not.toEqual(
      expect.arrayContaining(
        PILOT_ORDER_PURGE_DELETE_TABLES.map((table) => `DELETE FROM "${table}"`),
      ),
    );
  });

  it.each(PILOT_ORDER_PURGE_PREFLIGHTS)(
    'fails closed with zero maintenance writes when $name is unsafe',
    async (preflight) => {
      const { prisma, tx } = setup({ unsafePreflight: preflight.name });

      await expect(
        purgePilotOrderHistory(
          prisma as never,
          PILOT_ORDER_HISTORY_PURGE_CONFIRMATION,
          'pilot',
          'pilot',
          'yes',
        ),
      ).rejects.toThrow(preflight.failureMessage);
      expect(tx.$executeRawUnsafe.mock.calls.map(([statement]) => statement)).toEqual(
        PILOT_ORDER_PURGE_MAINTENANCE_STATEMENTS,
      );
    },
  );

  it.each(PILOT_ACCUMULATED_RUNTIME_PREFLIGHTS)(
    'fails before identifier capture when accumulated runtime has $name',
    async (preflight) => {
      const { prisma, tx } = setup({ unsafePreflight: preflight.name });

      await expect(
        purgePilotOrderHistory(
          prisma as never,
          PILOT_ORDER_HISTORY_PURGE_CONFIRMATION,
          'pilot',
          'pilot',
          'yes',
          PILOT_ACCUMULATED_RUNTIME_PURGE_CONFIRMATION,
        ),
      ).rejects.toThrow(preflight.failureMessage);
      expect(tx.$executeRawUnsafe.mock.calls.map(([statement]) => statement)).toEqual(
        PILOT_ORDER_PURGE_MAINTENANCE_STATEMENTS,
      );
    },
  );

  it('allows terminal submitted/intent print evidence but rejects active or uncertain jobs', () => {
    const printPreflight = PILOT_ORDER_PURGE_PREFLIGHTS.find(
      ({ name }) => name === 'unsafe print jobs',
    );
    expect(printPreflight).toBeDefined();
    const query = printPreflight?.query ?? '';

    for (const table of [
      'label_print_jobs',
      'pallet_print_jobs',
      'big_bag_label_print_jobs',
      'defect_bag_label_print_jobs',
    ]) {
      expect(query).toContain(`FROM "${table}"`);
    }
    for (const unsafeStatus of [
      'queued',
      'in_flight',
      'reprint_requested',
      'delivery_unknown',
      'uncertain',
    ]) {
      expect(query).toContain(`'${unsafeStatus}'`);
    }
    expect(query).not.toContain("'submitted'");
    expect(query).not.toContain("'intent_recorded'");
  });

  it('deletes a recovery audit fact only with its captured gateway command', () => {
    expect(PILOT_ORDER_PURGE_EVENT_DELETE_STATEMENT).toContain("'gateway:command_recovered'");
    expect(PILOT_ORDER_PURGE_EVENT_DELETE_STATEMENT).toContain('gateway_command_id');
  });

  it('fails closed on an active full 1C sync claim that must be preserved', () => {
    const syncPreflight = PILOT_ORDER_PURGE_PREFLIGHTS.find(
      ({ name }) => name === 'active 1C synchronization',
    );

    expect(syncPreflight?.query).toMatch(
      /onec_sync_runs[\s\S]+"status" = 'running'[\s\S]+"activeScopeKey" IS NOT NULL/u,
    );
  });

  it('fails before identifier capture for every unresolved SyncJournal claim shape', async () => {
    const journalPreflight = PILOT_ORDER_PURGE_PREFLIGHTS.find(
      ({ name }) => String(name) === 'active or unresolved 1C journal claims',
    );

    expect(journalPreflight?.query).toMatch(
      /sync_journals[\s\S]+"status" NOT IN \('ready', 'error'\)/u,
    );
    expect(journalPreflight?.query).toMatch(/"activeScopeKey" IS NOT NULL/u);
    expect(journalPreflight?.query).toMatch(/"leaseExpiresAt" IS NOT NULL/u);
    expect(journalPreflight?.query).not.toMatch(/"operationKey" IS NOT NULL/u);

    const { prisma, tx } = setup({ unsafePreflight: journalPreflight?.name });
    await expect(
      purgePilotOrderHistory(
        prisma as never,
        PILOT_ORDER_HISTORY_PURGE_CONFIRMATION,
        'pilot',
        'pilot',
        'yes',
      ),
    ).rejects.toThrow('active or unresolved 1C journal claims must be completed or recovered');
    expect(tx.$executeRawUnsafe.mock.calls.map(([statement]) => statement)).toEqual(
      PILOT_ORDER_PURGE_MAINTENANCE_STATEMENTS,
    );
    expect(tx.$executeRawUnsafe.mock.calls.map(([statement]) => statement)).not.toEqual(
      expect.arrayContaining(PILOT_ORDER_PURGE_IDENTIFIER_CAPTURE_STATEMENTS),
    );
  });

  it('fails before identifier capture on an ambiguous local-finance/1C invoice identity', async () => {
    const collisionPreflight = PILOT_ORDER_PURGE_PREFLIGHTS.find(
      ({ name }) => String(name) === 'ambiguous legacy admin 1C invoice identities',
    );

    expect(collisionPreflight?.query).toMatch(
      /finance_orders[\s\S]+onec_invoices[\s\S]+source_snapshots/u,
    );
    expect(collisionPreflight?.query).toMatch(
      /integration\.onec_imported[\s\S]+onec_import_invoice/u,
    );
    expect(collisionPreflight?.query).toMatch(
      /admin\.onec\.import_requested[\s\S]+subjectType[\s\S]+invoice/u,
    );
    expect(collisionPreflight?.query).not.toContain('~*');
    expect(collisionPreflight?.failureMessage).toContain(
      'PILOT_PURGE_ONEC_INVOICE_IDENTITY_COLLISION',
    );

    const { prisma, tx } = setup({ unsafePreflight: collisionPreflight?.name });
    await expect(
      purgePilotOrderHistory(
        prisma as never,
        PILOT_ORDER_HISTORY_PURGE_CONFIRMATION,
        'pilot',
        'pilot',
        'yes',
      ),
    ).rejects.toThrow('PILOT_PURGE_ONEC_INVOICE_IDENTITY_COLLISION');
    expect(tx.$executeRawUnsafe.mock.calls.map(([statement]) => statement)).toEqual(
      PILOT_ORDER_PURGE_MAINTENANCE_STATEMENTS,
    );
  });

  it('represents and classifies every current FK edge, including self and selective relations', () => {
    const models = Prisma.dmmf.datamodel.models;
    const modelsByName = new Map(models.map((model) => [model.name, model]));
    const schemaTables = models.map((model) => model.dbName ?? model.name).sort();
    const representedTables = Object.keys(PILOT_ORDER_PURGE_TABLE_BOUNDARY).sort();
    expect(representedTables).toEqual(schemaTables);
    expect(PILOT_ORDER_PURGE_TABLE_BOUNDARY).toMatchObject({
      payroll_tariff_orders: 'preserve',
      payroll_tariff_order_commands: 'preserve',
    });

    const preparedSql = PILOT_ORDER_PURGE_PREPARE_STATEMENTS.join('\n');
    const orderedDeletes = [
      ...PILOT_ORDER_PURGE_SELECTIVE_DELETE_STATEMENTS,
      ...PILOT_ORDER_PURGE_DELETE_TABLES.map((table) => `DELETE FROM "${table}"`),
      ...PILOT_ORDER_PURGE_OPERATIONAL_DELETE_STATEMENTS,
      PILOT_ORDER_PURGE_EVENT_DELETE_STATEMENT,
    ];
    const deletePosition = (table: string) =>
      orderedDeletes.findIndex((statement) => statement.includes(`DELETE FROM "${table}"`));
    const selfRelations: string[] = [];
    const selectiveRelations: string[] = [];
    const preservedChildrenOfDeletedParents: string[] = [];
    let characterizedEdges = 0;

    for (const model of models) {
      const childTable = model.dbName ?? model.name;
      for (const relation of model.fields.filter(
        (field) => field.kind === 'object' && field.relationFromFields?.length,
      )) {
        const parent = modelsByName.get(relation.type);
        if (!parent) continue;
        const parentTable = parent.dbName ?? parent.name;
        const childBoundary = PILOT_ORDER_PURGE_TABLE_BOUNDARY[childTable];
        const parentBoundary = PILOT_ORDER_PURGE_TABLE_BOUNDARY[parentTable];
        const signature = `${childTable}.${relation.name}->${parentTable}`;
        characterizedEdges += 1;

        if (childTable === parentTable) {
          selfRelations.push(signature);
          if (childBoundary === 'delete-all') {
            const relationWasBroken = (relation.relationFromFields ?? []).every((fieldName) =>
              preparedSql.includes(`"${fieldName}" = NULL`),
            );
            const optionalSetNull =
              relation.relationFromFields?.every(
                (fieldName) =>
                  model.fields.find(({ name }) => name === fieldName)?.isRequired === false,
              ) && relation.relationOnDelete !== 'Restrict';
            expect(relationWasBroken || optionalSetNull).toBe(true);
          } else {
            expect(childBoundary).toBe('preserve');
          }
          continue;
        }

        if (childBoundary === 'delete-order-linked' || parentBoundary === 'delete-order-linked') {
          selectiveRelations.push(signature);
        }

        const childIsDeleted = childBoundary !== 'preserve';
        const parentIsDeleted = parentBoundary !== 'preserve';
        if (childIsDeleted && parentIsDeleted) {
          const relationWasBroken = (relation.relationFromFields ?? []).every((fieldName) =>
            preparedSql.includes(`"${fieldName}" = NULL`),
          );
          expect(deletePosition(childTable)).toBeGreaterThanOrEqual(0);
          expect(deletePosition(parentTable)).toBeGreaterThanOrEqual(0);
          if (!relationWasBroken) {
            expect(deletePosition(childTable)).toBeLessThan(deletePosition(parentTable));
          }
          continue;
        }

        if (!childIsDeleted && parentIsDeleted) {
          preservedChildrenOfDeletedParents.push(signature);
          expect(relation.relationOnDelete).toBe('SetNull');
          expect(
            relation.relationFromFields?.every(
              (fieldName) =>
                model.fields.find(({ name }) => name === fieldName)?.isRequired === false,
            ),
          ).toBe(true);
        }
      }
    }

    expect(characterizedEdges).toBe(
      models.flatMap((model) =>
        model.fields.filter((field) => field.kind === 'object' && field.relationFromFields?.length),
      ).length,
    );
    expect(selfRelations.sort()).toEqual([
      'big_bag_label_print_jobs.replacesPrintJob->big_bag_label_print_jobs',
      'defect_bag_label_print_jobs.replacesJob->defect_bag_label_print_jobs',
      'finance_payment_allocations.reverses->finance_payment_allocations',
      'pallet_print_jobs.replacesJob->pallet_print_jobs',
      'payment_operations.reversesOperation->payment_operations',
      'roll_dispatch_items.replacesDispatchItem->roll_dispatch_items',
      'roll_production_cost_snapshots.supersedesSnapshot->roll_production_cost_snapshots',
      'weight_captures.supersedesCapture->weight_captures',
    ]);
    expect(selectiveRelations.sort()).toEqual([
      'domain_events.actor->users',
      'notification_receipts.event->domain_events',
      'onec_invoice_lines.invoice->onec_invoices',
      'onec_invoice_lines.nomenclature->onec_nomenclature_items',
      'onec_payments.invoice->onec_invoices',
      'onec_shipment_lines.nomenclature->onec_nomenclature_items',
      'onec_shipment_lines.shipment->onec_shipments',
      'onec_shipments.invoice->onec_invoices',
      'source_snapshots.financeOrder->finance_orders',
      'sync_journals.financeOrder->finance_orders',
    ]);
    expect(preservedChildrenOfDeletedParents).toEqual([
      'spool_stock_movements.defectRecord->defect_records',
    ]);
  });

  it('captures typed primary identities for every delete-all table before event cleanup', () => {
    const identifierSql = PILOT_ORDER_PURGE_IDENTIFIER_CAPTURE_STATEMENTS.join('\n');
    const modelsByTable = new Map(
      Prisma.dmmf.datamodel.models.map((model) => [model.dbName ?? model.name, model]),
    );

    for (const table of PILOT_ORDER_PURGE_DELETE_TABLES) {
      const model = modelsByTable.get(table);
      expect(model).toBeDefined();
      for (const idField of model?.fields.filter(({ isId }) => isId) ?? []) {
        expect(PILOT_ORDER_PURGE_IDENTIFIER_SOURCES).toContainEqual(
          expect.objectContaining({ table, column: idField.dbName ?? idField.name }),
        );
      }
    }
    expect(identifierSql).toMatch(
      /"namespace" text NOT NULL[\s\S]+PRIMARY KEY \("namespace", "value"\)/u,
    );
    expect(identifierSql).toContain('\'PLENKA_ORDER=\' || btrim(order_row."orderNumber")');
    expect(identifierSql).not.toMatch(/sourceFingerprint|onec_invoices"[^;]+"number"/u);
    expect(identifierSql).not.toMatch(
      /snapshot\."subjectId"|snapshot\."parsed" #>> '\{externalId\}'/u,
    );
    expect(identifierSql).toMatch(
      /operational_checks[\s\S]+pilot_order_purge_identifiers[\s\S]+operational_incidents/u,
    );
  });

  it('keeps physical, access, reference and active layout tables outside every delete', () => {
    const mustPreserve = [
      'users',
      'sessions',
      'user_capability_overrides',
      'access_templates',
      'counterparties',
      'counterparty_order_templates',
      'counterparty_order_template_versions',
      'defect_bag_label_print_jobs',
      'defect_bag_movements',
      'defect_bag_scan_tokens',
      'defect_bags',
      'stock_production_templates',
      'stock_production_template_versions',
      'raw_material_definitions',
      'raw_material_stocks',
      'recipe_definitions',
      'recipe_definition_versions',
      'recipe_ingredients',
      'material_price_references',
      'spool_price_references',
      'spool_stock_receipts',
      'spool_stock_movements',
      'posts',
      'device_runtimes',
      'big_bag_units',
      'big_bag_scan_tokens',
      'big_bag_movements',
      'big_bag_label_print_jobs',
      'shift_bag_usages',
      'shift_bag_usage_episodes',
      'pallet_label_layout_versions',
      'pallet_label_layout_publish_commands',
      'warehouse_coverage_inventory_epochs',
      'onec_nomenclature_items',
      'onec_organizations',
      'onec_warehouses',
      'onec_stock_balances',
      'onec_stock_push_operations',
      'onec_sync_runs',
      'onec_production_reports',
      'onec_production_output_lines',
      'onec_production_material_lines',
    ];

    expect(PILOT_ORDER_PURGE_PRESERVED_TABLES).toEqual(expect.arrayContaining(mustPreserve));
    expect(PILOT_ORDER_PURGE_DELETE_TABLES).not.toEqual(expect.arrayContaining(mustPreserve));
    expect(PILOT_ORDER_PURGE_DISABLE_TRIGGER_STATEMENTS.join('\n')).not.toMatch(
      /big_bag|raw_material|device_runtime|access_template|pallet_label_layout/u,
    );
    expect(PILOT_ORDER_PURGE_PRESERVED_FINGERPRINT_QUERY).toContain('_prisma_migrations');
    for (const selectiveTable of [
      'source_snapshots',
      'sync_journals',
      'onec_invoices',
      'onec_invoice_lines',
      'onec_payments',
      'onec_shipments',
      'onec_shipment_lines',
    ]) {
      expect(PILOT_ORDER_PURGE_TABLE_BOUNDARY[selectiveTable]).toBe('delete-order-linked');
      expect(PILOT_ORDER_PURGE_DELETE_TABLES).not.toContain(selectiveTable);
      expect(PILOT_ORDER_PURGE_PRESERVED_FINGERPRINT_QUERY).toContain(selectiveTable);
    }
  });

  it('declares nullable SET NULL defect provenance for the preserved physical spool ledger', () => {
    const schema = readFileSync(resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8');
    const migration = readFileSync(
      resolve(
        __dirname,
        '../../../prisma/migrations/20260812120000_preserve_spool_movements_on_order_purge/migration.sql',
      ),
      'utf8',
    );
    const movementModel = schema.match(/model SpoolStockMovement \{[\s\S]*?\n\}/u)?.[0] ?? '';

    expect(PILOT_ORDER_PURGE_DELETE_TABLES).not.toContain('spool_stock_movements');
    expect(movementModel).toMatch(/defectRecordId\s+String\?/u);
    expect(movementModel).toMatch(
      /@relation\(fields: \[defectRecordId\], references: \[id\], onDelete: SetNull/u,
    );
    expect(migration).toMatch(/DROP CONSTRAINT "spool_stock_movements_defectRecordId_fkey"/u);
    expect(migration).toMatch(/ALTER COLUMN "defectRecordId" DROP NOT NULL/u);
    expect(migration).toMatch(/ON DELETE SET NULL/u);
    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(PILOT_ORDER_PURGE_PRESERVED_FINGERPRINT_QUERY).toMatch(
      /spoolMovementPhysical[\s\S]+tareKg[\s\S]+quantity[\s\S]+location/u,
    );
  });

  it('deletes the order and defect while preserving spool count and physical aggregate', async () => {
    const { durableState, prisma } = setup();
    const before = durableState.spoolMovements.map((movement) => ({
      id: movement.id,
      tareKg: movement.tareKg,
      quantity: movement.quantity,
      location: movement.location,
    }));

    await purgePilotOrderHistory(
      prisma as never,
      PILOT_ORDER_HISTORY_PURGE_CONFIRMATION,
      'pilot',
      'pilot',
      'yes',
    );

    expect(durableState.orderRows).toBe(0);
    expect(durableState.defectRows).toBe(0);
    expect(
      durableState.spoolMovements.map((movement) => ({
        id: movement.id,
        tareKg: movement.tareKg,
        quantity: movement.quantity,
        location: movement.location,
      })),
    ).toEqual(before);
    expect(durableState.spoolMovements).toHaveLength(1);
    expect(durableState.spoolMovements[0]?.defectRecordId).toBeNull();
  });

  it('resets template usage, deletes pallet documents and preserves layout bytes', async () => {
    const { durableState, prisma, tx } = setup();

    const result = await purgePilotOrderHistory(
      prisma as never,
      PILOT_ORDER_HISTORY_PURGE_CONFIRMATION,
      'pilot',
      'pilot',
      'yes',
    );

    const statements = tx.$executeRawUnsafe.mock.calls.map(([statement]) => String(statement));
    expect(statements).toEqual(expect.arrayContaining(PILOT_ORDER_PURGE_TEMPLATE_RESET_STATEMENTS));
    expect(durableState.deletedTables).toContain('pallet_list_documents');
    expect(durableState.deletedTables).not.toContain('pallet_label_layout_versions');
    expect(durableState.deletedTables).not.toContain('pallet_label_layout_publish_commands');
    expect(result.preservedFingerprint).toEqual({
      users: 'users-hash',
      activeLayout: 'layout-hash',
      raw: 'raw-hash',
    });
  });

  it('removes every role-inbox event plus identifier references without deleting unrelated audits', () => {
    const registryTypes = [
      ...new Set(ROLE_INBOX_PRESENTATIONS.map((presentation) => presentation.eventType)),
    ].sort();
    expect(PILOT_ROLE_INBOX_EVENT_TYPES).toEqual(registryTypes);
    expect(PILOT_ORDER_PURGE_EVENT_DELETE_STATEMENT).toContain(
      '= ANY($pilot_role_inbox_event_types$',
    );
    expect(PILOT_ORDER_PURGE_EVENT_DELETE_STATEMENT).toContain('"namespace"');
    expect(PILOT_ORDER_PURGE_EVENT_DELETE_STATEMENT).toContain('"objectId"');
    expect(PILOT_ORDER_PURGE_EVENT_DELETE_STATEMENT).toContain('"sourceSnapshotId"');
    expect(PILOT_ORDER_PURGE_EVENT_DELETE_STATEMENT).toContain("#>> '{orderId}'");
    expect(PILOT_ORDER_PURGE_EVENT_DELETE_STATEMENT).toContain("#> '{rollIds}'");
    expect(PILOT_ORDER_PURGE_EVENT_DELETE_STATEMENT).toContain("#>> '{subjectType}'");
    expect(PILOT_ORDER_PURGE_EVENT_DELETE_STATEMENT).not.toMatch(/\$\.\*\*|jsonb_path_exists/u);
    expect(PILOT_ORDER_PURGE_EVENT_DELETE_STATEMENT).not.toContain("#>> '{operationKey}'");
    expect(PILOT_ORDER_PURGE_EVENT_DELETE_STATEMENT).not.toMatch(
      /audit:pallet_label_layout_published|device\.scale\.offline|audit:raw_material_received/u,
    );
    expect(PILOT_ORDER_PURGE_ZERO_VALIDATION_QUERY).toMatch(
      /notification_receipts[\s\S]+role_inbox_events/u,
    );
  });

  it('re-enables exact USER triggers in the same transaction', async () => {
    const { durableState, prisma, tx } = setup();

    await purgePilotOrderHistory(
      prisma as never,
      PILOT_ORDER_HISTORY_PURGE_CONFIRMATION,
      'pilot',
      'pilot',
      'yes',
    );

    expect(durableState.disabledTriggers.size).toBe(0);
    const statements = tx.$executeRawUnsafe.mock.calls.map(([statement]) => statement);
    for (const disabled of PILOT_ORDER_PURGE_DISABLE_TRIGGER_STATEMENTS) {
      expect(statements).toContain(disabled);
    }
    for (const enabled of PILOT_ORDER_PURGE_ENABLE_TRIGGER_STATEMENTS) {
      expect(statements).toContain(enabled);
    }
    expect(statements.indexOf(PILOT_ORDER_PURGE_ENABLE_TRIGGER_STATEMENTS[0])).toBeGreaterThan(
      statements.indexOf(PILOT_ORDER_PURGE_EVENT_DELETE_STATEMENT),
    );
  });

  it('rolls back deleted data and trigger state when any statement fails', async () => {
    const firstDelete = `DELETE FROM "${PILOT_ORDER_PURGE_DELETE_TABLES[0]}"`;
    const { durableState, prisma } = setup({
      failOnStatement: (statement) => statement.startsWith(firstDelete),
    });

    await expect(
      purgePilotOrderHistory(
        prisma as never,
        PILOT_ORDER_HISTORY_PURGE_CONFIRMATION,
        'pilot',
        'pilot',
        'yes',
      ),
    ).rejects.toThrow('injected purge failure');
    expect(durableState.deletedTables.size).toBe(0);
    expect(durableState.disabledTriggers.size).toBe(0);
  });

  it.each([
    [{ users: 'changed' }, 0, 'preserved fingerprint changed'],
    [{ users: 'users-hash', activeLayout: 'layout-hash', raw: 'raw-hash' }, 1, 'rows remain'],
  ])(
    'rolls back when post-delete validation fails',
    async (afterFingerprint, remaining, message) => {
      const { durableState, prisma } = setup({ afterFingerprint, remaining });

      await expect(
        purgePilotOrderHistory(
          prisma as never,
          PILOT_ORDER_HISTORY_PURGE_CONFIRMATION,
          'pilot',
          'pilot',
          'yes',
        ),
      ).rejects.toThrow(message);
      expect(durableState.deletedTables.size).toBe(0);
      expect(durableState.disabledTriggers.size).toBe(0);
    },
  );
});
