import type { WorkObject } from '../../domain/types';
import { AdminWorkbenchView } from './adminDiagnosticsWorkbench';
import { OperatorWorkbenchView } from './operatorWorkbench';
import { WarehouseWorkbenchView } from './warehouseWorkbench';

export {
  OperatorMachineChangePanel,
  OperatorShiftListSummary,
  OperatorShiftStrip,
  OperatorShiftSurface,
} from './operatorWorkbench';

export function Workbench({
  object,
  onAction,
  pendingActionId,
  hideOperatorRollTable = false,
}: {
  object: WorkObject;
  onAction?: (actionId: string) => void;
  pendingActionId?: string | null;
  hideOperatorRollTable?: boolean;
}) {
  if (!object.workbench) return null;
  if (object.workbench.type === 'operator')
    return (
      <OperatorWorkbenchView
        workbench={object.workbench}
        actions={object.actions}
        onAction={onAction}
        pendingActionId={pendingActionId}
        hideRollTable={hideOperatorRollTable}
      />
    );
  if (object.workbench.type === 'warehouse') return <WarehouseWorkbenchView workbench={object.workbench} actions={object.actions} onAction={onAction} />;
  return <AdminWorkbenchView object={object} workbench={object.workbench} onAction={onAction} />;
}
