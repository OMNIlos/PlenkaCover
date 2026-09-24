import type { CommercialTemplatePositionContract } from '../features/commercial/contracts';
import { ApiError, apiGet, apiPatch, apiPost, type ApiRequestOptions } from './client';

export type StockProductionTemplateVersion = {
  id: string;
  templateId: string;
  version: number;
  positions: CommercialTemplatePositionContract[];
  createdAt: string;
};

export type StockProductionTemplate = {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'archived';
  version: number;
  positions: CommercialTemplatePositionContract[];
  versions: StockProductionTemplateVersion[];
  usageCount: number;
  lastUsedAt: string | null;
  updatedAt: string;
};

export type StockProductionTemplatePositionWriteInput = Pick<
  CommercialTemplatePositionContract,
  | 'rollCount'
  | 'filmType'
  | 'actualThickness'
  | 'accountingThickness'
  | 'widthMm'
  | 'plannedLengthM'
> &
  Partial<
    Pick<
      CommercialTemplatePositionContract,
      | 'baseRawMaterialDefinitionId'
      | 'recipeDefinitionVersionId'
      | 'spoolType'
      | 'birka'
      | 'manualBirka'
      | 'comment'
      | 'plannedWeightKg'
      | 'recipeParameters'
    >
  >;

export type StockProductionTemplateWriteInput = {
  name: string;
  description?: string;
  positions: StockProductionTemplatePositionWriteInput[];
};

export const STOCK_PRODUCTION_TEMPLATE_CONFLICT_MESSAGE =
  'Шаблон уже изменён на другом рабочем месте. Обновите каталог и повторите.';

export async function fetchStockProductionTemplates(
  options?: ApiRequestOptions,
): Promise<StockProductionTemplate[]> {
  const response = await apiGet<unknown>('/api/commercial/stock-production-templates', options);
  return parseStockProductionTemplates(response);
}

const STOCK_TEMPLATE_STATUSES = ['active', 'archived'] as const;

function parseStockProductionTemplates(value: unknown): StockProductionTemplate[] {
  if (!Array.isArray(value)) throw invalidStockTemplateResponse();
  const templates = value.map(parseStockProductionTemplate);
  if (new Set(templates.map((template) => template.id)).size !== templates.length) {
    throw invalidStockTemplateResponse();
  }
  return templates;
}

function parseStockProductionTemplate(value: unknown): StockProductionTemplate {
  if (!isStockTemplateRecord(value)) throw invalidStockTemplateResponse();
  const requiredKeys = [
    'id',
    'name',
    'description',
    'status',
    'version',
    'positions',
    'versions',
    'usageCount',
    'lastUsedAt',
    'updatedAt',
  ] as const;
  if (
    !requiredKeys.every((key) => Object.hasOwn(value, key)) ||
    !isStockTemplateText(value.id) ||
    !isStockTemplateText(value.name) ||
    (value.description !== null && typeof value.description !== 'string') ||
    !isStockTemplateEnum(value.status, STOCK_TEMPLATE_STATUSES) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 1 ||
    !Array.isArray(value.positions) ||
    value.positions.length === 0 ||
    value.positions.length > 100 ||
    !value.positions.every(isStockTemplatePosition) ||
    !Array.isArray(value.versions) ||
    !value.versions.every((version) => isStockTemplateVersion(version, value.id as string)) ||
    !Number.isSafeInteger(value.usageCount) ||
    (value.usageCount as number) < 0 ||
    (value.lastUsedAt !== null && !isStockTemplateTimestamp(value.lastUsedAt)) ||
    !isStockTemplateTimestamp(value.updatedAt)
  ) {
    throw invalidStockTemplateResponse();
  }
  return value as StockProductionTemplate;
}

function isStockTemplateVersion(value: unknown, templateId: string): boolean {
  return (
    isStockTemplateRecord(value) &&
    ['id', 'templateId', 'version', 'positions', 'createdAt'].every((key) =>
      Object.hasOwn(value, key),
    ) &&
    isStockTemplateText(value.id) &&
    value.templateId === templateId &&
    Number.isSafeInteger(value.version) &&
    (value.version as number) >= 1 &&
    Array.isArray(value.positions) &&
    value.positions.length > 0 &&
    value.positions.length <= 100 &&
    value.positions.every(isStockTemplatePosition) &&
    isStockTemplateTimestamp(value.createdAt)
  );
}

