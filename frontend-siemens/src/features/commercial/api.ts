import type { IntakeDraftForm } from '../../domain/prototypeRuntime';
import type { NotificationItem, RequestCreatorRole } from '../../domain/types';
import { commercialOrderPositionPayloadForDraft } from '../../domain/materialRecipeCatalog';
import { normalizeWarehouseCoverage } from '../../domain/warehouseCoverage';
import { normalizeCommercialWarehouseCoverage } from '../../api/commercial';
import { apiDelete, apiGet, apiPatch, apiPost, type ApiRequestOptions } from '../../api/client';
import {
  fetchRoleInbox,
  mapRoleInboxItem,
  markRoleInboxRead,
  type RoleInboxPage,
  type ServerRoleInboxItem,
} from '../../api/roleInbox';
import type {
  CommercialOrderDetailContract,
  CommercialOrderAmendmentResultContract,
  CommercialOrderCancellationResultContract,
  CommercialOrderCommentContract,
  CommercialOrderPageContract,
  CommercialOrderQueryContract,
  CommercialOrderSection,
  CommercialProblemPageContract,
  CommercialProblemQueryContract,
  CommercialCurrentRollResolution,
  CommercialBigBagValueContract,
  CommercialQueueModeLabel,
  CommercialRawMaterialRiskPageContract,
  CommercialRequestType,
  CommercialTemplatePositionContract,
  CommercialTemplateVersionContract,
  WarehouseCoverProposalContract,
  WarehouseCoverRouteContract,
} from './contracts';
import type { StockProductionTemplate } from '../../api/stockProductionTemplates';
import type { CommercialCounterpartyContract } from './counterpartyApi';

export { fetchCommercialCounterparties, searchCommercialCounterparties } from './counterpartyApi';
export type {
  CommercialCounterpartyContract,
  CommercialCounterpartySearchPage,
} from './counterpartyApi';

const SECTION_BUCKETS: Record<CommercialOrderSection, CommercialOrderQueryContract['bucket']> = {
  'Входящие заявки': 'incoming',
  Черновики: 'drafts',
  'В работе': 'in_work',
  Выполненные: 'completed',
};

export type CommercialOrderFilterInput = {
  section: CommercialOrderSection;
  mode: CommercialQueueModeLabel;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
};

export function buildCommercialOrderQuery(
  input: CommercialOrderFilterInput,
): CommercialOrderQueryContract {
  return {
    bucket: SECTION_BUCKETS[input.section],
    mode: input.mode === 'Требуют действий' ? 'action_required' : 'current',
    ...(input.from ? { from: input.from } : {}),
    ...(input.to ? { to: input.to } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    limit: input.limit ?? 20,
  };
}

export function fetchCommercialOrderPage(
  query: CommercialOrderQueryContract,
): Promise<CommercialOrderPageContract> {
  const params = new URLSearchParams({
    bucket: query.bucket,
    mode: query.mode,
  });
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.cursor) params.set('cursor', query.cursor);
  params.set('limit', String(query.limit));
  return apiGet<CommercialOrderPageContract>(`/api/commercial/orders?${params}`);
}

export function fetchCommercialProblems(
  query: CommercialProblemQueryContract,
  signal?: AbortSignal,
): Promise<CommercialProblemPageContract> {
  const params = new URLSearchParams({
    filter: query.filter,
    limit: String(query.limit ?? 20),
  });
  if (query.cursor) params.set('cursor', query.cursor);
  return apiGet<CommercialProblemPageContract>(`/api/commercial/problems?${params.toString()}`, {
    signal,
  });
}

