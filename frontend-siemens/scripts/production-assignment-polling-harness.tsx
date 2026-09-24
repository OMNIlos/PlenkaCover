import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@siemens/ix/dist/siemens-ix/siemens-ix.css';

import '../src/styles.css';

import type { ProductionOperatorMachineView, ProductionPost } from '../src/api/production';
import type { ProductionOperator } from '../src/domain/operators';
import type { ProductionRollDispatchItem } from '../src/domain/types';
import { ProductionMachinePlanningSurface } from '../src/components/workbenches/ProductionMachinePlanningSurface';
import { ProductionDispatchPanel } from '../src/components/workbenches/productionDispatchPanel';

const operator: ProductionOperator = {
  id: 'operator-b',
  name: 'Анна Соколова',
  shortName: 'Соколова',
  workplace: 'POST-2',
  defaultMachineId: 'POST-2',
  defaultMachineLabel: 'Экструдер POST-2',
  defaultMachineAssignedAt: 'до смены',
  shiftId: 'shift-a9',
  shiftCapacityMinutes: 480,
  remainingShiftMinutes: 480,
  shift: 'Смена А9',
  activeTasks: 0,
  plannedTasks: 0,
  capacity: 4,
  skill: 'Станок назначен',
  status: 'available',
};

const externalOperator: ProductionOperator = {
  ...operator,
  id: 'operator-c',
  name: 'Ирина Волкова',
  shortName: 'Волкова',
  workplace: 'POST-3',
  defaultMachineId: 'POST-3',
  defaultMachineLabel: 'Экструдер POST-3',
};

const roll: ProductionRollDispatchItem = {
  id: 'dispatch-a9-new',
  productionOrderId: 'production-a9',
  orderId: 'production-a9',
  orderNumber: 'А9',
  orderLineId: 'position-a9',
  rollId: 'A-9-roll-new',
  sequenceNumber: 1,
  queueRank: 1,
  customerAlias: 'Тест А9',
  operatorId: '',
  operatorLabel: 'Не назначен',
  machineId: '',
  machineLabel: 'Не назначен',
  machineAssignedBy: 'Не назначен',
  machineAssignedAt: '',
  machineAssignmentRequired: true,
  priority: 'обычный',
  plannedNetKg: 40,
  characteristics: 'Плёнка · 80 мкм',
  filmType: 'ПВД',
  micron: '80',
  sizeMeters: '275 м',
  status: 'blocked',
  blocker: 'Нужен оператор',
  auditEvent: 'audit:roll_dispatch_assigned',
};

const orderRoll: ProductionRollDispatchItem = {
  ...roll,
  id: 'dispatch-a9-order',
  rollId: 'A-9-roll-order',
};

const posts: ProductionPost[] = [
  {
    id: 'post-2',
    code: 'POST-2',
    name: 'Экструдер POST-2',
    status: 'active',
    agentStatus: 'online',
  },
];

function machineView(shiftId = 'shift-a9'): ProductionOperatorMachineView {
  return {
    shift: {
      id: shiftId,
      label:
        shiftId === 'shift-a9'
          ? 'AUDIT-20260722T152221Z · будущая проверочная смена'
          : 'Другая смена',
      plannedStartAt: '2099-07-22T08:00:00.000Z',
      plannedEndAt: '2099-07-22T20:00:00.000Z',
      status: 'planned',
      machineAssignments: [],
    },
    operators: [{ id: operator.id, displayName: operator.name }],
  };
}

