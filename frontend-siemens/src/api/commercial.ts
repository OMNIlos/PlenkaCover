import { apiGet, apiPatch, apiPost, type ApiRequestOptions } from './client';
import { counterparties } from '../domain/templates';
import {
  factValue,
  intakeCounterpartyLabel,
  intakePositionSummary,
  intakeRawMaterialSummary,
  intakeTotalRollCount,
  type IntakeDraftForm,
  type IntakeDraftPosition,
} from '../domain/prototypeRuntime';
import { commercialOrderPositionPayloadForDraft } from '../domain/materialRecipeCatalog';
import { rawMaterialIdForLabel } from '../domain/commercialPositionEditing';
import {
  normalizeCommercialWarehouseCoverage as normalizeCommercialWarehouseCoverageView,
  type CommercialWarehouseCoverageEnvelopeView,
} from '../domain/warehouseCoverage';
import type {
  CommercialOrderPosition,
  CommercialOrderRequest,
  CommercialPaymentIndicator,
  CounterpartyOrderTemplate,
  CounterpartyOrderTemplateField,
  CounterpartyOrderTemplateVersion,
  CounterpartyBillingSnapshot,
  Fact,
  RecipeSnapshot,
  RawMaterialStock,
  Severity,
  WarehouseCoverProposal,
  WarehouseCoverStatus,
  WorkObject,
} from '../domain/types';

type ServerCounterparty = {
  id: string;
  displayName: string;
  legalName?: string | null;
  inn?: string | null;
  billingSource?: string | null;
  syncStatus?: string | null;
};

type ServerRecipe = {
  id: string;
  positionId: string;
  recipeOwnerRole: 'commercial';
  parameters: Array<{ label: string; value: string }>;
  source: 'commercial_form' | 'production_lead_form' | 'template';
  createdBy: string;
  version: string;
  createdAt: string;
};

type ServerPosition = {
  id: string;
  rollCount: number;
  filmType: string;
  actualThickness: string;
  accountingThickness: string;
  widthMm?: number | null;
  plannedLengthM?: number | null;
  rawMaterialId?: string | null;
  spoolType?: string | null;
  birka?: string | null;
  manualBirka?: string | null;
  comment?: string | null;
  plannedWeightKg?: number | null;
  warehouseCoverStatus?: string | null;
  recipe?: ServerRecipe | null;
};

type ServerCoverProposal = {
  id: string;
  positionId: string;
  coverType: 'partial' | 'full';
  coverQty: number;
  reserveQty: number;
  productionQty: number;
  matchedRollIds?: string[] | null;
  status: string;
  createdAt: string;
};

type ServerCounterpartyTemplatePosition = {
  id?: string;
  rollCount: number;
  filmType: string;
  actualThickness: string;
  accountingThickness: string;
  widthMm?: number | null;
  plannedLengthM?: number | null;
  rawMaterialId?: string | null;
  baseRawMaterialDefinitionId?: string | null;
  recipeDefinitionVersionId?: string | null;
  spoolType?: string | null;
  birka?: string | null;
  manualBirka?: string | null;
  comment?: string | null;
  plannedWeightKg?: number | null;
  recipeParameters: Array<{ label: string; value: string }>;
};

type ServerCounterpartyTemplateOwnerRole =
  | 'commercial'
  | 'production_lead'
  | 'operator'
  | 'warehouse'
  | 'finance'
  | 'director'
  | 'admin';

type ServerCounterpartyTemplateVersion = {
  id: string;
  templateId: string;
  version: number;
  positions: ServerCounterpartyTemplatePosition[];
  createdById: string | null;
  createdAt: string;
};

type ServerCounterpartyTemplate = {
  id: string;
  counterpartyId: string;
  name: string;
  description: string | null;
  status: 'active' | 'archived';
  ownerRole: ServerCounterpartyTemplateOwnerRole;
  positions: ServerCounterpartyTemplatePosition[];
  usageCount: number;
  lastUsedAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  versions: ServerCounterpartyTemplateVersion[];
};

export type CounterpartyTemplatesPayload = {
  templates: CounterpartyOrderTemplate[];
  versions: CounterpartyOrderTemplateVersion[];
  draftPositions: Record<string, IntakeDraftPosition[]>;
};

export type ServerCommercialOrder = {
  id: string;
  orderNumber: string;
  creatorRole: 'commercial' | 'production_lead';
  counterpartyId: string | null;
  requestType: 'client_order' | 'stock_reserve';
  productionIndicator: string;
  warehouseCoverStatus: string;
  paymentStatus: string;
  shipmentStatus: string;
  commercialStage?: 'draft' | 'incoming' | 'sent_to_finance' | 'in_work';
  draftedAt?: string | null;
  sentToFinanceAt?: string | null;
  financeConfirmedAt?: string | null;
  commercialLockedAt?: string | null;
  canEditParameters?: boolean;
  canSendToFinance?: boolean;
  canPromoteDraft?: boolean;
  canSendToProduction?: boolean;
  productionHandoffState?: 'not_ready' | 'ready' | 'sent';
  productionOrderId?: string | null;
  commercialConfirmationPolicy?: string | null;
  createdAt: string;
  updatedAt: string;
  externalId?: string | null;
  sourceVersion?: string | null;
  counterparty: ServerCounterparty | null;
  stockBatchCode?: string | null;
  positions: ServerPosition[];
  coverProposals: ServerCoverProposal[];
  problems: Array<{ id: string; reason?: string | null; status?: string | null }>;
  financeSummary?: {
    id: string;
    invoiceStatus: string;
    paymentStatus: string;
  } | null;
};

export function commercialProductionHandoffProjection(
  order: Pick<ServerCommercialOrder, 'canSendToProduction' | 'productionHandoffState'>,
) {
  const productionCreated = order.productionHandoffState === 'sent';
  const manualActionEnabled =
    order.productionHandoffState === 'ready' && order.canSendToProduction === true;
  return {
    state: productionCreated
      ? ('sent' as const)
      : manualActionEnabled
        ? ('ready' as const)
        : ('not_ready' as const),
    manualActionEnabled,
    productionCreated,
  };
}

type CreateOrderDto = {
  clientRequestId: string;
  counterpartyId?: string;
  requestType: 'client_order' | 'stock_reserve';
  mode?: 'draft' | 'submit';
  templateId?: string;
  templateVersionId?: string;
  saveAsTemplate?: boolean;
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
  onBehalfOfCommercial?: boolean;
};

type UpdatePositionDto = {
  rollCount?: number;
  filmType?: string;
  actualThickness?: string;
  accountingThickness?: string;
  widthMm?: number;
  plannedLengthM?: number;
  rawMaterialId?: string;
  spoolType?: string;
  birka?: string;
  manualBirka?: string;
  recipeParameters?: Array<{ label: string; value: string }>;
};

type WarehouseCoverRouteDto = {
  positionId: string;
  status: 'partial_proposed' | 'full_proposed' | 'needs_production';
  coverQty?: number;
  reason?: string;
};

const RAW_MATERIAL_LABELS: Record<string, string> = {
  'rm-pvd-15803': 'ПВД 15803-020',
  'rm-pvd-10803': 'ПВД 10803-020',
};

const RAW_MATERIAL_IDS_BY_LABEL = Object.fromEntries(
  Object.entries(RAW_MATERIAL_LABELS).map(([id, label]) => [label, id]),
) as Record<string, string>;

export function fetchCommercialOrders(): Promise<WorkObject[]> {
  return apiGet<ServerCommercialOrder[]>('/api/commercial/orders').then((orders) =>
    orders.map(mapCommercialOrder),
  );
}

