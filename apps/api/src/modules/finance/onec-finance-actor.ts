import type { Role } from '@plenka/contracts';
import type { AuditActorWriteInput, AuditWriteActor } from '../../common/audit/audit-actor';

export interface OneCFinanceActor {
  userId: string | null;
  role: Role;
  auditActor?: AuditWriteActor;
}

export function financeAuditActor(actor: OneCFinanceActor): AuditActorWriteInput {
  return actor.auditActor
    ? { actor: actor.auditActor }
    : { actorRole: actor.role, actorId: actor.userId };
}
