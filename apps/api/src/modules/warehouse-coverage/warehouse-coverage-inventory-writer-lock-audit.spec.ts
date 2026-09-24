import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const MODULES_ROOT = resolve(__dirname, '..');

const INVENTORY_WRITER_LOCK_MANIFEST = [
  ['commercial-order-amendment.service', 'delivery scope->epoch->order->dispatch->roll'],
  ['commercial-cover.service', 'v1-proposal-only; no later lock awaited by V2'],
  ['operator-physical.service', 'post locks not awaited by V2; BEFORE epoch precedes roll row'],
  ['warehouse.service', 'no task/scan lock; decision provenance rejected'],
  ['warehouse-intake-integrity.service', 'advisories->epoch->task->scan->roll'],
  ['warehouse-reserve-roll.service', 'serializable epoch->new roll'],
  ['warehouse-roll-coverage-fact.service', 'coverage hierarchy'],
  ['warehouse-coverage-decision.service', 'coverage hierarchy'],
  ['warehouse-coverage-order-change.service', 'coverage hierarchy'],
  ['warehouse-coverage-reservation-recovery.service', 'coverage hierarchy'],
] as const;

const DECLARED_BLOCKER_WRITERS = [
  'commercial-resolution.service',
  'finance.service',
  'material-shortage-correction.service',
  'operator-physical.service',
  'operator-session.service',
  'operator-shift.service',
  'operator.service',
  'production.service',
  'warehouse-intake-integrity.service',
] as const;

function sourceFiles(directory = MODULES_ROOT): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.service.ts') ? [path] : [];
  });
}

function writerNames(pattern: RegExp): string[] {
  return sourceFiles()
    .filter((path) => pattern.test(readFileSync(path, 'utf8')))
    .map((path) => basename(path, '.ts'))
    .sort();
}

function source(serviceName: string): string {
  const path = sourceFiles().find((candidate) => basename(candidate, '.ts') === serviceName);
  if (!path) throw new Error(`missing writer source: ${serviceName}`);
  return readFileSync(path, 'utf8');
}

describe('warehouse coverage inventory writer lock audit', () => {
  it('classifies every WarehouseRoll writer against the shared epoch hierarchy', () => {
    expect(INVENTORY_WRITER_LOCK_MANIFEST).toEqual([
      ['commercial-order-amendment.service', 'delivery scope->epoch->order->dispatch->roll'],
      ['commercial-cover.service', 'v1-proposal-only; no later lock awaited by V2'],
      ['operator-physical.service', 'post locks not awaited by V2; BEFORE epoch precedes roll row'],
      ['warehouse.service', 'no task/scan lock; decision provenance rejected'],
      ['warehouse-intake-integrity.service', 'advisories->epoch->task->scan->roll'],
      ['warehouse-reserve-roll.service', 'serializable epoch->new roll'],
      ['warehouse-roll-coverage-fact.service', 'coverage hierarchy'],
      ['warehouse-coverage-decision.service', 'coverage hierarchy'],
      ['warehouse-coverage-order-change.service', 'coverage hierarchy'],
      ['warehouse-coverage-reservation-recovery.service', 'coverage hierarchy'],
    ]);
    expect(
      writerNames(
        /warehouseRoll\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/u,
      ),
    ).toEqual(INVENTORY_WRITER_LOCK_MANIFEST.map(([name]) => name).sort());
  });

  it('keeps legacy intake advisory -> epoch -> task -> scan -> roll order explicit', () => {
    const intake = source('warehouse-intake-integrity.service');
    const advisory = intake.indexOf('pg_advisory_xact_lock');
    const epoch = intake.indexOf('lockCoverageInventoryEpoch', advisory);
    const task = intake.indexOf('warehouse_acceptance_tasks', epoch);
    const scan = intake.indexOf('scan_rows', task);
    const roll = intake.indexOf('warehouse_rolls', scan);
    expect([advisory, epoch, task, scan, roll].every((position) => position >= 0)).toBe(true);
    expect(advisory).toBeLessThan(epoch);
    expect(epoch).toBeLessThan(task);
    expect(task).toBeLessThan(scan);
    expect(scan).toBeLessThan(roll);
  });

  it('locks the inventory epoch before publishing a platform reserve roll', () => {
    const reserve = source('warehouse-reserve-roll.service');
    const serializable = reserve.indexOf('runCoverageSerializable');
    const epoch = reserve.indexOf('lockCoverageInventoryEpoch', serializable);
    const roll = reserve.indexOf('warehouseRoll.create', epoch);

    expect([serializable, epoch, roll].every((position) => position >= 0)).toBe(true);
    expect(serializable).toBeLessThan(epoch);
    expect(epoch).toBeLessThan(roll);
  });

  it('rejects decision provenance in every generic warehouse mutation class', () => {
    expect(source('warehouse.service')).toContain(
      'warehouse_coverage_decision_managed_reservation',
    );
    expect(source('warehouse.service')).toContain('warehouse_coverage_decision_managed_task');
    expect(source('warehouse-intake-integrity.service')).toContain(
      'warehouse_coverage_decision_managed_task',
    );
  });

  it('has no unclassified roll-scoped blocker writer service', () => {
    const discovered = writerNames(
      /(?:productionProblem|defectRecord)\.(?:create|update|updateMany|delete|deleteMany)\s*\(/u,
    );
    expect(discovered).toEqual([...DECLARED_BLOCKER_WRITERS].sort());
  });
});
