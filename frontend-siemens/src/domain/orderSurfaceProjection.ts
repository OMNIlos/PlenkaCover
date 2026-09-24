import type { ActionDescriptor, Fact, ProblemCase, Role, Severity, WorkObject } from './types';

export type OrderSurfaceTone =
  | 'commercial'
  | 'production'
  | 'finance'
  | 'director'
  | 'operator'
  | 'warehouse'
  | 'admin';

export type OrderSurfaceIdentity = {
  eyebrow: string;
  title: string;
  subtitle?: string;
  status: string;
  owner: string;
  severity: Severity;
};

export type OrderSurfaceAction = ActionDescriptor & {
  owner?: string;
  affectedBlock?: string;
};

export type OrderSurfaceRouteItem = {
  label: string;
  value: string;
  meta?: string;
  severity?: Severity;
  icon?: string;
};

export type OrderSurfaceProblem = {
  title: string;
  reason?: string;
  ownerRole: string;
  recovery: string;
  due?: string;
  severity: Severity;
};

export type OrderSurfaceProjection = {
  role: Role;
  tone: OrderSurfaceTone;
  identity: OrderSurfaceIdentity;
  primaryAction?: OrderSurfaceAction;
  secondaryActions: ActionDescriptor[];
  route: OrderSurfaceRouteItem[];
  facts: Fact[];
  problem?: OrderSurfaceProblem;
};

export function firstPrimaryAction(actions: ActionDescriptor[]) {
  return actions.find((action) => action.level === 'recommended')
    ?? actions.find((action) => action.level === 'peer' && action.enabled)
    ?? actions.find((action) => action.level === 'disabled')
    ?? actions[0];
}

export function secondaryOrderActions(actions: ActionDescriptor[], primaryActionId?: string) {
  return actions.filter((action) => action.id !== primaryActionId && action.level !== 'disabled');
}

export function orderSurfaceProblem(object: WorkObject): OrderSurfaceProblem | undefined {
  const primaryProblem =
    object.problems.find((problem) => problem.status === 'open')
    ?? object.productionProblems?.find((problem) => problem.status !== 'resolved');

  if (!primaryProblem) return undefined;

  if ('title' in primaryProblem) {
    const problem = primaryProblem as ProblemCase;
    return {
      title: problem.title,
      reason: problem.reason,
      ownerRole: problem.ownerRole,
      recovery: problem.recovery,
      due: problem.due,
      severity: problem.severity,
    };
  }

  return {
    title: primaryProblem.comment,
    reason: primaryProblem.reason,
    ownerRole: primaryProblem.ownerRole,
    recovery: primaryProblem.recovery,
    severity: primaryProblem.severity,
  };
}

export function createOrderSurfaceProjection(input: {
  role: Role;
  tone: OrderSurfaceTone;
  identity: OrderSurfaceIdentity;
  actions: ActionDescriptor[];
  route?: OrderSurfaceRouteItem[];
  facts?: Fact[];
  problem?: OrderSurfaceProblem;
  primaryAction?: OrderSurfaceAction;
  secondaryActions?: ActionDescriptor[];
}): OrderSurfaceProjection {
  const primaryAction = input.primaryAction ?? firstPrimaryAction(input.actions);
  return {
    role: input.role,
    tone: input.tone,
    identity: input.identity,
    primaryAction,
    secondaryActions: input.secondaryActions ?? secondaryOrderActions(input.actions, primaryAction?.id),
    route: input.route ?? [],
    facts: input.facts ?? [],
    problem: input.problem,
  };
}
