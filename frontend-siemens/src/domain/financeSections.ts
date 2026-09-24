export const FINANCE_SECTIONS = ['Счета', 'Рассрочка', 'Сырьё', 'Просрочки'] as const;

export type FinanceSection = (typeof FINANCE_SECTIONS)[number];

const LEGACY_FINANCE_SECTIONS: Record<string, FinanceSection> = {
  Обзор: 'Счета',
  Оплаты: 'Счета',
  История: 'Счета',
  'Сверка источников': 'Счета',
  Исключения: 'Просрочки',
  Сырье: 'Сырьё',
};

export function normalizeFinanceSection(section: string): FinanceSection {
  if (FINANCE_SECTIONS.includes(section as FinanceSection)) return section as FinanceSection;
  return LEGACY_FINANCE_SECTIONS[section] ?? 'Счета';
}
