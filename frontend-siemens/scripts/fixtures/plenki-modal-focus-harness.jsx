import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import { PlenkiModal } from '../../src/components/plenki-ui/PlenkiPrimitives';
import '../../src/styles.css';

const harnessState = {
  escapeEvents: [],
  scenario: 'usable-autofocus',
};

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  harnessState.escapeEvents.push({ defaultPrevented: event.defaultPrevented });
});

window.plenkiModalFocusHarness = {
  setScenario(scenario) {
    harnessState.scenario = scenario;
  },
  snapshot() {
    return {
      escapeEvents: [...harnessState.escapeEvents],
      modalOpen: document.querySelector('[role="dialog"]') !== null,
      activeTestId: document.activeElement?.getAttribute('data-testid') ?? null,
    };
  },
};

function PlenkiModalFocusHarness() {
  const [open, setOpen] = useState(false);
  const scenario = harnessState.scenario;
  const keepAutofocusAttribute = (element) => element?.setAttribute('autofocus', '');
  const autofocusTarget =
    scenario === 'non-focusable-autofocus' ? (
      <div ref={keepAutofocusAttribute} data-testid="modal-autofocus">
        Недоступная цель автофокуса
      </div>
    ) : (
      <input
        ref={keepAutofocusAttribute}
        data-testid="modal-autofocus"
        autoFocus
        disabled={scenario === 'disabled-autofocus'}
        hidden={scenario === 'hidden-autofocus'}
      />
    );

  return (
    <>
      <main style={{ position: 'relative', zIndex: 1, minHeight: '100vh' }}>
        <button
          data-testid="modal-trigger"
          type="button"
          style={{ position: 'fixed', top: 16, right: 16 }}
          onClick={() => setOpen(true)}
        >
          Открыть диалог
        </button>
        {open ? (
          <PlenkiModal
            title="Проверка фокуса"
            onClose={() => setOpen(false)}
            footer={
              scenario === 'contenteditable-last' ? (
                <div
                  aria-label="Последний редактор"
                  contentEditable
                  data-testid="modal-contenteditable-last"
                  suppressContentEditableWarning
                >
                  Редактор
                </div>
              ) : (
                <button data-testid="modal-last" type="button">
                  Последнее действие
                </button>
              )
            }
          >
            <label>
              Поле назначения
              {autofocusTarget}
            </label>
            <button data-testid="modal-middle" type="button">
              Среднее действие
            </button>
          </PlenkiModal>
        ) : null}
      </main>
      <div
        aria-hidden="true"
        data-testid="stacking-context-obstruction"
        style={{
          position: 'fixed',
          inset: '0 50% 0 0',
          zIndex: 10,
          background: 'var(--surface-1)',
        }}
      />
    </>
  );
}

createRoot(document.getElementById('root')).render(<PlenkiModalFocusHarness />);
