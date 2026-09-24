import {
  activeVersionForTemplate,
  templateDisplayName,
  templateFieldValue,
} from './templates';
import {
  COMMERCIAL_BIRKA_OPTIONS,
  COMMERCIAL_FILM_TYPES,
  COMMERCIAL_SPOOL_OPTIONS,
  isCommercialMaterialSelectionAvailable,
} from './materialRecipeCatalog';
import type {
  RawMaterialCatalogItem,
  RecipeCatalogItem,
} from '../api/materialRecipeCatalog';
import type { IntakeDraftForm, IntakeDraftPosition } from './prototypeRuntime';
import type { CounterpartyOrderTemplate, CounterpartyOrderTemplateVersion } from './types';

function fallbackPosition(current?: IntakeDraftPosition): IntakeDraftPosition {
  return {
    id: current?.id ?? 'pos-template-1',
    rollCount: current?.rollCount ?? '1',
    micronPreset: current?.micronPreset ?? '80',
    micronCustom: current?.micronCustom ?? '',
    actualThickness: current?.actualThickness ?? '80 мкм',
    accountingThickness: current?.accountingThickness ?? '80 мкм',
    filmType: current?.filmType ?? 'Рукав',
    widthMm: current?.widthMm ?? '',
    plannedLengthM: current?.plannedLengthM ?? '',
    plannedWeightKg: current?.plannedWeightKg ?? '',
    birka: current?.birka ?? 'Гост',
    manualBirka: current?.manualBirka ?? '',
    comment: current?.comment ?? '',
    rawMaterial: current?.rawMaterial ?? '',
    rawMaterialId: current?.rawMaterialId ?? '',
    baseRawMaterialDefinitionId: current?.baseRawMaterialDefinitionId ?? '',
    recipeDefinitionVersionId: current?.recipeDefinitionVersionId ?? '',
    spoolType: current?.spoolType ?? 'Тонкая',
  };
}

function rollCountFromText(value: string) {
  const match = value.match(/(\d+)\s*(шт|рулон|рул)/i) ?? value.match(/^\s*(\d+)/);
  return match ? match[1] : '';
}

function plannedWeightFromText(value: string) {
  const match =
    value.match(/по\s*(\d+(?:[.,]\d+)?)\s*кг/i) ??
    value.match(/(?:^|[,\s])(\d+(?:[.,]\d+)?)\s*кг\s*план/i);
  return match ? match[1].replace(',', '.') : '';
}

function micronPresetFromThickness(value: string) {
  const match = value.match(/(\d+)/);
  return match ? match[1] : '';
}

function exactOption(
  value: string,
  options: readonly string[],
): string {
  const trimmed = value.trim();
  return options.includes(trimmed) ? trimmed : '';
}

function normalizeTemplatePosition(
  position: IntakeDraftPosition,
  catalog?: {
    materials: readonly RawMaterialCatalogItem[];
    recipes: readonly RecipeCatalogItem[];
  },
): IntakeDraftPosition {
  const normalized = {
    ...position,
    filmType: exactOption(position.filmType, COMMERCIAL_FILM_TYPES),
    birka: exactOption(position.birka, COMMERCIAL_BIRKA_OPTIONS),
    spoolType: exactOption(position.spoolType, COMMERCIAL_SPOOL_OPTIONS),
    baseRawMaterialDefinitionId: position.baseRawMaterialDefinitionId.trim(),
    recipeDefinitionVersionId: position.recipeDefinitionVersionId.trim(),
    rawMaterialId: '',
  };
  if (
    catalog &&
    !isCommercialMaterialSelectionAvailable(
      normalized,
      catalog.materials,
      catalog.recipes,
    )
  ) {
    return {
      ...normalized,
      baseRawMaterialDefinitionId: '',
      recipeDefinitionVersionId: '',
      rawMaterial: '',
    };
  }
  return normalized;
}