export async function fetchCommercialOrderDetail(
  orderId: string,
  options?: ApiRequestOptions,
): Promise<CommercialOrderDetailContract> {
  const payload = await apiGet<unknown>(
    `/api/commercial/orders/${encodeURIComponent(orderId)}`,
    options,
  );
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    typeof (payload as { id?: unknown }).id !== 'string' ||
    (payload as { id: string }).id !== orderId
  ) {
    throw new Error('Карточка заказа не совпадает с созданной заявкой.');
  }
  const detail = payload as CommercialOrderDetailContract;
  const workflowVersion = detail.warehouseCoverageWorkflowVersion;
  if (workflowVersion === undefined) return detail;
  if (workflowVersion !== 1 && workflowVersion !== 2) {
    throw new Error('Некорректная версия процесса покрытия склада.');
  }

  const coverage =
    workflowVersion === 2
      ? normalizeCommercialWarehouseCoverage(detail.warehouseCoverage)
      : normalizeWarehouseCoverage(detail.warehouseCoverage);
  if (coverage.workflowVersion !== workflowVersion) {
    throw new Error('Версия расчёта покрытия не совпадает с версией заказа.');
  }
  return {
    ...detail,
    warehouseCoverage: coverage,
    ...(workflowVersion === 2
      ? {
          positions: detail.positions.map((position) => ({
            ...position,
            coverProposals: [],
          })),
        }
      : {}),
  };
}

export function fetchCommercialRawMaterialRisks({
  cursor,
  limit = 20,
  q,
}: {
  cursor?: string;
  limit?: number;
  q?: string;
} = {}): Promise<CommercialRawMaterialRiskPageContract> {
  const params = new URLSearchParams({ limit: String(limit) });
  const normalizedQuery = q?.trim();
  if (normalizedQuery) params.set('q', normalizedQuery);
  if (cursor) params.set('cursor', cursor);
  return apiGet<CommercialRawMaterialRiskPageContract>(`/api/commercial/raw-materials?${params}`);
}

export function fetchCommercialBigBagValues(): Promise<CommercialBigBagValueContract[]> {
  return apiGet<CommercialBigBagValueContract[]>('/api/commercial/raw-materials/big-bags');
}

const COMMERCIAL_TEMPLATE_STATUSES = ['active', 'archived'] as const;
const COMMERCIAL_TEMPLATE_OWNER_ROLES = [
  'commercial',
  'production_lead',
  'operator',
  'warehouse',
  'finance',
  'director',
  'admin',
] as const;

type CommercialTemplateOwnerRole = (typeof COMMERCIAL_TEMPLATE_OWNER_ROLES)[number];

export type CommercialIntakeTemplateContract = {
  id: string;
  counterpartyId: string;
  name: string;
  description: string | null;
  status: (typeof COMMERCIAL_TEMPLATE_STATUSES)[number];
  ownerRole: CommercialTemplateOwnerRole;
  version: number;
  positions: CommercialTemplatePositionContract[];
  versions: Array<CommercialTemplateVersionContract & { createdById: string | null }>;
  activeVersionId: string;
  usageCount: number;
  lastUsedAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
};

type CommercialCreateOrderBaseCommand = {
  clientRequestId: string;
  mode: 'draft' | 'submit';
  comment?: string;
  onBehalfOfCommercial?: boolean;
  positions: Array<
    {
      rollCount: number;
      filmType: string;
      actualThickness: string;
      accountingThickness: string;
      widthMm: number;
      plannedLengthM: number;
      spoolType?: string;
      birka?: string;
      manualBirka?: string;
      comment?: string;
      plannedWeightKg?: number;
    } & (
      | {
          baseRawMaterialDefinitionId: string;
          recipeDefinitionVersionId?: never;
        }
      | {
          recipeDefinitionVersionId: string;
          baseRawMaterialDefinitionId?: never;
        }
    )
  >;
};

export type CommercialCreateOrderCommand = CommercialCreateOrderBaseCommand &
  (
    | {
        requestType: 'client_order';
        counterpartyId: string;
        commercialFinanceNote?: string;
        templateId?: string;
        templateVersionId?: string;
        saveAsTemplate?: boolean;
      }
    | {
        requestType: 'stock_reserve';
        counterpartyId?: never;
        templateId?: never;
        templateVersionId?: never;
        stockProductionTemplateId?: string;
        stockProductionTemplateVersionId?: string;
      }
  );

export type CommercialCreateOrderResult = { id: string } & Record<string, unknown>;

export type CommercialPositionPatchCommand = {
  expectedVersion: number;
  rollCount?: number;
  filmType?: string;
  actualThickness?: string;
  accountingThickness?: string;
  widthMm?: number;
  plannedLengthM?: number;
  rawMaterialId?: string;
  baseRawMaterialDefinitionId?: string | null;
  recipeDefinitionVersionId?: string | null;
  spoolType?: string;
  birka?: string;
  manualBirka?: string;
  comment?: string;
  plannedWeightKg?: number;
  recipeParameters?: Array<{ label: string; value: string }>;
};

