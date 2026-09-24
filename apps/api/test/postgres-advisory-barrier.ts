import { Prisma } from '@prisma/client';
import type { PrismaService } from '../src/common/prisma/prisma.service';

interface Deferred<T> {
  promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
}

export interface AdvisoryLockBarrier {
  release(): Promise<void>;
  waitUntilBlocked(operation: Promise<unknown>, label: string): Promise<void>;
}

function deferred<T>(): Deferred<T> {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

export async function holdAdvisoryFingerprint(
  prisma: PrismaService,
  fingerprint: string,
): Promise<AdvisoryLockBarrier> {
  const acquired = deferred<number>();
  const released = deferred<void>();
  let blockerError: unknown;
  const blocker = prisma
    .$transaction(
      async (tx) => {
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>(Prisma.sql`
          WITH acquired AS (
            SELECT pg_advisory_xact_lock(hashtextextended(${fingerprint}, 0))
          )
          SELECT pg_backend_pid()::int AS pid
          FROM acquired
        `);
        if (!backend) throw new Error('Advisory lock barrier did not return its backend pid');
        acquired.resolve(backend.pid);
        await released.promise;
      },
      { maxWait: 5_000, timeout: 15_000 },
    )
    .catch((error: unknown) => {
      blockerError = error;
      acquired.reject(error);
    });
  const blockerPid = await acquired.promise;
  let didRelease = false;

  return {
    async release() {
      if (!didRelease) {
        didRelease = true;
        released.resolve();
      }
      await blocker;
      if (blockerError) throw blockerError;
    },
    async waitUntilBlocked(operation, label) {
      let settled = false;
      let operationError: unknown;
      void operation.then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          operationError = error;
        },
      );

      const deadline = Date.now() + 10_000;
      while (Date.now() <= deadline) {
        if (settled) {
          throw new Error(`${label} completed before reaching the advisory-lock barrier`, {
            cause: operationError,
          });
        }
        const [state] = await prisma.$queryRaw<Array<{ waiting: boolean }>>(Prisma.sql`
          SELECT EXISTS (
            SELECT 1
            FROM pg_locks AS held
            JOIN pg_locks AS waiting
              ON waiting.locktype = held.locktype
             AND waiting.database IS NOT DISTINCT FROM held.database
             AND waiting.classid IS NOT DISTINCT FROM held.classid
             AND waiting.objid IS NOT DISTINCT FROM held.objid
             AND waiting.objsubid IS NOT DISTINCT FROM held.objsubid
            WHERE held.pid = ${blockerPid}
              AND held.locktype = 'advisory'
              AND held.granted
              AND NOT waiting.granted
              AND waiting.pid <> held.pid
          ) AS waiting
        `);
        if (state?.waiting) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${label} at the advisory-lock barrier`);
    },
  };
}
