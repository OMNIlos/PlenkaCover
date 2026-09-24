import type { CurrentRollResolution, OrderResolutionCase, WarehouseCoverResolutionOutcome } from './types';

export const warehouseResolutionOutcomeLabels: Record<WarehouseCoverResolutionOutcome, string> = {
  accepted_with_missing_to_production: 'Склад принят, остаток в производство',
  edited_position: 'Коммерция меняет позицию',
  warehouse_recheck_requested: 'Склад перепроверяет остатки',
  rejected_send_all_to_production: 'Все отправлено в производство',
};

export const currentRollResolutionLabels: Record<CurrentRollResolution, string> = {
  finish_old_version: 'Текущий рулон закончить по старой версии',
  stop_and_apply_new: 'Остановить и применить новую версию',
  mark_defect: 'Пометить текущий рулон как брак',
  requires_production_decision: 'Зав. производства решит отдельно',
};

export function parseWarehouseResolutionTarget(targetId?: string) {
  const [outcome, encodedReason] = (targetId ?? '').split(':');
  let reason = 'Причина указана коммерцией в разборе складского покрытия.';
  if (encodedReason) {
    try {
      reason = decodeURIComponent(encodedReason);
    } catch {
      reason = encodedReason;
    }
  }

  return {
    outcome: outcome as WarehouseCoverResolutionOutcome,
    reason,
  };
}

export function parseCorrectionTarget(targetId: string | undefined, fallbackRoll: number) {
  const [rollValue, currentRollResolution, encodedReason] = (targetId ?? '').split(':');
  const appliesFromRollNumber = Math.max(1, Number(rollValue) || fallbackRoll);
  let reason = 'Причина указана коммерцией в форме изменения.';
  if (encodedReason) {
    try {
      reason = decodeURIComponent(encodedReason);
    } catch {
      reason = encodedReason;
    }
  }
  return {
    appliesFromRollNumber,
    currentRollResolution: (currentRollResolution as CurrentRollResolution | undefined) ?? 'requires_production_decision',
    reason,
  };
}

export function upsertResolutionCase(cases: OrderResolutionCase[] | undefined, nextCase: OrderResolutionCase) {
  return [nextCase, ...(cases ?? []).filter((item) => item.id !== nextCase.id)];
}
