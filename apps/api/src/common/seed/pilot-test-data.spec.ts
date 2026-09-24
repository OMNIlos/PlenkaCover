import type { Prisma } from '@prisma/client';
import { PilotTestDataError, seedPilotTestData } from './pilot-test-data';

type PilotAssignment = {
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

type PilotDispatch = {
  assignedOperatorId: string | null;
  completedAt: Date | null;
  id: string;
  machineId: string | null;
  plannedShiftId: string | null;
  postId: string | null;
  rollCode: string;
  status: string;
};

type PilotLine = {
  deferredFromStep: string | null;
  grossKg: number | null;
  id: string;
  labelState: string;
  netKg: number | null;
  rollDispatchItemId: string;
  spoolKg: number | null;
  step: string;
  toleranceOk: boolean | null;
  warehouseState: string;
};

type PilotMaterialStock = {
  id: string;
  label: string;
  rawMaterialDefinitionId: string | null;
};

type HarnessOptions = {
  assignment?: PilotAssignment;
  conflictingTargetAssignment?: PilotAssignment;
  dispatch?: PilotDispatch;
  hasMachineChange?: boolean;
  hasSession?: boolean;
  interleaveLineProgression?: boolean;
  line?: PilotLine;
  lineEvidenceCount?: number;
  omitRetiredOperator?: boolean;
  targetAssignment?: PilotAssignment;
};

type AsyncMockMethod<Args> = (args: Args) => Promise<unknown>;

type PilotPrismaMockFacade = {
  $queryRaw: (query: Prisma.Sql) => Promise<unknown>;
  bigBagUnit: { upsert: AsyncMockMethod<Prisma.BigBagUnitUpsertArgs> };
  commercialOrder: { upsert: AsyncMockMethod<Prisma.CommercialOrderUpsertArgs> };
  counterparty: { upsert: AsyncMockMethod<Prisma.CounterpartyUpsertArgs> };
  defectRecord: { count: AsyncMockMethod<Prisma.DefectRecordCountArgs> };
  financeOrder: {
    updateMany: AsyncMockMethod<Prisma.FinanceOrderUpdateManyArgs>;
    upsert: AsyncMockMethod<Prisma.FinanceOrderUpsertArgs>;
  };
  labelPrintJob: { count: AsyncMockMethod<Prisma.LabelPrintJobCountArgs> };
  operatorMachineChange: {
    findFirst: AsyncMockMethod<Prisma.OperatorMachineChangeFindFirstArgs>;
  };
  operatorPostSession: {
    findFirst: AsyncMockMethod<Prisma.OperatorPostSessionFindFirstArgs>;
    upsert: AsyncMockMethod<Prisma.OperatorPostSessionUpsertArgs>;
  };
  operatorRollLine: {
    findUnique: AsyncMockMethod<Prisma.OperatorRollLineFindUniqueArgs>;
    upsert: AsyncMockMethod<Prisma.OperatorRollLineUpsertArgs>;
  };
  operatorRollOperation: { count: AsyncMockMethod<Prisma.OperatorRollOperationCountArgs> };
  operatorShiftMachineAssignment: {
    findFirst: AsyncMockMethod<Prisma.OperatorShiftMachineAssignmentFindFirstArgs>;
    findUnique: AsyncMockMethod<Prisma.OperatorShiftMachineAssignmentFindUniqueArgs>;
    updateMany: AsyncMockMethod<Prisma.OperatorShiftMachineAssignmentUpdateManyArgs>;
    upsert: AsyncMockMethod<Prisma.OperatorShiftMachineAssignmentUpsertArgs>;
  };
  paymentOperation: { upsert: AsyncMockMethod<Prisma.PaymentOperationUpsertArgs> };
  paymentPolicy: { upsert: AsyncMockMethod<Prisma.PaymentPolicyUpsertArgs> };
  paymentPolicyStage: { upsert: AsyncMockMethod<Prisma.PaymentPolicyStageUpsertArgs> };
  paymentSchedule: { upsert: AsyncMockMethod<Prisma.PaymentScheduleUpsertArgs> };
  post: { findUnique: AsyncMockMethod<Prisma.PostFindUniqueArgs> };
  productionOrder: { upsert: AsyncMockMethod<Prisma.ProductionOrderUpsertArgs> };
  rawMaterialDefinition: {
    upsert: AsyncMockMethod<Prisma.RawMaterialDefinitionUpsertArgs>;
  };
  rawMaterialStock: {
    findMany: AsyncMockMethod<Prisma.RawMaterialStockFindManyArgs>;
    update: AsyncMockMethod<Prisma.RawMaterialStockUpdateArgs>;
    upsert: AsyncMockMethod<Prisma.RawMaterialStockUpsertArgs>;
  };
  rollDispatchItem: {
    findUnique: AsyncMockMethod<Prisma.RollDispatchItemFindUniqueArgs>;
    updateMany: AsyncMockMethod<Prisma.RollDispatchItemUpdateManyArgs>;
    upsert: AsyncMockMethod<Prisma.RollDispatchItemUpsertArgs>;
  };
  shift: { upsert: AsyncMockMethod<Prisma.ShiftUpsertArgs> };
  shiftBagUsage: { upsert: AsyncMockMethod<Prisma.ShiftBagUsageUpsertArgs> };
  user: { findUnique: AsyncMockMethod<Prisma.UserFindUniqueArgs> };
  warehouseAcceptanceTask: {
    upsert: AsyncMockMethod<Prisma.WarehouseAcceptanceTaskUpsertArgs>;
  };
  weightCapture: { count: AsyncMockMethod<Prisma.WeightCaptureCountArgs> };
};

function createOnlyUpsert<Args extends { create: object }>() {
  return jest.fn(async (args: Args) => args.create);
}

function stringField(input: object, field: string): string | undefined {
  const value: unknown = Reflect.get(input, field);
  return typeof value === 'string' ? value : undefined;
}

function requiredStringField(input: object, field: string, context: string): string {
  const value = stringField(input, field);
  if (value !== undefined) return value;
  throw new Error(`${context} requires scalar field "${field}"`);
}

function nullableStringField(input: object, field: string, context: string): string | null {
  const value: unknown = Reflect.get(input, field);
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  throw new Error(`${context} requires nullable scalar field "${field}"`);
}

function nullableDateField(input: object, field: string, context: string): Date | null {
  const value: unknown = Reflect.get(input, field);
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  throw new Error(`${context} requires nullable date scalar field "${field}"`);
}

function nullableNumberField(input: object, field: string, context: string): number | null {
  const value: unknown = Reflect.get(input, field);
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return value;
  throw new Error(`${context} requires nullable number scalar field "${field}"`);
}

function nullableBooleanField(input: object, field: string, context: string): boolean | null {
  const value: unknown = Reflect.get(input, field);
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  throw new Error(`${context} requires nullable boolean scalar field "${field}"`);
}

function pristineLegacySimulatorFixture(): Required<
  Pick<HarnessOptions, 'assignment' | 'dispatch' | 'line'>
> {
  return {
    assignment: {
      id: 'pilot-test-assignment-post-5',
      shiftId: 'pilot-test-shift-001',
      operatorId: 'operator-4-id',
      postId: 'post-5-id',
      status: 'planned',
      lockedAt: null,
      previousPostId: null,
      breakdownReason: null,
      reassignedAt: null,
    },
    dispatch: {
      id: 'pilot-test-dispatch-2',
      rollCode: 'PILOT-SIM-ROLL-001',
      assignedOperatorId: 'operator-4-id',
      postId: 'post-5-id',
      machineId: 'POST-5',
      plannedShiftId: 'pilot-test-shift-001',
      status: 'assigned',
      completedAt: null,
    },
    line: {
      id: 'pilot-test-operator-line-2',
      rollDispatchItemId: 'pilot-test-dispatch-2',
      step: 'assigned',
      deferredFromStep: null,
      spoolKg: null,
      grossKg: null,
      netKg: null,
      toleranceOk: null,
      labelState: 'not_printed',
      warehouseState: 'not_ready',
    },
  };
}

function createHarness(options: HarnessOptions = {}) {
  const users = new Map([
    ['seed-operator', { id: 'operator-id', externalId: 'seed-operator' }],
    ['seed-operator-3', { id: 'operator-3-id', externalId: 'seed-operator-3' }],
  ]);
  if (!options.omitRetiredOperator) {
    users.set('seed-operator-4', {
      id: 'operator-4-id',
      externalId: 'seed-operator-4',
    });
  }
  const posts = new Map([
    ['POST-1', { id: 'post-1-id', code: 'POST-1' }],
    ['POST-5', { id: 'post-5-id', code: 'POST-5' }],
  ]);
  const assignments = [
    options.assignment,
    options.targetAssignment,
    options.conflictingTargetAssignment,
  ]
    .filter((assignment): assignment is PilotAssignment => assignment !== undefined)
    .map((assignment) => ({ ...assignment }));
  const dispatches = options.dispatch ? [{ ...options.dispatch }] : [];
  const lines = options.line ? [{ ...options.line }] : [];
  const materialStocks: PilotMaterialStock[] = [
    {
      id: 'pilot-material-stock-unlinked',
      label: 'Пилот · ПВД 15803-020',
      rawMaterialDefinitionId: null,
    },
  ];
  const customDefinitionIds = new Map<string, string>();
  let interleavingApplied = false;
  const assignmentUpsert = jest.fn(
    async ({ where, create }: Prisma.OperatorShiftMachineAssignmentUpsertArgs) => {
      const identity = where.shiftId_operatorId;
      if (!identity) throw new Error('Assignment upsert requires shift/operator identity');
      const existing = assignments.find(
        (assignment) =>
          assignment.shiftId === identity.shiftId && assignment.operatorId === identity.operatorId,
      );
      if (existing) return existing;
      const created: PilotAssignment = {
        id: stringField(create, 'id') ?? `pilot-test-assignment-created-${assignments.length + 1}`,
        shiftId: requiredStringField(create, 'shiftId', 'assignment create'),
        operatorId: requiredStringField(create, 'operatorId', 'assignment create'),
        postId: requiredStringField(create, 'postId', 'assignment create'),
        status: stringField(create, 'status') ?? 'planned',
        lockedAt: nullableDateField(create, 'lockedAt', 'assignment create'),
        previousPostId: nullableStringField(create, 'previousPostId', 'assignment create'),
        breakdownReason: nullableStringField(create, 'breakdownReason', 'assignment create'),
        reassignedAt: nullableDateField(create, 'reassignedAt', 'assignment create'),
      };
      assignments.push(created);
      return created;
    },
  );
  const assignmentUpdateMany = jest.fn(
    async ({ where, data }: Prisma.OperatorShiftMachineAssignmentUpdateManyArgs) => {
      if (!where) return { count: 0 };
      const assignment = assignments.find(
        (candidate) =>
          candidate.id === where.id &&
          candidate.shiftId === where.shiftId &&
          candidate.operatorId === where.operatorId &&
          candidate.postId === where.postId &&
          candidate.status === where.status &&
          candidate.lockedAt === where.lockedAt &&
          candidate.previousPostId === where.previousPostId &&
          candidate.breakdownReason === where.breakdownReason &&
          candidate.reassignedAt === where.reassignedAt,
      );
      if (!assignment) return { count: 0 };
      Object.assign(assignment, data);
      return { count: 1 };
    },
  );
  const dispatchUpsert = jest.fn(async ({ where, create }: Prisma.RollDispatchItemUpsertArgs) => {
    const existing = dispatches.find((dispatch) => dispatch.rollCode === where.rollCode);
    if (existing) return existing;
    requiredStringField(create, 'productionOrderId', 'dispatch create');
    const created: PilotDispatch = {
      id: stringField(create, 'id') ?? `pilot-test-dispatch-created-${dispatches.length + 1}`,
      rollCode: requiredStringField(create, 'rollCode', 'dispatch create'),
      assignedOperatorId: nullableStringField(create, 'assignedOperatorId', 'dispatch create'),
      postId: nullableStringField(create, 'postId', 'dispatch create'),
      machineId: nullableStringField(create, 'machineId', 'dispatch create'),
      plannedShiftId: nullableStringField(create, 'plannedShiftId', 'dispatch create'),
      status: stringField(create, 'status') ?? 'new',
      completedAt: nullableDateField(create, 'completedAt', 'dispatch create'),
    };
    dispatches.push(created);
    return created;
  });
  const dispatchUpdateMany = jest.fn(
    async ({ where, data }: Prisma.RollDispatchItemUpdateManyArgs) => {
      if (!where) return { count: 0 };
      const dispatch = dispatches.find(
        (candidate) =>
          candidate.id === where.id &&
          candidate.rollCode === where.rollCode &&
          candidate.assignedOperatorId === where.assignedOperatorId &&
          candidate.postId === where.postId &&
          candidate.machineId === where.machineId &&
          candidate.plannedShiftId === where.plannedShiftId &&
          candidate.status === where.status &&
          candidate.completedAt === where.completedAt,
      );
      if (!dispatch) return { count: 0 };
      Object.assign(dispatch, data);
      return { count: 1 };
    },
  );
  const lineUpsert = jest.fn(async ({ where, create }: Prisma.OperatorRollLineUpsertArgs) => {
    const existing = lines.find((line) => line.rollDispatchItemId === where.rollDispatchItemId);
    if (existing) return existing;
    const created: PilotLine = {
      id: stringField(create, 'id') ?? `pilot-test-line-created-${lines.length + 1}`,
      rollDispatchItemId: requiredStringField(create, 'rollDispatchItemId', 'operator line create'),
      step: stringField(create, 'step') ?? 'assigned',
      deferredFromStep: nullableStringField(create, 'deferredFromStep', 'operator line create'),
      spoolKg: nullableNumberField(create, 'spoolKg', 'operator line create'),
      grossKg: nullableNumberField(create, 'grossKg', 'operator line create'),
      netKg: nullableNumberField(create, 'netKg', 'operator line create'),
      toleranceOk: nullableBooleanField(create, 'toleranceOk', 'operator line create'),
      labelState: stringField(create, 'labelState') ?? 'not_printed',
      warehouseState: stringField(create, 'warehouseState') ?? 'not_ready',
    };
    lines.push(created);
    return created;
  });
  const rawMaterialDefinitionUpsert = jest.fn(
    async ({ create }: Prisma.RawMaterialDefinitionUpsertArgs) => {
      const explicitId = stringField(create, 'id');
      if (explicitId) return { ...create, id: explicitId };
      const normalizedName = stringField(create, 'normalizedName') ?? '';
      const id =
        customDefinitionIds.get(normalizedName) ??
        `pilot-material-definition-custom-${customDefinitionIds.size + 1}`;
      customDefinitionIds.set(normalizedName, id);
      return { ...create, id };
    },
  );
  const rawMaterialStockFindMany = jest.fn(
    async (_args: Prisma.RawMaterialStockFindManyArgs) => materialStocks,
  );
  const rawMaterialStockUpdate = jest.fn(
    async ({ where, data }: Prisma.RawMaterialStockUpdateArgs) => {
      const stock = materialStocks.find(
        (candidate) => typeof where.id === 'string' && candidate.id === where.id,
      );
      if (!stock) throw new Error(`Unknown material stock ${String(where.id)}`);
      const nextDefinitionId: unknown = Reflect.get(data, 'rawMaterialDefinitionId');
      stock.rawMaterialDefinitionId =
        typeof nextDefinitionId === 'string' ? nextDefinitionId : null;
      return stock;
    },
  );

  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: Prisma.UserFindUniqueArgs) =>
        typeof where.externalId === 'string' ? (users.get(where.externalId) ?? null) : null,
      ),
    },
    post: {
      findUnique: jest.fn(async ({ where }: Prisma.PostFindUniqueArgs) =>
        typeof where.code === 'string' ? (posts.get(where.code) ?? null) : null,
      ),
    },
    counterparty: { upsert: createOnlyUpsert<Prisma.CounterpartyUpsertArgs>() },
    commercialOrder: {
      upsert: jest.fn(async ({ create }: Prisma.CommercialOrderUpsertArgs) => ({
        ...create,
        id: 'pilot-test-order-001',
        positions: [{ id: 'pilot-test-position-001' }],
      })),
    },
    productionOrder: { upsert: createOnlyUpsert<Prisma.ProductionOrderUpsertArgs>() },
    rollDispatchItem: {
      findUnique: jest.fn(async ({ where }: Prisma.RollDispatchItemFindUniqueArgs) => {
        if (typeof where.id === 'string') {
          return dispatches.find((dispatch) => dispatch.id === where.id) ?? null;
        }
        return typeof where.rollCode === 'string'
          ? (dispatches.find((dispatch) => dispatch.rollCode === where.rollCode) ?? null)
          : null;
      }),
      updateMany: dispatchUpdateMany,
      upsert: dispatchUpsert,
    },
    operatorRollLine: {
      findUnique: jest.fn(async ({ where }: Prisma.OperatorRollLineFindUniqueArgs) =>
        typeof where.rollDispatchItemId === 'string'
          ? (lines.find((line) => line.rollDispatchItemId === where.rollDispatchItemId) ?? null)
          : null,
      ),
      upsert: lineUpsert,
    },
    weightCapture: {
      count: jest.fn(
        async (_args: Prisma.WeightCaptureCountArgs) => options.lineEvidenceCount ?? 0,
      ),
    },
    defectRecord: {
      count: jest.fn(async (_args: Prisma.DefectRecordCountArgs) => options.lineEvidenceCount ?? 0),
    },
    labelPrintJob: {
      count: jest.fn(
        async (_args: Prisma.LabelPrintJobCountArgs) => options.lineEvidenceCount ?? 0,
      ),
    },
    operatorRollOperation: {
      count: jest.fn(
        async (_args: Prisma.OperatorRollOperationCountArgs) => options.lineEvidenceCount ?? 0,
      ),
    },
    operatorMachineChange: {
      findFirst: jest.fn(async (_args: Prisma.OperatorMachineChangeFindFirstArgs) =>
        options.hasMachineChange ? { id: 'machine-change-1' } : null,
      ),
    },
    rawMaterialDefinition: { upsert: rawMaterialDefinitionUpsert },
    rawMaterialStock: {
      upsert: createOnlyUpsert<Prisma.RawMaterialStockUpsertArgs>(),
      findMany: rawMaterialStockFindMany,
      update: rawMaterialStockUpdate,
    },
    bigBagUnit: { upsert: createOnlyUpsert<Prisma.BigBagUnitUpsertArgs>() },
    shift: { upsert: createOnlyUpsert<Prisma.ShiftUpsertArgs>() },
    operatorShiftMachineAssignment: {
      findFirst: jest.fn(
        async (_args: Prisma.OperatorShiftMachineAssignmentFindFirstArgs) =>
          options.conflictingTargetAssignment ?? null,
      ),
      findUnique: jest.fn(
        async ({ where }: Prisma.OperatorShiftMachineAssignmentFindUniqueArgs) => {
          if (typeof where.id === 'string') {
            return assignments.find((assignment) => assignment.id === where.id) ?? null;
          }
          const identity = where.shiftId_operatorId;
          return identity
            ? (assignments.find(
                (assignment) =>
                  assignment.shiftId === identity.shiftId &&
                  assignment.operatorId === identity.operatorId,
              ) ?? null)
            : null;
        },
      ),
      updateMany: assignmentUpdateMany,
      upsert: assignmentUpsert,
    },
    operatorPostSession: {
      findFirst: jest.fn(async (_args: Prisma.OperatorPostSessionFindFirstArgs) =>
        options.hasSession ? { id: 'session-1' } : null,
      ),
      upsert: createOnlyUpsert<Prisma.OperatorPostSessionUpsertArgs>(),
    },
    shiftBagUsage: { upsert: createOnlyUpsert<Prisma.ShiftBagUsageUpsertArgs>() },
    warehouseAcceptanceTask: {
      upsert: createOnlyUpsert<Prisma.WarehouseAcceptanceTaskUpsertArgs>(),
    },
    financeOrder: {
      upsert: createOnlyUpsert<Prisma.FinanceOrderUpsertArgs>(),
      updateMany: jest.fn(async (_args: Prisma.FinanceOrderUpdateManyArgs) => ({
        count: 1,
      })),
    },
    paymentPolicy: { upsert: createOnlyUpsert<Prisma.PaymentPolicyUpsertArgs>() },
    paymentPolicyStage: {
      upsert: createOnlyUpsert<Prisma.PaymentPolicyStageUpsertArgs>(),
    },
    paymentSchedule: { upsert: createOnlyUpsert<Prisma.PaymentScheduleUpsertArgs>() },
    paymentOperation: { upsert: createOnlyUpsert<Prisma.PaymentOperationUpsertArgs>() },
    $queryRaw: jest.fn(async (_query: Prisma.Sql) => {
      if (options.interleaveLineProgression && !interleavingApplied) {
        interleavingApplied = true;
        Object.assign(lines[0], { step: 'spool_weight', spoolKg: 1.2 });
      }
      return [];
    }),
  } satisfies PilotPrismaMockFacade;
  const transactionClient = prisma as unknown as Prisma.TransactionClient;
  return {
    assignments,
    dispatches,
    lines,
    materialStocks,
    prisma,
    transactionClient,
  };
}

