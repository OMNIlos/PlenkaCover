import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { createIntakeDraftPosition } from '../../domain/prototypeRuntime';
import { TemplateDirectorySurface } from './workObjectSurfaces';

describe('TemplateDirectorySurface', () => {
  it('renders bounded width and meterage inputs in a new client template', () => {
    const markup = renderToStaticMarkup(
      <TemplateDirectorySurface
        selectedCounterpartyId="cp-uralpak"
        templates={[]}
        versions={[]}
        query=""
        sortMode="recent"
        editor={{
          mode: 'add',
          counterpartyId: 'cp-uralpak',
          name: '',
          ownerRole: 'Зав. производства',
          reason: '',
          positions: [createIntakeDraftPosition(1)],
        }}
        onQueryChange={vi.fn()}
        onSortChange={vi.fn()}
        onOpenEditor={vi.fn()}
        onArchive={vi.fn()}
        onActivate={vi.fn()}
        onEditorChange={vi.fn()}
        onSafeFieldChange={vi.fn()}
        onSave={vi.fn()}
        onCancelEdit={vi.fn()}
        mode="counterparty"
        onModeChange={vi.fn()}
      />,
    );

    expect(markup).toMatch(
      /aria-label="Ширина, мм, позиция 1"[^>]*type="number" min="0.001" max="100000" step="0.001"/,
    );
    expect(markup).toMatch(
      /aria-label="Метраж, м, позиция 1"[^>]*type="number" min="0.001" max="10000000" step="0.001"/,
    );
    expect(markup).not.toMatch(
      /Заполните обязательные поля|Заполните поле, чтобы сохранить шаблон|Safe-поля автосохраняются/,
    );
  });

  it('does not promise position-level search when the live directory is read-only', () => {
    const markup = renderToStaticMarkup(
      <TemplateDirectorySurface
        selectedCounterpartyId="cp-uralpak"
        templates={[]}
        versions={[]}
        query=""
        sortMode="recent"
        editor={null}
        onQueryChange={vi.fn()}
        onSortChange={vi.fn()}
        onOpenEditor={vi.fn()}
        onArchive={vi.fn()}
        onActivate={vi.fn()}
        onEditorChange={vi.fn()}
        onSafeFieldChange={vi.fn()}
        onSave={vi.fn()}
        onCancelEdit={vi.fn()}
        mode="counterparty"
        onModeChange={vi.fn()}
        allowEditingActions={false}
      />,
    );

    expect(markup).toContain('placeholder="Название шаблона или число позиций"');
    expect(markup).not.toContain('placeholder="Название, пленка, толщина, сырье, втулка"');
  });

  it('uses the intake position editor for every position in a template', () => {
    const first = createIntakeDraftPosition(1);
    const second = {
      ...createIntakeDraftPosition(2),
      id: 'template-position-2',
      filmType: 'Полотно',
    };
    const markup = renderToStaticMarkup(
      <TemplateDirectorySurface
        selectedCounterpartyId="cp-uralpak"
        templates={[]}
        versions={[]}
        query=""
        sortMode="recent"
        editor={{
          mode: 'add',
          counterpartyId: 'cp-uralpak',
          name: '',
          ownerRole: 'Зав. производства',
          reason: '',
          positions: [first, second],
        }}
        onQueryChange={vi.fn()}
        onSortChange={vi.fn()}
        onOpenEditor={vi.fn()}
        onArchive={vi.fn()}
        onActivate={vi.fn()}
        onEditorChange={vi.fn()}
        onSafeFieldChange={vi.fn()}
        onSave={vi.fn()}
        onCancelEdit={vi.fn()}
        mode="counterparty"
        onModeChange={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Позиции шаблона"');
    expect(markup).toContain('Добавить позицию');
    expect(markup).toContain('Позиция 2');
    expect(markup).toMatch(/<select[^>]*aria-label="Тип пленки, позиция 1"/);
    for (const value of ['Рукав', 'Полотно', 'Полурукав', 'Фальц']) {
      expect(markup).toContain(`<option value="${value}"`);
    }
    expect(markup).not.toMatch(/<input[^>]*aria-label="Тип пленки"/);
  });
});
