import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { operatorWorkObjects } from '../../domain/fixtures/operator';
import { DetailView } from './workObjectSurfaces';

describe('operator detail header', () => {
  it('keeps close navigation but hides the crossed-out severity badge', () => {
    const object = { ...operatorWorkObjects[0], severity: 'warning' as const };
    const markup = renderToStaticMarkup(
      <DetailView
        role="operator"
        object={object}
        templateCatalog={[]}
        templateVersions={[]}
        onTemplateSelect={vi.fn()}
        onClose={vi.fn()}
        activeSection="Рулоны и заказы"
      />,
    );

    expect(markup).toContain('aria-label="Закрыть карточку"');
    expect(markup).not.toContain('Требует внимания');
    expect(markup).not.toContain('severity-pill');
  });
});
