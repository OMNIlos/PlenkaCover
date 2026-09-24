import { createRoot } from 'react-dom/client';
import { CommercialOrderOverview } from '../features/commercial/CommercialOrderOverview';
import { CommercialQueue } from '../features/commercial/CommercialQueue';
import type {
  CommercialOrderDetailContract,
  CommercialOrderSummaryContract,
} from '../features/commercial/contracts';
import '../styles.css';
import './commercialPipelineQa.css';

const summary: CommercialOrderSummaryContract = {
  id: 'order-a5',
  orderNumber: 'A-5',
  title: 'Плёнка полиэтиленовая 80 мкм',
  comment: null,
  commentVersion: 1,
  version: 2,
  bucket: 'in_work',
  requestType: 'client_order',
  counterparty: {
    id: 'counterparty-1',
    displayName: 'ПакетПром',
    legalName: 'ООО ПакетПром',
    inn: '7700000000',
  },
  positionCount: 1,
  requestedQty: 2,
  indicators: {
    production: 'not_started',
    warehouseCover: 'needs_production',
    payment: 'unpaid',
    shipment: 'not_shipped',
  },
  commercialCompletion: {
    state: 'incomplete',
    requestedQty: 2,
    fulfilledQty: 0,
    blockingReasons: ['production_incomplete'],
  },
  nextAction: {
    code: 'wait_prepayment',
    ownerRole: 'finance',
    label: 'Ожидать предоплату',
    allowed: false,
  },
  actionPriority: 100,
  createdAt: '2026-07-22T08:00:00.000Z',
  updatedAt: '2026-07-30T08:30:00.000Z',
};

const detail: CommercialOrderDetailContract = {
  ...summary,
  creatorRole: 'commercial',
  commercialStage: 'sent_to_finance',
  ownerRole: 'finance',
  productionOrderId: null,
  financeSummary: {
    invoiceStatus: 'invoiced',
    paymentStatus: 'unpaid',
  },
  edit: {
    parametersAllowed: false,
    parametersAmendable: false,
    parametersLockReason: 'invoice_issued',
    promoteDraftAllowed: false,
    lockedAt: '2026-07-22T09:00:00.000Z',
  },
  warehouseCoverageWorkflowVersion: 2,
  warehouseCoverage: {
    workflowVersion: 2,
    state: 'production_required',
    stateVersion: 2,
    generation: 1,
    availability: 'unavailable',
    reasonCodes: ['no_compatible_rolls'],
    nextOwner: 'system',
    availableActions: [],
    requiredRollCount: 2,
    matchedRollCount: 0,
    uncertainRollCount: 0,
    calculatedAt: '2026-07-30T08:10:00.000Z',
    stale: false,
  },
  positions: [],
  productionProblems: [],
};

function CommercialPipelineQa() {
  return (
    <div className="app-shell commercial-pipeline-qa" data-active-role="commercial">
      <aside className="commercial-live-list-panel">
        <CommercialQueue
          items={[summary]}
          selectedId={summary.id}
          status="ready"
          stale={false}
          error={null}
          hasMore={false}
          onSelect={() => undefined}
          onRetry={() => undefined}
          onLoadMore={() => undefined}
          filters={{ mode: 'Текущие', from: '', to: '' }}
          onFiltersChange={() => undefined}
          onResetFilters={() => undefined}
        />
      </aside>
      <main className="commercial-live-detail-panel">
        <CommercialOrderOverview detail={detail} />
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<CommercialPipelineQa />);