describe('seedPilotTestData', () => {
  it('plans physical and simulated lanes without opening an operator shift', async () => {
    const { materialStocks, prisma, transactionClient } = createHarness();

    await seedPilotTestData(transactionClient);

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { externalId: 'seed-operator' },
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { externalId: 'seed-operator-3' },
    });
    expect(prisma.rawMaterialStock.update).toHaveBeenCalledWith({
      where: { id: 'pilot-material-stock-unlinked' },
      data: { rawMaterialDefinitionId: 'pilot-material-definition-custom-1' },
    });
    expect(materialStocks[0].rawMaterialDefinitionId).toBe('pilot-material-definition-custom-1');
    expect(prisma.commercialOrder.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ productionIndicator: 'in_production' }),
      }),
    );
    expect(prisma.rollDispatchItem.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.rollDispatchItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          rollCode: 'PILOT-PHYSICAL-ROLL-001',
          assignedOperatorId: 'operator-id',
          postId: 'post-1-id',
          machineId: 'POST-1',
          status: 'assigned',
        }),
      }),
    );
    expect(prisma.rollDispatchItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          rollCode: 'PILOT-SIM-ROLL-001',
          assignedOperatorId: 'operator-3-id',
          postId: 'post-5-id',
          machineId: 'POST-5',
          status: 'assigned',
        }),
      }),
    );
    expect(prisma.shift.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'planned', startedAt: null }),
      }),
    );
    expect(prisma.operatorShiftMachineAssignment.upsert).toHaveBeenCalledTimes(2);
    for (const [input] of prisma.operatorShiftMachineAssignment.upsert.mock.calls) {
      expect(input.create).toEqual(expect.objectContaining({ status: 'planned', lockedAt: null }));
    }
    for (const [input] of prisma.bigBagUnit.upsert.mock.calls) {
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
    expect(prisma.operatorPostSession.upsert).not.toHaveBeenCalled();
    expect(prisma.shiftBagUsage.upsert).not.toHaveBeenCalled();
    expect(prisma.warehouseAcceptanceTask.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          id: 'pilot-test-receiving-001',
          rows: {
            create: expect.arrayContaining([
              expect.objectContaining({ rollCode: 'PILOT-PHYSICAL-ROLL-001' }),
              expect.objectContaining({ rollCode: 'PILOT-SIM-ROLL-001' }),
            ]),
          },
        }),
      }),
    );
    expect(prisma.financeOrder.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          amountValue: 100,
          paymentTermsType: 'prepay_50_postpay_50_30d',
          createdAt: expect.any(Date),
          invoiceIssuedAt: expect.any(Date),
        }),
      }),
    );
    const financeCreate = prisma.financeOrder.upsert.mock.calls[0][0].create;
    const financeCreatedAt = nullableDateField(financeCreate, 'createdAt', 'finance create');
    const invoiceIssuedAt = nullableDateField(financeCreate, 'invoiceIssuedAt', 'finance create');
    expect(invoiceIssuedAt).toEqual(financeCreatedAt);
    expect(prisma.financeOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'pilot-test-finance-001', invoiceIssuedAt: null },
      data: { invoiceIssuedAt: financeCreatedAt },
    });
    expect(prisma.financeOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'pilot-test-finance-001', paymentTermsType: null },
      data: { paymentTermsType: 'prepay_50_postpay_50_30d' },
    });
    expect(prisma.paymentPolicy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { financeOrderId: 'pilot-test-finance-001' },
        update: {},
        create: expect.objectContaining({
          id: 'pilot-test-payment-policy-001',
          installmentDays: 30,
          capturedProductionLeadDays: 2,
        }),
      }),
    );
    expect(prisma.paymentPolicyStage.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.paymentSchedule.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.paymentSchedule.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          id: 'pilot-test-payment-schedule-001',
          amount: 50,
          status: 'paid',
          startsAt: financeCreatedAt,
          dueDate: expect.any(Date),
        }),
      }),
    );
    const firstScheduleCreate = prisma.paymentSchedule.upsert.mock.calls[0][0].create;
    const firstDueDate = nullableDateField(
      firstScheduleCreate,
      'dueDate',
      'payment schedule create',
    );
    expect(firstDueDate?.toISOString().slice(0, 10)).toBe(
      invoiceIssuedAt?.toISOString().slice(0, 10),
    );
    expect(prisma.paymentSchedule.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          id: 'pilot-test-payment-schedule-002',
          amount: 50,
          status: 'unpaid',
          dueDate: null,
        }),
      }),
    );
    for (const [input] of prisma.paymentSchedule.upsert.mock.calls) {
      expect(input.update).toEqual({});
    }
    expect(prisma.paymentOperation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ amount: 50 }) }),
    );
  });

  it('uses create-only upserts so a repeated bootstrap cannot rewind test execution state', async () => {
    const { prisma, transactionClient } = createHarness();

    await seedPilotTestData(transactionClient);
    await seedPilotTestData(transactionClient);

    for (const model of [
      prisma.commercialOrder,
      prisma.productionOrder,
      prisma.rollDispatchItem,
      prisma.operatorRollLine,
      prisma.shift,
      prisma.operatorShiftMachineAssignment,
      prisma.bigBagUnit,
      prisma.warehouseAcceptanceTask,
      prisma.financeOrder,
      prisma.paymentPolicy,
      prisma.paymentPolicyStage,
      prisma.paymentSchedule,
      prisma.paymentOperation,
    ]) {
      for (const [input] of model.upsert.mock.calls) {
        expect(input.update).toEqual({});
      }
    }
  });

  it('fails closed when an assignment create uses relation objects instead of scalar IDs', async () => {
    const { prisma } = createHarness();
    const checkedCreate = {
      where: {
        shiftId_operatorId: {
          shiftId: 'pilot-test-shift-001',
          operatorId: 'operator-id',
        },
      },
      update: {},
      create: {
        id: 'checked-relation-assignment',
        shift: { connect: { id: 'pilot-test-shift-001' } },
        operator: { connect: { id: 'operator-id' } },
        post: { connect: { id: 'post-1-id' } },
      },
    } satisfies Prisma.OperatorShiftMachineAssignmentUpsertArgs;

    await expect(prisma.operatorShiftMachineAssignment.upsert(checkedCreate)).rejects.toThrow(
      'assignment create requires scalar field "shiftId"',
    );
  });

  it('moves only the pristine legacy simulator ownership and is state-idempotent', async () => {
    const legacy = pristineLegacySimulatorFixture();
    const { assignments, dispatches, lines, transactionClient } = createHarness(legacy);
    const stableLine = structuredClone(lines[0]);

    await seedPilotTestData(transactionClient);
    const firstState = {
      assignment: structuredClone(assignments[0]),
      dispatch: structuredClone(dispatches[0]),
    };
    await seedPilotTestData(transactionClient);

    expect(assignments[0]).toEqual({
      ...legacy.assignment,
      operatorId: 'operator-3-id',
    });
    expect(dispatches[0]).toEqual({
      ...legacy.dispatch,
      assignedOperatorId: 'operator-3-id',
    });
    expect(lines[0]).toEqual(stableLine);
    expect({ assignment: assignments[0], dispatch: dispatches[0] }).toEqual(firstState);
  });

  it('accepts already-current simulator ownership when the retired account is absent', async () => {
    const legacy = pristineLegacySimulatorFixture();
    const { assignments, dispatches, transactionClient } = createHarness({
      ...legacy,
      assignment: { ...legacy.assignment, operatorId: 'operator-3-id' },
      dispatch: { ...legacy.dispatch, assignedOperatorId: 'operator-3-id' },
      omitRetiredOperator: true,
    });

    await expect(seedPilotTestData(transactionClient)).resolves.toBeUndefined();

    expect(assignments[0].operatorId).toBe('operator-3-id');
    expect(dispatches[0].assignedOperatorId).toBe('operator-3-id');
  });

  it('creates a fresh simulator fixture on the retired account when the active operator is occupied', async () => {
    const legacy = pristineLegacySimulatorFixture();
    const conflictingTargetAssignment: PilotAssignment = {
      ...legacy.assignment,
      id: 'real-current-assignment',
      shiftId: 'real-current-shift',
      operatorId: 'operator-3-id',
      postId: 'post-1-id',
    };
    const { assignments, dispatches, transactionClient } = createHarness({
      conflictingTargetAssignment,
    });

    await seedPilotTestData(transactionClient);

    expect(
      assignments.find((assignment) => assignment.id === 'pilot-test-assignment-post-5'),
    ).toEqual(expect.objectContaining({ operatorId: 'operator-4-id', postId: 'post-5-id' }));
    expect(dispatches.find((dispatch) => dispatch.rollCode === 'PILOT-SIM-ROLL-001')).toEqual(
      expect.objectContaining({ assignedOperatorId: 'operator-4-id', postId: 'post-5-id' }),
    );
    expect(assignments[0]).toEqual(conflictingTargetAssignment);
  });

  it('restores a pristine simulator fixture to the retired account after a live assignment appears', async () => {
    const legacy = pristineLegacySimulatorFixture();
    const conflictingTargetAssignment: PilotAssignment = {
      ...legacy.assignment,
      id: 'real-current-assignment',
      shiftId: 'real-current-shift',
      operatorId: 'operator-3-id',
      postId: 'post-1-id',
    };
    const { assignments, dispatches, transactionClient } = createHarness({
      ...legacy,
      assignment: { ...legacy.assignment, operatorId: 'operator-3-id' },
      dispatch: { ...legacy.dispatch, assignedOperatorId: 'operator-3-id' },
      conflictingTargetAssignment,
    });

    await seedPilotTestData(transactionClient);

    expect(assignments[0].operatorId).toBe('operator-4-id');
    expect(dispatches[0].assignedOperatorId).toBe('operator-4-id');
    expect(assignments[1]).toEqual(conflictingTargetAssignment);
    expect(assignments).toHaveLength(3);
    expect(
      assignments.some(
        (assignment) =>
          assignment.shiftId === 'pilot-test-shift-001' &&
          assignment.operatorId === 'operator-3-id',
      ),
    ).toBe(false);
  });

  it.each([
    [
      'progressed line',
      { line: { ...pristineLegacySimulatorFixture().line, step: 'spool_weight' } },
    ],
    [
      'partial ownership',
      {
        dispatch: {
          ...pristineLegacySimulatorFixture().dispatch,
          assignedOperatorId: 'operator-3-id',
        },
      },
    ],
    ['session evidence', { hasSession: true }],
    ['machine change evidence', { hasMachineChange: true }],
    ['line evidence rows', { lineEvidenceCount: 1 }],
  ])('rejects a legacy simulator transition with %s', async (_label, mutation) => {
    const legacy = pristineLegacySimulatorFixture();
    const { assignments, dispatches, transactionClient } = createHarness({
      ...legacy,
      ...mutation,
    });
    const before = structuredClone({ assignments, dispatches });

    await expect(seedPilotTestData(transactionClient)).rejects.toBeInstanceOf(PilotTestDataError);

    expect({ assignments, dispatches }).toEqual(before);
  });

  it('does not rewrite ownership when the line progresses while legacy rows are locked', async () => {
    const legacy = pristineLegacySimulatorFixture();
    const { assignments, dispatches, lines, transactionClient } = createHarness({
      ...legacy,
      interleaveLineProgression: true,
    });

    await expect(seedPilotTestData(transactionClient)).rejects.toBeInstanceOf(PilotTestDataError);

    expect(assignments[0].operatorId).toBe('operator-4-id');
    expect(dispatches[0].assignedOperatorId).toBe('operator-4-id');
    expect(lines[0]).toEqual(expect.objectContaining({ step: 'spool_weight', spoolKg: 1.2 }));
  });

  it('rejects migration when the target operator already has an assignment in the shift', async () => {
    const legacy = pristineLegacySimulatorFixture();
    const targetAssignment: PilotAssignment = {
      ...legacy.assignment,
      id: 'target-operator-existing-assignment',
      operatorId: 'operator-3-id',
      postId: 'post-1-id',
    };
    const { assignments, dispatches, transactionClient } = createHarness({
      ...legacy,
      targetAssignment,
    });

    await expect(seedPilotTestData(transactionClient)).rejects.toBeInstanceOf(PilotTestDataError);

    expect(assignments[0].operatorId).toBe('operator-4-id');
    expect(dispatches[0].assignedOperatorId).toBe('operator-4-id');
  });
});
