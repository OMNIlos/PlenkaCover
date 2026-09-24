import { useState } from 'react';

import { ProductionBigBagSummaryPanel } from './ProductionBigBagSummaryPanel';
import { SafeRawMaterialInventorySurface } from './SafeRawMaterialInventorySurface';

export function ProductionRawMaterialSurface({
  refreshGeneration = 0,
}: {
  refreshGeneration?: string | number;
}) {
  const [manualRefreshGeneration, setManualRefreshGeneration] = useState(0);
  const effectiveRefreshGeneration = `${refreshGeneration}:${manualRefreshGeneration}`;

  return (
    <SafeRawMaterialInventorySurface
      role="production"
      refreshGeneration={effectiveRefreshGeneration}
      headerAction={
        <button
          type="button"
          className="action-secondary"
          aria-label="Обновить сырье и Big-Bag"
          onClick={() => setManualRefreshGeneration((current) => current + 1)}
        >
          Обновить
        </button>
      }
      bigBagRegister={
        <ProductionBigBagSummaryPanel
          refreshGeneration={effectiveRefreshGeneration}
          showRefreshAction={false}
        />
      }
    />
  );
}