export type CommercialFinanceNotePatchCommand = {
  commercialFinanceNote: string | null;
  expectedVersion: number;
  operationKey: string;
};

export type CommercialFinanceNotePatchResult = {
  id: string;
  version: number;
  commercialFinanceNote: string | null;
};

export type CommercialOrderCommentCommand = {
  expectedVersion: number;
  comment: string;
};

export type CommercialOrderAmendmentCommand =
  | {
      kind: 'add_position';
      operationKey: string;
      expectedOrderVersion: number;
      reason: string;
      position: CommercialCreateOrderCommand['positions'][number];
    }
  | {
      kind: 'update_position';
      operationKey: string;
      expectedOrderVersion: number;
      reason: string;
      positionId: string;
      expectedPositionVersion: number;
      changes: Omit<CommercialPositionPatchCommand, 'expectedVersion'>;
    }
  | {
      kind: 'cancel_remaining_position';
      operationKey: string;
      expectedOrderVersion: number;
      reason: string;
      positionId: string;
      expectedPositionVersion: number;
    };

export type CommercialOrderCancellationCommand = {
  operationKey: string;
  expectedVersion: number;
  reason: string;
};

export async function fetchCommercialTemplates(
  counterpartyId: string,
  options?: ApiRequestOptions,
): Promise<CommercialIntakeTemplateContract[]> {
  const response = await apiGet<unknown>(
    `/api/commercial/counterparties/${encodeURIComponent(counterpartyId)}/templates`,
    options,
  );
  return parseCommercialTemplates(response, counterpartyId);
}

function parseCommercialTemplates(
  value: unknown,
  expectedCounterpartyId: string,
): CommercialIntakeTemplateContract[] {
  if (!Array.isArray(value) || value.length > 500) throw invalidCommercialTemplates();
  const versionIds = new Set<string>();
  const templates = value.map((item) =>
    parseCommercialTemplate(item, expectedCounterpartyId, versionIds),
  );
  if (new Set(templates.map((template) => template.id)).size !== templates.length) {
    throw invalidCommercialTemplates();
  }
  return templates;
}

function parseCommercialTemplate(
  value: unknown,
  expectedCounterpartyId: string,
  responseVersionIds: Set<string>,
): CommercialIntakeTemplateContract {
  if (!isCommercialTemplateRecord(value)) throw invalidCommercialTemplates();
  const requiredKeys = [
    'id',
    'counterpartyId',
    'name',
    'description',
    'status',
    'ownerRole',
    'version',
    'positions',
    'versions',
    'usageCount',
    'lastUsedAt',
    'createdById',
    'createdAt',
    'updatedAt',
  ] as const;
  if (
    !requiredKeys.every((key) => Object.hasOwn(value, key)) ||
    !isCommercialTemplateText(value.id) ||
    value.counterpartyId !== expectedCounterpartyId ||
    !isCommercialTemplateText(value.name) ||
    (value.description !== null && typeof value.description !== 'string') ||
    !isCommercialTemplateEnum(value.status, COMMERCIAL_TEMPLATE_STATUSES) ||
    !isCommercialTemplateEnum(value.ownerRole, COMMERCIAL_TEMPLATE_OWNER_ROLES) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 1 ||
    !isCommercialTemplatePositions(value.positions) ||
    !Array.isArray(value.versions) ||
    value.versions.length === 0 ||
    value.versions.length > 100 ||
    !Number.isSafeInteger(value.usageCount) ||
    (value.usageCount as number) < 0 ||
    (value.lastUsedAt !== null && !isCommercialTemplateTimestamp(value.lastUsedAt)) ||
    (value.createdById !== null && !isCommercialTemplateText(value.createdById)) ||
    !isCommercialTemplateTimestamp(value.createdAt) ||
    !isCommercialTemplateTimestamp(value.updatedAt)
  ) {
    throw invalidCommercialTemplates();
  }

  const versionNumbers = new Set<number>();
  const versions = value.versions.map((version) => {
    const parsed = parseCommercialTemplateVersion(version, value.id as string);
    if (responseVersionIds.has(parsed.id) || versionNumbers.has(parsed.version)) {
      throw invalidCommercialTemplates();
    }
    responseVersionIds.add(parsed.id);
    versionNumbers.add(parsed.version);
    return parsed;
  });
  const activeVersion = versions.find((version) => version.version === value.version);
  if (!activeVersion) throw invalidCommercialTemplates();

  return {
    ...(value as Omit<CommercialIntakeTemplateContract, 'activeVersionId'>),
    versions,
    activeVersionId: activeVersion.id,
  };
}

