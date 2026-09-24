import type { CommercialCompletionContract } from './contracts';

export const COMMERCIAL_COMPLETION_LABELS: Record<CommercialCompletionContract['state'], string> = {
  incomplete: 'В исполнении',
  ready_for_shipment: 'Готов к отгрузке',
  shipped: 'Отгружен',
};
