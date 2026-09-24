import { roleOrder } from './demoData';
import { getFinanceActionKind } from './actions';
import { operatorById } from './operators';
import { counterparties } from './templates';
import {
  COMMERCIAL_BIRKA_OPTIONS,
  COMMERCIAL_FILM_TYPES,
  COMMERCIAL_SPOOL_OPTIONS,
} from './materialRecipeCatalog';
import type { WorkObjectsByRole } from './selectors';
import type {
  ActionDescriptor,
  AuditEntry,
  CommercialOrderPosition,
  CommercialOrderRequest,
  CommercialPaymentIndicator,
  CounterpartyBillingSnapshot,
  CounterpartyType,
  CounterpartyOrderTemplateField,
  Fact,
  OrderRollGroup,
  ProblemCase,
  ProductionLeadCreatedRequest,
  ProductionPriority,
  QRActionPanelContext,
  RecipeSnapshot,
  RoleAssignmentDraft,
  RoleTemplate,
  UserAccessEntry,
  WarehouseCoverProposal,
  WorkObject,
} from './types';

export type IntakeDraftPosition = {
  id: string;
  rollCount: string;
  micronPreset: string;
  micronCustom: string;
  actualThickness: string;
  accountingThickness: string;
  filmType: string;
  widthMm: string;
  plannedLengthM: string;
  plannedWeightKg: string;
  birka: string;
  manualBirka: string;
  comment: string;
  rawMaterial: string;
  rawMaterialId: string;
  baseRawMaterialDefinitionId: string;
  recipeDefinitionVersionId: string;
  spoolType: string;
};

export type IntakeDraftForm = {
  counterparty: string;
  counterpartyId?: string;
  counterpartyQuickCreateSaved: boolean;
  newCounterpartyType: CounterpartyType;
  newCounterpartyName: string;
  newCounterpartyInn: string;
  newCounterpartyKpp: string;
  newCounterpartyOgrn: string;
  newCounterpartyLegalAddress: string;
  newCounterpartyContactName: string;
  newCounterpartyContactPhone: string;
  newCounterpartyContactEmail: string;
  templateId: string | undefined;
  templateVersionId?: string;
  stockProductionTemplateId?: string;
  template: string;
  positions: IntakeDraftPosition[];
  comment: string;
  commercialFinanceNote?: string;
  saveAsTemplate: boolean;
  assignedOperatorId: string;
  priority: ProductionPriority;
};

export type IntakeSubmitMode = 'draft' | 'work' | 'order';

export function factValue(object: WorkObject, label: string) {
  const direct = object.facts.find((fact) => fact.label === label)?.value;
  if (direct) return direct;
  return object.sections.flatMap((section) => section.facts).find((fact) => fact.label === label)?.value;
}

export function canReorderStatus(statusLabel: string) {
  return !['Передано', 'Закрыто', 'Готово', 'Счет выставлен', 'Счет к оплате отправлен'].includes(statusLabel);
}

export const defaultIntakeDraft: IntakeDraftForm = {
  counterparty: 'УралПак',
  counterpartyQuickCreateSaved: false,
  newCounterpartyType: 'legal_entity',
  newCounterpartyName: '',
  newCounterpartyInn: '',
  newCounterpartyKpp: '',
  newCounterpartyOgrn: '',
  newCounterpartyLegalAddress: '',
  newCounterpartyContactName: '',
  newCounterpartyContactPhone: '',
  newCounterpartyContactEmail: '',
  templateId: 'tpl-uralpak-sleeve-80',
  template: 'УралПак · рукав 80 мкм',
  positions: [
    {
      id: 'pos-1',
      rollCount: '3',
      micronPreset: '80',
      micronCustom: '',
      actualThickness: '80 мкм',
      accountingThickness: '78 мкм',
      filmType: 'Рукав',
      widthMm: '1700',
      plannedLengthM: '275',
      plannedWeightKg: '41.2',
      birka: 'ГОСТ',
      manualBirka: '',
      comment: 'Основная позиция для повторного заказа.',
      rawMaterial: 'Первичное',
      rawMaterialId: '',
      baseRawMaterialDefinitionId: 'rmd-base-primary',
      recipeDefinitionVersionId: '',
      spoolType: 'Тонкая',
    },
    {
      id: 'pos-2',
      rollCount: '2',
      micronPreset: '60',
      micronCustom: '',
      actualThickness: '60 мкм',
      accountingThickness: '58 мкм',
      filmType: 'Полурукав',
      widthMm: '1400',
      plannedLengthM: '350',
      plannedWeightKg: '34.5',
      birka: 'i',
      manualBirka: 'Маркировка клиента A-17',
      comment: 'Отдельная бирка и другая шпуля, не склеивать с позицией 1.',
      rawMaterial: 'Вторичное',
      rawMaterialId: '',
      baseRawMaterialDefinitionId: 'rmd-base-secondary',
      recipeDefinitionVersionId: '',
      spoolType: 'Толстая',
    },
  ],
  comment: 'Повторить прошлый заказ, уточнить дату отгрузки и упаковку.',
  commercialFinanceNote: '',
  saveAsTemplate: false,
  assignedOperatorId: 'operator-line-a',
  priority: 'срочно',
};

export const defaultRoleAssignmentDraft: RoleAssignmentDraft = {
  email: 'new-operator@example.com',
  roleTemplateId: 'role-template-operator',
  status: 'active',
};

export function intakeCounterpartyLabel(form: IntakeDraftForm) {
  return form.counterparty === '__new__' ? form.newCounterpartyName.trim() : form.counterparty.trim();
}

export function counterpartyTypeLabel(type: CounterpartyType) {
  if (type === 'individual_entrepreneur') return 'ИП';
  if (type === 'individual') return 'Физическое лицо';
  return 'Юридическое лицо';
}

function billingSnapshotSourceLabel(source: CounterpartyBillingSnapshot['source']) {
  if (source === 'manual_order_entry') return 'ручной ввод';
  if (source === 'mock_1C_snapshot') return 'снимок карточки контрагента';
  return 'карточка контрагента';
}

export function intakeCounterpartyBillingSnapshot(form: IntakeDraftForm, createdBy: string): CounterpartyBillingSnapshot {
  const label = intakeCounterpartyLabel(form) || 'Контрагент не выбран';
  const selectedCounterparty = counterparties.find((counterparty) => counterparty.legalName === label);
  const isNewCounterparty = form.counterparty === '__new__';

  return {
    id: `billing-${label.toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-').replace(/^-|-$/g, '') || 'counterparty'}-${Date.now()}`,
    counterpartyId: selectedCounterparty?.id,
    label,
    type: isNewCounterparty ? form.newCounterpartyType : 'legal_entity',
    inn: isNewCounterparty ? form.newCounterpartyInn.trim() || undefined : selectedCounterparty?.inn,
    kpp: isNewCounterparty ? form.newCounterpartyKpp.trim() || undefined : selectedCounterparty?.kpp,
    ogrn: isNewCounterparty ? form.newCounterpartyOgrn.trim() || undefined : selectedCounterparty?.ogrn,
    legalAddress: isNewCounterparty ? form.newCounterpartyLegalAddress.trim() || undefined : selectedCounterparty?.legalAddress,
    contactName: isNewCounterparty ? form.newCounterpartyContactName.trim() || undefined : undefined,
    contactPhone: isNewCounterparty ? form.newCounterpartyContactPhone.trim() || undefined : undefined,
    contactEmail: isNewCounterparty ? form.newCounterpartyContactEmail.trim() || undefined : undefined,
    source: isNewCounterparty ? 'manual_order_entry' : selectedCounterparty?.source === 'mock_1C' ? 'mock_1C_snapshot' : 'counterparty_card_snapshot',
    syncStatus: isNewCounterparty ? 'manual_not_synced' : selectedCounterparty?.syncStatus === 'mock_snapshot' ? 'mock_snapshot' : 'needs_1C_discovery',
    createdBy,
    createdAt: stampNow(),
  };
}

