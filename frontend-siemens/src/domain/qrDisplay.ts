/**
 * Человеческое отображение QR-содержимого. Payload рулона — самодостаточный JSON
 * (design 2026-07-13 §5), но в UI показываем короткую метку, а не сырую строку.
 */
export function qrDisplayLabel(qr: string | null | undefined): string | null {
  if (!qr) return null;
  const trimmed = qr.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        const roll = (parsed as { roll?: unknown }).roll;
        if (typeof roll === 'string') return `QR · ${roll}`;
        const pallet = (parsed as { pallet?: unknown }).pallet;
        if (typeof pallet === 'string') return `QR · ${pallet}`;
      }
    } catch {
      // не JSON — покажем как есть ниже
    }
    return 'QR-этикетка';
  }
  return trimmed;
}
