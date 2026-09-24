import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyDateScope } from '../components/shell/DateScopeDropdown';
import { operatorRollHubRows } from '../domain/operatorRuntime';
import type { OperatorRollReweighResult, OperatorRollStepBackResult } from '../domain/types';
import { IdempotentOperationGate } from './idempotentOperation';
import {
  acceptOperatorRoll,
  addOperatorShiftBag,
  captureOperatorRollWeight,
  captureOperatorSpoolWeight,
  deferOperatorRoll,
  fetchCurrentOperatorMachineChange,
  fetchOperatorRuntime,
  handoverOperatorRoll,
  printOperatorDefectBag,
  printOperatorQr,
  reweighOperatorRoll,
  reportOperatorDefect,
  resumeOperatorRoll,
  serverOperatorRuntimeToState,
  stepBackOperatorRoll,
  verifyAndHandoverOperatorQr,
  verifyOperatorQr,
  weighOperatorDefectBag,
} from './operator';

const OPERATION_KEY = '11111111-1111-4111-8111-111111111111';
const HANDOVER_OPERATION_KEY = '22222222-2222-4222-8222-222222222222';

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('operator live adapter', () => {
  it('preserves an unresolved print instead of making the roll printable again', () => {
    const runtime = serverOperatorRuntimeToState({
      shift: null, generatedAt: '2026-09-11T13:06:20.000Z',
      orders: [{
        id: 'A-4', title: 'A-4', customerAlias: 'Клиент', filmType: 'Плёнка',
        status: 'qr_print', plannedRolls: 1, completedRolls: 0, currentRoll: 1, rollPlanKg: 10.9,
        spoolKg: 0.7, rollNetKg: 10.9,
        rolls: [{
          id: 'A-4-roll-7', sequenceNumber: 1, status: 'qr_print', plannedNetKg: 10.9,
          dispatchItemId: 'dispatch-7', queueRank: 7, priority: 1, machineId: 'POST-1',
          machineLabel: 'Станок 1', plannedLengthM: null, characteristicsSnapshot: null,
          updatedAt: '2026-09-11T13:06:20.000Z',
          spoolKg: 0.7, grossKg: 11.6, netKg: 10.9, toleranceOk: true,
          labelState: 'delivery_unknown', warehouseState: 'not_ready',
        }],
      }],
    });
    expect(runtime.orders[0].rolls[0].labelState).toBe('delivery_unknown');
  });
  it('treats an empty optional current-machine-change response as no active change', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchCurrentOperatorMachineChange()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/operator/machine-changes/current',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('clamps legacy roll progress to the local order total', () => {
    const runtime = serverOperatorRuntimeToState({
      shift: null,
      generatedAt: '2026-07-17T08:10:00.000Z',
      orders: [
        {
          id: 'A-503',
          title: 'A-503',
          customerAlias: 'Клиент A',
          commercialComment: 'Позвонить перед запуском',
          filmType: 'Пленка полиэтиленовая полотно 80 мкм 1700 мм 275 м',
          status: 'qr_print',
          plannedRolls: 1,
          completedRolls: 0,
          currentRoll: 885,
          rollPlanKg: 41.2,
          spoolKg: 1.8,
          rollNetKg: 41.2,
          rolls: [
            {
              id: 'A-503-roll-1',
              dispatchItemId: 'dispatch-3',
              sequenceNumber: 1,
              queueRank: 885,
              priority: 1,
              machineId: 'POST-1',
              machineLabel: 'Станок 1',
              plannedLengthM: 500,
              rawMaterialId: 'rm-primary',
              rawMaterialLabel: 'ПВД 15803-020',
              recipeVersion: 'v7',
              characteristicsSnapshot: {
                actualThickness: '80 мкм',
                accountingThickness: '78 мкм',
                widthMm: 1700,
                comment: 'Комментарий для производства',
              },
              updatedAt: '2026-07-17T08:05:00.000Z',
              status: 'qr_print',
              plannedNetKg: 41.2,
              spoolWeightPolicy: 'standard_700g',
              spoolKg: 1.8,
              grossKg: 43,
              netKg: 41.2,
              toleranceOk: true,
              labelState: 'not_printed',
              warehouseState: 'not_ready',
            },
          ],
        },
      ],
    });

    expect(runtime.orders[0]).toEqual(
      expect.objectContaining({
        rollProgress: { current: 1, completed: 0, total: 1 },
        currentRoll: 1,
        completedRolls: 0,
        plannedRolls: 1,
      }),
    );
    expect(runtime.orders[0]?.rollGroups[0]).toMatchObject({
      rollType: 'Полотно',
      actualThickness: '80 мкм',
      accountingThickness: '78 мкм',
      widthMm: 1700,
      plannedLengthM: 500,
      micron: '80 мкм (78 бух.)',
      sizeMeters: '1700 мм · 500 м',
      rawMaterialLabel: 'ПВД 15803-020',
      recipeVersion: 'v7',
      commercialComment: 'Позвонить перед запуском',
    });
    expect(runtime.orders[0]?.rolls[0]).toMatchObject({
      spoolWeightPolicy: 'standard_700g',
      spoolKg: 1.8,
      grossKg: 43,
      netKg: 41.2,
    });
    expect(JSON.stringify(runtime)).not.toContain('Клиент A');
  });

  it('keeps each production position parameters attached to its own active roll', () => {
    const runtime = serverOperatorRuntimeToState({
      shift: null,
      generatedAt: '2026-08-06T08:00:00.000Z',
      orders: [
        {
          id: 'MULTI-001',
          title: 'MULTI-001',
          customerAlias: null,
          commercialComment: 'Общий комментарий заявки',
          filmType: 'Полотно',
          status: 'spool_weight',
          progress: { current: 3, completed: 2, total: 3 },
          plannedRolls: 3,
          completedRolls: 2,
          currentRoll: 3,
          currentDispatchItemId: 'dispatch-position-2',
          rollPlanKg: 35,
          spoolKg: null,
          rollNetKg: null,
          rolls: [
            {
              id: 'MULTI-001-roll-1',
              dispatchItemId: 'dispatch-position-1',
              orderLineId: 'line-position-1',
              positionSequence: 1,
              sequenceNumber: 1,
              queueRank: 1,
              priority: 1,
              filmType: 'Полотно',
              machineId: 'POST-1',
              machineLabel: 'Станок 1',
              plannedLengthM: 300,
              characteristicsSnapshot: {
                actualThickness: '60 мкм',
                accountingThickness: '58 мкм',
                widthMm: 1200,
                comment: 'Инструкция первой позиции',
              },
              updatedAt: '2026-08-06T07:00:00.000Z',
              status: 'warehouse',
              plannedNetKg: 30,
              spoolKg: 0.7,
              netKg: 30,
              toleranceOk: true,
              labelState: 'verified',
              warehouseState: 'received',
            },
            {
              id: 'MULTI-001-roll-2',
              dispatchItemId: 'dispatch-position-1-roll-2',
              orderLineId: 'line-position-1',
              positionSequence: 2,
              sequenceNumber: 2,
              queueRank: 2,
              priority: 1,
              filmType: 'Полотно',
              machineId: 'POST-1',
              machineLabel: 'Станок 1',
              plannedLengthM: 300,
              characteristicsSnapshot: {
                actualThickness: '60 мкм',
                accountingThickness: '58 мкм',
                widthMm: 1200,
                comment: 'Инструкция первой позиции',
              },
              updatedAt: '2026-08-06T07:15:00.000Z',
              status: 'warehouse',
              plannedNetKg: 30,
              spoolKg: 0.7,
              netKg: 30,
              toleranceOk: true,
              labelState: 'verified',
              warehouseState: 'received',
            },
            {
              id: 'MULTI-001-roll-3',
              dispatchItemId: 'dispatch-position-2',
              orderLineId: 'line-position-2',
              positionSequence: 1,
              sequenceNumber: 3,
              queueRank: 3,
              priority: 1,
              filmType: 'Рукав',
              machineId: 'POST-1',
              machineLabel: 'Станок 1',
              plannedLengthM: 500,
              characteristicsSnapshot: {
                actualThickness: '80 мкм',
                accountingThickness: '78 мкм',
                widthMm: 1700,
                comment: 'Инструкция второй позиции',
                recipe: {
                  name: 'Синяя смесь',
                  version: 3,
                  ingredients: [
                    { name: 'Первичное', shareBasisPoints: 8000 },
                    { name: 'Синий краситель', shareBasisPoints: 2000 },
                  ],
                },
              },
              updatedAt: '2026-08-06T07:30:00.000Z',
              status: 'spool_weight',
              plannedNetKg: 35,
              spoolKg: null,
              netKg: null,
              toleranceOk: null,
              labelState: 'not_printed',
              warehouseState: 'not_ready',
            },
          ],
        },
      ],
    });

    const order = runtime.orders[0]!;
    expect(order.rollGroups).toHaveLength(2);
    expect(order.rolls[0]?.groupId).toBe(order.rolls[1]?.groupId);
    expect(order.rolls[1]?.groupId).not.toBe(order.rolls[2]?.groupId);
    expect(order.rollGroups[0]?.rollIds).toEqual(['MULTI-001-roll-1', 'MULTI-001-roll-2']);
    expect(order.rollGroups.find((group) => group.id === order.rolls[2]?.groupId)).toMatchObject({
      title: 'Позиция 2',
      rollType: 'Рукав',
      actualThickness: '80 мкм',
      accountingThickness: '78 мкм',
      widthMm: 1700,
      plannedLengthM: 500,
      recipeName: 'Синяя смесь',
      recipeVersionNumber: 3,
      recipeIngredients: [
        { name: 'Первичное', shareBasisPoints: 8000 },
        { name: 'Синий краситель', shareBasisPoints: 2000 },
      ],
      comment: 'Инструкция второй позиции',
      commercialComment: 'Общий комментарий заявки',
    });
    expect(order.realMicron).toBe('80 мкм (78 бух.)');
    expect(order.sizeMeters).toBe('1700 мм · 500 м');
    expect(operatorRollHubRows(runtime).find(({ id }) => id === 'MULTI-001-roll-3')).toMatchObject({
      recipe: 'Синяя смесь',
      plannedWeight: '35 кг',
    });
  });

  it('uses the legacy immutable recipe name when a catalog recipe is unavailable', () => {
    const runtime = serverOperatorRuntimeToState({
      shift: null,
      generatedAt: '2026-08-06T08:00:00.000Z',
      orders: [
        {
          id: 'LEGACY-RECIPE-001',
          title: 'LEGACY-RECIPE-001',
          customerAlias: null,
          filmType: 'Рукав',
          status: 'assigned',
          progress: { current: 1, completed: 0, total: 1 },
          plannedRolls: 1,
          completedRolls: 0,
          currentRoll: 1,
          currentDispatchItemId: 'dispatch-legacy',
          rollPlanKg: 40,
          spoolKg: null,
          rollNetKg: null,
          rolls: [
            {
              id: 'LEGACY-RECIPE-001-roll-1',
              dispatchItemId: 'dispatch-legacy',
              orderLineId: 'line-legacy',
              positionSequence: 1,
              sequenceNumber: 1,
              queueRank: 1,
              priority: 1,
              filmType: 'Рукав',
              machineId: 'POST-1',
              machineLabel: 'Станок 1',
              plannedLengthM: 400,
              rawMaterialId: null,
              rawMaterialLabel: null,
              recipeVersion: 'v2',
              characteristicsSnapshot: {
                actualThickness: '80 мкм',
                legacyRecipeName: '80% первичка / 20% вторичка',
              },
              updatedAt: '2026-08-06T07:00:00.000Z',
              status: 'assigned',
              plannedNetKg: 40,
              spoolKg: null,
              netKg: null,
              toleranceOk: null,
              labelState: 'not_printed',
              warehouseState: 'not_ready',
            },
          ],
        },
      ],
    });

    expect(runtime.orders[0]?.rollGroups[0]).toMatchObject({
      recipe: '80% первичка / 20% вторичка',
      recipeName: '80% первичка / 20% вторичка',
    });
  });

  it('prefers explicit bounded integer progress and rejects an invalid snapshot', () => {
    const baseOrder = {
      id: 'A-504',
      title: 'A-504',
      customerAlias: 'Клиент A',
      filmType: 'Рукав',
      status: 'qr_print' as const,
      plannedRolls: 1,
      completedRolls: 0,
      currentRoll: 885,
      rollPlanKg: 41.2,
      spoolKg: 1.8,
      rollNetKg: 41.2,
      rolls: [
        {
          id: 'A-504-roll-1',
          dispatchItemId: 'dispatch-4',
          sequenceNumber: 1,
          queueRank: 885,
          priority: 1,
          machineId: 'POST-1',
          machineLabel: 'Станок 1',
          plannedLengthM: 500,
          characteristicsSnapshot: null,
          updatedAt: '2026-07-17T08:05:00.000Z',
          status: 'qr_print' as const,
          plannedNetKg: 41.2,
          spoolKg: 1.8,
          netKg: 41.2,
          toleranceOk: true,
          labelState: 'not_printed',
          warehouseState: 'not_ready',
        },
      ],
    };
    const valid = serverOperatorRuntimeToState({
      shift: null,
      generatedAt: '2026-07-17T08:10:00.000Z',
      orders: [{ ...baseOrder, progress: { current: 2, completed: 1, total: 3 } }],
    });
    const invalid = serverOperatorRuntimeToState({
      shift: null,
      generatedAt: '2026-07-17T08:10:00.000Z',
      orders: [{ ...baseOrder, progress: { current: 2.5, completed: 4, total: 3 } }],
    });

    expect(valid.orders[0]).toEqual(
      expect.objectContaining({
        rollProgress: { current: 2, completed: 1, total: 3 },
        currentRoll: 2,
        completedRolls: 1,
        plannedRolls: 3,
      }),
    );
    expect(invalid.orders[0]?.rollProgress).toEqual({ current: 1, completed: 0, total: 1 });
  });

  it('keeps the immutable defect red while selecting its replacement without inflating progress', () => {
    const runtime = serverOperatorRuntimeToState({
      shift: null,
      generatedAt: '2026-07-27T04:20:00.000Z',
      orders: [
        {
          id: 'A-505',
          title: 'A-505',
          customerAlias: 'Клиент A',
          filmType: 'Полотно',
          status: 'assigned',
          progress: { current: 1, completed: 0, total: 1 },
          plannedRolls: 1,
          completedRolls: 0,
          currentRoll: 1,
          currentDispatchItemId: 'dispatch-replacement',
          rollPlanKg: 40,
          spoolKg: null,
          rollNetKg: null,
          rolls: [
            {
              id: 'A-505-roll-1',
              dispatchItemId: 'dispatch-defect',
              replacesDispatchItemId: null,
              sequenceNumber: 1,
              attemptNumber: 1,
              queueRank: 10,
              priority: 1,
              machineId: 'POST-1',
              machineLabel: 'Станок 1',
              plannedLengthM: 500,
              characteristicsSnapshot: null,
              updatedAt: '2026-07-27T04:18:00.000Z',
              status: 'defect',
              plannedNetKg: 40,
              spoolKg: 1,
              netKg: 42,
              toleranceOk: false,
              labelState: 'not_printed',
              warehouseState: 'not_ready',
            },
            {
              id: 'A-505-roll-1-R1',
              dispatchItemId: 'dispatch-replacement',
              replacesDispatchItemId: 'dispatch-defect',
              sequenceNumber: 1,
              attemptNumber: 2,
              queueRank: 11,
              priority: 1,
              machineId: 'POST-1',
              machineLabel: 'Станок 1',
              plannedLengthM: 500,
              characteristicsSnapshot: null,
              updatedAt: '2026-07-27T04:19:00.000Z',
              status: 'assigned',
              plannedNetKg: 40,
              spoolKg: null,
              netKg: null,
              toleranceOk: null,
              labelState: 'not_printed',
              warehouseState: 'not_ready',
            },
          ],
        },
      ],
    });

    expect(runtime.orders[0]).toMatchObject({
      rollProgress: { current: 1, completed: 0, total: 1 },
      currentRoll: 1,
      currentDispatchItemId: 'dispatch-replacement',
      plannedRolls: 1,
      rolls: [
        {
          id: 'A-505-roll-1',
          status: 'defect',
          sequenceNumber: 1,
          attemptNumber: 1,
          replacesDispatchItemId: null,
        },
        {
          id: 'A-505-roll-1-R1',
          status: 'assigned',
          sequenceNumber: 1,
          attemptNumber: 2,
          replacesDispatchItemId: 'dispatch-defect',
        },
      ],
    });
    const rows = operatorRollHubRows(runtime);
    expect(rows.find(({ id }) => id === 'A-505-roll-1')).toMatchObject({
      status: 'Брак',
      step: 'Неизменяемый факт',
      severity: 'critical',
      isCurrent: false,
    });
    expect(rows.find(({ id }) => id === 'A-505-roll-1-R1')).toMatchObject({
      isCurrent: true,
    });
  });

  it('preserves a submitted print handoff without calling the label physically printed', () => {
    const runtime = serverOperatorRuntimeToState({
      shift: null,
      generatedAt: '2026-07-17T08:10:00.000Z',
      orders: [
        {
          id: 'A-502',
          title: 'A-502',
          customerAlias: 'Клиент A',
          filmType: 'Рукав',
          status: 'qr_check',
          plannedRolls: 1,
          completedRolls: 0,
          currentRoll: 1,
          rollPlanKg: 41.2,
          spoolKg: 1.8,
          rollNetKg: 41.2,
          rolls: [
            {
              id: 'A-502-roll-1',
              dispatchItemId: 'dispatch-2',
              sequenceNumber: 1,
              queueRank: 10,
              priority: 1,
              machineId: 'POST-1',
              machineLabel: 'Станок 1',
              plannedLengthM: 500,
              characteristicsSnapshot: null,
              updatedAt: '2026-07-17T08:05:00.000Z',
              status: 'qr_check',
              plannedNetKg: 41.2,
              spoolKg: 1.8,
              netKg: 41.2,
              toleranceOk: true,
              labelState: 'submitted',
              warehouseState: 'not_ready',
            },
          ],
        },
      ],
    });

    expect(runtime.orders[0]?.rolls[0]?.labelState).toBe('submitted');
    expect(JSON.stringify(runtime)).not.toContain('printed');
  });

  it('maps the published backend order into the operator queue without fabricating another order', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          shift: {
            id: 'shift-2',
            status: 'start_missing',
            operatorName: 'Илья Ковалёв',
            workplace: 'POST-2',
          },
          generatedAt: '2026-07-10T08:10:00.000Z',
          orders: [
            {
              id: 'A-501',
              title: 'A-501',
              customerAlias: 'Клиент A',
              legalName: 'OPERATOR-LEGAL-SECRET',
              inn: 'OPERATOR-INN-SECRET',
              invoiceAmount: 'OPERATOR-FINANCE-SECRET',
              paymentSchedules: ['OPERATOR-SCHEDULE-SECRET'],
              rawPayload: 'OPERATOR-RAW-SECRET',
              filmType: 'Рукав',
              status: 'assigned',
              plannedRolls: 1,
              completedRolls: 0,
              currentRoll: 1,
              rollPlanKg: 41.2,
              spoolKg: null,
              rollNetKg: null,
              rolls: [
                {
                  id: 'A-501-roll-1',
                  dispatchItemId: 'dispatch-1',
                  sequenceNumber: 1,
                  queueRank: 10,
                  priority: 2,
                  machineId: 'POST-2',
                  machineLabel: 'Станок 2',
                  plannedLengthM: 500,
                  characteristicsSnapshot: { actualThickness: '80 мкм', spoolType: '76 мм' },
                  updatedAt: '2026-07-10T08:05:00.000Z',
                  status: 'assigned',
                  plannedNetKg: 41.2,
                  spoolKg: null,
                  netKg: null,
                  toleranceOk: null,
                  labelState: 'not_printed',
                  warehouseState: 'not_ready',
                  sourceSnapshot: 'OPERATOR-SOURCE-SECRET',
                  rawPayload: 'OPERATOR-ROLL-RAW-SECRET',
                },
              ],
            },
          ],
        }),
      ),
    );

    const runtime = await fetchOperatorRuntime();

    expect(runtime.shift).toEqual(
      expect.objectContaining({ status: 'start_missing', workplace: 'POST-2' }),
    );
    expect(runtime.orders).toHaveLength(1);
    expect(runtime.orders[0]).toEqual(
      expect.objectContaining({ orderId: 'A-501', title: 'Заказ A-501', workplace: 'Станок 2' }),
    );
    expect(runtime.orders[0].rolls[0]).toEqual(
      expect.objectContaining({
        dispatchItemId: 'dispatch-1',
        priority: 'срочно',
        machineId: 'POST-2',
        plannedNetKg: 41.2,
      }),
    );
    const serialized = JSON.stringify(runtime);
    for (const secret of [
      'OPERATOR-LEGAL-SECRET',
      'OPERATOR-INN-SECRET',
      'OPERATOR-FINANCE-SECRET',
      'OPERATOR-SCHEDULE-SECRET',
      'OPERATOR-RAW-SECRET',
      'OPERATOR-SOURCE-SECRET',
      'OPERATOR-ROLL-RAW-SECRET',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('uses the backend roll update date in the operator calendar filter', () => {
    const runtime = serverOperatorRuntimeToState({
      shift: null,
      generatedAt: '2026-07-10T08:10:00.000Z',
      orders: [
        {
          id: 'A-501',
          title: 'A-501',
          customerAlias: 'Клиент A',
          filmType: 'Рукав',
          status: 'assigned',
          plannedRolls: 1,
          completedRolls: 0,
          currentRoll: 1,
          rollPlanKg: 41.2,
          spoolKg: null,
          rollNetKg: null,
          rolls: [
            {
              id: 'A-501-roll-1',
              dispatchItemId: 'dispatch-1',
              sequenceNumber: 1,
              queueRank: 10,
              priority: 2,
              machineId: 'POST-2',
              machineLabel: 'Станок 2',
              plannedLengthM: 500,
              characteristicsSnapshot: null,
              updatedAt: '2026-07-10T08:05:00.000Z',
              status: 'assigned',
              plannedNetKg: 41.2,
              spoolKg: null,
              netKg: null,
              toleranceOk: null,
              labelState: 'not_printed',
              warehouseState: 'not_ready',
            },
          ],
        },
      ],
    });

    const rows = operatorRollHubRows(runtime);

    expect(applyDateScope(rows, '2026-07-10').map((row) => row.id)).toEqual(['A-501-roll-1']);
    expect(applyDateScope(rows, '2026-07-11')).toEqual([]);
  });
});