function parseCommercialTemplateVersion(
  value: unknown,
  expectedTemplateId: string,
): CommercialTemplateVersionContract & { createdById: string | null } {
  if (
    !isCommercialTemplateRecord(value) ||
    !['id', 'templateId', 'version', 'positions', 'createdById', 'createdAt'].every((key) =>
      Object.hasOwn(value, key),
    ) ||
    !isCommercialTemplateText(value.id) ||
    value.templateId !== expectedTemplateId ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 1 ||
    !isCommercialTemplatePositions(value.positions) ||
    (value.createdById !== null && !isCommercialTemplateText(value.createdById)) ||
    !isCommercialTemplateTimestamp(value.createdAt)
  ) {
    throw invalidCommercialTemplates();
  }
  return value as CommercialTemplateVersionContract & { createdById: string | null };
}

function isCommercialTemplatePositions(
  value: unknown,
): value is CommercialTemplatePositionContract[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return false;
  const positionIds = new Set<string>();
  return value.every((position) => {
    if (!isCommercialTemplatePosition(position)) return false;
    if (!Object.hasOwn(position, 'id')) return true;
    const id = position.id as string;
    if (positionIds.has(id)) return false;
    positionIds.add(id);
    return true;
  });
}

function isCommercialTemplatePosition(value: unknown): boolean {
  if (
    !isCommercialTemplateRecord(value) ||
    !['rollCount', 'filmType', 'actualThickness', 'accountingThickness', 'recipeParameters'].every(
      (key) => Object.hasOwn(value, key),
    ) ||
    !Number.isSafeInteger(value.rollCount) ||
    (value.rollCount as number) < 1 ||
    (value.rollCount as number) > 10_000 ||
    !isCommercialTemplateText(value.filmType) ||
    !isCommercialTemplateText(value.actualThickness) ||
    !isCommercialTemplateText(value.accountingThickness) ||
    !Array.isArray(value.recipeParameters) ||
    value.recipeParameters.length > 50 ||
    !value.recipeParameters.every(isCommercialTemplateParameter)
  ) {
    return false;
  }
  return (
    isOptionalCommercialTemplateText(value, 'id', false) &&
    isOptionalCommercialTemplateText(value, 'rawMaterialId', true) &&
    isOptionalCommercialTemplateText(value, 'baseRawMaterialDefinitionId', true) &&
    isOptionalCommercialTemplateText(value, 'recipeDefinitionVersionId', true) &&
    isOptionalCommercialTemplateText(value, 'spoolType', true) &&
    isOptionalCommercialTemplateText(value, 'birka', true) &&
    isOptionalCommercialTemplateText(value, 'manualBirka', true) &&
    isOptionalCommercialTemplateText(value, 'comment', true) &&
    isOptionalCommercialTemplateNumber(value, 'widthMm', 100_000) &&
    isOptionalCommercialTemplateNumber(value, 'plannedLengthM', 10_000_000) &&
    isOptionalCommercialTemplateNumber(value, 'plannedWeightKg', 100_000)
  );
}

function isCommercialTemplateParameter(value: unknown): boolean {
  return (
    isCommercialTemplateRecord(value) &&
    Object.hasOwn(value, 'label') &&
    Object.hasOwn(value, 'value') &&
    isCommercialTemplateText(value.label) &&
    typeof value.value === 'string'
  );
}

function isOptionalCommercialTemplateText(
  value: Record<string, unknown>,
  key: string,
  nullable: boolean,
): boolean {
  if (!Object.hasOwn(value, key)) return true;
  if (nullable && value[key] === null) return true;
  return nullable ? typeof value[key] === 'string' : isCommercialTemplateText(value[key]);
}

function isOptionalCommercialTemplateNumber(
  value: Record<string, unknown>,
  key: string,
  max: number,
): boolean {
  if (!Object.hasOwn(value, key) || value[key] === null) return true;
  return (
    typeof value[key] === 'number' &&
    Number.isFinite(value[key]) &&
    value[key] > 0 &&
    value[key] <= max
  );
}

function isCommercialTemplateRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCommercialTemplateText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCommercialTemplateTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isCommercialTemplateEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): value is T[number] {
  return typeof value === 'string' && allowed.includes(value);
}

function invalidCommercialTemplates(): Error {
  return new Error('Некорректный ответ каталога шаблонов контрагента.');
}

export function buildCommercialCreateOrderCommand({
  form,
  counterpartyId,
  stockProductionTemplateVersionId,
  requestType = 'client_order',
  clientRequestId,
  mode,
}: {
  form: IntakeDraftForm;
  counterpartyId?: string;
  stockProductionTemplateVersionId?: string;
  requestType?: CommercialRequestType;
  clientRequestId: string;
  creatorRole: RequestCreatorRole;
  mode: 'draft' | 'submit';
}): CommercialCreateOrderCommand {
  const base: CommercialCreateOrderBaseCommand = {
    clientRequestId,
    mode,
    ...(form.comment.trim() ? { comment: form.comment.trim() } : {}),
    positions: form.positions.map(commercialOrderPositionPayloadForDraft),
  };
  if (requestType === 'stock_reserve') {
    if (form.stockProductionTemplateId && !stockProductionTemplateVersionId) {
      throw new Error('Не удалось определить версию шаблона производства на запас.');
    }
    return {
      ...base,
      requestType,
      ...(form.stockProductionTemplateId && stockProductionTemplateVersionId
        ? {
            stockProductionTemplateId: form.stockProductionTemplateId,
            stockProductionTemplateVersionId,
          }
        : {}),
    };
  }
  if (!counterpartyId) {
    throw new Error('Не выбран контрагент.');
  }
  return {
    ...base,
    requestType,
    counterpartyId,
    ...((form.commercialFinanceNote ?? '').trim()
      ? { commercialFinanceNote: (form.commercialFinanceNote ?? '').trim() }
      : {}),
    ...(form.templateId ? { templateId: form.templateId } : {}),
    ...(form.templateId && form.templateVersionId
      ? { templateVersionId: form.templateVersionId }
      : {}),
    ...(form.saveAsTemplate ? { saveAsTemplate: true } : {}),
  };
}

export async function createCommercialOrderFromIntake({
  form,
  counterparties,
  templates,
  stockTemplates = [],
  creatorRole,
  mode,
  clientRequestId,
  requestType = 'client_order',
}: {
  form: IntakeDraftForm;
  counterparties: CommercialCounterpartyContract[];
  templates: CommercialIntakeTemplateContract[];
  stockTemplates?: StockProductionTemplate[];
  creatorRole: RequestCreatorRole;
  mode: 'draft' | 'submit';
  clientRequestId: string;
  requestType?: CommercialRequestType;
}): Promise<CommercialCreateOrderResult> {
  form.positions.forEach(commercialOrderPositionPayloadForDraft);
  const counterpartyId =
    requestType === 'client_order'
      ? await resolveCommercialCounterpartyId(form, counterparties)
      : undefined;
  const selectedTemplate =
    requestType === 'client_order' && form.templateId
      ? templates.find((template) => template.id === form.templateId)
      : undefined;
  if (requestType === 'client_order' && form.templateId && !selectedTemplate) {
    throw new Error('Выбранный шаблон устарел. Обновите список шаблонов.');
  }
  const selectedStockTemplate =
    requestType === 'stock_reserve' && form.stockProductionTemplateId
      ? stockTemplates.find((template) => template.id === form.stockProductionTemplateId)
      : undefined;
  if (requestType === 'stock_reserve' && form.stockProductionTemplateId && !selectedStockTemplate) {
    throw new Error('Выбранный шаблон производства на запас устарел. Обновите каталог.');
  }
  const selectedStockTemplateVersion = selectedStockTemplate?.versions.find(
    (version) => version.version === selectedStockTemplate.version,
  );
  if (selectedStockTemplate && !selectedStockTemplateVersion) {
    throw new Error('Версия шаблона производства на запас недоступна. Обновите каталог.');
  }
  const command = buildCommercialCreateOrderCommand({
    form,
    requestType,
    counterpartyId,
    stockProductionTemplateVersionId: selectedStockTemplateVersion?.id,
    clientRequestId,
    creatorRole,
    mode,
  });
  return apiPost<CommercialCreateOrderResult>('/api/commercial/orders', command);
}

