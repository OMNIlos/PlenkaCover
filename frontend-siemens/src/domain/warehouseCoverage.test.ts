import { describe, expect, it } from 'vitest';

import {
  coverageReasonLabel,
  normalizeFinanceWarehouseCoverage,
  normalizeFinanceWarehouseCoverageWithCase,
  normalizeWarehouseCoverage,
  normalizeWarehouseCoverageDecisionTask,
  normalizeWarehouseCoverageRecheckItem,
  normalizeWarehouseCoverageWithCase,
} from './warehouseCoverage';

function serverProjection() {
  return {
    workflowVersion: 2,
    state: 'awaiting_finance',
    stateVersion: 4,
    generation: 3,
    availability: 'verified_full',
    reasonCodes: ['full_cover_available'],
    nextOwner: 'finance',
    availableActions: ['use_warehouse', 'produce_all', 'request_recheck'],
    requiredRollCount: 2,
    matchedRollCount: 2,
    uncertainRollCount: 0,
    calculatedAt: '2026-07-24T10:00:00.000Z',
    stale: false,
  };
}

function correctionSpec() {
  return {
    filmType: 'пленка полиэтиленовая',
    actualThickness: '80 мкм',
    accountingThickness: '80 мкм',
    widthMm: 1000,
    plannedLengthM: 100,
    birka: 'полотно',
    spoolType: '76 мм',
    actualWeightKg: '275',
    plannedWeightKg: '275.125',
    recipeId: null,
    recipeVersion: 'v7',
    recipeDefinitionId: 'recipe-definition-real-id',
    recipeDefinitionVersionId: 'recipe-definition-version-real-id',
    recipeVersionNumber: 7,
    ingredients: [
      { rawMaterialDefinitionId: 'raw-material-a', shareBasisPoints: 6_000 },
      { rawMaterialDefinitionId: 'raw-material-b', shareBasisPoints: 4_000 },
    ],
  };
}

function serverFinanceRoll() {
  return {
    rollCode: 'ROLL-001',
    positionId: 'position-real-id',
    source: 'platform',
    locationLabel: 'Свободный резерв',
    availability: 'available',
    batchCode: 'ПАРТИЯ-1',
    receivedAt: '2026-08-06T01:00:00.000Z',
    grossKg: 41.9,
    spoolKg: 0.7,
    requested: {
      filmType: 'Рукав',
      actualThicknessMicron: 80,
      accountingThicknessMicron: 78,
      widthMm: 1_200,
      plannedLengthM: 800,
      netKg: 41,
      spoolType: 'Тонкая',
      birka: 'ГОСТ',
      materialLabel: 'ПВД первичный',
    },
    matched: {
      filmType: 'рукав',
      actualThicknessMicron: 80,
      accountingThicknessMicron: 78,
      widthMm: 1_200,
      plannedLengthM: 800,
      netKg: 41.2,
      spoolType: 'Тонкая',
      birka: 'гост',
      materialLabel: 'ПВД первичный',
    },
  };
}