function isStockTemplatePosition(value: unknown): boolean {
  if (
    !isStockTemplateRecord(value) ||
    !['rollCount', 'filmType', 'actualThickness', 'accountingThickness', 'recipeParameters'].every(
      (key) => Object.hasOwn(value, key),
    ) ||
    !Number.isSafeInteger(value.rollCount) ||
    (value.rollCount as number) < 1 ||
    (value.rollCount as number) > 10_000 ||
    !isStockTemplateText(value.filmType) ||
    !isStockTemplateText(value.actualThickness) ||
    !isStockTemplateText(value.accountingThickness) ||
    !Array.isArray(value.recipeParameters) ||
    value.recipeParameters.length > 50 ||
    !value.recipeParameters.every(isStockTemplateParameter)
  ) {
    return false;
  }
  const hasBaseMaterial = isStockTemplateText(value.baseRawMaterialDefinitionId);
  const hasRecipe = isStockTemplateText(value.recipeDefinitionVersionId);
  return (
    Number(hasBaseMaterial) + Number(hasRecipe) === 1 &&
    isOptionalStockTemplateText(value, 'rawMaterialId', true) &&
    isOptionalStockTemplateText(value, 'baseRawMaterialDefinitionId', true) &&
    isOptionalStockTemplateText(value, 'recipeDefinitionVersionId', true) &&
    isOptionalStockTemplateText(value, 'spoolType', true) &&
    isOptionalStockTemplateText(value, 'birka', true) &&
    isOptionalStockTemplateText(value, 'manualBirka', true) &&
    isOptionalStockTemplateText(value, 'comment', true) &&
    isOptionalPositiveStockTemplateNumber(value, 'widthMm') &&
    isOptionalPositiveStockTemplateNumber(value, 'plannedLengthM') &&
    isOptionalPositiveStockTemplateNumber(value, 'plannedWeightKg')
  );
}

function isStockTemplateParameter(value: unknown): boolean {
  return (
    isStockTemplateRecord(value) &&
    Object.hasOwn(value, 'label') &&
    Object.hasOwn(value, 'value') &&
    isStockTemplateText(value.label) &&
    typeof value.value === 'string'
  );
}

function isStockTemplateRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStockTemplateText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStockTemplateTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isStockTemplateEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): value is T[number] {
  return typeof value === 'string' && allowed.includes(value);
}

function isOptionalStockTemplateText(
  value: Record<string, unknown>,
  key: string,
  allowEmptyOrNull: boolean,
): boolean {
  if (!Object.hasOwn(value, key)) return true;
  if (allowEmptyOrNull && value[key] === null) return true;
  return allowEmptyOrNull ? typeof value[key] === 'string' : isStockTemplateText(value[key]);
}

function isOptionalPositiveStockTemplateNumber(
  value: Record<string, unknown>,
  key: string,
): boolean {
  if (!Object.hasOwn(value, key) || value[key] === null) return true;
  return typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] > 0;
}

function invalidStockTemplateResponse(): Error {
  return new Error('Некорректный ответ каталога шаблонов на запас.');
}

function projectPosition(
  position: StockProductionTemplatePositionWriteInput,
): StockProductionTemplatePositionWriteInput {
  return {
    rollCount: position.rollCount,
    filmType: position.filmType,
    actualThickness: position.actualThickness,
    accountingThickness: position.accountingThickness,
    widthMm: position.widthMm,
    plannedLengthM: position.plannedLengthM,
    ...(position.baseRawMaterialDefinitionId
      ? { baseRawMaterialDefinitionId: position.baseRawMaterialDefinitionId }
      : {}),
    ...(position.recipeDefinitionVersionId
      ? { recipeDefinitionVersionId: position.recipeDefinitionVersionId }
      : {}),
    ...(position.spoolType ? { spoolType: position.spoolType } : {}),
    ...(position.birka ? { birka: position.birka } : {}),
    ...(position.manualBirka ? { manualBirka: position.manualBirka } : {}),
    ...(position.comment ? { comment: position.comment } : {}),
    ...(position.plannedWeightKg !== null && position.plannedWeightKg !== undefined
      ? { plannedWeightKg: position.plannedWeightKg }
      : {}),
    ...(position.recipeParameters
      ? {
          recipeParameters: position.recipeParameters.map((parameter) => ({
            label: parameter.label,
            value: parameter.value,
          })),
        }
      : {}),
  };
}

function projectWriteInput(input: StockProductionTemplateWriteInput) {
  return {
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    positions: input.positions.map(projectPosition),
  };
}

function stockTemplateWriteError(error: unknown): never {
  if (error instanceof ApiError && error.status === 409) {
    throw new Error(STOCK_PRODUCTION_TEMPLATE_CONFLICT_MESSAGE);
  }
  throw error;
}

export async function createStockProductionTemplate(
  input: StockProductionTemplateWriteInput,
): Promise<StockProductionTemplate> {
  try {
    return await apiPost<StockProductionTemplate>(
      '/api/commercial/stock-production-templates',
      projectWriteInput(input),
    );
  } catch (error) {
    return stockTemplateWriteError(error);
  }
}

export async function updateStockProductionTemplate(
  id: string,
  input: StockProductionTemplateWriteInput & { expectedVersion: number },
): Promise<StockProductionTemplate> {
  try {
    return await apiPatch<StockProductionTemplate>(
      `/api/commercial/stock-production-templates/${encodeURIComponent(id)}`,
      {
        ...projectWriteInput(input),
        expectedVersion: input.expectedVersion,
      },
    );
  } catch (error) {
    return stockTemplateWriteError(error);
  }
}
