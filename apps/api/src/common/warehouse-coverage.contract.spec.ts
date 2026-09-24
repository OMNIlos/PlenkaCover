import {
  CAPABILITIES,
  DOMAIN_EVENTS,
  REQUIRED_WAREHOUSE_COVERAGE_PROJECTION_FIELDS,
  ROLES,
  ROLE_CAPABILITIES,
  WAREHOUSE_COVERAGE_ACTIONS,
  WAREHOUSE_COVERAGE_AVAILABILITIES,
  WAREHOUSE_COVERAGE_COMMANDS,
  WAREHOUSE_COVERAGE_DECISIONS,
  WAREHOUSE_COVERAGE_FACT_SOURCES,
  WAREHOUSE_COVERAGE_OWNERS,
  WAREHOUSE_COVERAGE_REASON_CODES,
  WAREHOUSE_COVERAGE_RECOVERY_COMMANDS,
  WAREHOUSE_COVERAGE_RECHECK_ORIGINS,
  WAREHOUSE_COVERAGE_STATES,
  WAREHOUSE_COVERAGE_WORKFLOW_VERSIONS,
  type Capability,
  type Role,
} from '@plenka/contracts';
import { loadRuntimeConfig } from './runtime-config';

const WAREHOUSE_COVERAGE_EVENTS = [
  'audit:warehouse_coverage_calculated',
  'audit:warehouse_coverage_decided',
  'audit:warehouse_coverage_recheck_requested',
  'audit:warehouse_roll_coverage_fact_corrected',
  'audit:warehouse_coverage_recheck_resolved',
  'audit:warehouse_coverage_reserved',
  'audit:warehouse_coverage_reservation_cancelled',
  'audit:warehouse_coverage_order_spec_invalidated',
] as const;

describe('automatic warehouse coverage V2 public contract', () => {
  it('locks every closed warehouse coverage vocabulary', () => {
    expect(WAREHOUSE_COVERAGE_WORKFLOW_VERSIONS).toEqual([1, 2]);
    expect(WAREHOUSE_COVERAGE_FACT_SOURCES).toEqual([
      'production_handover',
      'warehouse_recheck',
      'migration_backfill',
      'order_cancellation',
    ]);
    expect(WAREHOUSE_COVERAGE_AVAILABILITIES).toEqual(['verified_full', 'unavailable', 'unknown']);
    expect(WAREHOUSE_COVERAGE_STATES).toEqual([
      'calculating',
      'awaiting_finance',
      'production_required',
      'unknown',
      'recheck_requested',
      'warehouse_reserved',
      'stale',
      'order_spec_changed',
    ]);
    expect(WAREHOUSE_COVERAGE_DECISIONS).toEqual([
      'use_warehouse',
      'produce_all',
      'auto_produce_all',
    ]);
    expect(WAREHOUSE_COVERAGE_COMMANDS).toEqual([
      'refresh',
      'decide',
      'request_recheck',
      'resolve_recheck',
    ]);
    expect(WAREHOUSE_COVERAGE_RECOVERY_COMMANDS).toEqual(['cancel_reservation']);
    expect(WAREHOUSE_COVERAGE_RECHECK_ORIGINS).toEqual([
      'finance_request',
      'decision_linked_physical_exception',
    ]);
    expect(WAREHOUSE_COVERAGE_OWNERS).toEqual(['finance', 'commercial', 'warehouse', 'system']);
    expect(WAREHOUSE_COVERAGE_ACTIONS).toEqual([
      'use_warehouse',
      'produce_all',
      'request_recheck',
      'correct_order_spec',
      'resolve_recheck',
      'refresh',
      'report_physical_exception',
    ]);
    expect(WAREHOUSE_COVERAGE_REASON_CODES).toEqual([
      'full_cover_available',
      'no_compatible_rolls',
      'only_partial_cover',
      'order_spec_incomplete',
      'roll_facts_incomplete',
      'roll_ownership_unverified',
      'unsupported_policy_version',
      'inventory_changed',
      'warehouse_recheck_pending',
    ]);
  });

  it('locks the safe projection and role-owned capabilities', () => {
    expect(REQUIRED_WAREHOUSE_COVERAGE_PROJECTION_FIELDS).toEqual([
      'workflowVersion',
      'state',
      'stateVersion',
      'generation',
      'availability',
      'reasonCodes',
      'nextOwner',
      'availableActions',
      'requiredRollCount',
      'matchedRollCount',
      'uncertainRollCount',
      'calculatedAt',
      'stale',
    ]);
    expect(ROLE_CAPABILITIES.finance).toEqual(
      expect.arrayContaining([
        'warehouse_coverage:refresh',
        'warehouse_coverage:decide',
        'warehouse_coverage:request_recheck',
      ]),
    );
    expect(ROLE_CAPABILITIES.warehouse).toEqual(
      expect.arrayContaining([
        'warehouse_coverage:resolve_recheck',
        'warehouse_coverage:report_physical_exception',
      ]),
    );

    const capabilityOwners = {
      'warehouse_coverage:refresh': ['finance'],
      'warehouse_coverage:decide': ['finance'],
      'warehouse_coverage:request_recheck': ['finance'],
      'warehouse_coverage:resolve_recheck': ['warehouse'],
      'warehouse_coverage:report_physical_exception': ['warehouse'],
    } as const satisfies Partial<Record<Capability, readonly Role[]>>;

    expect(CAPABILITIES).toEqual(expect.arrayContaining(Object.keys(capabilityOwners)));
    for (const [capability, allowedRoles] of Object.entries(capabilityOwners) as Array<
      [keyof typeof capabilityOwners, readonly Role[]]
    >) {
      for (const role of ROLES) {
        expect(ROLE_CAPABILITIES[role].includes(capability)).toBe(allowedRoles.includes(role));
      }
    }
  });

  it('locks the aggregate-safe warehouse coverage audit vocabulary', () => {
    expect(
      DOMAIN_EVENTS.filter(
        (event) =>
          event.startsWith('audit:warehouse_coverage_') ||
          event === 'audit:warehouse_roll_coverage_fact_corrected',
      ),
    ).toEqual(WAREHOUSE_COVERAGE_EVENTS);
    expect(WAREHOUSE_COVERAGE_EVENTS).not.toContain('audit:warehouse_rolls_reserved_for_order');
  });

  it('keeps the rollout disabled by default and rejects non-boolean spellings', () => {
    expect(loadRuntimeConfig({ APP_ENV: 'test' }).warehouseCoverageV2Enabled).toBe(false);
    expect(() =>
      loadRuntimeConfig({
        APP_ENV: 'test',
        WAREHOUSE_COVERAGE_V2_ENABLED: '1',
      }),
    ).toThrow('must be exactly "true" or "false"');
  });
});
