import { useState } from 'react';

import type { ActionDescriptor, WorkObject } from '../../domain/types';
import { actionDisplayLabel, actionIcon } from '../shell/actionPresentation';
import { SiemensIcon } from '../shell/SiemensIcon';
import { FinanceInvoiceWizard } from './FinanceInvoiceWizard';

export function FinanceInvoiceSyncAction({
  action,
  object,
  onCreated,
}: {
  action: ActionDescriptor;
  object: WorkObject;
  onCreated?: (object: WorkObject) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className="compact-action-button action-recommended finance-command-primary"
        type="button"
        disabled={!action.enabled}
        title={action.helpText ?? action.label}
        onClick={() => setOpen(true)}
      >
        <SiemensIcon name={actionIcon(action)} size="24" />
        <span>{actionDisplayLabel(action)}</span>
      </button>
      {open ? (
        <FinanceInvoiceWizard
          action={action}
          financeOrderId={object.id}
          commercialFinanceNote={object.commercialFinanceNote}
          initialAmount={object.financeAmountValue}
          onClose={() => setOpen(false)}
          onCreated={onCreated}
        />
      ) : null}
    </>
  );
}
