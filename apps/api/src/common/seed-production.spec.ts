import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hashPassword } from './auth/password';
import {
  buildRollDispatchItemSeedUpsert,
  seedWarehouseCoverageV2Fixtures,
} from './seed/production-seed';

const seedSource = readFileSync(resolve(__dirname, '../../prisma/seed.ts'), 'utf8');

type UpsertArgs = {
  where: { rollCode: string };
  update: Record<string, unknown>;
  create: Record<string, unknown>;
};

type HistoricalRow = {
  rollCode: string;
  orderLineId: string;
  positionSequence: number;
  rawMaterialId: string;
  recipeVersion: string;
  characteristicsSnapshot: Record<string, unknown>;
  assignedOperatorId: string;
  machineId: string | null;
  postId: string | null;
  plannedShiftId: string | null;
  status: string;
  priority: number;
};

type SeedMaterialDefinition = {
  id: string;
  name: string;
  normalizedName: string;
  kind: string;
  status: string;
  createdByRole: string;
};

type SeedMaterialStock = {
  id: string;
  materialId: string;
  label: string;
  rawMaterialDefinitionId: string | null;
};

type SeedUser = {
  id: string;
  externalId: string | null;
  login: string;
  passwordHash: string | null;
  identityProvider: string;
  displayName: string;
  role: string;
  isActive: boolean;
  mustChangePassword: boolean;
  passwordChangedAt: Date | null;
};

type DemoAssignment = {
  breakdownReason: string | null;
  id: string;
  lockedAt: Date | null;
  operatorId: string;
  postId: string;
  previousPostId: string | null;
  reassignedAt: Date | null;
  shiftId: string;
  status: string;
};

type DemoPostSession = {
  endedAt: Date | null;
  id: string;
  operatorId: string;
  postId: string;
  shiftId: string;
  status: string;
};

type SeedAuthSession = {
  id: string;
  revokedAt: Date | null;
  userId: string;
};

type SeedHarnessOptions = {
  interleaveRetiredProgression?: boolean;
  legacyDemoAssignments?: boolean;
  retiredActivePostSession?: boolean;
};

type DemoAssignmentIdentity = Pick<DemoAssignment, 'operatorId' | 'shiftId'>;
type DemoAssignmentUniqueWhere =
  | { id: string; shiftId_operatorId?: never }
  | { id?: never; shiftId_operatorId: DemoAssignmentIdentity };
type DemoAssignmentCreate = Partial<DemoAssignment> &
  Pick<DemoAssignment, 'operatorId' | 'postId' | 'shiftId' | 'status'>;
type DemoAssignmentUpdateArgs = {
  data: Partial<DemoAssignment>;
  where: Pick<DemoAssignment, 'id'>;
};
type DemoAssignmentUpdateManyArgs = {
  data: Partial<DemoAssignment>;
  where: DemoAssignment;
};
type DemoAssignmentUpsertArgs = {
  create: DemoAssignmentCreate;
  update: Partial<DemoAssignment>;
  where: { shiftId_operatorId: DemoAssignmentIdentity };
};
type DemoPostSessionLookupArgs = {
  where: Pick<DemoPostSession, 'endedAt' | 'operatorId' | 'postId' | 'shiftId' | 'status'>;
};
type DemoPostSessionUpsertArgs = {
  create: Partial<DemoPostSession> &
    Pick<DemoPostSession, 'id' | 'operatorId' | 'postId' | 'shiftId' | 'status'>;
  update: Partial<DemoPostSession>;
  where: Pick<DemoPostSession, 'id'>;
};
type SeedAuthSessionUpdateManyArgs = {
  data: Pick<SeedAuthSession, 'revokedAt'>;
  where: Pick<SeedAuthSession, 'revokedAt' | 'userId'>;
};

const originalRows = () =>
  new Map<string, HistoricalRow>(
    Array.from({ length: 4 }, (_, index) => {
      const sequence = index + 1;
      return [
        `A-1024-roll-${sequence}`,
        {
          rollCode: `A-1024-roll-${sequence}`,
          orderLineId: `corrected-line-${sequence}`,
          positionSequence: 100 + sequence,
          rawMaterialId: `corrected-material-${sequence}`,
          recipeVersion: `corrected-v${sequence}`,
          characteristicsSnapshot: { source: 'commercial-correction', sequence },
          assignedOperatorId: `runtime-operator-${sequence}`,
          machineId: `runtime-machine-${sequence}`,
          postId: `runtime-post-${sequence}`,
          plannedShiftId: `runtime-shift-${sequence}`,
          status: 'in_progress',
          priority: 90 + sequence,
        },
      ] as const;
    }),
  );

