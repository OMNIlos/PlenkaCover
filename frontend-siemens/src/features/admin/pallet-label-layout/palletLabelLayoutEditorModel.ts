import {
  PALLET_LABEL_LAYOUT_SCHEMA_VERSION,
  PALLET_LABEL_LAYOUT_ELEMENT_IDS,
  createBasePalletLabelLayout,
  parsePalletLabelLayout,
  type PalletLabelEditorCanvas,
  type PalletLabelLayout,
  type PalletLabelLayoutElement,
  type PalletLabelLayoutElementId,
  type PalletLabelLayoutServerDiagnostics,
} from '../../../domain/palletLabelLayoutContract';

export const PALLET_LABEL_LAYOUT_STORAGE_KEY = 'plenki:admin:pallet-label-layout-draft:v2';

export type PalletLabelLayoutDraftEnvelope = {
  kind: 'plenka-pallet-label-layout-draft';
  schemaVersion: typeof PALLET_LABEL_LAYOUT_SCHEMA_VERSION;
  sourceDocumentId: string;
  layout: PalletLabelLayout;
};

export type PalletLabelLayoutHistory = {
  past: PalletLabelLayout[];
  present: PalletLabelLayout;
  future: PalletLabelLayout[];
};

export type PalletLabelLayoutDiagnostics = {
  beyondProvenCut: PalletLabelLayoutElementId[];
  outsideSafeArea: PalletLabelLayoutElementId[];
  overlaps: Array<[PalletLabelLayoutElementId, PalletLabelLayoutElementId]>;
};

const MAX_HISTORY = 50;

function cloneLayout(layout: PalletLabelLayout): PalletLabelLayout {
  return { ...layout, elements: layout.elements.map((element) => ({ ...element })) };
}

function sameLayout(left: PalletLabelLayout, right: PalletLabelLayout): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} имеет неверный формат.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  input: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
) {
  const allowed = new Set(allowedKeys);
  const unknownKey = Object.keys(input).find((key) => !allowed.has(key));
  if (unknownKey) throw new Error(`${label} содержит неизвестное поле «${unknownKey}».`);
}

export function isPalletLabelLayoutPublishable(
  local: PalletLabelLayoutDiagnostics,
  server: PalletLabelLayoutServerDiagnostics | null,
): boolean {
  if (!server) return false;
  return (
    local.outsideSafeArea.length === 0 &&
    local.overlaps.length === 0 &&
    local.beyondProvenCut.length === 0 &&
    server.outsideSafeArea.length === 0 &&
    server.overlaps.length === 0 &&
    server.belowProvenCut.length === 0
  );
}

export function palletLabelLayoutPreviewKey(
  sourceDocumentId: string,
  layout: PalletLabelLayout,
): string {
  return JSON.stringify({ sourceDocumentId, layout });
}

