import type { ActionDescriptor, Fact, WorkObject } from '../../domain/types';

export function factValue(object: WorkObject, label: string) {
  const direct = object.facts.find((fact) => fact.label === label)?.value;
  if (direct) return direct;
  return object.sections.flatMap((section) => section.facts).find((fact) => fact.label === label)?.value;
}

export function directorSyntheticObject({
  id,
  title,
  statusLabel,
  severity,
  facts,
  sections,
  actions,
  problemTitle,
  problemReason,
  recovery,
  auditLabel,
  auditDetail,
  time,
}: {
  id: string;
  title: string;
  statusLabel: string;
  severity: WorkObject['severity'];
  facts: Fact[];
  sections: WorkObject['sections'];
  actions: ActionDescriptor[];
  problemTitle: string;
  problemReason: string;
  recovery: string;
  auditLabel: string;
  auditDetail: string;
  time: string;
}): WorkObject {
  return {
    id,
    kind: 'directorDecision',
    title,
    statusLabel,
    nextOwner: 'Директор',
    severity,
    facts,
    sections,
    actions,
    problems: [
      {
        id: `p-${id}`,
        objectId: id,
        stage: statusLabel,
        title: problemTitle,
        severity,
        ownerRole: 'Директор',
        due: 'сегодня',
        reason: problemReason,
        recovery,
        status: 'open',
      },
    ],
    audit: [
      {
        id: `a-${id}`,
        objectId: id,
        time,
        actorLabel: 'Система',
        actionLabel: auditLabel,
        detail: auditDetail,
      },
    ],
  };
}