describe('operator shift live mutations (design 2026-07-13)', () => {
  it('maps shift bags, balance and estimates into the runtime state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          shift: {
            id: 'sess-1',
            status: 'active',
            operatorName: 'Сергей Волков',
            workplace: 'POST-1',
            bigBagId: 'BB-15803-01',
            startKg: 500,
            bags: [
              {
                bagId: 'bag-1',
                code: 'BB-15803-01',
                material: 'ПВД 15803-020',
                materialId: 'rm-pvd-15803',
                warehouseKg: 500,
                startKg: 500,
                endKg: null,
                addedReason: null,
                releasedReason: null,
                active: true,
                releasedAt: null,
                sequence: 1,
              },
            ],
            balance: {
              producedKg: 41.4,
              defectKg: 0,
              expectedUsageKg: 43.6,
              actualUsageKg: null,
              deviationPercent: null,
              status: 'pending',
            },
            defectBag: {
              id: 'defect-bag-1',
              code: 'BR-0609-001',
              status: 'ready_for_warehouse',
              defectType: 'secondary',
              weightKg: 12.4,
              recordedDefectKg: 12.1,
              differenceKg: 0.3,
              labelState: 'submitted',
              weighedAt: '2026-09-06T15:00:00.000Z',
            },
            plannedConsumptionKg: 86.7,
            plannedShortageKg: 40,
            estimatedMinutes: 50,
          },
          generatedAt: '2026-07-13T08:10:00.000Z',
          orders: [],
        }),
      ),
    );
    const { fetchOperatorRuntime: fetchRuntime } = await import('./operator');
    const state = await fetchRuntime();
    expect(state.shift.bags).toHaveLength(1);
    expect(state.shift.bags?.[0].code).toBe('BB-15803-01');
    expect(state.shift.bags?.[0]).toMatchObject({
      active: true,
      releasedReason: null,
      releasedAt: null,
    });
    expect(state.shift.balanceStatus).toBe('pending');
    expect(state.shift.defectBag).toEqual(
      expect.objectContaining({ code: 'BR-0609-001', status: 'ready_for_warehouse' }),
    );
    expect(state.shift.plannedConsumptionKg).toBe(86.7);
    expect(state.shift.plannedShortageKg).toBe(40);
    expect(state.shift.estimatedMinutes).toBe(50);
    expect(state.shift.plannedUsageKg).toBe(86.7);
  });

  it('submits the manually entered shift defect-bag weight and prints it separately', async () => {
    const bag = {
      id: 'defect-bag-1',
      code: 'BR-0609-001',
      status: 'weighed',
      defectType: 'aika',
      weightKg: 12.4,
      recordedDefectKg: 12.1,
      differenceKg: 0.3,
      labelState: 'not_printed',
      weighedAt: '2026-09-06T15:00:00.000Z',
    } as const;
    const fetchMock = vi.fn().mockResolvedValue(okResponse(bag));
    vi.stubGlobal('fetch', fetchMock);

    await weighOperatorDefectBag(OPERATION_KEY, 12.4, 'aika');
    await printOperatorDefectBag(HANDOVER_OPERATION_KEY, 'Повтор после ошибки принтера', bag.id);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/operator/shift/defect-bag/weigh');
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      operationKey: OPERATION_KEY,
      weightKg: 12.4,
      defectType: 'aika',
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/operator/shift/defect-bag/print');
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({
      operationKey: HANDOVER_OPERATION_KEY,
      reason: 'Повтор после ошибки принтера',
      defectBagId: bag.id,
    });
  });

  it('submits zero defect weight without an arbitrary defect type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({
      id: 'zero-defect', code: 'DEF-zero', status: 'weighed', defectType: null,
      weightKg: 0, recordedDefectKg: 0, differenceKg: 0,
      labelState: 'not_printed', weighedAt: '2026-09-17T10:00:00.000Z',
    }));
    vi.stubGlobal('fetch', fetchMock);

    await weighOperatorDefectBag(OPERATION_KEY, 0, null);

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      operationKey: OPERATION_KEY, weightKg: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['openOperatorShift', '/api/operator/shift/open', { bigBagId: 'bag-1', startKg: 500 }],
    ['addOperatorShiftBag', '/api/operator/shift/bags', { bigBagId: 'bag-2', startKg: 300 }],
    [
      'closeOperatorShift',
      '/api/operator/shift/close',
      {
        operationKey: OPERATION_KEY,
        bags: [{ bigBagId: 'bag-1', endKg: 410 }],
      },
    ],
  ] as const)('%s posts to %s with its payload', async (fnName, path, payload) => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse(
        fnName === 'closeOperatorShift'
          ? {
              balance: {
                producedKg: 0,
                defectKg: 0,
                expectedUsageKg: 0,
                actualUsageKg: 0,
                deviationPercent: 0.1,
                status: 'ok',
              },
              problemId: null,
              releasedRollIds: [],
              closingPayroll: {
                sessionId: 'session-1',
                shiftId: 'shift-1',
                status: 'empty',
                appliedTariffOrders: [],
                summary: {
                  payableAmountKopecks: 0,
                  payableKg: 0,
                  machineShiftCount: 0,
                  unresolvedKg: 0,
                  unresolvedFactCount: 0,
                  excludedDefectKg: 0,
                  excludedDefectRollCount: 0,
                },
                breakdown: [],
                unresolved: [],
              },
            }
          : { ok: true },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = await import('./operator');
    await (api[fnName] as (input: unknown) => Promise<unknown>)(payload);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(path);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(payload);
  });

  it('adds a Big-Bag without asking the operator for a reason', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await addOperatorShiftBag({ bigBagId: 'bag-2', startKg: 300 });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      bigBagId: 'bag-2',
      startKg: 300,
    });
  });

  it('releases one weighed Big-Bag without closing the shift', async () => {
    const result = {
      code: 'BB-01',
      bagId: 'bag-1',
      startKg: 5000,
      endKg: 4000,
      active: false,
      status: 'available',
      releasedAt: '2026-08-10T12:00:00.000Z',
    };
    const fetchMock = vi.fn().mockResolvedValue(okResponse(result));
    vi.stubGlobal('fetch', fetchMock);
    const { releaseOperatorShiftBag } = await import('./operator');
    const payload = { operationKey: OPERATION_KEY, endKg: 4000 };

    await expect(releaseOperatorShiftBag('bag-1', payload)).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/operator/shift/bags/bag-1/release',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    );
  });

  it.each([
    [acceptOperatorRoll, '/api/operator/rolls/A-1-roll-1/accept'],
    [captureOperatorSpoolWeight, '/api/operator/rolls/A-1-roll-1/spool-weight'],
    [captureOperatorRollWeight, '/api/operator/rolls/A-1-roll-1/roll-weight'],
    [handoverOperatorRoll, '/api/operator/rolls/A-1-roll-1/handover'],
    [resumeOperatorRoll, '/api/operator/rolls/A-1-roll-1/resume'],
  ] as const)('posts a UUID operation key to %s', async (mutation, path) => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await mutation('A-1-roll-1', OPERATION_KEY);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(path);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ operationKey: OPERATION_KEY });
  });

  it('prints and verifies only with an explicit operation key and actual scanned payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await printOperatorQr('A-1-roll-1', OPERATION_KEY, 'Повторная печать');
    await verifyOperatorQr('A-1-roll-1', OPERATION_KEY, 'prt_'.padEnd(68, 'a'));

    expect(fetchMock.mock.calls[0][0]).toBe('/api/operator/rolls/A-1-roll-1/qr-print');
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
      operationKey: OPERATION_KEY,
      reason: 'Повторная печать',
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual({
      operationKey: OPERATION_KEY,
      payload: 'prt_'.padEnd(68, 'a'),
    });
  });

  it('submits QR verification and automatic handover as one server command with distinct keys', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ step: 'warehouse' }));
    vi.stubGlobal('fetch', fetchMock);

    await verifyAndHandoverOperatorQr(
      'A/1 roll',
      OPERATION_KEY,
      HANDOVER_OPERATION_KEY,
      'prt_'.padEnd(68, 'a'),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/operator/rolls/A%2F1%20roll/qr-verify-and-handover',
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      operationKey: OPERATION_KEY,
      handoverOperationKey: HANDOVER_OPERATION_KEY,
      payload: 'prt_'.padEnd(68, 'a'),
    });
  });

  it('defers a roll with the mandatory reason', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({}));
    vi.stubGlobal('fetch', fetchMock);
    const api = await import('./operator');
    await deferOperatorRoll('A-1-roll-1', OPERATION_KEY, 'Брак пленки');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/operator/rolls/A-1-roll-1/defer');
    expect(JSON.parse(init?.body as string)).toEqual({
      operationKey: OPERATION_KEY,
      reason: 'Брак пленки',
    });
  });

  it('reports a defect without requiring browser-supplied reason, weight, or blocking state', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await reportOperatorDefect({
      rollCode: 'A-1-roll-1',
      operationKey: OPERATION_KEY,
      comment: 'Текст из браузера не является обязательным фактом',
      weightKg: 999,
      blocking: false,
    } as never);

    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
      operationKey: OPERATION_KEY,
    });
  });

  it('reports a generic roll problem through the backend route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ id: 'problem-1' }));
    vi.stubGlobal('fetch', fetchMock);
    const api = await import('./operator');

    await api.reportOperatorProblem({
      operationKey: OPERATION_KEY,
      type: 'raw_material_shortage',
      rollId: 'A/1 roll',
      reason: 'Пленка уходит в складку',
      recovery: 'Зав. производства проверяет режим станка',
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/operator/problems');
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      operationKey: OPERATION_KEY,
      type: 'raw_material_shortage',
      rollId: 'A/1 roll',
      reason: 'Пленка уходит в складку',
      recovery: 'Зав. производства проверяет режим станка',
    });
  });

  it('rejects a system-owned problem type before sending a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const api = await import('./operator');

    await expect(
      api.reportOperatorProblem({
        operationKey: OPERATION_KEY,
        type: 'shift_balance_mismatch',
        rollId: 'A/1 roll',
        reason: 'Отклонение',
      } as never),
    ).rejects.toThrow('Недопустимый тип проблемы');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reuses the exact problem UUID after a committed 201 has malformed JSON, then clears it on success', async () => {
    const nextOperationKey = '22222222-2222-4222-8222-222222222222';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"id":', {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: OPERATION_KEY }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: nextOperationKey }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const api = await import('./operator');
    const createKey = vi
      .fn()
      .mockReturnValueOnce(OPERATION_KEY)
      .mockReturnValueOnce(nextOperationKey);
    const gate = new IdempotentOperationGate(createKey);
    const execute = (operationKey: string) =>
      api.reportOperatorProblem({
        operationKey,
        type: 'general',
        rollId: 'A-1-roll-1',
        reason: 'Остановка линии',
      });

    await expect(gate.start('operator:problem:A-1', execute)).rejects.toMatchObject({
      deliveryUncertain: true,
      status: 201,
    });
    await expect(gate.start('operator:problem:A-1', execute)).resolves.toBeUndefined();
    await expect(gate.start('operator:problem:A-1', execute)).resolves.toBeUndefined();

    expect(
      fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string)),
    ).toEqual([
      expect.objectContaining({ operationKey: OPERATION_KEY }),
      expect.objectContaining({ operationKey: OPERATION_KEY }),
      expect.objectContaining({ operationKey: nextOperationKey }),
    ]);
    expect(createKey).toHaveBeenCalledTimes(2);
  });

  it('hands a roll to backend without creating a local cross-role notification result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        id: 'warehouse-task-1',
        notification: 'SYNTHETIC-NOTIFICATION-MUST-NOT-ESCAPE',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await handoverOperatorRoll('A/1 roll', OPERATION_KEY);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/operator/rolls/A%2F1%20roll/handover');
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');
    expect(result).toBeUndefined();
  });

  it('reweighs with one operation UUID and preserves only the safe weight result', async () => {
    const safeResult = {
      rollCode: 'A/1 roll',
      step: 'handover' as const,
      previousWeight: { grossKg: 43, netKg: 41.2, toleranceOk: true },
      currentWeight: { grossKg: 42.9, netKg: 41.1, toleranceOk: null },
    } satisfies OperatorRollReweighResult;
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        ...safeResult,
        captureId: 'CAPTURE-SECRET',
        rawPayload: 'RAW-DEVICE-SECRET',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await reweighOperatorRoll('A/1 roll', OPERATION_KEY);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/operator/rolls/A%2F1%20roll/reweigh');
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      operationKey: OPERATION_KEY,
    });
    expect(result).toEqual(safeResult);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('returns a roll to the previous physical step with one operation UUID', async () => {
    const safeResult = {
      rollCode: 'A/1 roll',
      previousStep: 'qr_print' as const,
      step: 'roll_weight' as const,
    } satisfies OperatorRollStepBackResult;
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        ...safeResult,
        captureId: 'CAPTURE-SECRET',
        rawPayload: 'RAW-DEVICE-SECRET',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await stepBackOperatorRoll('A/1 roll', OPERATION_KEY);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/operator/rolls/A%2F1%20roll/step-back');
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      operationKey: OPERATION_KEY,
    });
    expect(result).toEqual(safeResult);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
});