function intakeCounterpartyLegalFacts(form: IntakeDraftForm): Fact[] {
  const billingSnapshot = intakeCounterpartyBillingSnapshot(form, 'Коммерция');
  const sourceLabel = billingSnapshot.source === 'manual_order_entry'
    ? 'ручной ввод · нужна сверка'
    : 'карточка контрагента · нужна сверка';

  return [
    { label: 'Тип контрагента', value: counterpartyTypeLabel(billingSnapshot.type), scope: 'legal' },
    { label: 'ИНН', value: billingSnapshot.inn ?? '[нужен факт]', scope: 'legal' },
    { label: 'КПП', value: billingSnapshot.kpp ?? '[нужен факт]', scope: 'legal' },
    { label: 'ОГРН', value: billingSnapshot.ogrn ?? '[нужен факт]', scope: 'legal' },
    { label: 'Юр. адрес', value: billingSnapshot.legalAddress ?? '[нужен факт]', scope: 'legal' },
    ...(billingSnapshot.contactName ? [{ label: 'Контакт', value: billingSnapshot.contactName, scope: 'legal' as const }] : []),
    { label: 'Источник реквизитов', value: sourceLabel, scope: 'legal' },
    { label: 'Статус реквизитов', value: billingSnapshot.syncStatus, scope: 'rawDiagnostics' },
  ];
}

export function createIntakeDraftPosition(index: number): IntakeDraftPosition {
  return {
    id: `pos-${Date.now()}-${index}`,
    rollCount: '1',
    micronPreset: '80',
    micronCustom: '',
    actualThickness: '80 мкм',
    accountingThickness: '78 мкм',
    filmType: 'Рукав',
    widthMm: '',
    plannedLengthM: '',
    plannedWeightKg: '',
    birka: 'ГОСТ',
    manualBirka: '',
    comment: '',
    rawMaterial: '',
    rawMaterialId: '',
    baseRawMaterialDefinitionId: '',
    recipeDefinitionVersionId: '',
    spoolType: 'Тонкая',
  };
}

export function intakeMicronLabel(position: IntakeDraftPosition) {
  const explicit = position.actualThickness.trim();
  if (explicit) return explicit;
  const micron = position.micronPreset === 'manual' ? position.micronCustom.trim() : position.micronPreset;
  return micron ? `${micron} мкм` : 'толщина не указана';
}

export function intakeTotalRollCount(form: IntakeDraftForm) {
  return form.positions.reduce((total, position) => total + Math.max(0, Number(position.rollCount) || 0), 0);
}

export function intakePositionLineSummary(position: IntakeDraftPosition, index: number) {
  const rollCount = position.rollCount.trim() || '0';
  const dimensions =
    position.widthMm.trim() && position.plannedLengthM.trim()
      ? `${position.widthMm.trim()} мм · ${position.plannedLengthM.trim()} м`
      : 'размер не указан';
  const weight = position.plannedWeightKg.trim() ? `${position.plannedWeightKg.trim()} кг/рулон` : 'вес не указан';
  const birka = [position.birka.trim(), position.manualBirka.trim()].filter(Boolean).join(' / ') || 'бирка не указана';
  const accounting = position.accountingThickness.trim() || 'бух. толщина не указана';
  return `#${index + 1}: ${rollCount} рул. · ${position.filmType || 'тип не указан'} · факт ${intakeMicronLabel(position)} · бух. ${accounting} · ${dimensions} · ${position.spoolType || 'шпуля не указана'} · ${weight} · ${birka}`;
}

export function intakePositionSummary(form: IntakeDraftForm) {
  const positionCount = form.positions.length;
  const totalRolls = intakeTotalRollCount(form);
  const lines = form.positions.map((position, index) => intakePositionLineSummary(position, index)).join('; ');
  return `${positionCount} поз., ${totalRolls} рул. всего${lines ? `: ${lines}` : ''}`;
}

export function intakePositionMissingFields(position: IntakeDraftPosition) {
  const missing: string[] = [];
  if (!isValidPositiveDecimal(position.rollCount, 10_000, 0)) {
    missing.push('количество рулонов');
  }
  if (!position.actualThickness.trim()) missing.push('фактическая толщина');
  if (!position.accountingThickness.trim()) missing.push('бухгалтерская толщина');
  if (!isCatalogValue(position.filmType, COMMERCIAL_FILM_TYPES)) missing.push('тип пленки');
  if (!isValidPositiveDecimal(position.widthMm, 100_000)) missing.push('ширина');
  if (!isValidPositiveDecimal(position.plannedLengthM, 10_000_000)) missing.push('метраж');
  if (!isValidPositiveDecimal(position.plannedWeightKg, 100_000)) missing.push('вес');
  if (
    (position.birka.trim() && !isCatalogValue(position.birka, COMMERCIAL_BIRKA_OPTIONS)) ||
    (!position.birka.trim() && !position.manualBirka.trim())
  ) {
    missing.push('бирка');
  }
  if (!isCatalogValue(position.spoolType, COMMERCIAL_SPOOL_OPTIONS)) missing.push('шпуля');
  const hasBaseMaterial = position.baseRawMaterialDefinitionId.trim().length > 0;
  const hasRecipe = position.recipeDefinitionVersionId.trim().length > 0;
  if (hasBaseMaterial === hasRecipe) missing.push('сырье');
  return missing;
}

function isCatalogValue(value: string, options: readonly string[]) {
  const normalized = value.trim();
  return options.some((option) => option === normalized);
}

function isValidPositiveDecimal(value: string, max: number, decimalPlaces = 3) {
  const normalized = value.trim().replace(',', '.');
  const fraction = decimalPlaces > 0 ? `(?:\\.\\d{1,${decimalPlaces}})?` : '';
  if (!new RegExp(`^\\d+${fraction}$`).test(normalized)) return false;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) && numeric > 0 && numeric <= max;
}

export function intakeIncompletePositionReason(form: IntakeDraftForm) {
  if (form.positions.length === 0) return 'Нет позиций';
  const index = form.positions.findIndex((position) => intakePositionMissingFields(position).length > 0);
  if (index < 0) return '';
  return `Заполните позицию ${index + 1}: ${intakePositionMissingFields(form.positions[index]).join(', ')}`;
}

export function intakeHasRequiredPositionFields(form: IntakeDraftForm) {
  return form.positions.length > 0 && form.positions.every((position) => intakePositionMissingFields(position).length === 0);
}

export function intakeDraftIsComplete(form: IntakeDraftForm) {
  return intakeCounterpartyLabel(form).length > 0 && intakeHasRequiredPositionFields(form);
}

export function intakePositionDetailFacts(form: IntakeDraftForm, scope: Fact['scope'] = 'commercial'): Fact[] {
  return form.positions.map((position, index) => ({
    label: `Позиция ${index + 1}`,
    value: intakePositionLineSummary(position, index),
    scope,
  }));
}

function intakeRollGroups(form: IntakeDraftForm): OrderRollGroup[] {
  let rollSequence = 1;

  return form.positions.map((position, index) => {
    const plannedRolls = Math.max(1, Number(position.rollCount) || 1);
    const rollIds = Array.from({ length: plannedRolls }, () => {
      const rollId = `P${index + 1}-R${String(rollSequence).padStart(2, '0')}`;
      rollSequence += 1;
      return rollId;
    });

    return {
      id: `intake-position-${index + 1}`,
      title: `Позиция ${index + 1}`,
      filmType: position.filmType || 'Тип не указан',
      micron: intakeMicronLabel(position),
      color: position.birka || 'Бирка не указана',
      sizeMeters:
        position.widthMm && position.plannedLengthM
          ? `${position.widthMm} мм · ${position.plannedLengthM} м`
          : 'Уточнить при оформлении',
      sleeve: position.spoolType || 'Шпуля не указана',
      recipe: position.rawMaterial || 'Сырье не указано',
      recipeVersion: 'из заявки',
      plannedRolls,
      plannedNetKg: Number(position.plannedWeightKg) || 0,
      tolerancePercent: 2,
      machine: 'Назначить',
      owner: 'Зав. производства',
      status: 'Ждет оформления',
      rollIds,
    };
  });
}

export function intakeCharacteristicLabel(form: IntakeDraftForm) {
  if (form.positions.length === 0) return 'Не указаны';
  return form.positions.length === 1 ? intakePositionLineSummary(form.positions[0], 0) : 'Разные характеристики по позициям';
}

export function intakeRawMaterialSummary(form: IntakeDraftForm) {
  const materials = Array.from(new Set(form.positions.map((position) => position.rawMaterial.trim()).filter(Boolean)));
  if (materials.length === 0) return 'Не указано';
  return materials.join(', ');
}

function positionBirkaLabel(position: IntakeDraftPosition) {
  return [position.birka.trim(), position.manualBirka.trim()].filter(Boolean).join(' / ') || 'Не указана';
}

