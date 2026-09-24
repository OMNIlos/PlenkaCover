import { PrismaClient } from '@prisma/client';
import {
  PILOT_ORDER_HISTORY_PURGE_CONFIRMATION,
  purgePilotOrderHistory,
} from '../common/seed/pilot-order-history-purge';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const result = await purgePilotOrderHistory(
      prisma,
      process.env.PILOT_ORDER_HISTORY_PURGE_CONFIRM,
      process.env.APP_ENV,
      process.env.SEED_PROFILE,
      process.env.PILOT_GATEWAYS_STOPPED,
      process.env.PILOT_ACCUMULATED_RUNTIME_PURGE_CONFIRM,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown purge failure';
  process.stderr.write(
    `Pilot order history purge failed (${PILOT_ORDER_HISTORY_PURGE_CONFIRMATION} required): ${message}\n`,
  );
  process.exitCode = 1;
});