export function normalizeCommercialWarehouseCoverage(
  input: unknown,
): CommercialWarehouseCoverageEnvelopeView {
  return normalizeCommercialWarehouseCoverageView(input);
}

export async function createCommercialOrderFromDraft(
  form: IntakeDraftForm,
  _creatorRole: 'commercial' | 'production_lead',
  mode: 'draft' | 'submit',
  clientRequestId: string,
  requestType: 'client_order' | 'stock_reserve' = 'client_order',
): Promise<WorkObject> {
  const counterpartyId =
    requestType === 'client_order' ? await resolveCounterpartyId(form) : undefined;
  const dto: CreateOrderDto = {
    clientRequestId,
    ...(counterpartyId ? { counterpartyId } : {}),
    requestType,
    mode,
    templateId: requestType === 'client_order' ? form.templateId || undefined : undefined,
    ...(requestType === 'client_order' && form.templateId && form.templateVersionId
      ? { templateVersionId: form.templateVersionId }
      : {}),
    ...(requestType === 'client_order' && form.saveAsTemplate ? { saveAsTemplate: true } : {}),
    positions: form.positions.map(commercialOrderPositionPayloadForDraft),
  };
  const order = parseCommercialCreateResult(
    await apiPost<unknown>('/api/commercial/orders', dto),
  );
  return mapCommercialOrder(order);
}

const COMMERCIAL_CREATE_PRODUCTION_INDICATORS = [
  'not_started',
  'needs_production',
  'in_production',
  'ready',
  'needs_approval',
  'defect',
] as const;
const COMMERCIAL_CREATE_COVER_STATUSES = [
  'not_checked',
  'partial_proposed',
  'full_proposed',
  'partial_confirmed',
  'full_confirmed',
  'needs_production',
  'recheck_requested',
  'rejected',
] as const;
const COMMERCIAL_CREATE_PAYMENT_STATUSES = [
  'unpaid',
  'partial',
  'paid',
  'overdue',
  'sync_error',
  'not_applicable',
] as const;
const COMMERCIAL_CREATE_SHIPMENT_STATUSES = [
  'not_shipped',
  'partial_shipped',
  'shipped',
  'shipment_problem',
  'not_applicable',
] as const;
const COMMERCIAL_CREATE_STAGES = ['draft', 'incoming', 'sent_to_finance', 'in_work'] as const;
const COMMERCIAL_CREATE_HANDOFF_STATES = ['not_ready', 'ready', 'sent'] as const;
const COMMERCIAL_CREATE_CONFIRMATION_POLICIES = [
  'required',
  'bypassed_by_delegation',
] as const;

function parseCommercialCreateResult(value: unknown): ServerCommercialOrder {
  if (!isTemplateRecord(value)) return invalidCommercialCreateResult();
  const requiredKeys = [
    'id',
    'orderNumber',
    'creatorRole',
    'counterpartyId',
    'requestType',
    'productionIndicator',
    'warehouseCoverStatus',
    'paymentStatus',
    'shipmentStatus',
    'commercialStage',
    'draftedAt',
    'sentToFinanceAt',
    'financeConfirmedAt',
    'commercialLockedAt',
    'canEditParameters',
    'canSendToFinance',
    'canPromoteDraft',
    'canSendToProduction',
    'productionHandoffState',
    'productionOrderId',
    'commercialConfirmationPolicy',
    'createdAt',
    'updatedAt',
    'externalId',
    'sourceVersion',
    'counterparty',
    'stockBatchCode',
    'positions',
    'coverProposals',
    'problems',
    'financeSummary',
  ] as const;
  if (
    !requiredKeys.every((key) => Object.hasOwn(value, key)) ||
    !isTemplateText(value.id) ||
    !isTemplateText(value.orderNumber) ||
    !isTemplateEnum(value.creatorRole, ['commercial', 'production_lead'] as const) ||
    (value.counterpartyId !== null && !isTemplateText(value.counterpartyId)) ||
    !isTemplateEnum(value.requestType, ['client_order', 'stock_reserve'] as const) ||
    !isTemplateEnum(value.productionIndicator, COMMERCIAL_CREATE_PRODUCTION_INDICATORS) ||
    !isTemplateEnum(value.warehouseCoverStatus, COMMERCIAL_CREATE_COVER_STATUSES) ||
    !isTemplateEnum(value.paymentStatus, COMMERCIAL_CREATE_PAYMENT_STATUSES) ||
    !isTemplateEnum(value.shipmentStatus, COMMERCIAL_CREATE_SHIPMENT_STATUSES) ||
    !isTemplateEnum(value.commercialStage, COMMERCIAL_CREATE_STAGES) ||
    !isNullableCommercialCreateTimestamp(value.draftedAt) ||
    !isNullableCommercialCreateTimestamp(value.sentToFinanceAt) ||
    !isNullableCommercialCreateTimestamp(value.financeConfirmedAt) ||
    !isNullableCommercialCreateTimestamp(value.commercialLockedAt) ||
    typeof value.canEditParameters !== 'boolean' ||
    typeof value.canSendToFinance !== 'boolean' ||
    typeof value.canPromoteDraft !== 'boolean' ||
    typeof value.canSendToProduction !== 'boolean' ||
    !isTemplateEnum(value.productionHandoffState, COMMERCIAL_CREATE_HANDOFF_STATES) ||
    (value.productionOrderId !== null && !isTemplateText(value.productionOrderId)) ||
    !isTemplateEnum(
      value.commercialConfirmationPolicy,
      COMMERCIAL_CREATE_CONFIRMATION_POLICIES,
    ) ||
    !isTemplateTimestamp(value.createdAt) ||
    !isTemplateTimestamp(value.updatedAt) ||
    (value.externalId !== null && !isTemplateText(value.externalId)) ||
    (value.sourceVersion !== null && !isTemplateText(value.sourceVersion)) ||
    (value.stockBatchCode !== null && !isTemplateText(value.stockBatchCode)) ||
    !isCommercialCreateCounterparty(value.counterparty, value.counterpartyId) ||
    !Array.isArray(value.positions) ||
    value.positions.length === 0 ||
    !value.positions.every(isCommercialCreatePosition) ||
    !Array.isArray(value.coverProposals) ||
    !value.coverProposals.every(isCommercialCreateCoverProposal) ||
    !Array.isArray(value.problems) ||
    !value.problems.every(isCommercialCreateProblem) ||
    !isCommercialCreateFinanceSummary(value.financeSummary)
  ) {
    return invalidCommercialCreateResult();
  }
  if (
    (value.requestType === 'client_order' &&
      (value.counterpartyId === null || value.counterparty === null)) ||
    (value.requestType === 'stock_reserve' &&
      (value.counterpartyId !== null ||
        value.counterparty !== null ||
        value.paymentStatus !== 'not_applicable' ||
        value.shipmentStatus !== 'not_applicable'))
  ) {
    return invalidCommercialCreateResult();
  }
  return value as ServerCommercialOrder;
}

function invalidCommercialCreateResult(): never {
  throw new Error('Некорректный ответ создания заявки.');
}

function isNullableCommercialCreateTimestamp(value: unknown): boolean {
  return value === null || isTemplateTimestamp(value);
}

function isCommercialCreateCounterparty(value: unknown, expectedId: unknown): boolean {
  if (value === null) return expectedId === null;
  return (
    isTemplateRecord(value) &&
    ['id', 'displayName', 'legalName', 'inn', 'billingSource', 'syncStatus'].every((key) =>
      Object.hasOwn(value, key),
    ) &&
    value.id === expectedId &&
    isTemplateText(value.id) &&
    isTemplateText(value.displayName) &&
    (value.legalName === null || typeof value.legalName === 'string') &&
    (value.inn === null || typeof value.inn === 'string') &&
    isTemplateText(value.billingSource) &&
    isTemplateText(value.syncStatus)
  );
}

