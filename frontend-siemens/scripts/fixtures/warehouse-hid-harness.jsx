import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import { WarehouseScanStationSurface } from '../../src/components/workbenches/WarehouseScanStationSurface';
import { warehouseWorkObjects } from '../../src/domain/fixtures/warehouse';

const scanObject = warehouseWorkObjects.find((object) => object.id === 'WH-2606-049');
if (!scanObject) throw new Error('Warehouse HID fixture is missing.');

const harnessState = {
  outcome: 'success',
  submissions: [],
  unhandledRejections: [],
};

window.addEventListener('unhandledrejection', (event) => {
  harnessState.unhandledRejections.push(String(event.reason));
});

window.warehouseHidHarness = {
  setOutcome(outcome) {
    harnessState.outcome = outcome;
  },
  snapshot() {
    return {
      submissions: [...harnessState.submissions],
      unhandledRejections: [...harnessState.unhandledRejections],
    };
  },
};

function WarehouseHidHarness() {
  const [selectedObjectId, setSelectedObjectId] = useState(null);

  async function submitScan(payload) {
    harnessState.submissions.push(payload);
    if (harnessState.outcome === 'reject') throw new Error('Controlled scan rejection');
    return harnessState.outcome === 'success';
  }

  return (
    <WarehouseScanStationSurface
      objects={[scanObject]}
      activeSection="Приемка"
      selectedObjectId={selectedObjectId}
      onSelectObject={setSelectedObjectId}
      onScanPayload={submitScan}
      onClearSelection={() => setSelectedObjectId(null)}
    />
  );
}

createRoot(document.getElementById('root')).render(<WarehouseHidHarness />);
