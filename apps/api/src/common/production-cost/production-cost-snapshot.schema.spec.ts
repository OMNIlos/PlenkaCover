import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const API_ROOT = join(__dirname, '../../..');
const SCHEMA = readFileSync(join(API_ROOT, 'prisma/schema.prisma'), 'utf8');
const MIGRATION = readFileSync(
  join(API_ROOT, 'prisma/migrations/20260808043000_add_production_cost_snapshots/migration.sql'),
  'utf8',
);

describe('production cost snapshot persistence', () => {
  it('declares additive append-only price references and versioned roll snapshots', () => {
    expect(SCHEMA).toMatch(/model SpoolPriceReference \{/);
    expect(SCHEMA).toMatch(/operationKey\s+String\s+@unique\s+@db\.Uuid/);
    expect(SCHEMA).toMatch(/requestFingerprint\s+String\s+@db\.Char\(64\)/);
    expect(SCHEMA).toMatch(/priceKopecksPerMeter\s+BigInt/);
    expect(SCHEMA).toMatch(/@@unique\(\[spoolTypeKey, effectiveFrom\]\)/);

    expect(SCHEMA).toMatch(/model RollProductionCostSnapshot \{/);
    expect(SCHEMA).toMatch(/basisWeightGrams\s+Int/);
    expect(SCHEMA).toMatch(/sourceSnapshot\s+Json/);
    expect(SCHEMA).toMatch(/unresolvedReasons\s+Json/);
    expect(SCHEMA).toMatch(/@@unique\(\[rollDispatchItemId, version\]\)/);
  });

  it('creates only new tables, indexes, checks, and restrictive foreign keys', () => {
    expect(MIGRATION).toContain('CREATE TABLE "spool_price_references"');
    expect(MIGRATION).toContain('CREATE TABLE "roll_production_cost_snapshots"');
    expect(MIGRATION).toContain('ON DELETE RESTRICT');
    expect(MIGRATION).toMatch(/priceKopecksPerMeter" > 0/);
    expect(MIGRATION).toMatch(/basisWeightGrams" > 0/);
    expect(MIGRATION).toMatch(/status" IN \('complete', 'partial'\)/);
    expect(MIGRATION).toMatch(/actor.*xor/is);

    expect(MIGRATION).not.toMatch(
      /^\s*(?:UPDATE|DELETE\s+FROM|DROP\s+(?:TABLE|COLUMN|INDEX))\b/gim,
    );
    expect(MIGRATION).not.toMatch(
      /ALTER\s+TABLE\s+"(?!domain_events|spool_price_references|roll_production_cost_snapshots)/i,
    );
  });

  it('validates existing domain-event actors before atomically widening the exact XOR check', () => {
    const preflight = MIGRATION.indexOf('existing domain event violates actor XOR policy');
    const addTemporary = MIGRATION.indexOf(
      'ADD CONSTRAINT "domain_events_actor_xor_production_cost_v2"',
    );
    const notValid = MIGRATION.indexOf('NOT VALID', addTemporary);
    const validate = MIGRATION.indexOf(
      'VALIDATE CONSTRAINT "domain_events_actor_xor_production_cost_v2"',
    );
    const lock = MIGRATION.indexOf('LOCK TABLE "domain_events" IN ACCESS EXCLUSIVE MODE');
    const dropOld = MIGRATION.indexOf('DROP CONSTRAINT "domain_events_actor_xor"');
    const rename = MIGRATION.indexOf(
      'RENAME CONSTRAINT "domain_events_actor_xor_production_cost_v2" TO "domain_events_actor_xor"',
    );

    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(addTemporary).toBeGreaterThan(preflight);
    expect(notValid).toBeGreaterThan(addTemporary);
    expect(validate).toBeGreaterThan(notValid);
    expect(lock).toBeGreaterThan(validate);
    expect(dropOld).toBeGreaterThan(lock);
    expect(rename).toBeGreaterThan(dropOld);
    expect(MIGRATION.match(/DROP\s+CONSTRAINT/gi)).toEqual(['DROP CONSTRAINT']);
    const actorPredicates = [...MIGRATION.matchAll(/"systemActorKey"\s+IN\s*\(([\s\S]*?)\)/gu)];
    expect(actorPredicates).toHaveLength(2);
    for (const predicate of actorPredicates) {
      const keys = [...predicate[1].matchAll(/'([^']+)'/gu)].map((match) => match[1]);
      expect(keys).toEqual([
        'warehouse_coverage_engine',
        'warehouse-pallet-cutover',
        'onec_finance_sync',
        'production_cost_reconciler',
      ]);
    }
    expect(MIGRATION).toContain(') IS TRUE\n  ) NOT VALID');
  });

  it('rejects update, delete, and truncate for both histories at database level', () => {
    expect(MIGRATION).toContain('reject_production_cost_history_mutation');
    for (const table of ['spool_price_references', 'roll_production_cost_snapshots']) {
      expect(MIGRATION).toContain(`CREATE TRIGGER "${table}_append_only"`);
      expect(MIGRATION).toContain(`CREATE TRIGGER "${table}_no_truncate"`);
    }
  });

  it('bounds every persisted monetary bigint to the JavaScript safe-integer range', () => {
    const upperBounds = MIGRATION.match(/<= 9007199254740991/g) ?? [];

    expect(upperBounds).toHaveLength(7);
  });

  it('enforces exact complete totals, BigInt half-up per-kg, and partial-only system succession', () => {
    expect(MIGRATION).toMatch(
      /"totalAmountKopecks"\s*=\s*"materialAmountKopecks"\s*\+\s*"spoolAmountKopecks"\s*\+\s*"payrollAmountKopecks"\s*\+\s*"additionalAmountKopecks"/,
    );
    expect(MIGRATION).toMatch(/FLOOR\([\s\S]*::numeric[\s\S]*"basisWeightGrams"/);
    expect(MIGRATION).toMatch(/predecessor\."status"\s*<>\s*'partial'/);
    expect(MIGRATION).toMatch(
      /predecessor\."calculationFingerprint"\s*=\s*NEW\."calculationFingerprint"/,
    );
    expect(MIGRATION).toMatch(/NEW\."version" = 1[\s\S]*NEW\."actorId" IS NOT NULL/);
    expect(MIGRATION).toMatch(/TG_TABLE_SCHEMA[\s\S]*TG_TABLE_NAME/);
    expect(MIGRATION).not.toContain('public."roll_production_cost_snapshots"');
  });

  it('stores actual capability-authorized actor roles without hard-coded role checks', () => {
    expect(MIGRATION).not.toMatch(/createdByRole"\s*=\s*'warehouse'/);
    expect(MIGRATION).not.toMatch(/actorRole"\s*=\s*'finance'/);
    expect(MIGRATION).toMatch(/"actorRole" IS NOT NULL/);
  });
});
