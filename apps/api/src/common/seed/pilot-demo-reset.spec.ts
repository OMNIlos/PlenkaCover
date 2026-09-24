import {
  PILOT_DEMO_RESET_CONFIRMATION,
  PILOT_RUNTIME_ADVISORY_LOCK_QUERY,
  PILOT_RUNTIME_DISABLE_TRIGGER_STATEMENTS,
  PILOT_RUNTIME_ENABLE_TRIGGER_STATEMENTS,
  PILOT_RUNTIME_FINALIZE_STATEMENTS,
  PILOT_RUNTIME_MAINTENANCE_STATEMENTS,
  PILOT_RUNTIME_PREPARE_STATEMENTS,
  PILOT_RUNTIME_DELETE_TABLES,
  PilotDemoResetError,
  resetPilotDemoData,
} from './pilot-demo-reset';

function setup() {
  const tx = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ locked: 1 }]),
    user: {
      findFirst: jest.fn().mockImplementation(async ({ where }) => {
        if (where.role === 'admin') return { id: 'admin-user-1' };
        if (where.externalId === 'seed-operator-2') {
          return { id: 'operator-ruslan-1', displayName: 'Хабибулин Руслан' };
        }
        return null;
      }),
    },
    post: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'post-1',
        code: 'POST-1',
        name: 'Бегемот',
        status: 'active',
      }),
    },
    rawMaterialStock: {
      findUnique: jest.fn().mockResolvedValue({
        materialId: 'pilot-rm-pvd-15803',
        label: 'ПВД 15803-020',
      }),
      findFirst: jest.fn(),
    },
    counterparty: {
      findUnique: jest.fn().mockResolvedValue({ id: 'pilot-test-counterparty' }),
      findFirst: jest.fn(),
    },
    counterpartyOrderTemplate: {
      upsert: jest.fn(async ({ where, create }) => ({ ...create, id: where.id })),
    },
    counterpartyOrderTemplateVersion: {
      upsert: jest.fn(async ({ create }) => ({ ...create, id: `${create.templateId}-version` })),
    },
    stockProductionTemplate: {
      upsert: jest.fn(async ({ where, create }) => ({ ...create, id: where.id })),
    },
    stockProductionTemplateVersion: {
      upsert: jest.fn(async ({ create }) => ({ ...create, id: `${create.templateId}-version` })),
    },
    commercialOrder: {
      create: jest.fn().mockResolvedValue({
        id: 'demo-order-001',
        positions: [{ id: 'demo-position-001' }],
      }),
    },
    productionOrder: {
      create: jest.fn().mockResolvedValue({ id: 'demo-production-001' }),
    },
    shift: {
      create: jest.fn().mockResolvedValue({ id: 'demo-shift-001' }),
    },
    operatorShiftMachineAssignment: {
      create: jest.fn().mockResolvedValue({ id: 'demo-assignment-001' }),
    },
    rollDispatchItem: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    operatorRollLine: {
      create: jest.fn().mockResolvedValue({ id: 'demo-operator-line-001' }),
    },
    financeOrder: {
      create: jest.fn().mockResolvedValue({ id: 'demo-finance-001' }),
    },
    domainEvent: {
      create: jest.fn().mockResolvedValue({ id: 'reset-event-1' }),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  return { prisma, tx };
}