function isCommercialCreatePosition(value: unknown): boolean {
  if (!isTemplateRecord(value)) return false;
  const requiredKeys = [
    'id',
    'rollCount',
    'filmType',
    'actualThickness',
    'accountingThickness',
    'rawMaterialId',
    'spoolType',
    'birka',
    'comment',
    'plannedWeightKg',
    'warehouseCoverStatus',
    'recipe',
  ] as const;
  return (
    requiredKeys.every((key) => Object.hasOwn(value, key)) &&
    isTemplateText(value.id) &&
    Number.isSafeInteger(value.rollCount) &&
    (value.rollCount as number) >= 1 &&
    isTemplateText(value.filmType) &&
    isTemplateText(value.actualThickness) &&
    isTemplateText(value.accountingThickness) &&
    (value.rawMaterialId === null || isTemplateText(value.rawMaterialId)) &&
    (value.spoolType === null || typeof value.spoolType === 'string') &&
    (value.birka === null || typeof value.birka === 'string') &&
    (value.comment === null || typeof value.comment === 'string') &&
    (value.plannedWeightKg === null ||
      (typeof value.plannedWeightKg === 'number' && Number.isFinite(value.plannedWeightKg))) &&
    isTemplateEnum(value.warehouseCoverStatus, COMMERCIAL_CREATE_COVER_STATUSES) &&
    isCommercialCreateRecipe(value.recipe)
  );
}

function isCommercialCreateRecipe(value: unknown): boolean {
  if (value === null) return true;
  return (
    isTemplateRecord(value) &&
    ['id', 'positionId', 'recipeOwnerRole', 'parameters', 'source', 'createdBy', 'version', 'createdAt'].every(
      (key) => Object.hasOwn(value, key),
    ) &&
    isTemplateText(value.id) &&
    isTemplateText(value.positionId) &&
    value.recipeOwnerRole === 'commercial' &&
    Array.isArray(value.parameters) &&
    value.parameters.every(isCounterpartyTemplateParameter) &&
    isTemplateEnum(value.source, ['commercial_form', 'production_lead_form', 'template'] as const) &&
    isTemplateText(value.createdBy) &&
    isTemplateText(value.version) &&
    isTemplateTimestamp(value.createdAt)
  );
}

function isCommercialCreateCoverProposal(value: unknown): boolean {
  return (
    isTemplateRecord(value) &&
    ['id', 'positionId', 'coverType', 'coverQty', 'reserveQty', 'productionQty', 'status', 'createdAt'].every(
      (key) => Object.hasOwn(value, key),
    ) &&
    isTemplateText(value.id) &&
    isTemplateText(value.positionId) &&
    isTemplateEnum(value.coverType, ['partial', 'full'] as const) &&
    [value.coverQty, value.reserveQty, value.productionQty].every(
      (quantity) => Number.isSafeInteger(quantity) && (quantity as number) >= 0,
    ) &&
    isTemplateEnum(value.status, COMMERCIAL_CREATE_COVER_STATUSES) &&
    isTemplateTimestamp(value.createdAt)
  );
}

function isCommercialCreateProblem(value: unknown): boolean {
  return (
    isTemplateRecord(value) &&
    ['id', 'reason', 'status'].every((key) => Object.hasOwn(value, key)) &&
    isTemplateText(value.id) &&
    (value.reason === null || typeof value.reason === 'string') &&
    (value.status === null || isTemplateText(value.status))
  );
}

function isCommercialCreateFinanceSummary(value: unknown): boolean {
  return (
    value === null ||
    (isTemplateRecord(value) &&
      ['id', 'invoiceStatus', 'paymentStatus'].every((key) => Object.hasOwn(value, key)) &&
      isTemplateText(value.id) &&
      isTemplateText(value.invoiceStatus) &&
      isTemplateEnum(value.paymentStatus, COMMERCIAL_CREATE_PAYMENT_STATUSES))
  );
}

export async function fetchCounterpartyTemplates(
  counterpartyIds: string[],
  options?: ApiRequestOptions,
): Promise<CounterpartyTemplatesPayload> {
  const uniqueIds = [...new Set(counterpartyIds.filter(Boolean))];
  const responses: ServerCounterpartyTemplate[][] = [];
  const concurrency = 6;
  for (let offset = 0; offset < uniqueIds.length; offset += concurrency) {
    responses.push(
      ...(await Promise.all(
        uniqueIds
          .slice(offset, offset + concurrency)
          .map((counterpartyId) =>
            apiGet<unknown>(
              `/api/commercial/counterparties/${encodeURIComponent(counterpartyId)}/templates`,
              options,
            ).then((response) => parseCounterpartyTemplatesResponse(response, counterpartyId)),
          ),
      )),
    );
  }
  const templates = responses.flat();
  if (new Set(templates.map((template) => template.id)).size !== templates.length) {
    throw new Error('Некорректный ответ шаблонов контрагента.');
  }
  return serverTemplatesToPayload(templates);
}

export async function createCounterpartyTemplateFromFields(
  counterpartyId: string,
  name: string,
  positions: IntakeDraftPosition[],
): Promise<CounterpartyTemplatesPayload> {
  const template = await apiPost<ServerCounterpartyTemplate>(
    `/api/commercial/counterparties/${encodeURIComponent(counterpartyId)}/templates`,
    {
      name: name.trim() || 'Новый шаблон клиента',
      positions: positions.map(commercialOrderPositionPayloadForDraft),
    },
  );
  return serverTemplatesToPayload([template]);
}

export async function updateCounterpartyTemplateFromFields(
  counterpartyId: string,
  templateId: string,
  name: string,
  positions: IntakeDraftPosition[],
): Promise<CounterpartyTemplatesPayload> {
  const template = await apiPatch<ServerCounterpartyTemplate>(
    `/api/commercial/counterparties/${encodeURIComponent(counterpartyId)}/templates/${encodeURIComponent(templateId)}`,
    {
      name: name.trim() || 'Новый шаблон клиента',
      positions: positions.map(commercialOrderPositionPayloadForDraft),
    },
  );
  return serverTemplatesToPayload([template]);
}

export async function updateCounterpartyTemplateStatus(
  counterpartyId: string,
  templateId: string,
  status: 'active' | 'archived',
): Promise<CounterpartyTemplatesPayload> {
  const template = await apiPatch<ServerCounterpartyTemplate>(
    `/api/commercial/counterparties/${encodeURIComponent(counterpartyId)}/templates/${encodeURIComponent(templateId)}/status`,
    { status },
  );
  return serverTemplatesToPayload([template]);
}

export async function submitCommercialOrderToFinance(orderId: string): Promise<WorkObject> {
  const order = await apiPost<ServerCommercialOrder>(
    `/api/commercial/orders/${encodeURIComponent(orderId)}/submit-to-finance`,
    { amount: 0 },
  );
  return mapCommercialOrder(order);
}

export async function sendCommercialOrderToProduction(orderId: string): Promise<WorkObject[]> {
  await apiPost(`/api/commercial/orders/${encodeURIComponent(orderId)}/send-to-production`, {});
  return fetchCommercialOrders();
}

export async function promoteCommercialDraft(orderId: string): Promise<WorkObject> {
  const order = await apiPost<ServerCommercialOrder>(
    `/api/commercial/orders/${encodeURIComponent(orderId)}/promote-draft`,
    {},
  );
  return mapCommercialOrder(order);
}

export async function updateCommercialOrderPosition(
  orderId: string,
  positionId: string,
  draft: UpdatePositionDto,
): Promise<WorkObject> {
  const order = await apiPatch<ServerCommercialOrder>(
    `/api/commercial/orders/${encodeURIComponent(orderId)}/positions/${encodeURIComponent(positionId)}`,
    draft,
  );
  return mapCommercialOrder(order);
}