function recipeSnapshotForPosition(position: IntakeDraftPosition, requestId: string, index: number, createdBy: string): RecipeSnapshot {
  const positionId = `${requestId}-POS-${index + 1}`;
  return {
    id: `${positionId}-RECIPE-v1`,
    positionId,
    recipeOwnerRole: 'commercial',
    parameters: [
      { label: 'Тип пленки', value: position.filmType || 'Не указан' },
      { label: 'Фактическая толщина', value: position.actualThickness || intakeMicronLabel(position) },
      { label: 'Бухгалтерская толщина', value: position.accountingThickness || 'Не указана' },
      { label: 'Шпуля', value: position.spoolType || 'Не указана' },
      { label: 'Сырье', value: position.rawMaterial || 'Не указано' },
    ],
    source: createdBy === 'Зав. производства' ? 'production_lead_form' : 'commercial_form',
    createdBy,
    createdAt: stampNow(),
    version: 'v1',
  };
}

function commercialPositions(form: IntakeDraftForm, requestId: string, createdBy: string): CommercialOrderPosition[] {
  return form.positions.map((position, index) => {
    const recipeSnapshot = recipeSnapshotForPosition(position, requestId, index, createdBy);
    return {
      id: recipeSnapshot.positionId,
      draftId: requestId,
      rollCount: Math.max(1, Number(position.rollCount) || 1),
      filmType: position.filmType || 'Не указан',
      actualThickness: position.actualThickness || intakeMicronLabel(position),
      accountingThickness: position.accountingThickness || 'Не указана',
      widthMm: Number(position.widthMm) || undefined,
      plannedLengthM: Number(position.plannedLengthM) || undefined,
      plannedWeightKg: Number(position.plannedWeightKg) || undefined,
      rawMaterialId: position.rawMaterialId || undefined,
      rawMaterialLabel: position.rawMaterial || 'Не указано',
      spoolType: position.spoolType || 'Не указана',
      birka: position.birka || 'Не указана',
      manualBirka: position.manualBirka || undefined,
      comment: position.comment || undefined,
      recipeSnapshot,
      warehouseCoverStatus: index === 0 ? 'partial_proposed' : 'full_proposed',
    };
  });
}

function coverProposalForPosition(position: CommercialOrderPosition, index: number): WarehouseCoverProposal {
  const isFull = index % 2 === 1;
  const coverQty = isFull ? position.rollCount : Math.max(1, Math.min(position.rollCount - 1, 2));
  return {
    id: `${position.id}-COVER`,
    positionId: position.id,
    matchedRolls: [
      {
        id: `WHR-${position.id}-01`,
        ownership: isFull ? 'reserved_for_order' : 'free_reserve',
        qty: coverQty,
        label: `${position.filmType}, ${position.actualThickness}, ${position.spoolType}`,
      },
    ],
    coverType: isFull ? 'full' : 'partial',
    coverQty,
    missingQty: Math.max(0, position.rollCount - coverQty),
    reserveQty: coverQty,
    productionQty: Math.max(0, position.rollCount - coverQty),
    warehouseCoverStatus: isFull ? 'full_proposed' : 'partial_proposed',
    requiresConfirmation: true,
    decision: 'pending',
  };
}

function paymentIndicatorForOrder(orderId: string, status: CommercialPaymentIndicator['paymentStatus']): CommercialPaymentIndicator {
  const severity: CommercialPaymentIndicator['severity'] = status === 'просрочка' ? 'critical' : status === 'не оплачен' || status === 'частично оплачен' ? 'warning' : 'info';
  return {
    orderId,
    paymentStatus: status,
    label: status.charAt(0).toUpperCase() + status.slice(1),
    severity,
    lastUpdatedAt: stampNow(),
    source: 'mock_1C',
    syncedAt: 'учётный снимок 08:40',
  };
}

function qrContextForOrder(order: CommercialOrderRequest, role: QRActionPanelContext['currentRole']): QRActionPanelContext {
  const firstPosition = order.positions[0];
  const qrCode = `QR-${order.id}-${firstPosition?.id ?? 'POS'}`;
  const allowedActionsByRole: Record<QRActionPanelContext['currentRole'], string[]> = {
    commercial: ['comment', 'attach', 'request_status_change'],
    production: ['comment', 'change_status', 'request_reprint'],
    finance: ['comment'],
    director: ['comment', 'change_status'],
    operator: ['comment', 'change_status'],
    warehouse: ['comment', 'attach', 'change_status', 'request_reprint'],
    admin: [],
  };
  const allowedActions = allowedActionsByRole[role];
  const blockedActions = role === 'commercial' || role === 'director'
    ? ['delete_roll', 'silent_reprint', 'request_reprint']
    : ['delete_roll', 'silent_reprint'];
  return {
    qrCode,
    rollId: `${firstPosition?.id ?? order.id}-ROLL-01`,
    orderId: order.id,
    positionId: firstPosition?.id ?? order.id,
    currentRole: role,
    allowedActions,
    blockedActions,
    state: allowedActions.length > 1 ? 'actions_available' : 'read_only',
  };
}

export const newTemplateFields: CounterpartyOrderTemplateField[] = [
  { label: 'Позиции', value: '', kind: 'production', required: true },
  { label: 'Тип пленки', value: '', kind: 'production', required: true },
  { label: 'Толщина', value: '', kind: 'production', required: true },
  { label: 'Ширина, мм', value: '', kind: 'production', required: true },
  { label: 'Метраж, м', value: '', kind: 'production', required: true },
  { label: 'Цвет', value: '', kind: 'production', required: true },
  { label: 'Рулоны', value: '', kind: 'production', required: true },
  { label: 'Сырье', value: '', kind: 'production', required: true },
  { label: 'Шпуля', value: '', kind: 'production', required: true },
  { label: 'Расходники', value: '', kind: 'production', required: true },
  { label: 'Условия', value: '', kind: 'money', required: true },
];

export function stampNow() {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date());
}

export function cloneWorkObjects(source: WorkObjectsByRole): WorkObjectsByRole {
  return roleOrder.reduce((acc, role) => {
    acc[role] = source[role].map((object) => ({
      ...object,
      facts: object.facts.map((fact) => ({ ...fact })),
      sections: object.sections.map((section) => ({ ...section, facts: section.facts.map((fact) => ({ ...fact })) })),
      actions: object.actions.map((action) => ({ ...action })),
      problems: object.problems.map((problem) => ({ ...problem })),
      productionProblems: object.productionProblems?.map((problem) => ({ ...problem })),
      commercialProductionProgress: object.commercialProductionProgress
        ? { ...object.commercialProductionProgress, activeProblemIds: [...object.commercialProductionProgress.activeProblemIds] }
        : undefined,
      orderResolutionCases: object.orderResolutionCases?.map((resolutionCase) => ({
        ...resolutionCase,
        affectedPositionIds: [...resolutionCase.affectedPositionIds],
        affectedRollIds: resolutionCase.affectedRollIds ? [...resolutionCase.affectedRollIds] : undefined,
        warehouseCoverResolution: resolutionCase.warehouseCoverResolution
          ? {
              ...resolutionCase.warehouseCoverResolution,
              proposalIds: [...resolutionCase.warehouseCoverResolution.proposalIds],
            }
          : undefined,
        recipeCorrectionRequest: resolutionCase.recipeCorrectionRequest
          ? {
              ...resolutionCase.recipeCorrectionRequest,
              notifiedRoles: [...resolutionCase.recipeCorrectionRequest.notifiedRoles],
            }
          : undefined,
      })),
      audit: object.audit.map((entry) => ({ ...entry })),
      newness: object.newness ? { ...object.newness } : undefined,
    }));
    return acc;
  }, {} as WorkObjectsByRole);
}

export function auditEntry(objectId: string, actorLabel: string, actionLabel: string, detail: string): AuditEntry {
  return {
    id: `a-${objectId}-${Date.now()}`,
    objectId,
    time: stampNow(),
    actorLabel,
    actionLabel,
    detail,
  };
}

export function auditEntryWithValues(
  objectId: string,
  actorLabel: string,
  actionLabel: string,
  detail: string,
  values: Pick<AuditEntry, 'reason' | 'oldValue' | 'newValue' | 'sourceSnapshot'> = {}
): AuditEntry {
  return {
    ...auditEntry(objectId, actorLabel, actionLabel, detail),
    ...values,
  };
}

