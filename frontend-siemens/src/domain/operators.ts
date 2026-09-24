import type { OperatorMachineAssignment, ProductionShift } from '../api/production';

export type ProductionOperator = {
  id: string;
  name: string;
  shortName: string;
  workplace: string;
  defaultMachineId: string;
  defaultMachineLabel: string;
  defaultMachineAssignedAt: string;
  shiftId?: string;
  shiftCapacityMinutes: number;
  remainingShiftMinutes: number;
  capacityKnown?: boolean;
  shift: string;
  activeTasks: number;
  plannedTasks: number;
  capacity: number;
  skill: string;
  status: 'available' | 'busy' | 'blocked';
};

export type CurrentOperatorAssignment =
  | {
      state: 'assigned';
      shift: ProductionShift;
      assignment: OperatorMachineAssignment;
    }
  | {
      state: 'conflict';
      shiftIds: string[];
    };

const CURRENT_ASSIGNMENT_STATUSES = new Set<OperatorMachineAssignment['status']>([
  'planned',
  'locked',
  'breakdown_reassigned',
]);

export function currentProductionAssignments(shifts: ProductionShift[]) {
  return shifts.flatMap((shift) =>
    ['planned', 'open'].includes(shift.status)
      ? (shift.machineAssignments ?? [])
          .filter((assignment) => CURRENT_ASSIGNMENT_STATUSES.has(assignment.status))
          .map((assignment) => ({ shift, assignment }))
      : [],
  );
}

export function currentAssignmentByOperator(shifts: ProductionShift[]) {
  const candidates = new Map<
    string,
    Array<{ shift: ProductionShift; assignment: OperatorMachineAssignment }>
  >();
  for (const candidate of currentProductionAssignments(shifts)) {
    const current = candidates.get(candidate.assignment.operatorId) ?? [];
    current.push(candidate);
    candidates.set(candidate.assignment.operatorId, current);
  }

  const result = new Map<string, CurrentOperatorAssignment>();
  for (const [operatorId, current] of candidates) {
    if (current.length === 1) {
      result.set(operatorId, { state: 'assigned', ...current[0] });
      continue;
    }
    result.set(operatorId, {
      state: 'conflict',
      shiftIds: [...new Set(current.map(({ shift }) => shift.id))].sort((left, right) =>
        left.localeCompare(right),
      ),
    });
  }
  return result;
}

export function productionShiftCapacity(
  plannedStartAt: string | null,
  plannedEndAt: string | null,
): Pick<
  ProductionOperator,
  'capacityKnown' | 'shiftCapacityMinutes' | 'remainingShiftMinutes'
> {
  if (!plannedStartAt || !plannedEndAt) {
    return {
      capacityKnown: false,
      shiftCapacityMinutes: 0,
      remainingShiftMinutes: 0,
    };
  }

  const durationMinutes = Math.round(
    (new Date(plannedEndAt).getTime() - new Date(plannedStartAt).getTime()) / 60_000,
  );
  const capacityMinutes = Number.isFinite(durationMinutes) ? Math.max(1, durationMinutes) : 0;
  return {
    capacityKnown: capacityMinutes > 0,
    shiftCapacityMinutes: capacityMinutes,
    remainingShiftMinutes: capacityMinutes,
  };
}

export const productionOperators: ProductionOperator[] = [
  {
    id: 'operator-line-a',
    name: 'Сергей Волков',
    shortName: 'Волков',
    workplace: 'Экструдер E-04',
    defaultMachineId: 'E-04',
    defaultMachineLabel: 'Экструдер E-04',
    defaultMachineAssignedAt: '07:45',
    shiftId: 'SHIFT-A-2026-07-06',
    shiftCapacityMinutes: 480,
    remainingShiftMinutes: 310,
    shift: 'Смена A',
    activeTasks: 1,
    plannedTasks: 2,
    capacity: 4,
    skill: 'Рукав 60-80 мкм',
    status: 'available',
  },
  {
    id: 'operator-line-b',
    name: 'Илья Ковалев',
    shortName: 'Ковалев',
    workplace: 'Экструдер E-02',
    defaultMachineId: 'E-02',
    defaultMachineLabel: 'Экструдер E-02',
    defaultMachineAssignedAt: '07:45',
    shiftId: 'SHIFT-A-2026-07-06',
    shiftCapacityMinutes: 480,
    remainingShiftMinutes: 240,
    shift: 'Смена A',
    activeTasks: 1,
    plannedTasks: 3,
    capacity: 4,
    skill: 'Молочная пленка',
    status: 'busy',
  },
  {
    id: 'operator-line-c',
    name: 'Максим Лебедев',
    shortName: 'Лебедев',
    workplace: 'Экструдер E-06',
    defaultMachineId: 'E-06',
    defaultMachineLabel: 'Экструдер E-06',
    defaultMachineAssignedAt: '15:45',
    shiftId: 'SHIFT-B-2026-07-06',
    shiftCapacityMinutes: 480,
    remainingShiftMinutes: 430,
    shift: 'Смена B',
    activeTasks: 0,
    plannedTasks: 1,
    capacity: 4,
    skill: 'Толстая пленка',
    status: 'available',
  },
  {
    id: 'operator-line-d',
    name: 'Андрей Морозов',
    shortName: 'Морозов',
    workplace: 'Экструдер E-01',
    defaultMachineId: 'E-01',
    defaultMachineLabel: 'Экструдер E-01',
    defaultMachineAssignedAt: '15:45',
    shiftId: 'SHIFT-B-2026-07-06',
    shiftCapacityMinutes: 480,
    remainingShiftMinutes: 180,
    shift: 'Смена B',
    activeTasks: 2,
    plannedTasks: 4,
    capacity: 4,
    skill: 'Срочные заказы',
    status: 'busy',
  },
  {
    id: 'operator-line-e',
    name: 'Павел Соколов',
    shortName: 'Соколов',
    workplace: 'Экструдер E-03',
    defaultMachineId: 'E-03',
    defaultMachineLabel: 'Экструдер E-03',
    defaultMachineAssignedAt: 'резерв',
    shiftId: 'SHIFT-RESERVE-2026-07-06',
    shiftCapacityMinutes: 360,
    remainingShiftMinutes: 360,
    shift: 'Резерв',
    activeTasks: 0,
    plannedTasks: 0,
    capacity: 3,
    skill: 'Резерв / подмена',
    status: 'available',
  },
];

export function operatorById(id: string | undefined) {
  return productionOperators.find((operator) => operator.id === id);
}

export function operatorByIdentity(value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return operatorById(normalized) ?? productionOperators.find((operator) =>
    normalized === operator.name ||
    normalized === operator.shortName ||
    normalized.includes(operator.name) ||
    normalized.includes(operator.shortName)
  );
}

export function operatorLabelById(id: string | undefined) {
  return operatorById(id)?.name ?? id ?? 'Не назначен';
}

export function operatorWorkloadLabel(operator: ProductionOperator) {
  return `${operator.activeTasks}/${operator.capacity} активн., ${operator.plannedTasks} в плане`;
}

export function operatorDefaultMachineLabel(operator: ProductionOperator | undefined) {
  return operator?.defaultMachineLabel ?? operator?.workplace ?? 'Станок не назначен';
}
