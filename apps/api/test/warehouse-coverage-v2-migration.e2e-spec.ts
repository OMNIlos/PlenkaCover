import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  assertCommandSucceeded,
  assertSchemaDestructionTarget,
  createE2eSchemaName,
  type E2eCleanupAction,
  runE2eWithCleanup,
} from './e2e-database';

const API_ROOT = resolve(__dirname, '..');
const PRISMA_ROOT = resolve(API_ROOT, 'prisma');
const SOURCE_MIGRATIONS = resolve(PRISMA_ROOT, 'migrations');
const TARGET_MIGRATION = '20260724150000_warehouse_coverage_v2_engine';
const TARGET_MIGRATION_PATH = resolve(SOURCE_MIGRATIONS, TARGET_MIGRATION);
const SYSTEM_ACTOR_KEY = 'warehouse_coverage_engine';
const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

const COVERAGE_TABLE_COLUMNS = {
  warehouse_roll_coverage_facts: [
    'id',
    'rollId',
    'version',
    'source',
    'specVersion',
    'specFingerprint',
    'spec',
    'sourceOrderId',
    'sourcePositionId',
    'sourceDispatchItemId',
    'sourceWeightCaptureId',
    'actorKind',
    'actorRole',
    'actorId',
    'systemActorKey',
    'reason',
    'createdAt',
  ],
  warehouse_coverage_inventory_epochs: ['id', 'epoch', 'updatedAt'],
  warehouse_coverage_states: [
    'orderId',
    'state',
    'stateVersion',
    'generation',
    'currentCalculationId',
    'currentDecisionId',
    'createdAt',
    'updatedAt',
  ],
  warehouse_coverage_calculations: [
    'id',
    'orderId',
    'generation',
    'orderVersion',
    'positionVersions',
    'orderFingerprint',
    'inventoryEpoch',
    'inventoryFingerprint',
    'inputFingerprint',
    'algorithmVersion',
    'policyVersion',
    'availability',
    'reasonCodes',
    'requiredRollCount',
    'matchedRollCount',
    'uncertainRollCount',
    'verifiedCandidateRollIds',
    'uncertainCandidateRollIds',
    'systemActorKey',
    'calculatedAt',
  ],
  warehouse_coverage_matches: [
    'id',
    'calculationId',
    'orderId',
    'generation',
    'positionId',
    'rollId',
    'coverageFactId',
    'slotIndex',
    'createdAt',
  ],
  warehouse_coverage_decisions: [
    'id',
    'orderId',
    'calculationId',
    'generation',
    'kind',
    'inputFingerprint',
    'sourceInventoryEpoch',
    'committedInventoryEpoch',
    'expectedRollCount',
    'actorKind',
    'actorRole',
    'actorId',
    'systemActorKey',
    'createdAt',
  ],
  warehouse_coverage_commands: [
    'id',
    'clientRequestId',
    'kind',
    'orderId',
    'scopeCaseId',
    'scopeTaskId',
    'requestFingerprint',
    'actorKind',
    'actorRole',
    'actorId',
    'systemActorKey',
    'safeResultKind',
    'safeResult',
    'resultKind',
    'resultCalculationId',
    'resultDecisionId',
    'resultCaseId',
    'resultGeneration',
    'resultStateVersion',
    'createdAt',
  ],
  warehouse_coverage_recheck_memberships: [
    'id',
    'caseId',
    'orderId',
    'rollId',
    'sourceCalculationId',
    'sourceDecisionId',
    'sourceCoverageFactId',
    'sourceKind',
    'reasonCodes',
    'createdAt',
  ],
} as const;

type ExpectedColumn = {
  default: string | null;
  name: string;
  nullable: boolean;
  type: string;
};

const timestamp = (name: string): ExpectedColumn => ({
  name,
  type: 'timestamp(3) with time zone',
  nullable: false,
  default: 'CURRENT_TIMESTAMP',
});
const updatedTimestamp = (name: string): ExpectedColumn => ({
  name,
  type: 'timestamp(3) with time zone',
  nullable: false,
  default: null,
});
const required = (
  name: string,
  type = 'text',
  defaultValue: string | null = null,
): ExpectedColumn => ({
  name,
  type,
  nullable: false,
  default: defaultValue,
});
const optional = (name: string, type = 'text'): ExpectedColumn => ({
  name,
  type,
  nullable: true,
  default: null,
});

const EXACT_COVERAGE_COLUMN_DETAILS: Record<string, ExpectedColumn[]> = {
  warehouse_roll_coverage_facts: [
    required('id'),
    required('rollId'),
    required('version', 'integer'),
    required('source'),
    required('specVersion'),
    required('specFingerprint', 'character(64)'),
    required('spec', 'jsonb'),
    optional('sourceOrderId'),
    optional('sourcePositionId'),
    optional('sourceDispatchItemId'),
    optional('sourceWeightCaptureId'),
    required('actorKind'),
    optional('actorRole', '"Role"'),
    optional('actorId'),
    optional('systemActorKey'),
    optional('reason'),
    timestamp('createdAt'),
  ],
  warehouse_coverage_inventory_epochs: [
    required('id', 'integer', '1'),
    required('epoch', 'bigint', '0'),
    updatedTimestamp('updatedAt'),
  ],
  warehouse_coverage_states: [
    required('orderId'),
    required('state', 'text', "'calculating'::text"),
    required('stateVersion', 'integer', '1'),
    required('generation', 'integer', '0'),
    optional('currentCalculationId'),
    optional('currentDecisionId', 'uuid'),
    timestamp('createdAt'),
    updatedTimestamp('updatedAt'),
  ],
  warehouse_coverage_calculations: [
    required('id'),
    required('orderId'),
    required('generation', 'integer'),
    required('orderVersion', 'integer'),
    required('positionVersions', 'jsonb'),
    required('orderFingerprint', 'character(64)'),
    required('inventoryEpoch', 'bigint'),
    required('inventoryFingerprint', 'character(64)'),
    required('inputFingerprint', 'character(64)'),
    required('algorithmVersion'),
    required('policyVersion'),
    required('availability'),
    required('reasonCodes', 'jsonb'),
    required('requiredRollCount', 'integer'),
    required('matchedRollCount', 'integer'),
    required('uncertainRollCount', 'integer'),
    required('verifiedCandidateRollIds', 'jsonb'),
    required('uncertainCandidateRollIds', 'jsonb'),
    required('systemActorKey'),
    timestamp('calculatedAt'),
  ],
  warehouse_coverage_matches: [
    required('id'),
    required('calculationId'),
    required('orderId'),
    required('generation', 'integer'),
    required('positionId'),
    required('rollId'),
    required('coverageFactId'),
    required('slotIndex', 'integer'),
    timestamp('createdAt'),
  ],
  warehouse_coverage_decisions: [
    required('id', 'uuid'),
    required('orderId'),
    required('calculationId'),
    required('generation', 'integer'),
    required('kind'),
    required('inputFingerprint', 'character(64)'),
    required('sourceInventoryEpoch', 'bigint'),
    optional('committedInventoryEpoch', 'bigint'),
    required('expectedRollCount', 'integer', '0'),
    required('actorKind'),
    optional('actorRole', '"Role"'),
    optional('actorId'),
    optional('systemActorKey'),
    timestamp('createdAt'),
  ],
  warehouse_coverage_commands: [
    required('id'),
    required('clientRequestId', 'uuid'),
    required('kind'),
    required('orderId'),
    optional('scopeCaseId'),
    optional('scopeTaskId'),
    required('requestFingerprint', 'character(64)'),
    required('actorKind'),
    optional('actorRole', '"Role"'),
    optional('actorId'),
    optional('systemActorKey'),
    required('safeResultKind'),
    required('safeResult', 'jsonb'),
    required('resultKind'),
    optional('resultCalculationId'),
    optional('resultDecisionId', 'uuid'),
    optional('resultCaseId'),
    optional('resultGeneration', 'integer'),
    required('resultStateVersion', 'integer'),
    timestamp('createdAt'),
  ],
  warehouse_coverage_recheck_memberships: [
    required('id'),
    required('caseId'),
    required('orderId'),
    required('rollId'),
    required('sourceCalculationId'),
    optional('sourceDecisionId', 'uuid'),
    optional('sourceCoverageFactId'),
    required('sourceKind'),
    required('reasonCodes', 'jsonb'),
    timestamp('createdAt'),
  ],
};

const EXISTING_V2_COLUMNS: Record<string, ExpectedColumn[]> = {
  commercial_orders: [required('warehouseCoverageWorkflowVersion', 'integer', '1')],
  warehouse_rolls: [
    optional('currentCoverageFactId'),
    optional('reservedByCoverageDecisionId', 'uuid'),
  ],
  warehouse_acceptance_tasks: [optional('coverageDecisionId', 'uuid')],
  production_orders: [
    optional('sourceCoverageCalculationId'),
    optional('sourceCoverageDecisionId', 'uuid'),
    optional('sourceCoverageInputFingerprint', 'character(64)'),
    optional('sourceCoverageGeneration', 'integer'),
  ],
  order_resolution_cases: [
    optional('coverageScope'),
    optional('coverageOrigin'),
    optional('sourceCoverageCalculationId'),
    optional('sourceCoverageDecisionId', 'uuid'),
    optional('sourceCoverageStateVersion', 'integer'),
  ],
};

const EXACT_COVERAGE_FOREIGN_KEYS = [
  [
    'order_resolution_cases',
    'sourceCoverageCalculationId',
    'warehouse_coverage_calculations',
    'id',
  ],
  ['order_resolution_cases', 'sourceCoverageDecisionId', 'warehouse_coverage_decisions', 'id'],
  ['production_orders', 'sourceCoverageCalculationId', 'warehouse_coverage_calculations', 'id'],
  ['production_orders', 'sourceCoverageDecisionId', 'warehouse_coverage_decisions', 'id'],
  ['warehouse_acceptance_tasks', 'coverageDecisionId', 'warehouse_coverage_decisions', 'id'],
  ['warehouse_coverage_calculations', 'orderId', 'commercial_orders', 'id'],
  ['warehouse_coverage_commands', 'actorId', 'users', 'id'],
  ['warehouse_coverage_commands', 'orderId', 'commercial_orders', 'id'],
  ['warehouse_coverage_commands', 'resultCalculationId', 'warehouse_coverage_calculations', 'id'],
  ['warehouse_coverage_commands', 'resultCaseId', 'order_resolution_cases', 'id'],
  ['warehouse_coverage_commands', 'resultDecisionId', 'warehouse_coverage_decisions', 'id'],
  ['warehouse_coverage_commands', 'scopeCaseId', 'order_resolution_cases', 'id'],
  ['warehouse_coverage_commands', 'scopeTaskId', 'warehouse_acceptance_tasks', 'id'],
  ['warehouse_coverage_decisions', 'actorId', 'users', 'id'],
  ['warehouse_coverage_decisions', 'calculationId', 'warehouse_coverage_calculations', 'id'],
  ['warehouse_coverage_decisions', 'orderId', 'commercial_orders', 'id'],
  ['warehouse_coverage_matches', 'calculationId', 'warehouse_coverage_calculations', 'id'],
  ['warehouse_coverage_matches', 'coverageFactId', 'warehouse_roll_coverage_facts', 'id'],
  ['warehouse_coverage_matches', 'orderId', 'commercial_orders', 'id'],
  ['warehouse_coverage_matches', 'positionId', 'commercial_order_positions', 'id'],
  ['warehouse_coverage_matches', 'rollId', 'warehouse_rolls', 'id'],
  ['warehouse_coverage_recheck_memberships', 'caseId', 'order_resolution_cases', 'id'],
  ['warehouse_coverage_recheck_memberships', 'orderId', 'commercial_orders', 'id'],
  ['warehouse_coverage_recheck_memberships', 'rollId', 'warehouse_rolls', 'id'],
  [
    'warehouse_coverage_recheck_memberships',
    'sourceCalculationId',
    'warehouse_coverage_calculations',
    'id',
  ],
  [
    'warehouse_coverage_recheck_memberships',
    'sourceCoverageFactId',
    'warehouse_roll_coverage_facts',
    'id',
  ],
  [
    'warehouse_coverage_recheck_memberships',
    'sourceDecisionId',
    'warehouse_coverage_decisions',
    'id',
  ],
  ['warehouse_coverage_states', 'currentCalculationId', 'warehouse_coverage_calculations', 'id'],
  ['warehouse_coverage_states', 'currentDecisionId', 'warehouse_coverage_decisions', 'id'],
  ['warehouse_coverage_states', 'orderId', 'commercial_orders', 'id'],
  ['warehouse_roll_coverage_facts', 'actorId', 'users', 'id'],
  ['warehouse_roll_coverage_facts', 'rollId', 'warehouse_rolls', 'id'],
  ['warehouse_roll_coverage_facts', 'sourceDispatchItemId', 'roll_dispatch_items', 'id'],
  ['warehouse_roll_coverage_facts', 'sourceOrderId', 'commercial_orders', 'id'],
  ['warehouse_roll_coverage_facts', 'sourcePositionId', 'commercial_order_positions', 'id'],
  ['warehouse_roll_coverage_facts', 'sourceWeightCaptureId', 'weight_captures', 'id'],
  ['warehouse_rolls', 'currentCoverageFactId', 'warehouse_roll_coverage_facts', 'id'],
  ['warehouse_rolls', 'reservedByCoverageDecisionId', 'warehouse_coverage_decisions', 'id'],
] as const;

function expectedCoverageForeignKeyName(table: string, column: string): string {
  if (table === 'warehouse_acceptance_tasks' && column === 'coverageDecisionId') {
    return 'warehouse_acceptance_tasks_coverage_decision_id_fkey';
  }
  if (table === 'warehouse_rolls' && column === 'reservedByCoverageDecisionId') {
    return 'warehouse_rolls_reserved_by_coverage_decision_id_fkey';
  }
  return `${table}_${column}_fkey`.slice(0, 63);
}

const EXACT_COVERAGE_CHECKS = [
  ['commercial_orders_warehouse_coverage_workflow_ck', 'commercial_orders'],
  ['production_orders_coverage_provenance_ck', 'production_orders'],
  ['warehouse_acceptance_tasks_coverage_provenance_ck', 'warehouse_acceptance_tasks'],
  ['warehouse_coverage_calculations_algorithm_version_ck', 'warehouse_coverage_calculations'],
  ['warehouse_coverage_calculations_availability_ck', 'warehouse_coverage_calculations'],
  ['warehouse_coverage_calculations_counts_ck', 'warehouse_coverage_calculations'],
  ['warehouse_coverage_calculations_fingerprints_ck', 'warehouse_coverage_calculations'],
  ['warehouse_coverage_calculations_generation_ck', 'warehouse_coverage_calculations'],
  ['warehouse_coverage_calculations_order_version_ck', 'warehouse_coverage_calculations'],
  ['warehouse_coverage_calculations_policy_version_ck', 'warehouse_coverage_calculations'],
  ['warehouse_coverage_calculations_system_actor_ck', 'warehouse_coverage_calculations'],
  ['warehouse_coverage_commands_actor_kind_ck', 'warehouse_coverage_commands'],
  ['warehouse_coverage_commands_actor_xor_ck', 'warehouse_coverage_commands'],
  ['warehouse_coverage_commands_kind_ck', 'warehouse_coverage_commands'],
  ['warehouse_coverage_commands_request_fingerprint_ck', 'warehouse_coverage_commands'],
  ['warehouse_coverage_commands_result_ck', 'warehouse_coverage_commands'],
  ['warehouse_coverage_commands_result_generation_ck', 'warehouse_coverage_commands'],
  ['warehouse_coverage_commands_result_kind_ck', 'warehouse_coverage_commands'],
  ['warehouse_coverage_commands_result_state_version_ck', 'warehouse_coverage_commands'],
  ['warehouse_coverage_commands_safe_result_kind_ck', 'warehouse_coverage_commands'],
  ['warehouse_coverage_decisions_actor_kind_ck', 'warehouse_coverage_decisions'],
  ['warehouse_coverage_decisions_actor_xor_ck', 'warehouse_coverage_decisions'],
  ['warehouse_coverage_decisions_epochs_ck', 'warehouse_coverage_decisions'],
  ['warehouse_coverage_decisions_expected_roll_count_ck', 'warehouse_coverage_decisions'],
  ['warehouse_coverage_decisions_generation_ck', 'warehouse_coverage_decisions'],
  ['warehouse_coverage_decisions_input_fingerprint_ck', 'warehouse_coverage_decisions'],
  ['warehouse_coverage_decisions_kind_ck', 'warehouse_coverage_decisions'],
  ['warehouse_coverage_epoch_singleton_ck', 'warehouse_coverage_inventory_epochs'],
  ['warehouse_coverage_epoch_value_ck', 'warehouse_coverage_inventory_epochs'],
  ['warehouse_coverage_facts_actor_kind_ck', 'warehouse_roll_coverage_facts'],
  ['warehouse_coverage_facts_actor_xor_ck', 'warehouse_roll_coverage_facts'],
  ['warehouse_coverage_facts_source_ck', 'warehouse_roll_coverage_facts'],
  ['warehouse_coverage_facts_spec_fingerprint_ck', 'warehouse_roll_coverage_facts'],
  ['warehouse_coverage_facts_spec_version_ck', 'warehouse_roll_coverage_facts'],
  ['warehouse_coverage_facts_version_ck', 'warehouse_roll_coverage_facts'],
  ['warehouse_coverage_matches_generation_ck', 'warehouse_coverage_matches'],
  ['warehouse_coverage_matches_slot_index_ck', 'warehouse_coverage_matches'],
  ['warehouse_coverage_memberships_source_kind_ck', 'warehouse_coverage_recheck_memberships'],
  ['warehouse_coverage_states_generation_ck', 'warehouse_coverage_states'],
  ['warehouse_coverage_states_state_ck', 'warehouse_coverage_states'],
  ['warehouse_coverage_states_state_version_ck', 'warehouse_coverage_states'],
  ['warehouse_rolls_coverage_provenance_ck', 'warehouse_rolls'],
] as const;

const EXACT_COVERAGE_CHECK_TOKENS: Record<(typeof EXACT_COVERAGE_CHECKS)[number][0], string[]> = {
  commercial_orders_warehouse_coverage_workflow_ck: ['warehouseCoverageWorkflowVersion', '1', '2'],
  production_orders_coverage_provenance_ck: [
    'sourceCoverageCalculationId',
    'sourceCoverageDecisionId',
    'sourceCoverageInputFingerprint',
    'sourceCoverageGeneration',
  ],
  warehouse_acceptance_tasks_coverage_provenance_ck: [
    'coverageDecisionId',
    'mode',
    'reserve',
    'proposalId',
    'positionId',
  ],
  warehouse_coverage_calculations_algorithm_version_ck: [
    'algorithmVersion',
    'warehouse-coverage-matching/v1',
  ],
  warehouse_coverage_calculations_availability_ck: [
    'availability',
    'verified_full',
    'unavailable',
    'unknown',
  ],
  warehouse_coverage_calculations_counts_ck: [
    'requiredRollCount',
    'matchedRollCount',
    'uncertainRollCount',
  ],
  warehouse_coverage_calculations_fingerprints_ck: [
    'orderFingerprint',
    'inventoryFingerprint',
    'inputFingerprint',
    '[0-9a-f]{64}',
  ],
  warehouse_coverage_calculations_generation_ck: ['generation', '0'],
  warehouse_coverage_calculations_order_version_ck: ['orderVersion', '0'],
  warehouse_coverage_calculations_policy_version_ck: [
    'policyVersion',
    'warehouse-coverage-policy/v1',
  ],
  warehouse_coverage_calculations_system_actor_ck: ['systemActorKey', 'warehouse_coverage_engine'],
  warehouse_coverage_commands_actor_kind_ck: ['actorKind', 'user', 'system'],
  warehouse_coverage_commands_actor_xor_ck: ['actorKind', 'actorRole', 'actorId', 'systemActorKey'],
  warehouse_coverage_commands_kind_ck: [
    'kind',
    'refresh',
    'decide',
    'request_recheck',
    'resolve_recheck',
    'cancel_reservation',
  ],
  warehouse_coverage_commands_request_fingerprint_ck: ['requestFingerprint', '[0-9a-f]{64}'],
  warehouse_coverage_commands_result_ck: [
    'scopeCaseId',
    'scopeTaskId',
    'resultCalculationId',
    'resultDecisionId',
    'resultCaseId',
  ],
  warehouse_coverage_commands_result_generation_ck: ['resultGeneration', '0'],
  warehouse_coverage_commands_result_kind_ck: [
    'resultKind',
    'calculation',
    'decision',
    'recheck_case',
  ],
  warehouse_coverage_commands_result_state_version_ck: ['resultStateVersion', '0'],
  warehouse_coverage_commands_safe_result_kind_ck: [
    'safeResultKind',
    'projection',
    'projection_with_case',
  ],
  warehouse_coverage_decisions_actor_kind_ck: ['actorKind', 'user', 'system'],
  warehouse_coverage_decisions_actor_xor_ck: [
    'actorKind',
    'actorRole',
    'actorId',
    'systemActorKey',
  ],
  warehouse_coverage_decisions_epochs_ck: ['sourceInventoryEpoch', 'committedInventoryEpoch'],
  warehouse_coverage_decisions_expected_roll_count_ck: ['expectedRollCount', '0'],
  warehouse_coverage_decisions_generation_ck: ['generation', '0'],
  warehouse_coverage_decisions_input_fingerprint_ck: ['inputFingerprint', '[0-9a-f]{64}'],
  warehouse_coverage_decisions_kind_ck: [
    'kind',
    'use_warehouse',
    'produce_all',
    'auto_produce_all',
  ],
  warehouse_coverage_epoch_singleton_ck: ['id', '1'],
  warehouse_coverage_epoch_value_ck: ['epoch', '0'],
  warehouse_coverage_facts_actor_kind_ck: ['actorKind', 'user', 'system'],
  warehouse_coverage_facts_actor_xor_ck: ['actorKind', 'actorRole', 'actorId', 'systemActorKey'],
  warehouse_coverage_facts_source_ck: [
    'source',
    'production_handover',
    'warehouse_recheck',
    'migration_backfill',
    'manual_platform',
    'order_cancellation',
  ],
  warehouse_coverage_facts_spec_fingerprint_ck: ['specFingerprint', '[0-9a-f]{64}'],
  warehouse_coverage_facts_spec_version_ck: ['specVersion', 'warehouse-roll-coverage/v1'],
  warehouse_coverage_facts_version_ck: ['version', '0'],
  warehouse_coverage_matches_generation_ck: ['generation', '0'],
  warehouse_coverage_matches_slot_index_ck: ['slotIndex', '0'],
  warehouse_coverage_memberships_source_kind_ck: [
    'sourceKind',
    'verified_candidate',
    'uncertain_candidate',
    'decision_match',
  ],
  warehouse_coverage_states_generation_ck: ['generation', '0'],
  warehouse_coverage_states_state_ck: [
    'state',
    'calculating',
    'awaiting_finance',
    'production_required',
    'unknown',
    'recheck_requested',
    'warehouse_reserved',
    'stale',
    'order_spec_changed',
  ],
  warehouse_coverage_states_state_version_ck: ['stateVersion', '0'],
  warehouse_rolls_coverage_provenance_ck: ['reservedByProposalId', 'reservedByCoverageDecisionId'],
};

const EXACT_COVERAGE_INDEXES = [
  {
    table: 'production_orders',
    name: 'production_orders_coverage_order_generation_uq',
    unique: true,
    method: 'btree',
    columns: ['commercialOrderId', 'sourceCoverageGeneration'],
    predicate: null,
  },
  {
    table: 'warehouse_acceptance_tasks',
    name: 'warehouse_acceptance_tasks_coverageDecisionId_key',
    unique: true,
    method: 'btree',
    columns: ['coverageDecisionId'],
    predicate: null,
  },
  {
    table: 'warehouse_coverage_calculations',
    name: 'warehouse_coverage_calculations_order_generation_uq',
    unique: true,
    method: 'btree',
    columns: ['orderId', 'generation'],
    predicate: null,
  },
  {
    table: 'warehouse_coverage_commands',
    name: 'warehouse_coverage_commands_clientRequestId_key',
    unique: true,
    method: 'btree',
    columns: ['clientRequestId'],
    predicate: null,
  },
  {
    table: 'warehouse_coverage_commands',
    name: 'warehouse_coverage_commands_order_created_idx',
    unique: false,
    method: 'btree',
    columns: ['orderId', 'createdAt', 'id'],
    predicate: null,
  },
  {
    table: 'warehouse_coverage_decisions',
    name: 'warehouse_coverage_decisions_order_generation_uq',
    unique: true,
    method: 'btree',
    columns: ['orderId', 'generation'],
    predicate: null,
  },
  {
    table: 'warehouse_coverage_matches',
    name: 'warehouse_coverage_matches_calculation_position_slot_uq',
    unique: true,
    method: 'btree',
    columns: ['calculationId', 'positionId', 'slotIndex'],
    predicate: null,
  },
  {
    table: 'warehouse_coverage_matches',
    name: 'warehouse_coverage_matches_calculation_roll_uq',
    unique: true,
    method: 'btree',
    columns: ['calculationId', 'rollId'],
    predicate: null,
  },
  {
    table: 'warehouse_coverage_recheck_memberships',
    name: 'warehouse_coverage_recheck_memberships_case_roll_uq',
    unique: true,
    method: 'btree',
    columns: ['caseId', 'rollId'],
    predicate: null,
  },
  {
    table: 'warehouse_coverage_states',
    name: 'warehouse_coverage_states_currentCalculationId_key',
    unique: true,
    method: 'btree',
    columns: ['currentCalculationId'],
    predicate: null,
  },
  {
    table: 'warehouse_coverage_states',
    name: 'warehouse_coverage_states_currentDecisionId_key',
    unique: true,
    method: 'btree',
    columns: ['currentDecisionId'],
    predicate: null,
  },
  {
    table: 'warehouse_coverage_states',
    name: 'warehouse_coverage_states_state_order_idx',
    unique: false,
    method: 'btree',
    columns: ['state', 'orderId'],
    predicate: null,
  },
  {
    table: 'warehouse_roll_coverage_facts',
    name: 'warehouse_coverage_facts_roll_version_idx',
    unique: true,
    method: 'btree',
    columns: ['rollId', 'version'],
    predicate: null,
  },
  {
    table: 'warehouse_roll_coverage_facts',
    name: 'warehouse_roll_coverage_facts_sourceDispatchItemId_key',
    unique: true,
    method: 'btree',
    columns: ['sourceDispatchItemId'],
    predicate: null,
  },
  {
    table: 'warehouse_rolls',
    name: 'warehouse_rolls_coverage_candidates_idx',
    unique: false,
    method: 'btree',
    columns: [
      'warehouseStatus',
      'ownerCounterpartyId',
      'reservedForOrderId',
      'currentCoverageFactId',
      'rollCode',
      'id',
    ],
    predicate: null,
  },
  {
    table: 'warehouse_rolls',
    name: 'warehouse_rolls_currentCoverageFactId_key',
    unique: true,
    method: 'btree',
    columns: ['currentCoverageFactId'],
    predicate: null,
  },
] as const;

const EXACT_COVERAGE_PRIMARY_KEYS = [
  { table: 'warehouse_coverage_calculations', columns: ['id'] },
  { table: 'warehouse_coverage_commands', columns: ['id'] },
  { table: 'warehouse_coverage_decisions', columns: ['id'] },
  { table: 'warehouse_coverage_inventory_epochs', columns: ['id'] },
  { table: 'warehouse_coverage_matches', columns: ['id'] },
  { table: 'warehouse_coverage_recheck_memberships', columns: ['id'] },
  { table: 'warehouse_coverage_states', columns: ['orderId'] },
  { table: 'warehouse_roll_coverage_facts', columns: ['id'] },
] as const;

const EXACT_COVERAGE_TRIGGER_NAMES = [
  'commercial_orders_coverage_workflow_immutable',
  'defect_records_coverage_epoch_delete',
  'defect_records_coverage_epoch_insert',
  'defect_records_coverage_epoch_update',
  'order_resolution_cases_coverage_validate_write',
  'production_orders_coverage_validate_write',
  'production_problems_coverage_epoch_delete',
  'production_problems_coverage_epoch_insert',
  'production_problems_coverage_epoch_update',
  'scan_rows_coverage_validate_delete',
  'scan_rows_coverage_validate_insert',
  'scan_rows_coverage_validate_update',
  'warehouse_acceptance_tasks_coverage_validate_delete',
  'warehouse_acceptance_tasks_coverage_validate_insert',
  'warehouse_acceptance_tasks_coverage_validate_update',
  'warehouse_coverage_calculations_append_only',
  'warehouse_coverage_calculations_append_only_truncate',
  'warehouse_coverage_commands_append_only',
  'warehouse_coverage_commands_append_only_truncate',
  'warehouse_coverage_commands_validate_insert',
  'warehouse_coverage_decisions_append_only',
  'warehouse_coverage_decisions_append_only_truncate',
  'warehouse_coverage_decisions_final_set_deferred',
  'warehouse_coverage_decisions_validate_insert',
  'warehouse_coverage_inventory_epochs_protect_delete',
  'warehouse_coverage_inventory_epochs_protect_truncate',
  'warehouse_coverage_matches_append_only',
  'warehouse_coverage_matches_append_only_truncate',
  'warehouse_coverage_matches_validate_insert',
  'warehouse_coverage_recheck_memberships_append_only',
  'warehouse_coverage_recheck_memberships_append_only_truncate',
  'warehouse_coverage_recheck_memberships_validate_insert',
  'warehouse_coverage_order_change_retirement_deferred',
  'warehouse_coverage_states_validate_write',
  'warehouse_roll_coverage_facts_append_only',
  'warehouse_roll_coverage_facts_append_only_truncate',
  'warehouse_roll_coverage_facts_validate_insert',
  'warehouse_roll_coverage_facts_cancellation_validate_insert',
  'warehouse_rolls_coverage_epoch_delete',
  'warehouse_rolls_coverage_epoch_insert',
  'warehouse_rolls_coverage_epoch_update',
  'warehouse_rolls_coverage_validate_reservations_update',
  'warehouse_rolls_coverage_validate_write',
] as const;

