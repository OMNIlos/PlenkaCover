import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

type SessionRow = { id: string };

describe('shift BigBag episode integrity (e2e, real PostgreSQL)', () => {
  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createUsage(label: string): Promise<string> {
    const [session] = await prisma.$queryRaw<SessionRow[]>`
      SELECT "id" FROM "operator_post_sessions" ORDER BY "startedAt", "id" LIMIT 1
    `;
    if (!session) throw new Error('Seed must provide an operator post session');
    const suffix = randomUUID();
    const bagId = `episode-bag-${label}-${suffix}`;
    const usageId = `episode-usage-${label}-${suffix}`;
    await prisma.$executeRaw`
      INSERT INTO "big_bag_units" ("id", "code", "material")
      VALUES (${bagId}, ${`EPISODE-${label}-${suffix}`}, 'Тестовое сырьё')
    `;
    await prisma.$executeRaw`
      INSERT INTO "shift_bag_usages" (
        "id", "sessionId", "bigBagId", "startKg", "sequence"
      ) VALUES (${usageId}, ${session.id}, ${bagId}, 500, 1000)
    `;
    return usageId;
  }

  it('allows one open episode, preserves closed history and rejects later mutation or deletion', async () => {
    const usageId = await createUsage('history');
    const firstId = `episode-${randomUUID()}`;
    await prisma.$executeRaw`
      INSERT INTO "shift_bag_usage_episodes" (
        "id", "usageId", "sequence", "startKg"
      ) VALUES (${firstId}, ${usageId}, 1, 500)
    `;

    await expect(
      prisma.$executeRaw`
        INSERT INTO "shift_bag_usage_episodes" (
          "id", "usageId", "sequence", "startKg"
        ) VALUES (${`duplicate-${randomUUID()}`}, ${usageId}, 2, 450)
      `,
    ).rejects.toThrow();

    await prisma.$executeRaw`
      UPDATE "shift_bag_usage_episodes"
      SET "endKg" = 450, "closedAt" = CURRENT_TIMESTAMP, "closeKind" = 'released'
      WHERE "id" = ${firstId}
    `;
    const secondId = `episode-${randomUUID()}`;
    await prisma.$executeRaw`
      INSERT INTO "shift_bag_usage_episodes" (
        "id", "usageId", "sequence", "startKg"
      ) VALUES (${secondId}, ${usageId}, 2, 450)
    `;

    await expect(
      prisma.$executeRaw`
        UPDATE "shift_bag_usage_episodes" SET "endKg" = 449 WHERE "id" = ${firstId}
      `,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`DELETE FROM "shift_bag_usage_episodes" WHERE "id" = ${firstId}`,
    ).rejects.toThrow();
  });

  it('rejects impossible weights and incomplete close transitions at the database boundary', async () => {
    const usageId = await createUsage('checks');
    const episodeId = `episode-${randomUUID()}`;
    await prisma.$executeRaw`
      INSERT INTO "shift_bag_usage_episodes" (
        "id", "usageId", "sequence", "startKg"
      ) VALUES (${episodeId}, ${usageId}, 1, 500)
    `;

    await expect(
      prisma.$executeRaw`
        UPDATE "shift_bag_usage_episodes"
        SET "endKg" = 501, "closedAt" = CURRENT_TIMESTAMP, "closeKind" = 'released'
        WHERE "id" = ${episodeId}
      `,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`
        UPDATE "shift_bag_usage_episodes"
        SET "endKg" = 450
        WHERE "id" = ${episodeId}
      `,
    ).rejects.toThrow();
  });

  it('serializes concurrent attempts so exactly one open episode is committed', async () => {
    const usageId = await createUsage('race');
    const contenders = [new PrismaClient(), new PrismaClient()];
    try {
      const results = await Promise.allSettled(
        contenders.map((client, index) =>
          client.$executeRaw`
            INSERT INTO "shift_bag_usage_episodes" (
              "id", "usageId", "sequence", "startKg"
            ) VALUES (${`episode-race-${index}-${randomUUID()}`}, ${usageId}, ${index + 1}, 500)
          `,
        ),
      );

      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
      const [{ count }] = await prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count
        FROM "shift_bag_usage_episodes"
        WHERE "usageId" = ${usageId} AND "closedAt" IS NULL
      `;
      expect(count).toBe(1);
    } finally {
      await Promise.all(contenders.map((client) => client.$disconnect()));
    }
  });
});
