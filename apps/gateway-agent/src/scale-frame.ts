export interface ParsedScaleFrame {
  weightKg: number;
  /** true/false when the frame carries a stability marker (ST/US); null when it does not. */
  stable: boolean | null;
}

export type ScaleFrameResult =
  | { ok: true; frame: ParsedScaleFrame }
  | { ok: false; reason: string };

// CAS/AND-style continuous frame: "ST,GS,+  43.40kg" / "US,NT, 2.00 kg" / "OL,GS,+9999.9kg".
const MARKED_FRAME = /^(ST|US|OL)\s*,\s*(?:GS|NT)\s*,?\s*([+-]?[\d.,\s]+?)\s*(kg|кг|g|г)?$/i;
// Bare weight frame: "43.40 kg", "+43,40", "1250 g" — no stability information.
const BARE_FRAME = /^([+-]?\d+(?:[.,]\d+)?)\s*(kg|кг|g|г)?$/i;

function toKg(rawWeight: string, unit: string | undefined): number {
  const n = Number(rawWeight.replace(/\s+/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) return NaN;
  return unit && /^(g|г)$/i.test(unit) ? n / 1000 : n;
}

/**
 * Parse one ASCII frame from an RS-232/USB-COM scale (ТВ-М-300 class). Deliberately
 * conservative: an unknown format is a parse FAILURE (the caller reports unstable/offline),
 * never a fake "ready" reading — manual weight entry is forbidden, so a wrong parse here
 * would silently corrupt weights (ТЗ §9).
 */
export function parseScaleFrame(raw: string): ScaleFrameResult {
  const frame = raw.trim();
  if (!frame) return { ok: false, reason: 'empty frame' };

  const marked = MARKED_FRAME.exec(frame);
  if (marked) {
    const [, marker, weight, unit] = marked;
    if (/^OL$/i.test(marker)) return { ok: false, reason: 'overload' };
    const kg = toKg(weight, unit);
    if (!Number.isFinite(kg)) return { ok: false, reason: `unparsable weight in "${frame}"` };
    if (kg < 0) return { ok: false, reason: 'negative weight' };
    return { ok: true, frame: { weightKg: kg, stable: /^ST$/i.test(marker) } };
  }

  const bare = BARE_FRAME.exec(frame);
  if (bare) {
    const kg = toKg(bare[1], bare[2]);
    if (!Number.isFinite(kg)) return { ok: false, reason: `unparsable weight in "${frame}"` };
    if (kg < 0) return { ok: false, reason: 'negative weight' };
    return { ok: true, frame: { weightKg: kg, stable: null } };
  }

  return { ok: false, reason: `unknown frame format "${frame}"` };
}

/**
 * Decode a poll-command string from config into bytes: supports `hex:0D0A` and literal
 * text with \r \n \t escapes (e.g. "P\r\n").
 */
export function decodePollCommand(spec: string): Buffer {
  if (spec.toLowerCase().startsWith('hex:')) {
    return Buffer.from(spec.slice(4).replace(/[^0-9a-f]/gi, ''), 'hex');
  }
  return Buffer.from(
    spec.replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t'),
    'ascii',
  );
}
