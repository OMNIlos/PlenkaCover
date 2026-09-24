import type { Counterparty, Role } from '@prisma/client';

type CounterpartyProjectionSource = Pick<
  Counterparty,
  'id' | 'displayName' | 'legalName' | 'inn' | 'billingSource' | 'syncStatus'
>;

export interface ProjectedCounterparty {
  id: string;
  displayName: string;
  legalName: string | null;
  inn: string | null;
  billingSource: string;
  syncStatus: string;
}

export interface ProjectedStockProductionTemplate {
  id: string;
  name: string;
  versionId: string;
  version: number;
}

export interface StockProductionTemplateProjectionSource {
  stockProductionTemplateId?: string | null;
  stockProductionTemplateName?: string | null;
  stockProductionTemplateVersionId?: string | null;
  stockProductionTemplateVersion?: { version: number } | null;
}

/**
 * Roles allowed to see a counterparty's legal name (ТЗ §4, §15).
 * Operator/warehouse/production never see the legal name before a visibility
 * decision — they get the safe displayName only.
 */
export const LEGAL_NAME_ROLES: ReadonlySet<Role> = new Set<Role>([
  'commercial',
  'finance',
  'director',
]);

export function projectCounterparty(
  cp: CounterpartyProjectionSource,
  actorRole: Role,
): ProjectedCounterparty;
export function projectCounterparty(cp: null, actorRole: Role): null;
export function projectCounterparty(
  cp: CounterpartyProjectionSource | null,
  actorRole: Role,
): ProjectedCounterparty | null;
export function projectCounterparty(
  cp: CounterpartyProjectionSource | null,
  actorRole: Role,
): ProjectedCounterparty | null {
  if (!cp) return null;
  const canSeeLegal = LEGAL_NAME_ROLES.has(actorRole);
  return {
    id: cp.id,
    displayName: cp.displayName,
    legalName: canSeeLegal ? (cp.legalName ?? null) : null,
    inn: canSeeLegal && cp.inn?.trim() ? cp.inn : null,
    billingSource: cp.billingSource,
    syncStatus: cp.syncStatus,
  };
}

export function projectStockProductionTemplate(
  order: StockProductionTemplateProjectionSource,
): ProjectedStockProductionTemplate | null {
  const id = order.stockProductionTemplateId;
  const name = order.stockProductionTemplateName;
  const versionId = order.stockProductionTemplateVersionId;
  const version = order.stockProductionTemplateVersion?.version;
  if (
    !id ||
    !name ||
    !versionId ||
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    return null;
  }
  return { id, name, versionId, version };
}
