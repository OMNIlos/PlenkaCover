import type { CommercialOrderPosition, WarehouseCoverProposal } from '../../domain/types';

function positionCoverTitle(position: CommercialOrderPosition): string {
  return `${position.filmType} · ${position.actualThickness} · ${position.rollCount} рул.`;
}

function positionCoverSubtitle(position: CommercialOrderPosition): string {
  const label = [position.birka, position.manualBirka].filter(Boolean).join(' / ') || 'бирка не задана';
  return `${position.rawMaterialLabel} · ${position.spoolType} · ${label}`;
}

export function CommercialCoverProposalList({
  proposals,
  positions,
}: {
  proposals: WarehouseCoverProposal[];
  positions: CommercialOrderPosition[];
}) {
  return (
    <div className="commercial-cover-stack">
      {proposals.map((proposal, index) => {
        const position = positions.find((item) => item.id === proposal.positionId);
        const requested = proposal.coverQty + proposal.missingQty;
        const productionLabel = proposal.productionQty && proposal.productionQty > 0 ? `${proposal.productionQty} рул.` : proposal.missingQty > 0 ? `${proposal.missingQty} рул.` : 'Нет';
        const confirmationLabel = proposal.confirmedAt
          ? `${proposal.confirmedBy ?? 'Коммерция'} · ${proposal.confirmedAt}`
          : 'Ждет коммерцию';
        return (
          <details key={proposal.id} className={`commercial-cover-card ${proposal.confirmedAt ? 'is-confirmed' : ''}`} open={index === 0 && !proposal.confirmedAt}>
            <summary>
              <span className="commercial-cover-position-number">Позиция {index + 1}</span>
              <strong>{position ? positionCoverTitle(position) : `Позиция ${index + 1}`}</strong>
              <small>{position ? positionCoverSubtitle(position) : 'Параметры позиции не найдены'}</small>
              <b>{proposal.coverQty} из {requested} рул.</b>
            </summary>
            <div className="commercial-cover-detail-grid">
              <div><span>Со склада</span><strong>{proposal.coverQty} из {requested} рул.</strong></div>
              <div><span>Резерв</span><strong>{proposal.reserveQty && proposal.reserveQty > 0 ? `${proposal.reserveQty} рул.` : 'Нет'}</strong></div>
              <div><span>Производство</span><strong>{productionLabel}</strong></div>
              <div><span>{proposal.confirmedAt ? 'Принято' : 'Подтверждение'}</span><strong>{confirmationLabel}</strong></div>
              {position && (
                <>
                  <div><span>Толщина</span><strong>{position.actualThickness} факт / {position.accountingThickness} бух.</strong></div>
                  <div><span>Бирка</span><strong>{[position.birka, position.manualBirka].filter(Boolean).join(' / ') || 'Не задана'}</strong></div>
                </>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}