type ExpectedCoverageTrigger = {
  configKind: 'current' | 'pg_catalog';
  deferred: boolean;
  events: string[];
  function: string;
  hasCondition: boolean;
  initiallyDeferred: boolean;
  name: string;
  newTransitionTable: string | null;
  oldTransitionTable: string | null;
  orientation: 'ROW' | 'STATEMENT';
  table: string;
  timing: 'AFTER' | 'BEFORE';
  updateColumns: string[];
};

function expectedCoverageTrigger(
  name: (typeof EXACT_COVERAGE_TRIGGER_NAMES)[number],
): ExpectedCoverageTrigger {
  let table: string;
  if (name === 'warehouse_coverage_order_change_retirement_deferred') {
    table = 'warehouse_coverage_states';
  } else if (name.startsWith('commercial_orders_')) table = 'commercial_orders';
  else if (name.startsWith('defect_records_')) table = 'defect_records';
  else if (name.startsWith('order_resolution_cases_')) table = 'order_resolution_cases';
  else if (name.startsWith('production_orders_')) table = 'production_orders';
  else if (name.startsWith('production_problems_')) table = 'production_problems';
  else if (name.startsWith('scan_rows_')) table = 'scan_rows';
  else if (name.startsWith('warehouse_acceptance_tasks_')) {
    table = 'warehouse_acceptance_tasks';
  } else if (name.startsWith('warehouse_coverage_calculations_')) {
    table = 'warehouse_coverage_calculations';
  } else if (name.startsWith('warehouse_coverage_commands_')) {
    table = 'warehouse_coverage_commands';
  } else if (name.startsWith('warehouse_coverage_decisions_')) {
    table = 'warehouse_coverage_decisions';
  } else if (name.startsWith('warehouse_coverage_inventory_epochs_')) {
    table = 'warehouse_coverage_inventory_epochs';
  } else if (name.startsWith('warehouse_coverage_matches_')) {
    table = 'warehouse_coverage_matches';
  } else if (name.startsWith('warehouse_coverage_recheck_memberships_')) {
    table = 'warehouse_coverage_recheck_memberships';
  } else if (name.startsWith('warehouse_coverage_states_')) {
    table = 'warehouse_coverage_states';
  } else if (name.startsWith('warehouse_roll_coverage_facts_')) {
    table = 'warehouse_roll_coverage_facts';
  } else if (name.startsWith('warehouse_rolls_')) {
    table = 'warehouse_rolls';
  } else {
    throw new Error(`Unmapped coverage trigger table: ${name}`);
  }

  const base: ExpectedCoverageTrigger = {
    name,
    table,
    timing: 'BEFORE',
    orientation: 'ROW',
    events: [],
    function: '',
    deferred: false,
    initiallyDeferred: false,
    oldTransitionTable: null,
    newTransitionTable: null,
    hasCondition: false,
    configKind: 'current',
    updateColumns: [],
  };
  if (name.endsWith('_append_only_truncate')) {
    return {
      ...base,
      orientation: 'STATEMENT' as const,
      events: ['TRUNCATE'],
      function: 'warehouse_coverage_reject_append_only',
      configKind: 'pg_catalog' as const,
    };
  }
  if (name.endsWith('_append_only')) {
    return {
      ...base,
      events: ['UPDATE', 'DELETE'],
      function: 'warehouse_coverage_reject_append_only',
      configKind: 'pg_catalog' as const,
    };
  }
  if (name === 'commercial_orders_coverage_workflow_immutable') {
    return {
      ...base,
      events: ['UPDATE'],
      function: 'warehouse_coverage_reject_workflow_mutation',
      configKind: 'pg_catalog' as const,
      updateColumns: ['warehouseCoverageWorkflowVersion'],
    };
  }
  if (name.endsWith('_coverage_epoch_insert')) {
    return {
      ...base,
      orientation: name.startsWith('warehouse_rolls_') ? ('STATEMENT' as const) : ('ROW' as const),
      events: ['INSERT'],
      function: name.startsWith('warehouse_rolls_')
        ? 'warehouse_coverage_bump_epoch_statement'
        : 'warehouse_coverage_bump_epoch_row',
      hasCondition: !name.startsWith('warehouse_rolls_'),
    };
  }
  if (name.endsWith('_coverage_epoch_update')) {
    return {
      ...base,
      orientation: name.startsWith('warehouse_rolls_') ? ('STATEMENT' as const) : ('ROW' as const),
      events: ['UPDATE'],
      function: name.startsWith('warehouse_rolls_')
        ? 'warehouse_coverage_bump_epoch_statement'
        : 'warehouse_coverage_bump_epoch_row',
      hasCondition: !name.startsWith('warehouse_rolls_'),
      updateColumns: name.startsWith('warehouse_rolls_')
        ? [
            'rollCode',
            'warehouseStatus',
            'ownerCounterpartyId',
            'reservedForOrderId',
            'reservedForPositionId',
            'reservedByProposalId',
            'reservedAt',
            'currentCoverageFactId',
            'reservedByCoverageDecisionId',
            'producedForOrderId',
            'producedForPositionId',
            'producedByCoverageDecisionId',
          ]
        : [],
    };
  }
  if (name.endsWith('_coverage_epoch_delete')) {
    return {
      ...base,
      orientation: name.startsWith('warehouse_rolls_') ? ('STATEMENT' as const) : ('ROW' as const),
      events: ['DELETE'],
      function: name.startsWith('warehouse_rolls_')
        ? 'warehouse_coverage_bump_epoch_statement'
        : 'warehouse_coverage_bump_epoch_row',
      hasCondition: !name.startsWith('warehouse_rolls_'),
    };
  }
  if (name === 'warehouse_coverage_inventory_epochs_protect_delete') {
    return {
      ...base,
      events: ['DELETE'],
      function: 'warehouse_coverage_protect_epoch_singleton',
      configKind: 'pg_catalog' as const,
    };
  }
  if (name === 'warehouse_coverage_inventory_epochs_protect_truncate') {
    return {
      ...base,
      orientation: 'STATEMENT' as const,
      events: ['TRUNCATE'],
      function: 'warehouse_coverage_protect_epoch_singleton',
      configKind: 'pg_catalog' as const,
    };
  }
  if (
    name.startsWith('scan_rows_coverage_validate_') ||
    name.startsWith('warehouse_acceptance_tasks_coverage_validate_')
  ) {
    const event = name.endsWith('_insert')
      ? 'INSERT'
      : name.endsWith('_update')
        ? 'UPDATE'
        : 'DELETE';
    return {
      ...base,
      timing: 'AFTER' as const,
      orientation: 'STATEMENT' as const,
      events: [event],
      function: 'warehouse_coverage_validate_final_sets',
      oldTransitionTable: event === 'INSERT' ? null : 'old_rows',
      newTransitionTable: event === 'DELETE' ? null : 'new_rows',
    };
  }
  if (name === 'warehouse_rolls_coverage_validate_reservations_update') {
    return {
      ...base,
      timing: 'AFTER' as const,
      orientation: 'STATEMENT' as const,
      events: ['UPDATE'],
      function: 'warehouse_coverage_validate_final_sets',
      oldTransitionTable: 'old_rows',
      newTransitionTable: 'new_rows',
    };
  }
  if (name === 'warehouse_coverage_decisions_final_set_deferred') {
    return {
      ...base,
      timing: 'AFTER' as const,
      events: ['INSERT'],
      function: 'warehouse_coverage_validate_final_decision',
      deferred: true,
      initiallyDeferred: true,
    };
  }
  if (name === 'warehouse_coverage_order_change_retirement_deferred') {
    return {
      ...base,
      timing: 'AFTER' as const,
      events: ['UPDATE'],
      function: 'warehouse_coverage_validate_order_change_retirement',
      deferred: true,
      initiallyDeferred: true,
      hasCondition: true,
    };
  }
  const validatorFunctions: Record<string, string> = {
    order_resolution_cases_coverage_validate_write: 'warehouse_coverage_validate_case',
    production_orders_coverage_validate_write: 'warehouse_coverage_validate_production_order',
    warehouse_coverage_commands_validate_insert: 'warehouse_coverage_validate_command',
    warehouse_coverage_decisions_validate_insert: 'warehouse_coverage_validate_decision',
    warehouse_coverage_matches_validate_insert: 'warehouse_coverage_validate_match',
    warehouse_coverage_recheck_memberships_validate_insert:
      'warehouse_coverage_validate_membership',
    warehouse_coverage_states_validate_write: 'warehouse_coverage_validate_state',
    warehouse_roll_coverage_facts_validate_insert: 'warehouse_coverage_validate_fact',
    warehouse_roll_coverage_facts_cancellation_validate_insert:
      'warehouse_coverage_validate_cancellation_fact',
    warehouse_rolls_coverage_validate_write: 'warehouse_coverage_validate_roll',
  };
  const validatorFunction = validatorFunctions[name];
  if (!validatorFunction) throw new Error(`Unmapped coverage trigger: ${name}`);
  return {
    ...base,
    events: name.endsWith('_validate_write') ? ['INSERT', 'UPDATE'] : ['INSERT'],
    function: validatorFunction,
  };
}

const EXACT_COVERAGE_TRIGGERS = EXACT_COVERAGE_TRIGGER_NAMES.map(expectedCoverageTrigger).sort(
  (left, right) => left.name.localeCompare(right.name),
);

const CANONICAL_SPEC = {
  sourceOrderId: null,
  sourcePositionId: null,
  rollCode: 'COVERAGE-ROLL',
  ownerCounterpartyId: null,
  filmType: 'Рукав',
  actualThicknessMilliMicron: 80_000,
  accountingThicknessMilliMicron: 80_000,
  widthMilliMm: 1_700_000,
  plannedLengthMilliM: 30_000,
  birka: 'Прозрачная',
  spoolType: '76 мм',
  actualWeightMilliKg: 41_200,
  plannedWeightMilliKg: 41_200,
  recipeId: null,
  recipeVersion: null,
  recipeDefinitionId: null,
  recipeDefinitionVersionId: null,
  recipeVersionNumber: null,
  ingredients: [{ rawMaterialDefinitionId: 'coverage-material', shareBasisPoints: 10_000 }],
  policyVersion: 'warehouse-coverage-policy/v2',
} as const;

function databaseUrlForSchema(schema: string): string {
  if (!process.env.DATABASE_URL) throw new Error('E2E DATABASE_URL is not configured');
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function migrationDirectories(): string[] {
  return readdirSync(SOURCE_MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function copyPredecessorProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'plenka-coverage-v2-engine-'));
  const migrations = join(project, 'migrations');
  mkdirSync(migrations);
  cpSync(resolve(PRISMA_ROOT, 'schema.prisma'), join(project, 'schema.prisma'));
  cpSync(
    resolve(SOURCE_MIGRATIONS, 'migration_lock.toml'),
    join(migrations, 'migration_lock.toml'),
  );
  for (const name of migrationDirectories().filter((migration) => migration < TARGET_MIGRATION)) {
    cpSync(resolve(SOURCE_MIGRATIONS, name), join(migrations, name), { recursive: true });
  }
  return project;
}

function addTargetMigration(project: string): void {
  cpSync(TARGET_MIGRATION_PATH, join(project, 'migrations', TARGET_MIGRATION), {
    recursive: true,
  });
}

function deploy(project: string, databaseUrl: string, label: string): void {
  assertCommandSucceeded(
    label,
    spawnSync(
      process.execPath,
      [
        require.resolve('prisma/build/index.js'),
        'migrate',
        'deploy',
        '--schema',
        join(project, 'schema.prisma'),
      ],
      {
        cwd: API_ROOT,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: 'pipe',
      },
    ),
  );
}

async function dropSchema(schema: string, databaseUrl: string): Promise<void> {
  assertSchemaDestructionTarget(schema, databaseUrl);
  const admin = new PrismaClient();
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await admin.$disconnect();
  }
}

function isolatedCleanup(
  prisma: PrismaClient,
  schema: string,
  databaseUrl: string,
  project: string,
): E2eCleanupAction[] {
  return [
    { label: 'warehouse coverage engine client', run: () => prisma.$disconnect() },
    {
      label: 'warehouse coverage engine schema',
      run: () => dropSchema(schema, databaseUrl),
    },
    {
      label: 'warehouse coverage engine project',
      run: () => rmSync(project, { recursive: true, force: true }),
    },
  ];
}

async function coverageColumnMatrix(
  prisma: PrismaClient,
): Promise<Array<{ columns: string[]; table: string }>> {
  return prisma.$queryRaw<Array<{ columns: string[]; table: string }>>`
    SELECT
      table_row.table_name AS table,
      array_agg(table_row.column_name::text ORDER BY table_row.ordinal_position) AS columns
    FROM information_schema.columns AS table_row
    WHERE table_row.table_schema = current_schema()
      AND (
        table_row.table_name LIKE 'warehouse_coverage_%'
        OR table_row.table_name = 'warehouse_roll_coverage_facts'
      )
    GROUP BY table_row.table_name
    ORDER BY table_row.table_name
  `;
}

async function exactColumnDetails(
  prisma: PrismaClient,
  tables: readonly string[],
): Promise<Record<string, ExpectedColumn[]>> {
  const rows = await prisma.$queryRaw<
    Array<{
      default: string | null;
      name: string;
      nullable: boolean;
      table: string;
      type: string;
    }>
  >`
    SELECT
      attribute_row.attrelid::regclass::text AS table,
      attribute_row.attname AS name,
      format_type(attribute_row.atttypid, attribute_row.atttypmod) AS type,
      NOT attribute_row.attnotnull AS nullable,
      pg_get_expr(default_row.adbin, default_row.adrelid) AS default
    FROM pg_attribute AS attribute_row
    LEFT JOIN pg_attrdef AS default_row
      ON default_row.adrelid = attribute_row.attrelid
     AND default_row.adnum = attribute_row.attnum
    WHERE attribute_row.attrelid = ANY (
      ARRAY(
        SELECT format('%I.%I', current_schema(), table_name)::regclass
        FROM unnest(${tables}::text[]) AS table_name
      )
    )
      AND attribute_row.attnum > 0
      AND NOT attribute_row.attisdropped
    ORDER BY attribute_row.attrelid::regclass::text, attribute_row.attnum
  `;
  return rows.reduce<Record<string, ExpectedColumn[]>>((result, row) => {
    (result[row.table] ??= []).push({
      name: row.name,
      type: row.type,
      nullable: row.nullable,
      default: row.default,
    });
    return result;
  }, {});
}

async function exactCoverageChecks(
  prisma: PrismaClient,
): Promise<Array<{ definition: string; name: string; table: string }>> {
  return prisma.$queryRaw`
    SELECT
      constraint_row.conname AS name,
      table_row.relname AS table,
      regexp_replace(
        pg_get_constraintdef(constraint_row.oid, true),
        '[[:space:]]+',
        ' ',
        'g'
      ) AS definition
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS table_row ON table_row.oid = constraint_row.conrelid
    JOIN pg_namespace AS namespace_row ON namespace_row.oid = table_row.relnamespace
    WHERE namespace_row.nspname = current_schema()
      AND constraint_row.contype = 'c'
      AND (
        table_row.relname LIKE 'warehouse_coverage_%'
        OR table_row.relname = 'warehouse_roll_coverage_facts'
        OR constraint_row.conname LIKE '%coverage%'
      )
    ORDER BY constraint_row.conname
  `;
}

async function exactCoverageIndexes(prisma: PrismaClient): Promise<
  Array<{
    columns: string[];
    method: string;
    name: string;
    predicate: string | null;
    table: string;
    unique: boolean;
  }>
> {
  return prisma.$queryRaw`
    SELECT
      table_row.relname AS table,
      index_row.relname AS name,
      index_meta.indisunique AS unique,
      access_method.amname AS method,
      array_agg(attribute_row.attname ORDER BY key_row.ordinality) AS columns,
      pg_get_expr(index_meta.indpred, index_meta.indrelid) AS predicate
    FROM pg_index AS index_meta
    JOIN pg_class AS index_row ON index_row.oid = index_meta.indexrelid
    JOIN pg_class AS table_row ON table_row.oid = index_meta.indrelid
    JOIN pg_namespace AS namespace_row ON namespace_row.oid = table_row.relnamespace
    JOIN pg_am AS access_method ON access_method.oid = index_row.relam
    CROSS JOIN LATERAL unnest(index_meta.indkey)
      WITH ORDINALITY AS key_row(attribute_number, ordinality)
    JOIN pg_attribute AS attribute_row
      ON attribute_row.attrelid = table_row.oid
     AND attribute_row.attnum = key_row.attribute_number
    WHERE namespace_row.nspname = current_schema()
      AND NOT index_meta.indisprimary
      AND key_row.ordinality <= index_meta.indnkeyatts
      AND (
        table_row.relname LIKE 'warehouse_coverage_%'
        OR table_row.relname = 'warehouse_roll_coverage_facts'
        OR index_row.relname IN (
          'warehouse_rolls_coverage_candidates_idx',
          'warehouse_rolls_currentCoverageFactId_key',
          'warehouse_acceptance_tasks_coverageDecisionId_key',
          'production_orders_coverage_order_generation_uq'
        )
      )
    GROUP BY
      table_row.relname,
      index_row.relname,
      index_meta.indisunique,
      access_method.amname,
      index_meta.indpred,
      index_meta.indrelid
    ORDER BY index_row.relname
  `;
}

async function exactCoveragePrimaryKeys(
  prisma: PrismaClient,
): Promise<Array<{ columns: string[]; table: string }>> {
  return prisma.$queryRaw`
    SELECT
      table_row.relname AS table,
      array_agg(attribute_row.attname ORDER BY key_row.ordinality) AS columns
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS table_row ON table_row.oid = constraint_row.conrelid
    JOIN pg_namespace AS namespace_row ON namespace_row.oid = table_row.relnamespace
    CROSS JOIN LATERAL unnest(constraint_row.conkey)
      WITH ORDINALITY AS key_row(attribute_number, ordinality)
    JOIN pg_attribute AS attribute_row
      ON attribute_row.attrelid = table_row.oid
     AND attribute_row.attnum = key_row.attribute_number
    WHERE namespace_row.nspname = current_schema()
      AND constraint_row.contype = 'p'
      AND (
        table_row.relname LIKE 'warehouse_coverage_%'
        OR table_row.relname = 'warehouse_roll_coverage_facts'
      )
    GROUP BY table_row.relname
    ORDER BY table_row.relname
  `;
}

async function exactCoverageForeignKeys(prisma: PrismaClient): Promise<
  Array<{
    column: string;
    deferred: boolean;
    deleteAction: string;
    initiallyDeferred: boolean;
    name: string;
    referencedColumn: string;
    referencedTable: string;
    table: string;
  }>
> {
  return prisma.$queryRaw`
    SELECT
      constraint_row.conname AS name,
      source_table.relname AS table,
      source_attribute.attname AS column,
      target_table.relname AS "referencedTable",
      target_attribute.attname AS "referencedColumn",
      CASE constraint_row.confdeltype WHEN 'r' THEN 'RESTRICT' ELSE constraint_row.confdeltype::text END
        AS "deleteAction",
      constraint_row.condeferrable AS deferred,
      constraint_row.condeferred AS "initiallyDeferred"
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS source_table ON source_table.oid = constraint_row.conrelid
    JOIN pg_namespace AS namespace_row ON namespace_row.oid = source_table.relnamespace
    JOIN pg_class AS target_table ON target_table.oid = constraint_row.confrelid
    JOIN LATERAL unnest(constraint_row.conkey, constraint_row.confkey)
      WITH ORDINALITY AS key_row(source_number, target_number, ordinality) ON true
    JOIN pg_attribute AS source_attribute
      ON source_attribute.attrelid = source_table.oid
     AND source_attribute.attnum = key_row.source_number
    JOIN pg_attribute AS target_attribute
      ON target_attribute.attrelid = target_table.oid
     AND target_attribute.attnum = key_row.target_number
    WHERE namespace_row.nspname = current_schema()
      AND constraint_row.contype = 'f'
      AND (
        source_table.relname IN (
          'warehouse_roll_coverage_facts',
          'warehouse_coverage_states',
          'warehouse_coverage_calculations',
          'warehouse_coverage_matches',
          'warehouse_coverage_decisions',
          'warehouse_coverage_commands',
          'warehouse_coverage_recheck_memberships'
        )
        OR (
          source_table.relname = 'warehouse_rolls'
          AND source_attribute.attname IN (
            'currentCoverageFactId',
            'reservedByCoverageDecisionId'
          )
        )
        OR (
          source_table.relname = 'warehouse_acceptance_tasks'
          AND source_attribute.attname = 'coverageDecisionId'
        )
        OR (
          source_table.relname = 'production_orders'
          AND source_attribute.attname IN (
            'sourceCoverageCalculationId',
            'sourceCoverageDecisionId'
          )
        )
        OR (
          source_table.relname = 'order_resolution_cases'
          AND source_attribute.attname IN (
            'sourceCoverageCalculationId',
            'sourceCoverageDecisionId'
          )
        )
      )
    ORDER BY source_table.relname, source_attribute.attname
  `;
}

async function coverageTriggers(prisma: PrismaClient): Promise<
  Array<{
    configKind: string;
    deferred: boolean;
    events: string[];
    function: string;
    functionConfiguration: string[] | null;
    hasCondition: boolean;
    initiallyDeferred: boolean;
    name: string;
    newTransitionTable: string | null;
    oldTransitionTable: string | null;
    orientation: string;
    table: string;
    timing: string;
    updateColumns: string[];
  }>
> {
  return prisma.$queryRaw`
    SELECT
      trigger_row.tgname AS name,
      table_row.relname AS table,
      CASE
        WHEN (trigger_row.tgtype & 2) <> 0 THEN 'BEFORE'
        ELSE 'AFTER'
      END AS timing,
      CASE
        WHEN (trigger_row.tgtype & 1) <> 0 THEN 'ROW'
        ELSE 'STATEMENT'
      END AS orientation,
      array_remove(ARRAY[
        CASE WHEN (trigger_row.tgtype & 4) <> 0 THEN 'INSERT' END,
        CASE WHEN (trigger_row.tgtype & 16) <> 0 THEN 'UPDATE' END,
        CASE WHEN (trigger_row.tgtype & 8) <> 0 THEN 'DELETE' END,
        CASE WHEN (trigger_row.tgtype & 32) <> 0 THEN 'TRUNCATE' END
      ], NULL) AS events,
      function_row.proname AS function,
      trigger_row.tgdeferrable AS deferred,
      trigger_row.tginitdeferred AS "initiallyDeferred",
      trigger_row.tgoldtable AS "oldTransitionTable",
      trigger_row.tgnewtable AS "newTransitionTable",
      COALESCE(
        ARRAY(
          SELECT attribute_row.attname
          FROM unnest(trigger_row.tgattr::smallint[])
            WITH ORDINALITY AS trigger_attribute(attribute_number, ordinality)
          JOIN pg_attribute AS attribute_row
            ON attribute_row.attrelid = trigger_row.tgrelid
           AND attribute_row.attnum = trigger_attribute.attribute_number
          ORDER BY trigger_attribute.ordinality
        ),
        ARRAY[]::text[]
      ) AS "updateColumns",
      trigger_row.tgqual IS NOT NULL AS "hasCondition",
      CASE
        WHEN function_row.proconfig = ARRAY['search_path=pg_catalog']::text[]
          THEN 'pg_catalog'
        WHEN cardinality(function_row.proconfig) = 1
          AND function_row.proconfig[1] LIKE 'search_path=%'
          THEN 'current'
        ELSE 'invalid'
      END AS "configKind",
      function_row.proconfig AS "functionConfiguration"
    FROM pg_trigger AS trigger_row
    JOIN pg_class AS table_row ON table_row.oid = trigger_row.tgrelid
    JOIN pg_namespace AS namespace_row ON namespace_row.oid = table_row.relnamespace
    JOIN pg_proc AS function_row ON function_row.oid = trigger_row.tgfoid
    WHERE namespace_row.nspname = current_schema()
      AND NOT trigger_row.tgisinternal
      AND (
        table_row.relname LIKE 'warehouse_coverage_%'
        OR table_row.relname = 'warehouse_roll_coverage_facts'
        OR trigger_row.tgname LIKE '%_coverage_%'
      )
    ORDER BY trigger_row.tgname
  `;
}

async function insertCalculation(
  prisma: PrismaClient,
  input: {
    availability?: string;
    fingerprint?: string;
    generation?: number;
    id: string;
    inventoryEpoch?: bigint;
    matchedRollCount?: number;
    orderId: string;
    positionVersions?: Array<{ positionId: string; version: number }>;
    reasonCodes?: string[];
    requiredRollCount?: number;
    uncertainCandidateRollIds?: string[];
    uncertainRollCount?: number;
    verifiedCandidateRollIds?: string[];
  },
): Promise<unknown> {
  const requiredRollCount = input.requiredRollCount ?? 1;
  const matchedRollCount = input.matchedRollCount ?? 0;
  return prisma.$executeRawUnsafe(
    `INSERT INTO "warehouse_coverage_calculations" (
       "id", "orderId", "generation", "orderVersion", "positionVersions",
       "orderFingerprint", "inventoryEpoch", "inventoryFingerprint", "inputFingerprint",
       "algorithmVersion", "policyVersion", "availability", "reasonCodes",
       "requiredRollCount", "matchedRollCount", "uncertainRollCount",
       "verifiedCandidateRollIds", "uncertainCandidateRollIds", "systemActorKey"
     ) VALUES (
       $1, $2, $3, 1, $4::jsonb, $5, $6, $5, $5,
       'warehouse-coverage-matching/v1', 'warehouse-coverage-policy/v1', $7, $8::jsonb,
       $9, $10, $11, $12::jsonb, $13::jsonb, $14
     )`,
    input.id,
    input.orderId,
    input.generation ?? 1,
    JSON.stringify(input.positionVersions ?? []),
    input.fingerprint ?? HEX_A,
    input.inventoryEpoch ?? 0n,
    input.availability ?? 'unavailable',
    JSON.stringify(input.reasonCodes ?? ['no_compatible_rolls']),
    requiredRollCount,
    matchedRollCount,
    input.uncertainRollCount ?? 0,
    JSON.stringify(input.verifiedCandidateRollIds ?? []),
    JSON.stringify(input.uncertainCandidateRollIds ?? []),
    SYSTEM_ACTOR_KEY,
  );
}

async function createMinimalOrder(
  prisma: PrismaClient,
  suffix: string,
  workflowVersion = 2,
): Promise<{ orderId: string; positionId: string; userId: string }> {
  const counterpartyId = `coverage-counterparty-${suffix}`;
  const orderId = `coverage-order-${suffix}`;
  const positionId = `coverage-position-${suffix}`;
  const userId = `coverage-user-${suffix}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO "counterparties" ("id", "displayName") VALUES ($1, $2)`,
    counterpartyId,
    counterpartyId,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "users" ("id", "login", "displayName", "role")
     VALUES ($1, $2, $3, 'finance'::"Role")`,
    userId,
    `${userId}@test.local`,
    userId,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "commercial_orders" (
       "id", "orderNumber", "creatorRole", "counterpartyId",
       "warehouseCoverageWorkflowVersion", "updatedAt"
     ) VALUES ($1, $2, 'commercial'::"Role", $3, $4, CURRENT_TIMESTAMP)`,
    orderId,
    `COVERAGE-${suffix}`,
    counterpartyId,
    workflowVersion,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "commercial_order_positions" (
       "id", "orderId", "rollCount", "filmType", "actualThickness",
       "accountingThickness", "version", "updatedAt"
     ) VALUES ($1, $2, 1, 'Рукав', '80 мкм', '80 мкм', 1, CURRENT_TIMESTAMP)`,
    positionId,
    orderId,
  );
  return { orderId, positionId, userId };
}

async function insertBackfillFact(
  prisma: Pick<PrismaClient, '$executeRawUnsafe'>,
  input: { factId: string; rollCode: string; rollId: string; version?: number },
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "warehouse_roll_coverage_facts" (
       "id", "rollId", "version", "source", "specVersion", "specFingerprint",
       "spec", "actorKind", "systemActorKey"
     ) VALUES (
       $1, $2, $3, 'migration_backfill', 'warehouse-roll-coverage/v1', $4,
       $5::jsonb, 'system', $6
     )`,
    input.factId,
    input.rollId,
    input.version ?? 1,
    HEX_A,
    JSON.stringify({ ...CANONICAL_SPEC, rollCode: input.rollCode }),
    SYSTEM_ACTOR_KEY,
  );
}

function financeProjection(input: {
  calculatedAt?: string;
  generation?: number;
  matched?: number;
  positionId: string;
  required?: number;
  rollCodes?: string[];
  state?: string;
  stateVersion?: number;
  uncertain?: number;
}): Record<string, unknown> {
  const required = input.required ?? 1;
  const matched = input.matched ?? required;
  const state = input.state ?? 'awaiting_finance';
  const route =
    state === 'production_required'
      ? {
          availability: matched === required ? 'verified_full' : 'unavailable',
          reasonCodes: matched === required ? ['full_cover_available'] : ['no_compatible_rolls'],
          nextOwner: 'system',
          availableActions: ['request_recheck'],
        }
      : state === 'recheck_requested'
        ? {
            availability: 'unknown',
            reasonCodes: ['warehouse_recheck_pending'],
            nextOwner: 'warehouse',
            availableActions: ['resolve_recheck'],
          }
        : state === 'warehouse_reserved'
          ? {
              availability: 'verified_full',
              reasonCodes: ['full_cover_available'],
              nextOwner: 'warehouse',
              availableActions: [],
            }
          : {
              availability: matched === required ? 'verified_full' : 'unavailable',
              reasonCodes:
                matched === required ? ['full_cover_available'] : ['no_compatible_rolls'],
              nextOwner: 'finance',
              availableActions:
                matched === required
                  ? ['use_warehouse', 'produce_all', 'request_recheck']
                  : ['produce_all', 'request_recheck'],
            };
  return {
    workflowVersion: 2,
    state,
    stateVersion: input.stateVersion ?? 1,
    generation: input.generation ?? 1,
    ...route,
    requiredRollCount: required,
    matchedRollCount: matched,
    uncertainRollCount: input.uncertain ?? 0,
    calculatedAt: input.calculatedAt ?? '2026-07-24T12:00:00.000Z',
    stale: false,
    financeRolls: (input.rollCodes ?? []).map((rollCode) => ({
      rollCode,
      positionId: input.positionId,
    })),
  };
}