function snap(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function updateLayoutElement(
  layout: PalletLabelLayout,
  id: PalletLabelLayoutElementId,
  patch: Partial<
    Pick<PalletLabelLayoutElement, 'xDots' | 'yDots' | 'widthDots' | 'heightDots' | 'maxFontSize'>
  >,
  canvas: PalletLabelEditorCanvas,
): PalletLabelLayout {
  const current = layout.elements.find((element) => element.id === id);
  if (!current || current.locked || current.kind === 'qr') return layout;

  const grid = canvas.dotsPerMm;
  const minimumSize = grid * 3;
  const candidateX =
    patch.xDots === undefined
      ? current.xDots
      : clamp(snap(patch.xDots, grid), 0, canvas.widthDots - minimumSize);
  const candidateY =
    patch.yDots === undefined
      ? current.yDots
      : clamp(snap(patch.yDots, grid), 0, canvas.heightDots - minimumSize);
  const widthDots =
    patch.widthDots === undefined
      ? current.widthDots
      : clamp(snap(patch.widthDots, grid), minimumSize, canvas.widthDots - candidateX);
  const heightDots =
    patch.heightDots === undefined
      ? current.heightDots
      : clamp(snap(patch.heightDots, grid), minimumSize, canvas.heightDots - candidateY);
  const adjustedX = clamp(candidateX, 0, canvas.widthDots - widthDots);
  const adjustedY = clamp(candidateY, 0, canvas.heightDots - heightDots);
  const maxFontSize = clamp(
    Math.round(patch.maxFontSize ?? current.maxFontSize),
    current.minFontSize,
    96,
  );
  const next = {
    ...current,
    xDots: adjustedX,
    yDots: adjustedY,
    widthDots,
    heightDots,
    maxFontSize,
  };
  if (JSON.stringify(next) === JSON.stringify(current)) return layout;
  return {
    ...layout,
    elements: layout.elements.map((element) => (element.id === id ? next : element)),
  };
}

export function moveLayoutElement(
  layout: PalletLabelLayout,
  id: PalletLabelLayoutElementId,
  xDots: number,
  yDots: number,
  canvas: PalletLabelEditorCanvas,
): PalletLabelLayout {
  return updateLayoutElement(layout, id, { xDots, yDots }, canvas);
}

export function resizeLayoutElement(
  layout: PalletLabelLayout,
  id: PalletLabelLayoutElementId,
  widthDots: number,
  heightDots: number,
  canvas: PalletLabelEditorCanvas,
): PalletLabelLayout {
  return updateLayoutElement(layout, id, { widthDots, heightDots }, canvas);
}

export function removeLayoutElement(
  layout: PalletLabelLayout,
  id: PalletLabelLayoutElementId,
): PalletLabelLayout {
  if (id === 'qr' || !layout.elements.some((element) => element.id === id)) return layout;
  return { ...layout, elements: layout.elements.filter((element) => element.id !== id) };
}

export function restoreLayoutElement(
  layout: PalletLabelLayout,
  id: PalletLabelLayoutElementId,
): PalletLabelLayout {
  if (id === 'qr' || layout.elements.some((element) => element.id === id)) return layout;
  const canonical = createBasePalletLabelLayout().elements.find((element) => element.id === id);
  if (!canonical) return layout;
  const byId = new Map(layout.elements.map((element) => [element.id, element]));
  byId.set(id, canonical);
  return {
    ...layout,
    elements: PALLET_LABEL_LAYOUT_ELEMENT_IDS.flatMap((elementId) => {
      const element = byId.get(elementId);
      return element ? [element] : [];
    }),
  };
}

function elementsOverlap(left: PalletLabelLayoutElement, right: PalletLabelLayoutElement): boolean {
  return (
    left.xDots < right.xDots + right.widthDots &&
    left.xDots + left.widthDots > right.xDots &&
    left.yDots < right.yDots + right.heightDots &&
    left.yDots + left.heightDots > right.yDots
  );
}

export function analyzePalletLabelLayout(
  layout: PalletLabelLayout,
  canvas: PalletLabelEditorCanvas,
): PalletLabelLayoutDiagnostics {
  const beyondProvenCut = layout.elements
    .filter((element) => element.yDots + element.heightDots > canvas.provenCutYDots)
    .map((element) => element.id);
  const safeMaxX = canvas.widthDots - canvas.safeInsetDots;
  const safeMaxY = canvas.heightDots - canvas.safeInsetDots;
  const outsideSafeArea = layout.elements
    .filter(
      (element) =>
        element.xDots < canvas.safeInsetDots ||
        element.yDots < canvas.safeInsetDots ||
        element.xDots + element.widthDots > safeMaxX ||
        element.yDots + element.heightDots > safeMaxY,
    )
    .map((element) => element.id);
  const overlaps: PalletLabelLayoutDiagnostics['overlaps'] = [];
  for (let leftIndex = 0; leftIndex < layout.elements.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < layout.elements.length; rightIndex += 1) {
      const left = layout.elements[leftIndex];
      const right = layout.elements[rightIndex];
      if (elementsOverlap(left, right)) overlaps.push([left.id, right.id]);
    }
  }
  return { beyondProvenCut, outsideSafeArea, overlaps };
}

export function createLayoutHistory(layout: PalletLabelLayout): PalletLabelLayoutHistory {
  return { past: [], present: cloneLayout(layout), future: [] };
}

export function commitLayoutHistory(
  history: PalletLabelLayoutHistory,
  layout: PalletLabelLayout,
): PalletLabelLayoutHistory {
  if (sameLayout(history.present, layout)) return history;
  return {
    past: [...history.past, cloneLayout(history.present)].slice(-MAX_HISTORY),
    present: cloneLayout(layout),
    future: [],
  };
}

export function undoLayoutHistory(history: PalletLabelLayoutHistory): PalletLabelLayoutHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: cloneLayout(previous),
    future: [cloneLayout(history.present), ...history.future].slice(0, MAX_HISTORY),
  };
}

export function redoLayoutHistory(history: PalletLabelLayoutHistory): PalletLabelLayoutHistory {
  const next = history.future[0];
  if (!next) return history;
  return {
    past: [...history.past, cloneLayout(history.present)].slice(-MAX_HISTORY),
    present: cloneLayout(next),
    future: history.future.slice(1),
  };
}

export function serializePalletLayoutDraft(input: {
  sourceDocumentId: string;
  layout: PalletLabelLayout;
}): string {
  const envelope: PalletLabelLayoutDraftEnvelope = {
    kind: 'plenka-pallet-label-layout-draft',
    schemaVersion: 2,
    sourceDocumentId: input.sourceDocumentId,
    layout: input.layout,
  };
  return JSON.stringify(envelope, null, 2);
}

export function parsePalletLayoutDraft(
  json: string,
  canvas: PalletLabelEditorCanvas,
): PalletLabelLayoutDraftEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('Файл не является корректным JSON.');
  }
  const input = record(value, 'Черновик');
  assertExactKeys(input, ['kind', 'schemaVersion', 'sourceDocumentId', 'layout'], 'Черновик');
  if (
    input.kind !== 'plenka-pallet-label-layout-draft' ||
    input.schemaVersion !== PALLET_LABEL_LAYOUT_SCHEMA_VERSION ||
    typeof input.sourceDocumentId !== 'string'
  ) {
    throw new Error('Версия файла черновика не поддерживается.');
  }
  return {
    kind: 'plenka-pallet-label-layout-draft',
    schemaVersion: 2,
    sourceDocumentId: input.sourceDocumentId,
    layout: parsePalletLabelLayout(input.layout, canvas),
  };
}

export function dotsToMillimeters(dots: number, canvas: PalletLabelEditorCanvas): number {
  return Number((dots / canvas.dotsPerMm).toFixed(3));
}

export function millimetersToDots(mm: number, canvas: PalletLabelEditorCanvas): number {
  return Math.round(mm * canvas.dotsPerMm);
}
