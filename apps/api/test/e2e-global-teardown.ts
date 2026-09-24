import { cleanupE2eDatabase } from './e2e-database';

export default async function globalTeardown(): Promise<void> {
  await cleanupE2eDatabase();
}