function aggregateProjection(
  input: Parameters<typeof financeProjection>[0],
): Record<string, unknown> {
  const projection = financeProjection(input);
  delete projection.financeRolls;
  return projection;
}

describe('warehouse coverage V2 engine migration (e2e, real PostgreSQL)', () => {
  jest.setTimeout(180_000);

  it('materializes the exact eight-model column and named index contract', async () => {
    const prisma = new PrismaClient();
    await runE2eWithCleanup(async () => {
      const expectedMatrix = Object.entries(COVERAGE_TABLE_COLUMNS)
        .map(([table, columns]) => ({ table, columns: [...columns] }))
        .sort((left, right) => left.table.localeCompare(right.table));
      expect(await coverageColumnMatrix(prisma)).toEqual(expectedMatrix);
      expect(await exactColumnDetails(prisma, Object.keys(EXACT_COVERAGE_COLUMN_DETAILS))).toEqual(
        EXACT_COVERAGE_COLUMN_DETAILS,
      );

      const existingDetails = await exactColumnDetails(prisma, Object.keys(EXISTING_V2_COLUMNS));
      for (const [table, expectedColumns] of Object.entries(EXISTING_V2_COLUMNS)) {
        const names = new Set(expectedColumns.map(({ name }) => name));
        expect(existingDetails[table]?.filter(({ name }) => names.has(name))).toEqual(
          expectedColumns,
        );
      }

      expect(await exactCoverageIndexes(prisma)).toEqual(
        [...EXACT_COVERAGE_INDEXES].sort((left, right) => left.name.localeCompare(right.name)),
      );
      expect(await exactCoveragePrimaryKeys(prisma)).toEqual(EXACT_COVERAGE_PRIMARY_KEYS);
      const checks = await exactCoverageChecks(prisma);
      expect(checks.map(({ definition: _definition, ...metadata }) => metadata)).toEqual(
        EXACT_COVERAGE_CHECKS.map(([name, table]) => ({ name, table })),
      );
      for (const check of checks) {
        for (const token of EXACT_COVERAGE_CHECK_TOKENS[
          check.name as keyof typeof EXACT_COVERAGE_CHECK_TOKENS
        ]) {
          expect(check.definition).toContain(token);
        }
      }

      const triggers = await coverageTriggers(prisma);
      expect(
        triggers.map(({ functionConfiguration: _functionConfiguration, ...metadata }) => metadata),
      ).toEqual(EXACT_COVERAGE_TRIGGERS);
      for (const trigger of triggers) {
        if (trigger.configKind === 'pg_catalog') {
          expect(trigger.functionConfiguration).toEqual(['search_path=pg_catalog']);
        } else {
          expect(trigger.functionConfiguration).toEqual([expect.stringMatching(/^search_path=/u)]);
          expect(trigger.functionConfiguration?.[0]).not.toBe('search_path=pg_catalog');
        }
      }
    }, [{ label: 'warehouse coverage metadata client', run: () => prisma.$disconnect() }]);
  });

  it('uses only two deferred coverage foreign keys and protects immutable generations', async () => {
    const prisma = new PrismaClient();
    const suffix = createE2eSchemaName().split('_').at(-1) as string;
    await runE2eWithCleanup(async () => {
      const deferred = await prisma.$queryRaw<
        Array<{ deferred: boolean; initiallyDeferred: boolean; name: string }>
      >`
        SELECT
          constraint_row.conname AS name,
          constraint_row.condeferrable AS deferred,
          constraint_row.condeferred AS "initiallyDeferred"
        FROM pg_constraint AS constraint_row
        WHERE constraint_row.connamespace = current_schema()::regnamespace
          AND constraint_row.contype = 'f'
          AND constraint_row.condeferrable
        ORDER BY constraint_row.conname
      `;
      expect(deferred).toEqual([
        {
          name: 'warehouse_acceptance_tasks_coverage_decision_id_fkey',
          deferred: true,
          initiallyDeferred: true,
        },
        {
          name: 'warehouse_rolls_reserved_by_coverage_decision_id_fkey',
          deferred: true,
          initiallyDeferred: true,
        },
      ]);
      const coverageForeignKeys = await exactCoverageForeignKeys(prisma);
      expect(
        coverageForeignKeys.map(
          ({
            column,
            deleteAction,
            deferred: isDeferred,
            initiallyDeferred,
            name,
            referencedColumn,
            referencedTable,
            table,
          }) => ({
            name,
            table,
            column,
            referencedTable,
            referencedColumn,
            deleteAction,
            deferred: isDeferred,
            initiallyDeferred,
          }),
        ),
      ).toEqual(
        EXACT_COVERAGE_FOREIGN_KEYS.map(([table, column, referencedTable, referencedColumn]) => ({
          name: expectedCoverageForeignKeyName(table, column),
          table,
          column,
          referencedTable,
          referencedColumn,
          deleteAction: 'RESTRICT',
          deferred:
            (table === 'warehouse_rolls' && column === 'reservedByCoverageDecisionId') ||
            (table === 'warehouse_acceptance_tasks' && column === 'coverageDecisionId'),
          initiallyDeferred:
            (table === 'warehouse_rolls' && column === 'reservedByCoverageDecisionId') ||
            (table === 'warehouse_acceptance_tasks' && column === 'coverageDecisionId'),
        })),
      );

      const { orderId, positionId } = await createMinimalOrder(prisma, suffix);
      const calculationId = `coverage-calculation-${suffix}`;
      await expect(
        insertCalculation(prisma, {
          id: calculationId,
          orderId,
          positionVersions: [{ positionId, version: 1 }],
        }),
      ).resolves.toBeDefined();
      await expect(
        insertCalculation(prisma, {
          id: `${calculationId}-duplicate`,
          orderId,
          positionVersions: [{ positionId, version: 1 }],
        }),
      ).rejects.toThrow(/order_generation|already exists/u);
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "warehouse_coverage_calculations"
           SET "algorithmVersion" = 'mutated'
           WHERE "id" = $1`,
          calculationId,
        ),
      ).rejects.toThrow(/append.only/u);
      await expect(
        prisma.$executeRawUnsafe(
          `DELETE FROM "warehouse_coverage_calculations" WHERE "id" = $1`,
          calculationId,
        ),
      ).rejects.toThrow(/append.only/u);
    }, [{ label: 'warehouse coverage immutability client', run: () => prisma.$disconnect() }]);
  });

  it('increments the singleton inventory epoch exactly once per relevant roll statement', async () => {
    const prisma = new PrismaClient();
    const lockA = new PrismaClient();
    const lockB = new PrismaClient();
    const lockC = new PrismaClient();
    const suffix = createE2eSchemaName().split('_').at(-1) as string;
    await runE2eWithCleanup(async () => {
      const readEpoch = async (): Promise<bigint> => {
        const [row] = await prisma.$queryRaw<Array<{ epoch: bigint }>>`
          SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1
        `;
        return row!.epoch;
      };
      const expectEpochDelta = async (beforeEpoch: bigint, expected: bigint): Promise<bigint> => {
        const afterEpoch = await readEpoch();
        expect(afterEpoch - beforeEpoch).toBe(expected);
        return afterEpoch;
      };
      const before = await prisma.$queryRaw<Array<{ epoch: bigint; id: number }>>`
        SELECT id, epoch FROM "warehouse_coverage_inventory_epochs"
      `;
      expect(before).toEqual([{ id: 1, epoch: expect.any(BigInt) }]);
      const assertSingleton = async (): Promise<void> => {
        await expect(
          prisma.$queryRaw<Array<{ epoch: bigint; id: number }>>`
            SELECT id, epoch
            FROM "warehouse_coverage_inventory_epochs"
            ORDER BY id
          `,
        ).resolves.toEqual([{ id: 1, epoch: expect.any(BigInt) }]);
      };
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_inventory_epochs" ("id", "epoch", "updatedAt")
           VALUES (2, 0, CURRENT_TIMESTAMP)`,
        ),
      ).rejects.toThrow(/epoch|singleton|check/u);
      await assertSingleton();
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "warehouse_coverage_inventory_epochs" SET "id" = 2 WHERE "id" = 1`,
        ),
      ).rejects.toThrow(/epoch|singleton|check/u);
      await assertSingleton();
      await expect(
        prisma.$executeRawUnsafe(
          `DELETE FROM "warehouse_coverage_inventory_epochs" WHERE "id" = 1`,
        ),
      ).rejects.toThrow(/epoch|singleton|delete/u);
      await assertSingleton();
      await expect(
        prisma.$executeRawUnsafe(`TRUNCATE TABLE "warehouse_coverage_inventory_epochs"`),
      ).rejects.toThrow(/epoch|singleton|truncate/u);
      await assertSingleton();

      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_rolls" ("id", "rollCode", "warehouseStatus", "updatedAt")
         VALUES
           ($1, $2, 'received', CURRENT_TIMESTAMP),
           ($3, $4, 'received', CURRENT_TIMESTAMP)`,
        `coverage-roll-a-${suffix}`,
        `COVERAGE-A-${suffix}`,
        `coverage-roll-b-${suffix}`,
        `COVERAGE-B-${suffix}`,
      );
      const afterInsert = await prisma.$queryRaw<Array<{ epoch: bigint }>>`
        SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1
      `;
      expect(afterInsert[0]?.epoch - before[0]!.epoch).toBe(1n);

      let epoch = afterInsert[0]!.epoch;
      const conservativeRelevantUpdates = [
        '"rollCode" = "rollCode"',
        '"warehouseStatus" = "warehouseStatus"',
        '"ownerCounterpartyId" = "ownerCounterpartyId"',
        '"reservedForOrderId" = "reservedForOrderId"',
        '"reservedForPositionId" = "reservedForPositionId"',
        '"reservedByProposalId" = "reservedByProposalId"',
        '"reservedAt" = "reservedAt"',
        '"currentCoverageFactId" = "currentCoverageFactId"',
        '"reservedByCoverageDecisionId" = "reservedByCoverageDecisionId"',
      ];
      for (const assignment of conservativeRelevantUpdates) {
        await prisma.$executeRawUnsafe(
          `UPDATE "warehouse_rolls"
           SET ${assignment}
           WHERE "id" IN ($1, $2)`,
          `coverage-roll-a-${suffix}`,
          `coverage-roll-b-${suffix}`,
        );
        epoch = await expectEpochDelta(epoch, 1n);
      }

      await prisma.$executeRawUnsafe(
        `UPDATE "warehouse_rolls" SET "updatedAt" = "updatedAt" WHERE "id" = $1`,
        `coverage-roll-a-${suffix}`,
      );
      epoch = await expectEpochDelta(epoch, 0n);

      const rollProblemId = `coverage-problem-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "production_problems" (
           "id", "rollId", "actorRole", "reason", "status", "type"
         ) VALUES ($1, $2, 'warehouse'::"Role", 'blocking', 'open', 'general')`,
        rollProblemId,
        `coverage-roll-a-${suffix}`,
      );
      epoch = await expectEpochDelta(epoch, 1n);
      await prisma.$executeRawUnsafe(
        `UPDATE "production_problems" SET "reason" = 'same blocker' WHERE "id" = $1`,
        rollProblemId,
      );
      epoch = await expectEpochDelta(epoch, 0n);
      await prisma.$executeRawUnsafe(
        `UPDATE "production_problems" SET "status" = 'resolved' WHERE "id" = $1`,
        rollProblemId,
      );
      epoch = await expectEpochDelta(epoch, 1n);

      await prisma.$executeRawUnsafe(
        `INSERT INTO "production_problems" (
           "id", "actorRole", "reason", "status", "type"
         ) VALUES ($1, 'warehouse'::"Role", 'not roll scoped', 'open', 'general')`,
        `coverage-non-roll-problem-${suffix}`,
      );
      epoch = await expectEpochDelta(epoch, 0n);

      const { orderId } = await createMinimalOrder(prisma, `${suffix}-defect`, 1);
      const productionOrderId = `coverage-defect-production-${suffix}`;
      const dispatchId = `coverage-defect-dispatch-${suffix}`;
      const lineId = `coverage-defect-line-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "production_orders" ("id", "commercialOrderId", "updatedAt")
         VALUES ($1, $2, CURRENT_TIMESTAMP)`,
        productionOrderId,
        orderId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "roll_dispatch_items" (
           "id", "rollCode", "productionOrderId", "positionSequence", "updatedAt"
         ) VALUES ($1, $2, $3, 1, CURRENT_TIMESTAMP)`,
        dispatchId,
        `COVERAGE-A-${suffix}`,
        productionOrderId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "operator_roll_lines" ("id", "rollDispatchItemId", "updatedAt")
         VALUES ($1, $2, CURRENT_TIMESTAMP)`,
        lineId,
        dispatchId,
      );
      const defectId = `coverage-defect-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "defect_records" (
           "id", "operatorRollLineId", "sourceRole", "comment", "blocking"
         ) VALUES ($1, $2, 'operator'::"Role", 'blocking defect', true)`,
        defectId,
        lineId,
      );
      epoch = await expectEpochDelta(epoch, 1n);
      await prisma.$executeRawUnsafe(
        `UPDATE "defect_records" SET "blocking" = false WHERE "id" = $1`,
        defectId,
      );
      epoch = await expectEpochDelta(epoch, 1n);

      let signalBStarted: (() => void) | undefined;
      const bStarted = new Promise<void>((resolveStarted) => {
        signalBStarted = resolveStarted;
      });
      let bBackendPid: number | null = null;
      let bUpdate: Promise<unknown> | undefined;
      await lockA.$transaction(
        async (transactionA) => {
          await transactionA.$executeRawUnsafe(`SET LOCAL statement_timeout = '10s'`);
          await transactionA.$queryRaw`
            SELECT epoch
            FROM "warehouse_coverage_inventory_epochs"
            WHERE id = 1
            FOR UPDATE
          `;
          bUpdate = lockB.$transaction(
            async (transactionB) => {
              await transactionB.$executeRawUnsafe(`SET LOCAL lock_timeout = '8s'`);
              await transactionB.$executeRawUnsafe(`SET LOCAL statement_timeout = '10s'`);
              const [backend] = await transactionB.$queryRaw<Array<{ pid: number }>>`
                SELECT pg_backend_pid() AS pid
              `;
              bBackendPid = backend!.pid;
              signalBStarted?.();
              return transactionB.$executeRawUnsafe(
                `UPDATE "warehouse_rolls"
                 SET "warehouseStatus" = "warehouseStatus"
                 WHERE "id" = $1`,
                `coverage-roll-a-${suffix}`,
              );
            },
            { maxWait: 5_000, timeout: 15_000 },
          );
          await bStarted;
          let observedEpochLockWait = false;
          for (let attempt = 0; attempt < 40; attempt += 1) {
            const [activity] = await lockC.$queryRawUnsafe<Array<{ waiting: boolean }>>(
              `SELECT EXISTS (
                 SELECT 1
                 FROM pg_stat_activity
                 WHERE pid = $1
                   AND wait_event_type = 'Lock'
               ) AS waiting`,
              bBackendPid,
            );
            if (activity?.waiting) {
              observedEpochLockWait = true;
              break;
            }
            await lockC.$queryRaw`SELECT 1 AS "ready" FROM pg_sleep(0.05)`;
          }
          expect(observedEpochLockWait).toBe(true);
          await expect(
            lockC.$transaction(
              async (transactionC) => {
                await transactionC.$executeRawUnsafe(`SET LOCAL lock_timeout = '500ms'`);
                return transactionC.$queryRawUnsafe(
                  `SELECT id
                   FROM "warehouse_rolls"
                   WHERE "id" = $1
                   FOR UPDATE NOWAIT`,
                  `coverage-roll-a-${suffix}`,
                );
              },
              { maxWait: 5_000, timeout: 5_000 },
            ),
          ).resolves.toBeDefined();
        },
        { maxWait: 5_000, timeout: 15_000 },
      );
      await expect(bUpdate).resolves.toBeDefined();
      epoch = await expectEpochDelta(epoch, 1n);

      await prisma.$executeRawUnsafe(
        `DELETE FROM "warehouse_rolls" WHERE "id" IN ($1, $2)`,
        `coverage-roll-a-${suffix}`,
        `coverage-roll-b-${suffix}`,
      );
      await expectEpochDelta(epoch, 1n);
    }, [
      { label: 'warehouse coverage epoch client', run: () => prisma.$disconnect() },
      { label: 'warehouse coverage epoch lock A', run: () => lockA.$disconnect() },
      { label: 'warehouse coverage epoch lock B', run: () => lockB.$disconnect() },
      { label: 'warehouse coverage epoch lock C', run: () => lockC.$disconnect() },
    ]);
  });

  it('keeps every immutable engine fact append-only, including TRUNCATE', async () => {
    const prisma = new PrismaClient();
    const suffix = createE2eSchemaName().split('_').at(-1) as string;
    await runE2eWithCleanup(async () => {
      const { orderId, positionId, userId } = await createMinimalOrder(prisma, suffix);
      const rollId = `coverage-immutable-roll-${suffix}`;
      const rollCode = `COVERAGE-IMMUTABLE-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_rolls" ("id", "rollCode", "warehouseStatus", "updatedAt")
         VALUES ($1, $2, 'received', CURRENT_TIMESTAMP)`,
        rollId,
        rollCode,
      );
      const factId = `coverage-immutable-fact-${suffix}`;
      await insertBackfillFact(prisma, { factId, rollCode, rollId });
      await prisma.$executeRawUnsafe(
        `UPDATE "warehouse_rolls" SET "currentCoverageFactId" = $1 WHERE "id" = $2`,
        factId,
        rollId,
      );
      const uncertainRollId = `coverage-immutable-uncertain-roll-${suffix}`;
      const uncertainRollCode = `COVERAGE-IMMUTABLE-UNCERTAIN-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_rolls" ("id", "rollCode", "warehouseStatus", "updatedAt")
         VALUES ($1, $2, 'received', CURRENT_TIMESTAMP)`,
        uncertainRollId,
        uncertainRollCode,
      );
      const uncertainFactId = `coverage-immutable-uncertain-fact-${suffix}`;
      await insertBackfillFact(prisma, {
        factId: uncertainFactId,
        rollCode: uncertainRollCode,
        rollId: uncertainRollId,
      });
      await prisma.$executeRawUnsafe(
        `UPDATE "warehouse_rolls" SET "currentCoverageFactId" = $1 WHERE "id" = $2`,
        uncertainFactId,
        uncertainRollId,
      );
      const [{ epoch }] = await prisma.$queryRaw<Array<{ epoch: bigint }>>`
        SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1
      `;
      const calculationId = `coverage-immutable-calculation-${suffix}`;
      await insertCalculation(prisma, {
        id: calculationId,
        orderId,
        positionVersions: [{ positionId, version: 1 }],
        inventoryEpoch: epoch,
        availability: 'verified_full',
        reasonCodes: ['full_cover_available'],
        requiredRollCount: 1,
        matchedRollCount: 1,
        uncertainCandidateRollIds: [uncertainRollId],
        uncertainRollCount: 1,
        verifiedCandidateRollIds: [rollId],
      });
      const [{ calculatedAt }] = await prisma.$queryRaw<Array<{ calculatedAt: Date }>>`
        SELECT "calculatedAt"
        FROM "warehouse_coverage_calculations"
        WHERE id = ${calculationId}
      `;
      const matchId = `coverage-immutable-match-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_matches" (
           "id", "calculationId", "orderId", "generation", "positionId",
           "rollId", "coverageFactId", "slotIndex"
         ) VALUES ($1, $2, $3, 1, $4, $5, $6, 1)`,
        matchId,
        calculationId,
        orderId,
        positionId,
        rollId,
        factId,
      );
      const decisionId = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_decisions" (
           "id", "orderId", "calculationId", "generation", "kind",
           "inputFingerprint", "sourceInventoryEpoch", "expectedRollCount",
           "actorKind", "actorRole", "actorId"
         ) VALUES (
           $1::uuid, $2, $3, 1, 'produce_all', $4, $5, 0,
           'user', 'finance'::"Role", $6
         )`,
        decisionId,
        orderId,
        calculationId,
        HEX_A,
        epoch,
        userId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_states" (
           "orderId", "state", "stateVersion", "generation", "currentCalculationId",
           "updatedAt"
         ) VALUES ($1, 'awaiting_finance', 1, 1, $2, CURRENT_TIMESTAMP)`,
        orderId,
        calculationId,
      );
      const caseId = `coverage-immutable-case-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "order_resolution_cases" (
           "id", "openScopeKey", "orderId", "type", "status", "ownerRole",
           "reason", "createdByRole", "coverageScope", "coverageOrigin",
           "sourceCoverageCalculationId", "sourceCoverageStateVersion", "updatedAt"
         ) VALUES (
           $1, $2, $3, 'warehouse_coverage_recheck', 'open', 'warehouse'::"Role",
           'Проверить покрытие', 'finance'::"Role", $4, 'finance_request', $5, 1,
           CURRENT_TIMESTAMP
         )`,
        caseId,
        `warehouse_coverage_v2:${orderId}:finance_request`,
        orderId,
        `warehouse_coverage_v2:${orderId}`,
        calculationId,
      );
      const membershipId = `coverage-immutable-membership-${suffix}`;
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_recheck_memberships" (
             "id", "caseId", "orderId", "rollId", "sourceCalculationId",
             "sourceCoverageFactId", "sourceKind", "reasonCodes"
           ) VALUES (
             $1, $2, $3, $4, $5, $6, 'arbitrary_roll',
             '["warehouse_recheck_pending"]'::jsonb
           )`,
          `coverage-immutable-invalid-source-kind-${suffix}`,
          caseId,
          orderId,
          rollId,
          calculationId,
          factId,
        ),
      ).rejects.toThrow(/sourceKind|membership|check/u);
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_recheck_memberships" (
             "id", "caseId", "orderId", "rollId", "sourceCalculationId",
             "sourceDecisionId", "sourceCoverageFactId", "sourceKind", "reasonCodes"
           ) VALUES (
             $1, $2, $3, $4, $5, $6::uuid, $7, 'verified_candidate',
             '["warehouse_recheck_pending"]'::jsonb
           )`,
          `coverage-immutable-finance-decision-membership-${suffix}`,
          caseId,
          orderId,
          rollId,
          calculationId,
          decisionId,
          factId,
        ),
      ).rejects.toThrow(/finance|decision|membership|origin/u);
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_recheck_memberships" (
             "id", "caseId", "orderId", "rollId", "sourceCalculationId",
             "sourceCoverageFactId", "sourceKind", "reasonCodes"
           ) VALUES (
             $1, $2, $3, $4, $5, $6, 'uncertain_candidate',
             '["warehouse_recheck_pending"]'::jsonb
           )`,
          `coverage-immutable-wrong-verified-kind-${suffix}`,
          caseId,
          orderId,
          rollId,
          calculationId,
          factId,
        ),
      ).rejects.toThrow(/candidate|membership|sourceKind/u);
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_recheck_memberships" (
             "id", "caseId", "orderId", "rollId", "sourceCalculationId",
             "sourceCoverageFactId", "sourceKind", "reasonCodes"
           ) VALUES (
             $1, $2, $3, $4, $5, $6, 'verified_candidate',
             '["warehouse_recheck_pending"]'::jsonb
           )`,
          `coverage-immutable-wrong-fact-membership-${suffix}`,
          caseId,
          orderId,
          rollId,
          calculationId,
          uncertainFactId,
        ),
      ).rejects.toThrow(/fact|roll|membership/u);
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_recheck_memberships" (
           "id", "caseId", "orderId", "rollId", "sourceCalculationId",
           "sourceCoverageFactId", "sourceKind", "reasonCodes"
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 'verified_candidate',
           '[]'::jsonb
         )`,
        membershipId,
        caseId,
        orderId,
        rollId,
        calculationId,
        factId,
      );
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_recheck_memberships" (
             "id", "caseId", "orderId", "rollId", "sourceCalculationId",
             "sourceCoverageFactId", "sourceKind", "reasonCodes"
           ) VALUES (
             $1, $2, $3, $4, $5, $6, 'verified_candidate',
             '["warehouse_recheck_pending"]'::jsonb
           )`,
          `coverage-immutable-wrong-uncertain-kind-${suffix}`,
          caseId,
          orderId,
          uncertainRollId,
          calculationId,
          uncertainFactId,
        ),
      ).rejects.toThrow(/candidate|membership|sourceKind/u);
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_recheck_memberships" (
             "id", "caseId", "orderId", "rollId", "sourceCalculationId",
             "sourceCoverageFactId", "sourceKind", "reasonCodes"
           ) VALUES (
             $1, $2, $3, $4, $5, $6, 'uncertain_candidate',
             '["warehouse_recheck_pending"]'::jsonb
           )`,
          `coverage-immutable-uncertain-membership-${suffix}`,
          caseId,
          orderId,
          uncertainRollId,
          calculationId,
          uncertainFactId,
        ),
      ).resolves.toBeDefined();
      const outsideRollId = `coverage-immutable-outside-roll-${suffix}`;
      const outsideRollCode = `COVERAGE-IMMUTABLE-OUTSIDE-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_rolls" ("id", "rollCode", "warehouseStatus", "updatedAt")
         VALUES ($1, $2, 'received', CURRENT_TIMESTAMP)`,
        outsideRollId,
        outsideRollCode,
      );
      const outsideFactId = `coverage-immutable-outside-fact-${suffix}`;
      await insertBackfillFact(prisma, {
        factId: outsideFactId,
        rollCode: outsideRollCode,
        rollId: outsideRollId,
      });
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_recheck_memberships" (
             "id", "caseId", "orderId", "rollId", "sourceCalculationId",
             "sourceCoverageFactId", "sourceKind", "reasonCodes"
           ) VALUES (
             $1, $2, $3, $4, $5, $6, 'verified_candidate',
             '["warehouse_recheck_pending"]'::jsonb
           )`,
          `coverage-immutable-outside-membership-${suffix}`,
          caseId,
          orderId,
          outsideRollId,
          calculationId,
          outsideFactId,
        ),
      ).rejects.toThrow(/candidate|membership/u);
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "order_resolution_cases"
           SET "status" = 'resolved', "version" = 2, "resolvedAt" = CURRENT_TIMESTAMP,
               "updatedAt" = CURRENT_TIMESTAMP
           WHERE "id" = $1`,
          caseId,
        ),
      ).rejects.toThrow(/openScopeKey|case|coverage/u);
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "order_resolution_cases"
           SET "status" = 'resolved', "openScopeKey" = NULL, "version" = 2,
               "outcome" = 'coverage_rechecked', "resolvedAt" = CURRENT_TIMESTAMP,
               "updatedAt" = CURRENT_TIMESTAMP
           WHERE "id" = $1`,
          caseId,
        ),
      ).resolves.toBeDefined();
      await expect(
        prisma.$queryRawUnsafe<
          Array<{
            coverageOrigin: string | null;
            coverageScope: string | null;
            openScopeKey: string | null;
            sourceCoverageCalculationId: string | null;
            sourceCoverageDecisionId: string | null;
            sourceCoverageStateVersion: number | null;
            status: string;
            version: number;
          }>
        >(
          `SELECT "coverageOrigin", "coverageScope", "openScopeKey",
                  "sourceCoverageCalculationId", "sourceCoverageDecisionId",
                  "sourceCoverageStateVersion", "status", "version"
           FROM "order_resolution_cases"
           WHERE "id" = $1`,
          caseId,
        ),
      ).resolves.toEqual([
        {
          coverageOrigin: 'finance_request',
          coverageScope: `warehouse_coverage_v2:${orderId}`,
          openScopeKey: null,
          sourceCoverageCalculationId: calculationId,
          sourceCoverageDecisionId: null,
          sourceCoverageStateVersion: 1,
          status: 'resolved',
          version: 2,
        },
      ]);
      const commandId = `coverage-immutable-command-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_commands" (
           "id", "clientRequestId", "kind", "orderId", "requestFingerprint",
           "actorKind", "actorRole", "actorId", "safeResultKind", "safeResult",
           "resultKind", "resultCalculationId", "resultGeneration", "resultStateVersion"
         ) VALUES (
           $1, $2::uuid, 'refresh', $3, $4, 'user', 'finance'::"Role", $5,
           'projection', $6::jsonb, 'calculation', $7, 1, 1
         )`,
        commandId,
        randomUUID(),
        orderId,
        HEX_A,
        userId,
        JSON.stringify(
          financeProjection({
            calculatedAt: calculatedAt!.toISOString(),
            positionId,
            rollCodes: [rollCode],
            uncertain: 1,
          }),
        ),
        calculationId,
      );

      const immutableRows = [
        ['warehouse_roll_coverage_facts', factId],
        ['warehouse_coverage_calculations', calculationId],
        ['warehouse_coverage_matches', matchId],
        ['warehouse_coverage_decisions', decisionId],
        ['warehouse_coverage_commands', commandId],
        ['warehouse_coverage_recheck_memberships', membershipId],
      ] as const;
      for (const [table, id] of immutableRows) {
        const idCast = table === 'warehouse_coverage_decisions' ? '::uuid' : '';
        await expect(
          prisma.$executeRawUnsafe(
            `UPDATE "${table}" SET "id" = "id" WHERE "id" = $1${idCast}`,
            id,
          ),
        ).rejects.toThrow(/append.only/u);
        await expect(
          prisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "id" = $1${idCast}`, id),
        ).rejects.toThrow(/append.only/u);
        await expect(prisma.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`)).rejects.toThrow(
          /append.only/u,
        );
      }
    }, [{ label: 'warehouse coverage append-only client', run: () => prisma.$disconnect() }]);
  });

  it('enforces exact canonical fact JSON, source contracts and null-safe actor XOR', async () => {
    const prisma = new PrismaClient();
    const suffix = createE2eSchemaName().split('_').at(-1) as string;
    await runE2eWithCleanup(async () => {
      const warehouseUserId = `coverage-fact-user-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "users" ("id", "login", "displayName", "role")
         VALUES ($1, $2, $3, 'warehouse'::"Role")`,
        warehouseUserId,
        `${warehouseUserId}@test.local`,
        warehouseUserId,
      );
      const rollId = `coverage-fact-roll-${suffix}`;
      const rollCode = `COVERAGE-FACT-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_rolls" ("id", "rollCode", "warehouseStatus", "updatedAt")
         VALUES ($1, $2, 'received', CURRENT_TIMESTAMP)`,
        rollId,
        rollCode,
      );
      const insertFact = (input: {
        actorId?: string | null;
        actorKind?: string;
        actorRole?: string | null;
        id: string;
        reason?: string | null;
        source?: string;
        spec?: Record<string, unknown>;
        specFingerprint?: string;
        specVersion?: string;
        systemActorKey?: string | null;
        version: number;
      }): Promise<unknown> =>
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_roll_coverage_facts" (
             "id", "rollId", "version", "source", "specVersion", "specFingerprint",
             "spec", "actorKind", "actorRole", "actorId", "systemActorKey", "reason"
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::"Role", $10, $11, $12
           )`,
          input.id,
          rollId,
          input.version,
          input.source ?? 'migration_backfill',
          input.specVersion ?? 'warehouse-roll-coverage/v1',
          input.specFingerprint ?? HEX_A,
          JSON.stringify(input.spec ?? { ...CANONICAL_SPEC, rollCode }),
          input.actorKind ?? 'system',
          input.actorRole ?? null,
          input.actorId ?? null,
          input.systemActorKey === undefined ? SYSTEM_ACTOR_KEY : input.systemActorKey,
          input.reason ?? null,
        );

      await expect(
        insertFact({ id: `coverage-fact-valid-${suffix}`, version: 1 }),
      ).resolves.toBeDefined();
      await expect(
        insertFact({
          id: `coverage-fact-invalid-source-${suffix}`,
          source: 'manual_guess',
          version: 2,
        }),
      ).rejects.toThrow(/source|check/u);
      await expect(
        insertFact({
          id: `coverage-fact-invalid-fingerprint-${suffix}`,
          specFingerprint: 'A'.repeat(64),
          version: 2,
        }),
      ).rejects.toThrow(/fingerprint|check/u);
      await expect(
        insertFact({
          id: `coverage-fact-invalid-version-number-${suffix}`,
          version: 0,
        }),
      ).rejects.toThrow(/version|check/u);
      await expect(
        insertFact({
          id: `coverage-fact-extra-key-${suffix}`,
          version: 2,
          spec: { ...CANONICAL_SPEC, rollCode, leaked: true },
        }),
      ).rejects.toThrow(/spec|canonical|keys/u);
      const { policyVersion: _removed, ...missingKeySpec } = {
        ...CANONICAL_SPEC,
        rollCode,
      };
      await expect(
        insertFact({
          id: `coverage-fact-missing-key-${suffix}`,
          version: 2,
          spec: missingKeySpec,
        }),
      ).rejects.toThrow(/spec|canonical|keys/u);
      await expect(
        insertFact({
          id: `coverage-fact-null-policy-version-${suffix}`,
          version: 2,
          spec: { ...CANONICAL_SPEC, rollCode, policyVersion: null },
        }),
      ).rejects.toThrow(/policy|spec|scalar/u);
      await expect(
        insertFact({
          id: `coverage-fact-numeric-policy-version-${suffix}`,
          version: 2,
          spec: { ...CANONICAL_SPEC, rollCode, policyVersion: 1 },
        }),
      ).rejects.toThrow(/policy|spec|scalar/u);
      await expect(
        insertFact({
          id: `coverage-fact-wrong-policy-version-${suffix}`,
          version: 2,
          spec: {
            ...CANONICAL_SPEC,
            rollCode,
            policyVersion: 'warehouse-coverage-policy/v1',
          },
        }),
      ).rejects.toThrow(/policy|spec|scalar/u);
      await expect(
        insertFact({
          id: `coverage-fact-empty-ingredients-${suffix}`,
          version: 2,
          spec: { ...CANONICAL_SPEC, rollCode, ingredients: [] },
        }),
      ).rejects.toThrow(/ingredient|spec/u);
      await expect(
        insertFact({
          id: `coverage-fact-missing-ingredient-keys-${suffix}`,
          version: 2,
          spec: { ...CANONICAL_SPEC, rollCode, ingredients: [{}] },
        }),
      ).rejects.toThrow(/ingredient|spec|shape/u);
      await expect(
        insertFact({
          id: `coverage-fact-bad-version-${suffix}`,
          version: 2,
          specVersion: 'warehouse-roll-coverage/v2',
        }),
      ).rejects.toThrow(/specVersion|spec_version/u);
      await expect(
        insertFact({
          id: `coverage-fact-null-system-key-${suffix}`,
          version: 2,
          systemActorKey: null,
        }),
      ).rejects.toThrow(/actor_xor|actor/u);
      await expect(
        insertFact({
          id: `coverage-fact-recheck-${suffix}`,
          version: 2,
          source: 'warehouse_recheck',
          actorKind: 'user',
          actorRole: 'warehouse',
          actorId: warehouseUserId,
          systemActorKey: null,
          reason: 'Проверено повторно',
        }),
      ).resolves.toBeDefined();
      await expect(
        insertFact({
          id: `coverage-fact-short-reason-${suffix}`,
          version: 3,
          source: 'warehouse_recheck',
          actorKind: 'user',
          actorRole: 'warehouse',
          actorId: warehouseUserId,
          systemActorKey: null,
          reason: 'x',
        }),
      ).rejects.toThrow(/reason|source/u);
      await expect(
        insertFact({
          id: `coverage-fact-incomplete-handover-${suffix}`,
          version: 3,
          source: 'production_handover',
          actorKind: 'user',
          actorRole: 'warehouse',
          actorId: warehouseUserId,
          systemActorKey: null,
        }),
      ).rejects.toThrow(/production_handover|source/u);
    }, [{ label: 'warehouse coverage fact client', run: () => prisma.$disconnect() }]);
  });

  it('pins production handover facts to exact dispatch and canonical stable weight evidence', async () => {
    const prisma = new PrismaClient();
    const suffix = createE2eSchemaName().split('_').at(-1) as string;
    await runE2eWithCleanup(async () => {
      const source = await createMinimalOrder(prisma, `${suffix}-handover`, 1);
      const other = await createMinimalOrder(prisma, `${suffix}-handover-other`, 1);
      const operatorId = `coverage-handover-operator-${suffix}`;
      const warehouseId = `coverage-handover-warehouse-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "users" ("id", "login", "displayName", "role")
         VALUES
           ($1, $2, $1, 'operator'::"Role"),
           ($3, $4, $3, 'warehouse'::"Role")`,
        operatorId,
        `${operatorId}@test.local`,
        warehouseId,
        `${warehouseId}@test.local`,
      );
      const rollCode = `COVERAGE-HANDOVER-${suffix}`;
      const rollId = `coverage-handover-roll-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_rolls" ("id", "rollCode", "warehouseStatus", "updatedAt")
         VALUES ($1, $2, 'received', CURRENT_TIMESTAMP)`,
        rollId,
        rollCode,
      );
      const createEvidence = async (input: {
        orderId: string;
        positionId: string;
        stable?: boolean;
        tag: string;
      }): Promise<{ captureId: string; dispatchId: string; lineId: string }> => {
        const productionId = `coverage-handover-production-${input.tag}-${suffix}`;
        const dispatchId = `coverage-handover-dispatch-${input.tag}-${suffix}`;
        const lineId = `coverage-handover-line-${input.tag}-${suffix}`;
        const captureId = `coverage-handover-capture-${input.tag}-${suffix}`;
        await prisma.$executeRawUnsafe(
          `INSERT INTO "production_orders" ("id", "commercialOrderId", "updatedAt")
           VALUES ($1, $2, CURRENT_TIMESTAMP)`,
          productionId,
          input.orderId,
        );
        await prisma.$executeRawUnsafe(
          `INSERT INTO "roll_dispatch_items" (
             "id", "rollCode", "productionOrderId", "orderLineId", "filmType",
             "plannedWeightKg", "characteristicsSnapshot", "updatedAt"
          ) VALUES ($1, $2, $3, $4, 'Рукав', 41.2, $5::jsonb, CURRENT_TIMESTAMP)`,
          dispatchId,
          input.tag === 'main' ? rollCode : `${rollCode}-${input.tag}`,
          productionId,
          input.positionId,
          JSON.stringify({
            filmType: 'Рукав',
            actualThicknessMilliMicron: 80_000,
            accountingThicknessMilliMicron: 80_000,
          }),
        );
        await prisma.$executeRawUnsafe(
          `INSERT INTO "operator_roll_lines" (
             "id", "rollDispatchItemId", "netKg", "step", "updatedAt"
           ) VALUES ($1, $2, 41.2, 'completed', CURRENT_TIMESTAMP)`,
          lineId,
          dispatchId,
        );
        await prisma.$executeRawUnsafe(
          `INSERT INTO "weight_captures" (
             "id", "operatorRollLineId", "kind", "stable", "netKg",
             "actorRole", "actorId"
           ) VALUES ($1, $2, 'roll', $3, 41.2, 'operator'::"Role", $4)`,
          captureId,
          lineId,
          input.stable ?? true,
          operatorId,
        );
        return { captureId, dispatchId, lineId };
      };
      const evidence = await createEvidence({
        orderId: source.orderId,
        positionId: source.positionId,
        tag: 'main',
      });
      const otherEvidence = await createEvidence({
        orderId: other.orderId,
        positionId: other.positionId,
        tag: 'other',
      });
      const unstableCaptureId = `coverage-handover-capture-unstable-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "weight_captures" (
           "id", "operatorRollLineId", "kind", "stable", "netKg", "actorRole", "actorId"
         ) VALUES ($1, $2, 'roll', false, 41.2, 'operator'::"Role", $3)`,
        unstableCaptureId,
        evidence.lineId,
        operatorId,
      );
      const canonicalSpec = {
        ...CANONICAL_SPEC,
        sourceOrderId: source.orderId,
        sourcePositionId: source.positionId,
        rollCode,
        actualWeightMilliKg: 41_200,
      };
      const insertProductionFact = (input: {
        dispatchId?: string;
        id: string;
        sourceOrderId?: string;
        sourcePositionId?: string;
        spec?: Record<string, unknown>;
        version: number;
        weightCaptureId?: string;
      }): Promise<unknown> =>
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_roll_coverage_facts" (
             "id", "rollId", "version", "source", "specVersion", "specFingerprint",
             "spec", "sourceOrderId", "sourcePositionId", "sourceDispatchItemId",
             "sourceWeightCaptureId", "actorKind", "actorRole", "actorId"
           ) VALUES (
             $1, $2, $3, 'production_handover', 'warehouse-roll-coverage/v1', $4,
             $5::jsonb, $6, $7, $8, $9, 'user', 'operator'::"Role", $10
           )`,
          input.id,
          rollId,
          input.version,
          HEX_A,
          JSON.stringify(input.spec ?? canonicalSpec),
          input.sourceOrderId ?? source.orderId,
          input.sourcePositionId ?? source.positionId,
          input.dispatchId ?? evidence.dispatchId,
          input.weightCaptureId ?? evidence.captureId,
          operatorId,
        );
      await expect(
        insertProductionFact({
          id: `coverage-handover-wrong-order-${suffix}`,
          sourceOrderId: other.orderId,
          version: 1,
        }),
      ).rejects.toThrow(/sourceOrder|dispatch|handover/u);
      await expect(
        insertProductionFact({
          id: `coverage-handover-wrong-position-${suffix}`,
          sourcePositionId: other.positionId,
          version: 1,
        }),
      ).rejects.toThrow(/sourcePosition|order|handover/u);
      await expect(
        insertProductionFact({
          dispatchId: otherEvidence.dispatchId,
          id: `coverage-handover-wrong-dispatch-${suffix}`,
          version: 1,
        }),
      ).rejects.toThrow(/dispatch|order|position|handover/u);
      await expect(
        insertProductionFact({
          id: `coverage-handover-wrong-capture-${suffix}`,
          version: 1,
          weightCaptureId: otherEvidence.captureId,
        }),
      ).rejects.toThrow(/weight|capture|dispatch|handover/u);
      await expect(
        insertProductionFact({
          id: `coverage-handover-unstable-${suffix}`,
          version: 1,
          weightCaptureId: unstableCaptureId,
        }),
      ).rejects.toThrow(/stable|weight|capture|handover/u);
      await expect(
        insertProductionFact({
          id: `coverage-handover-spec-order-${suffix}`,
          spec: { ...canonicalSpec, sourceOrderId: other.orderId },
          version: 1,
        }),
      ).rejects.toThrow(/spec|sourceOrder|handover/u);
      await expect(
        insertProductionFact({
          id: `coverage-handover-spec-position-${suffix}`,
          spec: { ...canonicalSpec, sourcePositionId: other.positionId },
          version: 1,
        }),
      ).rejects.toThrow(/spec|sourcePosition|handover/u);
      await expect(
        insertProductionFact({
          id: `coverage-handover-spec-roll-${suffix}`,
          spec: { ...canonicalSpec, rollCode: `${rollCode}-wrong` },
          version: 1,
        }),
      ).rejects.toThrow(/spec|rollCode|handover/u);
      await expect(
        insertProductionFact({
          id: `coverage-handover-spec-weight-${suffix}`,
          spec: { ...canonicalSpec, actualWeightMilliKg: 41_201 },
          version: 1,
        }),
      ).rejects.toThrow(/spec|weight|handover/u);
      await expect(
        insertProductionFact({
          id: `coverage-handover-valid-${suffix}`,
          version: 1,
        }),
      ).resolves.toBeDefined();
      await expect(
        insertProductionFact({
          id: `coverage-handover-duplicate-dispatch-${suffix}`,
          version: 2,
        }),
      ).rejects.toThrow(/sourceDispatchItemId|unique/u);
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_roll_coverage_facts" (
             "id", "rollId", "version", "source", "specVersion", "specFingerprint",
             "spec", "sourceOrderId", "sourcePositionId", "sourceWeightCaptureId",
             "actorKind", "actorRole", "actorId", "reason"
           ) VALUES (
             $1, $2, 2, 'warehouse_recheck', 'warehouse-roll-coverage/v1', $3,
             $4::jsonb, $5, $6, $7, 'user', 'warehouse'::"Role", $8,
             'Повторная проверка'
           )`,
          `coverage-handover-shared-weight-${suffix}`,
          rollId,
          HEX_A,
          JSON.stringify(canonicalSpec),
          source.orderId,
          source.positionId,
          evidence.captureId,
          warehouseId,
        ),
      ).resolves.toBeDefined();
    }, [{ label: 'warehouse coverage handover client', run: () => prisma.$disconnect() }]);
  });

  it('enforces canonical calculation arrays, counts, candidate disjointness and non-full matches', async () => {
    const prisma = new PrismaClient();
    const suffix = createE2eSchemaName().split('_').at(-1) as string;
    await runE2eWithCleanup(async () => {
      const { orderId, positionId } = await createMinimalOrder(prisma, suffix);
      const secondPositionId = `coverage-position-b-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "commercial_order_positions" (
           "id", "orderId", "rollCount", "filmType", "actualThickness",
           "accountingThickness", "version", "updatedAt"
         ) VALUES ($1, $2, 1, 'Рукав', '80 мкм', '80 мкм', 2, CURRENT_TIMESTAMP)`,
        secondPositionId,
        orderId,
      );
      const positions = [
        { positionId, version: 1 },
        { positionId: secondPositionId, version: 2 },
      ].sort((left, right) => Buffer.from(left.positionId).compare(Buffer.from(right.positionId)));
      await expect(
        insertCalculation(prisma, {
          id: `coverage-calculation-invalid-generation-${suffix}`,
          orderId,
          generation: 0,
          positionVersions: positions,
        }),
      ).rejects.toThrow(/generation|check/u);
      await expect(
        insertCalculation(prisma, {
          id: `coverage-calculation-invalid-availability-${suffix}`,
          orderId,
          generation: 2,
          positionVersions: positions,
          availability: 'maybe',
        }),
      ).rejects.toThrow(/availability|check/u);
      await expect(
        insertCalculation(prisma, {
          id: `coverage-calculation-invalid-count-${suffix}`,
          orderId,
          generation: 2,
          positionVersions: positions,
          requiredRollCount: -1,
        }),
      ).rejects.toThrow(/counts|check/u);
      await expect(
        insertCalculation(prisma, {
          id: `coverage-calculation-invalid-fingerprint-${suffix}`,
          orderId,
          generation: 2,
          positionVersions: positions,
          fingerprint: 'A'.repeat(64),
        }),
      ).rejects.toThrow(/fingerprint|check/u);
      await expect(
        insertCalculation(prisma, {
          id: `coverage-canonical-calculation-${suffix}`,
          orderId,
          positionVersions: positions,
          requiredRollCount: 2,
        }),
      ).resolves.toBeDefined();

      const partial = await createMinimalOrder(prisma, `${suffix}-partial-lower-bound`);
      const partialCalculationId = `coverage-calculation-partial-lower-bound-${suffix}`;
      await expect(
        insertCalculation(prisma, {
          id: partialCalculationId,
          orderId: partial.orderId,
          availability: 'unavailable',
          positionVersions: [{ positionId: partial.positionId, version: 1 }],
          reasonCodes: ['only_partial_cover'],
          requiredRollCount: 2,
          matchedRollCount: 1,
          verifiedCandidateRollIds: [`coverage-candidate-${suffix}`],
        }),
      ).resolves.toBeDefined();
      await expect(
        prisma.$queryRawUnsafe<Array<{ count: number }>>(
          `SELECT count(*)::int AS count
           FROM "warehouse_coverage_matches"
           WHERE "calculationId" = $1`,
          partialCalculationId,
        ),
      ).resolves.toEqual([{ count: 0 }]);

      const unknownReasons = await createMinimalOrder(prisma, `${suffix}-unknown-reasons`);
      await expect(
        insertCalculation(prisma, {
          id: `coverage-calculation-unknown-reasons-${suffix}`,
          orderId: unknownReasons.orderId,
          availability: 'unknown',
          positionVersions: [{ positionId: unknownReasons.positionId, version: 1 }],
          reasonCodes: [
            'order_spec_incomplete',
            'roll_facts_incomplete',
            'roll_ownership_unverified',
            'unsupported_policy_version',
          ],
          uncertainRollCount: 1,
        }),
      ).resolves.toBeDefined();

      const invalidCalculations: Array<{
        input: Parameters<typeof insertCalculation>[1];
        label: string;
      }> = [
        {
          label: 'empty reasons',
          input: {
            id: `coverage-calculation-empty-reasons-${suffix}`,
            orderId,
            generation: 2,
            positionVersions: positions,
            reasonCodes: [],
          },
        },
        {
          label: 'unknown reason',
          input: {
            id: `coverage-calculation-unknown-reason-${suffix}`,
            orderId,
            generation: 2,
            positionVersions: positions,
            reasonCodes: ['not_supported'],
          },
        },
        {
          label: 'verified reason mismatch',
          input: {
            id: `coverage-calculation-verified-reason-${suffix}`,
            orderId,
            generation: 2,
            positionVersions: positions,
            availability: 'verified_full',
            reasonCodes: ['no_compatible_rolls'],
            matchedRollCount: 1,
          },
        },
        {
          label: 'unavailable reason mismatch',
          input: {
            id: `coverage-calculation-unavailable-reason-${suffix}`,
            orderId,
            generation: 2,
            positionVersions: positions,
            reasonCodes: ['full_cover_available'],
          },
        },
        {
          label: 'unknown terminal reason',
          input: {
            id: `coverage-calculation-unknown-terminal-${suffix}`,
            orderId,
            generation: 2,
            positionVersions: positions,
            availability: 'unknown',
            reasonCodes: ['warehouse_recheck_pending'],
          },
        },
        {
          label: 'unknown stale reason',
          input: {
            id: `coverage-calculation-unknown-stale-${suffix}`,
            orderId,
            generation: 2,
            positionVersions: positions,
            availability: 'unknown',
            reasonCodes: ['inventory_changed'],
          },
        },
        {
          label: 'unsorted reasons',
          input: {
            id: `coverage-calculation-unsorted-reasons-${suffix}`,
            orderId,
            generation: 2,
            positionVersions: positions,
            reasonCodes: ['only_partial_cover', 'no_compatible_rolls'],
          },
        },
        {
          label: 'unsorted positions',
          input: {
            id: `coverage-calculation-unsorted-positions-${suffix}`,
            orderId,
            generation: 2,
            positionVersions: [...positions].reverse(),
          },
        },
        {
          label: 'missing position keys',
          input: {
            id: `coverage-calculation-missing-position-keys-${suffix}`,
            orderId,
            generation: 2,
            positionVersions: [{} as { positionId: string; version: number }],
          },
        },
        {
          label: 'blank position id',
          input: {
            id: `coverage-calculation-blank-position-${suffix}`,
            orderId,
            generation: 2,
            positionVersions: [{ positionId: '   ', version: 1 }],
          },
        },
        {
          label: 'duplicate verified candidate',
          input: {
            id: `coverage-calculation-duplicate-candidate-${suffix}`,
            orderId,
            generation: 2,
            positionVersions: positions,
            verifiedCandidateRollIds: ['roll-a', 'roll-a'],
          },
        },
        {
          label: 'blank verified candidate',
          input: {
            id: `coverage-calculation-blank-candidate-${suffix}`,
            orderId,
            generation: 2,
            positionVersions: positions,
            verifiedCandidateRollIds: [''],
          },
        },
      ];
      for (const { input, label } of invalidCalculations) {
        await expect(insertCalculation(prisma, input)).rejects.toThrow(
          new RegExp(`(?:${label.split(' ')[0]}|canonical|reason|candidate|position)`, 'u'),
        );
      }

      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_calculations" (
             "id", "orderId", "generation", "orderVersion", "positionVersions",
             "orderFingerprint", "inventoryEpoch", "inventoryFingerprint", "inputFingerprint",
             "algorithmVersion", "policyVersion", "availability", "reasonCodes",
             "requiredRollCount", "matchedRollCount", "uncertainRollCount",
             "verifiedCandidateRollIds", "uncertainCandidateRollIds", "systemActorKey"
           ) VALUES (
             $1, $2, 2, 1, $3::jsonb, $4, 0, $4, $4,
             'warehouse-coverage-matching/v1', 'warehouse-coverage-policy/v1',
             'unknown', '["roll_facts_incomplete"]'::jsonb,
             2, 1, 1, '["roll-overlap"]'::jsonb, '["roll-overlap"]'::jsonb, $5
           )`,
          `coverage-calculation-overlap-${suffix}`,
          orderId,
          JSON.stringify(positions),
          HEX_A,
          SYSTEM_ACTOR_KEY,
        ),
      ).rejects.toThrow(/candidate|disjoint/u);
      await expect(
        insertCalculation(prisma, {
          id: `coverage-calculation-bad-full-${suffix}`,
          orderId,
          generation: 2,
          positionVersions: positions,
          availability: 'verified_full',
          reasonCodes: ['full_cover_available'],
          requiredRollCount: 2,
          matchedRollCount: 1,
        }),
      ).rejects.toThrow(/counts|verified_full/u);

      const rollId = `coverage-non-full-roll-${suffix}`;
      const rollCode = `COVERAGE-NON-FULL-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_rolls" ("id", "rollCode", "warehouseStatus", "updatedAt")
         VALUES ($1, $2, 'received', CURRENT_TIMESTAMP)`,
        rollId,
        rollCode,
      );
      const factId = `coverage-non-full-fact-${suffix}`;
      await insertBackfillFact(prisma, { factId, rollCode, rollId });
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_matches" (
             "id", "calculationId", "orderId", "generation", "positionId",
             "rollId", "coverageFactId", "slotIndex"
           ) VALUES ($1, $2, $3, 1, $4, $5, $6, 1)`,
          `coverage-non-full-match-${suffix}`,
          `coverage-canonical-calculation-${suffix}`,
          orderId,
          positionId,
          rollId,
          factId,
        ),
      ).rejects.toThrow(/availability|match/u);
    }, [{ label: 'warehouse coverage calculation client', run: () => prisma.$disconnect() }]);
  });

  it('rejects cross-entity facts, matches, decisions, actors, provenance and memberships', async () => {
    const prisma = new PrismaClient();
    const suffix = createE2eSchemaName().split('_').at(-1) as string;
    await runE2eWithCleanup(async () => {
      const { orderId, positionId, userId } = await createMinimalOrder(prisma, suffix);
      const other = await createMinimalOrder(prisma, `${suffix}-other`);
      const rollId = `coverage-roll-${suffix}`;
      const otherRollId = `coverage-roll-other-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_rolls" ("id", "rollCode", "warehouseStatus", "updatedAt")
         VALUES
           ($1, $2, 'received', CURRENT_TIMESTAMP),
           ($3, $4, 'received', CURRENT_TIMESTAMP)`,
        rollId,
        `COVERAGE-${suffix}`,
        otherRollId,
        `COVERAGE-OTHER-${suffix}`,
      );

      const factId = `coverage-fact-${suffix}`;
      await insertBackfillFact(prisma, {
        factId,
        rollId,
        rollCode: `COVERAGE-${suffix}`,
      });
      const otherFactId = `coverage-fact-other-${suffix}`;
      await insertBackfillFact(prisma, {
        factId: otherFactId,
        rollId: otherRollId,
        rollCode: `COVERAGE-OTHER-${suffix}`,
      });
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "warehouse_rolls" SET "currentCoverageFactId" = $1 WHERE "id" = $2`,
          factId,
          otherRollId,
        ),
      ).rejects.toThrow(/current.*fact|same roll/u);
      const [{ epoch: decisionEpoch }] = await prisma.$queryRaw<Array<{ epoch: bigint }>>`
        SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1
      `;

      const calculationId = `coverage-calculation-${suffix}`;
      await insertCalculation(prisma, {
        id: calculationId,
        orderId,
        inventoryEpoch: decisionEpoch,
        availability: 'verified_full',
        positionVersions: [{ positionId, version: 1 }],
        reasonCodes: ['full_cover_available'],
        requiredRollCount: 1,
        matchedRollCount: 1,
        verifiedCandidateRollIds: [rollId],
      });
      const [{ calculatedAt: negativeCalculatedAt }] = await prisma.$queryRaw<
        Array<{ calculatedAt: Date }>
      >`
        SELECT "calculatedAt"
        FROM "warehouse_coverage_calculations"
        WHERE id = ${calculationId}
      `;
      const matchId = `coverage-match-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_matches" (
           "id", "calculationId", "orderId", "generation", "positionId",
           "rollId", "coverageFactId", "slotIndex"
         ) VALUES ($1, $2, $3, 1, $4, $5, $6, 1)`,
        matchId,
        calculationId,
        orderId,
        positionId,
        rollId,
        factId,
      );
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_matches" (
             "id", "calculationId", "orderId", "generation", "positionId",
             "rollId", "coverageFactId", "slotIndex"
           ) VALUES ($1, $2, $3, 1, $4, $5, $6, 2)`,
          `${matchId}-duplicate-roll`,
          calculationId,
          orderId,
          positionId,
          rollId,
          factId,
        ),
      ).rejects.toThrow(/calculation_roll|already exists/u);
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_matches" (
             "id", "calculationId", "orderId", "generation", "positionId",
             "rollId", "coverageFactId", "slotIndex"
           ) VALUES ($1, $2, $3, 1, $4, $5, $6, 1)`,
          `${matchId}-duplicate-slot`,
          calculationId,
          orderId,
          positionId,
          otherRollId,
          otherFactId,
        ),
      ).rejects.toThrow();

      const secondCalculationId = `coverage-calculation-second-${suffix}`;
      await insertCalculation(prisma, {
        id: secondCalculationId,
        orderId,
        generation: 2,
        inventoryEpoch: decisionEpoch,
        availability: 'verified_full',
        positionVersions: [{ positionId, version: 1 }],
        reasonCodes: ['full_cover_available'],
        requiredRollCount: 1,
        matchedRollCount: 1,
        verifiedCandidateRollIds: [otherRollId],
      });
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_matches" (
             "id", "calculationId", "orderId", "generation", "positionId",
             "rollId", "coverageFactId", "slotIndex"
           ) VALUES ($1, $2, $3, 2, $4, $5, $6, 1)`,
          `coverage-match-wrong-fact-${suffix}`,
          secondCalculationId,
          orderId,
          positionId,
          otherRollId,
          factId,
        ),
      ).rejects.toThrow(/fact|roll|match/u);
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_matches" (
           "id", "calculationId", "orderId", "generation", "positionId",
           "rollId", "coverageFactId", "slotIndex"
         ) VALUES ($1, $2, $3, 2, $4, $5, $6, 1)`,
        `coverage-match-second-${suffix}`,
        secondCalculationId,
        orderId,
        positionId,
        otherRollId,
        otherFactId,
      );

      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_decisions" (
             "id", "orderId", "calculationId", "generation", "kind",
             "inputFingerprint", "sourceInventoryEpoch", "expectedRollCount",
             "actorKind", "actorRole", "actorId"
           ) VALUES (
             $1::uuid, $2, $3, 2, 'produce_all', $4, 0, 0,
             'user', 'finance'::"Role", $5
           )`,
          randomUUID(),
          orderId,
          calculationId,
          HEX_A,
          userId,
        ),
      ).rejects.toThrow(/generation|decision|calculation/u);
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_decisions" (
             "id", "orderId", "calculationId", "generation", "kind",
             "inputFingerprint", "sourceInventoryEpoch", "expectedRollCount",
             "actorKind", "actorRole", "actorId"
           ) VALUES (
             $1::uuid, $2, $3, 1, 'produce_all', $4, 999, 0,
             'user', 'finance'::"Role", $5
           )`,
          randomUUID(),
          orderId,
          calculationId,
          HEX_A,
          userId,
        ),
      ).rejects.toThrow(/epoch|decision|calculation/u);

      const secondDecisionId = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_decisions" (
           "id", "orderId", "calculationId", "generation", "kind",
           "inputFingerprint", "sourceInventoryEpoch", "expectedRollCount",
           "actorKind", "actorRole", "actorId"
         ) VALUES (
           $1::uuid, $2, $3, 2, 'produce_all', $4, $5, 0,
           'user', 'finance'::"Role", $6
         )`,
        secondDecisionId,
        orderId,
        secondCalculationId,
        HEX_A,
        decisionEpoch,
        userId,
      );
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_states" (
             "orderId", "state", "stateVersion", "generation",
             "currentCalculationId", "currentDecisionId", "updatedAt"
           ) VALUES ($1, 'production_required', 1, 1, $2, $3::uuid, CURRENT_TIMESTAMP)`,
          orderId,
          calculationId,
          secondDecisionId,
        ),
      ).rejects.toThrow(/state|decision|calculation|generation/u);

      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_decisions" (
             "id", "orderId", "calculationId", "generation", "kind",
             "inputFingerprint", "sourceInventoryEpoch", "committedInventoryEpoch",
             "expectedRollCount", "actorKind", "actorRole", "actorId"
           ) VALUES (
             $1::uuid, $2, $3, 1, 'use_warehouse', $4, 0, 0, 1,
             'user', 'finance'::"Role", $5
           )`,
          randomUUID(),
          other.orderId,
          calculationId,
          HEX_A,
          userId,
        ),
      ).rejects.toThrow();
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_decisions" (
             "id", "orderId", "calculationId", "generation", "kind",
             "inputFingerprint", "sourceInventoryEpoch", "committedInventoryEpoch",
             "expectedRollCount", "actorKind", "actorRole", "actorId"
           ) VALUES (
             $1::uuid, $2, $3, 1, 'use_warehouse', $4, 0, 0, 1,
             'user', 'finance'::"Role", $5
           )`,
          randomUUID(),
          orderId,
          calculationId,
          HEX_B,
          userId,
        ),
      ).rejects.toThrow(/fingerprint|decision/u);

      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_commands" (
             "id", "clientRequestId", "kind", "orderId", "requestFingerprint",
             "actorKind", "actorRole", "actorId", "systemActorKey",
             "safeResultKind", "safeResult", "resultKind", "resultCalculationId",
             "resultGeneration", "resultStateVersion"
           ) VALUES (
             $1, $2::uuid, 'refresh', $3, $4,
             'system', 'finance'::"Role", $5, $6,
             'projection', $7::jsonb, 'calculation', $8, 1, 1
           )`,
          `coverage-command-${suffix}`,
          randomUUID(),
          orderId,
          HEX_A,
          userId,
          SYSTEM_ACTOR_KEY,
          JSON.stringify(
            financeProjection({
              calculatedAt: negativeCalculatedAt!.toISOString(),
              positionId,
              rollCodes: [`COVERAGE-${suffix}`],
            }),
          ),
          calculationId,
        ),
      ).rejects.toThrow(/actor_xor|actor/u);

      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "production_orders" (
             "id", "commercialOrderId", "sourceCoverageCalculationId", "updatedAt"
           ) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
          `coverage-production-${suffix}`,
          orderId,
          calculationId,
        ),
      ).rejects.toThrow(/coverage|provenance/u);

      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "order_resolution_cases" (
             "id", "orderId", "type", "ownerRole", "reason", "createdByRole",
             "coverageScope", "coverageOrigin", "sourceCoverageCalculationId",
             "sourceCoverageStateVersion", "updatedAt"
           ) VALUES (
             $1, $2, 'warehouse_coverage_recheck', 'warehouse'::"Role", 'invalid',
             'finance'::"Role", $3, 'finance_request', $4, 1, CURRENT_TIMESTAMP
           )`,
          `coverage-case-invalid-${suffix}`,
          orderId,
          `wrong:${orderId}`,
          calculationId,
        ),
      ).rejects.toThrow(/coverage/u);

      const explicitUnavailable = await createMinimalOrder(
        prisma,
        `${suffix}-explicit-unavailable`,
      );
      const explicitUnknown = await createMinimalOrder(prisma, `${suffix}-explicit-unknown`);
      const frozen = await createMinimalOrder(prisma, `${suffix}-frozen-match-set`);
      const decisionFrozen = await createMinimalOrder(
        prisma,
        `${suffix}-decision-frozen-match-set`,
      );
      const frozenRolls = [
        {
          factId: `coverage-frozen-fact-a-${suffix}`,
          rollCode: `COVERAGE-FROZEN-A-${suffix}`,
          rollId: `coverage-frozen-roll-a-${suffix}`,
        },
        {
          factId: `coverage-frozen-fact-b-${suffix}`,
          rollCode: `COVERAGE-FROZEN-B-${suffix}`,
          rollId: `coverage-frozen-roll-b-${suffix}`,
        },
      ];
      for (const frozenRoll of frozenRolls) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_rolls" ("id", "rollCode", "warehouseStatus", "updatedAt")
           VALUES ($1, $2, 'received', CURRENT_TIMESTAMP)`,
          frozenRoll.rollId,
          frozenRoll.rollCode,
        );
        await insertBackfillFact(prisma, frozenRoll);
      }
      const [{ epoch: policyEpoch }] = await prisma.$queryRaw<Array<{ epoch: bigint }>>`
        SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1
      `;
      const unavailableCalculationId = `coverage-explicit-unavailable-${suffix}`;
      await insertCalculation(prisma, {
        id: unavailableCalculationId,
        orderId: explicitUnavailable.orderId,
        inventoryEpoch: policyEpoch,
        positionVersions: [{ positionId: explicitUnavailable.positionId, version: 1 }],
      });
      const unknownCalculationId = `coverage-explicit-unknown-${suffix}`;
      await insertCalculation(prisma, {
        id: unknownCalculationId,
        orderId: explicitUnknown.orderId,
        inventoryEpoch: policyEpoch,
        availability: 'unknown',
        positionVersions: [{ positionId: explicitUnknown.positionId, version: 1 }],
        reasonCodes: ['roll_facts_incomplete'],
        uncertainRollCount: 1,
      });
      const frozenCalculationId = `coverage-frozen-calculation-${suffix}`;
      await insertCalculation(prisma, {
        id: frozenCalculationId,
        orderId: frozen.orderId,
        inventoryEpoch: policyEpoch,
        availability: 'verified_full',
        positionVersions: [{ positionId: frozen.positionId, version: 1 }],
        reasonCodes: ['full_cover_available'],
        matchedRollCount: 1,
        verifiedCandidateRollIds: frozenRolls.map(({ rollId: frozenRollId }) => frozenRollId),
      });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_matches" (
           "id", "calculationId", "orderId", "generation", "positionId",
           "rollId", "coverageFactId", "slotIndex"
         ) VALUES ($1, $2, $3, 1, $4, $5, $6, 1)`,
        `coverage-frozen-match-a-${suffix}`,
        frozenCalculationId,
        frozen.orderId,
        frozen.positionId,
        frozenRolls[0]!.rollId,
        frozenRolls[0]!.factId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_states" (
           "orderId", "state", "stateVersion", "generation",
           "currentCalculationId", "updatedAt"
         ) VALUES ($1, 'awaiting_finance', 1, 1, $2, CURRENT_TIMESTAMP)`,
        frozen.orderId,
        frozenCalculationId,
      );
      const decisionFrozenCalculationId = `coverage-decision-frozen-calculation-${suffix}`;
      await insertCalculation(prisma, {
        id: decisionFrozenCalculationId,
        orderId: decisionFrozen.orderId,
        inventoryEpoch: policyEpoch,
        availability: 'verified_full',
        positionVersions: [{ positionId: decisionFrozen.positionId, version: 1 }],
        reasonCodes: ['full_cover_available'],
        matchedRollCount: 1,
        verifiedCandidateRollIds: frozenRolls.map(({ rollId: frozenRollId }) => frozenRollId),
      });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_matches" (
           "id", "calculationId", "orderId", "generation", "positionId",
           "rollId", "coverageFactId", "slotIndex"
         ) VALUES ($1, $2, $3, 1, $4, $5, $6, 1)`,
        `coverage-decision-frozen-match-a-${suffix}`,
        decisionFrozenCalculationId,
        decisionFrozen.orderId,
        decisionFrozen.positionId,
        frozenRolls[0]!.rollId,
        frozenRolls[0]!.factId,
      );
      const insertExplicitProduceAll = (
        resultOrderId: string,
        resultCalculationId: string,
        actorId: string,
      ): Promise<unknown> =>
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_decisions" (
             "id", "orderId", "calculationId", "generation", "kind",
             "inputFingerprint", "sourceInventoryEpoch", "expectedRollCount",
             "actorKind", "actorRole", "actorId"
           ) VALUES (
             $1::uuid, $2, $3, 1, 'produce_all', $4, $5, 0,
             'user', 'finance'::"Role", $6
           )`,
          randomUUID(),
          resultOrderId,
          resultCalculationId,
          HEX_A,
          policyEpoch,
          actorId,
        );
      await insertExplicitProduceAll(
        decisionFrozen.orderId,
        decisionFrozenCalculationId,
        decisionFrozen.userId,
      );
      const unsafePublicationResults = await Promise.allSettled([
        insertExplicitProduceAll(
          explicitUnavailable.orderId,
          unavailableCalculationId,
          explicitUnavailable.userId,
        ),
        insertExplicitProduceAll(
          explicitUnknown.orderId,
          unknownCalculationId,
          explicitUnknown.userId,
        ),
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_matches" (
             "id", "calculationId", "orderId", "generation", "positionId",
             "rollId", "coverageFactId", "slotIndex"
           ) VALUES ($1, $2, $3, 1, $4, $5, $6, 2)`,
          `coverage-frozen-match-b-${suffix}`,
          frozenCalculationId,
          frozen.orderId,
          frozen.positionId,
          frozenRolls[1]!.rollId,
          frozenRolls[1]!.factId,
        ),
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_matches" (
             "id", "calculationId", "orderId", "generation", "positionId",
             "rollId", "coverageFactId", "slotIndex"
           ) VALUES ($1, $2, $3, 1, $4, $5, $6, 2)`,
          `coverage-decision-frozen-match-b-${suffix}`,
          decisionFrozenCalculationId,
          decisionFrozen.orderId,
          decisionFrozen.positionId,
          frozenRolls[1]!.rollId,
          frozenRolls[1]!.factId,
        ),
      ]);
      expect(
        Object.fromEntries(
          [
            'explicitUnavailable',
            'explicitUnknown',
            'lateStatePublishedMatch',
            'lateDecisionPublishedMatch',
          ].map((label, index) => [label, unsafePublicationResults[index]!.status]),
        ),
      ).toEqual({
        explicitUnavailable: 'rejected',
        explicitUnknown: 'rejected',
        lateStatePublishedMatch: 'rejected',
        lateDecisionPublishedMatch: 'rejected',
      });
    }, [{ label: 'warehouse coverage negative client', run: () => prisma.$disconnect() }]);
  });

  it('allows a preallocated decision UUID but rejects a missing or mismatched final decision', async () => {
    const prisma = new PrismaClient();
    const suffix = createE2eSchemaName().split('_').at(-1) as string;
    await runE2eWithCleanup(async () => {
      const { orderId, positionId, userId } = await createMinimalOrder(prisma, suffix);
      const rollId = `coverage-deferred-roll-${suffix}`;
      const rollCode = `COVERAGE-DEFERRED-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_rolls" ("id", "rollCode", "warehouseStatus", "updatedAt")
         VALUES ($1, $2, 'received', CURRENT_TIMESTAMP)`,
        rollId,
        rollCode,
      );
      const factId = `coverage-deferred-fact-${suffix}`;
      await insertBackfillFact(prisma, { factId, rollCode, rollId });
      await prisma.$executeRawUnsafe(
        `UPDATE "warehouse_rolls" SET "currentCoverageFactId" = $1 WHERE "id" = $2`,
        factId,
        rollId,
      );
      const [{ epoch: sourceInventoryEpoch }] = await prisma.$queryRaw<Array<{ epoch: bigint }>>`
        SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1
      `;
      const calculationId = `coverage-deferred-calculation-${suffix}`;
      await insertCalculation(prisma, {
        id: calculationId,
        orderId,
        inventoryEpoch: sourceInventoryEpoch,
        availability: 'verified_full',
        positionVersions: [{ positionId, version: 1 }],
        reasonCodes: ['full_cover_available'],
        requiredRollCount: 1,
        matchedRollCount: 1,
        verifiedCandidateRollIds: [rollId],
      });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_matches" (
           "id", "calculationId", "orderId", "generation", "positionId",
           "rollId", "coverageFactId", "slotIndex"
         ) VALUES ($1, $2, $3, 1, $4, $5, $6, 1)`,
        `coverage-deferred-match-${suffix}`,
        calculationId,
        orderId,
        positionId,
        rollId,
        factId,
      );

      const insertReserveSet = async (
        transaction: Omit<
          PrismaClient,
          '$connect' | '$disconnect' | '$on' | '$transaction' | '$use'
        >,
        decisionId: string,
        taskId: string,
        scanCode = rollCode,
      ): Promise<void> => {
        await transaction.$executeRawUnsafe(
          `UPDATE "warehouse_rolls"
           SET "reservedForOrderId" = $1, "reservedByCoverageDecisionId" = $2::uuid,
               "reservedAt" = now()
           WHERE "id" = $3`,
          orderId,
          decisionId,
          rollId,
        );
        await transaction.$executeRawUnsafe(
          `INSERT INTO "warehouse_acceptance_tasks" (
             "id", "mode", "status", "orderId", "coverageDecisionId", "updatedAt"
           ) VALUES ($1, 'reserve', 'open', $2, $3::uuid, CURRENT_TIMESTAMP)`,
          taskId,
          orderId,
          decisionId,
        );
        await transaction.$executeRawUnsafe(
          `INSERT INTO "scan_rows" ("id", "taskId", "rollCode", "fromOrderId")
           VALUES ($1, $2, $3, $4)`,
          `${taskId}-row`,
          taskId,
          scanCode,
          orderId,
        );
      };
      const insertDecision = async (
        transaction: Omit<
          PrismaClient,
          '$connect' | '$disconnect' | '$on' | '$transaction' | '$use'
        >,
        decisionId: string,
        committedInventoryEpoch: bigint,
        expectedRollCount = 1,
        resultCalculationId = calculationId,
        resultGeneration = 1,
        resultSourceInventoryEpoch = sourceInventoryEpoch,
      ): Promise<void> => {
        await transaction.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_decisions" (
             "id", "orderId", "calculationId", "generation", "kind",
             "inputFingerprint", "sourceInventoryEpoch", "committedInventoryEpoch",
             "expectedRollCount", "actorKind", "actorRole", "actorId"
           ) VALUES (
             $1::uuid, $2, $3, $4, 'use_warehouse', $5, $6, $7, $8,
             'user', 'finance'::"Role", $9
           )`,
          decisionId,
          orderId,
          resultCalculationId,
          resultGeneration,
          HEX_A,
          resultSourceInventoryEpoch,
          committedInventoryEpoch,
          expectedRollCount,
          userId,
        );
      };

      const missingDecisionId = randomUUID();
      await expect(
        prisma.$transaction(async (transaction) => {
          await insertReserveSet(
            transaction as Parameters<typeof insertReserveSet>[0],
            missingDecisionId,
            `coverage-missing-task-${suffix}`,
          );
        }),
      ).rejects.toThrow(/coverageDecisionId|foreign key/iu);

      const wrongScanDecisionId = randomUUID();
      await expect(
        prisma.$transaction(async (transaction) => {
          await insertReserveSet(
            transaction as Parameters<typeof insertReserveSet>[0],
            wrongScanDecisionId,
            `coverage-wrong-scan-task-${suffix}`,
            `WRONG-${rollCode}`,
          );
          const [{ epoch: committedInventoryEpoch }] = await transaction.$queryRaw<
            Array<{ epoch: bigint }>
          >`SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1`;
          await insertDecision(
            transaction as Parameters<typeof insertDecision>[0],
            wrongScanDecisionId,
            committedInventoryEpoch,
          );
        }),
      ).rejects.toThrow(/final decision set|scan|match/u);

      const mismatchedDecisionId = randomUUID();
      await expect(
        prisma.$transaction(async (transaction) => {
          await insertReserveSet(
            transaction as Parameters<typeof insertReserveSet>[0],
            mismatchedDecisionId,
            `coverage-mismatch-task-${suffix}`,
          );
          const [{ epoch: committedInventoryEpoch }] = await transaction.$queryRaw<
            Array<{ epoch: bigint }>
          >`SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1`;
          await insertDecision(
            transaction as Parameters<typeof insertDecision>[0],
            mismatchedDecisionId,
            committedInventoryEpoch,
            2,
          );
        }),
      ).rejects.toThrow(/final decision set|expectedRollCount|match/u);

      const futureEpochDecisionId = randomUUID();
      await expect(
        prisma.$transaction(async (transaction) => {
          await insertReserveSet(
            transaction as Parameters<typeof insertReserveSet>[0],
            futureEpochDecisionId,
            `coverage-future-epoch-task-${suffix}`,
          );
          const [{ epoch: committedInventoryEpoch }] = await transaction.$queryRaw<
            Array<{ epoch: bigint }>
          >`SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1`;
          await insertDecision(
            transaction as Parameters<typeof insertDecision>[0],
            futureEpochDecisionId,
            committedInventoryEpoch + 1n,
          );
        }),
      ).rejects.toThrow(/committed|epoch|decision/u);

      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_rolls" ("id", "rollCode", "warehouseStatus", "updatedAt")
         VALUES ($1, $2, 'received', CURRENT_TIMESTAMP)`,
        `coverage-deferred-epoch-bump-${suffix}`,
        `COVERAGE-DEFERRED-EPOCH-BUMP-${suffix}`,
      );
      const staleSourceDecisionId = randomUUID();
      await expect(
        prisma.$transaction(async (transaction) => {
          await insertReserveSet(
            transaction as Parameters<typeof insertReserveSet>[0],
            staleSourceDecisionId,
            `coverage-stale-source-task-${suffix}`,
          );
          const [{ epoch: committedInventoryEpoch }] = await transaction.$queryRaw<
            Array<{ epoch: bigint }>
          >`SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1`;
          await insertDecision(
            transaction as Parameters<typeof insertDecision>[0],
            staleSourceDecisionId,
            committedInventoryEpoch,
          );
        }),
      ).rejects.toThrow(/source|fresh|epoch|decision/u);

      const [{ epoch: freshSourceInventoryEpoch }] = await prisma.$queryRaw<
        Array<{ epoch: bigint }>
      >`SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1`;
      const freshCalculationId = `coverage-deferred-calculation-2-${suffix}`;
      await insertCalculation(prisma, {
        id: freshCalculationId,
        orderId,
        generation: 2,
        inventoryEpoch: freshSourceInventoryEpoch,
        availability: 'verified_full',
        positionVersions: [{ positionId, version: 1 }],
        reasonCodes: ['full_cover_available'],
        requiredRollCount: 1,
        matchedRollCount: 1,
        verifiedCandidateRollIds: [rollId],
      });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_matches" (
           "id", "calculationId", "orderId", "generation", "positionId",
           "rollId", "coverageFactId", "slotIndex"
         ) VALUES ($1, $2, $3, 2, $4, $5, $6, 1)`,
        `coverage-deferred-match-2-${suffix}`,
        freshCalculationId,
        orderId,
        positionId,
        rollId,
        factId,
      );
      const validDecisionId = randomUUID();
      await expect(
        prisma.$transaction(async (transaction) => {
          await insertReserveSet(
            transaction as Parameters<typeof insertReserveSet>[0],
            validDecisionId,
            `coverage-deferred-task-${suffix}`,
          );
          const [{ epoch: committedInventoryEpoch }] = await transaction.$queryRaw<
            Array<{ epoch: bigint }>
          >`SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1`;
          await insertDecision(
            transaction as Parameters<typeof insertDecision>[0],
            validDecisionId,
            committedInventoryEpoch,
            1,
            freshCalculationId,
            2,
            freshSourceInventoryEpoch,
          );
        }),
      ).resolves.toBeUndefined();
    }, [{ label: 'warehouse coverage deferred client', run: () => prisma.$disconnect() }]);
  });

  it('accepts only the exact five command result, scope, actor and safe projection shapes', async () => {
    const prisma = new PrismaClient();
    const suffix = createE2eSchemaName().split('_').at(-1) as string;
    await runE2eWithCleanup(async () => {
      const { orderId, positionId, userId } = await createMinimalOrder(prisma, suffix);
      const warehouseUserId = `coverage-command-warehouse-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "users" ("id", "login", "displayName", "role")
         VALUES ($1, $2, $3, 'warehouse'::"Role")`,
        warehouseUserId,
        `${warehouseUserId}@test.local`,
        warehouseUserId,
      );
      const rollId = `coverage-command-roll-${suffix}`;
      const rollCode = `COVERAGE-COMMAND-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_rolls" ("id", "rollCode", "warehouseStatus", "updatedAt")
         VALUES ($1, $2, 'received', CURRENT_TIMESTAMP)`,
        rollId,
        rollCode,
      );
      const factId = `coverage-command-fact-${suffix}`;
      await insertBackfillFact(prisma, { factId, rollCode, rollId });
      await prisma.$executeRawUnsafe(
        `UPDATE "warehouse_rolls" SET "currentCoverageFactId" = $1 WHERE "id" = $2`,
        factId,
        rollId,
      );
      const [{ epoch }] = await prisma.$queryRaw<Array<{ epoch: bigint }>>`
        SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1
      `;
      const calculationId = `coverage-command-calculation-${suffix}`;
      await insertCalculation(prisma, {
        id: calculationId,
        orderId,
        positionVersions: [{ positionId, version: 1 }],
        inventoryEpoch: epoch,
        availability: 'verified_full',
        reasonCodes: ['full_cover_available'],
        requiredRollCount: 1,
        matchedRollCount: 1,
        verifiedCandidateRollIds: [rollId],
      });
      const [{ calculatedAt: commandCalculatedAt }] = await prisma.$queryRaw<
        Array<{ calculatedAt: Date }>
      >`
        SELECT "calculatedAt"
        FROM "warehouse_coverage_calculations"
        WHERE id = ${calculationId}
      `;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_matches" (
           "id", "calculationId", "orderId", "generation", "positionId",
           "rollId", "coverageFactId", "slotIndex"
         ) VALUES ($1, $2, $3, 1, $4, $5, $6, 1)`,
        `coverage-command-match-${suffix}`,
        calculationId,
        orderId,
        positionId,
        rollId,
        factId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_states" (
           "orderId", "state", "stateVersion", "generation",
           "currentCalculationId", "updatedAt"
         ) VALUES ($1, 'awaiting_finance', 1, 1, $2, CURRENT_TIMESTAMP)`,
        orderId,
        calculationId,
      );
      const decisionId = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_decisions" (
           "id", "orderId", "calculationId", "generation", "kind",
           "inputFingerprint", "sourceInventoryEpoch", "expectedRollCount",
           "actorKind", "actorRole", "actorId"
         ) VALUES (
           $1::uuid, $2, $3, 1, 'produce_all', $4, $5, 0,
           'user', 'finance'::"Role", $6
         )`,
        decisionId,
        orderId,
        calculationId,
        HEX_A,
        epoch,
        userId,
      );
      const caseId = `coverage-command-case-${suffix}`;
      const financeScope = `warehouse_coverage_v2:${orderId}`;
      const financeOpenScope = `${financeScope}:finance_request`;
      const insertFinanceCase = (input: {
        id: string;
        openScopeKey?: string | null;
        ownerRole?: string;
        sourceDecisionId?: string | null;
        sourceStateVersion?: number;
      }): Promise<unknown> =>
        prisma.$executeRawUnsafe(
          `INSERT INTO "order_resolution_cases" (
             "id", "openScopeKey", "orderId", "type", "status", "ownerRole",
             "reason", "createdByRole", "coverageScope", "coverageOrigin",
             "sourceCoverageCalculationId", "sourceCoverageDecisionId",
             "sourceCoverageStateVersion", "updatedAt"
           ) VALUES (
             $1, $2, $3, 'warehouse_coverage_recheck', 'open', $4::"Role",
             'Перепроверить', 'finance'::"Role", $5, 'finance_request', $6, $7::uuid, $8,
             CURRENT_TIMESTAMP
           )`,
          input.id,
          input.openScopeKey === undefined ? financeOpenScope : input.openScopeKey,
          orderId,
          input.ownerRole ?? 'warehouse',
          financeScope,
          calculationId,
          input.sourceDecisionId ?? null,
          input.sourceStateVersion ?? 1,
        );
      await expect(
        insertFinanceCase({
          id: `coverage-case-finance-decision-${suffix}`,
          sourceDecisionId: decisionId,
        }),
      ).rejects.toThrow(/case|decision|origin|coverage/u);
      await expect(
        insertFinanceCase({
          id: `coverage-case-finance-owner-${suffix}`,
          ownerRole: 'commercial',
        }),
      ).rejects.toThrow(/case|owner|coverage/u);
      await expect(
        insertFinanceCase({
          id: `coverage-case-finance-open-missing-${suffix}`,
          openScopeKey: null,
        }),
      ).rejects.toThrow(/case|openScopeKey|coverage/u);
      await expect(
        insertFinanceCase({
          id: `coverage-case-finance-open-wrong-${suffix}`,
          openScopeKey: `${financeScope}:wrong`,
        }),
      ).rejects.toThrow(/case|openScopeKey|coverage/u);
      await expect(
        insertFinanceCase({
          id: `coverage-case-finance-state-version-drift-${suffix}`,
          sourceStateVersion: 2,
        }),
      ).rejects.toThrow(/case|state|version|coverage/u);
      const orphanCase = await createMinimalOrder(prisma, `${suffix}-orphan-case`);
      const orphanCalculationId = `coverage-command-orphan-case-calculation-${suffix}`;
      await insertCalculation(prisma, {
        id: orphanCalculationId,
        orderId: orphanCase.orderId,
        inventoryEpoch: epoch,
        positionVersions: [{ positionId: orphanCase.positionId, version: 1 }],
      });
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "order_resolution_cases" (
             "id", "openScopeKey", "orderId", "type", "status", "ownerRole",
             "reason", "createdByRole", "coverageScope", "coverageOrigin",
             "sourceCoverageCalculationId", "sourceCoverageStateVersion", "updatedAt"
           ) VALUES (
             $1, $2, $3, 'warehouse_coverage_recheck', 'open', 'warehouse'::"Role",
             'Перепроверить', 'finance'::"Role", $4, 'finance_request', $5, 1,
             CURRENT_TIMESTAMP
           )`,
          `coverage-command-orphan-case-${suffix}`,
          `warehouse_coverage_v2:${orphanCase.orderId}:finance_request`,
          orphanCase.orderId,
          `warehouse_coverage_v2:${orphanCase.orderId}`,
          orphanCalculationId,
        ),
      ).rejects.toThrow(/case|state|version|coverage/u);
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "order_resolution_cases" (
             "id", "orderId", "type", "status", "ownerRole", "reason",
             "createdByRole", "coverageScope", "updatedAt"
           ) VALUES (
             $1, $2, 'legacy', 'open', 'commercial'::"Role", 'legacy',
             'commercial'::"Role", $3, CURRENT_TIMESTAMP
           )`,
          `coverage-case-legacy-partial-${suffix}`,
          orderId,
          financeScope,
        ),
      ).rejects.toThrow(/case|legacy|coverage/u);
      await insertFinanceCase({ id: caseId });
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "order_resolution_cases"
           SET "openScopeKey" = NULL,
               "coverageScope" = NULL,
               "coverageOrigin" = NULL,
               "sourceCoverageCalculationId" = NULL,
               "sourceCoverageDecisionId" = NULL,
               "sourceCoverageStateVersion" = NULL
           WHERE "id" = $1`,
          caseId,
        ),
      ).rejects.toThrow(/case|coverage|immutable/u);
      const resolveCalculationId = `coverage-command-resolve-calculation-${suffix}`;
      await insertCalculation(prisma, {
        id: resolveCalculationId,
        orderId,
        generation: 2,
        inventoryEpoch: epoch,
        positionVersions: [{ positionId, version: 1 }],
        availability: 'verified_full',
        reasonCodes: ['full_cover_available'],
        requiredRollCount: 1,
        matchedRollCount: 1,
        verifiedCandidateRollIds: [rollId],
      });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_matches" (
           "id", "calculationId", "orderId", "generation", "positionId",
           "rollId", "coverageFactId", "slotIndex"
         ) VALUES ($1, $2, $3, 2, $4, $5, $6, 1)`,
        `coverage-command-resolve-match-${suffix}`,
        resolveCalculationId,
        orderId,
        positionId,
        rollId,
        factId,
      );
      const [{ calculatedAt: resolveCalculatedAt }] = await prisma.$queryRaw<
        Array<{ calculatedAt: Date }>
      >`
        SELECT "calculatedAt"
        FROM "warehouse_coverage_calculations"
        WHERE id = ${resolveCalculationId}
      `;
      const decideOrder = await createMinimalOrder(prisma, `${suffix}-decide-command`);
      const decideCalculationId = `coverage-command-decide-calculation-${suffix}`;
      await insertCalculation(prisma, {
        id: decideCalculationId,
        orderId: decideOrder.orderId,
        positionVersions: [{ positionId: decideOrder.positionId, version: 1 }],
        inventoryEpoch: epoch,
        availability: 'verified_full',
        reasonCodes: ['full_cover_available'],
        matchedRollCount: 1,
        verifiedCandidateRollIds: [rollId],
      });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_matches" (
           "id", "calculationId", "orderId", "generation", "positionId",
           "rollId", "coverageFactId", "slotIndex"
         ) VALUES ($1, $2, $3, 1, $4, $5, $6, 1)`,
        `coverage-command-decide-match-${suffix}`,
        decideCalculationId,
        decideOrder.orderId,
        decideOrder.positionId,
        rollId,
        factId,
      );
      const decideDecisionId = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_decisions" (
           "id", "orderId", "calculationId", "generation", "kind",
           "inputFingerprint", "sourceInventoryEpoch", "expectedRollCount",
           "actorKind", "actorRole", "actorId"
         ) VALUES (
           $1::uuid, $2, $3, 1, 'produce_all', $4, $5, 0,
           'user', 'finance'::"Role", $6
         )`,
        decideDecisionId,
        decideOrder.orderId,
        decideCalculationId,
        HEX_A,
        epoch,
        decideOrder.userId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_states" (
           "orderId", "state", "stateVersion", "generation",
           "currentCalculationId", "updatedAt"
         ) VALUES ($1, 'awaiting_finance', 1, 1, $2, CURRENT_TIMESTAMP)`,
        decideOrder.orderId,
        decideCalculationId,
      );
      await prisma.$executeRawUnsafe(
        `UPDATE "warehouse_coverage_states"
         SET "state" = 'production_required', "stateVersion" = 2,
             "currentDecisionId" = $1::uuid
         WHERE "orderId" = $2 AND "stateVersion" = 1`,
        decideDecisionId,
        decideOrder.orderId,
      );
      const [{ calculatedAt: decideCalculatedAt }] = await prisma.$queryRaw<
        Array<{ calculatedAt: Date }>
      >`
        SELECT "calculatedAt"
        FROM "warehouse_coverage_calculations"
        WHERE "id" = ${decideCalculationId}
      `;

      type CommandInput = {
        actorId?: string | null;
        actorKind?: string;
        actorRole?: string | null;
        clientRequestId?: string;
        id: string;
        kind: string;
        orderId?: string;
        resultCalculationId?: string | null;
        resultCaseId?: string | null;
        resultDecisionId?: string | null;
        resultGeneration?: number | null;
        resultKind: string;
        resultStateVersion?: number;
        safeResult: Record<string, unknown>;
        safeResultKind: string;
        scopeCaseId?: string | null;
        scopeTaskId?: string | null;
        systemActorKey?: string | null;
      };
      const insertCommand = (input: CommandInput): Promise<unknown> =>
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_commands" (
             "id", "clientRequestId", "kind", "orderId", "scopeCaseId", "scopeTaskId",
             "requestFingerprint", "actorKind", "actorRole", "actorId", "systemActorKey",
             "safeResultKind", "safeResult", "resultKind", "resultCalculationId",
             "resultDecisionId", "resultCaseId", "resultGeneration", "resultStateVersion"
           ) VALUES (
             $1, $2::uuid, $3, $4, $5, $6, $7, $8, $9::"Role", $10, $11,
             $12, $13::jsonb, $14, $15, $16::uuid, $17, $18, $19
           )`,
          input.id,
          input.clientRequestId ?? randomUUID(),
          input.kind,
          input.orderId ?? orderId,
          input.scopeCaseId ?? null,
          input.scopeTaskId ?? null,
          HEX_A,
          input.actorKind ?? 'user',
          input.actorRole === undefined ? 'finance' : input.actorRole,
          input.actorId === undefined ? userId : input.actorId,
          input.systemActorKey ?? null,
          input.safeResultKind,
          JSON.stringify(input.safeResult),
          input.resultKind,
          input.resultCalculationId ?? null,
          input.resultDecisionId ?? null,
          input.resultCaseId ?? null,
          input.resultGeneration === undefined ? 1 : input.resultGeneration,
          input.resultStateVersion ?? 1,
        );
      const finance = financeProjection({
        calculatedAt: commandCalculatedAt!.toISOString(),
        positionId,
        rollCodes: [rollCode],
      });
      const productionRequired = financeProjection({
        calculatedAt: decideCalculatedAt!.toISOString(),
        positionId: decideOrder.positionId,
        rollCodes: [rollCode],
        state: 'production_required',
        stateVersion: 2,
      });
      productionRequired.availableActions = [];
      const recheckRequested = financeProjection({
        calculatedAt: commandCalculatedAt!.toISOString(),
        positionId,
        rollCodes: [rollCode],
        state: 'recheck_requested',
        stateVersion: 2,
      });
      recheckRequested.availableActions = [];
      const resolvedRecheck = aggregateProjection({
        calculatedAt: resolveCalculatedAt!.toISOString(),
        generation: 2,
        positionId,
        rollCodes: [rollCode],
        state: 'awaiting_finance',
        stateVersion: 3,
      });
      resolvedRecheck.availableActions = [];
      const refreshRequestId = randomUUID();
      const resolveRequestId = randomUUID();
      const validRoutineCommands: CommandInput[] = [
        {
          clientRequestId: refreshRequestId,
          id: `coverage-command-refresh-${suffix}`,
          kind: 'refresh',
          safeResultKind: 'projection',
          safeResult: finance,
          resultKind: 'calculation',
          resultCalculationId: calculationId,
        },
        {
          id: `coverage-command-decide-${suffix}`,
          kind: 'decide',
          orderId: decideOrder.orderId,
          safeResultKind: 'projection',
          safeResult: productionRequired,
          resultKind: 'decision',
          resultDecisionId: decideDecisionId,
          resultStateVersion: 2,
        },
        {
          id: `coverage-command-request-${suffix}`,
          kind: 'request_recheck',
          safeResultKind: 'projection_with_case',
          safeResult: { ...recheckRequested, caseId },
          resultKind: 'recheck_case',
          resultCaseId: caseId,
          resultStateVersion: 2,
        },
        {
          clientRequestId: resolveRequestId,
          id: `coverage-command-resolve-${suffix}`,
          kind: 'resolve_recheck',
          actorId: warehouseUserId,
          actorRole: 'warehouse',
          scopeCaseId: caseId,
          safeResultKind: 'projection',
          safeResult: resolvedRecheck,
          resultKind: 'calculation',
          resultCalculationId: resolveCalculationId,
          resultGeneration: 2,
          resultStateVersion: 3,
        },
      ];
      await expect(insertCommand(validRoutineCommands[0]!)).resolves.toBeDefined();
      await prisma.$executeRawUnsafe(
        `UPDATE "warehouse_coverage_states"
         SET "state" = 'recheck_requested', "stateVersion" = 2
         WHERE "orderId" = $1 AND "stateVersion" = 1`,
        orderId,
      );
      await expect(insertCommand(validRoutineCommands[2]!)).resolves.toBeDefined();
      await expect(insertCommand(validRoutineCommands[1]!)).resolves.toBeDefined();
      const openResolveCaseId = `coverage-command-open-resolve-case-${suffix}`;
      await prisma.$executeRawUnsafe(
        `UPDATE "order_resolution_cases"
         SET "status" = 'resolved', "openScopeKey" = NULL, "version" = 2,
             "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = $1`,
        caseId,
      );
      await expect(
        insertCommand({
          ...validRoutineCommands[2]!,
          clientRequestId: randomUUID(),
          id: `coverage-command-request-resolved-case-${suffix}`,
        }),
      ).rejects.toThrow(/case|open|lifecycle|result/u);
      const numericCaseId = '987654321';
      await insertFinanceCase({ id: numericCaseId, sourceStateVersion: 2 });
      await expect(
        insertCommand({
          ...validRoutineCommands[2]!,
          clientRequestId: randomUUID(),
          id: `coverage-command-numeric-case-id-${suffix}`,
          resultCaseId: numericCaseId,
          safeResult: {
            ...recheckRequested,
            caseId: Number(numericCaseId),
          },
        }),
      ).rejects.toThrow(/caseId|safeResult|projection|type/u);
      await prisma.$executeRawUnsafe(
        `UPDATE "order_resolution_cases"
         SET "status" = 'resolved', "openScopeKey" = NULL, "version" = 2,
             "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = $1`,
        numericCaseId,
      );
      await insertFinanceCase({ id: openResolveCaseId, sourceStateVersion: 2 });
      await prisma.$executeRawUnsafe(
        `UPDATE "warehouse_coverage_states"
         SET "state" = 'awaiting_finance', "stateVersion" = 3, "generation" = 2,
             "currentCalculationId" = $1
         WHERE "orderId" = $2 AND "stateVersion" = 2`,
        resolveCalculationId,
        orderId,
      );
      await expect(
        insertCommand({
          ...validRoutineCommands[3]!,
          clientRequestId: randomUUID(),
          id: `coverage-command-resolve-open-case-${suffix}`,
          scopeCaseId: openResolveCaseId,
        }),
      ).rejects.toThrow(/case|resolved|lifecycle|scope/u);
      await expect(insertCommand(validRoutineCommands[3]!)).resolves.toBeDefined();

      const nonFull = await createMinimalOrder(prisma, `${suffix}-non-full-command`);
      const nonFullCalculationId = `coverage-command-non-full-calculation-${suffix}`;
      await insertCalculation(prisma, {
        id: nonFullCalculationId,
        orderId: nonFull.orderId,
        inventoryEpoch: epoch,
        positionVersions: [{ positionId: nonFull.positionId, version: 1 }],
        reasonCodes: ['only_partial_cover'],
        requiredRollCount: 2,
        matchedRollCount: 1,
        verifiedCandidateRollIds: [`coverage-command-candidate-${suffix}`],
      });
      const [{ calculatedAt: nonFullCalculatedAt }] = await prisma.$queryRaw<
        Array<{ calculatedAt: Date }>
      >`
        SELECT "calculatedAt"
        FROM "warehouse_coverage_calculations"
        WHERE id = ${nonFullCalculationId}
      `;
      const nonFullProjection = financeProjection({
        calculatedAt: nonFullCalculatedAt!.toISOString(),
        matched: 1,
        positionId: nonFull.positionId,
        required: 2,
        rollCodes: [],
        state: 'production_required',
      });
      nonFullProjection.reasonCodes = ['only_partial_cover'];
      const autoDecisionId = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_decisions" (
           "id", "orderId", "calculationId", "generation", "kind",
           "inputFingerprint", "sourceInventoryEpoch", "expectedRollCount",
           "actorKind", "systemActorKey"
         ) VALUES (
           $1::uuid, $2, $3, 1, 'auto_produce_all',
           $4, $5, 0, 'system', $6
         )`,
        autoDecisionId,
        nonFull.orderId,
        nonFullCalculationId,
        HEX_A,
        epoch,
        SYSTEM_ACTOR_KEY,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_states" (
           "orderId", "state", "stateVersion", "generation",
           "currentCalculationId", "currentDecisionId", "updatedAt"
         ) VALUES ($1, 'production_required', 1, 1, $2, $3::uuid, CURRENT_TIMESTAMP)`,
        nonFull.orderId,
        nonFullCalculationId,
        autoDecisionId,
      );
      await expect(
        insertCommand({
          id: `coverage-command-non-full-refresh-${suffix}`,
          kind: 'refresh',
          orderId: nonFull.orderId,
          safeResultKind: 'projection',
          safeResult: nonFullProjection,
          resultKind: 'calculation',
          resultCalculationId: nonFullCalculationId,
        }),
      ).resolves.toBeDefined();
      await expect(
        insertCommand({
          id: `coverage-command-user-decide-auto-${suffix}`,
          kind: 'decide',
          orderId: nonFull.orderId,
          resultDecisionId: autoDecisionId,
          resultKind: 'decision',
          resultStateVersion: 2,
          safeResult: {
            ...nonFullProjection,
            availableActions: [],
            stateVersion: 2,
          },
          safeResultKind: 'projection',
        }),
      ).rejects.toThrow(/decision|auto|kind|command/u);

      const stateBound = await createMinimalOrder(prisma, `${suffix}-state-bound-command`);
      const stateBoundCalculationId = `coverage-command-state-bound-calculation-${suffix}`;
      await insertCalculation(prisma, {
        id: stateBoundCalculationId,
        orderId: stateBound.orderId,
        inventoryEpoch: epoch,
        positionVersions: [{ positionId: stateBound.positionId, version: 1 }],
        availability: 'verified_full',
        reasonCodes: ['full_cover_available'],
        matchedRollCount: 1,
        verifiedCandidateRollIds: [rollId],
      });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_matches" (
           "id", "calculationId", "orderId", "generation", "positionId",
           "rollId", "coverageFactId", "slotIndex"
         ) VALUES ($1, $2, $3, 1, $4, $5, $6, 1)`,
        `coverage-command-state-bound-match-${suffix}`,
        stateBoundCalculationId,
        stateBound.orderId,
        stateBound.positionId,
        rollId,
        factId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_states" (
           "orderId", "state", "stateVersion", "generation",
           "currentCalculationId", "updatedAt"
         ) VALUES ($1, 'awaiting_finance', 1, 1, $2, CURRENT_TIMESTAMP)`,
        stateBound.orderId,
        stateBoundCalculationId,
      );
      const [{ calculatedAt: stateBoundCalculatedAt }] = await prisma.$queryRaw<
        Array<{ calculatedAt: Date }>
      >`
        SELECT "calculatedAt"
        FROM "warehouse_coverage_calculations"
        WHERE id = ${stateBoundCalculationId}
      `;
      await expect(
        insertCommand({
          id: `coverage-command-state-row-version-mismatch-${suffix}`,
          kind: 'refresh',
          orderId: stateBound.orderId,
          resultCalculationId: stateBoundCalculationId,
          resultKind: 'calculation',
          resultStateVersion: 2,
          safeResult: financeProjection({
            calculatedAt: stateBoundCalculatedAt!.toISOString(),
            positionId: stateBound.positionId,
            rollCodes: [rollCode],
            stateVersion: 2,
          }),
          safeResultKind: 'projection',
        }),
      ).rejects.toThrow(/state|version|pointer|result/u);

      const missingRequiredSafeKey = { ...finance };
      delete missingRequiredSafeKey.stale;
      await expect(
        insertCommand({
          ...validRoutineCommands[0]!,
          clientRequestId: randomUUID(),
          id: `coverage-command-invalid-kind-${suffix}`,
          kind: 'delete_everything',
        }),
      ).rejects.toThrow(/kind|command/u);
      await expect(
        insertCommand({
          ...validRoutineCommands[0]!,
          actorId: null,
          actorKind: 'system',
          actorRole: null,
          clientRequestId: randomUUID(),
          id: `coverage-command-routine-system-actor-${suffix}`,
          systemActorKey: SYSTEM_ACTOR_KEY,
        }),
      ).rejects.toThrow(/actor|routine|command/u);
      await expect(
        insertCommand({
          ...validRoutineCommands[0]!,
          clientRequestId: randomUUID(),
          id: `coverage-command-missing-safe-key-${suffix}`,
          safeResult: missingRequiredSafeKey,
        }),
      ).rejects.toThrow(/safeResult|projection|stale/u);
      await expect(
        insertCommand({
          ...validRoutineCommands[0]!,
          clientRequestId: randomUUID(),
          id: `coverage-command-string-workflow-version-${suffix}`,
          safeResult: { ...finance, workflowVersion: '2' },
        }),
      ).rejects.toThrow(/safeResult|projection|workflowVersion|type/u);
      await expect(
        insertCommand({
          ...validRoutineCommands[0]!,
          clientRequestId: randomUUID(),
          id: `coverage-command-extra-safe-key-${suffix}`,
          safeResult: { ...finance, rawRollIds: [rollId] },
        }),
      ).rejects.toThrow(/safeResult|projection/u);
      await expect(
        insertCommand({
          ...validRoutineCommands[0]!,
          clientRequestId: randomUUID(),
          id: `coverage-command-wrong-result-${suffix}`,
          resultKind: 'decision',
          resultCalculationId: null,
          resultDecisionId: decisionId,
        }),
      ).rejects.toThrow(/result|command/u);
      await expect(
        insertCommand({
          ...validRoutineCommands[0]!,
          clientRequestId: randomUUID(),
          id: `coverage-command-two-results-${suffix}`,
          resultDecisionId: decisionId,
        }),
      ).rejects.toThrow(/result|command/u);
      await expect(
        insertCommand({
          ...validRoutineCommands[3]!,
          id: `coverage-command-duplicate-client-request-${suffix}`,
        }),
      ).rejects.toThrow(/clientRequestId|unique/u);
      await expect(
        insertCommand({
          ...validRoutineCommands[0]!,
          clientRequestId: randomUUID(),
          id: `coverage-command-wrong-scope-${suffix}`,
          scopeCaseId: caseId,
        }),
      ).rejects.toThrow(/scope|result/u);
      await expect(
        insertCommand({
          ...validRoutineCommands[0]!,
          clientRequestId: randomUUID(),
          id: `coverage-command-missing-actor-${suffix}`,
          actorId: null,
        }),
      ).rejects.toThrow(/actor/u);
      await expect(
        insertCommand({
          ...validRoutineCommands[0]!,
          clientRequestId: randomUUID(),
          id: `coverage-command-wrong-stored-role-${suffix}`,
          actorRole: 'commercial',
        }),
      ).rejects.toThrow(/actor|role/u);
      await expect(
        insertCommand({
          ...validRoutineCommands[0]!,
          clientRequestId: randomUUID(),
          id: `coverage-command-generation-mismatch-${suffix}`,
          resultGeneration: 2,
        }),
      ).rejects.toThrow(/generation|result/u);
      await expect(
        insertCommand({
          ...validRoutineCommands[0]!,
          clientRequestId: randomUUID(),
          id: `coverage-command-state-version-mismatch-${suffix}`,
          resultStateVersion: 2,
        }),
      ).rejects.toThrow(/stateVersion|result|safeResult/u);
      await expect(
        insertCommand({
          ...validRoutineCommands[2]!,
          clientRequestId: randomUUID(),
          id: `coverage-command-case-mismatch-${suffix}`,
          safeResult: {
            ...validRoutineCommands[2]!.safeResult,
            caseId: `other-${caseId}`,
          },
        }),
      ).rejects.toThrow(/caseId|result|safeResult/u);
      await expect(
        insertCommand({
          ...validRoutineCommands[3]!,
          clientRequestId: randomUUID(),
          id: `coverage-command-resolve-leaks-finance-rolls-${suffix}`,
          safeResult: { ...resolvedRecheck, financeRolls: [{ rollCode, positionId }] },
        }),
      ).rejects.toThrow(/financeRolls|safeResult|projection/u);
      await expect(
        insertCommand({
          ...validRoutineCommands[3]!,
          clientRequestId: randomUUID(),
          id: `coverage-command-resolve-missing-scope-${suffix}`,
          scopeCaseId: null,
        }),
      ).rejects.toThrow(/scopeCaseId|scope|command/u);
      await expect(
        insertCommand({
          ...validRoutineCommands[0]!,
          clientRequestId: randomUUID(),
          id: `coverage-command-finance-roll-extra-key-${suffix}`,
          safeResult: {
            ...finance,
            financeRolls: [{ rollCode, positionId, rollId }],
          },
        }),
      ).rejects.toThrow(/financeRolls|safeResult|projection/u);

      const crossResult = await createMinimalOrder(prisma, `${suffix}-cross-result`);
      const crossCalculationId = `coverage-command-cross-calculation-${suffix}`;
      await insertCalculation(prisma, {
        id: crossCalculationId,
        orderId: crossResult.orderId,
        inventoryEpoch: epoch,
        positionVersions: [{ positionId: crossResult.positionId, version: 1 }],
        availability: 'verified_full',
        reasonCodes: ['full_cover_available'],
        matchedRollCount: 1,
        verifiedCandidateRollIds: [rollId],
      });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_matches" (
           "id", "calculationId", "orderId", "generation", "positionId",
           "rollId", "coverageFactId", "slotIndex"
         ) VALUES ($1, $2, $3, 1, $4, $5, $6, 1)`,
        `coverage-command-cross-match-${suffix}`,
        crossCalculationId,
        crossResult.orderId,
        crossResult.positionId,
        rollId,
        factId,
      );
      const crossDecisionId = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_decisions" (
           "id", "orderId", "calculationId", "generation", "kind",
           "inputFingerprint", "sourceInventoryEpoch", "expectedRollCount",
           "actorKind", "actorRole", "actorId"
         ) VALUES (
           $1::uuid, $2, $3, 1, 'produce_all', $4, $5, 0,
           'user', 'finance'::"Role", $6
         )`,
        crossDecisionId,
        crossResult.orderId,
        crossCalculationId,
        HEX_A,
        epoch,
        crossResult.userId,
      );
      await expect(
        insertCommand({
          ...validRoutineCommands[0]!,
          clientRequestId: randomUUID(),
          id: `coverage-command-cross-order-result-${suffix}`,
          resultCalculationId: crossCalculationId,
        }),
      ).rejects.toThrow(/order|result/u);
      await expect(
        insertCommand({
          ...validRoutineCommands[1]!,
          clientRequestId: randomUUID(),
          id: `coverage-command-decide-cross-order-result-${suffix}`,
          resultDecisionId: crossDecisionId,
        }),
      ).rejects.toThrow(/decision|order|result/u);

      const recovery = await createMinimalOrder(prisma, `${suffix}-recovery`);
      const recoveryRolls = [
        {
          factId: `coverage-recovery-fact-a-${suffix}`,
          rollCode: `COVERAGE-RECOVERY-A-${suffix}`,
          rollId: `coverage-recovery-roll-a-${suffix}`,
        },
        {
          factId: `coverage-recovery-fact-b-${suffix}`,
          rollCode: `COVERAGE-RECOVERY-B-${suffix}`,
          rollId: `coverage-recovery-roll-b-${suffix}`,
        },
      ];
      for (const recoveryRoll of recoveryRolls) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_rolls" ("id", "rollCode", "warehouseStatus", "updatedAt")
           VALUES ($1, $2, 'received', CURRENT_TIMESTAMP)`,
          recoveryRoll.rollId,
          recoveryRoll.rollCode,
        );
        await insertBackfillFact(prisma, recoveryRoll);
        await prisma.$executeRawUnsafe(
          `UPDATE "warehouse_rolls" SET "currentCoverageFactId" = $1 WHERE "id" = $2`,
          recoveryRoll.factId,
          recoveryRoll.rollId,
        );
      }
      const [{ epoch: recoverySourceEpoch }] = await prisma.$queryRaw<Array<{ epoch: bigint }>>`
        SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1
      `;
      const recoveryCalculationId = `coverage-recovery-calculation-${suffix}`;
      await insertCalculation(prisma, {
        id: recoveryCalculationId,
        orderId: recovery.orderId,
        positionVersions: [{ positionId: recovery.positionId, version: 1 }],
        inventoryEpoch: recoverySourceEpoch,
        availability: 'verified_full',
        reasonCodes: ['full_cover_available'],
        requiredRollCount: 2,
        matchedRollCount: 2,
        verifiedCandidateRollIds: recoveryRolls.map(({ rollId }) => rollId),
      });
      for (const [index, recoveryRoll] of recoveryRolls.entries()) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_matches" (
             "id", "calculationId", "orderId", "generation", "positionId",
             "rollId", "coverageFactId", "slotIndex"
           ) VALUES ($1, $2, $3, 1, $4, $5, $6, $7)`,
          `coverage-recovery-match-${index + 1}-${suffix}`,
          recoveryCalculationId,
          recovery.orderId,
          recovery.positionId,
          recoveryRoll.rollId,
          recoveryRoll.factId,
          index + 1,
        );
      }
      const [{ calculatedAt: recoveryRefreshCalculatedAt }] = await prisma.$queryRaw<
        Array<{ calculatedAt: Date }>
      >`
        SELECT "calculatedAt"
        FROM "warehouse_coverage_calculations"
        WHERE id = ${recoveryCalculationId}
      `;
      await expect(
        insertCommand({
          id: `coverage-command-duplicate-finance-roll-${suffix}`,
          kind: 'refresh',
          orderId: recovery.orderId,
          resultCalculationId: recoveryCalculationId,
          resultKind: 'calculation',
          safeResult: financeProjection({
            calculatedAt: recoveryRefreshCalculatedAt!.toISOString(),
            matched: 2,
            positionId: recovery.positionId,
            required: 2,
            rollCodes: [recoveryRolls[0]!.rollCode, recoveryRolls[0]!.rollCode],
          }),
          safeResultKind: 'projection',
        }),
      ).rejects.toThrow(/financeRolls|exact|duplicate|projection/u);
      const recoveryDecisionId = randomUUID();
      const recoveryTaskId = `coverage-recovery-task-${suffix}`;
      await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(
          `UPDATE "warehouse_rolls"
           SET "reservedForOrderId" = $1, "reservedByCoverageDecisionId" = $2::uuid,
               "reservedAt" = now()
           WHERE "id" = ANY ($3::text[])`,
          recovery.orderId,
          recoveryDecisionId,
          recoveryRolls.map(({ rollId }) => rollId),
        );
        await transaction.$executeRawUnsafe(
          `INSERT INTO "warehouse_acceptance_tasks" (
             "id", "mode", "status", "orderId", "coverageDecisionId", "updatedAt"
           ) VALUES ($1, 'reserve', 'open', $2, $3::uuid, CURRENT_TIMESTAMP)`,
          recoveryTaskId,
          recovery.orderId,
          recoveryDecisionId,
        );
        for (const [index, recoveryRoll] of recoveryRolls.entries()) {
          await transaction.$executeRawUnsafe(
            `INSERT INTO "scan_rows" ("id", "taskId", "rollCode", "fromOrderId")
             VALUES ($1, $2, $3, $4)`,
            `coverage-recovery-scan-${index + 1}-${suffix}`,
            recoveryTaskId,
            recoveryRoll.rollCode,
            recovery.orderId,
          );
        }
        const [{ epoch: committedEpoch }] = await transaction.$queryRaw<
          Array<{ epoch: bigint }>
        >`SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1`;
        await transaction.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_decisions" (
             "id", "orderId", "calculationId", "generation", "kind",
             "inputFingerprint", "sourceInventoryEpoch", "committedInventoryEpoch",
             "expectedRollCount", "actorKind", "actorRole", "actorId"
           ) VALUES (
             $1::uuid, $2, $3, 1, 'use_warehouse', $4, $5, $6, 2,
             'user', 'finance'::"Role", $7
           )`,
          recoveryDecisionId,
          recovery.orderId,
          recoveryCalculationId,
          HEX_A,
          recoverySourceEpoch,
          committedEpoch,
          recovery.userId,
        );
      });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_states" (
           "orderId", "state", "stateVersion", "generation",
           "currentCalculationId", "currentDecisionId", "updatedAt"
         ) VALUES ($1, 'warehouse_reserved', 1, 1, $2, $3::uuid, CURRENT_TIMESTAMP)`,
        recovery.orderId,
        recoveryCalculationId,
        recoveryDecisionId,
      );
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "warehouse_rolls"
           SET "reservedForOrderId" = NULL, "reservedByCoverageDecisionId" = NULL,
               "reservedAt" = NULL
           WHERE "reservedByCoverageDecisionId" = $1::uuid`,
          recoveryDecisionId,
        ),
      ).rejects.toThrow(/physical|case|recovery|reservation|decision/u);
      const recoveryCaseId = `coverage-recovery-case-${suffix}`;
      const recoveryScope = `warehouse_coverage_v2:${recovery.orderId}`;
      const recoveryOpenScope = `${recoveryScope}:decision_linked_physical_exception`;
      const insertPhysicalCase = (input: {
        id: string;
        sourceDecisionId?: string | null;
      }): Promise<unknown> =>
        prisma.$executeRawUnsafe(
          `INSERT INTO "order_resolution_cases" (
             "id", "openScopeKey", "orderId", "type", "status", "ownerRole",
             "reason", "createdByRole", "coverageScope", "coverageOrigin",
             "sourceCoverageCalculationId", "sourceCoverageDecisionId",
             "sourceCoverageStateVersion", "updatedAt"
           ) VALUES (
             $1, $2, $3, 'warehouse_coverage_physical_exception', 'open',
             'warehouse'::"Role", 'Физическое расхождение', 'warehouse'::"Role",
             $4, 'decision_linked_physical_exception', $5, $6::uuid, 1,
             CURRENT_TIMESTAMP
           )`,
          input.id,
          recoveryOpenScope,
          recovery.orderId,
          recoveryScope,
          recoveryCalculationId,
          input.sourceDecisionId === undefined ? recoveryDecisionId : input.sourceDecisionId,
        );
      await expect(
        insertPhysicalCase({
          id: `coverage-recovery-case-missing-decision-${suffix}`,
          sourceDecisionId: null,
        }),
      ).rejects.toThrow(/case|physical|decision|coverage/u);
      await expect(
        insertPhysicalCase({
          id: `coverage-recovery-case-mismatched-decision-${suffix}`,
          sourceDecisionId: decisionId,
        }),
      ).rejects.toThrow(/case|physical|decision|order|coverage/u);
      await insertPhysicalCase({ id: recoveryCaseId });
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_recheck_memberships" (
             "id", "caseId", "orderId", "rollId", "sourceCalculationId",
             "sourceDecisionId", "sourceCoverageFactId", "sourceKind", "reasonCodes"
           ) VALUES (
             $1, $2, $3, $4, $5, $6::uuid, $7, 'decision_match',
             '["warehouse_recheck_pending"]'::jsonb
           )`,
          `coverage-recovery-wrong-decision-membership-${suffix}`,
          recoveryCaseId,
          recovery.orderId,
          recoveryRolls[0]!.rollId,
          recoveryCalculationId,
          decisionId,
          recoveryRolls[0]!.factId,
        ),
      ).rejects.toThrow(/decision|membership|case/u);
      for (const [index, recoveryRoll] of recoveryRolls.entries()) {
        await expect(
          prisma.$executeRawUnsafe(
            `INSERT INTO "warehouse_coverage_recheck_memberships" (
               "id", "caseId", "orderId", "rollId", "sourceCalculationId",
               "sourceDecisionId", "sourceCoverageFactId", "sourceKind", "reasonCodes"
             ) VALUES (
               $1, $2, $3, $4, $5, $6::uuid, $7, 'decision_match',
               '[]'::jsonb
             )`,
            `coverage-recovery-membership-${index + 1}-${suffix}`,
            recoveryCaseId,
            recovery.orderId,
            recoveryRoll.rollId,
            recoveryCalculationId,
            recoveryDecisionId,
            recoveryRoll.factId,
          ),
        ).resolves.toBeDefined();
      }
      const outsideRollId = `coverage-recovery-outside-roll-${suffix}`;
      const outsideRollCode = `COVERAGE-RECOVERY-OUTSIDE-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_rolls" ("id", "rollCode", "warehouseStatus", "updatedAt")
         VALUES ($1, $2, 'received', CURRENT_TIMESTAMP)`,
        outsideRollId,
        outsideRollCode,
      );
      const outsideFactId = `coverage-recovery-outside-fact-${suffix}`;
      await insertBackfillFact(prisma, {
        factId: outsideFactId,
        rollCode: outsideRollCode,
        rollId: outsideRollId,
      });
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_recheck_memberships" (
             "id", "caseId", "orderId", "rollId", "sourceCalculationId",
             "sourceDecisionId", "sourceCoverageFactId", "sourceKind", "reasonCodes"
           ) VALUES (
             $1, $2, $3, $4, $5, $6::uuid, $7, 'decision_match',
             '["warehouse_recheck_pending"]'::jsonb
           )`,
          `coverage-recovery-outside-membership-${suffix}`,
          recoveryCaseId,
          recovery.orderId,
          outsideRollId,
          recoveryCalculationId,
          recoveryDecisionId,
          outsideFactId,
        ),
      ).rejects.toThrow(/decision_match|membership|candidate/u);
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "warehouse_rolls"
           SET "reservedForOrderId" = NULL, "reservedByCoverageDecisionId" = NULL,
               "reservedAt" = NULL
           WHERE "id" = $1`,
          recoveryRolls[0]!.rollId,
        ),
      ).rejects.toThrow(/physical|recovery|reservation|decision/u);
      await expect(
        prisma.$transaction(async (transaction) => {
          await transaction.$executeRawUnsafe(
            `UPDATE "warehouse_rolls"
             SET "reservedForOrderId" = NULL, "reservedByCoverageDecisionId" = NULL,
                 "reservedAt" = NULL
             WHERE "id" = $1`,
            recoveryRolls[0]!.rollId,
          );
          await transaction.$executeRawUnsafe(
            `UPDATE "warehouse_acceptance_tasks"
             SET "status" = 'exception', "updatedAt" = CURRENT_TIMESTAMP
             WHERE "id" = $1`,
            recoveryTaskId,
          );
          await transaction.$executeRawUnsafe(
            `UPDATE "warehouse_coverage_states"
             SET "state" = 'recheck_requested', "stateVersion" = 2,
                 "currentDecisionId" = NULL
             WHERE "orderId" = $1 AND "stateVersion" = 1`,
            recovery.orderId,
          );
        }),
      ).rejects.toThrow(/exact|physical|recovery|reservation|decision/u);
      await expect(
        prisma.$queryRawUnsafe<
          Array<{
            reservedByCoverageDecisionId: string | null;
            reservedForOrderId: string | null;
          }>
        >(
          `SELECT "reservedByCoverageDecisionId", "reservedForOrderId"
           FROM "warehouse_rolls"
           WHERE "id" = ANY ($1::text[])
           ORDER BY "id"`,
          recoveryRolls.map(({ rollId }) => rollId),
        ),
      ).resolves.toEqual(
        recoveryRolls.map(() => ({
          reservedByCoverageDecisionId: recoveryDecisionId,
          reservedForOrderId: recovery.orderId,
        })),
      );
      const [{ calculatedAt: recoveryCalculatedAt }] = await prisma.$queryRaw<
        Array<{ calculatedAt: Date }>
      >`
        SELECT "calculatedAt"
        FROM "warehouse_coverage_calculations"
        WHERE id = ${recoveryCalculationId}
      `;
      const recoverySafeResult = {
        ...aggregateProjection({
          calculatedAt: recoveryCalculatedAt!.toISOString(),
          matched: 2,
          positionId: recovery.positionId,
          required: 2,
          state: 'recheck_requested',
          stateVersion: 2,
        }),
        availableActions: [],
        caseId: recoveryCaseId,
      };
      type CancelCommandInput = {
        actorId?: string | null;
        actorKind?: string;
        actorRole?: string | null;
        clientRequestId?: string;
        id: string;
        resultCaseId?: string | null;
        safeResult?: Record<string, unknown>;
        scopeTaskId?: string | null;
        systemActorKey?: string | null;
      };
      const insertCancelCommand = (
        executor: Pick<PrismaClient, '$executeRawUnsafe'>,
        input: CancelCommandInput,
      ): Promise<unknown> =>
        executor.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_commands" (
             "id", "clientRequestId", "kind", "orderId", "scopeTaskId",
             "requestFingerprint", "actorKind", "actorRole", "actorId", "systemActorKey",
             "safeResultKind", "safeResult", "resultKind", "resultCaseId",
             "resultGeneration", "resultStateVersion"
           ) VALUES (
             $1, $2::uuid, 'cancel_reservation', $3, $4, $5,
             $6, $7::"Role", $8, $9, 'projection_with_case', $10::jsonb,
             'recheck_case', $11, 1, 2
           )`,
          input.id,
          input.clientRequestId ?? randomUUID(),
          recovery.orderId,
          input.scopeTaskId === undefined ? recoveryTaskId : input.scopeTaskId,
          HEX_A,
          input.actorKind ?? 'system',
          input.actorRole ?? null,
          input.actorId ?? null,
          input.systemActorKey === undefined ? SYSTEM_ACTOR_KEY : input.systemActorKey,
          JSON.stringify(input.safeResult ?? recoverySafeResult),
          input.resultCaseId === undefined ? recoveryCaseId : input.resultCaseId,
        );
      const validCancelCommandId = `coverage-command-cancel-${suffix}`;
      await expect(
        prisma.$transaction(async (transaction) => {
          await transaction.$executeRawUnsafe(
            `UPDATE "warehouse_rolls"
             SET "reservedForOrderId" = NULL, "reservedByCoverageDecisionId" = NULL,
                 "reservedAt" = NULL
             WHERE "reservedByCoverageDecisionId" = $1::uuid`,
            recoveryDecisionId,
          );
          await transaction.$executeRawUnsafe(
            `UPDATE "warehouse_acceptance_tasks"
             SET "status" = 'exception', "updatedAt" = CURRENT_TIMESTAMP
             WHERE "id" = $1`,
            recoveryTaskId,
          );
          await transaction.$executeRawUnsafe(
            `UPDATE "warehouse_coverage_states"
             SET "state" = 'recheck_requested', "stateVersion" = 2,
                 "currentDecisionId" = NULL
             WHERE "orderId" = $1 AND "stateVersion" = 1`,
            recovery.orderId,
          );
          await insertCancelCommand(
            transaction as unknown as Pick<PrismaClient, '$executeRawUnsafe'>,
            {
              id: validCancelCommandId,
            },
          );
        }),
      ).resolves.toBeUndefined();
      await expect(
        prisma.$queryRawUnsafe<
          Array<{
            currentDecisionId: string | null;
            state: string;
            stateVersion: number;
            taskStatus: string;
          }>
        >(
          `SELECT
             state."currentDecisionId",
             state."state",
             state."stateVersion",
             task."status" AS "taskStatus"
           FROM "warehouse_coverage_states" AS state
           JOIN "warehouse_acceptance_tasks" AS task
             ON task."coverageDecisionId" = $2::uuid
           WHERE state."orderId" = $1`,
          recovery.orderId,
          recoveryDecisionId,
        ),
      ).resolves.toEqual([
        {
          currentDecisionId: null,
          state: 'recheck_requested',
          stateVersion: 2,
          taskStatus: 'exception',
        },
      ]);
      await expect(
        prisma.$queryRawUnsafe<
          Array<{
            reservedAt: Date | null;
            reservedByCoverageDecisionId: string | null;
            reservedForOrderId: string | null;
          }>
        >(
          `SELECT "reservedAt", "reservedByCoverageDecisionId", "reservedForOrderId"
           FROM "warehouse_rolls"
           WHERE "id" = ANY ($1::text[])
           ORDER BY "id"`,
          recoveryRolls.map(({ rollId }) => rollId),
        ),
      ).resolves.toEqual(
        recoveryRolls.map(() => ({
          reservedAt: null,
          reservedByCoverageDecisionId: null,
          reservedForOrderId: null,
        })),
      );
      await expect(
        insertCancelCommand(prisma, {
          id: `coverage-command-cancel-wrong-key-${suffix}`,
          systemActorKey: 'wrong_coverage_engine',
        }),
      ).rejects.toThrow(/actor|systemActorKey|command/u);
      await expect(
        insertCancelCommand(prisma, {
          actorId: warehouseUserId,
          actorKind: 'user',
          actorRole: 'warehouse',
          id: `coverage-command-cancel-user-${suffix}`,
          systemActorKey: null,
        }),
      ).rejects.toThrow(/actor|cancel|command/u);
      await expect(
        insertCancelCommand(prisma, {
          id: `coverage-command-cancel-missing-scope-${suffix}`,
          scopeTaskId: null,
        }),
      ).rejects.toThrow(/scopeTaskId|scope|cancel/u);
      await expect(
        insertCancelCommand(prisma, {
          id: `coverage-command-cancel-finance-rolls-${suffix}`,
          safeResult: {
            ...recoverySafeResult,
            financeRolls: recoveryRolls.map(({ rollCode }) => ({
              positionId: recovery.positionId,
              rollCode,
            })),
          },
        }),
      ).rejects.toThrow(/financeRolls|safeResult|projection/u);
      await expect(
        insertCancelCommand(prisma, {
          id: `coverage-command-cancel-case-mismatch-${suffix}`,
          safeResult: { ...recoverySafeResult, caseId },
        }),
      ).rejects.toThrow(/caseId|resultCaseId|safeResult/u);
      await prisma.$executeRawUnsafe(
        `UPDATE "order_resolution_cases"
         SET "status" = 'resolved', "openScopeKey" = NULL, "version" = 2,
             "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = $1`,
        recoveryCaseId,
      );
      await expect(
        insertCancelCommand(prisma, {
          id: `coverage-command-cancel-resolved-case-${suffix}`,
        }),
      ).rejects.toThrow(/case|open|lifecycle|result/u);
      const [{ epoch: recoveryResolveEpoch }] = await prisma.$queryRaw<
        Array<{ epoch: bigint }>
      >`SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1`;
      const recoveryResolveCalculationId = `coverage-recovery-resolve-calculation-${suffix}`;
      await insertCalculation(prisma, {
        id: recoveryResolveCalculationId,
        orderId: recovery.orderId,
        generation: 2,
        inventoryEpoch: recoveryResolveEpoch,
        positionVersions: [{ positionId: recovery.positionId, version: 1 }],
        availability: 'verified_full',
        reasonCodes: ['full_cover_available'],
        requiredRollCount: 2,
        matchedRollCount: 2,
        verifiedCandidateRollIds: recoveryRolls.map(({ rollId }) => rollId),
      });
      for (const [index, recoveryRoll] of recoveryRolls.entries()) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_matches" (
             "id", "calculationId", "orderId", "generation", "positionId",
             "rollId", "coverageFactId", "slotIndex"
           ) VALUES ($1, $2, $3, 2, $4, $5, $6, $7)`,
          `coverage-recovery-resolve-match-${index + 1}-${suffix}`,
          recoveryResolveCalculationId,
          recovery.orderId,
          recovery.positionId,
          recoveryRoll.rollId,
          recoveryRoll.factId,
          index + 1,
        );
      }
      await prisma.$executeRawUnsafe(
        `UPDATE "warehouse_coverage_states"
         SET "state" = 'awaiting_finance', "stateVersion" = 3, "generation" = 2,
             "currentCalculationId" = $1
         WHERE "orderId" = $2 AND "stateVersion" = 2`,
        recoveryResolveCalculationId,
        recovery.orderId,
      );
      const [{ calculatedAt: recoveryResolveCalculatedAt }] = await prisma.$queryRaw<
        Array<{ calculatedAt: Date }>
      >`
        SELECT "calculatedAt"
        FROM "warehouse_coverage_calculations"
        WHERE id = ${recoveryResolveCalculationId}
      `;
      const recoveryResolveProjection = aggregateProjection({
        calculatedAt: recoveryResolveCalculatedAt!.toISOString(),
        generation: 2,
        matched: 2,
        positionId: recovery.positionId,
        required: 2,
        stateVersion: 3,
      });
      recoveryResolveProjection.availableActions = [];
      await expect(
        insertCommand({
          actorId: warehouseUserId,
          actorRole: 'warehouse',
          id: `coverage-command-resolve-physical-case-${suffix}`,
          kind: 'resolve_recheck',
          orderId: recovery.orderId,
          resultCalculationId: recoveryResolveCalculationId,
          resultGeneration: 2,
          resultKind: 'calculation',
          resultStateVersion: 3,
          safeResult: recoveryResolveProjection,
          safeResultKind: 'projection',
          scopeCaseId: recoveryCaseId,
        }),
      ).resolves.toBeDefined();
      await expect(
        prisma.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM "warehouse_coverage_decisions" WHERE id = $1::uuid`,
          recoveryDecisionId,
        ),
      ).resolves.toEqual([{ id: recoveryDecisionId }]);
      await expect(
        prisma.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM "warehouse_coverage_commands" WHERE id = $1`,
          validCancelCommandId,
        ),
      ).resolves.toEqual([{ id: validCancelCommandId }]);

      const missingState = await createMinimalOrder(prisma, `${suffix}-missing-command-state`);
      const mismatchedCase = await createMinimalOrder(prisma, `${suffix}-mismatched-case-state`);
      const [{ epoch: commandRegressionEpoch }] = await prisma.$queryRaw<
        Array<{ epoch: bigint }>
      >`SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1`;
      const missingStateCalculationId = `coverage-command-missing-state-calculation-${suffix}`;
      const mismatchedCaseCalculationId = `coverage-command-mismatched-case-calculation-${suffix}`;
      for (const commandFixture of [
        {
          calculationId: missingStateCalculationId,
          orderId: missingState.orderId,
          positionId: missingState.positionId,
        },
        {
          calculationId: mismatchedCaseCalculationId,
          orderId: mismatchedCase.orderId,
          positionId: mismatchedCase.positionId,
        },
      ]) {
        await insertCalculation(prisma, {
          id: commandFixture.calculationId,
          orderId: commandFixture.orderId,
          inventoryEpoch: commandRegressionEpoch,
          availability: 'verified_full',
          positionVersions: [{ positionId: commandFixture.positionId, version: 1 }],
          reasonCodes: ['full_cover_available'],
          matchedRollCount: 1,
          verifiedCandidateRollIds: [rollId],
        });
        await prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_matches" (
             "id", "calculationId", "orderId", "generation", "positionId",
             "rollId", "coverageFactId", "slotIndex"
           ) VALUES ($1, $2, $3, 1, $4, $5, $6, 1)`,
          `${commandFixture.calculationId}-match`,
          commandFixture.calculationId,
          commandFixture.orderId,
          commandFixture.positionId,
          rollId,
          factId,
        );
      }
      const [{ calculatedAt: missingStateCalculatedAt }] = await prisma.$queryRaw<
        Array<{ calculatedAt: Date }>
      >`
        SELECT "calculatedAt"
        FROM "warehouse_coverage_calculations"
        WHERE "id" = ${missingStateCalculationId}
      `;
      const [{ calculatedAt: mismatchedCaseCalculatedAt }] = await prisma.$queryRaw<
        Array<{ calculatedAt: Date }>
      >`
        SELECT "calculatedAt"
        FROM "warehouse_coverage_calculations"
        WHERE "id" = ${mismatchedCaseCalculationId}
      `;
      const mismatchedCaseId = `coverage-command-mismatched-state-case-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_states" (
           "orderId", "state", "stateVersion", "generation",
           "currentCalculationId", "updatedAt"
         ) VALUES ($1, 'awaiting_finance', 1, 1, $2, CURRENT_TIMESTAMP)`,
        mismatchedCase.orderId,
        mismatchedCaseCalculationId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "order_resolution_cases" (
           "id", "openScopeKey", "orderId", "type", "status", "ownerRole",
           "reason", "createdByRole", "coverageScope", "coverageOrigin",
           "sourceCoverageCalculationId", "sourceCoverageStateVersion", "updatedAt"
         ) VALUES (
           $1, $2, $3, 'warehouse_coverage_recheck', 'open', 'warehouse'::"Role",
           'Перепроверить', 'finance'::"Role", $4, 'finance_request', $5, 1,
           CURRENT_TIMESTAMP
         )`,
        mismatchedCaseId,
        `warehouse_coverage_v2:${mismatchedCase.orderId}:finance_request`,
        mismatchedCase.orderId,
        `warehouse_coverage_v2:${mismatchedCase.orderId}`,
        mismatchedCaseCalculationId,
      );
      await prisma.$executeRawUnsafe(
        `UPDATE "warehouse_coverage_states"
         SET "state" = 'recheck_requested', "stateVersion" = 2
         WHERE "orderId" = $1 AND "stateVersion" = 1`,
        mismatchedCase.orderId,
      );
      await prisma.$executeRawUnsafe(
        `UPDATE "warehouse_coverage_states"
         SET "stateVersion" = 3
         WHERE "orderId" = $1 AND "stateVersion" = 2`,
        mismatchedCase.orderId,
      );
      const mismatchedCaseProjection = financeProjection({
        calculatedAt: mismatchedCaseCalculatedAt!.toISOString(),
        positionId: mismatchedCase.positionId,
        rollCodes: [rollCode],
        state: 'recheck_requested',
        stateVersion: 3,
      });
      mismatchedCaseProjection.availableActions = [];
      const commandStateResults = await Promise.allSettled([
        insertCommand({
          id: `coverage-command-without-state-${suffix}`,
          kind: 'refresh',
          orderId: missingState.orderId,
          resultCalculationId: missingStateCalculationId,
          resultKind: 'calculation',
          safeResult: financeProjection({
            calculatedAt: missingStateCalculatedAt!.toISOString(),
            positionId: missingState.positionId,
            rollCodes: [rollCode],
          }),
          safeResultKind: 'projection',
        }),
        insertCommand({
          id: `coverage-command-case-state-version-drift-${suffix}`,
          kind: 'request_recheck',
          orderId: mismatchedCase.orderId,
          resultCaseId: mismatchedCaseId,
          resultKind: 'recheck_case',
          resultStateVersion: 3,
          safeResult: { ...mismatchedCaseProjection, caseId: mismatchedCaseId },
          safeResultKind: 'projection_with_case',
        }),
      ]);
      expect(
        Object.fromEntries(
          ['missingState', 'caseStateVersionDrift'].map((label, index) => [
            label,
            commandStateResults[index]!.status,
          ]),
        ),
      ).toEqual({
        missingState: 'rejected',
        caseStateVersionDrift: 'rejected',
      });
    }, [{ label: 'warehouse coverage command client', run: () => prisma.$disconnect() }]);
  });

  it('whitelists only stale auto replacement, accepted auto clears and CAS state writes', async () => {
    const prisma = new PrismaClient();
    const suffix = createE2eSchemaName().split('_').at(-1) as string;
    await runE2eWithCleanup(async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_rolls" ("id", "rollCode", "warehouseStatus", "updatedAt")
         VALUES ($1, $2, 'received', CURRENT_TIMESTAMP)`,
        `coverage-state-epoch-seed-${suffix}`,
        `COVERAGE-STATE-EPOCH-SEED-${suffix}`,
      );
      const [{ epoch: currentEpoch }] = await prisma.$queryRaw<Array<{ epoch: bigint }>>`
        SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1
      `;
      expect(currentEpoch).toBeGreaterThan(0n);
      const staleEpoch = currentEpoch > 0n ? currentEpoch - 1n : 0n;
      const crossState = await createMinimalOrder(prisma, `${suffix}-cross-state`);
      const crossStateSource = await createMinimalOrder(prisma, `${suffix}-cross-state-source`);
      const crossStateCalculation = `coverage-state-cross-calculation-${suffix}`;
      await insertCalculation(prisma, {
        id: crossStateCalculation,
        orderId: crossStateSource.orderId,
        inventoryEpoch: currentEpoch,
        positionVersions: [{ positionId: crossStateSource.positionId, version: 1 }],
      });
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_states" (
             "orderId", "state", "stateVersion", "generation",
             "currentCalculationId", "updatedAt"
           ) VALUES ($1, 'awaiting_finance', 1, 1, $2, CURRENT_TIMESTAMP)`,
          crossState.orderId,
          crossStateCalculation,
        ),
      ).rejects.toThrow(/state|calculation|order/u);
      const insertDecision = async (input: {
        calculationId: string;
        generation: number;
        id: string;
        kind: 'auto_produce_all' | 'produce_all';
        orderId: string;
        sourceInventoryEpoch?: bigint;
        userId: string;
      }): Promise<void> => {
        const system = input.kind === 'auto_produce_all';
        await prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_decisions" (
             "id", "orderId", "calculationId", "generation", "kind",
             "inputFingerprint", "sourceInventoryEpoch", "expectedRollCount",
             "actorKind", "actorRole", "actorId", "systemActorKey"
           ) VALUES (
             $1::uuid, $2, $3, $4, $5, $6, $7, 0,
             $8, $9::"Role", $10, $11
           )`,
          input.id,
          input.orderId,
          input.calculationId,
          input.generation,
          input.kind,
          HEX_A,
          input.sourceInventoryEpoch ?? (input.generation === 1 ? staleEpoch : currentEpoch),
          system ? 'system' : 'user',
          system ? null : 'finance',
          system ? null : input.userId,
          system ? SYSTEM_ACTOR_KEY : null,
        );
      };
      const createAutoFixture = async (tag: string) => {
        const actor = await createMinimalOrder(prisma, `${suffix}-${tag}`);
        const calculationId = `coverage-state-${tag}-calculation-1-${suffix}`;
        await insertCalculation(prisma, {
          id: calculationId,
          orderId: actor.orderId,
          inventoryEpoch: staleEpoch,
          positionVersions: [{ positionId: actor.positionId, version: 1 }],
        });
        const decisionId = randomUUID();
        await insertDecision({
          calculationId,
          generation: 1,
          id: decisionId,
          kind: 'auto_produce_all',
          orderId: actor.orderId,
          userId: actor.userId,
        });
        await prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_states" (
             "orderId", "state", "stateVersion", "generation",
             "currentCalculationId", "currentDecisionId", "updatedAt"
           ) VALUES ($1, 'stale', 1, 1, $2, $3::uuid, CURRENT_TIMESTAMP)`,
          actor.orderId,
          calculationId,
          decisionId,
        );
        return { ...actor, calculationId, decisionId };
      };

      const replace = await createAutoFixture('replace');
      const replaceCalculation2 = `coverage-state-replace-calculation-2-${suffix}`;
      await insertCalculation(prisma, {
        id: replaceCalculation2,
        orderId: replace.orderId,
        generation: 2,
        inventoryEpoch: currentEpoch,
        positionVersions: [{ positionId: replace.positionId, version: 1 }],
      });
      const replaceDecision2 = randomUUID();
      await insertDecision({
        calculationId: replaceCalculation2,
        generation: 2,
        id: replaceDecision2,
        kind: 'auto_produce_all',
        orderId: replace.orderId,
        userId: replace.userId,
      });
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "warehouse_coverage_states"
           SET "state" = 'production_required', "stateVersion" = 2, "generation" = 2,
               "currentCalculationId" = $1, "currentDecisionId" = $2::uuid
           WHERE "orderId" = $3 AND "stateVersion" = 1`,
          replaceCalculation2,
          replaceDecision2,
          replace.orderId,
        ),
      ).resolves.toBeDefined();

      const fresh = await createMinimalOrder(prisma, `${suffix}-fresh-auto-clear`);
      const freshCalculation1 = `coverage-state-fresh-calculation-1-${suffix}`;
      await insertCalculation(prisma, {
        id: freshCalculation1,
        orderId: fresh.orderId,
        inventoryEpoch: currentEpoch,
        positionVersions: [{ positionId: fresh.positionId, version: 1 }],
      });
      const freshDecision1 = randomUUID();
      await insertDecision({
        calculationId: freshCalculation1,
        generation: 1,
        id: freshDecision1,
        kind: 'auto_produce_all',
        orderId: fresh.orderId,
        sourceInventoryEpoch: currentEpoch,
        userId: fresh.userId,
      });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_states" (
           "orderId", "state", "stateVersion", "generation",
           "currentCalculationId", "currentDecisionId", "updatedAt"
         ) VALUES ($1, 'production_required', 1, 1, $2, $3::uuid, CURRENT_TIMESTAMP)`,
        fresh.orderId,
        freshCalculation1,
        freshDecision1,
      );
      const freshCalculation2 = `coverage-state-fresh-calculation-2-${suffix}`;
      await insertCalculation(prisma, {
        id: freshCalculation2,
        orderId: fresh.orderId,
        generation: 2,
        inventoryEpoch: currentEpoch,
        positionVersions: [{ positionId: fresh.positionId, version: 1 }],
        availability: 'unknown',
        reasonCodes: ['roll_facts_incomplete'],
      });
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "warehouse_coverage_states"
           SET "state" = 'unknown', "stateVersion" = 2, "generation" = 2,
               "currentCalculationId" = $1, "currentDecisionId" = NULL
           WHERE "orderId" = $2 AND "stateVersion" = 1`,
          freshCalculation2,
          fresh.orderId,
        ),
      ).rejects.toThrow(/stale|auto|state/u);

      const unknown = await createAutoFixture('unknown');
      const unknownCalculation2 = `coverage-state-unknown-calculation-2-${suffix}`;
      await insertCalculation(prisma, {
        id: unknownCalculation2,
        orderId: unknown.orderId,
        generation: 2,
        inventoryEpoch: currentEpoch,
        positionVersions: [{ positionId: unknown.positionId, version: 1 }],
        availability: 'unknown',
        reasonCodes: ['roll_facts_incomplete'],
      });
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "warehouse_coverage_states"
           SET "state" = 'unknown', "stateVersion" = 2, "generation" = 2,
               "currentCalculationId" = $1, "currentDecisionId" = NULL
           WHERE "orderId" = $2 AND "stateVersion" = 1`,
          unknownCalculation2,
          unknown.orderId,
        ),
      ).resolves.toBeDefined();

      const recheck = await createAutoFixture('recheck');
      await prisma.$executeRawUnsafe(
        `INSERT INTO "order_resolution_cases" (
           "id", "openScopeKey", "orderId", "type", "status", "ownerRole",
           "reason", "createdByRole", "coverageScope", "coverageOrigin",
           "sourceCoverageCalculationId", "sourceCoverageStateVersion", "updatedAt"
         ) VALUES (
           $1, $2, $3, 'warehouse_coverage_recheck', 'open', 'warehouse'::"Role",
           'Финансовая перепроверка', 'finance'::"Role", $4, 'finance_request', $5, 1,
           CURRENT_TIMESTAMP
         )`,
        `coverage-state-recheck-case-${suffix}`,
        `warehouse_coverage_v2:${recheck.orderId}:finance_request`,
        recheck.orderId,
        `warehouse_coverage_v2:${recheck.orderId}`,
        recheck.calculationId,
      );
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "warehouse_coverage_states"
           SET "state" = 'recheck_requested', "stateVersion" = 2,
               "currentDecisionId" = NULL
           WHERE "orderId" = $1 AND "stateVersion" = 1`,
          recheck.orderId,
        ),
      ).resolves.toBeDefined();

      const verified = await createAutoFixture('verified-full');
      const verifiedRollId = `coverage-state-verified-roll-${suffix}`;
      const verifiedRollCode = `COVERAGE-STATE-VERIFIED-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_rolls" ("id", "rollCode", "warehouseStatus", "updatedAt")
         VALUES ($1, $2, 'received', CURRENT_TIMESTAMP)`,
        verifiedRollId,
        verifiedRollCode,
      );
      const verifiedFactId = `coverage-state-verified-fact-${suffix}`;
      await insertBackfillFact(prisma, {
        factId: verifiedFactId,
        rollCode: verifiedRollCode,
        rollId: verifiedRollId,
      });
      await prisma.$executeRawUnsafe(
        `UPDATE "warehouse_rolls" SET "currentCoverageFactId" = $1 WHERE "id" = $2`,
        verifiedFactId,
        verifiedRollId,
      );
      const [{ epoch: epochAfterVerifiedRoll }] = await prisma.$queryRaw<
        Array<{ epoch: bigint }>
      >`SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1`;
      const verifiedCalculation2 = `coverage-state-verified-calculation-2-${suffix}`;
      await insertCalculation(prisma, {
        id: verifiedCalculation2,
        orderId: verified.orderId,
        generation: 2,
        inventoryEpoch: epochAfterVerifiedRoll,
        positionVersions: [{ positionId: verified.positionId, version: 1 }],
        availability: 'verified_full',
        reasonCodes: ['full_cover_available'],
        requiredRollCount: 1,
        matchedRollCount: 1,
        verifiedCandidateRollIds: [verifiedRollId],
      });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_matches" (
           "id", "calculationId", "orderId", "generation", "positionId",
           "rollId", "coverageFactId", "slotIndex"
         ) VALUES ($1, $2, $3, 2, $4, $5, $6, 1)`,
        `coverage-state-verified-match-${suffix}`,
        verifiedCalculation2,
        verified.orderId,
        verified.positionId,
        verifiedRollId,
        verifiedFactId,
      );
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "warehouse_coverage_states"
           SET "state" = 'awaiting_finance', "stateVersion" = 2, "generation" = 2,
               "currentCalculationId" = $1, "currentDecisionId" = NULL
           WHERE "orderId" = $2 AND "stateVersion" = 1`,
          verifiedCalculation2,
          verified.orderId,
        ),
      ).resolves.toBeDefined();

      const explicit = await createMinimalOrder(prisma, `${suffix}-explicit`);
      const explicitCalculation = `coverage-state-explicit-calculation-${suffix}`;
      await insertCalculation(prisma, {
        id: explicitCalculation,
        orderId: explicit.orderId,
        inventoryEpoch: epochAfterVerifiedRoll,
        positionVersions: [{ positionId: explicit.positionId, version: 1 }],
        availability: 'verified_full',
        reasonCodes: ['full_cover_available'],
        matchedRollCount: 1,
        verifiedCandidateRollIds: [verifiedRollId],
      });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_matches" (
           "id", "calculationId", "orderId", "generation", "positionId",
           "rollId", "coverageFactId", "slotIndex"
         ) VALUES ($1, $2, $3, 1, $4, $5, $6, 1)`,
        `coverage-state-explicit-match-${suffix}`,
        explicitCalculation,
        explicit.orderId,
        explicit.positionId,
        verifiedRollId,
        verifiedFactId,
      );
      const explicitDecision = randomUUID();
      await insertDecision({
        calculationId: explicitCalculation,
        generation: 1,
        id: explicitDecision,
        kind: 'produce_all',
        orderId: explicit.orderId,
        sourceInventoryEpoch: epochAfterVerifiedRoll,
        userId: explicit.userId,
      });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_states" (
           "orderId", "state", "stateVersion", "generation",
           "currentCalculationId", "currentDecisionId", "updatedAt"
         ) VALUES ($1, 'production_required', 1, 1, $2, $3::uuid, CURRENT_TIMESTAMP)`,
        explicit.orderId,
        explicitCalculation,
        explicitDecision,
      );
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "warehouse_coverage_states"
           SET "stateVersion" = 2, "currentDecisionId" = NULL
           WHERE "orderId" = $1 AND "stateVersion" = 1`,
          explicit.orderId,
        ),
      ).rejects.toThrow(/terminal|state|decision/u);
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "warehouse_coverage_states"
           SET "stateVersion" = 3
           WHERE "orderId" = $1 AND "stateVersion" = 1`,
          explicit.orderId,
        ),
      ).rejects.toThrow(/stateVersion|CAS|state/u);

      const postAuto = await createAutoFixture('post-auto');
      await prisma.$executeRawUnsafe(
        `INSERT INTO "production_orders" (
           "id", "commercialOrderId", "sourceCoverageCalculationId",
           "sourceCoverageDecisionId", "sourceCoverageInputFingerprint",
           "sourceCoverageGeneration", "updatedAt"
         ) VALUES ($1, $2, $3, $4::uuid, $5, 1, CURRENT_TIMESTAMP)`,
        `coverage-state-production-${suffix}`,
        postAuto.orderId,
        postAuto.calculationId,
        postAuto.decisionId,
        HEX_A,
      );
      const postCalculation2 = `coverage-state-post-auto-calculation-2-${suffix}`;
      await insertCalculation(prisma, {
        id: postCalculation2,
        orderId: postAuto.orderId,
        generation: 2,
        inventoryEpoch: epochAfterVerifiedRoll,
        positionVersions: [{ positionId: postAuto.positionId, version: 1 }],
      });
      const postDecision2 = randomUUID();
      await insertDecision({
        calculationId: postCalculation2,
        generation: 2,
        id: postDecision2,
        kind: 'auto_produce_all',
        orderId: postAuto.orderId,
        sourceInventoryEpoch: epochAfterVerifiedRoll,
        userId: postAuto.userId,
      });
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "warehouse_coverage_states"
           SET "stateVersion" = 2, "generation" = 2,
               "currentCalculationId" = $1, "currentDecisionId" = $2::uuid
           WHERE "orderId" = $3 AND "stateVersion" = 1`,
          postCalculation2,
          postDecision2,
          postAuto.orderId,
        ),
      ).rejects.toThrow(/production|terminal|state/u);
    }, [{ label: 'warehouse coverage state client', run: () => prisma.$disconnect() }]);
  });

  it('keeps workflow version immutable and enforces all-or-none production and reservation provenance', async () => {
    const prisma = new PrismaClient();
    const suffix = createE2eSchemaName().split('_').at(-1) as string;
    await runE2eWithCleanup(async () => {
      const invalidWorkflowCounterparty = `coverage-invalid-workflow-counterparty-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "counterparties" ("id", "displayName") VALUES ($1, $1)`,
        invalidWorkflowCounterparty,
      );
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "commercial_orders" (
             "id", "orderNumber", "creatorRole", "counterpartyId",
             "warehouseCoverageWorkflowVersion", "updatedAt"
           ) VALUES ($1, $2, 'commercial'::"Role", $3, 3, CURRENT_TIMESTAMP)`,
          `coverage-invalid-workflow-order-${suffix}`,
          `COVERAGE-INVALID-WORKFLOW-${suffix}`,
          invalidWorkflowCounterparty,
        ),
      ).rejects.toThrow(/workflow|check/u);
      const legacy = await createMinimalOrder(prisma, `${suffix}-legacy`, 1);
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "production_orders" ("id", "commercialOrderId", "updatedAt")
           VALUES ($1, $2, CURRENT_TIMESTAMP)`,
          `coverage-legacy-production-${suffix}`,
          legacy.orderId,
        ),
      ).resolves.toBeDefined();
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "commercial_orders"
           SET "warehouseCoverageWorkflowVersion" = 2
           WHERE "id" = $1`,
          legacy.orderId,
        ),
      ).rejects.toThrow(/workflow|immutable/u);

      const v2 = await createMinimalOrder(prisma, `${suffix}-v2`);
      const [{ epoch }] = await prisma.$queryRaw<Array<{ epoch: bigint }>>`
        SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1
      `;
      const missingDecisionRollId = `coverage-v2-missing-decision-roll-${suffix}`;
      const missingDecisionRollCode = `COVERAGE-V2-MISSING-DECISION-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_rolls" ("id", "rollCode", "warehouseStatus", "updatedAt")
         VALUES ($1, $2, 'received', CURRENT_TIMESTAMP)`,
        missingDecisionRollId,
        missingDecisionRollCode,
      );
      const missingDecisionFactId = `coverage-v2-missing-decision-fact-${suffix}`;
      await insertBackfillFact(prisma, {
        factId: missingDecisionFactId,
        rollCode: missingDecisionRollCode,
        rollId: missingDecisionRollId,
      });
      await prisma.$executeRawUnsafe(
        `UPDATE "warehouse_rolls" SET "currentCoverageFactId" = $1 WHERE "id" = $2`,
        missingDecisionFactId,
        missingDecisionRollId,
      );
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "warehouse_rolls"
           SET "reservedForOrderId" = $1, "reservedForPositionId" = $2,
               "reservedAt" = CURRENT_TIMESTAMP
           WHERE "id" = $3`,
          v2.orderId,
          v2.positionId,
          missingDecisionRollId,
        ),
      ).rejects.toThrow(/decision|provenance|reservation|workflow/u);
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_acceptance_tasks" (
             "id", "mode", "status", "orderId", "updatedAt"
           ) VALUES ($1, 'reserve', 'open', $2, CURRENT_TIMESTAMP)`,
          `coverage-v2-missing-decision-task-${suffix}`,
          v2.orderId,
        ),
      ).rejects.toThrow(/decision|provenance|reserve|workflow/u);

      const legacyWithProvenance = await createMinimalOrder(
        prisma,
        `${suffix}-legacy-provenance`,
        1,
      );
      const legacyCalculationId = `coverage-legacy-provenance-calculation-${suffix}`;
      await insertCalculation(prisma, {
        id: legacyCalculationId,
        orderId: legacyWithProvenance.orderId,
        inventoryEpoch: epoch,
        positionVersions: [{ positionId: legacyWithProvenance.positionId, version: 1 }],
      });
      const legacyDecisionId = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_decisions" (
           "id", "orderId", "calculationId", "generation", "kind",
           "inputFingerprint", "sourceInventoryEpoch", "expectedRollCount",
           "actorKind", "systemActorKey"
         ) VALUES (
           $1::uuid, $2, $3, 1, 'auto_produce_all', $4, $5, 0,
           'system', $6
         )`,
        legacyDecisionId,
        legacyWithProvenance.orderId,
        legacyCalculationId,
        HEX_A,
        epoch,
        SYSTEM_ACTOR_KEY,
      );
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "production_orders" (
             "id", "commercialOrderId", "sourceCoverageCalculationId",
             "sourceCoverageDecisionId", "sourceCoverageInputFingerprint",
             "sourceCoverageGeneration", "updatedAt"
           ) VALUES ($1, $2, $3, $4::uuid, $5, 1, CURRENT_TIMESTAMP)`,
          `coverage-v1-provenance-production-${suffix}`,
          legacyWithProvenance.orderId,
          legacyCalculationId,
          legacyDecisionId,
          HEX_A,
        ),
      ).rejects.toThrow(/workflow|coverage|provenance/u);
      const calculationId = `coverage-provenance-calculation-${suffix}`;
      await insertCalculation(prisma, {
        id: calculationId,
        orderId: v2.orderId,
        inventoryEpoch: epoch,
        positionVersions: [{ positionId: v2.positionId, version: 1 }],
      });
      const decisionId = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_decisions" (
           "id", "orderId", "calculationId", "generation", "kind",
           "inputFingerprint", "sourceInventoryEpoch", "expectedRollCount",
           "actorKind", "systemActorKey"
         ) VALUES (
           $1::uuid, $2, $3, 1, 'auto_produce_all', $4, $5, 0,
           'system', $6
         )`,
        decisionId,
        v2.orderId,
        calculationId,
        HEX_A,
        epoch,
        SYSTEM_ACTOR_KEY,
      );
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "production_orders" (
             "id", "commercialOrderId", "sourceCoverageCalculationId",
             "sourceCoverageDecisionId", "sourceCoverageInputFingerprint",
             "sourceCoverageGeneration", "updatedAt"
           ) VALUES ($1, $2, $3, $4::uuid, $5, 1, CURRENT_TIMESTAMP)`,
          `coverage-v2-production-${suffix}`,
          v2.orderId,
          calculationId,
          decisionId,
          HEX_A,
        ),
      ).resolves.toBeDefined();

      const partial = await createMinimalOrder(prisma, `${suffix}-partial`);
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "production_orders" ("id", "commercialOrderId", "updatedAt")
           VALUES ($1, $2, CURRENT_TIMESTAMP)`,
          `coverage-v2-null-production-${suffix}`,
          partial.orderId,
        ),
      ).rejects.toThrow(/coverage|provenance|workflow/u);
      const partialCalculationId = `coverage-partial-calculation-${suffix}`;
      await insertCalculation(prisma, {
        id: partialCalculationId,
        orderId: partial.orderId,
        inventoryEpoch: epoch,
        positionVersions: [{ positionId: partial.positionId, version: 1 }],
      });
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "production_orders" (
             "id", "commercialOrderId", "sourceCoverageCalculationId", "updatedAt"
           ) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
          `coverage-partial-production-${suffix}`,
          partial.orderId,
          partialCalculationId,
        ),
      ).rejects.toThrow(/coverage|provenance/u);
      const partialDecisionId = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_decisions" (
           "id", "orderId", "calculationId", "generation", "kind",
           "inputFingerprint", "sourceInventoryEpoch", "expectedRollCount",
           "actorKind", "systemActorKey"
         ) VALUES (
           $1::uuid, $2, $3, 1, 'auto_produce_all', $4, $5, 0,
           'system', $6
         )`,
        partialDecisionId,
        partial.orderId,
        partialCalculationId,
        HEX_A,
        epoch,
        SYSTEM_ACTOR_KEY,
      );
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "production_orders" (
             "id", "commercialOrderId", "sourceCoverageCalculationId",
             "sourceCoverageDecisionId", "sourceCoverageInputFingerprint",
             "sourceCoverageGeneration", "updatedAt"
           ) VALUES ($1, $2, $3, $4::uuid, $5, 1, CURRENT_TIMESTAMP)`,
          `coverage-fingerprint-production-${suffix}`,
          partial.orderId,
          partialCalculationId,
          partialDecisionId,
          HEX_B,
        ),
      ).rejects.toThrow(/fingerprint|coverage|provenance/u);
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "production_orders" (
             "id", "commercialOrderId", "sourceCoverageCalculationId",
             "sourceCoverageDecisionId", "sourceCoverageInputFingerprint",
             "sourceCoverageGeneration", "updatedAt"
           ) VALUES ($1, $2, $3, $4::uuid, $5, 2, CURRENT_TIMESTAMP)`,
          `coverage-generation-production-${suffix}`,
          partial.orderId,
          partialCalculationId,
          partialDecisionId,
          HEX_A,
        ),
      ).rejects.toThrow(/generation|coverage|provenance/u);
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "production_orders" (
             "id", "commercialOrderId", "sourceCoverageCalculationId",
             "sourceCoverageDecisionId", "sourceCoverageInputFingerprint",
             "sourceCoverageGeneration", "updatedAt"
           ) VALUES ($1, $2, $3, $4::uuid, $5, 1, CURRENT_TIMESTAMP)`,
          `coverage-cross-order-production-${suffix}`,
          partial.orderId,
          calculationId,
          decisionId,
          HEX_A,
        ),
      ).rejects.toThrow(/coverage|order|provenance/u);

      const warehouseDecisionOrder = await createMinimalOrder(
        prisma,
        `${suffix}-warehouse-decision`,
      );
      const rollId = `coverage-mixed-provenance-roll-${suffix}`;
      const rollCode = `COVERAGE-MIXED-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_rolls" ("id", "rollCode", "warehouseStatus", "updatedAt")
         VALUES ($1, $2, 'received', CURRENT_TIMESTAMP)`,
        rollId,
        rollCode,
      );
      const warehouseFactId = `coverage-mixed-provenance-fact-${suffix}`;
      await insertBackfillFact(prisma, {
        factId: warehouseFactId,
        rollCode,
        rollId,
      });
      await prisma.$executeRawUnsafe(
        `UPDATE "warehouse_rolls" SET "currentCoverageFactId" = $1 WHERE "id" = $2`,
        warehouseFactId,
        rollId,
      );
      const [{ epoch: warehouseDecisionSourceEpoch }] = await prisma.$queryRaw<
        Array<{ epoch: bigint }>
      >`SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1`;
      const warehouseCalculationId = `coverage-mixed-provenance-calculation-${suffix}`;
      await insertCalculation(prisma, {
        id: warehouseCalculationId,
        orderId: warehouseDecisionOrder.orderId,
        inventoryEpoch: warehouseDecisionSourceEpoch,
        positionVersions: [{ positionId: warehouseDecisionOrder.positionId, version: 1 }],
        availability: 'verified_full',
        reasonCodes: ['full_cover_available'],
        requiredRollCount: 1,
        matchedRollCount: 1,
        verifiedCandidateRollIds: [rollId],
      });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_coverage_matches" (
           "id", "calculationId", "orderId", "generation", "positionId",
           "rollId", "coverageFactId", "slotIndex"
         ) VALUES ($1, $2, $3, 1, $4, $5, $6, 1)`,
        `coverage-mixed-provenance-match-${suffix}`,
        warehouseCalculationId,
        warehouseDecisionOrder.orderId,
        warehouseDecisionOrder.positionId,
        rollId,
        warehouseFactId,
      );
      const warehouseDecisionId = randomUUID();
      const warehouseTaskId = `coverage-mixed-provenance-task-${suffix}`;
      await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(
          `UPDATE "warehouse_rolls"
           SET "reservedForOrderId" = $1, "reservedForPositionId" = $2,
               "reservedByCoverageDecisionId" = $3::uuid, "reservedAt" = CURRENT_TIMESTAMP
           WHERE "id" = $4`,
          warehouseDecisionOrder.orderId,
          warehouseDecisionOrder.positionId,
          warehouseDecisionId,
          rollId,
        );
        await transaction.$executeRawUnsafe(
          `INSERT INTO "warehouse_acceptance_tasks" (
             "id", "mode", "status", "orderId", "coverageDecisionId", "updatedAt"
           ) VALUES ($1, 'reserve', 'open', $2, $3::uuid, CURRENT_TIMESTAMP)`,
          warehouseTaskId,
          warehouseDecisionOrder.orderId,
          warehouseDecisionId,
        );
        await transaction.$executeRawUnsafe(
          `INSERT INTO "scan_rows" ("id", "taskId", "rollCode", "fromOrderId")
           VALUES ($1, $2, $3, $4)`,
          `coverage-mixed-provenance-scan-${suffix}`,
          warehouseTaskId,
          rollCode,
          warehouseDecisionOrder.orderId,
        );
        const [{ epoch: committedEpoch }] = await transaction.$queryRaw<
          Array<{ epoch: bigint }>
        >`SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1`;
        await transaction.$executeRawUnsafe(
          `INSERT INTO "warehouse_coverage_decisions" (
             "id", "orderId", "calculationId", "generation", "kind",
             "inputFingerprint", "sourceInventoryEpoch", "committedInventoryEpoch",
             "expectedRollCount", "actorKind", "actorRole", "actorId"
           ) VALUES (
             $1::uuid, $2, $3, 1, 'use_warehouse', $4, $5, $6, 1,
             'user', 'finance'::"Role", $7
           )`,
          warehouseDecisionId,
          warehouseDecisionOrder.orderId,
          warehouseCalculationId,
          HEX_A,
          warehouseDecisionSourceEpoch,
          committedEpoch,
          warehouseDecisionOrder.userId,
        );
      });
      const proposalId = `coverage-proposal-${suffix}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_cover_proposals" (
           "id", "orderId", "positionId", "coverType", "coverQty",
           "reserveQty", "productionQty", "status", "updatedAt"
        ) VALUES (
           $1, $2, $3, 'full', 1, 1, 0, 'full_proposed', CURRENT_TIMESTAMP
         )`,
        proposalId,
        warehouseDecisionOrder.orderId,
        warehouseDecisionOrder.positionId,
      );
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "warehouse_rolls" SET "reservedByProposalId" = $1 WHERE "id" = $2`,
          proposalId,
          rollId,
        ),
      ).rejects.toThrow(/proposal|decision|provenance|reserve/u);
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "warehouse_acceptance_tasks"
           SET "mode" = 'receiving', "updatedAt" = CURRENT_TIMESTAMP
           WHERE "id" = $1`,
          warehouseTaskId,
        ),
      ).rejects.toThrow(/mode|decision|coverage/u);
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "warehouse_acceptance_tasks"
           SET "proposalId" = $1, "updatedAt" = CURRENT_TIMESTAMP
           WHERE "id" = $2`,
          proposalId,
          warehouseTaskId,
        ),
      ).rejects.toThrow(/proposal|decision|provenance|coverage/u);
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "production_orders" (
             "id", "commercialOrderId", "sourceCoverageCalculationId",
             "sourceCoverageDecisionId", "sourceCoverageInputFingerprint",
             "sourceCoverageGeneration", "updatedAt"
           ) VALUES ($1, $2, $3, $4::uuid, $5, 1, CURRENT_TIMESTAMP)`,
          `coverage-use-warehouse-production-${suffix}`,
          warehouseDecisionOrder.orderId,
          warehouseCalculationId,
          warehouseDecisionId,
          HEX_A,
        ),
      ).rejects.toThrow(/decision|production|coverage|provenance/u);
    }, [{ label: 'warehouse coverage provenance client', run: () => prisma.$disconnect() }]);
  });

  it('preserves V1 rows and treats a second target deploy as a no-op', async () => {
    expect(existsSync(TARGET_MIGRATION_PATH)).toBe(true);
    const schema = createE2eSchemaName();
    const suffix = schema.split('_').at(-1) as string;
    const databaseUrl = databaseUrlForSchema(schema);
    const project = copyPredecessorProject();
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    await runE2eWithCleanup(
      async () => {
        deploy(project, databaseUrl, 'Warehouse coverage engine predecessor deploy');
        const counterpartyId = `coverage-upgrade-counterparty-${suffix}`;
        const orderId = `coverage-upgrade-order-${suffix}`;
        await prisma.$executeRawUnsafe(
          `INSERT INTO "counterparties" ("id", "displayName") VALUES ($1, $2)`,
          counterpartyId,
          counterpartyId,
        );
        await prisma.$executeRawUnsafe(
          `INSERT INTO "commercial_orders" (
             "id", "orderNumber", "creatorRole", "counterpartyId", "updatedAt"
           ) VALUES ($1, $2, 'commercial'::"Role", $3, CURRENT_TIMESTAMP)`,
          orderId,
          `COVERAGE-UPGRADE-${suffix}`,
          counterpartyId,
        );
        await prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_rolls" (
             "id", "rollCode", "warehouseStatus", "reservedForOrderId",
             "reservedAt", "updatedAt"
           ) VALUES ($1, $2, 'received', $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          `coverage-upgrade-roll-${suffix}`,
          `COVERAGE-UPGRADE-ROLL-${suffix}`,
          orderId,
        );
        await prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_acceptance_tasks" (
             "id", "mode", "status", "orderId", "updatedAt"
           ) VALUES ($1, 'receiving', 'open', $2, CURRENT_TIMESTAMP)`,
          `coverage-upgrade-task-${suffix}`,
          orderId,
        );
        await prisma.$executeRawUnsafe(
          `INSERT INTO "production_orders" ("id", "commercialOrderId", "updatedAt")
           VALUES ($1, $2, CURRENT_TIMESTAMP)`,
          `coverage-upgrade-production-${suffix}`,
          orderId,
        );
        await prisma.$executeRawUnsafe(
          `INSERT INTO "order_resolution_cases" (
             "id", "openScopeKey", "orderId", "type", "ownerRole", "reason",
             "createdByRole", "version", "updatedAt"
           ) VALUES ($1, $2, $3, 'legacy', 'commercial'::"Role", 'legacy',
             'commercial'::"Role", 7, CURRENT_TIMESTAMP)`,
          `coverage-upgrade-case-${suffix}`,
          `legacy:coverage-upgrade:${suffix}`,
          orderId,
        );

        addTargetMigration(project);
        deploy(project, databaseUrl, 'Warehouse coverage engine upgrade');
        const migrationLedgerAfterFirstDeploy = await prisma.$queryRaw<
          Array<{ checksum: string; finishedAt: Date; migrationName: string }>
        >`
          SELECT
            checksum,
            finished_at AS "finishedAt",
            migration_name AS "migrationName"
          FROM "_prisma_migrations"
          ORDER BY migration_name
        `;
        deploy(project, databaseUrl, 'Warehouse coverage engine second deploy');
        expect(
          await prisma.$queryRaw<
            Array<{ checksum: string; finishedAt: Date; migrationName: string }>
          >`
            SELECT
              checksum,
              finished_at AS "finishedAt",
              migration_name AS "migrationName"
            FROM "_prisma_migrations"
            ORDER BY migration_name
          `,
        ).toEqual(migrationLedgerAfterFirstDeploy);

        const legacy = await prisma.$queryRawUnsafe<
          Array<{
            caseCoverageOrigin: string | null;
            caseCoverageScope: string | null;
            caseOpenScopeKey: string | null;
            caseSourceCalculationId: string | null;
            caseSourceDecisionId: string | null;
            caseSourceStateVersion: number | null;
            caseStatus: string;
            caseType: string;
            caseVersion: number;
            currentCoverageFactId: string | null;
            productionId: string;
            productionSourceCalculationId: string | null;
            productionSourceDecisionId: string | null;
            productionSourceGeneration: number | null;
            productionSourceInputFingerprint: string | null;
            reservedAt: Date | null;
            reservedByCoverageDecisionId: string | null;
            reservedForOrderId: string | null;
            taskCoverageDecisionId: string | null;
            taskMode: string;
            taskOrderId: string | null;
            taskStatus: string;
            warehouseCoverageWorkflowVersion: number;
            warehouseStatus: string;
          }>
        >(
          `SELECT "warehouseCoverageWorkflowVersion"
             , warehouse_roll."currentCoverageFactId" AS "currentCoverageFactId"
             , warehouse_roll."warehouseStatus" AS "warehouseStatus"
             , warehouse_roll."reservedForOrderId" AS "reservedForOrderId"
             , warehouse_roll."reservedAt" AS "reservedAt"
             , warehouse_roll."reservedByCoverageDecisionId"
                 AS "reservedByCoverageDecisionId"
             , acceptance_task."coverageDecisionId" AS "taskCoverageDecisionId"
             , acceptance_task."mode" AS "taskMode"
             , acceptance_task."status" AS "taskStatus"
             , acceptance_task."orderId" AS "taskOrderId"
             , production_order."id" AS "productionId"
             , production_order."sourceCoverageCalculationId"
                 AS "productionSourceCalculationId"
             , production_order."sourceCoverageDecisionId"
                 AS "productionSourceDecisionId"
             , production_order."sourceCoverageInputFingerprint"
                 AS "productionSourceInputFingerprint"
             , production_order."sourceCoverageGeneration"
                 AS "productionSourceGeneration"
             , resolution_case."coverageScope" AS "caseCoverageScope"
             , resolution_case."coverageOrigin" AS "caseCoverageOrigin"
             , resolution_case."openScopeKey" AS "caseOpenScopeKey"
             , resolution_case."sourceCoverageCalculationId"
                 AS "caseSourceCalculationId"
             , resolution_case."sourceCoverageDecisionId"
                 AS "caseSourceDecisionId"
             , resolution_case."sourceCoverageStateVersion"
                 AS "caseSourceStateVersion"
             , resolution_case."type" AS "caseType"
             , resolution_case."status" AS "caseStatus"
             , resolution_case."version" AS "caseVersion"
           FROM "commercial_orders" AS commercial_order
           JOIN "warehouse_rolls" AS warehouse_roll
             ON warehouse_roll.id = $2
           JOIN "warehouse_acceptance_tasks" AS acceptance_task
             ON acceptance_task.id = $3
           JOIN "production_orders" AS production_order
             ON production_order.id = $4
           JOIN "order_resolution_cases" AS resolution_case
             ON resolution_case.id = $5
           WHERE commercial_order."id" = $1`,
          orderId,
          `coverage-upgrade-roll-${suffix}`,
          `coverage-upgrade-task-${suffix}`,
          `coverage-upgrade-production-${suffix}`,
          `coverage-upgrade-case-${suffix}`,
        );
        expect(legacy).toEqual([
          {
            warehouseCoverageWorkflowVersion: 1,
            currentCoverageFactId: null,
            warehouseStatus: 'received',
            reservedForOrderId: orderId,
            reservedAt: expect.any(Date),
            reservedByCoverageDecisionId: null,
            taskCoverageDecisionId: null,
            taskMode: 'receiving',
            taskStatus: 'open',
            taskOrderId: orderId,
            productionId: `coverage-upgrade-production-${suffix}`,
            productionSourceCalculationId: null,
            productionSourceDecisionId: null,
            productionSourceInputFingerprint: null,
            productionSourceGeneration: null,
            caseCoverageScope: null,
            caseCoverageOrigin: null,
            caseOpenScopeKey: `legacy:coverage-upgrade:${suffix}`,
            caseSourceCalculationId: null,
            caseSourceDecisionId: null,
            caseSourceStateVersion: null,
            caseType: 'legacy',
            caseStatus: 'open',
            caseVersion: 7,
          },
        ]);
        const epoch = await prisma.$queryRaw<Array<{ epoch: bigint; id: number }>>`
          SELECT id, epoch FROM "warehouse_coverage_inventory_epochs"
        `;
        expect(epoch).toEqual([{ id: 1, epoch: 0n }]);
        for (const table of Object.keys(COVERAGE_TABLE_COLUMNS)) {
          if (table === 'warehouse_coverage_inventory_epochs') {
            continue;
          }
          const rows = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
            `SELECT COUNT(*)::int AS count FROM "${table}"`,
          );
          expect(rows).toEqual([{ count: 0 }]);
        }
        await expect(
          prisma.$executeRawUnsafe(
            `UPDATE "warehouse_rolls" SET "updatedAt" = "updatedAt" WHERE "id" = $1`,
            `coverage-upgrade-roll-${suffix}`,
          ),
        ).resolves.toBeDefined();
        await expect(
          prisma.$executeRawUnsafe(
            `UPDATE "warehouse_acceptance_tasks"
             SET "updatedAt" = "updatedAt"
             WHERE "id" = $1`,
            `coverage-upgrade-task-${suffix}`,
          ),
        ).resolves.toBeDefined();
        await expect(
          prisma.$executeRawUnsafe(
            `UPDATE "order_resolution_cases" SET "reason" = "reason" WHERE "id" = $1`,
            `coverage-upgrade-case-${suffix}`,
          ),
        ).resolves.toBeDefined();
        const applied = await prisma.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS count
          FROM "_prisma_migrations"
          WHERE migration_name = ${TARGET_MIGRATION}
            AND finished_at IS NOT NULL
        `;
        expect(applied).toEqual([{ count: 1 }]);
      },
      isolatedCleanup(prisma, schema, databaseUrl, project),
    );
  });
});