function createSeedHarness(rows = originalRows(), options: SeedHarnessOptions = {}) {
  const order = {
    id: 'commercial-order-1',
    positions: [
      {
        id: 'commercial-position-1',
        rawMaterialId: 'seed-material',
        recipe: { version: 'seed-v1', parameters: [{ label: 'seed', value: 'value' }] },
      },
    ],
  };
  let resolveDisconnected: () => void;
  const disconnected = new Promise<void>((resolve) => {
    resolveDisconnected = resolve;
  });

  const rollDispatchItemUpsert = jest.fn(async ({ where, update, create }: UpsertArgs) => {
    const existing = rows.get(where.rollCode);
    if (existing) {
      Object.assign(existing, update);
      return existing;
    }
    const created = { ...create };
    rows.set(where.rollCode, created as HistoricalRow);
    return created;
  });
  const commercialOrderFindUnique = jest.fn(async () => order);
  const genericUpsert = jest.fn(async () => ({}));
  const bigBagUnitUpsert = jest.fn(
    async (_input: {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
      where: Record<string, unknown>;
    }) => ({}),
  );
  const seededUsers: SeedUser[] = [];
  const createSeedUser = (data: Omit<SeedUser, 'id' | 'passwordChangedAt'>): SeedUser => {
    const operatorIndex = ['seed-operator', 'seed-operator-2', 'seed-operator-3'].indexOf(
      data.externalId ?? '',
    );
    return {
      ...data,
      id:
        operatorIndex >= 0
          ? `runtime-operator-${operatorIndex + 1}`
          : `seed-user-${seededUsers.length + 1}`,
      passwordChangedAt: null,
    };
  };
  const userUpsert = jest.fn(
    async ({
      where,
      update,
      create,
    }: {
      where: { login: string };
      update: Partial<SeedUser>;
      create: Omit<SeedUser, 'id' | 'identityProvider' | 'isActive' | 'passwordChangedAt'>;
    }) => {
      const existing = seededUsers.find((user) => user.login === where.login);
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const user = createSeedUser({
        ...create,
        identityProvider: 'local',
        isActive: true,
      });
      seededUsers.push(user);
      return user;
    },
  );
  const userCreate = jest.fn(
    async ({ data }: { data: Omit<SeedUser, 'id' | 'passwordChangedAt'> }) => {
      const user = createSeedUser(data);
      seededUsers.push(user);
      return user;
    },
  );
  const userUpdate = jest.fn(
    async ({ where, data }: { where: { id: string }; data: Partial<SeedUser> }) => {
      const user = seededUsers.find((candidate) => candidate.id === where.id);
      if (!user) throw new Error(`Unknown seed user ${where.id}`);
      Object.assign(user, data);
      return user;
    },
  );
  const userFindUnique = jest.fn(
    async ({
      where,
    }: {
      where: { externalId?: string; login?: string };
    }): Promise<SeedUser | null> => {
      if (where.login !== undefined) {
        return seededUsers.find((user) => user.login === where.login) ?? null;
      }
      return seededUsers.find((user) => user.externalId === where.externalId) ?? null;
    },
  );
  const userFindMany = jest.fn(
    async ({
      where,
    }: {
      where?: { externalId?: { in: string[] } };
    } = {}) => {
      const externalIds = where?.externalId?.in;
      return externalIds
        ? seededUsers.filter(
            (user) => user.externalId !== null && externalIds.includes(user.externalId),
          )
        : seededUsers;
    },
  );
  const authSessions: SeedAuthSession[] = [];
  const sessionUpdateMany = jest.fn(async ({ where, data }: SeedAuthSessionUpdateManyArgs) => {
    let count = 0;
    for (const session of authSessions) {
      if (session.userId !== where.userId || session.revokedAt !== where.revokedAt) continue;
      Object.assign(session, data);
      count += 1;
    }
    return { count };
  });
  if (options.legacyDemoAssignments) {
    for (const account of [
      ['seed-operator', 'ахметов булат', 'Ахметов Булат'],
      ['seed-operator-2', 'хабибулин руслан', 'Хабибулин Руслан'],
      ['seed-operator-3', 'гайнулин ильназ', 'Гайнулин Ильназ'],
    ]) {
      seededUsers.push(
        createSeedUser({
          externalId: account[0],
          login: account[1],
          passwordHash: hashPassword('plenka-dev'),
          identityProvider: 'local',
          displayName: account[2],
          role: 'operator',
          isActive: true,
          mustChangePassword: false,
        }),
      );
    }
    seededUsers.push({
      id: 'runtime-operator-4',
      externalId: 'seed-operator-4',
      login: 'оператор4',
      passwordHash: hashPassword('plenka-dev'),
      identityProvider: 'local',
      displayName: 'Анна Соколова',
      role: 'operator',
      isActive: true,
      mustChangePassword: false,
      passwordChangedAt: null,
    });
    authSessions.push({
      id: 'runtime-operator-4-auth-session',
      userId: 'runtime-operator-4',
      revokedAt: null,
    });
  }
  const warehouseRollUpsert = jest.fn(async ({ where }: { where: { rollCode: string } }) => ({
    id: `warehouse-${where.rollCode}`,
    rollCode: where.rollCode,
  }));
  const warehouseRollFindMany = jest.fn(async () => [
    { rollCode: 'STK-roll-1' },
    { rollCode: 'STK-roll-2' },
  ]);
  const rollScanTokenCreateMany = jest.fn(async () => ({ count: 2 }));
  const materialDefinitions = new Map<string, SeedMaterialDefinition>();
  const materialStocks = new Map<string, SeedMaterialStock>();
  let customDefinitionSequence = 0;
  const rawMaterialDefinitionUpsert = jest.fn(
    async ({
      where,
      create,
      update,
    }: {
      where: { id?: string; normalizedName?: string };
      create: Omit<SeedMaterialDefinition, 'id'> & { id?: string };
      update: Partial<SeedMaterialDefinition>;
    }) => {
      const existing = where.id
        ? materialDefinitions.get(where.id)
        : [...materialDefinitions.values()].find(
            (definition) => definition.normalizedName === where.normalizedName,
          );
      if (existing) {
        Object.assign(existing, update);
        return { ...existing };
      }
      const definition = {
        ...create,
        id: create.id ?? `seed-material-definition-${++customDefinitionSequence}`,
      };
      materialDefinitions.set(definition.id, definition);
      return { ...definition };
    },
  );
  const rawMaterialStockUpsert = jest.fn(
    async ({
      where,
      create,
      update,
    }: {
      where: { materialId: string };
      create: Omit<SeedMaterialStock, 'id' | 'rawMaterialDefinitionId'>;
      update: Partial<SeedMaterialStock>;
    }) => {
      const existing = materialStocks.get(where.materialId);
      if (existing) {
        Object.assign(existing, update);
        return { ...existing };
      }
      const stock: SeedMaterialStock = {
        id: `seed-stock-${where.materialId}`,
        materialId: create.materialId,
        label: create.label,
        rawMaterialDefinitionId: null,
      };
      materialStocks.set(stock.materialId, stock);
      return { ...stock };
    },
  );
  const rollDispatchItemUpdateMany = jest.fn(
    async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const row of rows.values()) {
        const rollCode = where.rollCode as string | { startsWith: string } | undefined;
        const matchesRoll =
          rollCode === undefined ||
          (typeof rollCode === 'string'
            ? row.rollCode === rollCode
            : row.rollCode.startsWith(rollCode.startsWith));
        const matchesFields = ['assignedOperatorId', 'postId', 'machineId', 'plannedShiftId'].every(
          (field) => !(field in where) || row[field as keyof HistoricalRow] === where[field],
        );
        if (!matchesRoll || !matchesFields) continue;
        Object.assign(row, data);
        count += 1;
      }
      return { count };
    },
  );
  const legacyLockedAt = new Date('2026-07-20T08:00:00.000Z');
  const assignments: DemoAssignment[] = options.legacyDemoAssignments
    ? Array.from({ length: 4 }, (_, index) => ({
        id: `legacy-demo-assignment-${index + 1}`,
        shiftId: 'shift-demo',
        operatorId: `runtime-operator-${index + 1}`,
        postId: `POST-${index + 1}`,
        status: 'locked',
        lockedAt: legacyLockedAt,
        previousPostId: null,
        breakdownReason: null,
        reassignedAt: null,
      }))
    : [];
  const postSessions: DemoPostSession[] = options.retiredActivePostSession
    ? [
        {
          id: 'legacy-retired-session',
          operatorId: 'runtime-operator-4',
          postId: 'POST-4',
          shiftId: 'shift-demo',
          status: 'active',
          endedAt: null,
        },
      ]
    : [];
  const assignmentFindUnique = jest.fn(async ({ where }: { where: DemoAssignmentUniqueWhere }) => {
    if (where.id !== undefined) {
      return assignments.find((assignment) => assignment.id === where.id) ?? null;
    }
    const identity = where.shiftId_operatorId;
    return (
      assignments.find(
        (assignment) =>
          assignment.shiftId === identity.shiftId && assignment.operatorId === identity.operatorId,
      ) ?? null
    );
  });
  const assignmentUpdate = jest.fn(async ({ where, data }: DemoAssignmentUpdateArgs) => {
    const assignment = assignments.find((candidate) => candidate.id === where.id);
    if (!assignment) throw new Error(`Unknown demo assignment ${where.id}`);
    Object.assign(assignment, data);
    return assignment;
  });
  const assignmentUpdateMany = jest.fn(async ({ where, data }: DemoAssignmentUpdateManyArgs) => {
    const assignment = assignments.find(
      (candidate) =>
        candidate.id === where.id &&
        candidate.shiftId === where.shiftId &&
        candidate.operatorId === where.operatorId &&
        candidate.postId === where.postId &&
        candidate.status === where.status &&
        candidate.lockedAt?.getTime() === where.lockedAt?.getTime() &&
        candidate.previousPostId === where.previousPostId &&
        candidate.breakdownReason === where.breakdownReason &&
        candidate.reassignedAt === where.reassignedAt,
    );
    if (!assignment) return { count: 0 };
    Object.assign(assignment, data);
    return { count: 1 };
  });
  const assignmentUpsert = jest.fn(async ({ where, update, create }: DemoAssignmentUpsertArgs) => {
    const identity = where.shiftId_operatorId;
    const existing = assignments.find(
      (assignment) =>
        assignment.shiftId === identity.shiftId && assignment.operatorId === identity.operatorId,
    );
    if (existing) {
      Object.assign(existing, update);
      return existing;
    }
    const created = {
      id: `created-demo-assignment-${assignments.length + 1}`,
      lockedAt: null,
      ...create,
    } as DemoAssignment;
    assignments.push(created);
    return created;
  });
  const postSessionFindFirst = jest.fn(
    async ({ where }: DemoPostSessionLookupArgs) =>
      postSessions.find(
        (session) =>
          session.operatorId === where.operatorId &&
          session.shiftId === where.shiftId &&
          session.postId === where.postId &&
          session.status === where.status &&
          session.endedAt === where.endedAt,
      ) ?? null,
  );
  const postSessionUpsert = jest.fn(
    async ({ where, update, create }: DemoPostSessionUpsertArgs) => {
      const existing = postSessions.find((session) => session.id === where.id);
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const created = { endedAt: null, ...create } as DemoPostSession;
      postSessions.push(created);
      return created;
    },
  );
  const postUpsert = jest.fn(async ({ where }: { where: { code: string } }) => ({
    id: where.code,
  }));
  let activeTransactionSnapshot:
    | {
        assignments: DemoAssignment[];
        authSessions: SeedAuthSession[];
        postSessions: DemoPostSession[];
        users: SeedUser[];
      }
    | undefined;
  let interleavingApplied = false;
  const captureTransactionState = () => ({
    assignments: structuredClone(assignments),
    authSessions: structuredClone(authSessions),
    postSessions: structuredClone(postSessions),
    users: structuredClone(seededUsers),
  });
  const restoreTransactionState = (snapshot: ReturnType<typeof captureTransactionState>) => {
    assignments.splice(0, assignments.length, ...structuredClone(snapshot.assignments));
    authSessions.splice(0, authSessions.length, ...structuredClone(snapshot.authSessions));
    postSessions.splice(0, postSessions.length, ...structuredClone(snapshot.postSessions));
    seededUsers.splice(0, seededUsers.length, ...structuredClone(snapshot.users));
  };
  const applyInterleavedRuntimeProgression = () => {
    const assignment = assignments.find(
      (candidate) => candidate.operatorId === 'runtime-operator-4',
    );
    if (!assignment) return;
    Object.assign(assignment, {
      status: 'breakdown_reassigned',
      breakdownReason: 'concurrent runtime progression',
      reassignedAt: new Date('2026-07-20T09:00:00.000Z'),
    });
    postSessions.push({
      id: 'interleaved-retired-session',
      operatorId: 'runtime-operator-4',
      postId: 'POST-4',
      shiftId: 'shift-demo',
      status: 'active',
      endedAt: null,
    });
    if (activeTransactionSnapshot) {
      const snapshotAssignment = activeTransactionSnapshot.assignments.find(
        (candidate) => candidate.operatorId === 'runtime-operator-4',
      );
      if (snapshotAssignment) {
        Object.assign(snapshotAssignment, {
          status: 'breakdown_reassigned',
          breakdownReason: 'concurrent runtime progression',
          reassignedAt: new Date('2026-07-20T09:00:00.000Z'),
        });
      }
      activeTransactionSnapshot.postSessions.push(
        structuredClone(postSessions[postSessions.length - 1]),
      );
    }
  };

  const prisma = {
    user: {
      upsert: userUpsert,
      create: userCreate,
      update: userUpdate,
      findUnique: userFindUnique,
      findMany: userFindMany,
    },
    session: { updateMany: sessionUpdateMany, upsert: jest.fn(async () => ({})) },
    counterparty: {
      upsert: jest.fn(async () => ({ id: 'cp-uralpak' })),
      findUniqueOrThrow: jest.fn(async () => ({ id: 'cp-sibplast' })),
    },
    counterpartyOrderTemplate: { upsert: genericUpsert },
    counterpartyOrderTemplateVersion: { upsert: genericUpsert },
    stockProductionTemplate: {
      upsert: jest.fn(async ({ create }: { create: { id: string } }) => ({ id: create.id })),
    },
    stockProductionTemplateVersion: { upsert: genericUpsert },
    commercialOrder: {
      upsert: jest.fn(async ({ where }: { where: { orderNumber: string } }) => {
        if (where.orderNumber === 'A-1024') return order;
        const rollCount = where.orderNumber === 'A-1025' ? 2 : 1;
        return {
          id: `commercial-${where.orderNumber}`,
          orderNumber: where.orderNumber,
          positions: [{ id: `position-${where.orderNumber}`, rollCount }],
        };
      }),
      findUnique: commercialOrderFindUnique,
    },
    commercialOrderPosition: { update: genericUpsert },
    warehouseCoverProposal: { upsert: genericUpsert },
    productionOrder: { upsert: jest.fn(async () => ({ id: 'production-order-1' })) },
    rollDispatchItem: {
      upsert: rollDispatchItemUpsert,
      findUnique: jest.fn(async ({ where }: { where: { rollCode: string } }) => ({
        id: `dispatch-${where.rollCode}`,
      })),
      updateMany: rollDispatchItemUpdateMany,
    },
    operatorRollLine: { upsert: genericUpsert },
    bigBagUnit: { upsert: bigBagUnitUpsert },
    warehouseAcceptanceTask: { upsert: genericUpsert },
    warehouseRoll: {
      upsert: warehouseRollUpsert,
      update: genericUpsert,
      findMany: warehouseRollFindMany,
    },
    rollScanToken: { createMany: rollScanTokenCreateMany },
    warehouseCoverMatch: { upsert: genericUpsert },
    scanRow: { deleteMany: genericUpsert, create: genericUpsert },
    rawMaterialDefinition: { upsert: rawMaterialDefinitionUpsert },
    rawMaterialStock: {
      upsert: rawMaterialStockUpsert,
      findMany: jest.fn(async () => [...materialStocks.values()].map((stock) => ({ ...stock }))),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { rawMaterialDefinitionId: string };
        }) => {
          const stock = [...materialStocks.values()].find((candidate) => candidate.id === where.id);
          if (!stock) throw new Error(`Unknown material stock ${where.id}`);
          stock.rawMaterialDefinitionId = data.rawMaterialDefinitionId;
          return { ...stock };
        },
      ),
    },
    financeOrder: { upsert: jest.fn(async () => ({ id: 'finance-order-1' })) },
    sourceSnapshot: { upsert: genericUpsert },
    directorDecision: { upsert: genericUpsert },
    penalty: { upsert: genericUpsert },
    accessTemplate: { upsert: genericUpsert },
    post: {
      upsert: postUpsert,
      findUnique: jest.fn(async ({ where }: { where: { code?: string; id?: string } }) =>
        where.code === 'POST-4' || where.id === 'POST-4' ? { id: 'POST-4', code: 'POST-4' } : null,
      ),
    },
    deviceRuntime: { upsert: genericUpsert },
    shift: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id === 'shift-demo' ? { id: 'shift-demo' } : null,
      ),
      upsert: jest.fn(async () => ({ id: 'shift-demo' })),
    },
    operatorShiftMachineAssignment: {
      findUnique: assignmentFindUnique,
      update: assignmentUpdate,
      updateMany: assignmentUpdateMany,
      upsert: assignmentUpsert,
    },
    operatorMachineChange: { findFirst: jest.fn(async () => null) },
    operatorPostSession: {
      findFirst: postSessionFindFirst,
      upsert: postSessionUpsert,
    },
    $queryRaw: jest.fn(async () => {
      if (options.interleaveRetiredProgression && !interleavingApplied) {
        interleavingApplied = true;
        applyInterleavedRuntimeProgression();
      }
      return [];
    }),
    defectBag: { upsert: jest.fn(async () => ({})) },
    defectBagLabelPrintJob: { upsert: jest.fn(async () => ({})) },
    defectBagMovement: { upsert: jest.fn(async () => ({})) },
    $disconnect: jest.fn(async () => resolveDisconnected()),
  };
  const transaction = jest.fn(async (callback: (tx: typeof prisma) => unknown) => {
    activeTransactionSnapshot = captureTransactionState();
    try {
      return await callback(prisma);
    } catch (error) {
      restoreTransactionState(activeTransactionSnapshot);
      throw error;
    } finally {
      activeTransactionSnapshot = undefined;
    }
  });
  const prismaWithTransaction = Object.assign(prisma, { $transaction: transaction });

  return {
    commercialOrderFindUnique,
    disconnected,
    materialDefinitions,
    materialStocks,
    assignments,
    authSessions,
    postSessions,
    postUpsert,
    prisma: prismaWithTransaction,
    rollDispatchItemUpsert,
    rows,
    rollScanTokenCreateMany,
    seededUsers,
    sessionUpdateMany,
    userCreate,
    userUpsert,
    warehouseRollUpsert,
  };
}

