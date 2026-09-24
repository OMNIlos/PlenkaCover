import {
  isDeviceBackedSpoolEvidence,
  isDeviceBackedWeightEvidence,
} from './device-backed-evidence';

const operatorOperation = {
  id: 'operation-1',
  action: 'roll_weight',
  status: 'succeeded',
  deviceId: 'scale-1',
  postId: 'post-1',
  postSessionId: 'post-session-1',
  resultRef: 'capture-1',
};

const physical = {
  id: 'capture-1',
  kind: 'roll',
  deviceId: 'scale-1',
  deviceStatus: 'ready',
  stable: true,
  grossKg: 43,
  spoolKg: 2,
  netKg: 41,
  postId: 'post-1',
  postSessionId: 'post-session-1',
  operationId: 'operation-1',
  warehouseOperationId: null,
  operation: operatorOperation,
  warehouseOperation: null,
};

describe('isDeviceBackedWeightEvidence', () => {
  it('accepts a consistent roll capture linked to its successful operator operation', () => {
    expect(
      isDeviceBackedWeightEvidence(physical, {
        source: 'operator',
        allowedActions: ['roll_weight', 'roll_reweigh'],
      }),
    ).toBe(true);
  });

  it('accepts an operator defect capture only when the operation result references the defect', () => {
    expect(
      isDeviceBackedWeightEvidence(
        {
          ...physical,
          operation: {
            ...operatorOperation,
            action: 'defect',
            resultRef: 'defect-1',
          },
        },
        {
          source: 'operator',
          allowedActions: ['defect'],
          defectRecordId: 'defect-1',
        },
      ),
    ).toBe(true);
  });

  it('accepts a warehouse control capture linked to the completed durable operation', () => {
    const warehouseEvidence = {
      ...physical,
      postSessionId: null,
      operationId: null,
      operation: null,
      warehouseOperationId: 'warehouse-operation-1',
      warehouseOperation: {
        id: 'warehouse-operation-1',
        kind: 'control_weight',
        status: 'succeeded',
        taskId: 'task-1',
        rollCode: 'ROLL-1',
        deviceId: 'scale-1',
        postId: 'post-1',
        safeResult: {
          operationId: 'warehouse-operation-1',
          taskId: 'task-1',
          rollCode: 'ROLL-1',
          grossKg: 43,
          spoolKg: 2,
          netKg: 41,
        },
      },
    };

    expect(
      isDeviceBackedWeightEvidence(warehouseEvidence, {
        source: 'warehouse',
        expectedRollCode: 'ROLL-1',
      }),
    ).toBe(true);
  });

  it.each([
    { deviceId: null },
    { deviceStatus: 'offline' },
    { stable: false },
    { grossKg: null },
    { spoolKg: null },
    { netKg: null },
    { grossKg: Number.POSITIVE_INFINITY },
    { netKg: 40 },
  ])('rejects synthetic or inconsistent evidence %o', (change) => {
    expect(
      isDeviceBackedWeightEvidence(
        { ...physical, ...change },
        { source: 'operator', allowedActions: ['roll_weight'] },
      ),
    ).toBe(false);
  });

  it.each([
    { operation: null },
    { operationId: null },
    { operation: { ...operatorOperation, status: 'in_progress' } },
    { operation: { ...operatorOperation, action: 'spool_weight' } },
    { operation: { ...operatorOperation, deviceId: 'fake-scale' } },
    { operation: { ...operatorOperation, postId: 'other-post' } },
    { operation: { ...operatorOperation, postSessionId: 'other-session' } },
    { operation: { ...operatorOperation, resultRef: 'other-capture' } },
  ])('rejects operator evidence without matching durable success %o', (change) => {
    expect(
      isDeviceBackedWeightEvidence(
        { ...physical, ...change },
        { source: 'operator', allowedActions: ['roll_weight', 'roll_reweigh'] },
      ),
    ).toBe(false);
  });

  it('rejects a plausible scalar with a fake device id and no durable operation', () => {
    expect(
      isDeviceBackedWeightEvidence(
        {
          ...physical,
          operationId: null,
          operation: null,
        },
        { source: 'operator', allowedActions: ['roll_weight'] },
      ),
    ).toBe(false);
  });
});

describe('isDeviceBackedSpoolEvidence', () => {
  const spool = {
    ...physical,
    id: 'spool-capture-1',
    kind: 'spool',
    grossKg: 2.4,
    spoolKg: 2.4,
    netKg: null,
  };

  it('accepts a stable positive spool capture from a ready device', () => {
    expect(isDeviceBackedSpoolEvidence(spool)).toBe(true);
  });

  it.each([
    { kind: 'roll' },
    { stable: false },
    { deviceId: null },
    { deviceStatus: 'offline' },
    { spoolKg: null },
    { spoolKg: Number.NaN },
    { spoolKg: Number.POSITIVE_INFINITY },
    { spoolKg: 0 },
    { spoolKg: -1 },
  ])('rejects spool evidence without strict device-backed facts %o', (change) => {
    expect(isDeviceBackedSpoolEvidence({ ...spool, ...change })).toBe(false);
  });
});
