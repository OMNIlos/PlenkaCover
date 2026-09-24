import { Prisma } from '@prisma/client';

type FinanceAggregateLockClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** Serialize every schedule mutation through its owning FinanceOrder aggregate. */
export async function lockFinanceOrderAggregate(
  client: FinanceAggregateLockClient,
  financeOrderId: string,
) {
  await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "finance_orders"
    WHERE "id" = ${financeOrderId}
    FOR UPDATE
  `);
}
