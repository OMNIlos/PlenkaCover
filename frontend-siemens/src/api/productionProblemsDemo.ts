import type { ServerProductionProblem } from './production';

export function createDemoProductionProblems(): ServerProductionProblem[] {
  return [
    {
      id: 'problem-demo-defect',
      type: 'defect',
      status: 'open',
      orderId: 'order-demo-1',
      positionId: 'position-demo-1',
      rollId: 'ROLL-DEMO-1',
      actorRole: 'operator',
      reason: 'Разрыв полотна на контрольном участке',
      recovery: null,
      createdAt: '2026-08-14T09:30:00.000Z',
      resolvedAt: null,
      postId: 'post-demo-1',
      post: {
        id: 'post-demo-1',
        code: 'POST-DEMO-1',
        name: 'Экструдер DEMO-1',
        status: 'online',
      },
      order: { id: 'order-demo-1', orderNumber: 'З-ДЕМО-1' },
      defectWeightKg: 42.6,
      defectWeightCapturedAt: '2026-08-14T09:29:30.000Z',
      defectWeightSource: 'operator_scale',
    },
  ];
}
