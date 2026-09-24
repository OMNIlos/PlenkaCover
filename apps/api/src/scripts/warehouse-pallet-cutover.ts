import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  parseWarehousePalletCutoverMode,
  WarehousePalletCutoverBlockedError,
  WarehousePalletCutoverService,
} from '../modules/warehouse/warehouse-pallet-cutover';

async function main(): Promise<void> {
  const mode = parseWarehousePalletCutoverMode(process.argv.slice(2));
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const service = new WarehousePalletCutoverService(prisma, new AuditService(prisma));
    const report = mode === 'apply' ? await service.apply() : await service.dryRun();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    if (error instanceof WarehousePalletCutoverBlockedError) {
      process.stdout.write(`${JSON.stringify(error.report, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown cutover failure';
  process.stderr.write(`Warehouse pallet cutover failed: ${message}\n`);
  process.exitCode = 1;
});
