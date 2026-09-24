import type { MeResponse } from '../../api/auth';
import type { PermissionPolicy, UserSession } from '../../domain/types';
import { AccountCabinet } from '../../components/shell/appShell';

export function commercialSessionFromMe(
  me: MeResponse,
  preferences: Pick<UserSession, 'notificationSound' | 'reducedMotion'>,
): UserSession {
  return {
    id: me.userId,
    name: me.displayName ?? 'Сотрудник коммерции',
    role: 'commercial',
    workplace: me.workContext.assignment?.workplace ?? null,
    shift: me.workContext.assignment?.shift ?? null,
    status: me.isActive && me.session?.state === 'active' ? 'active' : 'blocked',
    sessionExpiresAt: me.session?.expiresAt ?? null,
    sessionState: me.session?.state ?? null,
    ...preferences,
  };
}

export function CommercialProfilePanel(props: {
  session: UserSession;
  policy: PermissionPolicy;
  onToggleSound: () => void;
  onToggleReducedMotion: () => void;
  onLogout: () => void;
  onClose: () => void;
}) {
  return <AccountCabinet {...props} />;
}
