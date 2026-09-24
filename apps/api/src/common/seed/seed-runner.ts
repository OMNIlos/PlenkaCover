import { loadSeedProfile, type DemoSeedProfile, type PilotSeedProfile } from './seed-profile';

interface Disconnectable {
  $disconnect(): Promise<unknown>;
}

interface SeedRunnerDependencies<TPrisma extends Disconnectable> {
  createPrisma(): TPrisma;
  seedDemo(prisma: TPrisma, config: DemoSeedProfile): Promise<unknown>;
  seedPilot(prisma: TPrisma, config: PilotSeedProfile): Promise<unknown>;
}

export async function runSeedProfile<TPrisma extends Disconnectable>(
  env: Record<string, string | undefined>,
  dependencies: SeedRunnerDependencies<TPrisma>,
): Promise<void> {
  const config = loadSeedProfile(env);
  const prisma = dependencies.createPrisma();
  try {
    if (config.profile === 'demo') {
      await dependencies.seedDemo(prisma, config);
    } else {
      await dependencies.seedPilot(prisma, config);
    }
  } finally {
    await prisma.$disconnect();
  }
}
