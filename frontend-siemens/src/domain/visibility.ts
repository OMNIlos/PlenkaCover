import type { ActionDescriptor, AdminWorkbench, AuditEntry, Fact, FactScope, PermissionCapability, ProblemCase, Role, Section, WarehouseWorkbench, Workbench, WorkObject } from './types';
import { getRoleAccessPolicy, roleHasCapability } from './accessPolicy';

export function canShowScope(role: Role, scope: FactScope | undefined) {
  if (!scope || scope === 'common') return true;
  if (scope === role) return true;
  return !getRoleAccessPolicy(role).hiddenScopes.includes(scope);
}

export function filterFacts(role: Role, facts: Fact[]) {
  return facts.filter((fact) => canShowScope(role, fact.scope));
}

export function filterSections(role: Role, sections: Section[]) {
  return sections
    .filter((section) => canShowScope(role, section.scope))
    .map((section) => ({
      ...section,
      facts: filterFacts(role, section.facts),
    }))
    .filter((section) => section.facts.length > 0);
}

export function filterProblems(role: Role, problems: ProblemCase[]) {
  return problems.filter((problem) => {
    if (role === 'operator') return ['Оператор', 'Админ'].includes(problem.ownerRole) || problem.stage === 'Вес';
    if (role === 'warehouse') return ['Склад', 'Админ'].includes(problem.ownerRole) || problem.stage === 'Сканирование';
    if (role === 'finance') return ['Бухгалтерия', 'Директор'].includes(problem.ownerRole) || ['Платеж', 'Рассрочка', 'Источник данных'].includes(problem.stage);
    return true;
  });
}

export function filterAudit(role: Role, audit: AuditEntry[]) {
  return audit.filter((entry) => canShowScope(role, entry.scope));
}

function requiredCapabilityForAction(action: ActionDescriptor): PermissionCapability | null {
  const id = action.id.toLowerCase();
  if (id.startsWith('warehouse-') || id.startsWith('warehouse.') || id === 'scan' || id.startsWith('scan-') || id === 'partial' || id.startsWith('reject')) return 'warehouse.scan';
  if (id.startsWith('admin.device.')) return 'device.recover';
  if (id.startsWith('admin-')) return id.includes('source') || id.includes('device') || id.includes('history') ? 'device.recover' : 'admin.access_manage';
  if (id.startsWith('finance-') || id.includes('payment') || id.includes('invoice')) return 'finance.mutate';
  if (id.startsWith('production-')) return 'production.mutate';
  if (id.startsWith('operator-') || id.includes('weight')) return 'operator.execute';
  if (id.includes('penalty')) return 'penalty.create';
  if (id.includes('override')) return 'finance.override';
  if (id.startsWith('commercial-')) return 'commercial.manage';
  return null;
}

function filterActions(role: Role, actions: ActionDescriptor[]) {
  return actions.filter((action) => {
    const required = requiredCapabilityForAction(action);
    return !required || roleHasCapability(role, required);
  });
}

function filterWarehouseWorkbench(role: Role, workbench: WarehouseWorkbench): WarehouseWorkbench {
  return {
    ...workbench,
    evidence: workbench.evidence ? filterFacts(role, workbench.evidence) : workbench.evidence,
  };
}

function filterAdminWorkbench(role: Role, workbench: AdminWorkbench): AdminWorkbench {
  const canSeeRaw = roleHasCapability(role, 'admin.raw_diagnostics');
  return {
    ...workbench,
    evidence: workbench.evidence ? filterFacts(role, workbench.evidence) : workbench.evidence,
    parsedRows: filterFacts(role, workbench.parsedRows),
    rawRows: canSeeRaw ? filterFacts(role, workbench.rawRows) : [],
    rawCollapsedLabel: canSeeRaw ? workbench.rawCollapsedLabel : 'Служебные данные скрыты',
  };
}

function filterWorkbench(role: Role, workbench: Workbench | undefined): Workbench | undefined {
  if (!workbench) return workbench;
  if (workbench.type === 'warehouse') return filterWarehouseWorkbench(role, workbench);
  if (workbench.type === 'admin') return filterAdminWorkbench(role, workbench);
  return workbench;
}

export function visibleObject(role: Role, object: WorkObject): WorkObject {
  return {
    ...object,
    facts: filterFacts(role, object.facts),
    sections: filterSections(role, object.sections),
    actions: filterActions(role, object.actions),
    problems: filterProblems(role, object.problems),
    audit: filterAudit(role, object.audit),
    workbench: filterWorkbench(role, object.workbench),
  };
}
