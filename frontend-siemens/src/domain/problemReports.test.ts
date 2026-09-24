import { describe, expect, it } from 'vitest';

import { createProblemReportContext, problemReportPayload } from './problemReports';
import type { WorkObject } from './types';

describe('operator problem routing copy', () => {
  it('uses the unified event and production owner without synthesizing system types', () => {
    const object = {
      id: 'operator-order-1',
      kind: 'operatorTask',
      title: 'Заказ A-501',
      statusLabel: 'Взвешивание рулона',
      severity: 'warning',
      facts: [],
      actions: [],
      problems: [],
      audit: [],
      filterTags: [],
      workbench: {
        type: 'operator',
        currentRoll: { id: 'A-501-roll-1' },
      },
    } as unknown as WorkObject;

    const context = createProblemReportContext('operator', object, 'operator-problem');

    expect(context.draft.operatorProblemType).toBe('general');
    expect(context.draft.ownerRole).toBe('Зав. производства');
    expect(context.draft.targetRole).toBe('production');
    expect(context.notificationRole).toBe('production');
    expect(context.auditEvent).toBe('problem:operator_reported');
  });

  it('routes a selected raw-material shortage to the existing Commerce correction owner', () => {
    const object = {
      id: 'operator-order-1',
      kind: 'operatorTask',
      title: 'Заказ A-501',
      statusLabel: 'Взвешивание рулона',
      severity: 'warning',
      facts: [],
      actions: [],
      problems: [],
      audit: [],
      filterTags: [],
      workbench: {
        type: 'operator',
        currentRoll: { id: 'A-501-roll-1' },
      },
    } as unknown as WorkObject;
    const context = createProblemReportContext('operator', object, 'operator-problem');

    const payload = problemReportPayload(context, {
      ...context.draft,
      operatorProblemType: 'raw_material_shortage',
    });

    expect(payload.ownerRole).toBe('Коммерция');
    expect(payload.targetRole).toBe('commercial');
    expect(payload.notificationRole).toBe('commercial');
    expect(payload.recovery).toBe('Коммерция применяет корректировку сырья');
  });
});