export async function saveCommercialOrderPosition(
  orderId: string,
  positionId: string,
  positionUpdate: UpdatePositionDto,
  route?: Omit<WarehouseCoverRouteDto, 'positionId'>,
): Promise<WorkObject> {
  const updatedOrder = await updateCommercialOrderPosition(orderId, positionId, positionUpdate);
  if (!route) return updatedOrder;
  return selectCommercialWarehouseCoverRoute(orderId, { positionId, ...route });
}

export async function selectCommercialWarehouseCoverRoute(
  orderId: string,
  dto: WarehouseCoverRouteDto,
): Promise<WorkObject> {
  const order = await apiPost<ServerCommercialOrder>(
    `/api/commercial/orders/${encodeURIComponent(orderId)}/warehouse-cover/route`,
    dto,
  );
  return mapCommercialOrder(order);
}

export function rawMaterialIdFromLabel(label: string, stocks: RawMaterialStock[] = []) {
  return (
    rawMaterialIdForLabel(label, stocks) ?? RAW_MATERIAL_IDS_BY_LABEL[label.trim()] ?? undefined
  );
}

const COUNTERPARTY_TEMPLATE_STATUSES = ['active', 'archived'] as const;
const COUNTERPARTY_TEMPLATE_OWNER_ROLES = [
  'commercial',
  'production_lead',
  'operator',
  'warehouse',
  'finance',
  'director',
  'admin',
] as const;

function parseCounterpartyTemplatesResponse(
  value: unknown,
  expectedCounterpartyId: string,
): ServerCounterpartyTemplate[] {
  if (!Array.isArray(value)) throw new Error('Некорректный ответ шаблонов контрагента.');
  return value.map((template) => parseCounterpartyTemplate(template, expectedCounterpartyId));
}

function parseCounterpartyTemplate(
  value: unknown,
  expectedCounterpartyId: string,
): ServerCounterpartyTemplate {
  if (!isTemplateRecord(value)) throw new Error('Некорректный ответ шаблонов контрагента.');
  const requiredKeys = [
    'id',
    'counterpartyId',
    'name',
    'description',
    'status',
    'ownerRole',
    'positions',
    'usageCount',
    'lastUsedAt',
    'createdById',
    'createdAt',
    'updatedAt',
    'version',
    'versions',
  ] as const;
  if (
    !requiredKeys.every((key) => Object.hasOwn(value, key)) ||
    !isTemplateText(value.id) ||
    value.counterpartyId !== expectedCounterpartyId ||
    !isTemplateText(value.name) ||
    (value.description !== null && typeof value.description !== 'string') ||
    !isTemplateEnum(value.status, COUNTERPARTY_TEMPLATE_STATUSES) ||
    !isTemplateEnum(value.ownerRole, COUNTERPARTY_TEMPLATE_OWNER_ROLES) ||
    !Array.isArray(value.positions) ||
    value.positions.length === 0 ||
    value.positions.length > 100 ||
    !value.positions.every(isCounterpartyTemplatePosition) ||
    !Number.isSafeInteger(value.usageCount) ||
    (value.usageCount as number) < 0 ||
    (value.lastUsedAt !== null && !isTemplateTimestamp(value.lastUsedAt)) ||
    (value.createdById !== null && !isTemplateText(value.createdById)) ||
    !isTemplateTimestamp(value.createdAt) ||
    !isTemplateTimestamp(value.updatedAt) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 1 ||
    !Array.isArray(value.versions) ||
    !value.versions.every((version) => isCounterpartyTemplateVersion(version, value.id as string))
  ) {
    throw new Error('Некорректный ответ шаблонов контрагента.');
  }
  return value as ServerCounterpartyTemplate;
}

function isCounterpartyTemplateVersion(value: unknown, templateId: string): boolean {
  return (
    isTemplateRecord(value) &&
    ['id', 'templateId', 'version', 'positions', 'createdById', 'createdAt'].every((key) =>
      Object.hasOwn(value, key),
    ) &&
    isTemplateText(value.id) &&
    value.templateId === templateId &&
    Number.isSafeInteger(value.version) &&
    (value.version as number) >= 1 &&
    Array.isArray(value.positions) &&
    value.positions.length > 0 &&
    value.positions.length <= 100 &&
    value.positions.every(isCounterpartyTemplatePosition) &&
    (value.createdById === null || isTemplateText(value.createdById)) &&
    isTemplateTimestamp(value.createdAt)
  );
}

function isCounterpartyTemplatePosition(value: unknown): boolean {
  if (
    !isTemplateRecord(value) ||
    !['rollCount', 'filmType', 'actualThickness', 'accountingThickness', 'recipeParameters'].every(
      (key) => Object.hasOwn(value, key),
    ) ||
    !Number.isSafeInteger(value.rollCount) ||
    (value.rollCount as number) < 1 ||
    (value.rollCount as number) > 10_000 ||
    !isTemplateText(value.filmType) ||
    !isTemplateText(value.actualThickness) ||
    !isTemplateText(value.accountingThickness) ||
    !Array.isArray(value.recipeParameters) ||
    value.recipeParameters.length > 50 ||
    !value.recipeParameters.every(isCounterpartyTemplateParameter)
  ) {
    return false;
  }
  return (
    isOptionalTemplateText(value, 'id', false) &&
    isOptionalTemplateText(value, 'rawMaterialId', true) &&
    isOptionalTemplateText(value, 'baseRawMaterialDefinitionId', true) &&
    isOptionalTemplateText(value, 'recipeDefinitionVersionId', true) &&
    isOptionalTemplateText(value, 'spoolType', true) &&
    isOptionalTemplateText(value, 'birka', true) &&
    isOptionalTemplateText(value, 'manualBirka', true) &&
    isOptionalTemplateText(value, 'comment', true) &&
    isOptionalPositiveTemplateNumber(value, 'widthMm') &&
    isOptionalPositiveTemplateNumber(value, 'plannedLengthM') &&
    isOptionalPositiveTemplateNumber(value, 'plannedWeightKg')
  );
}

function isCounterpartyTemplateParameter(value: unknown): boolean {
  return (
    isTemplateRecord(value) &&
    Object.hasOwn(value, 'label') &&
    Object.hasOwn(value, 'value') &&
    isTemplateText(value.label) &&
    typeof value.value === 'string'
  );
}

function isTemplateRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTemplateText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTemplateTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isTemplateEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): value is T[number] {
  return typeof value === 'string' && allowed.includes(value);
}

function isOptionalTemplateText(
  value: Record<string, unknown>,
  key: string,
  allowEmptyOrNull: boolean,
): boolean {
  if (!Object.hasOwn(value, key)) return true;
  if (allowEmptyOrNull && value[key] === null) return true;
  return allowEmptyOrNull ? typeof value[key] === 'string' : isTemplateText(value[key]);
}

function isOptionalPositiveTemplateNumber(value: Record<string, unknown>, key: string): boolean {
  if (!Object.hasOwn(value, key) || value[key] === null) return true;
  return typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] > 0;
}

function serverTemplatesToPayload(
  serverTemplates: ServerCounterpartyTemplate[],
): CounterpartyTemplatesPayload {
  return {
    templates: serverTemplates.map(serverTemplateToCatalog),
    versions: serverTemplates.flatMap((template) => {
      const version = activeServerTemplateVersion(template);
      return version ? [serverTemplateToVersion(template, version)] : [];
    }),
    draftPositions: Object.fromEntries(
      serverTemplates.map((template) => [template.id, serverTemplateToDraftPositions(template)]),
    ),
  };
}

