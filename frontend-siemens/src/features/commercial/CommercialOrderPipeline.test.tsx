import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CommercialOrderPipeline } from './CommercialOrderPipeline';
import type { CommercialPipelineProjection } from './commercialPipeline';

const projection: CommercialPipelineProjection = {
  steps: [
    { id: 'intake', title: 'Заявка', state: 'done' },
    { id: 'finance_handoff', title: 'Передано в бухгалтерию', state: 'done' },
    { id: 'invoice', title: 'Счёт выставлен', state: 'done' },
    {
      id: 'production_handoff',
      title: 'Передать в производство',
      state: 'current',
      action: true,
    },
    { id: 'production', title: 'Производство', state: 'next' },
    { id: 'warehouse', title: 'Склад', state: 'next' },
  ],
  focus: {
    mode: 'action',
    title: 'Передать в производство',
    detail: '',
    owner: 'Коммерция',
    actionLabel: 'Передать в производство',
  },
};

describe('CommercialOrderPipeline', () => {
  it('renders one linear six-stage route without a separate current-stage panel', () => {
    const markup = renderToStaticMarkup(<CommercialOrderPipeline projection={projection} />);

    expect(markup).toContain('aria-label="Путь заказа"');
    expect(markup.match(/class="commercial-pipeline-step /g)).toHaveLength(6);
    expect(markup.match(/aria-current="step"/g)).toHaveLength(1);
    expect(markup).toContain('Передано в бухгалтерию');
    expect(markup).toContain('Счёт выставлен');
    expect(markup).toContain('Передать в производство');
    expect(markup).not.toContain('Текущий этап');
    expect(markup).not.toContain('Финансовый путь');
    expect(markup).not.toContain('commercial-current-focus');
  });

  it('keeps the real action as a compact command under the route', () => {
    const markup = renderToStaticMarkup(
      <CommercialOrderPipeline projection={projection} onAction={vi.fn()} />,
    );

    expect(markup).toMatch(
      /class="commercial-pipeline-command"[\s\S]*<button[^>]*>Передать в производство<\/button>/u,
    );
    expect(markup).not.toMatch(/disabled=/u);
  });
});
