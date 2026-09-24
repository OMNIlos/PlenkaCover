import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/** Business leases can expire before the gateway returns its command ID. */
export async function assertPrintCommandSettled(
  tx: Prisma.TransactionClient,
  commandId: string | null,
  payloadIdentity: Record<string, string>,
): Promise<void> {
  const active = await tx.gatewayCommand.findFirst({
    where: {
      kind: 'print',
      status: { in: ['queued', 'in_flight'] },
      OR: [
        ...(commandId ? [{ id: commandId }] : []),
        {
          AND: Object.entries(payloadIdentity).map(([key, value]) => ({
            payload: { path: [key], equals: value },
          })),
        },
      ],
    },
    select: { id: true },
  });
  if (active)
    throw new ConflictException({
      code: 'ADMIN_PRINT_COMMAND_IN_PROGRESS',
      message: 'Команда печати ещё выполняется. Дождитесь её завершения и обновите список.',
    });
}