function serverTemplateToDraftPositions(
  template: ServerCounterpartyTemplate,
): IntakeDraftPosition[] {
  return template.positions.map((position, index) => {
    const plannedWeightText =
      parameterValue(position.recipeParameters, 'План. вес, кг') ||
      parameterValue(position.recipeParameters, 'Рулоны') ||
      '';
    const plannedWeightMatch =
      plannedWeightText.match(/по\s*(\d+(?:[.,]\d+)?)\s*кг/iu) ??
      plannedWeightText.match(/^\s*(\d+(?:[.,]\d+)?)\s*кг/iu);
    const plannedWeight =
      position.plannedWeightKg ??
      Number(
        plannedWeightMatch?.[1]?.replace(',', '.') ||
          parameterValue(position.recipeParameters, 'План. вес, кг'),
      );
    const rawMaterial =
      parameterValue(position.recipeParameters, 'Сырьё') ||
      parameterValue(position.recipeParameters, 'Сырье') ||
      (position.rawMaterialId ? RAW_MATERIAL_LABELS[position.rawMaterialId] : undefined) ||
      position.rawMaterialId ||
      '';
    const thicknessMatch = position.actualThickness.match(/(\d+)/);
    return {
      id: position.id ?? `${template.id}-position-${index + 1}`,
      rollCount: String(position.rollCount),
      micronPreset: thicknessMatch?.[1] ?? '',
      micronCustom: '',
      actualThickness: position.actualThickness,
      accountingThickness: position.accountingThickness,
      filmType: position.filmType,
      widthMm: position.widthMm == null ? '' : String(position.widthMm),
      plannedLengthM: position.plannedLengthM == null ? '' : String(position.plannedLengthM),
      plannedWeightKg:
        Number.isFinite(plannedWeight) && plannedWeight > 0 ? String(plannedWeight) : '',
      birka: position.birka ?? '',
      manualBirka: position.manualBirka ?? '',
      comment: position.comment ?? parameterValue(position.recipeParameters, 'Комментарий') ?? '',
      rawMaterial,
      rawMaterialId: position.rawMaterialId ?? '',
      baseRawMaterialDefinitionId: position.baseRawMaterialDefinitionId ?? '',
      recipeDefinitionVersionId: position.recipeDefinitionVersionId ?? '',
      spoolType: position.spoolType ?? '',
    };
  });
}

function serverTemplateToCatalog(template: ServerCounterpartyTemplate): CounterpartyOrderTemplate {
  return {
    id: template.id,
    counterpartyId: template.counterpartyId,
    name: template.name,
    activeVersionId: activeServerTemplateVersion(template)?.id ?? '',
    status: template.status,
    ownerRole: ownerRoleLabel(template.ownerRole),
    usageCount: template.usageCount,
    lastUsedAt: template.lastUsedAt ? dateLabel(template.lastUsedAt) : 'еще не применялся',
    updatedAt: dateLabel(template.updatedAt),
  };
}

function serverTemplateToVersion(
  template: ServerCounterpartyTemplate,
  activeVersion: ServerCounterpartyTemplateVersion,
): CounterpartyOrderTemplateVersion {
  return {
    id: activeVersion.id,
    templateId: template.id,
    version: 'актуальная версия',
    fields: serverTemplateFields(activeVersion.positions),
    reason: 'Актуальная версия шаблона',
    createdBy: activeVersion.createdById ?? template.createdById ?? 'Не указан',
    createdAt: dateLabel(activeVersion.createdAt),
    affectsProduction: true,
    affectsMoney: false,
  };
}

function serverTemplateFields(
  positions: ServerCounterpartyTemplatePosition[],
): CounterpartyOrderTemplateField[] {
  if (positions.length > 1) {
    return [templateField('Количество позиций', String(positions.length), 'production')];
  }
  const position = positions[0];
  if (!position) return [];
  const rawMaterial =
    parameterValue(position.recipeParameters, 'Сырьё') ||
    parameterValue(position.recipeParameters, 'Сырье') ||
    (position.rawMaterialId ? RAW_MATERIAL_LABELS[position.rawMaterialId] : undefined) ||
    position.rawMaterialId ||
    '';
  const color = parameterValue(position.recipeParameters, 'Цвет') || position.birka || '';
  const plannedWeight = parameterValue(position.recipeParameters, 'План. вес, кг');
  const positionsLabel =
    parameterValue(position.recipeParameters, 'Позиции') ||
    `${position.rollCount} шт., ${position.filmType} ${position.actualThickness}`;
  const rolls =
    parameterValue(position.recipeParameters, 'Рулоны') ||
    (plannedWeight
      ? `${position.rollCount} шт. по ${plannedWeight} кг`
      : `${position.rollCount} шт.`);
  const knownLabels = new Set([
    'Позиции',
    'Тип пленки',
    'Тип плёнки',
    'Толщина',
    'Толщина факт',
    'Толщина учётная',
    'Ширина, мм',
    'Ширина',
    'Метраж, м',
    'Метраж',
    'План. вес, кг',
    'Рулоны',
    'Цвет',
    'Сырье',
    'Сырьё',
    'Шпуля',
    'Втулка',
    'Комментарий',
  ]);
  const extraFields = (position.recipeParameters ?? [])
    .filter((item) => !knownLabels.has(item.label))
    .map((item) => templateField(item.label, item.value, 'production'));

  return [
    templateField('Позиции', positionsLabel, 'production'),
    templateField('Тип пленки', position.filmType, 'production'),
    templateField('Толщина', position.actualThickness, 'production'),
    templateField(
      'Ширина, мм',
      position.widthMm == null ? '' : String(position.widthMm),
      'production',
    ),
    templateField(
      'Метраж, м',
      position.plannedLengthM == null ? '' : String(position.plannedLengthM),
      'production',
    ),
    templateField('Рулоны', rolls, 'production'),
    templateField('Сырье', rawMaterial || 'Не указано', 'production'),
    templateField('Шпуля', position.spoolType || 'Не указана', 'production'),
    ...(color ? [templateField('Цвет', color, 'production')] : []),
    ...extraFields,
  ];
}

function templateField(
  label: string,
  value: string,
  kind: CounterpartyOrderTemplateField['kind'],
): CounterpartyOrderTemplateField {
  return { label, value, kind, required: true };
}

function activeServerTemplateVersion(template: ServerCounterpartyTemplate) {
  return template.versions.find((version) => version.version === template.version);
}

function parameterValue(
  parameters: Array<{ label: string; value: string }> | null | undefined,
  label: string,
) {
  return parameters?.find((item) => item.label.toLowerCase() === label.toLowerCase())?.value;
}

function ownerRoleLabel(ownerRole: ServerCounterpartyTemplateOwnerRole) {
  const labels: Record<ServerCounterpartyTemplateOwnerRole, string> = {
    commercial: 'Коммерция',
    production_lead: 'Зав. производства',
    operator: 'Оператор',
    warehouse: 'Склад',
    finance: 'Бухгалтерия',
    director: 'Директор',
    admin: 'Админ',
  };
  return labels[ownerRole];
}

function dateLabel(value: string) {
  return value.includes('T') ? value.slice(0, 10) : value;
}

export async function requestCoverRecheck(orderId: string): Promise<WorkObject[]> {
  await apiPost(
    `/api/commercial/orders/${encodeURIComponent(orderId)}/warehouse-cover/recheck`,
    {},
  );
  return fetchCommercialOrders();
}

export async function confirmCover(orderId: string, proposalId: string): Promise<WorkObject[]> {
  await apiPost(
    `/api/commercial/orders/${encodeURIComponent(orderId)}/warehouse-cover/${encodeURIComponent(proposalId)}/confirm`,
    {},
  );
  return fetchCommercialOrders();
}

