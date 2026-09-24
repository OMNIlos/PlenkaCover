import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

describe('1C production sync persistence (e2e, real PostgreSQL)', () => {
  const prisma = new PrismaClient();
  const runIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

  afterAll(async () => {
    await prisma
      .$executeRawUnsafe(`DELETE FROM "onec_sync_runs" WHERE "id" = ANY($1::text[])`, runIds)
      .catch(() => undefined);
    await prisma.$disconnect();
  });

  it('creates the current-mirror relations required by a production sync', async () => {
    const rows = await prisma.$queryRaw<Array<{ relation: string | null }>>`
      SELECT to_regclass('onec_sync_runs')::text AS relation
      UNION ALL
      SELECT to_regclass('onec_nomenclature_items')::text
      UNION ALL
      SELECT to_regclass('onec_stock_balances')::text
      UNION ALL
      SELECT to_regclass('onec_production_reports')::text
      UNION ALL
      SELECT to_regclass('onec_production_output_lines')::text
      UNION ALL
      SELECT to_regclass('onec_production_material_lines')::text
    `;

    expect(rows.map((row) => row.relation?.replace(/^[^.]+\./, ''))).toEqual([
      'onec_sync_runs',
      'onec_nomenclature_items',
      'onec_stock_balances',
      'onec_production_reports',
      'onec_production_output_lines',
      'onec_production_material_lines',
    ]);
  });

  it('preserves sub-cent quantities from 1C without rounding them on every sync', async () => {
    const columns = await prisma.$queryRaw<
      Array<{ table_name: string; column_name: string; numeric_scale: number }>
    >`
      SELECT table_name, column_name, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND column_name = 'quantity'
        AND table_name IN (
          'onec_invoice_lines',
          'onec_shipment_lines',
          'onec_stock_balances',
          'onec_production_output_lines',
          'onec_production_material_lines'
        )
      ORDER BY table_name
    `;

    expect(columns).toEqual([
      { table_name: 'onec_invoice_lines', column_name: 'quantity', numeric_scale: 6 },
      {
        table_name: 'onec_production_material_lines',
        column_name: 'quantity',
        numeric_scale: 6,
      },
      {
        table_name: 'onec_production_output_lines',
        column_name: 'quantity',
        numeric_scale: 6,
      },
      { table_name: 'onec_shipment_lines', column_name: 'quantity', numeric_scale: 6 },
      { table_name: 'onec_stock_balances', column_name: 'quantity', numeric_scale: 6 },
    ]);
  });

  it('allows only one non-null active full-sync claim', async () => {
    await prisma.$executeRaw`
      INSERT INTO "onec_sync_runs" ("id", "mode", "status", "activeScopeKey")
      VALUES (${runIds[0]}, 'apply', 'running', 'onec:full-sync')
    `;

    await expect(
      prisma.$executeRaw`
        INSERT INTO "onec_sync_runs" ("id", "mode", "status", "activeScopeKey")
        VALUES (${runIds[1]}, 'scheduled', 'running', 'onec:full-sync')
      `,
    ).rejects.toThrow();

    await prisma.$executeRaw`
      INSERT INTO "onec_sync_runs" ("id", "mode", "status", "activeScopeKey")
      VALUES
        (${runIds[2]}, 'preview', 'completed', NULL),
        (${runIds[3]}, 'preview', 'completed', NULL)
    `;

    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "onec_sync_runs"
      WHERE "id" = ANY(${runIds}::text[])
      ORDER BY "id"
    `;
    expect(rows).toHaveLength(3);
  });
});
