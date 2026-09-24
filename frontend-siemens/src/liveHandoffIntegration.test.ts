import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const warehouseActivePalletSource = readFileSync(
  new URL('./components/workbenches/WarehouseActivePalletPanel.tsx', import.meta.url),
  'utf8',
);

function sourceBetween(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Source markers not found: ${start} -> ${end}`);
  return source.slice(from, to);
}

describe('live handoff integration policy', () => {
  it('blocks initial loading or failure but keeps a previously ready stale workspace mounted', () => {
    const liveRefresh = sourceBetween(
      '  useEffect(() => {\n    const controller = liveRefreshControllerRef.current;',
      '  // HID-сканер = клавиатурный ввод',
    );
    const availability = sourceBetween(
      '  const activeLiveRoleLoadState =',
      '  function pendingInboxReads',
    );
    const workspace = sourceBetween('      <main', '      {isIntakeDrawerOpen && (');

    expect(source).toContain('liveRoleLoadStateByRole');
    expect(source).toContain("type LiveRoleLoadState = 'loading' | 'ready' | 'stale' | 'failed'");
    expect(liveRefresh).toContain("current[role] === 'ready'");
    expect(liveRefresh).toContain("{ ...current, [role]: 'ready' }");
    expect(liveRefresh).toContain('clearFailedLiveRole(role)');
    expect(liveRefresh).toContain(
      'liveRoleLoadStateAfterError(liveSnapshotLoadedRef.current[role] === true)',
    );
    expect(availability).toContain("activeLiveRoleLoadState === 'loading'");
    expect(availability).toContain("activeLiveRoleLoadState === 'failed'");
    expect(availability).not.toContain("activeLiveRoleLoadState !== 'ready'");
    expect(workspace).toContain('activeLiveRoleUnavailable ? (');
    expect(workspace).toContain('<LiveRoleUnavailable');
  });

  it('applies the director decision queue only through the guarded live snapshot', () => {
    const legacyDirectorLoader = sourceBetween(
      '  const directorSupplemental = useDirectorSupplementalObjects({',
      '  useEffect(() => {\n    const controller = liveRefreshControllerRef.current;',
    );
    const directorSnapshot = sourceBetween(
      "          case 'director':\n            setDirectorRefreshPending(false);\n            setBusinessRefreshGeneration",
      '            break;\n        }\n      },\n      onError:',
    );

    expect(legacyDirectorLoader).not.toContain('fetchDirectorControl');
    expect(legacyDirectorLoader).not.toContain('fetchDirectorDecisions');
    expect(legacyDirectorLoader).not.toContain('fetchDirectorDecisionObjects');
    expect(legacyDirectorLoader).not.toContain('decisionObjects ? { director: decisionObjects }');
    expect(legacyDirectorLoader).toContain('refreshGeneration: businessRefreshGeneration');
    expect(legacyDirectorLoader).not.toContain('refreshGeneration: directorLiveTick');
    expect(directorSnapshot).toContain('director: snapshot.decisionObjects');
  });

  it('starts authenticated live roles without fixture selections and never merges warehouse fixtures', () => {
    const initialSelection = sourceBetween(
      'function initialSelectionFromUrl',
      'const ADMIN_ROLE_TEMPLATES_STORAGE_KEY',
    );
    const initialState = sourceBetween('  const [operatorRuntime', '  const [productionShifts');
    const warehouseSnapshot = sourceBetween(
      "          case 'warehouse': {",
      "          case 'director':",
    );

    expect(initialSelection).toContain('AUTH_REQUIRED && isLiveContour(item)');
    expect(initialSelection).toMatch(/item === role\s*\?\s*requestedObject\s*:\s*null/u);
    expect(initialState).toContain('emptyOperatorRuntime()');
    expect(initialState).toContain('emptyProductionRuntime()');
    expect(initialState).toContain('initialLiveWorkObjects');
    expect(warehouseSnapshot).not.toContain('...current.warehouse');
    expect(warehouseSnapshot).not.toContain("object.id === 'WH-INV-RAW'");
    expect(warehouseSnapshot).toContain('liveRawMaterialsToWorkObject(snapshot.stocks)');
  });

  it('keeps an opaque live deep link until the first server snapshot can reconcile it', () => {
    const selectionReconciliation = sourceBetween(
      '  const selectedObjectBase =',
      "  useEffect(() => {\n    if (activeRole !== 'commercial'",
    );

    expect(selectionReconciliation.match(/activeLiveRoleUnavailable/gu)).toHaveLength(4);
  });

  it('derives warehouse inventory rows and navigation counts from the same live read model', () => {
    const inventoryProjection = sourceBetween(
      '  const warehouseInventoryDashboard = useMemo(',
      '  const directorDashboard = useMemo(',
    );
    const workspace = sourceBetween('      <main', '      {isIntakeDrawerOpen && (');

    expect(inventoryProjection).toContain(
      'buildWarehouseInventoryDashboard(rawMaterialSourceObject, warehouseCoverFreeRolls)',
    );
    expect(inventoryProjection).toContain('warehouseSectionForCategory(category.id)');
    expect(inventoryProjection).toContain('category.rows.length');
    expect(inventoryProjection).not.toContain('[WAREHOUSE_STOCK_SECTION]: 0');
    expect(workspace.match(/warehouseSectionCounts/gu)).toHaveLength(3);
  });

  it('uses the legacy inventory fixture only when the warehouse contour is not live', () => {
    const inventorySource = sourceBetween(
      '  const rawMaterialSourceObject = useMemo(',
      '  const warehouseInventoryDashboard = useMemo(',
    );

    expect(inventorySource).toContain("object.id === 'warehouse-live-inventory'");
    expect(inventorySource).toContain('if (isWarehouseLive) return liveProjection ?? null');
    expect(inventorySource).toContain("object.id === 'WH-INV-RAW'");
    expect(inventorySource).toContain('[isWarehouseLive, projectedWorkObjectsByRole]');
  });

  it('refreshes the operator through the shared controller without synthetic receiver notices', () => {
    const liveOperatorMutation = sourceBetween(
      '  function runOperatorLiveAction',
      '  function applyOperatorAction',
    );

    expect(liveOperatorMutation).toContain("requestLiveRoleRefresh('operator')");
    expect(liveOperatorMutation).toContain('liveMutationGateRef.current.start(');
    expect(liveOperatorMutation).not.toContain('notifyRole(');
  });

  it('refreshes commercial invoice and production handoffs without synthetic receiver notices', () => {
    const productionHandoff = sourceBetween(
      '        if (isCommercialLive) {\n          void sendCommercialOrderToProduction',
      "      if (action.kind === 'commercialDelegateSelected') {",
    );
    const financeHandoff = sourceBetween(
      '        if (isCommercialLive) {\n          void submitCommercialOrderToFinance',
      "        const productionObject = productionFromIntake(selectedObject, 'incomplete');",
    );

    for (const block of [productionHandoff, financeHandoff]) {
      expect(block).toContain("requestLiveRoleRefresh('commercial')");
      expect(block).not.toContain('notifyRole(');
    }
  });

  it('does not synthesize a finance handoff when a live commercial intake is only created', () => {
    const liveIntake = sourceBetween(
      '  async function submitIntake',
      '    const commercialObject = createCommercialObject',
    );

    expect(liveIntake).toContain('requestLiveRoleRefresh(');
    expect(liveIntake).not.toContain('notifyRole(');
  });

  it('keeps cover handoff notices demo-only and refreshes a live commercial confirmation', () => {
    const coverHandoff = sourceBetween(
      '        if (!isCommercialLive) {\n          if (reserveTask) {',
      '        const proposalId = selectedObject.warehouseCoverProposals?.[0]?.id;',
    );
    const liveConfirmation = sourceBetween(
      '        const proposalId = selectedObject.warehouseCoverProposals?.[0]?.id;',
      "          'Покрытие склада принято',",
    );

    expect(coverHandoff).toContain('if (!isCommercialLive) {');
    expect(liveConfirmation).toContain("requestLiveRoleRefresh('commercial')");
    expect(liveConfirmation).not.toContain('notifyRole(');
  });

  it('refreshes production assignment mutations through the shared controller', () => {
    const assignMachine = sourceBetween(
      '  async function assignLiveProductionMachine',
      '  function breakdownReassignLiveProductionMachine',
    );
    const assignRoll = sourceBetween(
      '  async function assignLiveProductionRollOperator',
      '  async function setLiveProductionRollPriority',
    );
    const updateRollPriority = sourceBetween(
      '  async function setLiveProductionRollPriority',
      '  function saveLiveProductionRolls',
    );
    const batchAssign = sourceBetween(
      '  function saveLiveProductionRolls',
      '  function moveLiveProductionRoll',
    );

    for (const block of [assignMachine, batchAssign]) {
      expect(block).toContain("requestLiveRoleRefresh('production')");
    }
    for (const block of [assignRoll, updateRollPriority]) {
      expect(block).toContain('commitThenRefresh(');
      expect(block).toContain('liveRefreshControllerRef.current?.invalidateAndRefresh()');
      expect(block).not.toContain("requestLiveRoleRefresh('production')");
    }
    expect(assignRoll).toContain(
      'Полностью назначенный заказ-наряд передаётся оператору автоматически',
    );
    expect(assignRoll).not.toContain("roll.publicationState === 'published'");
    expect(assignRoll).not.toContain('«Согласовать»');
  });

  it('keeps pre-production technical rows during local production reloads', () => {
    const reload = sourceBetween(
      '  async function reloadLiveProductionOrders',
      '  async function reloadLiveProductionProblems',
    );

    expect(reload).toContain('fetchProductionLiveOrdersWithStatus()');
    expect(reload).toContain('setLiveProductionOrders(result.orders)');
    expect(reload).toContain('setProductionCommercialActionsState(result.commercialActionsState)');
    expect(reload).not.toContain('fetchProductionOrders()');
  });

  it('uses backend inbox events for finance to commercial handoff and refreshes the sender', () => {
    const liveFinance = sourceBetween(
      "    if (action.kind === 'financeReduce') {\n      if (isFinanceLive) {",
      '      const beforeStatus = selectedObject.statusLabel;',
    );
    const officeSuccess = sourceBetween(
      '  function setMutatingOfficeActionOutcome',
      '  function setMutatingNavigationActionOutcome',
    );

    expect(liveFinance).toContain("setMutatingOfficeActionOutcome('finance'");
    expect(liveFinance).toContain('liveMutationGateRef.current.start(');
    expect(officeSuccess).toContain('requestLiveRoleRefresh(role)');
    expect(liveFinance).not.toContain("notifyRole(\n                    'commercial'");
  });

  it('invalidates an in-flight role snapshot before every post-mutation refresh', () => {
    const refreshHelper = sourceBetween(
      '  function requestLiveRoleRefresh',
      '  function markLiveSelectionInitialized',
    );

    expect(refreshHelper).toContain('liveRefreshControllerRef.current?.invalidateAndRefresh()');
    expect(refreshHelper).not.toContain('liveRefreshControllerRef.current?.refresh()');
  });

  it('keeps complete per-role inbox state and polls administrator notifications independently', () => {
    const sharedRefresh = sourceBetween(
      '  useEffect(() => {\n    const controller = liveRefreshControllerRef.current;',
      '  // HID-сканер = клавиатурный ввод',
    );

    expect(source).toContain('inboxStateByRole');
    expect(source).toContain('adminInboxRefreshControllerRef');
    expect(source).toContain('adminInboxRefreshErrorRef');
    expect(source).toContain("fetchRoleInbox('admin'");
    expect(source).toContain('if (adminInboxRefreshErrorRef.current === message) return;');
    expect(source).toContain('adminInboxRefreshErrorRef.current = null;');
    expect(source).toContain('mergeInboxFirstPage');
    expect(source).toContain('appendInboxPage');
    expect(source).toContain('loadMoreRoleInbox');
    expect(source).toContain('applyInboxFirstPage(role, snapshot.inbox)');
    expect(sharedRefresh).not.toContain("loadLiveRoleSnapshot('admin'");
    expect(source).toContain('<AdminLiveControlPlane');
    expect(source).toContain('selectedIncidentId={selectedAdminIncidentId}');
  });

  it('coalesces repeated optimistic read clicks before issuing another request', () => {
    const markRead = sourceBetween(
      '  function markNotificationRead',
      '  function openLiveNotification',
    );

    expect(markRead).toContain('if (pendingInboxReadsRef.current.has(pendingKey)) return;');
    expect(
      markRead.indexOf('if (pendingInboxReadsRef.current.has(pendingKey)) return;'),
    ).toBeLessThan(markRead.indexOf('pendingInboxReadsRef.current.set(pendingKey, pending);'));
  });

  it('keeps an unavailable warehouse 1C action silent instead of blaming the employee', () => {
    const requestPush = sourceBetween(
      '  async function requestWarehouseOneCStockPush',
      '  function runWarehouseLiveAction',
    );
    const unavailableGuard = sourceBetween(
      '    if (!canPushWarehouseOneC)',
      '    setWarehouseOneCStockPushBusy(true);',
    );

    expect(requestPush).toContain('if (!canPushWarehouseOneC) return;');
    expect(unavailableGuard).not.toContain('showMutationToast');
    expect(unavailableGuard).not.toContain('Недостаточно прав');
    expect(unavailableGuard).not.toContain('Backend не выдал capability');
    expect(source).toContain(
      "activeRole === 'warehouse' && isWarehouseLive && canPushWarehouseOneC",
    );
  });

  it('routes queue/admin notification CTAs without retaining stale object selection', () => {
    const openNotification = sourceBetween(
      '  function openLiveNotification',
      '  function acknowledgeNotification',
    );

    expect(openNotification).toContain("'clearSelection' in destination");
    expect(openNotification).toContain('setSelectedAdminIncidentId(destination.incidentId)');
    expect(openNotification).toContain('setSelectedByRole((current) => ({');
    expect(openNotification).toContain('[role]: null');
    expect(openNotification).toContain('normalizeWarehouseNotificationUrl(url)');
    expect(openNotification).toContain('warehouseStockDestination');
  });

  it('waits for a live finance problem before reporting success and does not synthesize receivers', () => {
    const liveFinanceProblem = sourceBetween(
      "    if (isFinanceLive && payload.sourceActionId.startsWith('finance-create-problem:')) {",
      "    if (payload.auditEvent === 'problem:production_reported_to_commercial') {",
    );

    expect(liveFinanceProblem).toContain('return createFinanceProblem(');
    expect(liveFinanceProblem).toContain('.then(() => {');
    expect(liveFinanceProblem).toContain(
      "payload.auditEvent === 'problem:payment_overdue' ? 'overdue' : 'other'",
    );
    expect(liveFinanceProblem).not.toContain('/просроч/i');
    expect(liveFinanceProblem).toContain("requestLiveRoleRefresh('finance')");
    expect(liveFinanceProblem).not.toContain('notifyRole(');
  });

  it('waits for a live operator problem and leaves receiver routing to backend events', () => {
    const liveOperatorProblem = sourceBetween(
      "    if (isOperatorLive && payload.createdByRole === 'operator') {",
      "    if (isFinanceLive && payload.sourceActionId.startsWith('finance-create-problem:')) {",
    );

    expect(liveOperatorProblem).toContain('reportOperatorProblem({');
    expect(liveOperatorProblem).toContain('operatorProblemGateRef.current.start(');
    expect(liveOperatorProblem).toContain('operationKey,');
    expect(liveOperatorProblem).toContain('type: problemType,');
    expect(liveOperatorProblem).not.toContain('physicalOperationGateRef.current.start(');
    expect(liveOperatorProblem).toContain("requestLiveRoleRefresh('operator')");
    expect(liveOperatorProblem).not.toContain('submitOperatorProblemReport(');
    expect(liveOperatorProblem).not.toContain('notifyRole(');
  });

  it('uses the backend penalty event for live operator notification', () => {
    const liveProductionPenalty = sourceBetween(
      '  async function createProductionPenalty',
      '  function updatePenalty',
    );

    expect(liveProductionPenalty).toContain('createProductionOperatorPenalty(');
    expect(liveProductionPenalty).toContain("refreshLivePenaltySnapshot('production')");
    expect(liveProductionPenalty).not.toContain('notifyRole(');
  });

  it('passes inbox penalty selection into the production penalty surface', () => {
    const productionPenaltySurface = sourceBetween(
      ') : isProductionPenaltySection ? (',
      ") : activeRole === 'admin' && isAdminLive ? (",
    );

    expect(productionPenaltySurface).toContain('selectedPenaltyId={selectedId}');
    expect(productionPenaltySurface).toContain('snapshot={productionPenaltySnapshot}');
    expect(source).toContain(
      'snapshot.penalties.map((penalty) => penaltyWorkListId(penalty.penaltyId))',
    );
  });

  it('uses durable director penalties in live mode and disables unsupported inline edits', () => {
    const liveDirectorPenalty = sourceBetween(
      '  async function createDirectorPenalty',
      '  async function createProductionPenalty',
    );

    expect(liveDirectorPenalty).toContain('createDirectorPenaltyApi(');
    expect(liveDirectorPenalty).toContain('liveMutationGateRef.current.start(');
    expect(liveDirectorPenalty).toContain("refreshLivePenaltySnapshot('director')");
    expect(source).toContain('allowPenaltyUpdate={!isDirectorLive}');
  });

  it('single-flights production technical approval and every mutating warehouse live action', () => {
    const productionActions = sourceBetween(
      "      if (action.kind === 'productionApproveTechnicalCover') {",
      "      if (action.kind === 'productionApproveOrder') {",
    );
    const productionTechnicalApproval = sourceBetween(
      '  function approveLiveProductionTechnicalCover',
      '  function approveLiveProductionHubOrder',
    );
    const warehouseLive = sourceBetween(
      '  function runWarehouseLiveAction',
      '  function applyWorkObjectAction',
    );
    const warehouseScan = sourceBetween(
      '  async function handleWarehouseScan',
      '  async function handleWarehousePalletSelectionScan',
    );

    expect(productionActions).toContain('approveLiveProductionTechnicalCover(');
    expect(productionTechnicalApproval).toContain('liveMutationGateRef.current.start(');
    expect(productionTechnicalApproval).toContain(
      'error instanceof ProductionTechnicalCoverReconciliationError',
    );
    expect(productionTechnicalApproval).toContain("requestLiveRoleRefresh('production')");
    expect(productionTechnicalApproval).toContain('могло быть записано');
    expect(warehouseLive.match(/liveMutationGateRef\.current\.start\(/g)).toHaveLength(2);
    expect(warehouseLive).not.toContain('physicalOperationGateRef.current.start(');
    expect(warehouseScan.match(/physicalOperationGateRef\.current\.start\(/g)).toHaveLength(5);
    expect(warehouseScan).toContain('receiveWarehouseDefectBag(payload, operationKey)');
    expect(warehouseScan).toContain('shipWarehouseDefectBag(payload, operationKey)');
    expect(warehouseActivePalletSource).toContain(
      'sealCurrentWarehousePallet(taskId, { requestId })',
    );
    expect(warehouseActivePalletSource).toContain('if (!canClose || pendingRef.current) return;');
    expect(warehouseActivePalletSource).toContain(
      'const requestId = retryRequestIdRef.current ?? createWarehouseSystemPrintRequestId();',
    );
    expect(warehouseActivePalletSource).toContain(
      'recordWarehousePalletSystemPrintIntent(sealed.id',
    );
    expect(warehouseActivePalletSource).toContain('fetchWarehousePalletPreview(sealed.id)');
    expect(warehouseActivePalletSource).toContain(
      'openWarehousePalletSystemPrint(preview, sealed.templateVersion)',
    );
    expect(warehouseActivePalletSource).not.toContain('useWarehousePrinterResources');
    expect(warehouseScan).toContain('scanWarehouseTask(');
    expect(warehouseScan).toContain('isWarehousePalletPayload(payload)');
    expect(warehouseScan).toContain('warehousePalletScanIntent(activeSection)');
    expect(warehouseScan).toContain('scanWarehousePalletDelivery(payload, operationKey)');
    expect(warehouseScan).toContain('`delivery-${palletDelivery.deliveryTaskId}`');
    expect(warehouseScan).toContain("palletIntent === 'delivery'");
    expect(warehouseScan).toContain('scanWarehousePallet(payload, operationKey)');
    expect(warehouseScan).toContain('`delivery-${palletHandoff.deliveryTaskId}`');
    expect(warehouseScan).toContain("warehouse: 'Выдача'");
    expect(warehouseScan).toContain('подтверждены в задаче выдачи');
    expect(warehouseScan).not.toContain('добавлено в задачу выдачи');
    expect(warehouseScan.indexOf('warehousePalletScanIntent(activeSection)')).toBeLessThan(
      warehouseScan.indexOf('scanWarehousePallet(payload, operationKey)'),
    );
    expect(warehouseScan).toContain('const scannedTask = result.task');
    expect(warehouseScan).toContain("const accepted = result.scanStatus === 'accepted'");
    expect(warehouseScan).not.toContain('result.matched');
    expect(warehouseScan).not.toContain('deliveryTask.lastScanResult');
    expect(warehouseLive).toContain('actionId.match(/^warehouse\\.delivery\\.close:');
    expect(warehouseLive).not.toContain('Контрольный вес ${rollCode}, кг');
  });

  it('routes pallet formation scans through a separate idempotent live handler', () => {
    const palletSelectionScan = sourceBetween(
      '  async function handleWarehousePalletSelectionScan',
      '  /**\n   * Live-режим Приёмки',
    );

    expect(source).toContain('scanWarehousePalletSelection,');
    expect(palletSelectionScan.match(/physicalOperationGateRef\.current\.start\(/g)).toHaveLength(
      1,
    );
    expect(palletSelectionScan).toContain('`warehouse:pallet-selection:${taskId}:${payload}`');
    expect(palletSelectionScan).toContain(
      'scanWarehousePalletSelection(taskId, payload, operationKey)',
    );
    expect(palletSelectionScan).toContain('applyWarehousePalletSelectionScan(object, result)');
    expect(palletSelectionScan).not.toContain('setWarehouseLiveTick(');
    expect(palletSelectionScan).toContain("result.outcome === 'added'");
    expect(palletSelectionScan).toContain('Скан палеты не обработан');
    expect(source).toMatch(
      /onPalletScanPayload=\{\s*isWarehouseLive\s*\?\s*handleWarehousePalletSelectionScan\s*:\s*undefined\s*\}/u,
    );
  });

  it('routes the production hub technical-cover CTA through the commercial approval endpoint', () => {
    const hubApproval = sourceBetween(
      '  function approveLiveProductionHubOrder',
      '  function openDetailTarget',
    );

    expect(hubApproval).toContain("getWorkObjectAction('production', actionId)");
    expect(hubApproval).toContain("action.kind === 'productionApproveTechnicalCover'");
    expect(hubApproval).toContain('approveLiveProductionTechnicalCover(');
    expect(hubApproval).toContain('approveLiveProductionOrder(orderId, actionId)');
    expect(source).toContain('onApproveOrder={approveLiveProductionHubOrder}');
  });

  it('single-flights repeated live production approval clicks through one mutation key', () => {
    const approval = sourceBetween(
      '  function approveLiveProductionOrder',
      '  function approveLiveProductionTechnicalCover',
    );

    expect(approval).toContain('liveMutationGateRef.current.start(');
    expect(approval).toContain('`production:${orderId}:${actionId}`');
    expect(approval).toContain('if (!request) return;');
    expect(approval).toContain('void request');
  });

  it('treats warehouse scanning as a browser-owned station without a machine post', () => {
    expect(source).not.toContain('fetchWarehousePhysicalPosts()');
    expect(source).not.toContain('resolveWarehousePostSelection(');
    expect(source).not.toContain('WarehousePostBindingCoordinator');
    expect(source).not.toContain('ensureWarehousePostBinding()');
    expect(source).not.toContain('warehouse-post-selector');
    expect(source).not.toContain('Физический пост');
    expect(source).not.toContain('VITE_WAREHOUSE_POST_CODE');
    expect(source).toContain('scanWarehousePayload(payload, operationKey)');
    expect(source).not.toContain('controlWeighWarehouseRoll(');
    expect(source).not.toContain('markWarehouseRollDamaged(');
    expect(source).not.toContain('warehouse.control_weight:');
    expect(source).not.toContain('warehouse.roll_damaged:');
  });

  it('replaces live warehouse delivery fixtures with backend task projections', () => {
    const warehouseSnapshot = sourceBetween(
      "          case 'warehouse': {",
      "          case 'director':",
    );

    expect(warehouseSnapshot).toContain('snapshot.deliveryTasks.map(deliveryTaskToWorkObject)');
    expect(warehouseSnapshot).toContain('const nextWarehouseObjects = [');
    expect(warehouseSnapshot).toContain('warehouse: nextWarehouseObjects');
    expect(warehouseSnapshot).toContain('reconcileEquivalentSnapshot(');
    expect(warehouseSnapshot).not.toContain('...current.warehouse');
  });

  it('rebinds the HID scanner when the live delivery target changes', () => {
    const hidEffect = sourceBetween(
      '  // HID-сканер = клавиатурный ввод',
      '  useEffect(() => {\n    try {\n      window.localStorage.setItem(',
    );

    expect(hidEffect).toContain('activeSection,');
    expect(hidEffect).toContain('selectedByRole.warehouse,');
    expect(hidEffect).toContain('warehouseDeliveryTasks,');
    expect(hidEffect).not.toContain('react-hooks/exhaustive-deps');
  });

  it('routes the first visible delivery task even before an explicit row click', () => {
    const warehouseScan = sourceBetween(
      '  async function handleWarehouseScan',
      '  async function handleWarehousePalletSelectionScan',
    );

    expect(warehouseScan).toContain('`delivery-${task.id}` === selectedWarehouseScanStationId');
    expect(warehouseScan).not.toContain('`delivery-${task.id}` === selectedByRole.warehouse');
  });

  it('single-flights operator shift, machine and roll live mutations', () => {
    const operatorShiftClose = sourceBetween(
      '  function settleOperatorShiftCloseAttempt',
      '  function runOperatorLiveAction',
    );
    const operatorLive = sourceBetween(
      '  function runOperatorLiveAction',
      '  function applyOperatorAction',
    );

    expect(operatorLive.match(/liveMutationGateRef\.current\.start\(/g)).toHaveLength(3);
    expect(operatorShiftClose.match(/operatorShiftCloseGateRef\.current\.start\(/g)).toHaveLength(
      1,
    );
    expect(operatorShiftClose).toContain(
      'closeOperatorShift({ operationKey, bags: attempt.bags })',
    );
    expect(operatorShiftClose).toContain('attempt.operationKey = operationKey');
    expect(operatorShiftClose).toContain('attempt.operationKey !== operationKey');
    expect(operatorShiftClose).toContain("current === 'operator-close-shift-uncertain'");
    expect(operatorShiftClose).toContain("shift.status === 'closed'");
    expect(operatorLive.match(/operatorRollOperationGateRef\.current\.start\(/g)).toHaveLength(2);
    expect(operatorLive).toContain('physicalOperationGateRef.current.start(');
    expect(operatorLive).toContain('weighOperatorDefectBag(');
    expect(operatorLive).toContain('defectBagWeight.weightKg');
    expect(operatorLive).toContain('defectBagWeight.defectType');
    expect(operatorLive).toContain('printOperatorDefectBag(');
    expect(operatorLive).toContain('`operator:${rollCode}:physical`');
    expect(operatorLive).toContain('operatorDefectIntent(rollCode)');
    expect(operatorLive).toContain("kind: 'reweigh'");
    expect(operatorLive).toContain(
      'setOperatorRuntime((current) => applyOperatorReweighResult(current, outcome.result))',
    );
    expect(operatorLive).not.toContain('invalidateAndRefresh()');
    expect(operatorLive).not.toContain('Promise<void | OperatorRollReweighResult>');
    expect(operatorLive).not.toContain('roll.qrCode');
  });

  it('keeps warehouse close on the shared refresh controller path', () => {
    const warehouseLive = sourceBetween(
      '  function runWarehouseLiveAction',
      '  function applyWorkObjectAction',
    );

    expect(warehouseLive).toContain("requestLiveRoleRefresh('warehouse')");
  });

  it('enables one shared recipe catalog for intake, warehouse data entry, or template editing', () => {
    const detailObjectIndex = source.indexOf('  const detailObject =');
    const warehouseGateIndex = source.indexOf('  const warehouseMaterialRecipeCatalogEnabled =');
    const catalogHookIndex = source.indexOf(
      '  const materialRecipeCatalog = useMaterialRecipeCatalog(',
    );
    const gate = source.slice(warehouseGateIndex, catalogHookIndex);
    const hook = source.slice(catalogHookIndex, catalogHookIndex + 220);
    const workspace = sourceBetween(
      "              ) : activeRole === 'commercial' &&",
      '            </section>',
    );

    expect(detailObjectIndex).toBeGreaterThan(-1);
    expect(warehouseGateIndex).toBeGreaterThan(detailObjectIndex);
    expect(catalogHookIndex).toBeGreaterThan(warehouseGateIndex);
    expect(source.match(/useMaterialRecipeCatalog\(/gu)).toHaveLength(1);
    expect(gate).toContain("activeRole === 'warehouse'");
    expect(gate).toContain('isWarehouseLive');
    expect(gate).toContain('isWarehouseInventoryPage');
    expect(gate).toContain("detailObject?.id === 'warehouse-live-inventory'");
    expect(gate).toContain('warehouseInventoryCategoryForSection(');
    expect(gate).toContain(") === 'raw'");
    expect(gate).toContain('isWarehouseStockSection(');
    expect(hook).toContain('isIntakeDrawerOpen ||');
    expect(hook).toContain('warehouseMaterialRecipeCatalogEnabled ||');
    expect(hook).toContain('(isProductionLive && isTemplateDirectory)');
    expect(workspace).toMatch(
      /warehouseMaterialRecipeCatalog=\{\s*warehouseMaterialRecipeCatalogEnabled\s*\?\s*materialRecipeCatalog\s*:\s*undefined\s*\}/u,
    );
  });

  it('persists authorized live stock corrections and keeps demo mutation out of live inventory', () => {
    expect(source).toContain('async function adjustLiveWarehouseRawMaterial');
    const adjustment = sourceBetween(
      '  async function adjustLiveWarehouseRawMaterial',
      '  async function receiveLiveWarehouseRawMaterial',
    );
    const receipt = sourceBetween(
      '  async function receiveLiveWarehouseRawMaterial',
      '  function applyWarehouseStockMutationDraft',
    );
    const workspace = sourceBetween(
      "              ) : activeRole === 'commercial' &&",
      '            </section>',
    );

    expect(adjustment).toContain('adjustWarehouseRawMaterial(input.materialId');
    expect(adjustment).toContain('warehouseRawAdjustmentReplayRef.current.prepare(');
    expect(adjustment).toContain('warehouseRawAdjustmentIntent(input.materialId, payload)');
    expect(adjustment).toContain(
      'const serializationKey = `warehouse:raw-adjust:${input.materialId}`',
    );
    expect(adjustment).toContain('physicalOperationGateRef.current.start(');
    expect(adjustment).toContain('operationKey,');
    expect(adjustment).toContain('serializationKey,');
    expect(adjustment).toContain('if (!request) return false;');
    expect(adjustment).toContain('await request;');
    expect(adjustment).toContain(
      'warehouseRawAdjustmentReplayRef.current.resolve(input.materialId)',
    );
    expect(adjustment).toContain(
      'warehouseRawAdjustmentReplayRef.current.reject(input.materialId, payload, error)',
    );
    expect(adjustment).toContain('liveRefreshControllerRef.current?.invalidateAndRefresh();');
    expect(adjustment).not.toContain('liveRefreshControllerRef.current?.refresh()');
    expect(adjustment).toContain("'Результат корректировки нужно сверить'");
    expect(receipt).toContain('receiveWarehouseRawMaterial(input.materialId');
    expect(receipt).toContain('operationKey: input.operationKey');
    expect(receipt).toContain('`warehouse:raw-receipt:${input.materialId}`');
    expect(receipt).toContain('if (!request) return false;');
    expect(receipt).toContain('await request;');
    expect(receipt).toContain('liveRefreshControllerRef.current?.invalidateAndRefresh();');
    expect(receipt).toContain("'Приход не записан'");
    expect(workspace).toContain("detailObject?.id === 'warehouse-live-inventory'");
    expect(workspace).toMatch(
      /onStockMutation=\{\s*activeRole === 'warehouse' &&\s*detailObject\?\.id === 'warehouse-live-inventory'/u,
    );
    expect(workspace).toContain("activeRole === 'warehouse' &&");
    expect(workspace).toContain('isWarehouseLive &&');
    expect(workspace).toContain('canAdjustWarehouseRawMaterial');
    expect(workspace).toContain('onAdjustRawMaterial={');
    expect(workspace).toContain('onReceiveRawMaterial={');
    expect(workspace).toContain('? receiveLiveWarehouseRawMaterial');
  });
});
