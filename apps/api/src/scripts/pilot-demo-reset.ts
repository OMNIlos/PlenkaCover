import { PrismaClient } from '@prisma/client';
import { PILOT_DEMO_RESET_CONFIRMATION, resetPilotDemoData } from '../common/seed/pilot-demo-reset';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const result = await resetPilotDemoData(
      prisma,
      process.env.PILOT_DEMO_RESET_CONFIRM,
      process.env.APP_ENV,
      process.env.SEED_PROFILE,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown reset failure';
  process.stderr.write(
    `Pilot demo reset failed (${PILOT_DEMO_RESET_CONFIRMATION} required): ${message}\n`,
  );
  process.exitCode = 1;
});
