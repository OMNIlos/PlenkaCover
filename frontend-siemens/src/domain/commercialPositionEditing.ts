import type {
  CommercialOrderPosition,
  CounterpartyOrderTemplateVersion,
  RawMaterialStock,
  WarehouseCoverStatus,
} from './types';

export const COMMERCIAL_BIRKA_DIRECTORY_OPTIONS = [
  'Гост 103',
  'Гост 103 (без ПХТ)',
  'Гост 259',
  'Гост 259 (без ПХТ)',
  'Техничка',
  'Гост',
  '(i)',
  'Бирка клиента',
];

export type CommercialPositionDraft = {
  rollCount: string;
  filmType: string;
  actualThickness: string;
  accountingThickness: string;
  birka: string;
  manualBirka: string;
  spoolType: string;
  rawMaterialLabel: string;
  warehouseCoverStatus: CommercialOrderPosition['warehouseCoverStatus'];
  warehousePartialCoverQty: string;
};

export type CommercialPositionOptionField =
  | 'filmType'
  | 'actualThickness'
  | 'accountingThickness'
  | 'birka'
  | 'spoolType'
  | 'rawMaterialLabel';

export type CommercialPositionOptionSources = Record<CommercialPositionOptionField, string[]>;

export type CommercialPositionUpdate = {
  rollCount: number;
  filmType: string;
  actualThickness: string;
  accountingThickness: string;
  rawMaterialId?: string;
  spoolType: string;
  birka?: string;
  recipeParameters: Array<{ label: string; value: string }>;
};

export type CommercialPositionRoute = {
  status: 'partial_proposed' | 'full_proposed' | 'needs_production';
  coverQty?: number;
  reason: string;
};

export type CommercialPositionMutationPlan = {
  positionUpdate: CommercialPositionUpdate;
  route?: CommercialPositionRoute;
};

const TEMPLATE_FIELD_LABELS: Record<
  Exclude<CommercialPositionOptionField, 'rawMaterialLabel'>,
  string[]
> = {
  filmType: ['тип пленки', 'тип плёнки'],
  actualThickness: ['толщина', 'фактическая толщина', 'толщина факт'],
  accountingThickness: ['толщина', 'бухгалтерская толщина', 'толщина учётная'],
  birka: ['бирка', 'цвет'],
  spoolType: ['шпуля', 'втулка'],
};