export function roleTemplateName(roleTemplateId: string, templates: RoleTemplate[]) {
  return templates.find((template) => template.id === roleTemplateId)?.name ?? 'Шаблон роли';
}

export function accessStatusLabel(status: UserAccessEntry['status']) {
  if (status === 'blocked') return 'Отозван';
  return 'Доступ выдан';
}

export function createAdminAccessObject(entry: UserAccessEntry, templates: RoleTemplate[]): WorkObject {
  const templateName = roleTemplateName(entry.roleTemplateId, templates);
  const statusLabel = accessStatusLabel(entry.status);
  const severity: WorkObject['severity'] = entry.status === 'blocked' ? 'warning' : 'info';
  const extraCapabilities = entry.extraCapabilities ?? [];
  const extraCapabilitiesLabel = extraCapabilities.length > 0 ? extraCapabilities.join(', ') : 'Нет';

  return {
    id: `ADM-USERS-${entry.id}`,
    kind: 'adminEntity',
    title: entry.email,
    statusLabel,
    nextOwner: 'Админ',
    severity,
    filterTags: ['Доступы', entry.status === 'blocked' ? 'Требуют действия' : 'Завершены'],
    facts: [
      { label: 'Email', value: entry.email, scope: 'admin' },
      { label: 'Шаблон роли', value: templateName, scope: 'admin' },
      { label: 'Статус доступа', value: statusLabel, scope: 'admin' },
      { label: 'Индивидуальные права', value: extraCapabilitiesLabel, scope: 'admin' },
    ],
    sections: [
      {
        id: `${entry.id}-access`,
        title: 'Доступ пользователя',
        facts: [
          { label: 'Email', value: entry.email },
          { label: 'Шаблон роли', value: templateName },
          { label: 'Индивидуально', value: extraCapabilitiesLabel },
          { label: 'Назначил', value: entry.assignedBy },
        ],
      },
    ],
    actions: [
      { id: 'admin-save-user-role', label: 'Сохранить роль', level: 'recommended', enabled: true },
      { id: 'admin-block-user', label: 'Заблокировать...', level: 'destructive', enabled: true, confirmation: 'Нужна причина блокировки учетной записи' },
    ],
    problems: [],
    audit: [
      {
        id: `a-admin-access-${entry.id}`,
        objectId: `ADM-USERS-${entry.id}`,
        time: entry.assignedAt,
        actorLabel: entry.assignedBy,
        actionLabel: 'Роль назначена',
        detail: `${entry.email} получил шаблон ${templateName}.`,
      },
    ],
    workbench: {
      type: 'admin',
      entityType: 'access',
      prompt: 'Управление доступом по email без входа в производственную роль.',
      status: statusLabel,
      owner: 'Админ',
      now: entry.status === 'blocked' ? 'Доступ отозван, вход не разрешен.' : 'Доступ выдан по email и шаблону роли.',
      why: entry.status === 'blocked' ? 'Нужно решение владельца роли перед восстановлением доступа.' : 'Email и шаблон роли заданы.',
      after: 'После сохранения изменение попадет в историю доступа.',
      evidence: [
        { label: 'Назначил', value: entry.assignedBy, scope: 'admin' },
        { label: 'Время', value: entry.assignedAt, scope: 'admin' },
        { label: 'Шаблон', value: templateName, scope: 'admin' },
        { label: 'Индивидуально', value: extraCapabilitiesLabel, scope: 'admin' },
      ],
      lastSeen: entry.assignedAt,
      testResult: `Шаблон применен: ${templateName}`,
      checks: [
        { label: 'Email', value: entry.email, severity: 'info' },
        { label: 'Шаблон', value: templateName, severity: 'info' },
        { label: 'Статус', value: statusLabel, severity },
        { label: 'Индивидуально', value: extraCapabilitiesLabel, severity: 'info' },
      ],
      parsedRows: [
        { label: 'Система поняла', value: `Пользователь получает шаблон ${templateName}` },
        { label: 'Влияние', value: 'Видимость задается шаблоном роли, а не ручным списком полей' },
      ],
      rawCollapsedLabel: 'Диагностика и история',
      rawRows: [
        { label: 'email', value: entry.email, scope: 'rawDiagnostics' },
        { label: 'role_template_id', value: entry.roleTemplateId, scope: 'rawDiagnostics' },
        { label: 'status', value: entry.status, scope: 'rawDiagnostics' },
      ],
      nextEffect: 'После сохранения доступ применяется через шаблон роли в текущем прототипе.',
    },
  };
}

export function intakeIdSuffix() {
  return String(Math.floor(Date.now() % 100000)).padStart(5, '0');
}

export function modeStatus(mode: IntakeSubmitMode) {
  if (mode === 'draft') return { label: 'Черновик', severity: 'warning' as const, nextOwner: 'Коммерция' };
  return { label: 'Оформляется', severity: 'info' as const, nextOwner: 'Коммерция' };
}

export function commercialActions(statusLabel: string): ActionDescriptor[] {
  if (statusLabel === 'Черновик') {
    return [
      { id: 'commercial-edit-params', label: 'Заполнить параметры', level: 'recommended', enabled: true },
      { id: 'commercial-add-position', label: 'Добавить позицию', level: 'secondary', enabled: true },
      { id: 'commercial-save-draft', label: 'Сохранить черновик', level: 'secondary', enabled: true },
      { id: 'commercial-promote-draft', label: 'Оформить заявку', level: 'peer', enabled: true },
    ];
  }
  if (statusLabel === 'Оформляется') {
    return [
      { id: 'commercial-transfer-selected', label: 'Направить в бухгалтерию', level: 'recommended', enabled: true },
      { id: 'commercial-open-production', label: 'Статус производства', level: 'peer', enabled: true },
      { id: 'commercial-edit-params', label: 'Изменить параметры', level: 'secondary', enabled: true, helpText: 'Производство еще не стартовало; правка сохраняет прежнее и новое значение.' },
      { id: 'commercial-open-payment-shipment', label: 'Показать оплату и отгрузку', level: 'secondary', enabled: true, actionIntent: 'navigate' as const },
    ];
  }
  if (statusLabel === 'Передано' || statusLabel === 'В работе') {
    return [
      { id: 'commercial-open-production', label: 'Статус производства', level: 'recommended', enabled: true, actionIntent: 'inspect' as const },
      { id: 'commercial-request-correction', label: 'Запросить изменение параметров...', level: 'peer', enabled: true, confirmation: 'Нужна причина изменения; прямое редактирование закрыто после передачи' },
      { id: 'commercial-open-payment-shipment', label: 'Показать оплату и отгрузку', level: 'secondary', enabled: true, actionIntent: 'navigate' as const },
      {
        id: 'commercial-edit-params',
        label: 'Изменить параметры напрямую',
        level: 'disabled',
        enabled: false,
        disabledReason: 'Заявка уже передана в производственный контур',
        recoveryAction: 'Запросить изменение с причиной',
        recoveryOwner: 'Коммерция',
      },
    ];
  }
  return [
    {
      id: 'commercial-reorder-blocked',
      label: 'Изменить порядок',
      level: 'disabled',
      enabled: false,
      disabledReason: 'Нельзя менять порядок после передачи/закрытия',
      recoveryAction: 'Менять очередь можно до передачи в заказ-наряд',
      recoveryOwner: 'Коммерция',
    },
  ];
}

