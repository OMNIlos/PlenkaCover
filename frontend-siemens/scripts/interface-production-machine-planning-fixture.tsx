import { createRoot } from 'react-dom/client';

import type { ProductionPost, ProductionShift } from '../src/api/production';
import { ProductionMachinePlanningSurface } from '../src/components/workbenches/ProductionMachinePlanningSurface';

const posts: ProductionPost[] = [
  {
    id: 'post-5',
    code: 'POST-5',
    name: 'Экструдер E-05',
    status: 'active',
    agentStatus: 'online',
  },
  {
    id: 'post-6',
    code: 'POST-6',
    name: 'Экструдер E-06',
    status: 'active',
    agentStatus: 'online',
  },
  {
    id: 'post-7',
    code: 'POST-7',
    name: 'Экструдер E-07',
    status: 'broken',
    agentStatus: 'offline',
  },
];

const shift: ProductionShift = {
  id: 'shift-workstation',
  label: 'Смена 1',
  plannedStartAt: '2099-07-22T05:00:00.000Z',
  plannedEndAt: '2099-07-22T17:00:00.000Z',
  status: 'planned',
  machineAssignments: [
    {
      id: 'assignment-locked',
      shiftId: 'shift-workstation',
      operatorId: 'operator-locked',
      postId: 'post-5',
      status: 'locked',
      lockedAt: '2026-07-22T05:00:00.000Z',
      operator: { id: 'operator-locked', displayName: 'Сергей Волков', isActive: true },
      post: { id: 'post-5', code: 'POST-5', name: 'Экструдер E-05', status: 'active' },
    },
  ],
};

export function mountInterfaceProductionMachinePlanningFixture(planningPage: Element) {
  const mount = document.createElement('div');
  mount.dataset.interfaceFixture = 'production-machine-planning';
  mount.style.display = 'contents';
  planningPage.prepend(mount);

  const root = createRoot(mount);
  root.render(
    <ProductionMachinePlanningSurface
      shifts={[shift]}
      posts={posts}
      operators={[
        { id: 'operator-planned', displayName: 'Анна Соколова' },
        { id: 'operator-locked', displayName: 'Сергей Волков' },
      ]}
      onCreateShift={() => true}
      onAssignMachine={() => true}
      onBreakdownReassign={() => undefined}
      onReportBreakdown={() => undefined}
      onStartRepair={() => undefined}
      onCompleteRepair={() => undefined}
    />,
  );
}