function normalizeText(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeCommercialThickness(value: string) {
  const normalized = normalizeText(value).replace(/,/g, '.').toLowerCase();
  const match = normalized.match(/^(\d{1,3})(?:\s*(?:мкм|мкр|micron|microns))?$/i);
  return match ? `${Number(match[1])} мкм` : '';
}

function uniqueValues(values: Array<string | undefined>) {
  return Array.from(new Set(values.map((value) => normalizeText(value ?? '')).filter(Boolean)));
}

function templateValues(
  templateVersions: CounterpartyOrderTemplateVersion[],
  field: Exclude<CommercialPositionOptionField, 'rawMaterialLabel'>,
) {
  const labels = TEMPLATE_FIELD_LABELS[field];
  return templateVersions.flatMap((version) =>
    version.fields
      .filter((item) => labels.includes(item.label.trim().toLowerCase()))
      .map((item) => item.value),
  );
}

export function buildCommercialPositionOptionSources({
  positions,
  templateVersions,
  rawMaterialStocks,
}: {
  positions: CommercialOrderPosition[];
  templateVersions: CounterpartyOrderTemplateVersion[];
  rawMaterialStocks: RawMaterialStock[];
}): CommercialPositionOptionSources {
  const thicknessValues = (values: Array<string | undefined>) =>
    uniqueValues(values.map((value) => (value ? normalizeCommercialThickness(value) : value)));

  return {
    filmType: uniqueValues([
      ...positions.map((position) => position.filmType),
      ...templateValues(templateVersions, 'filmType'),
    ]),
    actualThickness: thicknessValues([
      ...positions.map((position) => position.actualThickness),
      ...templateValues(templateVersions, 'actualThickness'),
    ]),
    accountingThickness: thicknessValues([
      ...positions.map((position) => position.accountingThickness),
      ...templateValues(templateVersions, 'accountingThickness'),
    ]),
    birka: uniqueValues([
      ...COMMERCIAL_BIRKA_DIRECTORY_OPTIONS,
      ...positions.flatMap((position) => [position.birka, position.manualBirka]),
      ...templateValues(templateVersions, 'birka'),
    ]),
    spoolType: uniqueValues([
      ...positions.map((position) => position.spoolType),
      ...templateValues(templateVersions, 'spoolType'),
    ]),
    rawMaterialLabel: uniqueValues([
      ...rawMaterialStocks.map((stock) => stock.label),
      ...positions.map((position) => position.rawMaterialLabel),
    ]),
  };
}

export function rawMaterialIdForLabel(
  label: string,
  rawMaterialStocks: RawMaterialStock[],
  sourcePositions: CommercialOrderPosition[] = [],
) {
  const normalized = normalizeText(label);
  return (
    rawMaterialStocks.find((stock) => normalizeText(stock.label) === normalized)?.rawMaterialId ??
    sourcePositions.find(
      (sourcePosition) => normalizeText(sourcePosition.rawMaterialLabel) === normalized,
    )?.rawMaterialId
  );
}

function routeForDraft(
  draft: CommercialPositionDraft,
  position: CommercialOrderPosition,
  currentCoverQty?: number,
): CommercialPositionRoute | undefined {
  const status = draft.warehouseCoverStatus;
  if (!isEditableRouteStatus(status)) return undefined;

  const rollCount = Math.max(1, Number(draft.rollCount) || position.rollCount);
  const coverQty =
    status === 'full_proposed'
      ? rollCount
      : status === 'partial_proposed'
        ? Math.max(1, Math.min(rollCount - 1, Number(draft.warehousePartialCoverQty) || 1))
        : undefined;
  const coverChanged = coverQty !== undefined && coverQty !== currentCoverQty;
  if (status === position.warehouseCoverStatus && !coverChanged) return undefined;

  return {
    status,
    ...(coverQty !== undefined ? { coverQty } : {}),
    reason: 'Коммерция выбрала маршрут покрытия в правке позиции',
  };
}

function isEditableRouteStatus(
  status: WarehouseCoverStatus,
): status is CommercialPositionRoute['status'] {
  return ['partial_proposed', 'full_proposed', 'needs_production'].includes(status);
}

export function buildCommercialPositionMutationPlan({
  draft,
  position,
  rawMaterialStocks,
  sourcePositions = [],
  currentCoverQty,
}: {
  draft: CommercialPositionDraft;
  position: CommercialOrderPosition;
  rawMaterialStocks: RawMaterialStock[];
  sourcePositions?: CommercialOrderPosition[];
  currentCoverQty?: number;
}): CommercialPositionMutationPlan {
  const rollCount = Math.max(1, Math.min(999, Math.trunc(Number(draft.rollCount) || 1)));
  const birka = uniqueValues([draft.birka, draft.manualBirka]).join(' / ') || undefined;
  const rawMaterialId = rawMaterialIdForLabel(draft.rawMaterialLabel, rawMaterialStocks, [
    position,
    ...sourcePositions,
  ]);

  return {
    positionUpdate: {
      rollCount,
      filmType: normalizeText(draft.filmType),
      actualThickness: normalizeCommercialThickness(draft.actualThickness),
      accountingThickness: normalizeCommercialThickness(draft.accountingThickness),
      rawMaterialId,
      spoolType: normalizeText(draft.spoolType),
      birka,
      recipeParameters: [
        { label: 'Тип плёнки', value: normalizeText(draft.filmType) },
        { label: 'Толщина факт', value: normalizeCommercialThickness(draft.actualThickness) },
        {
          label: 'Толщина учётная',
          value: normalizeCommercialThickness(draft.accountingThickness),
        },
        {
          label: 'План. вес, кг',
          value:
            position.plannedWeightKg !== undefined
              ? String(position.plannedWeightKg)
              : (position.recipeSnapshot.parameters.find(
                  (parameter) => parameter.label === 'План. вес, кг',
                )?.value ?? 'не указан'),
        },
        { label: 'Сырьё', value: normalizeText(draft.rawMaterialLabel) },
        { label: 'Шпуля', value: normalizeText(draft.spoolType) },
        { label: 'Комментарий', value: position.comment ?? 'Без комментария' },
      ],
    },
    route: routeForDraft(draft, position, currentCoverQty),
  };
}