export function createCommercialObject(
  form: IntakeDraftForm,
  mode: IntakeSubmitMode,
  creatorRole: CommercialOrderRequest['creatorRole'] = 'commercial'
): WorkObject {
  const id = `З-${intakeIdSuffix()}`;
  const status = modeStatus(mode);
  const actorLabel = creatorRole === 'production_lead' ? 'Зав. производства' : 'Коммерция';
  const actionLabel = mode === 'draft' ? 'Заявка сохранена' : 'Заявка создана';
  const counterparty = intakeCounterpartyLabel(form) || 'Контрагент не выбран';
  const billingSnapshot = intakeCounterpartyBillingSnapshot(form, actorLabel);
  const counterpartyLegalFacts = intakeCounterpartyLegalFacts(form);
  const positions = intakePositionSummary(form);
  const rollGroups = intakeRollGroups(form);
  const complete = intakeDraftIsComplete(form);
  const incompleteReason = intakeIncompletePositionReason(form);
  const commercialPositionList = commercialPositions(form, id, actorLabel);
  const warehouseCoverProposals = commercialPositionList.map(coverProposalForPosition);
  const totalMissingQty = warehouseCoverProposals.reduce((sum, proposal) => sum + proposal.missingQty, 0);
  const warehouseCoverStatus: CommercialOrderRequest['warehouseCoverStatus'] = warehouseCoverProposals.some((proposal) => proposal.coverType === 'partial')
    ? 'partial_proposed'
    : 'full_proposed';
  const paymentStatus: CommercialPaymentIndicator['paymentStatus'] = creatorRole === 'production_lead' ? 'не оплачен' : 'частично оплачен';
  const commercialConfirmationPolicy: CommercialOrderRequest['commercialConfirmationPolicy'] = creatorRole === 'production_lead'
    ? 'required'
    : undefined;
  const commercialOrder: CommercialOrderRequest = {
    id,
    createdBy: actorLabel,
    creatorRole,
    counterpartyId: billingSnapshot.counterpartyId,
    billingSnapshot,
    requestType: 'клиентский заказ',
    status: mode === 'draft' ? 'draft' : 'in_work',
    productionStatus: totalMissingQty > 0 ? 'needs_production' : 'not_started',
    warehouseCoverStatus,
    paymentStatus,
    shipmentStatus: 'не отгружено',
    createdAt: stampNow(),
    submittedAt: mode === 'draft' ? undefined : stampNow(),
    assignedOperatorId: creatorRole === 'production_lead' ? form.assignedOperatorId : undefined,
    priority: creatorRole === 'production_lead' ? form.priority : undefined,
    commercialConfirmationPolicy,
    commercialConfirmationReason: creatorRole === 'production_lead'
      ? 'Заявка создана зав. производства без явного поручения коммерции.'
      : undefined,
    requiresCommercialRecipeConfirmation: commercialConfirmationPolicy === 'required',
    positions: commercialPositionList,
  };
  const paymentIndicator = paymentIndicatorForOrder(id, paymentStatus);
  const qrActionPanelContext = qrContextForOrder(commercialOrder, 'commercial');
  const actions = [
    ...(creatorRole === 'production_lead' && mode !== 'draft'
      ? [{ id: 'commercial-confirm-production-lead-recipe', label: 'Подтвердить рецептуру', level: 'recommended' as const, enabled: true }]
      : []),
    ...commercialActions(status.label),
  ].map((action) => {
    if (status.label !== 'Черновик') return action;
    if (complete && action.id === 'commercial-promote-draft') {
      return { ...action, level: 'recommended' as const, enabled: true };
    }
    if (complete && action.id === 'commercial-edit-params') {
      return { ...action, label: 'Изменить параметры', level: 'peer' as const, enabled: true };
    }
    if (!complete && action.id === 'commercial-promote-draft') {
      return {
        ...action,
        level: 'disabled' as const,
        enabled: false,
        disabledReason: incompleteReason || 'Заполните обязательные параметры позиции',
        recoveryOwner: 'Коммерция',
        recoveryAction: incompleteReason || 'Заполнить обязательные параметры позиции',
      };
    }
    return action;
  });
  const detail = mode === 'draft'
    ? 'Черновик остался в коммерции.'
    : creatorRole === 'production_lead'
      ? 'Зав. производства создал заявку с оператором и приоритетом; рецептура остается за коммерцией.'
      : 'Коммерция создала заявку с позициями, складским покрытием и недостающей частью для производства.';

  return {
    id,
    kind: 'intake',
    title: `${id} · ${counterparty}`,
    statusLabel: status.label,
    nextOwner: status.nextOwner,
    severity: complete ? status.severity : 'warning',
    filterTags: mode === 'draft'
      ? ['Входящие заявки', 'Черновики', status.label]
      : ['Входящие заявки', status.label],
    facts: [
      { label: 'Создатель заявки', value: commercialOrder.creatorRole === 'production_lead' ? 'Зав. производства' : 'Коммерция', scope: 'rawDiagnostics' },
      { label: 'Владелец рецептуры', value: 'Коммерция', scope: 'rawDiagnostics' },
      ...(commercialOrder.commercialConfirmationPolicy ? [{ label: 'commercialConfirmationPolicy', value: commercialOrder.commercialConfirmationPolicy, scope: 'rawDiagnostics' as const }] : []),
      { label: 'Контрагент', value: counterparty, scope: 'commercial' },
      ...counterpartyLegalFacts,
      { label: 'Billing snapshot', value: billingSnapshot.id, scope: 'rawDiagnostics' },
      { label: 'Позиции', value: positions, scope: 'commercial' },
      { label: 'Всего рулонов', value: String(intakeTotalRollCount(form)), scope: 'commercial' },
      { label: 'Характеристики', value: intakeCharacteristicLabel(form), scope: 'commercial' },
      { label: 'Сырье', value: intakeRawMaterialSummary(form), scope: 'commercial' },
      { label: 'Шаблон', value: form.template, scope: 'commercial' },
      { label: 'Комментарий', value: form.comment || 'Без комментария', scope: 'commercial' },
      { label: 'Производство', value: totalMissingQty > 0 ? `${totalMissingQty} рул. в производство` : 'Не требуется после склада', scope: 'commercial' },
      { label: 'Склад', value: warehouseCoverStatus === 'partial_proposed' ? 'Частично есть на складе' : 'Закрыто складом', scope: 'commercial' },
      { label: 'Оплата', value: paymentIndicator.label, scope: 'commercial' },
      { label: 'Отгрузка', value: commercialOrder.shipmentStatus, scope: 'commercial' },
      { label: 'Корзина заказа', value: mode === 'draft' ? 'Черновик сохранен' : 'Заявка оформляется', scope: 'commercial' },
      ...(creatorRole === 'production_lead'
        ? [
            { label: 'Приоритет', value: form.priority, scope: 'production' as const },
            { label: 'assignedOperatorId', value: form.assignedOperatorId, scope: 'rawDiagnostics' as const },
          ]
        : []),
    ],
    sections: [
      {
        id: `${id}-indicators`,
        title: 'Индикаторы заявки',
        facts: [
          { label: 'Производство', value: totalMissingQty > 0 ? `${totalMissingQty} рул. уйдет в производство` : 'Закрыто складским предложением', scope: 'commercial' },
          { label: 'Склад', value: warehouseCoverStatus === 'partial_proposed' ? 'Частично есть на складе' : 'Закрыто складом', scope: 'commercial' },
          { label: 'Оплата', value: paymentIndicator.label, scope: 'commercial' },
          { label: 'Отгрузка', value: commercialOrder.shipmentStatus, scope: 'commercial' },
        ],
      },
      {
        id: `${id}-client`,
        title: 'Заявка клиента',
        facts: [
          { label: 'Контрагент', value: counterparty, scope: 'commercial' },
          ...counterpartyLegalFacts,
          { label: 'Позиции', value: positions, scope: 'commercial' },
          ...intakePositionDetailFacts(form, 'commercial'),
          { label: 'Комментарий', value: form.comment || 'Без комментария', scope: 'commercial' },
        ],
      },
      ...commercialPositionList.map((position, index) => ({
        id: `${position.id}-full-card`,
        title: `Позиция ${index + 1}`,
        facts: [
          { label: 'Бирка', value: [position.birka, position.manualBirka].filter(Boolean).join(' / '), scope: 'commercial' as const },
          { label: 'Фактическая толщина', value: position.actualThickness, scope: 'commercial' as const },
          { label: 'Бухгалтерская толщина', value: position.accountingThickness, scope: 'commercial' as const },
          { label: 'Шпуля', value: position.spoolType, scope: 'commercial' as const },
          { label: 'Сырье', value: position.rawMaterialLabel, scope: 'commercial' as const },
          { label: 'Рецептура', value: position.recipeSnapshot.parameters.map((item) => `${item.label}: ${item.value}`).join('; '), scope: 'commercial' as const },
          { label: 'Комментарий позиции', value: position.comment ?? 'Без комментария', scope: 'commercial' as const },
        ],
      })),
      {
        id: `${id}-warehouse-cover`,
        title: 'Складское покрытие',
        facts: warehouseCoverProposals.flatMap((proposal, index) => [
          { label: `Позиция ${index + 1}`, value: proposal.coverType === 'full' ? 'Закрыто складом' : 'Частично есть на складе', scope: 'commercial' as const },
          { label: `Недостающая часть ${index + 1}`, value: proposal.missingQty > 0 ? `${proposal.missingQty} рул. в производство` : 'Нет', scope: 'commercial' as const },
        ]),
      },
      {
        id: `${id}-handover`,
        title: 'Производственный маршрут',
        facts: [
          { label: 'Кто получит', value: 'Зав. производства', scope: 'commercial' },
          { label: 'Действие', value: mode === 'draft' ? 'Создать заявку после заполнения карточки' : 'Оформить недостающую часть в заказ-наряд', scope: 'common' },
        ],
      },
    ],
    actions,
    problems: [],
    audit: [
      auditEntry(id, actorLabel, 'audit:commercial_order_draft_created', detail),
      ...(form.counterparty === '__new__'
        ? [auditEntryWithValues(id, actorLabel, 'audit:counterparty_created_from_order', `${counterparty} создан из поля клиента в заявке.`, {
            newValue: counterparty,
            sourceSnapshot: billingSnapshot.id,
          })]
        : []),
      auditEntryWithValues(id, actorLabel, 'audit:counterparty_billing_snapshot_set', `Снимок реквизитов закреплен за заявкой: ${billingSnapshot.label}.`, {
        newValue: billingSnapshotSourceLabel(billingSnapshot.source),
        sourceSnapshot: billingSnapshot.id,
      }),
      auditEntryWithValues(id, actorLabel, 'audit:counterparty_attached_to_order', `${counterparty} подставлен в заявку ${id}.`, {
        newValue: counterparty,
        sourceSnapshot: billingSnapshot.id,
      }),
      ...commercialPositionList.map((position, index) => auditEntry(position.id, actorLabel, 'audit:commercial_order_position_added', `Позиция ${index + 1}: ${position.rollCount} рул., ${position.actualThickness}, ${position.spoolType}.`)),
      ...commercialPositionList.map((position) => auditEntry(position.id, actorLabel, 'audit:commercial_recipe_snapshot_set', `Снимок рецептуры ${position.recipeSnapshot.version}: рецептуру ведет коммерция.`)),
      ...warehouseCoverProposals.map((proposal) => auditEntry(proposal.id, 'Система', 'audit:warehouse_cover_proposed', `Предложено покрытие ${proposal.coverQty} рул.; недостача ${proposal.missingQty} рул.`)),
      auditEntry(id, 'Бухгалтерия', 'audit:payment_status_updated', `Статус оплаты: ${paymentIndicator.label}.`),
      auditEntry(id, actorLabel, actionLabel, detail),
    ],
    rollGroups,
    commercialOrder,
    warehouseCoverProposals,
    paymentIndicator,
    qrActionPanelContext,
    newness: {
      recipientRole: 'commercial',
      createdAt: stampNow(),
      highlightUntil: 'текущая сессия',
      firstSeenAt: stampNow(),
    },
  };
}