export function applyTemplateToIntakeDraft(
  form: IntakeDraftForm,
  template: CounterpartyOrderTemplate,
  versions: CounterpartyOrderTemplateVersion[],
  structuredPositions: readonly IntakeDraftPosition[] = [],
  materialCatalog?: {
    materials: readonly RawMaterialCatalogItem[];
    recipes: readonly RecipeCatalogItem[];
  },
): IntakeDraftForm {
  const version = activeVersionForTemplate(template, versions);
  if (structuredPositions.length > 0) {
    return {
      ...form,
      templateId: template.id,
      templateVersionId: version?.id,
      template: templateDisplayName(template, versions) || template.name,
      positions: structuredPositions.map((position) =>
        normalizeTemplatePosition({ ...position }, materialCatalog),
      ),
    };
  }

  if (!version) {
    return {
      ...form,
      templateId: template.id,
      templateVersionId: undefined,
      template: template.name,
    };
  }

  const current = fallbackPosition(form.positions[0]);
  const thickness = templateFieldValue(version.fields, 'Толщина');
  const widthMm =
    templateFieldValue(version.fields, 'Ширина, мм') ||
    templateFieldValue(version.fields, 'Ширина');
  const plannedLengthM =
    templateFieldValue(version.fields, 'Метраж, м') ||
    templateFieldValue(version.fields, 'Метраж');
  const filmType = templateFieldValue(version.fields, 'Тип пленки');
  const rawMaterial = templateFieldValue(version.fields, 'Сырье');
  const spool = templateFieldValue(version.fields, 'Шпуля') || templateFieldValue(version.fields, 'Втулка');
  const birka =
    templateFieldValue(version.fields, 'Бирка') ||
    templateFieldValue(version.fields, 'Цвет');
  const rollsText = templateFieldValue(version.fields, 'Рулоны') || templateFieldValue(version.fields, 'Позиции');
  const nextRawMaterial = rawMaterial || current.rawMaterial;

  return {
    ...form,
    templateId: template.id,
    templateVersionId: version.id,
    template: templateDisplayName(template, versions) || template.name,
    positions: [
      {
        ...current,
        rollCount: rollCountFromText(rollsText) || current.rollCount,
        micronPreset: thickness ? micronPresetFromThickness(thickness) || current.micronPreset : current.micronPreset,
        actualThickness: thickness || current.actualThickness,
        accountingThickness: thickness || current.accountingThickness,
        widthMm: widthMm || current.widthMm,
        plannedLengthM: plannedLengthM || current.plannedLengthM,
        filmType: exactOption(filmType || current.filmType, COMMERCIAL_FILM_TYPES),
        plannedWeightKg: plannedWeightFromText(rollsText) || current.plannedWeightKg,
        rawMaterial: nextRawMaterial,
        rawMaterialId: '',
        baseRawMaterialDefinitionId: '',
        recipeDefinitionVersionId: '',
        birka: exactOption(birka || current.birka, COMMERCIAL_BIRKA_OPTIONS),
        spoolType: exactOption(spool || current.spoolType, COMMERCIAL_SPOOL_OPTIONS),
      },
    ],
  };
}

export function refreshIntakeDraftFromSelectedTemplate(
  form: IntakeDraftForm,
  templates: CounterpartyOrderTemplate[],
  versions: CounterpartyOrderTemplateVersion[],
  structuredPositions: Readonly<Record<string, readonly IntakeDraftPosition[]>> = {},
  materialCatalog?: {
    materials: readonly RawMaterialCatalogItem[];
    recipes: readonly RecipeCatalogItem[];
  },
): IntakeDraftForm {
  const selectedTemplate = form.templateId
    ? templates.find((template) => template.id === form.templateId)
    : undefined;
  return selectedTemplate
    ? applyTemplateToIntakeDraft(
        form,
        selectedTemplate,
        versions,
        structuredPositions[selectedTemplate.id],
        materialCatalog,
      )
    : form;
}
