import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import { IntakeCreateSurface } from '../src/components/shell/intakeCreateSurface';
import { defaultIntakeDraft } from '../src/domain/prototypeRuntime';

export function mountCounterpartyPickerHarness(container: HTMLElement) {
  function Harness() {
    const [value, setValue] = useState({
      ...defaultIntakeDraft,
      counterparty: '',
      templateId: undefined,
      template: 'Новый шаблон клиента',
    });

    return (
      <IntakeCreateSurface
        value={value}
        onChange={setValue}
        onClose={() => undefined}
        onSubmit={() => undefined}
        counterpartySearchHasMore
        onLoadMoreCounterparties={() => undefined}
      />
    );
  }

  createRoot(container).render(<Harness />);
}
