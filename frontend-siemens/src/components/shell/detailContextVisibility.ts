import type { Role } from '../../domain/types';

export function shouldShowInlineContextPanel(
  role: Role,
  {
    isFinanceRegistryPage,
  }: {
    isFinanceRegistryPage: boolean;
  },
) {
  return !(role === 'finance' && isFinanceRegistryPage);
}
