import { PrismaClient } from '@prisma/client';
import {
  assertDirectorAnalyticsLocalDatabase,
  seedDirectorAnalyticsDemo,
} from '../src/common/seed/director-analytics-demo-seed';

async function main(): Promise<void> {
  const databaseUrl = process.env.DIRECTOR_PREVIEW_DATABASE_URL;
  if (!databaseUrl) throw new Error('DIRECTOR_PREVIEW_DATABASE_URL is required');

  assertDirectorAnalyticsLocalDatabase(databaseUrl);
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    await seedDirectorAnalyticsDemo(prisma, '2026-07-24');
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
