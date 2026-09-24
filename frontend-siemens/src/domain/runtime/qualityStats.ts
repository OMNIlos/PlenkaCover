import type { Fact } from '../types';
import type {
  DefectRuntime,
  ProductionRuntimeState,
  QualityDefectStats,
  QualityDefectStatsProjection,
} from './types';

function emptyStats(): QualityDefectStats {
  return {
    totalCount: 0,
    operatorCount: 0,
    warehouseCount: 0,
    blockingCount: 0,
    totalWeightKg: 0,
    latestLabel: 'нет записей',
    sourceEventCount: 0,
  };
}

function addDefect(stats: QualityDefectStats, defect: DefectRuntime, sourceEventCount: number): QualityDefectStats {
  const totalWeightKg = stats.totalWeightKg + (defect.weightKg ?? 0);
  return {
    totalCount: stats.totalCount + 1,
    operatorCount: stats.operatorCount + (defect.sourceRole === 'operator' ? 1 : 0),
    warehouseCount: stats.warehouseCount + (defect.sourceRole === 'warehouse' ? 1 : 0),
    blockingCount: stats.blockingCount + (defect.blocking ? 1 : 0),
    totalWeightKg,
    latestLabel: `${defect.rollId} · ${defect.sourceRole === 'warehouse' ? 'склад' : 'оператор'}`,
    latestObjectId: defect.acceptanceId ?? defect.taskId,
    sourceEventCount: stats.sourceEventCount + sourceEventCount,
  };
}

function defectSourceEventCount(runtime: ProductionRuntimeState, defect: DefectRuntime) {
  return runtime.events.filter((event) =>
    (event.family === 'MasterKpiEvent' || event.family === 'ProblemEvent')
    && (event.objectId === defect.rollId || event.objectId === defect.taskId || event.objectId === defect.acceptanceId)
    && (event.type.includes('defect') || event.type.includes('damaged') || event.label.toLowerCase().includes('брак'))
  ).length;
}

function warehouseDefectsFromDamagedRolls(runtime: ProductionRuntimeState) {
  const recordedRollIds = new Set(runtime.defects.map((defect) => defect.rollId));
  return runtime.warehouseAcceptances.flatMap((acceptance) =>
    acceptance.rolls
      .filter((roll) => roll.status === 'damaged' && !recordedRollIds.has(roll.id))
      .map((roll): DefectRuntime => ({
        id: `DEF-${acceptance.id}-${roll.id}`,
        rollId: roll.id,
        taskId: acceptance.sourceTaskId,
        orderId: acceptance.orderId,
        acceptanceId: acceptance.id,
        sourceRole: 'warehouse',
        comment: acceptance.scanResult ?? `${roll.id}: брак зафиксирован складом.`,
        blocking: true,
        createdAt: acceptance.createdAt,
      }))
  );
}

export function buildQualityDefectStatsProjection(runtime: ProductionRuntimeState): QualityDefectStatsProjection {
  const allDefects = [...runtime.defects, ...warehouseDefectsFromDamagedRolls(runtime)];
  const byTaskId: Record<string, QualityDefectStats> = {};
  const byAcceptanceId: Record<string, QualityDefectStats> = {};
  let summary = emptyStats();

  for (const defect of allDefects) {
    const sourceEventCount = defectSourceEventCount(runtime, defect);
    summary = addDefect(summary, defect, sourceEventCount);
    byTaskId[defect.taskId] = addDefect(byTaskId[defect.taskId] ?? emptyStats(), defect, sourceEventCount);
    if (defect.acceptanceId) {
      byAcceptanceId[defect.acceptanceId] = addDefect(byAcceptanceId[defect.acceptanceId] ?? emptyStats(), defect, sourceEventCount);
    }
  }

  return { summary, byTaskId, byAcceptanceId };
}

export function qualityDefectFacts(stats: QualityDefectStats, scope: Fact['scope'] = 'production'): Fact[] {
  const weightLabel = stats.totalWeightKg > 0 ? `${Number(stats.totalWeightKg.toFixed(1))} кг` : 'нет данных';
  return [
    { label: 'Записи брака', value: String(stats.totalCount), scope },
    { label: 'Оператор', value: String(stats.operatorCount), scope },
    { label: 'Склад', value: String(stats.warehouseCount), scope },
    { label: 'Вес брака', value: weightLabel, scope, helpText: 'Вес показывается только когда есть событие взвешивания; складской брак без веса не досчитывается догадкой.' },
    { label: 'Открытые блокеры', value: String(stats.blockingCount), scope },
    { label: 'Последняя запись', value: stats.latestLabel, scope },
    { label: 'Источник статистики', value: `${stats.sourceEventCount} событий качества`, scope },
  ];
}

export function hasQualityDefectStatsSignal(facts: Fact[] | undefined): boolean {
  if (!facts) return false;
  return facts.some((fact) => {
    const label = fact.label.toLowerCase();
    const value = String(fact.value).trim().toLowerCase();
    const numericValue = Number.parseFloat(value.replace(',', '.'));

    if (['записи брака', 'оператор', 'склад', 'открытые блокеры'].includes(label)) {
      return Number.isFinite(numericValue) && numericValue > 0;
    }

    if (label === 'вес брака') {
      return value.includes('кг') && Number.isFinite(numericValue) && numericValue > 0;
    }

    if (label === 'последняя запись') {
      return value !== '' && value !== 'нет записей' && value !== 'нет данных' && value !== '-' && value !== '—';
    }

    if (label === 'источник статистики') {
      return Number.isFinite(numericValue) && numericValue > 0;
    }

    return false;
  });
}
