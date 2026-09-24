import { createRoot } from 'react-dom/client';

import type { PenaltySnapshotRuntime } from '../api/penalties';
import { PenaltyManagementSurface } from '../components/workbenches/directorPenalties';
import '../styles.css';

const penaltyId = 'cmsq0wtc300d7qt06ocfs9qn0';
const snapshot: PenaltySnapshotRuntime = {
  items: [
    {
      penaltyId,
      employeeId: 'production-lead-1',
      employeeName: 'Завпроизводства',
      employeeRole: 'Зав. производства',
      targetRole: 'production_lead',
      scopeObjectId: 'без связанного объекта',
      reason: 'Нарушение производственного регламента',
      amountLabel: '2 000 ₽',
      author: 'Директор',
      status: 'issued',
      createdAt: '2026-08-12T11:46:07.106Z',
      history: [
        {
          id: `${penaltyId}-created`,
          time: '2026-08-12T11:46:07.106Z',
          actorLabel: 'Директор',
          actionLabel: 'audit:penalty_created',
          detail: 'Нарушение производственного регламента. Сумма: 2 000 ₽.',
        },
      ],
    },
  ],
  summary: {
    totalCount: 1,
    totalAmountKopecks: 200_000,
    topReason: 'Нарушение производственного регламента',
  },
};

function DirectorPenaltiesQa() {
  return (
    <main className="app-shell" data-active-role="director">
      <aside className="role-nav" aria-label="Разделы текущей роли" />
      <section className="director-workbench" aria-label="Директор">
        <h1>Штрафы</h1>
        <PenaltyManagementSurface
          snapshot={snapshot}
          filters={{}}
          scopedObjectId=""
          authorRole="director"
          assignmentEmployees={[
            { id: 'production-lead-1', name: 'Завпроизводства', role: 'Зав. производства' },
            { id: 'operator-1', name: 'Оператор 1', role: 'Оператор' },
          ]}
          canCreatePenalty
          allowUpdate={false}
          onFiltersChange={() => undefined}
          onCreate={() => undefined}
          onUpdate={() => undefined}
        />
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<DirectorPenaltiesQa />);