describe('resetPilotDemoData', () => {
  it('requires the exact destructive confirmation before opening a transaction', async () => {
    const { prisma } = setup();

    await expect(
      resetPilotDemoData(prisma as never, 'yes', 'pilot', 'pilot'),
    ).rejects.toBeInstanceOf(PilotDemoResetError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['production', 'pilot'],
    ['pilot', 'production'],
    [undefined, 'pilot'],
    ['pilot', undefined],
  ])(
    'rejects a destructive reset for APP_ENV=%s / SEED_PROFILE=%s before a transaction',
    async (appEnvironment, seedProfile) => {
      const { prisma } = setup();

      await expect(
        resetPilotDemoData(
          prisma as never,
          PILOT_DEMO_RESET_CONFIRMATION,
          appEnvironment,
          seedProfile,
        ),
      ).rejects.toThrow('available only for the pilot profile');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('clears runtime and creates one POST-1 roll ready for Хабибулин Руслан', async () => {
    const { prisma, tx } = setup();

    const result = await resetPilotDemoData(
      prisma as never,
      PILOT_DEMO_RESET_CONFIRMATION,
      'pilot',
      'pilot',
    );

    const statements = tx.$executeRawUnsafe.mock.calls.map(([statement]) => String(statement));
    expect(statements).toHaveLength(
      PILOT_RUNTIME_MAINTENANCE_STATEMENTS.length +
        PILOT_RUNTIME_DISABLE_TRIGGER_STATEMENTS.length +
        PILOT_RUNTIME_PREPARE_STATEMENTS.length +
        PILOT_RUNTIME_DELETE_TABLES.length +
        PILOT_RUNTIME_ENABLE_TRIGGER_STATEMENTS.length +
        PILOT_RUNTIME_FINALIZE_STATEMENTS.length,
    );
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(PILOT_RUNTIME_ADVISORY_LOCK_QUERY);
    for (const statement of PILOT_RUNTIME_MAINTENANCE_STATEMENTS) {
      expect(statements).toContain(statement);
    }
    for (const statement of PILOT_RUNTIME_DISABLE_TRIGGER_STATEMENTS) {
      expect(statements).toContain(statement);
    }
    for (const statement of PILOT_RUNTIME_PREPARE_STATEMENTS) {
      expect(statements).toContain(statement);
    }
    for (const statement of PILOT_RUNTIME_ENABLE_TRIGGER_STATEMENTS) {
      expect(statements).toContain(statement);
    }
    for (const statement of PILOT_RUNTIME_FINALIZE_STATEMENTS) {
      expect(statements).toContain(statement);
    }
    for (const table of PILOT_RUNTIME_DELETE_TABLES) {
      expect(statements).toContain(`DELETE FROM "${table}"`);
    }
    expect(statements.join('\n')).not.toMatch(
      /domain_events|users|user_capability_overrides|access_templates|posts|device_runtimes|counterparties|raw_material_stocks|raw_material_definitions|recipe_definitions/u,
    );
    const deleteIndex = (table: string) => statements.indexOf(`DELETE FROM "${table}"`);
    expect(deleteIndex('commercial_orders')).toBeLessThan(
      deleteIndex('counterparty_order_template_versions'),
    );
    expect(deleteIndex('commercial_orders')).toBeLessThan(
      deleteIndex('stock_production_template_versions'),
    );
    expect(deleteIndex('counterparty_order_template_versions')).toBeLessThan(
      deleteIndex('counterparty_order_templates'),
    );
    expect(deleteIndex('stock_production_template_versions')).toBeLessThan(
      deleteIndex('stock_production_templates'),
    );
    expect(deleteIndex('operator_shift_machine_assignment_cancellation_commands')).toBeLessThan(
      deleteIndex('operator_shift_machine_assignments'),
    );
    expect(deleteIndex('finance_payment_correction_commands')).toBeLessThan(
      deleteIndex('finance_orders'),
    );
    expect(deleteIndex('commercial_order_amendment_commands')).toBeLessThan(
      deleteIndex('commercial_orders'),
    );
    expect(PILOT_RUNTIME_DELETE_TABLES).toContain('pallet_print_reconciliations');
    expect(deleteIndex('pallet_print_reconciliations')).toBeLessThan(
      deleteIndex('pallet_print_jobs'),
    );
    expect(PILOT_RUNTIME_DISABLE_TRIGGER_STATEMENTS).toContain(
      'ALTER TABLE "pallet_print_reconciliations" DISABLE TRIGGER USER',
    );
    expect(PILOT_RUNTIME_ENABLE_TRIGGER_STATEMENTS).toContain(
      'ALTER TABLE "pallet_print_reconciliations" ENABLE TRIGGER USER',
    );
    expect(PILOT_RUNTIME_DISABLE_TRIGGER_STATEMENTS).toContain(
      'ALTER TABLE "warehouse_pallet_commands" DISABLE TRIGGER USER',
    );
    expect(PILOT_RUNTIME_ENABLE_TRIGGER_STATEMENTS).toContain(
      'ALTER TABLE "warehouse_pallet_commands" ENABLE TRIGGER USER',
    );
    for (const palletTable of [
      'warehouse_pallet_commands',
      'warehouse_pallet_items',
      'warehouse_pallets',
    ]) {
      expect(PILOT_RUNTIME_DELETE_TABLES).toContain(palletTable);
    }
    expect(deleteIndex('pallet_list_documents')).toBeLessThan(deleteIndex('warehouse_pallets'));
    expect(deleteIndex('warehouse_pallet_commands')).toBeLessThan(deleteIndex('warehouse_pallets'));
    expect(deleteIndex('warehouse_pallet_items')).toBeLessThan(deleteIndex('warehouse_pallets'));
    expect(deleteIndex('warehouse_pallet_items')).toBeLessThan(deleteIndex('scan_rows'));
    expect(deleteIndex('warehouse_pallets')).toBeLessThan(
      deleteIndex('warehouse_acceptance_tasks'),
    );
    for (const childTable of [
      'big_bag_label_print_jobs',
      'big_bag_movements',
      'big_bag_scan_tokens',
    ]) {
      expect(PILOT_RUNTIME_DELETE_TABLES).toContain(childTable);
      expect(deleteIndex(childTable)).toBeLessThan(deleteIndex('big_bag_units'));
    }

    expect(tx.counterpartyOrderTemplate.upsert).toHaveBeenCalledTimes(2);
    expect(tx.counterpartyOrderTemplateVersion.upsert).toHaveBeenCalledTimes(2);
    expect(tx.stockProductionTemplate.upsert).toHaveBeenCalledTimes(1);
    expect(tx.stockProductionTemplateVersion.upsert).toHaveBeenCalledTimes(1);
    const canonicalPositionSnapshots = [
      ...tx.counterpartyOrderTemplate.upsert.mock.calls,
      ...tx.counterpartyOrderTemplateVersion.upsert.mock.calls,
      ...tx.stockProductionTemplate.upsert.mock.calls,
      ...tx.stockProductionTemplateVersion.upsert.mock.calls,
    ].map(([command]) => command.create.positions);
    for (const positions of canonicalPositionSnapshots) {
      expect(positions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            widthMm: expect.any(Number),
            plannedLengthM: expect.any(Number),
          }),
        ]),
      );
      expect(
        positions.every(
          (position: { widthMm?: number; plannedLengthM?: number }) =>
            Number.isFinite(position.widthMm) &&
            Number(position.widthMm) > 0 &&
            Number.isFinite(position.plannedLengthM) &&
            Number(position.plannedLengthM) > 0,
        ),
      ).toBe(true);
    }

    expect(tx.commercialOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: 'demo-order-001',
          orderNumber: 'DEMO-001',
          productionIndicator: 'in_production',
          warehouseCoverStatus: 'needs_production',
          commercialStage: 'sent_to_finance',
          counterpartyId: 'pilot-test-counterparty',
          positions: {
            create: expect.objectContaining({
              id: 'demo-position-001',
              rollCount: 1,
              rawMaterialId: 'pilot-rm-pvd-15803',
              filmType: 'Пленка полиэтиленовая полотно 80 мкм 1700 мм 275 м',
              widthMm: 1700,
              plannedLengthM: 275,
              warehouseCoverStatus: 'needs_production',
              recipe: {
                create: expect.not.objectContaining({
                  recipeName: expect.anything(),
                  ingredients: expect.anything(),
                }),
              },
            }),
          },
        }),
        include: { positions: { select: { id: true } } },
      }),
    );
    expect(tx.productionOrder.create).toHaveBeenCalledWith({
      data: {
        id: 'demo-production-001',
        commercialOrderId: 'demo-order-001',
        indicator: 'in_production',
        approvalState: 'approved',
      },
    });
    expect(tx.shift.create).toHaveBeenCalledWith({
      data: {
        id: 'demo-shift-001',
        label: 'Тест физических устройств',
        plannedStartAt: null,
        plannedEndAt: null,
        status: 'planned',
      },
    });
    expect(tx.operatorShiftMachineAssignment.create).toHaveBeenCalledWith({
      data: {
        id: 'demo-assignment-001',
        shiftId: 'demo-shift-001',
        operatorId: 'operator-ruslan-1',
        postId: 'post-1',
        status: 'planned',
        createdById: 'admin-user-1',
      },
    });
    expect(tx.rollDispatchItem.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          id: 'demo-dispatch-001',
          rollCode: 'DEMO-001-roll-1',
          widthMm: 1700,
          plannedLengthM: 275,
          characteristicsSnapshot: expect.objectContaining({
            actualThickness: '80 мкм',
            accountingThickness: '80 мкм',
            widthMm: 1700,
            plannedLengthM: 275,
          }),
          status: 'assigned',
          assignedOperatorId: 'operator-ruslan-1',
          machineId: 'POST-1',
          postId: 'post-1',
          plannedShiftId: 'demo-shift-001',
        }),
      ],
    });
    expect(tx.operatorRollLine.create).toHaveBeenCalledWith({
      data: {
        id: 'demo-operator-line-001',
        rollDispatchItemId: 'demo-dispatch-001',
        sequence: 1,
        planKg: 42.3,
        step: 'assigned',
      },
    });
    expect(tx.financeOrder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: 'demo-finance-001',
        commercialOrderId: 'demo-order-001',
        invoiceStatus: 'invoiced',
        paymentStatus: 'unpaid',
        paymentTermsType: 'postpay_100_30d',
        invoiceIssuedAt: expect.any(Date),
      }),
    });
    expect(tx.domainEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        family: 'audit',
        type: 'audit:pilot_demo_reset',
        objectId: 'DEMO-001',
        actorKind: 'user',
        actorRole: 'admin',
        actorId: 'admin-user-1',
        systemActorKey: null,
      }),
    });
    expect(tx.domainEvent.create.mock.invocationCallOrder[0]).toBeGreaterThan(
      tx.$executeRawUnsafe.mock.invocationCallOrder.at(-1) ?? 0,
    );
    expect(result).toEqual({
      resetEventId: 'reset-event-1',
      orderId: 'demo-order-001',
      orderNumber: 'DEMO-001',
      rollCount: 1,
      removedRows: PILOT_RUNTIME_DELETE_TABLES.length,
    });
  });

  it('falls back to a real warehouse material when the preferred pilot material is absent', async () => {
    const { prisma, tx } = setup();
    tx.rawMaterialStock.findUnique.mockResolvedValue(null);
    tx.rawMaterialStock.findFirst.mockResolvedValue({
      materialId: 'rm-current',
      label: 'Текущее сырьё',
    });

    await resetPilotDemoData(prisma as never, PILOT_DEMO_RESET_CONFIRMATION, 'pilot', 'pilot');

    expect(tx.rawMaterialStock.findFirst).toHaveBeenCalledWith({
      orderBy: [{ materialId: 'asc' }],
      select: { materialId: true, label: true },
    });
    expect(tx.commercialOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          positions: {
            create: expect.objectContaining({ rawMaterialId: 'rm-current' }),
          },
        }),
      }),
    );
  });

  it('falls back to a preserved counterparty instead of creating a reference object', async () => {
    const { prisma, tx } = setup();
    tx.counterparty.findUnique.mockResolvedValue(null);
    tx.counterparty.findFirst.mockResolvedValue({ id: 'existing-counterparty' });

    await resetPilotDemoData(prisma as never, PILOT_DEMO_RESET_CONFIRMATION, 'pilot', 'pilot');

    expect(tx.counterparty.findFirst).toHaveBeenCalledWith({
      orderBy: [{ id: 'asc' }],
      select: { id: true },
    });
    expect(tx.commercialOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ counterpartyId: 'existing-counterparty' }),
      }),
    );
  });

  it('rolls back when the preserved coverage epoch singleton is missing', async () => {
    const { prisma, tx } = setup();
    tx.$executeRawUnsafe.mockImplementation(async (statement: string) =>
      PILOT_RUNTIME_FINALIZE_STATEMENTS.includes(statement as never) ? 0 : 1,
    );

    await expect(
      resetPilotDemoData(prisma as never, PILOT_DEMO_RESET_CONFIRMATION, 'pilot', 'pilot'),
    ).rejects.toThrow('coverage inventory epoch singleton is missing');
    expect(tx.domainEvent.create).not.toHaveBeenCalled();
  });

  it('fails closed before maintenance DML when an active admin audit actor is absent', async () => {
    const { prisma, tx } = setup();
    tx.user.findFirst.mockResolvedValue(null);

    await expect(
      resetPilotDemoData(prisma as never, PILOT_DEMO_RESET_CONFIRMATION, 'pilot', 'pilot'),
    ).rejects.toThrow('active admin account is required');
    expect(tx.$executeRawUnsafe.mock.calls.map(([statement]) => statement)).toEqual(
      PILOT_RUNTIME_MAINTENANCE_STATEMENTS,
    );
    expect(tx.domainEvent.create).not.toHaveBeenCalled();
  });
});