export function productionFromIntake(intake: WorkObject, state: 'waiting' | 'incomplete'): WorkObject {
  const id = `ЗН-${intake.id.replace(/^З-/, '')}`;
  const isWaiting = state === 'waiting';
  const counterparty = factValue(intake, 'Контрагент') ?? 'Контрагент не выбран';
  const positions = factValue(intake, 'Позиции') ?? 'Позиции не заполнены';
  const template = factValue(intake, 'Шаблон') ?? 'Шаблон не выбран';
  const positionFacts = intake.sections
    .flatMap((section) => section.facts)
    .filter((fact) => fact.label.startsWith('Позиция '))
    .map((fact) => ({ ...fact, scope: 'production' as const }));
  const sleeves = Array.from(new Set(intake.rollGroups?.map((group) => group.sleeve).filter(Boolean) ?? []));
  const sleeveSummary = sleeves.length > 0 ? sleeves.join(', ') : 'По позициям';
  const createdByProductionLead = intake.commercialOrder?.creatorRole === 'production_lead';
  const requiresCommercialRecipeConfirmation =
    intake.commercialOrder?.commercialConfirmationPolicy === 'required'
    && Boolean(intake.commercialOrder?.requiresCommercialRecipeConfirmation);
  const statusLabel = isWaiting ? 'Ждет заказ-наряд' : 'Неполный заказ-наряд';
  const primaryAction = isWaiting
    ? { id: `production-form-order:${intake.id}`, label: 'Сформировать заказ-наряд', level: 'recommended' as const, enabled: true }
    : requiresCommercialRecipeConfirmation
      ? {
          id: `production-approve-order:${intake.id}`,
          label: 'Согласовать заказ-наряд',
          level: 'disabled' as const,
          enabled: false,
          disabledReason: 'Коммерция должна подтвердить рецептуру',
          recoveryOwner: 'Коммерция',
          recoveryAction: 'Подтвердить рецептуру в коммерческой заявке',
        }
      : { id: `production-approve-order:${intake.id}`, label: 'Согласовать заказ-наряд', level: 'recommended' as const, enabled: true };
  const productionLeadRequest: ProductionLeadCreatedRequest | undefined = createdByProductionLead && intake.commercialOrder
    ? {
        id: intake.commercialOrder.id,
        createdBy: intake.commercialOrder.createdBy,
        creatorRole: 'production_lead',
        createdOnBehalfOfRole: intake.commercialOrder.createdOnBehalfOfRole,
        createdOnBehalfOfUserId: intake.commercialOrder.createdOnBehalfOfUserId,
        commercialDelegationConfirmed: intake.commercialOrder.commercialDelegationConfirmed,
        commercialConfirmationPolicy: intake.commercialOrder.commercialConfirmationPolicy ?? 'required',
        commercialConfirmationReason: intake.commercialOrder.commercialConfirmationReason,
        counterpartyId: intake.commercialOrder.counterpartyId,
        requestType: intake.commercialOrder.requestType,
        positions: intake.commercialOrder.positions,
        assignedOperatorId: intake.commercialOrder.assignedOperatorId,
        priority: intake.commercialOrder.priority ?? 'обычный',
        recipeOwnerRole: 'commercial',
        createdAt: intake.commercialOrder.createdAt,
      }
    : undefined;
  const assignedOperator = operatorById(productionLeadRequest?.assignedOperatorId);
  const defaultOperator = operatorById('operator-line-a');
  const assignedOperatorName = assignedOperator?.name ?? (isWaiting ? 'Назначить при оформлении' : defaultOperator?.name ?? 'Сергей Волков');
  const assignedWorkplace = assignedOperator?.workplace ?? (isWaiting ? 'Назначить при оформлении' : defaultOperator?.workplace ?? 'Экструдер E-04');

  return {
    id,
    kind: 'productionOrder',
    title: `${id} · ${counterparty}`,
    statusLabel,
    nextOwner: 'Зав. производства',
    severity: 'warning',
    filterTags: ['Очередь заказ-нарядов', statusLabel, 'Неполные'],
    facts: [
      { label: 'Контрагент', value: counterparty, scope: 'production' },
      { label: 'Позиции', value: positions, scope: 'production' },
      { label: 'Шаблон', value: template, scope: 'production' },
      { label: 'Характеристики', value: factValue(intake, 'Характеристики') ?? 'Разные по позициям', scope: 'production' },
      { label: 'Рулоны', value: positions, scope: 'production' },
      { label: 'Сырье', value: factValue(intake, 'Сырье') ?? 'По позициям', scope: 'production' },
      { label: 'Втулки', value: sleeveSummary, scope: 'production' },
      { label: 'Рабочее место', value: assignedWorkplace, scope: 'production' },
      { label: 'Ответственный', value: assignedOperatorName, scope: 'production' },
      { label: 'Приоритет', value: productionLeadRequest?.priority ?? 'обычный', scope: 'production' },
      { label: 'Создатель заявки', value: intake.commercialOrder?.creatorRole === 'production_lead' ? 'Зав. производства' : 'Коммерция', scope: 'rawDiagnostics' },
      { label: 'Владелец рецептуры', value: 'Коммерция', scope: 'rawDiagnostics' },
      ...(intake.commercialOrder?.commercialConfirmationPolicy ? [{ label: 'commercialConfirmationPolicy', value: intake.commercialOrder.commercialConfirmationPolicy, scope: 'rawDiagnostics' as const }] : []),
      { label: 'Директор', value: 'Не требуется без отличий', scope: 'director' },
    ],
    sections: [
      {
        id: `${id}-source`,
        title: createdByProductionLead ? 'Заявка зав. производства' : 'Заявка от коммерции',
        facts: [
          { label: 'Пришла от', value: createdByProductionLead ? 'Зав. производства' : 'Олег / Коммерция', scope: 'production' },
          { label: 'Действие', value: isWaiting ? 'Сформировать заказ-наряд до счета' : 'Дозаполнить и согласовать заказ-наряд', scope: 'production' },
          { label: 'Владелец рецептуры', value: 'Коммерция', scope: 'production' },
          { label: 'Оператор', value: assignedOperatorName, scope: 'production' },
          { label: 'Приоритет', value: productionLeadRequest?.priority ?? 'обычный', scope: 'production' },
          { label: 'Позиции', value: positions, scope: 'production' },
          ...positionFacts,
        ],
      },
    ],
    actions: [
      primaryAction,
      { id: `production-assign-operator:${intake.id}`, label: 'Назначить оператора...', level: 'secondary', enabled: true },
      { id: `production-save-draft:${intake.id}`, label: 'Сохранить черновик', level: 'secondary', enabled: true },
      { id: `production-reorder-note:${intake.id}`, label: 'Изменить порядок очереди', level: 'secondary', enabled: true },
      { id: `production-create-problem:${intake.id}`, label: 'Сообщить проблему коммерции...', level: 'destructive', enabled: true, confirmation: 'Нужна причина проблемы для коммерции' },
    ],
    problems: [],
    audit: [
      ...(createdByProductionLead ? [auditEntry(id, 'Зав. производства', 'audit:production_lead_request_created', 'Создана заявка с назначением оператора и приоритетом; рецептуру ведет коммерция.')] : []),
      auditEntry(id, createdByProductionLead ? 'Зав. производства' : 'Коммерция', 'Заявка создана', 'Строка создана у зав. производства; счет в этом сценарии не редактируется.'),
    ],
    rollGroups: intake.rollGroups?.map((group) => ({
      ...group,
      status: isWaiting ? 'Ждет формирования заказ-наряда' : 'Ждет производственного оформления',
      machine: isWaiting ? 'Назначить' : group.machine,
      owner: 'Зав. производства',
    })),
    commercialOrder: intake.commercialOrder,
    newness: {
      recipientRole: 'production',
      createdAt: stampNow(),
      highlightUntil: 'текущая сессия',
    },
  };
}