describe('warehouse coverage domain boundary', () => {
  it('normalizes the exact safe envelope and falls back safely for a new reason', () => {
    expect(normalizeWarehouseCoverage(serverProjection())).toEqual(serverProjection());
    expect(coverageReasonLabel('future_reason')).toBe('Требуется безопасная проверка данных');
  });

  it('accepts an order-spec invalidation as a refreshable safe projection', () => {
    const invalidated = {
      ...serverProjection(),
      state: 'order_spec_changed',
      stateVersion: 5,
      nextOwner: 'system',
      availableActions: ['refresh'],
      stale: true,
    };

    expect(normalizeWarehouseCoverage(invalidated)).toEqual(invalidated);
  });

  it('drops internal and protected details from the base projection', () => {
    const normalized = normalizeWarehouseCoverage({
      ...serverProjection(),
      requestFingerprint: 'secret-fingerprint',
      spec: { raw: true },
      ownerCounterpartyId: 'secret-owner',
      financeRolls: [{ rollCode: 'SECRET-ROLL', positionId: 'secret-position' }],
      members: [{ membershipId: 'secret-membership' }],
      rows: [{ scanRowId: 'secret-row' }],
    });

    expect(normalized).toEqual(serverProjection());
    expect(JSON.stringify(normalized)).not.toMatch(
      /requestFingerprint|spec|secret-owner|SECRET-ROLL|membershipId|scanRowId/u,
    );
  });

  it('preserves the validated protected set only in the finance normalizer', () => {
    const server = {
      ...serverProjection(),
      financeRolls: [serverFinanceRoll()],
    };

    expect(normalizeFinanceWarehouseCoverage(server).financeRolls).toEqual([serverFinanceRoll()]);
    expect(normalizeWarehouseCoverage(server)).not.toHaveProperty('financeRolls');
    expect(() =>
      normalizeFinanceWarehouseCoverage({
        ...server,
        financeRolls: [
          {
            ...serverFinanceRoll(),
            requested: { ...serverFinanceRoll().requested, rawPayload: 'secret' },
          },
        ],
      }),
    ).toThrow(/extra key.*rawPayload/u);
  });

  it('requires exact with-case envelopes and rejects protected cross-surface rows', () => {
    expect(
      normalizeFinanceWarehouseCoverageWithCase({
        ...serverProjection(),
        financeRolls: [serverFinanceRoll()],
        caseId: 'case-real-id',
      }).caseId,
    ).toBe('case-real-id');
    expect(
      normalizeWarehouseCoverageWithCase({
        ...serverProjection(),
        caseId: 'case-real-id',
      }).caseId,
    ).toBe('case-real-id');
    expect(() =>
      normalizeWarehouseCoverageWithCase({
        ...serverProjection(),
        caseId: 'case-real-id',
        members: [{ membershipId: 'secret-membership' }],
      }),
    ).toThrow(/extra key.*members/u);
    expect(() =>
      normalizeFinanceWarehouseCoverageWithCase({
        ...serverProjection(),
        financeRolls: [],
        caseId: 'case-real-id',
        rows: [{ scanRowId: 'secret-row' }],
      }),
    ).toThrow(/extra key.*rows/u);
  });

  it('strictly normalizes warehouse recheck members and correction specs', () => {
    const input = {
      caseId: 'case-real-id',
      coverageOrigin: 'finance_request',
      caseVersion: 2,
      stateVersion: 5,
      generation: 3,
      reasonCodes: ['roll_facts_incomplete'],
      members: [
        {
          membershipId: 'membership-real-id',
          rollCode: 'ROLL-001',
          sourceKind: 'uncertain_candidate',
          reasonCodes: ['roll_facts_incomplete'],
          currentFactVersion: 4,
          ownerVerified: true,
          currentSpec: correctionSpec(),
        },
      ],
    };
    const item = normalizeWarehouseCoverageRecheckItem(input);

    expect(item).toEqual(input);
    for (const [field, value] of [
      ['widthMm', null],
      ['widthMm', 0],
      ['widthMm', 100000.001],
      ['widthMm', 1.0001],
      ['plannedLengthM', -1],
      ['plannedLengthM', 10000000.001],
    ]) {
      expect(() =>
        normalizeWarehouseCoverageRecheckItem({
          ...input,
          members: [
            { ...input.members[0], currentSpec: { ...correctionSpec(), [field as string]: value } },
          ],
        }),
      ).toThrow();
    }
    expect(() =>
      normalizeWarehouseCoverageRecheckItem({
        ...input,
        members: [{ ...input.members[0], rollId: 'secret-roll-id' }],
      }),
    ).toThrow(/extra key.*rollId/u);
    expect(() =>
      normalizeWarehouseCoverageRecheckItem({
        ...input,
        rawPayload: { device: 'secret' },
      }),
    ).toThrow(/extra key.*rawPayload/u);
    expect(() =>
      normalizeWarehouseCoverageRecheckItem({
        ...input,
        members: [
          {
            ...input.members[0],
            currentSpec: {
              ...correctionSpec(),
              ingredients: [
                { rawMaterialDefinitionId: 'raw-material-a', shareBasisPoints: 5_999 },
                { rawMaterialDefinitionId: 'raw-material-b', shareBasisPoints: 4_000 },
              ],
            },
          },
        ],
      }),
    ).toThrow(/10.?000/u);
  });

  it('strictly normalizes decision-task rows and rejects row provenance leakage', () => {
    const task = normalizeWarehouseCoverageDecisionTask({
      taskId: 'task-real-id',
      status: 'open',
      generation: 3,
      stateVersion: 5,
      updatedAt: '2026-07-24T10:00:00.000Z',
      rows: [
        {
          scanRowId: 'scan-row-real-id',
          rollCode: 'ROLL-001',
          scanStatus: 'expected',
        },
      ],
    });

    expect(task.rows[0]).toEqual({
      scanRowId: 'scan-row-real-id',
      rollCode: 'ROLL-001',
      scanStatus: 'expected',
    });
    expect(task).toMatchObject({ generation: 3, stateVersion: 5 });
    expect(() =>
      normalizeWarehouseCoverageDecisionTask({
        ...task,
        rows: [{ ...task.rows[0], coverageFactId: 'secret-fact-id' }],
      }),
    ).toThrow(/extra key.*coverageFactId/u);
  });
});
