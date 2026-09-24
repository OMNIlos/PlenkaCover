import type { OperatorShift, OperatorShiftDefectBag } from './types';

export function operatorShiftDefectBags(shift: Pick<OperatorShift, 'defectBags' | 'defectBag'>) {
  return shift.defectBags ?? (shift.defectBag ? [shift.defectBag] : []);
}

export function withOperatorDefectBag(
  shift: OperatorShift,
  bag: OperatorShiftDefectBag,
): OperatorShift {
  const previous = operatorShiftDefectBags(shift);
  const defectBags = previous.some(({ id }) => id === bag.id)
    ? previous.map((entry) => (entry.id === bag.id ? bag : entry))
    : [...previous, bag];
  return { ...shift, defectBags, defectBag: defectBags[0] };
}

const LEGACY_DEFECT_BAG_CODE = /^DEF-c[a-z0-9]{20,}$/iu;
const LEGACY_SHIFT_LABEL = /^Смена оператора c[a-z0-9]{20,}$/iu;
const MOSCOW_DATE = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'Europe/Moscow',
});

export const DEFECT_BAG_TYPES = ['secondary', 'aika', 'primary'] as const;
export type DefectBagType = (typeof DEFECT_BAG_TYPES)[number];

const DEFECT_BAG_TYPE_LABELS: Record<DefectBagType, string> = {
  secondary: 'Вторичка',
  aika: 'Айка',
  primary: 'Первичка',
};

const DEFECT_BAG_WEIGH_ACTION_PREFIX = 'operator-weigh-defect-bag:';

type DefectBagLabelSource = {
  code: string;
  weighedAt: string;
  postCode?: string;
};

function weighedDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? MOSCOW_DATE.format(date) : null;
}

export function isDefectBagType(value: unknown): value is DefectBagType {
  return typeof value === 'string' && DEFECT_BAG_TYPES.includes(value as DefectBagType);
}

export function defectBagTypeLabel(value: DefectBagType | null) {
  return value === null ? 'Не указан' : DEFECT_BAG_TYPE_LABELS[value];
}

export function operatorDefectBagWeighAction(
  defectType: DefectBagType | null,
  weightKg: number,
  draftId?: string,
) {
  return `${DEFECT_BAG_WEIGH_ACTION_PREFIX}${defectType ?? 'none'}:${weightKg}${draftId ? `:${draftId}` : ''}`;
}

export function parseOperatorDefectBagWeighAction(actionId: string) {
  if (!actionId.startsWith(DEFECT_BAG_WEIGH_ACTION_PREFIX)) return null;
  const [defectType, rawWeight, draftId, extra] = actionId
    .slice(DEFECT_BAG_WEIGH_ACTION_PREFIX.length)
    .split(':');
  const weightKg = Number(rawWeight);
  if (
    extra !== undefined ||
    (draftId !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(draftId)) ||
    !(isDefectBagType(defectType) || (defectType === 'none' && weightKg === 0)) ||
    !rawWeight?.trim() ||
    !Number.isFinite(weightKg) ||
    weightKg < 0 ||
    weightKg > 10_000
  ) {
    return null;
  }
  return { defectType: defectType === 'none' ? null : defectType, weightKg, ...(draftId ? { draftId } : {}) };
}

export function parseOperatorDefectBagPrintAction(actionId: string) {
  const match = /^operator-(reprint|print)-defect-bag(?::([^:]+))?$/u.exec(actionId);
  return match ? { reprint: match[1] === 'reprint', defectBagId: match[2] } : null;
}

export function defectBagDisplayLabel(bag: DefectBagLabelSource) {
  const date = weighedDate(bag.weighedAt);
  if (!LEGACY_DEFECT_BAG_CODE.test(bag.code) || !date) return bag.code;
  return `Мешок брака ${date}${bag.postCode ? ` · ${bag.postCode}` : ''}`;
}

export function defectBagShiftDisplayLabel(
  bag: DefectBagLabelSource & { shiftLabel: string | null; operatorName: string },
) {
  if (bag.shiftLabel && !LEGACY_SHIFT_LABEL.test(bag.shiftLabel)) return bag.shiftLabel;
  const date = weighedDate(bag.weighedAt);
  if (!date) return bag.shiftLabel ?? 'Смена без названия';
  return `Смена ${date} · ${bag.operatorName}${bag.postCode ? ` · ${bag.postCode}` : ''}`;
}