export function financeFromProduction(order: WorkObject): WorkObject {
  const id = `FIN-${order.id.replace(/^ЗН-/, '')}`;
  const counterparty = factValue(order, 'Контрагент') ?? 'Контрагент';
  const positions = factValue(order, 'Позиции') ?? factValue(order, 'Рулоны') ?? 'Позиции';
  const positionFacts = order.sections
    .flatMap((section) => section.facts)
    .filter((fact) => fact.label.startsWith('Позиция '))
    .map((fact) => ({ ...fact, scope: 'finance' as const }));

  return {
    id,
    kind: 'financeOrder',
    title: `${id} · ${counterparty}`,
    statusLabel: 'Ждет счет',
    nextOwner: 'Бухгалтерия',
    severity: 'info',
    filterTags: ['Финансовые действия', 'Ждет счет'],
    facts: [
      { label: 'Контрагент', value: counterparty, scope: 'finance' },
      { label: 'Позиции', value: positions, scope: 'finance' },
      { label: 'Характеристики', value: factValue(order, 'Характеристики') ?? 'Разные по позициям', scope: 'finance' },
      { label: 'Заказ-наряд', value: 'Согласован', scope: 'finance' },
      { label: 'Статус счета', value: 'Не выставлен', scope: 'finance' },
      { label: 'Статус оплаты', value: 'Ждет счет', scope: 'finance' },
      { label: 'Сумма', value: 'нет данных', scope: 'finance' },
      { label: 'Оплачено', value: '0 ₽', scope: 'finance' },
      { label: 'Остаток', value: 'нет данных', scope: 'finance' },
      { label: 'Следующий платеж', value: 'нет данных', scope: 'finance' },
      { label: 'Дата отгрузки', value: 'нет данных', scope: 'finance' },
      { label: 'Вид оплаты', value: 'уточнить из источника', scope: 'finance' },
      { label: 'Рассрочка', value: 'Старт после закрытой выдачи', scope: 'finance' },
      { label: 'График', value: 'Не создан до закрытой выдачи', scope: 'finance' },
      { label: 'Источник данных', value: 'Согласованный заказ-наряд', scope: 'finance' },
    ],
    sections: [
      {
        id: `${id}-invoice`,
        title: 'Основание для счета',
        facts: [
          { label: 'Заказ-наряд', value: order.id, scope: 'finance' },
          { label: 'Позиции', value: positions, scope: 'finance' },
          ...positionFacts,
          { label: 'Создание документа', value: 'Статус счета изменится после действия бухгалтерии', scope: 'finance' },
          { label: 'Действие', value: 'Выставить счет', scope: 'finance' },
        ],
      },
    ],
    actions: [
      { id: `finance-create-invoice:${order.id}`, label: 'Выставить счет', level: 'recommended', enabled: true },
      { id: `finance-history:${order.id}`, label: 'Открыть историю', level: 'secondary', enabled: true },
    ],
    problems: [],
    audit: [auditEntry(id, 'Зав. производства', 'Заказ-наряд согласован', 'Бухгалтерия получила строку Ждет счет после согласования производственной части.')],
    newness: {
      recipientRole: 'finance',
      createdAt: stampNow(),
      highlightUntil: 'текущая сессия',
    },
  };
}

export function updateFactList(facts: Fact[], updates: Record<string, string>, scope: Fact['scope'] = 'finance') {
  const seen = new Set<string>();
  const next = facts.map((fact) => {
    if (!(fact.label in updates)) return fact;
    seen.add(fact.label);
    return { ...fact, value: updates[fact.label] };
  });
  Object.entries(updates).forEach(([label, value]) => {
    if (!seen.has(label)) next.push({ label, value, scope });
  });
  return next;
}

export function updateFinanceSections(object: WorkObject, updates: Record<string, string>) {
  return object.sections.map((section) => ({
    ...section,
    facts: updateFactList(section.facts, updates, 'finance'),
  }));
}

export function financeInvoiceIssuedActions(objectId: string): ActionDescriptor[] {
  return [
    { id: `finance-check-payment:${objectId}`, label: 'Проверить оплату', level: 'recommended', enabled: true, helpText: 'Проверяет, есть ли поступление по счету, и не закрывает оплату автоматически.' },
    { id: `finance-update-payment:${objectId}`, label: 'Обновить оплату вручную', level: 'secondary', enabled: true, confirmation: 'Нужны сумма, дата, источник и причина ручного изменения оплаты' },
    { id: `finance-retry-sync:${objectId}`, label: 'Повторить проверку источника', level: 'secondary', enabled: true },
    { id: `finance-history:${objectId}`, label: 'Открыть историю', level: 'secondary', enabled: true },
  ];
}

export function financePaidActions(objectId: string): ActionDescriptor[] {
  return [
    {
      id: `finance-history:${objectId}`,
      label: 'Открыть историю закрытия',
      level: 'recommended',
      enabled: true,
      helpText: 'Оплата закрыта: доступна только история и источник последнего события.',
    },
  ];
}