async function runSeed(
  harness: ReturnType<typeof createSeedHarness>,
  demoSeedScope: 'full' | 'accounts' = 'full',
): Promise<{ errors: unknown[][] }> {
  const previousSeedProfile = process.env.SEED_PROFILE;
  const previousDemoSeedScope = process.env.DEMO_SEED_SCOPE;
  const previousExitCode = process.exitCode;
  process.env.SEED_PROFILE = 'demo';
  process.env.DEMO_SEED_SCOPE = demoSeedScope;
  jest.resetModules();
  jest.doMock('@prisma/client', () => ({
    ...jest.requireActual<typeof import('@prisma/client')>('@prisma/client'),
    PrismaClient: jest.fn(() => harness.prisma),
  }));
  const logSpy = jest.spyOn(console, 'log').mockImplementation();
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
  const errorSpy = jest.spyOn(console, 'error').mockImplementation();

  try {
    await import('../../prisma/seed');
    await harness.disconnected;
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { errors: errorSpy.mock.calls.map((call) => [...call]) };
  } finally {
    if (previousSeedProfile === undefined) delete process.env.SEED_PROFILE;
    else process.env.SEED_PROFILE = previousSeedProfile;
    if (previousDemoSeedScope === undefined) delete process.env.DEMO_SEED_SCOPE;
    else process.env.DEMO_SEED_SCOPE = previousDemoSeedScope;
    process.exitCode = previousExitCode;
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

describe('production demo seed', () => {
  it('delegates demo account convergence to the shared reconciler in one transaction', () => {
    expect(seedSource).toContain('reconcileSeedAccounts(tx, {');
    expect(seedSource).toContain('accounts: PILOT_ACCOUNT_MANIFEST');
    expect(seedSource).toContain('retiredExternalIds: RETIRED_PILOT_ACCOUNT_EXTERNAL_IDS');
    expect(seedSource).toContain('new SeedAccountConflictError(message)');
    expect(seedSource).toContain('error instanceof SeedAccountConflictError');
    expect(seedSource).not.toContain('prisma.user.upsert');
  });

  it('assigns demo machine rows to only three active operators', () => {
    expect(seedSource).toContain("in: ['seed-operator', 'seed-operator-2', 'seed-operator-3']");
    expect(seedSource).not.toContain("{ externalId: 'seed-operator-4', postCode: 'POST-4' }");
    expect(seedSource).toContain('including three operators');
  });

  it('converges POST-1 and POST-4 to the corrected machine names on every run', async () => {
    const harness = createSeedHarness();

    await runSeed(harness);
    await runSeed(harness);

    const calls = harness.postUpsert.mock.calls
      .map(
        ([input]) =>
          input as { create: { name: string }; update: { name: string }; where: { code: string } },
      )
      .filter(({ where }) => where.code === 'POST-1' || where.code === 'POST-4');
    expect(calls).toHaveLength(4);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          where: { code: 'POST-1' },
          create: expect.objectContaining({ name: 'Китайка старая' }),
          update: expect.objectContaining({ name: 'Китайка старая' }),
        }),
        expect.objectContaining({
          where: { code: 'POST-4' },
          create: expect.objectContaining({ name: 'Бегемот' }),
          update: expect.objectContaining({ name: 'Бегемот' }),
        }),
      ]),
    );
  });

  it('seeds only accounts when the explicit demo scope is accounts', async () => {
    const harness = createSeedHarness();

    await runSeed(harness, 'accounts');

    expect(harness.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(harness.userCreate).toHaveBeenCalledTimes(9);
    expect(harness.seededUsers).toHaveLength(9);
    expect(harness.userUpsert).not.toHaveBeenCalled();
    expect(harness.prisma.commercialOrder.upsert).not.toHaveBeenCalled();
    expect(harness.prisma.productionOrder.upsert).not.toHaveBeenCalled();
    expect(harness.prisma.operatorRollLine.upsert).not.toHaveBeenCalled();
    expect(harness.prisma.warehouseRoll.upsert).not.toHaveBeenCalled();
    expect(harness.prisma.financeOrder.upsert).not.toHaveBeenCalled();
    expect(harness.prisma.post.upsert).not.toHaveBeenCalled();
    expect(harness.prisma.defectBag.upsert).not.toHaveBeenCalled();
  });

  it('creates operator test bags ready for production without rewinding existing bags', async () => {
    const harness = createSeedHarness();

    await runSeed(harness);

    expect(harness.prisma.bigBagUnit.upsert).toHaveBeenCalledTimes(4);
    const calls = harness.prisma.bigBagUnit.upsert.mock.calls as unknown as Array<
      [{ create: Record<string, unknown>; update: Record<string, unknown> }]
    >;
    for (const [input] of calls) {
      expect(input.update).toEqual({});
      expect(input.create).toEqual(
        expect.objectContaining({
          status: 'available',
          registrationStatus: 'registered',
          location: 'production',
          locationRevision: 1,
          scanToken: {
            create: {
              token: expect.stringMatching(/^bbt_[0-9a-f]{64}$/u),
            },
          },
        }),
      );
    }
  });

  it('rejects direct V2 fixture seeding outside development and test', async () => {
    await expect(
      seedWarehouseCoverageV2Fixtures(
        {} as never,
        {
          appEnv: 'pilot',
          includeWarehouseCoverageV2Fixtures: true,
        } as never,
      ),
    ).rejects.toThrow('development/test only');
  });

  it('does not enable V2 fixtures through an environment-shaped release toggle', async () => {
    const previous = process.env.SEED_WAREHOUSE_COVERAGE_V2_FIXTURES;
    process.env.SEED_WAREHOUSE_COVERAGE_V2_FIXTURES = 'true';
    const harness = createSeedHarness();

    try {
      await runSeed(harness);
    } finally {
      if (previous === undefined) {
        delete process.env.SEED_WAREHOUSE_COVERAGE_V2_FIXTURES;
      } else {
        process.env.SEED_WAREHOUSE_COVERAGE_V2_FIXTURES = previous;
      }
    }

    expect(
      harness.prisma.commercialOrder.upsert.mock.calls.some(([args]) => {
        const create = (args as { create?: Record<string, unknown> }).create;
        return (
          create?.warehouseCoverageWorkflowVersion === 2 ||
          String(create?.orderNumber ?? '').startsWith('V2-COVER-')
        );
      }),
    ).toBe(false);
  });

  it('seeds an unreserved compatible roll for commercial cover decisions', async () => {
    const harness = createSeedHarness();
    await runSeed(harness);

    const freeRollCall = harness.warehouseRollUpsert.mock.calls
      .map(([args]) => args)
      .find(({ where }) => where.rollCode === 'SEED-COVER-FREE-1');

    expect(freeRollCall).toEqual(
      expect.objectContaining({
        update: expect.objectContaining({
          warehouseStatus: 'received',
          reservedForOrderId: null,
          reservedForPositionId: null,
          reservedByProposalId: null,
          reservedAt: null,
          positionSnapshot: expect.objectContaining({
            filmType: 'Рукав',
            actualThickness: '80 мкм',
            birka: 'Прозрачная',
            spoolType: 'Шпуля 76 мм',
            plannedWeightKg: 41.2,
          }),
        }),
      }),
    );
    expect(harness.rollScanTokenCreateMany).toHaveBeenCalledWith({
      data: [{ rollCode: 'STK-roll-1' }, { rollCode: 'STK-roll-2' }],
      skipDuplicates: true,
    });
    expect(harness.prisma.scanRow.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ scannedByName: 'Склад' }),
    });
    expect(
      [...harness.materialDefinitions.values()].filter((definition) => definition.kind === 'base'),
    ).toHaveLength(6);
    expect(
      [...harness.materialStocks.values()].every((stock) => stock.rawMaterialDefinitionId !== null),
    ).toBe(true);
    expect(
      harness.prisma.commercialOrder.upsert.mock.calls.every(([args]) => {
        const upsertArgs = args as unknown as {
          create?: Record<string, unknown>;
          update?: Record<string, unknown>;
        };
        const { create, update } = upsertArgs;
        return (
          (create?.warehouseCoverageWorkflowVersion ?? 1) === 1 &&
          !Object.prototype.hasOwnProperty.call(update ?? {}, 'warehouseCoverageWorkflowVersion')
        );
      }),
    ).toBe(true);
  });

  it('seeds stable ready and received defect-bag demo queues only in the full profile', async () => {
    const harness = createSeedHarness();

    await runSeed(harness);
    const warehouseId = harness.seededUsers.find(
      ({ externalId }) => externalId === 'seed-warehouse',
    )?.id;

    expect(harness.prisma.defectBag.upsert).toHaveBeenCalledTimes(2);
    expect(harness.prisma.defectBag.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {},
        create: expect.objectContaining({
          code: 'DEF-DEMO-READY',
          status: 'ready_for_warehouse',
          defectType: 'secondary',
          scanToken: { create: { token: `bbt_${'a'.repeat(64)}` } },
        }),
      }),
    );
    expect(harness.prisma.defectBag.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {},
        create: expect.objectContaining({
          code: 'DEF-DEMO-RECEIVED',
          status: 'received',
          defectType: 'aika',
          scanToken: { create: { token: `bbt_${'b'.repeat(64)}` } },
        }),
      }),
    );
    expect(harness.prisma.defectBagLabelPrintJob.upsert).toHaveBeenCalledTimes(2);
    expect(harness.prisma.operatorPostSession.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sess-demo-defect-ready' },
        create: expect.objectContaining({ status: 'closed', endedAt: expect.any(Date) }),
      }),
    );
    for (const model of [
      harness.prisma.defectBag,
      harness.prisma.defectBagLabelPrintJob,
      harness.prisma.defectBagMovement,
    ]) {
      for (const [input] of model.upsert.mock.calls as unknown as Array<[{ update: unknown }]>) {
        expect(input.update).toEqual({});
      }
    }
    expect(harness.prisma.defectBagMovement.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {},
        create: expect.objectContaining({
          defectBagId: 'defect-bag-demo-received',
          kind: 'receive',
          actorId: warehouseId,
          postId: null,
          deviceId: null,
          captureChannel: 'warehouse_browser_hid',
        }),
      }),
    );
  });

  it('leaves every existing dispatch row unchanged through the entire seed', async () => {
    const harness = createSeedHarness();
    const before = structuredClone([...harness.rows]);
    await runSeed(harness);

    expect([...harness.rows]).toEqual(before);
    const dispatchCalls = harness.rollDispatchItemUpsert.mock.calls.map(([args]) => args);
    expect(dispatchCalls).toHaveLength(4);
    expect(dispatchCalls.every(({ update }) => Object.keys(update).length === 0)).toBe(true);
    expect(harness.commercialOrderFindUnique).toHaveBeenCalledWith({
      where: { orderNumber: 'A-1024' },
      include: { positions: { orderBy: { id: 'asc' }, include: { recipe: true } } },
    });
  });

  it('retains the material snapshot when a dispatch row is missing', () => {
    const upsert = buildRollDispatchItemSeedUpsert({
      productionOrderId: 'production-order-1',
      position: {
        id: 'commercial-position-1',
        rawMaterialId: 'seed-material',
        recipe: {
          version: 'seed-v1',
          parameters: [{ label: 'seed', value: 'value' }],
        },
      },
      sequence: 1,
      roll: { rollCode: 'A-1024-roll-1', assignedOperatorId: 'operator-1', status: 'assigned' },
    });

    expect(upsert.update).toEqual({});
    expect(upsert.create).toEqual(
      expect.objectContaining({
        orderLineId: 'commercial-position-1',
        positionSequence: 1,
        rawMaterialId: 'seed-material',
        recipeVersion: 'seed-v1',
        characteristicsSnapshot: {
          rawMaterialId: 'seed-material',
          recipeVersion: 'seed-v1',
          recipeParameters: [{ label: 'seed', value: 'value' }],
        },
      }),
    );
  });

  it('initializes demo routing and shift when their seed fields are empty', async () => {
    const rows = originalRows();
    for (const row of rows.values()) {
      row.postId = null;
      row.machineId = null;
      row.plannedShiftId = null;
    }
    const harness = createSeedHarness(rows);

    await runSeed(harness);

    expect([...harness.rows.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rollCode: 'A-1024-roll-1',
          postId: 'POST-1',
          machineId: 'POST-1',
          plannedShiftId: 'shift-demo',
        }),
        ...Array.from({ length: 3 }, (_, index) =>
          expect.objectContaining({
            rollCode: `A-1024-roll-${index + 2}`,
            postId: 'POST-1',
            machineId: 'POST-1',
            plannedShiftId: null,
          }),
        ),
      ]),
    );
  });

  it('does not assign the demo shift to a roll routed to another post', async () => {
    const rows = originalRows();
    const reroutedRoll = rows.get('A-1024-roll-1');
    if (!reroutedRoll) throw new Error('roll-1 fixture is missing');
    reroutedRoll.plannedShiftId = null;
    const before = structuredClone([...rows]);
    const harness = createSeedHarness(rows);

    await runSeed(harness);

    expect([...harness.rows]).toEqual(before);
  });

  it('retains the retired demo assignment as completed without rewriting assignment history', async () => {
    const harness = createSeedHarness(originalRows(), { legacyDemoAssignments: true });
    const before = structuredClone(harness.assignments);

    await runSeed(harness);
    await runSeed(harness);

    expect(harness.assignments).toEqual(
      before.map((assignment) =>
        assignment.operatorId === 'runtime-operator-4'
          ? { ...assignment, status: 'completed' }
          : assignment,
      ),
    );
    expect(
      harness.assignments.filter((assignment) => assignment.status !== 'completed'),
    ).toHaveLength(3);
  });

  it('rejects retiring a demo assignment with an active post session without rewriting it', async () => {
    const harness = createSeedHarness(originalRows(), {
      legacyDemoAssignments: true,
      retiredActivePostSession: true,
    });
    const before = structuredClone(harness.assignments);
    const beforeUsers = structuredClone(harness.seededUsers);
    const beforeAuthSessions = structuredClone(harness.authSessions);

    const result = await runSeed(harness);

    expect(result.errors.flat().join(' ')).toContain('Seed account conflict');
    expect(harness.assignments).toEqual(before);
    expect(harness.seededUsers).toEqual(beforeUsers);
    expect(harness.authSessions).toEqual(beforeAuthSessions);
  });

  it('rejects concurrent retired assignment progression after lookup without partial writes', async () => {
    const harness = createSeedHarness(originalRows(), {
      legacyDemoAssignments: true,
      interleaveRetiredProgression: true,
    });
    const beforeUsers = structuredClone(harness.seededUsers);
    const beforeAuthSessions = structuredClone(harness.authSessions);

    const result = await runSeed(harness);

    expect(result.errors.flat().join(' ')).toContain('Seed account conflict');
    expect(harness.seededUsers).toEqual(beforeUsers);
    expect(harness.authSessions).toEqual(beforeAuthSessions);
    expect(
      harness.assignments.find((assignment) => assignment.operatorId === 'runtime-operator-4'),
    ).toEqual(
      expect.objectContaining({
        status: 'breakdown_reassigned',
        breakdownReason: 'concurrent runtime progression',
      }),
    );
    expect(harness.postSessions).toEqual([
      expect.objectContaining({ id: 'interleaved-retired-session', status: 'active' }),
    ]);
  });
});
