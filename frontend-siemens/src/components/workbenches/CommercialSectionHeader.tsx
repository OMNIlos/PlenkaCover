import type { ReactNode } from 'react';

import { SiemensIcon } from '../shell/SiemensIcon';

type CommercialSectionTone = 'positions' | 'basis' | 'warehouse' | 'finance' | 'context';

type CommercialSectionHeaderProps = {
  tone: CommercialSectionTone;
  eyebrow: string;
  title: string;
  description?: string;
  owner?: string;
  status: string;
  statusState?: 'ready' | 'blocked' | 'warning' | 'done';
  children?: ReactNode;
};

function sectionIcon(tone: CommercialSectionTone) {
  if (tone === 'positions') return 'table-settings';
  if (tone === 'basis') return 'rules-filled';
  if (tone === 'warehouse') return 'capacity-check';
  if (tone === 'finance') return 'truck';
  return 'info';
}

export function CommercialSectionHeader({
  tone,
  eyebrow,
  title,
  description,
  owner,
  status,
  statusState = 'ready',
  children,
}: CommercialSectionHeaderProps) {
  return (
    <div className={`commercial-section-header tone-${tone}`} aria-label={description ? `${title}. ${description}` : title}>
      <div className="commercial-section-icon" aria-hidden="true">
        <SiemensIcon name={sectionIcon(tone)} size="24" />
      </div>
      <div className="commercial-section-copy">
        <span className="eyebrow">{eyebrow}</span>
        <h4>{title}</h4>
        <div className="commercial-section-meta" aria-label={`${title}: статус`}>
          {owner && <span className="commercial-owner-chip">{owner}</span>}
          <span className={`commercial-state-badge state-${statusState}`}>{status}</span>
        </div>
      </div>
      {children && <div className="commercial-section-actions">{children}</div>}
    </div>
  );
}
