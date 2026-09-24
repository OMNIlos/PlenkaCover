import { Prisma } from '@prisma/client';

export const COMMERCIAL_ORDER_PARAMETERS_LOCKED_AFTER_INVOICE =
  'COMMERCIAL_ORDER_PARAMETERS_LOCKED_AFTER_INVOICE';

export type CommercialInvoiceBoundary = {
  financeOrderId: string;
  commercialOrderId: string;
  invoiceStatus: string;
  invoiceIssuedAt: Date | null;
  invoiceSyncState: string;
};

const BOUNDARY_SELECT = {
  id: true,
  commercialOrderId: true,
  invoiceStatus: true,
  invoiceIssuedAt: true,
  invoiceSyncState: true,
} satisfies Prisma.FinanceOrderSelect;

type BoundaryRow = Prisma.FinanceOrderGetPayload<{
  select: typeof BOUNDARY_SELECT;
}>;

export function invoiceLocksCommercialParameters(
  boundary: CommercialInvoiceBoundary | null,
): boolean {
  return Boolean(
    boundary &&
    (boundary.invoiceStatus === 'invoiced' ||
      boundary.invoiceIssuedAt !== null ||
      boundary.invoiceSyncState === 'posted'),
  );
}

export async function lockInvoiceBoundaryForCommercialOrder(
  tx: Prisma.TransactionClient,
  commercialOrderId: string,
): Promise<CommercialInvoiceBoundary | null> {
  await acquireCommercialInvoiceBoundary(tx, commercialOrderId);
  return readInvoiceBoundaryForCommercialOrder(tx, commercialOrderId);
}

export async function lockInvoiceBoundaryForFinanceOrder(
  tx: Prisma.TransactionClient,
  financeOrderId: string,
): Promise<CommercialInvoiceBoundary | null> {
  const link = await tx.financeOrder.findUnique({
    where: { id: financeOrderId },
    select: { id: true, commercialOrderId: true },
  });
  if (!link) return null;
  await acquireCommercialInvoiceBoundary(tx, link.commercialOrderId);
  if (!(await lockFinanceOrder(tx, link.id))) return null;
  return readBoundary(tx, link.id);
}

export async function tryLockCommercialInvoiceBoundary(
  tx: Prisma.TransactionClient,
  commercialOrderId: string,
): Promise<boolean> {
  const [row] = await tx.$queryRaw<Array<{ locked: boolean }>>(Prisma.sql`
    SELECT pg_try_advisory_xact_lock(
      hashtextextended(${invoiceBoundaryScope(commercialOrderId)}, 0)
    ) AS "locked"
  `);
  return row?.locked === true;
}

export async function readInvoiceBoundaryForCommercialOrder(
  tx: Prisma.TransactionClient,
  commercialOrderId: string,
): Promise<CommercialInvoiceBoundary | null> {
  const row = await tx.financeOrder.findUnique({
    where: { commercialOrderId },
    select: BOUNDARY_SELECT,
  });
  return projectBoundary(row);
}

async function acquireCommercialInvoiceBoundary(
  tx: Prisma.TransactionClient,
  commercialOrderId: string,
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${invoiceBoundaryScope(commercialOrderId)}, 0)
    )::text AS "lock"
  `);
}

function invoiceBoundaryScope(commercialOrderId: string): string {
  return `commercial-invoice-boundary:${commercialOrderId}`;
}

async function lockFinanceOrder(
  tx: Prisma.TransactionClient,
  financeOrderId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "finance_orders"
    WHERE "id" = ${financeOrderId}
    FOR UPDATE
  `);
  return rows.length === 1;
}

async function readBoundary(
  tx: Prisma.TransactionClient,
  financeOrderId: string,
): Promise<CommercialInvoiceBoundary | null> {
  const row: BoundaryRow | null = await tx.financeOrder.findUnique({
    where: { id: financeOrderId },
    select: BOUNDARY_SELECT,
  });
  return projectBoundary(row);
}

function projectBoundary(row: BoundaryRow | null): CommercialInvoiceBoundary | null {
  return row
    ? {
        financeOrderId: row.id,
        commercialOrderId: row.commercialOrderId,
        invoiceStatus: row.invoiceStatus,
        invoiceIssuedAt: row.invoiceIssuedAt,
        invoiceSyncState: row.invoiceSyncState,
      }
    : null;
}