export async function rejectCover(
  orderId: string,
  proposalId: string,
  reason: string,
): Promise<WorkObject[]> {
  await apiPost(
    `/api/commercial/orders/${encodeURIComponent(orderId)}/warehouse-cover/${encodeURIComponent(proposalId)}/reject`,
    { reason },
  );
  return fetchCommercialOrders();
}

export async function forceProduction(orderId: string, reason?: string): Promise<WorkObject[]> {
  await apiPost(`/api/commercial/orders/${encodeURIComponent(orderId)}/force-production`, {
    ...(reason ? { reason } : {}),
  });
  return fetchCommercialOrders();
}

async function resolveCounterpartyId(form: IntakeDraftForm) {
  const label = intakeCounterpartyLabel(form);
  if (form.counterparty === '__new__') {
    throw new Error(
      'Создание нового контрагента в этой форме недоступно. Выберите запись из справочника.',
    );
  }
  if (form.counterparty !== '__new__') {
    const explicitCounterpartyId = form.counterpartyId?.trim();
    if (explicitCounterpartyId) return explicitCounterpartyId;
    const known = counterparties.find(
      (item) => item.legalName === label || item.id === form.counterparty,
    );
    if (known) return known.id;
  }
  throw new Error('Контрагент отсутствует в актуальном справочнике. Обновите форму.');
}

export function mapCommercialOrder(order: ServerCommercialOrder): WorkObject {
  const positions = order.positions.map((position, index) =>
    serverPositionToCommercialPosition(position, order, index),
  );
  const proposals = order.coverProposals.map((proposal) =>
    serverProposalToWarehouseProposal(proposal, positions),
  );
  const totalRolls = positions.reduce((sum, position) => sum + position.rollCount, 0);
  const missingRolls =
    proposals.length > 0
      ? proposals.reduce((sum, proposal) => sum + proposal.missingQty, 0)
      : order.warehouseCoverStatus === 'needs_production'
        ? totalRolls
        : 0;
  const counterparty =
    order.requestType === 'stock_reserve'
      ? order.stockBatchCode || 'На запас'
      : order.counterparty?.displayName ||
        order.counterparty?.legalName ||
        order.counterpartyId ||
        'Контрагент не указан';
  const paymentIndicator = paymentIndicatorForOrder(order);
  const stage = commercialStageForOrder(order);
  const stageLabel = statusLabelForOrder(order, missingRolls);
  const canEditParameters =
    (order.canEditParameters ?? true) && (stage === 'draft' || stage === 'incoming');
  const canSendToFinance = order.canSendToFinance ?? stage === 'incoming';
  const canPromoteDraft = order.canPromoteDraft ?? (stage === 'draft' && !order.financeSummary);
  const productionHandoff = commercialProductionHandoffProjection(order);
  const canSendToProduction = productionHandoff.manualActionEnabled;
  const productionSent = productionHandoff.productionCreated;
  const commercialOrder: CommercialOrderRequest = {
    id: order.id,
    createdBy: order.creatorRole === 'production_lead' ? 'Зав. производства' : 'Коммерция',
    creatorRole: order.creatorRole,
    ...(order.counterpartyId ? { counterpartyId: order.counterpartyId } : {}),
    ...(order.requestType === 'client_order' && order.counterparty
      ? { billingSnapshot: billingSnapshotForOrder(order) }
      : {}),
    requestType: order.requestType === 'stock_reserve' ? 'на склад/резерв' : 'клиентский заказ',
    status: stage === 'draft' ? 'draft' : 'in_work',
    productionStatus: mapProductionStatus(order.productionIndicator),
    warehouseCoverStatus: mapWarehouseCoverStatus(order.warehouseCoverStatus),
    paymentStatus: paymentIndicator.paymentStatus,
    shipmentStatus: mapShipmentStatus(order.shipmentStatus),
    createdAt: order.createdAt,
    submittedAt: order.sentToFinanceAt ?? (stage === 'draft' ? undefined : order.createdAt),
    commercialConfirmationPolicy:
      order.commercialConfirmationPolicy === 'bypassed_by_delegation'
        ? 'bypassed_by_delegation'
        : 'required',
    requiresCommercialRecipeConfirmation: order.commercialConfirmationPolicy === 'required',
    positions,
  };
  return {
    id: order.id,
    kind: 'intake',
    title: `${order.orderNumber} · ${counterparty}`,
    statusLabel: stageLabel,
    nextOwner: canSendToFinance
      ? 'Коммерция'
      : stage === 'sent_to_finance'
        ? 'Бухгалтерия'
        : canSendToProduction
          ? 'Коммерция'
          : productionSent
            ? 'Зав. производства'
            : missingRolls > 0
              ? 'Зав. производства'
              : 'Коммерция',
    severity: severityForOrder(order),
    filterTags: filterTagsForOrder(order, stageLabel),
    facts: [
      { label: 'Номер', value: order.orderNumber, scope: 'commercial' },
      { label: 'Контрагент', value: counterparty, scope: 'commercial' },
      {
        label: 'Позиции',
        value: `${positions.length} поз., ${totalRolls} рул. всего`,
        scope: 'commercial',
      },
      { label: 'Всего рулонов', value: String(totalRolls), scope: 'commercial' },
      {
        label: 'Характеристики',
        value: positions
          .map((position) => `${position.filmType} ${position.actualThickness}`)
          .join('; '),
        scope: 'commercial',
      },
      {
        label: 'Сырье',
        value: positions.map((position) => position.rawMaterialLabel).join('; '),
        scope: 'commercial',
      },
      {
        label: 'Производство',
        value:
          missingRolls > 0
            ? canSendToProduction
              ? `${missingRolls} рул. готовы к передаче`
              : productionSent
                ? `${missingRolls} рул. переданы в производство`
                : `${missingRolls} рул. требуют производства`
            : 'Не требуется после склада',
        scope: 'commercial',
      },
      {
        label: 'Склад',
        value: warehouseStatusLabel(commercialOrder.warehouseCoverStatus),
        scope: 'commercial',
      },
      { label: 'Оплата', value: paymentIndicator.label, scope: 'commercial' },
      {
        label: 'Счет',
        value: invoiceStatusLabel(order.financeSummary?.invoiceStatus, stage),
        scope: 'commercial',
      },
      { label: 'Отгрузка', value: commercialOrder.shipmentStatus, scope: 'commercial' },
    ],
    sections: sectionsForOrder(order, positions, proposals, paymentIndicator),
    actions: [
      ...(canPromoteDraft
        ? [
            {
              id: 'commercial-promote-draft',
              label: 'Оформить заявку',
              level: 'recommended' as const,
              enabled: true,
            },
          ]
        : []),
      ...(canSendToFinance
        ? [
            {
              id: 'commercial-transfer-selected',
              label: 'Направить в бухгалтерию',
              level: 'recommended' as const,
              enabled: true,
            },
          ]
        : []),
      ...(canSendToProduction
        ? [
            {
              id: `commercial-send-to-production:${order.id}`,
              label: 'Отправить зав. производства',
              level: 'recommended' as const,
              enabled: true,
            },
          ]
        : productionSent
          ? [
              {
                id: `commercial-production-sent:${order.id}`,
                label: 'Передано зав. производства',
                level: 'disabled' as const,
                enabled: false,
                disabledReason: 'Заказ-наряд уже создан',
              },
            ]
          : []),
      {
        id: 'commercial-edit-params',
        label: canEditParameters ? 'Изменить параметры' : 'Параметры закрыты',
        level: canEditParameters ? ('peer' as const) : ('disabled' as const),
        enabled: canEditParameters,
        disabledReason: canEditParameters
          ? undefined
          : 'Параметры закрыты после передачи в бухгалтерию',
        recoveryOwner: canEditParameters ? undefined : 'Бухгалтерия',
        recoveryAction: canEditParameters ? undefined : 'Смотреть статус оплаты',
      },
      {
        id: 'commercial-open-production',
        label: 'Открыть производство',
        level: missingRolls > 0 ? 'recommended' : 'secondary',
        enabled: true,
      },
      {
        id: 'commercial-open-payment-shipment',
        label: 'Оплата и отгрузка',
        level: 'secondary',
        enabled: true,
      },
    ],
    problems: order.problems.map((problem) => ({
      id: problem.id,
      objectId: order.id,
      stage: 'Коммерция',
      title: problem.reason || 'Проблема по заказу',
      severity: 'warning',
      ownerRole: 'Коммерция',
      due: 'по факту',
      reason: problem.reason || 'Причина не указана',
      recovery: 'Открыть карточку и уточнить с владельцем контура',
      status: problem.status === 'resolved' ? 'resolved' : 'open',
    })),
    audit: [],
    commercialOrder,
    warehouseCoverProposals: proposals,
  };
}

