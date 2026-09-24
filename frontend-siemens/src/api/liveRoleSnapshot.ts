import type { Role, UserSession } from '../domain/types';
import { fetchMe, type MeResponse } from './auth';
import { fetchFinanceOrders } from './finance';
import {
  fetchCurrentOperatorMachineChange,
  fetchOperatorBigBags,
  fetchOperatorRuntime,
} from './operator';
import {
  fetchPenaltySnapshot,
  fetchOperatorPenalties,
  type PenaltySnapshotFilters,
} from './penalties';
import {
  fetchProductionOperatorMachines,
  fetchProductionOperatorOptions,
  fetchProductionLiveOrdersWithStatus,
  fetchProductionPosts,
  fetchProductionProblems,
  fetchProductionShifts,
  selectProductionPlanningShift,
  type ProductionOperatorMachineView,
} from './production';
import {
  fetchDirectorControl,
  fetchDirectorDecisions,
  fetchDirectorPenaltyTargets,
  projectDirectorDecisionObjects,
  fetchDirectorProblems,
  type ServerDirectorControl,
  type ServerDirectorDecision,
} from './director';
import { fetchRoleInbox, type RoleInboxPage, type RoleInboxRole } from './roleInbox';
import {
  fetchWarehouseCoverCheckQueue,
  fetchWarehouseDeliveryTasks,
  fetchWarehouseFreeRolls,
  fetchWarehouseIntake,
  fetchWarehouseRawMaterialStocks,
} from './warehouse';

export type LiveRoleSnapshotRole = Exclude<RoleInboxRole, 'admin'>;

type LiveSnapshotBase<R extends LiveRoleSnapshotRole> = {
  role: R;
  me: MeResponse;
  inbox: RoleInboxPage;
};

export type LiveRoleSnapshot =
  | LiveSnapshotBase<'commercial'>
  | (LiveSnapshotBase<'finance'> & {
      orders: Awaited<ReturnType<typeof fetchFinanceOrders>>;
    })
  | (LiveSnapshotBase<'production'> & {
      orders: Awaited<ReturnType<typeof fetchProductionLiveOrdersWithStatus>>['orders'];
      commercialActionsState: Awaited<
        ReturnType<typeof fetchProductionLiveOrdersWithStatus>
      >['commercialActionsState'];
      shifts: Awaited<ReturnType<typeof fetchProductionShifts>>;
      posts: Awaited<ReturnType<typeof fetchProductionPosts>>;
      penaltySnapshot: Awaited<ReturnType<typeof fetchPenaltySnapshot>>;
      penaltyFilters: PenaltySnapshotFilters;
      problems: Awaited<ReturnType<typeof fetchProductionProblems>>;
      operators: Awaited<ReturnType<typeof fetchProductionOperatorOptions>>;
      operatorMachineView: ProductionOperatorMachineView | null;
    })
  | (LiveSnapshotBase<'operator'> & {
      runtime: Awaited<ReturnType<typeof fetchOperatorRuntime>>;
      penalties: Awaited<ReturnType<typeof fetchOperatorPenalties>>;
      bags: Awaited<ReturnType<typeof fetchOperatorBigBags>>;
      machineChange: Awaited<ReturnType<typeof fetchCurrentOperatorMachineChange>>;
    })
  | (LiveSnapshotBase<'warehouse'> & {
      stocks: Awaited<ReturnType<typeof fetchWarehouseRawMaterialStocks>>;
      coverChecks: Awaited<ReturnType<typeof fetchWarehouseCoverCheckQueue>>;
      freeRolls: Awaited<ReturnType<typeof fetchWarehouseFreeRolls>>;
      intake: Awaited<ReturnType<typeof fetchWarehouseIntake>>;
      deliveryTasks: Awaited<ReturnType<typeof fetchWarehouseDeliveryTasks>>;
    })
  | (LiveSnapshotBase<'director'> & {
      control: ServerDirectorControl;
      decisions: ServerDirectorDecision[];
      decisionObjects: ReturnType<typeof projectDirectorDecisionObjects>;
      penaltySnapshot: Awaited<ReturnType<typeof fetchPenaltySnapshot>>;
      penaltyFilters: PenaltySnapshotFilters;
      penaltyTargets: Awaited<ReturnType<typeof fetchDirectorPenaltyTargets>>;
      problems: Awaited<ReturnType<typeof fetchDirectorProblems>>;
    });

export const LIVE_ROLE_LOAD_ERROR_TITLE: Record<LiveRoleSnapshotRole, string> = {
  commercial: 'Профиль и контроль не загружены',
  finance: 'Финансы не загружены',
  production: 'Заказ-наряды не загружены',
  operator: 'Задания оператора не загружены',
  warehouse: 'Складская очередь не загружена',
  director: 'Контроль директора не загружен',
};

