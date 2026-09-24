import { PrismaClient } from '@prisma/client';
import { prepareE2eDatabase } from './e2e-database';
import { enableSimulatedDevices } from './simulated-device-fixture';

export default async function globalSetup(): Promise<void> {
  await prepareE2eDatabase();
  process.env.GATEWAY_STALE_AFTER_SEC ??= '3600';
  process.env.GATEWAY_OFFLINE_AFTER_SEC ??= '7200';

  const prisma = new PrismaClient();
  try {
    const devices = await prisma.deviceRuntime.findMany({
      where: { postId: { not: null }, isEnabled: true },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    await enableSimulatedDevices(
      prisma,
      devices.map((device) => device.id),
    );
  } finally {
    await prisma.$disconnect();
  }
}
