import type { Role } from './types';

export type FinanceActionKind =
  | 'issueInvoice'
  | 'updatePayment'
  | 'retrySync'
  | 'createProblem'
  | 'noop';

export type WorkObjectActionKind =
  | 'commercialOpenProduction'
  | 'commercialSendToProduction'
  | 'commercialDelegateSelected'
  | 'commercialPromoteDraft'
  | 'commercialTransferSelected'
  | 'commercialSaveDraft'
  | 'commercialEditParams'
  | 'commercialAddPosition'
  | 'commercialDuplicatePosition'
  | 'commercialCreatePositionTemplate'
  | 'commercialApplyPositionTemplate'
  | 'commercialRequestCorrection'
  | 'commercialApplyProblemCorrection'
  | 'commercialOpenWarehouseResolution'
  | 'commercialWarehouseResolutionOutcome'
  | 'commercialOpenPaymentShipment'
  | 'commercialOpenProductionProblem'
  | 'productionAssignOperator'
  | 'productionSetPriority'
  | 'productionFormOrder'
  | 'productionApproveOrder'
  | 'productionApproveTechnicalCover'
  | 'productionApplyTemplate'
  | 'productionCheckCompleteness'
  | 'productionSaveDraft'
  | 'productionFillRequired'
  | 'productionReorderQueue'
  | 'productionCommentDirector'
  | 'productionReturnIntake'
  | 'productionCreateProblem'
  | 'productionResolveCurrentRoll'
  | 'financeReduce'
  | 'noop';

export type WorkObjectAction = {
  role: Role;
  kind: WorkObjectActionKind;
  targetId?: string;
};

type RouteAlias<TKind extends string> = {
  kind: TKind;
  exact?: readonly string[];
  prefixes?: readonly string[];
};

const financeActionRoutes: readonly RouteAlias<FinanceActionKind>[] = [
  { kind: 'issueInvoice', exact: ['issue'], prefixes: ['finance-create-invoice:'] },
  { kind: 'updatePayment', exact: ['update-payment', 'update-installment', 'update-after-invoice'], prefixes: ['finance-update-payment:', 'finance-confirm-cash:', 'finance-confirm-schedule:'] },
  { kind: 'retrySync', exact: ['check-payment', 'check-installment', 'check-after-invoice', 'retry-sync', 'retry-issued'], prefixes: ['finance-check-payment:', 'finance-retry-sync:'] },
  { kind: 'createProblem', exact: ['problem', 'problem-sync', 'problem-delivery'], prefixes: ['finance-create-problem:'] },
];

const workObjectActionRoutes: Partial<Record<Role, readonly RouteAlias<WorkObjectActionKind>[]>> = {
  commercial: [
    { kind: 'commercialOpenProduction', exact: ['commercial-open-production', 'open-production'] },
    { kind: 'commercialSendToProduction', prefixes: ['commercial-send-to-production:'] },
    { kind: 'commercialDelegateSelected', exact: ['commercial-delegate-selected'] },
    { kind: 'commercialPromoteDraft', exact: ['commercial-promote-draft'] },
    { kind: 'commercialTransferSelected', exact: ['transfer', 'transfer-ready', 'commercial-transfer-selected'] },
    { kind: 'commercialSaveDraft', exact: ['save', 'save-ready', 'commercial-save-draft'] },
    { kind: 'commercialEditParams', exact: ['commercial-edit-params'], prefixes: ['commercial-edit-params:'] },
    { kind: 'commercialAddPosition', exact: ['commercial-add-position'] },
    { kind: 'commercialDuplicatePosition', exact: ['commercial-duplicate-position'] },
    { kind: 'commercialCreatePositionTemplate', prefixes: ['commercial-create-position-template:'] },
    { kind: 'commercialApplyPositionTemplate', prefixes: ['commercial-apply-position-template:'] },
    { kind: 'commercialRequestCorrection', exact: ['commercial-request-correction'] },
    { kind: 'commercialApplyProblemCorrection', exact: ['commercial-apply-problem-correction', 'commercial-request-correction-submitted'], prefixes: ['commercial-apply-problem-correction:', 'commercial-request-correction-submitted:'] },
    { kind: 'commercialOpenWarehouseResolution', exact: ['commercial-open-warehouse-resolution', 'commercial-reject-warehouse-cover'] },
    { kind: 'commercialWarehouseResolutionOutcome', prefixes: ['commercial-warehouse-resolution:'] },
    { kind: 'commercialOpenPaymentShipment', exact: ['commercial-open-payment-shipment'] },
    { kind: 'commercialOpenProductionProblem', exact: ['commercial-open-production-problem'] },
  ],
  production: [
    { kind: 'productionAssignOperator', exact: ['assign-production'], prefixes: ['production-assign-operator:'] },
    { kind: 'productionSetPriority', prefixes: ['production-set-priority:'] },
    { kind: 'productionFormOrder', prefixes: ['production-form-order:'] },
    { kind: 'productionApproveOrder', exact: ['approve', 'approve-order'], prefixes: ['production-approve-order:'] },
    { kind: 'productionApproveTechnicalCover', prefixes: ['production-technical-approve-cover:'] },
    { kind: 'productionApplyTemplate', exact: ['apply-template-partial'], prefixes: ['production-apply-template:'] },
    { kind: 'productionCheckCompleteness', exact: ['check-partial'], prefixes: ['production-check-completeness:'] },
    { kind: 'productionSaveDraft', exact: ['save', 'save-partial'], prefixes: ['production-save-draft:'] },
    { kind: 'productionFillRequired', exact: ['fill-required-fields'], prefixes: ['production-fill-required:'] },
    { kind: 'productionReorderQueue', exact: ['queue-reorder-global'], prefixes: ['production-reorder-note:'] },
    { kind: 'productionCommentDirector', exact: ['director-comment'], prefixes: ['production-comment-director:'] },
    { kind: 'productionReturnIntake', exact: ['return'], prefixes: ['production-return-intake:'] },
    { kind: 'productionCreateProblem', exact: ['problem'], prefixes: ['production-create-problem:'] },
    { kind: 'productionResolveCurrentRoll', prefixes: ['production-resolve-current-roll:'] },
  ],
};

function targetFromPrefix(actionId: string, prefixes: readonly string[] | undefined) {
  const prefix = prefixes?.find((item) => actionId.startsWith(item));
  return prefix ? actionId.slice(prefix.length) : undefined;
}

function routeKind<TKind extends string>(actionId: string, routes: readonly RouteAlias<TKind>[]) {
  for (const route of routes) {
    if (route.exact?.some((alias) => alias === actionId)) return { kind: route.kind };
    const targetId = targetFromPrefix(actionId, route.prefixes);
    if (targetId !== undefined) return { kind: route.kind, targetId };
  }
  return null;
}

export function getFinanceActionKind(actionId: string): FinanceActionKind {
  return routeKind(actionId, financeActionRoutes)?.kind ?? 'noop';
}

export function getWorkObjectAction(role: Role, actionId: string): WorkObjectAction {
  if (role === 'finance') return { role, kind: 'financeReduce' };
  const route = routeKind(actionId, workObjectActionRoutes[role] ?? []);
  return route ? { role, kind: route.kind, targetId: route.targetId } : { role, kind: 'noop' };
}
