import type { StockProductionTemplate } from '../api/stockProductionTemplates';
import type { CommercialTemplatePositionContract } from '../features/commercial/contracts';
import type { IntakeDraftForm, IntakeDraftPosition } from './prototypeRuntime';

function recipeValue(position: CommercialTemplatePositionContract, label: string): string {
  return (
    position.recipeParameters?.find(
      (parameter) =>
        parameter.label.toLocaleLowerCase('ru-RU') === label.toLocaleLowerCase('ru-RU'),
    )?.value ?? ''
  );
}

function templatePositionToDraft(
  templateId: string,
  position: CommercialTemplatePositionContract,
  index: number,
): IntakeDraftPosition {
  const micron = position.actualThickness.match(/\d+(?:[.,]\d+)?/)?.[0] ?? '';
  return {
    id: `${templateId}-position-${index + 1}`,
    rollCount: String(position.rollCount),
    micronPreset: micron || 'manual',
    micronCustom: micron,
    actualThickness: position.actualThickness,
    accountingThickness: position.accountingThickness,
    filmType: position.filmType,
    widthMm: position.widthMm == null ? '' : String(position.widthMm),
    plannedLengthM:
      position.plannedLengthM == null ? '' : String(position.plannedLengthM),
    plannedWeightKg:
      position.plannedWeightKg === null || position.plannedWeightKg === undefined
        ? ''
        : String(position.plannedWeightKg),
    birka: position.birka ?? '',
    manualBirka: position.manualBirka ?? '',
    comment: position.comment ?? '',
    rawMaterial:
      recipeValue(position, 'Сырьё') ||
      recipeValue(position, 'Сырье') ||
      position.rawMaterialId ||
      '',
    rawMaterialId: position.rawMaterialId ?? '',
    baseRawMaterialDefinitionId: position.baseRawMaterialDefinitionId ?? '',
    recipeDefinitionVersionId: position.recipeDefinitionVersionId ?? '',
    spoolType: position.spoolType ?? '',
  };
}

export function applyStockProductionTemplate(
  form: IntakeDraftForm,
  template: StockProductionTemplate,
): IntakeDraftForm {
  return {
    ...form,
    stockProductionTemplateId: template.id,
    positions: template.positions.map((position, index) =>
      templatePositionToDraft(template.id, position, index),
    ),
  };
}
