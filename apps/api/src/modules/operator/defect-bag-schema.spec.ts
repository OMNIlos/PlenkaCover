import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CAPABILITIES,
  DEFECT_BAG_TYPES,
  DOMAIN_EVENTS,
  ROLE_CAPABILITIES,
  isPrinterPayload,
} from '@plenka/contracts';

const prismaRoot = resolve(__dirname, '../../../prisma');
const migration = resolve(
  prismaRoot,
  'migrations/20260906170000_defect_bag_logistics/migration.sql',
);
const manualWeightMigration = resolve(
  prismaRoot,
  'migrations/20260910170000_defect_bag_manual_weight/migration.sql',
);
const defectTypeMigration = resolve(
  prismaRoot,
  'migrations/20260911120000_defect_bag_type/migration.sql',
);

describe('defect bag persistence contract', () => {
  it('publishes the three defect types', () => {
    expect(DEFECT_BAG_TYPES).toEqual(['secondary', 'aika', 'primary']);
  });

  it('publishes the guarded operator and warehouse actions', () => {
    expect(CAPABILITIES).toEqual(
      expect.arrayContaining([
        'defect_bag:weigh',
        'defect_bag:print',
        'defect_bag:read',
        'defect_bag:receive',
        'defect_bag:ship',
      ]),
    );
    expect(ROLE_CAPABILITIES.operator).toEqual(
      expect.arrayContaining(['defect_bag:weigh', 'defect_bag:print']),
    );
    expect(ROLE_CAPABILITIES.warehouse).toEqual(
      expect.arrayContaining(['defect_bag:read', 'defect_bag:receive', 'defect_bag:ship']),
    );
  });

  it('publishes the append-only audit facts', () => {
    expect(DOMAIN_EVENTS).toEqual(
      expect.arrayContaining([
        'audit:defect_bag_weighed',
        'audit:defect_bag_label_print_requested',
        'audit:defect_bag_label_reprint_requested',
        'audit:defect_bag_label_print_submitted',
        'audit:defect_bag_label_print_failed',
        'audit:defect_bag_label_print_delivery_unknown',
        'audit:defect_bag_received',
        'audit:defect_bag_shipped',
      ]),
    );
  });

  it('accepts only a bounded Big-Bag-compatible defect label payload', () => {
    expect(
      isPrinterPayload({
        kind: 'big_bag_label',
        destination: 'operator',
        bigBagCode: 'DEF-session-1',
        material: 'БРАК · 12.345 кг',
        qrCode: `bbt_${'a'.repeat(64)}`,
      }),
    ).toBe(true);
    expect(
      isPrinterPayload({
        kind: 'big_bag_label',
        destination: 'operator',
        bigBagCode: 'DEF-session-1',
        material: 'БРАК',
        qrCode: 'DEF-session-1',
      }),
    ).toBe(false);
  });

  it('models individually keyed bags per post-session with token, print jobs and movements', () => {
    const schema = readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8');

    expect(schema).toContain('model DefectBag {');
    expect(schema).toMatch(/defectBags\s+DefectBag\[\]/);
    expect(schema).toContain('@@index([postSessionId, weighedAt, id])');
    expect(schema).not.toMatch(/postSessionId\s+String\s+@unique/);
    expect(schema).toMatch(/weighOperationKey\s+String\s+@unique\s+@db\.Uuid/);
    expect(schema).toMatch(/captureChannel\s+String\s+@default\("machine_post_scale"\)/);
    expect(schema).toMatch(/defectType\s+String\?/);
    expect(schema).toMatch(/scaleDeviceId\s+String\?/);
    expect(schema).toContain('model DefectBagScanToken {');
    expect(schema).toMatch(/token\s+String\s+@unique.*@db\.VarChar\(68\)/);
    expect(schema).toContain('model DefectBagLabelPrintJob {');
    expect(schema).toContain('model DefectBagMovement {');
    expect(schema).toMatch(/@@unique\(\[defectBagId, kind\]\)/);
  });

  it('stores manual provenance without inventing scale evidence', () => {
    const sql = readFileSync(manualWeightMigration, 'utf8');

    expect(sql).toContain('"captureChannel" = \'operator_manual\'');
    expect(sql).toContain('"scaleDeviceId" IS NULL');
    expect(sql).toContain('defect_bags_capture_evidence_check');
  });

  it('adds a nullable, constrained type without inventing historical classifications', () => {
    const sql = readFileSync(defectTypeMigration, 'utf8');

    expect(sql.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain('ADD COLUMN "defectType" TEXT');
    expect(sql).toContain("'secondary', 'aika', 'primary'");
    expect(sql).not.toMatch(/UPDATE\s+"defect_bags"/u);
  });

  it('installs lifecycle checks and restrictive provenance foreign keys', () => {
    const sql = readFileSync(migration, 'utf8');

    expect(sql.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain('defect_bags_status_check');
    expect(sql).toContain('defect_bag_print_jobs_status_check');
    expect(sql).toContain('defect_bag_movements_kind_check');
    expect(sql).toContain('ON DELETE RESTRICT ON UPDATE CASCADE');
  });
});
