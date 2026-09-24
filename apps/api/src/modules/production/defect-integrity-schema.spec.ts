import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const prismaRoot = resolve(__dirname, '../../../prisma');
const migration = resolve(
  prismaRoot,
  'migrations/20260723110000_defect_weight_integrity/migration.sql',
);

describe('defect weight integrity persistence', () => {
  it('links defects to physical captures and problems to exact defects', () => {
    const schema = readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8');

    expect(schema).toMatch(/weightCaptureId\s+String\?\s+@unique/);
    expect(schema).toMatch(
      /weightCapture\s+WeightCapture\?\s+@relation\(fields: \[weightCaptureId\], references: \[id\], onDelete: Restrict, onUpdate: Restrict\)/,
    );
    expect(schema).toMatch(/defectRecordId\s+String\?\s+@unique/);
    expect(schema).toMatch(
      /defectRecord\s+DefectRecord\?\s+@relation\(fields: \[defectRecordId\], references: \[id\], onDelete: Restrict, onUpdate: Restrict\)/,
    );
  });

  it('adds safe nullable foreign keys and one-open-defect-per-roll uniqueness', () => {
    const sql = readFileSync(migration, 'utf8');

    expect(sql.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain('ADD COLUMN "weightCaptureId" TEXT');
    expect(sql).toContain('ADD COLUMN "defectRecordId" TEXT');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "defect_records_weightCaptureId_key"',
    );
    expect(sql).toContain(
      'FOREIGN KEY ("weightCaptureId") REFERENCES "weight_captures"("id") ON DELETE RESTRICT ON UPDATE RESTRICT',
    );
    expect(sql).toContain(
      'FOREIGN KEY ("defectRecordId") REFERENCES "defect_records"("id") ON DELETE RESTRICT ON UPDATE RESTRICT',
    );
    expect(sql).toContain(
      `CREATE UNIQUE INDEX "production_problems_one_open_defect_per_roll_idx"
ON "production_problems" ("rollId")
WHERE "type" = 'defect' AND "status" = 'open' AND "rollId" IS NOT NULL;`,
    );
    const preflight = sql.slice(
      sql.indexOf('DO $$'),
      sql.indexOf('CREATE UNIQUE INDEX "production_problems_one_open_defect_per_roll_idx"'),
    );
    expect(preflight).toContain(
      `WHERE "type" = 'defect'
      AND "status" = 'open'`,
    );
    expect(preflight).not.toContain('"rollId"');
    expect(preflight).not.toContain('HAVING COUNT(*) > 1');
    expect(preflight).toContain(
      'Open defect problems must be resolved before defect provenance migration',
    );
    expect(sql.indexOf('DO $$')).toBeLessThan(sql.indexOf('ADD COLUMN "weightCaptureId"'));
    expect(sql).toContain('CREATE FUNCTION "guard_defect_weight_capture_link"()');
    expect(sql).toContain('CREATE FUNCTION "guard_problem_defect_record_link"()');
    expect(sql).toContain('CREATE FUNCTION "require_open_defect_record_link"()');
    expect(sql).toContain(
      'CREATE TRIGGER "production_problems_open_defect_link_guard"',
    );
    expect(sql).toContain(
      `IF NEW."type" = 'defect'
     AND NEW."status" = 'open'
     AND NEW."defectRecordId" IS NULL`,
    );
    expect(sql).toContain('BEFORE UPDATE OF "weightCaptureId" ON "defect_records"');
    expect(sql).toContain('BEFORE DELETE ON "defect_records"');
    expect(sql).toContain('BEFORE UPDATE OF "defectRecordId" ON "production_problems"');
    expect(sql).toContain('BEFORE DELETE ON "production_problems"');
  });
});