export function updateCommercialPosition(
  orderId: string,
  positionId: string,
  command: CommercialPositionPatchCommand,
): Promise<CommercialOrderDetailContract> {
  return apiPatch<CommercialOrderDetailContract>(
    `/api/commercial/orders/${encodeURIComponent(orderId)}/positions/${encodeURIComponent(positionId)}`,
    command,
  );
}

export function updateCommercialFinanceNote(
  orderId: string,
  command: CommercialFinanceNotePatchCommand,
): Promise<CommercialFinanceNotePatchResult> {
  return apiPatch<CommercialFinanceNotePatchResult>(
    `/api/commercial/orders/${encodeURIComponent(orderId)}/finance-note`,
    command,
  );
}

export function updateCommercialOrderComment(
  orderId: string,
  command: CommercialOrderCommentCommand,
): Promise<CommercialOrderCommentContract> {
  return apiPatch<CommercialOrderCommentContract>(
    `/api/commercial/orders/${encodeURIComponent(orderId)}/comment`,
    command,
  );
}

export function amendCommercialOrder(
  orderId: string,
  command: CommercialOrderAmendmentCommand,
): Promise<CommercialOrderAmendmentResultContract> {
  return apiPost<CommercialOrderAmendmentResultContract>(
    `/api/commercial/orders/${encodeURIComponent(orderId)}/amendments`,
    command,
  );
}

export function cancelCommercialOrder(
  orderId: string,
  command: CommercialOrderCancellationCommand,
): Promise<CommercialOrderCancellationResultContract> {
  return apiPost<CommercialOrderCancellationResultContract>(
    `/api/commercial/orders/${encodeURIComponent(orderId)}/cancellations`,
    command,
  );
}

export function deleteCommercialOrder(orderId: string): Promise<void> {
  return apiDelete(`/api/commercial/orders/${encodeURIComponent(orderId)}`);
}

export async function promoteCommercialDraft(
  orderId: string,
): Promise<CommercialOrderDetailContract> {
  await apiPost<unknown>(`/api/commercial/orders/${encodeURIComponent(orderId)}/promote-draft`, {});
  return fetchCommercialOrderDetail(orderId);
}

export async function handoffCommercialOrderToFinance(
  orderId: string,
  input: { amount?: number; note?: string } = {},
): Promise<CommercialOrderDetailContract> {
  await apiPost<unknown>(`/api/commercial/orders/${encodeURIComponent(orderId)}/invoice-handoff`, {
    ...(input.amount !== undefined ? { amount: input.amount } : {}),
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
  });
  return fetchCommercialOrderDetail(orderId);
}

export async function requestCommercialWarehouseCover(
  orderId: string,
): Promise<CommercialOrderDetailContract> {
  await apiPost<unknown>(
    `/api/commercial/orders/${encodeURIComponent(orderId)}/warehouse-cover/recheck`,
    {},
  );
  return fetchCommercialOrderDetail(orderId);
}

export async function handoffCommercialOrderToProduction(
  orderId: string,
): Promise<CommercialOrderDetailContract> {
  await apiPost<unknown>(
    `/api/commercial/orders/${encodeURIComponent(orderId)}/send-to-production`,
    {},
  );
  return fetchCommercialOrderDetail(orderId);
}

export function approveCommercialWarehouseCover(
  orderId: string,
  positionId: string,
  proposalId: string,
  command: { expectedVersion: number; route: WarehouseCoverRouteContract },
): Promise<WarehouseCoverProposalContract> {
  return apiPost<WarehouseCoverProposalContract>(
    `/api/commercial/orders/${encodeURIComponent(orderId)}/positions/${encodeURIComponent(positionId)}/warehouse-cover/${encodeURIComponent(proposalId)}/commercial-approval`,
    command,
  );
}

export function approveTechnicalWarehouseCover(
  orderId: string,
  positionId: string,
  proposalId: string,
  expectedVersion: number,
): Promise<WarehouseCoverProposalContract> {
  return apiPost<WarehouseCoverProposalContract>(
    `/api/commercial/orders/${encodeURIComponent(orderId)}/positions/${encodeURIComponent(positionId)}/warehouse-cover/${encodeURIComponent(proposalId)}/technical-approval`,
    { expectedVersion },
  );
}