export function isLiveRoleSnapshotRole(role: Role): role is LiveRoleSnapshotRole {
  return role !== 'admin';
}

export function liveSessionFromMe(
  me: MeResponse,
  role: LiveRoleSnapshotRole,
  fallbackName: string,
  preferences: Pick<UserSession, 'notificationSound' | 'reducedMotion'>,
): UserSession {
  return {
    id: me.userId,
    name: me.displayName ?? fallbackName,
    role,
    workplace: me.workContext.assignment?.workplace ?? null,
    shift: me.workContext.assignment?.shift ?? null,
    status: me.isActive && me.session?.state === 'active' ? 'active' : 'blocked',
    sessionExpiresAt: me.session?.expiresAt ?? null,
    sessionState: me.session?.state ?? null,
    ...preferences,
  };
}

export type LiveRoleSnapshotOptions = {
  productionShiftId?: string | null;
  penaltyFilters?: PenaltySnapshotFilters;
  signal?: AbortSignal;
};

export async function loadLiveRoleSnapshot(
  role: LiveRoleSnapshotRole,
  options: LiveRoleSnapshotOptions = {},
): Promise<LiveRoleSnapshot> {
  const requestOptions = { signal: options.signal };
  const fetchInbox = () => fetchRoleInbox(role, requestOptions);
  switch (role) {
    case 'commercial': {
      const [me, inbox] = await Promise.all([fetchMe(undefined, requestOptions), fetchInbox()]);
      return { role, me, inbox };
    }
    case 'finance': {
      const [me, inbox, orders] = await Promise.all([
        fetchMe(undefined, requestOptions),
        fetchInbox(),
        fetchFinanceOrders(requestOptions),
      ]);
      return { role, me, inbox, orders };
    }
    case 'production': {
      const penaltyFilters = options.penaltyFilters ?? {};
      const [me, inbox, orderResult, shifts, posts, penaltySnapshot, problems, operators] =
        await Promise.all([
          fetchMe(undefined, requestOptions),
          fetchInbox(),
          fetchProductionLiveOrdersWithStatus({ signal: options.signal }),
          fetchProductionShifts(requestOptions),
          fetchProductionPosts(requestOptions),
          fetchPenaltySnapshot(penaltyFilters, requestOptions),
          fetchProductionProblems(undefined, requestOptions),
          fetchProductionOperatorOptions(requestOptions),
        ]);
      const preferredShift = selectProductionPlanningShift(shifts, options.productionShiftId);
      const operatorMachineView = preferredShift
        ? await fetchProductionOperatorMachines(preferredShift.id, requestOptions)
        : null;
      return {
        role,
        me,
        inbox,
        orders: orderResult.orders,
        commercialActionsState: orderResult.commercialActionsState,
        shifts,
        posts,
        penaltySnapshot,
        penaltyFilters,
        problems,
        operators,
        operatorMachineView,
      };
    }
    case 'operator': {
      const [me, inbox, runtime, penalties, bags, machineChange] = await Promise.all([
        fetchMe(undefined, requestOptions),
        fetchInbox(),
        fetchOperatorRuntime(requestOptions),
        fetchOperatorPenalties(requestOptions),
        fetchOperatorBigBags(requestOptions),
        fetchCurrentOperatorMachineChange(requestOptions),
      ]);
      return { role, me, inbox, runtime, penalties, bags, machineChange };
    }
    case 'warehouse': {
      const [me, inbox, stocks, coverChecks, freeRolls, intake, deliveryTasks] = await Promise.all([
        fetchMe(undefined, requestOptions),
        fetchInbox(),
        fetchWarehouseRawMaterialStocks(requestOptions),
        fetchWarehouseCoverCheckQueue(requestOptions),
        fetchWarehouseFreeRolls(requestOptions),
        fetchWarehouseIntake(requestOptions),
        fetchWarehouseDeliveryTasks(requestOptions),
      ]);
      return { role, me, inbox, stocks, coverChecks, freeRolls, intake, deliveryTasks };
    }
    case 'director': {
      const penaltyFilters = options.penaltyFilters ?? {};
      const [me, inbox, control, decisions, penaltySnapshot, penaltyTargets, problems] =
        await Promise.all([
          fetchMe(undefined, requestOptions),
          fetchInbox(),
          fetchDirectorControl(requestOptions),
          fetchDirectorDecisions({ status: 'pending' }, requestOptions),
          fetchPenaltySnapshot(penaltyFilters, requestOptions),
          fetchDirectorPenaltyTargets(requestOptions),
          fetchDirectorProblems(requestOptions),
        ]);
      return {
        role,
        me,
        inbox,
        control,
        decisions,
        decisionObjects: projectDirectorDecisionObjects(decisions),
        penaltySnapshot,
        penaltyFilters,
        penaltyTargets,
        problems,
      };
    }
  }
}