function serverPositionToCommercialPosition(
  position: ServerPosition,
  order: ServerCommercialOrder,
  index: number,
): CommercialOrderPosition {
  const rawMaterialLabel =
    recipeValue(position.recipe, 'Сырьё') ||
    (position.rawMaterialId ? RAW_MATERIAL_LABELS[position.rawMaterialId] : undefined) ||
    'Не указано';
  const plannedWeightKg = numberFromRecipe(position.recipe, 'План. вес, кг');
  const recipeSnapshot: RecipeSnapshot = {
    id: position.recipe?.id ?? `${position.id}-RECIPE-v1`,
    positionId: position.id,
    recipeOwnerRole: 'commercial',
    parameters: position.recipe?.parameters ?? [],
    source:
      position.recipe?.source ??
      (order.creatorRole === 'production_lead' ? 'production_lead_form' : 'commercial_form'),
    createdBy: position.recipe?.createdBy ?? order.creatorRole,
    createdAt: position.recipe?.createdAt ?? order.createdAt,
    version: position.recipe?.version ?? 'v1',
  };
  return {
    id: position.id,
    draftId: order.id,
    rollCount: position.rollCount,
    filmType: position.filmType,
    actualThickness: position.actualThickness,
    accountingThickness: position.accountingThickness,
    widthMm: position.widthMm ?? undefined,
    plannedLengthM: position.plannedLengthM ?? undefined,
    plannedWeightKg,
    rawMaterialId: position.rawMaterialId ?? undefined,
    rawMaterialLabel,
    rawMaterials:
      position.rawMaterialId && plannedWeightKg != null
        ? [
            {
              rawMaterialId: position.rawMaterialId,
              label: rawMaterialLabel,
              nominalQty: position.rollCount * plannedWeightKg,
              unit: 'кг',
              accountingSource: 'order_entry',
            },
          ]
        : undefined,
    spoolType: position.spoolType || recipeValue(position.recipe, 'Шпуля') || 'Не указана',
    birka: position.birka || 'Не указана',
    manualBirka: position.manualBirka ?? undefined,
    comment: position.comment || recipeValue(position.recipe, 'Комментарий') || undefined,
    recipeSnapshot,
    warehouseCoverStatus: mapWarehouseCoverStatus(
      position.warehouseCoverStatus ?? order.warehouseCoverStatus,
    ),
  };
}

function serverProposalToWarehouseProposal(
  proposal: ServerCoverProposal,
  positions: CommercialOrderPosition[],
): WarehouseCoverProposal {
  const position = positions.find((item) => item.id === proposal.positionId);
  const coverQty = proposal.coverQty ?? 0;
  const productionQty =
    proposal.productionQty ?? Math.max(0, (position?.rollCount ?? 0) - coverQty);
  return {
    id: proposal.id,
    positionId: proposal.positionId,
    matchedRolls: (proposal.matchedRollIds ?? []).map((id) => ({
      id,
      ownership: 'reserved_for_order',
      qty: 1,
      label: position ? `${position.filmType}, ${position.actualThickness}` : id,
    })),
    coverType: proposal.coverType,
    coverQty,
    missingQty: productionQty,
    reserveQty: proposal.reserveQty,
    productionQty,
    warehouseCoverStatus: mapWarehouseCoverStatus(proposal.status),
    requiresConfirmation: true,
    decision: proposal.status.endsWith('_confirmed')
      ? 'confirmed'
      : proposal.status === 'rejected'
        ? 'rejected'
        : 'pending',
    confirmedAt: proposal.status.endsWith('_confirmed') ? proposal.createdAt : undefined,
  };
}

function sectionsForOrder(
  order: ServerCommercialOrder,
  positions: CommercialOrderPosition[],
  proposals: WarehouseCoverProposal[],
  paymentIndicator: CommercialPaymentIndicator,
) {
  const totalRolls = positions.reduce((sum, position) => sum + position.rollCount, 0);
  return [
    {
      id: `${order.id}-indicators`,
      title: 'Индикаторы заявки',
      facts: [
        {
          label: 'Производство',
          value: mapProductionStatus(order.productionIndicator),
          scope: 'commercial' as const,
        },
        {
          label: 'Склад',
          value: warehouseStatusLabel(mapWarehouseCoverStatus(order.warehouseCoverStatus)),
          scope: 'commercial' as const,
        },
        { label: 'Оплата', value: paymentIndicator.label, scope: 'commercial' as const },
        {
          label: 'Счет',
          value: invoiceStatusLabel(
            order.financeSummary?.invoiceStatus,
            commercialStageForOrder(order),
          ),
          scope: 'commercial' as const,
        },
        {
          label: 'Отгрузка',
          value: mapShipmentStatus(order.shipmentStatus),
          scope: 'commercial' as const,
        },
      ],
    },
    {
      id: `${order.id}-client`,
      title: 'Заявка клиента',
      facts: [
        {
          label: order.requestType === 'stock_reserve' ? 'Режим' : 'Контрагент',
          value:
            order.requestType === 'stock_reserve'
              ? order.stockBatchCode || 'На запас'
              : order.counterparty?.displayName || 'Контрагент не указан',
          scope: 'commercial' as const,
        },
        {
          label: 'Позиции',
          value: `${positions.length} поз., ${totalRolls} рул. всего`,
          scope: 'commercial' as const,
        },
      ],
    },
    ...positions.map((position, index) => ({
      id: `${position.id}-full-card`,
      title: `Позиция ${index + 1}`,
      facts: [
        { label: 'Бирка', value: position.birka, scope: 'commercial' as const },
        {
          label: 'Фактическая толщина',
          value: position.actualThickness,
          scope: 'commercial' as const,
        },
        {
          label: 'Бухгалтерская толщина',
          value: position.accountingThickness,
          scope: 'commercial' as const,
        },
        { label: 'Шпуля', value: position.spoolType, scope: 'commercial' as const },
        { label: 'Сырье', value: position.rawMaterialLabel, scope: 'commercial' as const },
        {
          label: 'Рецептура',
          value:
            position.recipeSnapshot.parameters
              .map((item) => `${item.label}: ${item.value}`)
              .join('; ') || 'Не указана',
          scope: 'commercial' as const,
        },
      ],
    })),
    {
      id: `${order.id}-warehouse-cover`,
      title: 'Складское покрытие',
      facts:
        proposals.length > 0
          ? proposals.flatMap((proposal, index) => [
              {
                label: `Позиция ${index + 1}`,
                value: warehouseStatusLabel(proposal.warehouseCoverStatus),
                scope: 'commercial' as const,
              },
              {
                label: `Недостающая часть ${index + 1}`,
                value:
                  proposal.missingQty > 0 ? `${proposal.missingQty} рул. в производство` : 'Нет',
                scope: 'commercial' as const,
              },
            ])
          : [
              {
                label: 'Статус',
                value: warehouseStatusLabel(mapWarehouseCoverStatus(order.warehouseCoverStatus)),
                scope: 'commercial' as const,
              },
            ],
    },
  ];
}