export function reduceFinanceObject(object: WorkObject, actionId: string): WorkObject {
  const actionKind = getFinanceActionKind(actionId);

  if (actionKind === 'issueInvoice') {
    const isPaymentDueToday = object.statusLabel === 'К оплате' || object.statusLabel === 'Оплата сегодня';
    const nextStatusLabel = isPaymentDueToday ? 'Счет к оплате отправлен' : 'Счет отправлен';
    const oldInvoiceStatus = factValue(object, 'Статус счета') ?? 'Не выставлен';
    const updates: Record<string, string> = {
      'Статус счета': nextStatusLabel,
      'Статус оплаты': isPaymentDueToday ? 'Ожидает плановую оплату' : 'Ожидает оплаты',
      'Источник данных': isPaymentDueToday ? 'график платежа · счет отправлен' : 'учётный снимок: счет отправлен',
    };
    if (isPaymentDueToday) updates['Уведомление'] = 'Закрыто действием бухгалтерии';
    if (isPaymentDueToday) updates['Следующее действие'] = 'Проверить поступление по графику';
    const nextFilterTags = isPaymentDueToday
      ? Array.from(new Set([...(object.filterTags ?? []).filter((tag) => tag !== 'Оплата сегодня' && tag !== 'Требуют действия'), 'Оплаты', 'Счет к оплате отправлен']))
      : Array.from(new Set([...(object.filterTags ?? []), 'Оплаты', 'Счет выставлен']));
    const nextSections = updateFinanceSections(object, updates).map((section) =>
      isPaymentDueToday && section.id === 'finance-payment-due-today'
        ? { ...section, title: 'Плановая оплата' }
        : section
    );
    return {
      ...object,
      statusLabel: nextStatusLabel,
      nextOwner: 'Бухгалтерия',
      severity: 'info',
      filterTags: nextFilterTags,
      facts: updateFactList(object.facts, updates, 'sensitiveFinance'),
      sections: nextSections,
      actions: financeInvoiceIssuedActions(object.id),
      paymentSchedule: object.paymentSchedule
        ? { ...object.paymentSchedule, invoiceReminderStatus: 'closed' }
        : undefined,
      audit: [
        auditEntryWithValues(
          object.id,
          'Бухгалтерия',
          'audit:invoice_status_updated',
          isPaymentDueToday
            ? 'Плановое уведомление закрыто действием бухгалтерии; счет отправлен к оплате.'
            : 'Статус счета обновлен действием бухгалтерии; внешний документ не обещается.',
          {
            reason: 'Согласованный заказ-наряд готов к счету',
            oldValue: oldInvoiceStatus,
            newValue: nextStatusLabel,
            sourceSnapshot: 'счет отправлен действием бухгалтерии',
          }
        ),
        ...object.audit,
      ],
    };
  }

  if (actionKind === 'updatePayment') {
    const oldPaymentStatus = factValue(object, 'Статус оплаты') ?? object.statusLabel;
    const shouldRemainPartial = /частич|просроч/i.test(`${object.statusLabel} ${oldPaymentStatus}`);
    const nextStatusLabel = shouldRemainPartial ? 'Частично оплачен' : 'Оплачено';
    const partialPaid = object.id === 'FIN-2606-021' ? '210 000 ₽' : factValue(object, 'Оплачено') ?? 'часть суммы';
    const partialRemaining = object.id === 'FIN-2606-021' ? '210 000 ₽' : factValue(object, 'Остаток') ?? 'остаток открыт';
    const updates: Record<string, string> = shouldRemainPartial
      ? {
          'Статус оплаты': 'Частично оплачен',
          'Оплачено': partialPaid,
          'Остаток': partialRemaining,
          'Следующий платеж': partialRemaining,
          'Следующее действие': 'Проверить поступление и контролировать остаток',
          'Рассрочка': 'Остаток открыт',
          'Уведомление': 'Просрочка снята частичной оплатой',
          'Источник данных': 'ручная проверка бухгалтерии',
        }
      : {
          'Статус оплаты': 'Оплачено',
          'Оплачено': factValue(object, 'Сумма') ?? factValue(object, 'Остаток') ?? 'полная сумма',
          'Остаток': '0 ₽',
          'Следующий платеж': 'нет',
          'Следующее действие': 'Оплата закрыта ручной отметкой',
          'Рассрочка': 'Закрыта',
          'Уведомление': 'Закрыто после оплаты',
          'Источник данных': 'ручная проверка бухгалтерии',
        };
    const nextActions = financePaidActions(object.id);
    const nextProblems = shouldRemainPartial
      ? object.problems.map((problem) => ({ ...problem, status: 'resolved' as const, recovery: 'Частичная оплата записана; остаток контролирует бухгалтерия' }))
      : object.problems.map((problem) => ({ ...problem, status: 'resolved' as const, recovery: 'Платеж подтвержден и записан в историю' }));
    return {
      ...object,
      statusLabel: nextStatusLabel,
      nextOwner: shouldRemainPartial ? 'Бухгалтерия' : 'Завершено',
      severity: shouldRemainPartial ? 'warning' : 'info',
      filterTags: shouldRemainPartial
        ? Array.from(new Set([...(object.filterTags ?? []).filter((tag) => tag !== 'Оплата сегодня' && tag !== 'Просрочка'), 'Оплаты', 'Частичная оплата', 'Требуют действия']))
        : Array.from(new Set([...(object.filterTags ?? []).filter((tag) => tag !== 'Оплата сегодня' && tag !== 'Требуют действия'), 'Оплаты', 'Завершены'])),
      facts: updateFactList(object.facts, updates, 'sensitiveFinance'),
      sections: updateFinanceSections(object, updates).map((section) =>
        section.id === 'finance-payment-due-today'
          ? { ...section, title: 'Плановая оплата закрыта' }
          : section
      ),
      actions: nextActions,
      problems: nextProblems,
      paymentSchedule: object.paymentSchedule
        ? { ...object.paymentSchedule, status: shouldRemainPartial ? 'scheduled' : 'paid', invoiceReminderStatus: 'closed' }
        : undefined,
      audit: [
        auditEntryWithValues(
          object.id,
          'Бухгалтерия',
          'audit:payment_status_updated',
          'Платежный статус обновлен; директорский денежный риск закрывается из финансового источника.',
          {
            reason: 'Обновление оплаты из финансового источника',
            oldValue: oldPaymentStatus,
            newValue: shouldRemainPartial ? 'частично оплачен' : 'оплачен',
            sourceSnapshot: 'ручная проверка бухгалтерии',
          }
        ),
        ...object.audit,
      ],
    };
  }

  if (actionKind === 'retrySync') {
    const updates = {
      'Статус счета': factValue(object, 'Статус счета')?.includes('Не подтвержден') ? 'Не выставлен' : factValue(object, 'Статус счета') ?? 'Не выставлен',
      'Статус оплаты': factValue(object, 'Статус оплаты')?.includes('Не обновлен') ? 'Ждет счет' : factValue(object, 'Статус оплаты') ?? 'Ждет счет',
      'Источник данных': 'ручная проверка источника оплаты',
    };
    const isSourceError = object.statusLabel === 'Ошибка источника' || object.statusLabel === 'Ошибка синхронизации';
    return {
      ...object,
      statusLabel: isSourceError ? 'Ждет счет' : object.statusLabel,
      severity: isSourceError ? 'info' : object.severity,
      filterTags: Array.from(new Set([...(object.filterTags ?? []), 'Синхронизация'])),
      facts: updateFactList(object.facts, updates, 'finance'),
      sections: updateFinanceSections(object, updates),
      actions: isSourceError
        ? [
            { id: `finance-create-invoice:${object.id}`, label: 'Выставить счет', level: 'recommended', enabled: true },
            { id: `finance-history:${object.id}`, label: 'Открыть историю', level: 'secondary', enabled: true },
          ]
        : object.actions,
      problems: isSourceError ? object.problems.map((problem) => ({ ...problem, status: 'resolved' as const, recovery: 'Источник повторно проверен; предыдущая ошибка сохранена в истории' })) : object.problems,
      audit: [
        auditEntryWithValues(object.id, 'Бухгалтерия', 'audit:sync_retry_requested', 'Запрошена повторная проверка источника; предыдущая ошибка остается в истории.', {
          reason: 'Повторная проверка источника запрошена бухгалтерией',
          oldValue: isSourceError ? 'Ошибка источника' : object.statusLabel,
          newValue: isSourceError ? 'источник проверен' : 'проверка источника записана',
          sourceSnapshot: 'ручная проверка источника оплаты',
        }),
        ...object.audit,
      ],
    };
  }

  if (actionKind === 'createProblem') {
    const problem: ProblemCase = {
      id: `p-${object.id}-${Date.now()}`,
      objectId: object.id,
      stage: 'Финансовый контур',
      title: 'Требуется ручной разбор',
      severity: 'warning',
      ownerRole: 'Бухгалтерия',
      due: 'сегодня',
      reason: 'Бухгалтерия создала проблему из финансового действия.',
      recovery: 'Назначить владельца и записать решение в историю',
      status: 'open',
    };
    return {
      ...object,
      severity: object.severity === 'critical' ? 'critical' : 'warning',
      filterTags: Array.from(new Set([...(object.filterTags ?? []), 'С проблемами', 'Требуют действия'])),
      problems: [problem, ...object.problems],
      audit: [
        auditEntryWithValues(object.id, 'Бухгалтерия', (object.statusLabel === 'Ошибка источника' || object.statusLabel === 'Ошибка синхронизации') ? 'problem:payment_sync_error' : 'problem:payment_overdue', problem.reason, {
          reason: 'Проблема создана из финансового действия',
          newValue: problem.title,
        }),
        ...object.audit,
      ],
    };
  }

  return object;
}
