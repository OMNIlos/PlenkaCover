import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { financeWorkObjects } from '../../domain/fixtures/finance';
import { DetailView } from './workObjectSurfaces';

const props = {
  role: 'finance' as const,
  object: financeWorkObjects[0],
  templateCatalog: [],
  templateVersions: [],
  onTemplateSelect: vi.fn(),
  siblingObjects: financeWorkObjects,
  activeSection: 'Просрочки',
};

describe('finance registry landing detail context', () => {
  it.each(['Счета', 'Рассрочка', 'Просрочки'])(
    'does not present the fallback first order as selected in %s',
    (activeSection) => {
      const markup = renderToStaticMarkup(
        <DetailView {...props} activeSection={activeSection} isFinanceRegistryPage />,
      );

      expect(markup).toContain('Реестр');
      expect(markup).not.toContain('class="detail-header"');
      expect(markup).not.toContain('aria-label="Закрыть карточку"');
    },
  );

  it('restores the detail header after an explicit selection', () => {
    const markup = renderToStaticMarkup(
      <DetailView {...props} isFinanceRegistryPage={false} onClose={vi.fn()} />,
    );

    expect(markup).toContain('class="detail-header"');
    expect(markup).toContain('К списку просрочек');
    expect(markup).not.toContain('aria-label="Закрыть карточку"');
  });
});