function Harness() {
  const [rollPoll, setRollPoll] = useState(0);
  const [machinePoll, setMachinePoll] = useState(0);
  const [machineShiftId, setMachineShiftId] = useState('shift-a9');
  const [orderServerRoll, setOrderServerRoll] = useState(orderRoll);
  const [orderAssignmentAttempts, setOrderAssignmentAttempts] = useState(0);
  const [bulkAssignmentAttempts, setBulkAssignmentAttempts] = useState(0);
  const orderAssignmentResolverRef = useRef<
    ((resolution: { accepted: boolean; syncServer: boolean }) => void) | null
  >(null);

  async function assignOrderOperator(_rollId: string, operatorId: string) {
    setOrderAssignmentAttempts((value) => value + 1);
    const resolution = await new Promise<{ accepted: boolean; syncServer: boolean }>((resolve) => {
      orderAssignmentResolverRef.current = resolve;
    });
    orderAssignmentResolverRef.current = null;
    if (!resolution.accepted) return false;
    if (resolution.syncServer) {
      setOrderServerRoll((current) => ({
        ...current,
        operatorId,
        operatorLabel: operator.name,
        machineId: operator.defaultMachineId,
        machineLabel: operator.defaultMachineLabel,
        status: 'assigned',
        blocker: undefined,
      }));
    }
    return true;
  }

  return (
    <>
      <button type="button" onClick={() => setRollPoll((value) => value + 1)}>
        Сервер обновил рулоны {rollPoll}
      </button>
      <ProductionDispatchPanel
        viewMode="rolls"
        selectedOperatorId=""
        selectedPriority="обычный"
        rollDispatchItems={[{ ...roll }]}
        operators={[operator]}
        machineOptions={[
          { value: '', label: 'Не назначен' },
          { value: 'POST-2', label: 'Экструдер POST-2' },
        ]}
      />

      <button
        type="button"
        onClick={() =>
          orderAssignmentResolverRef.current?.({ accepted: false, syncServer: false })
        }
      >
        Отклонить назначение
      </button>
      <button
        type="button"
        onClick={() => orderAssignmentResolverRef.current?.({ accepted: true, syncServer: true })}
      >
        Подтвердить назначение
      </button>
      <button
        type="button"
        onClick={() => orderAssignmentResolverRef.current?.({ accepted: true, syncServer: false })}
      >
        Подтвердить без обновления
      </button>
      <button
        type="button"
        onClick={() =>
          setOrderServerRoll((current) => ({
            ...current,
            operatorId: externalOperator.id,
            operatorLabel: externalOperator.name,
            machineId: externalOperator.defaultMachineId,
            machineLabel: externalOperator.defaultMachineLabel,
            status: 'assigned',
            blocker: undefined,
          }))
        }
      >
        Сервер назначил C
      </button>
      <button type="button" onClick={() => setOrderServerRoll(orderRoll)}>
        Сервер вернул A
      </button>
      <output>Попыток назначения: {orderAssignmentAttempts}</output>
      <output>Пакетных назначений: {bulkAssignmentAttempts}</output>
      <ProductionDispatchPanel
        viewMode="order"
        selectedOperatorId=""
        selectedPriority="обычный"
        rollDispatchItems={[{ ...orderServerRoll }]}
        operators={[operator, externalOperator]}
        machineOptions={[
          { value: '', label: 'Не назначен' },
          { value: 'POST-2', label: 'Экструдер POST-2' },
          { value: 'POST-3', label: 'Экструдер POST-3' },
        ]}
        onUpdateRollOperator={assignOrderOperator}
        onSaveSelected={() => setBulkAssignmentAttempts((value) => value + 1)}
      />

      <button type="button" onClick={() => setMachinePoll((value) => value + 1)}>
        Сервер обновил план {machinePoll}
      </button>
      <button
        type="button"
        onClick={() =>
          setMachineShiftId((current) => (current === 'shift-a9' ? 'shift-next' : 'shift-a9'))
        }
      >
        Открыть другую смену
      </button>
      <ProductionMachinePlanningSurface
        shifts={[machineView(machineShiftId).shift]}
        posts={[...posts]}
        operators={[...machineView(machineShiftId).operators]}
        onCreateShift={() => true}
        onAssignMachine={() => true}
        onBreakdownReassign={() => undefined}
      />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
