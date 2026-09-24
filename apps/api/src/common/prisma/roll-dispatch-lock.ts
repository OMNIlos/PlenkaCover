import { Prisma } from '@prisma/client';

type RollDispatchLockClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

export async function lockRollDispatchItems(
  client: RollDispatchLockClient,
  rollDispatchItemIds: readonly string[],
) {
  const orderedIds = [...new Set(rollDispatchItemIds)].sort();
  if (orderedIds.length === 0) return;

  await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "roll_dispatch_items"
    WHERE "id" IN (${Prisma.join(orderedIds)})
    ORDER BY "id"
    FOR UPDATE
  `);
}