export function requestCommercialWarehouseCoverRecheck(
  orderId: string,
  positionId: string,
  proposalId: string,
  command: { expectedVersion: number; reason: string },
): Promise<WarehouseCoverProposalContract> {
  return apiPost<WarehouseCoverProposalContract>(
    `/api/commercial/orders/${encodeURIComponent(orderId)}/positions/${encodeURIComponent(positionId)}/warehouse-cover/${encodeURIComponent(proposalId)}/recheck`,
    command,
  );
}

export type CommercialProblemCorrectionCommand = {
  positionId: string;
  fromRollId: string;
  expectedRecipeVersion: string;
  currentRollResolution: CommercialCurrentRollResolution;
  newParameters: Array<{ label: string; value: string }>;
  reason: string;
};

export type CommercialProblemCorrectionResult = {
  caseId: string;
  problemId: string;
  status: 'resolved';
  oldRecipeVersionId: string;
  newRecipeVersionId: string;
  recipeVersion: string;
  affectedRollIds: string[];
};

export type CommercialMaterialShortageCorrectionCommand = {
  problemId: string;
  fromRollId: string;
  newRawMaterialId: string;
  newParameters: Array<{ label: string; value: string }>;
  reason: string;
};

export function applyCommercialProblemCorrection(
  orderId: string,
  problemId: string,
  command: CommercialProblemCorrectionCommand,
): Promise<CommercialProblemCorrectionResult> {
  return apiPost<CommercialProblemCorrectionResult>(
    `/api/commercial/orders/${encodeURIComponent(orderId)}/problems/${encodeURIComponent(problemId)}/correction`,
    command,
  );
}

export function applyCommercialMaterialShortageCorrection(
  orderId: string,
  command: CommercialMaterialShortageCorrectionCommand,
): Promise<CommercialProblemCorrectionResult> {
  return apiPost<CommercialProblemCorrectionResult>(
    `/api/commercial/orders/${encodeURIComponent(orderId)}/material-shortage-corrections`,
    command,
  );
}

async function resolveCommercialCounterpartyId(
  form: IntakeDraftForm,
  counterparties: CommercialCounterpartyContract[],
): Promise<string> {
  if (form.counterparty === '__new__') {
    const created = await apiPost<CommercialCounterpartyContract>(
      '/api/commercial/counterparties',
      {
        displayName: form.newCounterpartyName.trim(),
        ...(form.newCounterpartyName.trim() ? { legalName: form.newCounterpartyName.trim() } : {}),
        ...(form.newCounterpartyInn.trim() ? { inn: form.newCounterpartyInn.trim() } : {}),
      },
    );
    return created.id;
  }
  const canonicalId = form.counterpartyId?.trim();
  if (canonicalId) return canonicalId;
  const selected = counterparties.find(
    (counterparty) =>
      counterparty.id === form.counterparty ||
      counterparty.displayName === form.counterparty ||
      counterparty.legalName === form.counterparty,
  );
  if (!selected) {
    throw new Error('Контрагент отсутствует в актуальном справочнике. Обновите форму.');
  }
  return selected.id;
}

export type ServerCommercialNotification = Omit<ServerRoleInboxItem, 'recipientRole'> & {
  recipientRole: 'commercial';
};

export type ServerCommercialNotificationPage = RoleInboxPage;

export function mapCommercialNotification(
  notification: ServerCommercialNotification,
): NotificationItem;
export function mapCommercialNotification(notification: NotificationItem): NotificationItem;
export function mapCommercialNotification(
  notification: ServerCommercialNotification | NotificationItem,
): NotificationItem {
  return 'cta' in notification ? mapRoleInboxItem(notification) : notification;
}

export async function fetchCommercialNotifications(
  cursor?: string,
  limit = 20,
): Promise<ServerCommercialNotificationPage> {
  return fetchRoleInbox('commercial', { cursor, limit });
}

export function markCommercialNotificationRead(
  eventId: string,
): Promise<{ ok: true; eventId: string }> {
  return markRoleInboxRead('commercial', eventId);
}