function billingSnapshotForOrder(order: ServerCommercialOrder): CounterpartyBillingSnapshot {
  if (!order.counterparty || !order.counterpartyId) {
    throw new Error('Для клиентского заказа отсутствует карточка контрагента.');
  }
  return {
    id: `billing-${order.id}`,
    counterpartyId: order.counterpartyId,
    label: order.counterparty.displayName,
    type: 'legal_entity',
    inn: order.counterparty.inn ?? undefined,
    source:
      order.counterparty.billingSource === 'manual_platform'
        ? 'manual_order_entry'
        : 'counterparty_card_snapshot',
    syncStatus:
      order.counterparty.billingSource === 'manual_platform'
        ? 'manual_not_synced'
        : 'needs_1C_discovery',
    createdBy: order.creatorRole === 'production_lead' ? 'Зав. производства' : 'Коммерция',
    createdAt: order.createdAt,
  };
}

function paymentIndicatorForOrder(order: ServerCommercialOrder): CommercialPaymentIndicator {
  const paymentStatus = mapPaymentStatus(
    order.financeSummary?.paymentStatus ?? order.paymentStatus,
  );
  return {
    orderId: order.id,
    paymentStatus,
    label: paymentStatus,
    severity:
      paymentStatus === 'просрочка'
        ? 'critical'
        : paymentStatus === 'не оплачен'
          ? 'warning'
          : 'info',
    lastUpdatedAt: order.updatedAt,
    source: order.externalId ? '1C' : 'mock_1C',
    syncedAt: order.sourceVersion ?? undefined,
  };
}

function invoiceStatusLabel(
  invoiceStatus: string | null | undefined,
  stage: 'draft' | 'incoming' | 'sent_to_finance' | 'in_work',
) {
  if (invoiceStatus === 'invoiced' || invoiceStatus === 'issued' || invoiceStatus === 'sent') {
    return 'Счет выставлен';
  }
  if (invoiceStatus === 'source_error') return 'Источник не подтвердил';
  if (stage === 'sent_to_finance') return 'В бухгалтерии';
  if (stage === 'in_work') return 'Счет обработан';
  return 'Не передано';
}

function commercialStageForOrder(order: ServerCommercialOrder) {
  if (order.commercialStage) return order.commercialStage;
  if (
    order.financeConfirmedAt ||
    order.paymentStatus === 'partial' ||
    order.paymentStatus === 'paid'
  ) {
    return 'in_work';
  }
  if (order.sentToFinanceAt) return 'sent_to_finance';
  if (order.draftedAt || order.orderNumber.startsWith('D-')) return 'draft';
  return 'incoming';
}

function recipeValue(recipe: ServerRecipe | null | undefined, label: string) {
  return recipe?.parameters.find((item) => item.label.toLowerCase() === label.toLowerCase())?.value;
}

function numberFromRecipe(recipe: ServerRecipe | null | undefined, label: string) {
  const value = recipeValue(recipe, label);
  if (!value) return undefined;
  const parsed = Number(value.replace(',', '.').replace(/[^0-9.]+/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mapProductionStatus(status: string): CommercialOrderRequest['productionStatus'] {
  if (status === 'in_production') return 'in_production';
  if (status === 'ready') return 'ready';
  if (status === 'needs_production' || status === 'needs_approval' || status === 'defect')
    return 'needs_production';
  return 'not_started';
}

function mapWarehouseCoverStatus(status: string): WarehouseCoverStatus {
  if (
    status === 'partial_proposed' ||
    status === 'partial_confirmed' ||
    status === 'full_proposed' ||
    status === 'full_confirmed' ||
    status === 'needs_production' ||
    status === 'not_checked'
  ) {
    return status;
  }
  if (status === 'recheck_requested' || status === 'rejected') return status;
  // full-only: неизвестный/непроверенный статус не угадываем как partial/full — оставляем «не проверено».
  return 'not_checked';
}

function mapPaymentStatus(status: string): CommercialPaymentIndicator['paymentStatus'] {
  if (status === 'paid') return 'оплачен';
  if (status === 'partial') return 'частично оплачен';
  if (status === 'overdue' || status === 'sync_error') return 'просрочка';
  return 'не оплачен';
}

function mapShipmentStatus(status: string): CommercialOrderRequest['shipmentStatus'] {
  if (status === 'partial_shipped') return 'частично отгружено';
  if (status === 'shipped') return 'отгружено';
  if (status === 'shipment_problem') return 'проблема отгрузки';
  return 'не отгружено';
}

function warehouseStatusLabel(status: WarehouseCoverStatus) {
  if (status === 'full_proposed' || status === 'full_confirmed') return 'Склад закрывает';
  if (status === 'partial_proposed' || status === 'partial_confirmed') return 'Часть со склада';
  if (status === 'needs_production') return 'В производство';
  if (status === 'recheck_requested') return 'Перепроверка склада';
  if (status === 'rejected') return 'Отклонено';
  return 'Не проверено';
}

function statusLabelForOrder(order: ServerCommercialOrder, missingRolls: number) {
  const stage = commercialStageForOrder(order);
  if (stage === 'draft') return 'Черновик';
  if (stage === 'sent_to_finance') return 'В бухгалтерии';
  if (stage === 'in_work') return 'В работе';
  if (order.productionIndicator === 'in_production') return 'В производстве';
  if (order.productionIndicator === 'ready') return 'Готово';
  if (order.warehouseCoverStatus === 'needs_production' || missingRolls > 0) return 'Передано';
  if (order.warehouseCoverStatus === 'not_checked') return 'Проверка склада';
  return 'В работе';
}

function filterTagsForOrder(order: ServerCommercialOrder, statusLabel: string) {
  const stage = commercialStageForOrder(order);
  const bucket =
    stage === 'draft' ? 'Черновики' : stage === 'in_work' ? 'В работе' : 'Входящие заявки';
  const extra =
    stage === 'draft'
      ? ['Черновик']
      : stage === 'sent_to_finance'
        ? ['Направлено в бухгалтерию']
        : [];
  return Array.from(new Set([bucket, statusLabel, ...extra]));
}

function severityForOrder(order: ServerCommercialOrder): Severity {
  if (
    order.problems.length > 0 ||
    order.paymentStatus === 'overdue' ||
    order.paymentStatus === 'sync_error'
  )
    return 'critical';
  if (
    order.warehouseCoverStatus === 'not_checked' ||
    order.warehouseCoverStatus === 'needs_production'
  )
    return 'warning';
  return 'info';
}

export function liveCreateFallbackDraftSummary(form: IntakeDraftForm): Fact[] {
  return [
    {
      label: 'Контрагент',
      value: intakeCounterpartyLabel(form) || 'Не выбран',
      scope: 'commercial',
    },
    { label: 'Позиции', value: intakePositionSummary(form), scope: 'commercial' },
    { label: 'Всего рулонов', value: String(intakeTotalRollCount(form)), scope: 'commercial' },
    { label: 'Сырье', value: intakeRawMaterialSummary(form), scope: 'commercial' },
  ];
}

export function liveOrderCounterpartyLabel(object: WorkObject) {
  return (
    factValue(object, 'Контрагент') ?? object.commercialOrder?.billingSnapshot?.label ?? object.id
  );
}
