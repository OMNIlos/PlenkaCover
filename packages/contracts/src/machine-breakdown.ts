export const MACHINE_BREAKDOWN_TYPES = [
  'screw_jam',
  'extruder_stopped',
  'drive_stopped',
  'belt_break',
  'other',
] as const;

export type MachineBreakdownType = (typeof MACHINE_BREAKDOWN_TYPES)[number];

export const MACHINE_BREAKDOWN_TYPE_LABELS = {
  screw_jam: 'Клин шнека',
  extruder_stopped: 'Экструдер остановился',
  drive_stopped: 'Остановка привода',
  belt_break: 'Обрыв ремня',
  other: 'Другая поломка',
} as const satisfies Record<MachineBreakdownType, string>;

export interface MachineBreakdownRequest {
  type: MachineBreakdownType;
  details?: string;
}
