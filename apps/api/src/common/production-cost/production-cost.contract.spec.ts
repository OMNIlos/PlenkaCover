import {
  CAPABILITIES,
  DOMAIN_EVENTS,
  PRODUCTION_COST_UNRESOLVED_LABELS,
  PRODUCTION_COST_UNRESOLVED_REASONS,
  ROLES,
  ROLE_CAPABILITIES,
  type PersistedRollProductionCostSnapshotView,
  type RollProductionCostPendingView,
  type RollProductionCostView,
} from '@plenka/contracts';
import { ADMIN_CAPABILITY_METADATA } from '../../modules/admin/admin-capability-catalog';

describe('production cost shared contract', () => {
  it('assigns narrow capabilities only to the owning business roles', () => {
    expect(CAPABILITIES).toEqual(
      expect.arrayContaining([
        'production_cost:read',
        'spool_price:manage',
        'spool_stock:receive',
        'spool_stock:read',
        'production_cost:correct',
      ]),
    );
    expect(ROLE_CAPABILITIES.commercial).toContain('production_cost:read');
    expect(ROLE_CAPABILITIES.director).toContain('production_cost:read');
    expect(ROLE_CAPABILITIES.warehouse).toContain('spool_price:manage');
    expect(ROLE_CAPABILITIES.warehouse).toEqual(
      expect.arrayContaining(['spool_stock:receive', 'spool_stock:read']),
    );
    expect(ROLE_CAPABILITIES.production_lead).toContain('spool_stock:read');
    expect(ROLE_CAPABILITIES.finance).toContain('production_cost:correct');

    for (const role of ROLES.filter((role) => role !== 'warehouse')) {
      expect(ROLE_CAPABILITIES[role]).not.toContain('spool_stock:receive');
    }
    for (const role of ROLES.filter(
      (role) => role !== 'warehouse' && role !== 'production_lead',
    )) {
      expect(ROLE_CAPABILITIES[role]).not.toContain('spool_stock:read');
    }

    for (const role of ['production_lead', 'operator', 'warehouse', 'finance', 'admin'] as const) {
      if (role !== 'warehouse') expect(ROLE_CAPABILITIES[role]).not.toContain('spool_price:manage');
      if (role !== 'finance') {
        expect(ROLE_CAPABILITIES[role]).not.toContain('production_cost:correct');
      }
      expect(ROLE_CAPABILITIES[role]).not.toContain('production_cost:read');
    }
  });

  it('publishes audited append-only price, snapshot, and correction facts', () => {
    expect(DOMAIN_EVENTS).toEqual(
      expect.arrayContaining([
        'audit:spool_price_reference_recorded',
        'audit:spool_stock_receipt_recorded',
        'audit:roll_production_cost_snapshotted',
        'audit:roll_production_cost_corrected',
      ]),
    );
  });

  it('provides a Russian label for every stable unresolved reason', () => {
    expect(PRODUCTION_COST_UNRESOLVED_REASONS).toEqual(
      expect.arrayContaining([
        'weight_unresolved',
        'material_usage_unresolved',
        'material_price_unresolved',
        'spool_type_unresolved',
        'spool_price_unresolved',
        'spool_geometry_unresolved',
        'payroll_unresolved',
        'order_cost_allocation_unresolved',
        'additional_cost_unresolved',
      ]),
    );
    for (const reason of PRODUCTION_COST_UNRESOLVED_REASONS) {
      expect(PRODUCTION_COST_UNRESOLVED_LABELS[reason]).toEqual(expect.any(String));
      expect(PRODUCTION_COST_UNRESOLVED_LABELS[reason].trim()).not.toBe('');
    }
  });

  it('publishes non-empty Russian admin metadata for every new capability', () => {
    for (const capability of [
      'production_cost:read',
      'spool_price:manage',
      'spool_stock:receive',
      'spool_stock:read',
      'production_cost:correct',
    ] as const) {
      const metadata = ADMIN_CAPABILITY_METADATA[capability];
      expect(metadata.label).toMatch(/[А-Яа-яЁё]/u);
      expect(metadata.description).toMatch(/[А-Яа-яЁё]/u);
      expect(metadata.group).toMatch(/[А-Яа-яЁё]/u);
    }
  });

  it('discriminates live planned, stored actual, and pending actual views', () => {
    const stored: PersistedRollProductionCostSnapshotView = {
      kind: 'actual_snapshot',
      status: 'complete',
      calculationVersion: 'historical-production-cost-v0',
      snapshotId: 'snapshot-1',
      version: 1,
      producedAt: '2026-08-02T10:00:00.000Z',
      closedAt: '2026-08-02T18:00:00.000Z',
      createdAt: '2026-08-02T18:00:01.000Z',
      basis: { kind: 'actual', weightGrams: 10_000 },
      materialAmountKopecks: 2_000,
      spoolAmountKopecks: 9_000,
      payrollAmountKopecks: 4_000,
      payrollSource: null,
      additionalAmountKopecks: 0,
      totalAmountKopecks: 15_000,
      totalKopecksPerKg: 1_500,
      unresolvedReasons: [],
    };
    const pending: RollProductionCostPendingView = {
      kind: 'actual_pending',
      status: 'pending',
      calculationVersion: 'production-cost-v1',
      basis: { kind: 'actual', weightGrams: null },
      materialAmountKopecks: null,
      spoolAmountKopecks: null,
      payrollAmountKopecks: null,
      payrollSource: null,
      additionalAmountKopecks: 0,
      totalAmountKopecks: null,
      totalKopecksPerKg: null,
      unresolvedReasons: ['weight_unresolved'],
    };
    const partial: PersistedRollProductionCostSnapshotView = {
      kind: 'actual_snapshot',
      status: 'partial',
      calculationVersion: 'production-cost-v1',
      snapshotId: 'snapshot-2',
      version: 2,
      producedAt: '2026-08-02T10:00:00.000Z',
      closedAt: '2026-08-02T18:00:00.000Z',
      createdAt: '2026-08-02T18:00:02.000Z',
      basis: { kind: 'actual', weightGrams: 10_000 },
      materialAmountKopecks: 2_000,
      spoolAmountKopecks: null,
      payrollAmountKopecks: 4_000,
      payrollSource: null,
      additionalAmountKopecks: 0,
      totalAmountKopecks: null,
      totalKopecksPerKg: null,
      unresolvedReasons: ['spool_price_unresolved'],
    };
    const views: RollProductionCostView[] = [
      {
        kind: 'planned_preview',
        status: 'complete',
        calculationVersion: 'production-cost-v1',
        basis: { kind: 'planned', weightGrams: 10_000 },
        materialAmountKopecks: 2_000,
        spoolAmountKopecks: 9_000,
        payrollAmountKopecks: 4_000,
        payrollSource: null,
        additionalAmountKopecks: 0,
        totalAmountKopecks: 15_000,
        totalKopecksPerKg: 1_500,
        unresolvedReasons: [],
      },
      stored,
      partial,
      pending,
    ];

    expect(views.map(({ kind }) => kind)).toEqual([
      'planned_preview',
      'actual_snapshot',
      'actual_snapshot',
      'actual_pending',
    ]);
    expect(stored.calculationVersion).toBe('historical-production-cost-v0');
    expect('snapshotId' in pending).toBe(false);
  });

  it('makes impossible persisted and pending states fail at compile time', () => {
    const invalidComplete: PersistedRollProductionCostSnapshotView = {
      kind: 'actual_snapshot',
      status: 'complete',
      calculationVersion: 'v1',
      snapshotId: 's1',
      version: 1,
      producedAt: '2026-08-02T10:00:00.000Z',
      closedAt: '2026-08-02T18:00:00.000Z',
      createdAt: '2026-08-02T18:00:01.000Z',
      basis: { kind: 'actual', weightGrams: 1 },
      materialAmountKopecks: 1,
      spoolAmountKopecks: 1,
      payrollAmountKopecks: 1,
      payrollSource: null,
      additionalAmountKopecks: 0,
      totalAmountKopecks: null,
      totalKopecksPerKg: null,
      // @ts-expect-error complete snapshots require non-null totals and an empty reason tuple
      unresolvedReasons: ['spool_price_unresolved'],
    };
    // @ts-expect-error partial snapshots require null totals and a non-empty reason tuple
    const invalidPartial: PersistedRollProductionCostSnapshotView = {
      kind: 'actual_snapshot',
      status: 'partial',
      calculationVersion: 'v1',
      snapshotId: 's2',
      version: 1,
      producedAt: '2026-08-02T10:00:00.000Z',
      closedAt: '2026-08-02T18:00:00.000Z',
      createdAt: '2026-08-02T18:00:01.000Z',
      basis: { kind: 'actual', weightGrams: 1 },
      materialAmountKopecks: 1,
      spoolAmountKopecks: 1,
      payrollAmountKopecks: 1,
      payrollSource: null,
      additionalAmountKopecks: 0,
      totalAmountKopecks: 3,
      totalKopecksPerKg: 3_000,
      unresolvedReasons: [],
    };
    const invalidPending: RollProductionCostPendingView = {
      kind: 'actual_pending',
      status: 'pending',
      calculationVersion: 'production-cost-v1',
      basis: { kind: 'actual', weightGrams: null },
      materialAmountKopecks: null,
      spoolAmountKopecks: null,
      payrollAmountKopecks: null,
      payrollSource: null,
      additionalAmountKopecks: 0,
      totalAmountKopecks: null,
      totalKopecksPerKg: null,
      unresolvedReasons: ['snapshot_pending'],
      // @ts-expect-error pending views never carry persisted snapshot identity
      snapshotId: 'not-persisted',
    };
    expect([invalidComplete, invalidPartial, invalidPending]).toHaveLength(3);
  });
});
