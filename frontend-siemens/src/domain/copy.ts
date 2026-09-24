import type { Severity } from './types';

export function severityLabel(severity: Severity) {
  const labels: Record<Severity, string> = {
    info: 'В норме',
    warning: 'Требует внимания',
    critical: 'Критично',
  };
  return labels[severity];
}

export function severityTone(severity: Severity) {
  const tones: Record<Severity, 'info' | 'warning' | 'critical'> = {
    info: 'info',
    warning: 'warning',
    critical: 'critical',
  };
  return tones[severity];
}

export const forbiddenGlobal = [
  'mock',
  'adapter',
  'source of truth',
  'ProductionOrder',
  'AuditEvent',
  'OperationalEvent',
];

export const operatorForbidden = ['Счет', 'Оплата', 'Откат', '1С', 'ООО'];

export const warehouseForbidden = ['Откат', 'Статус оплаты', 'Сумма', 'Влияние на стоимость'];
