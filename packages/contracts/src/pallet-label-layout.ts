export const PALLET_LABEL_CONFIGURABLE_PROFILE = 'pallet-100x100-configurable-v7' as const;
export const PALLET_LABEL_LAYOUT_EDITOR_PROFILE = PALLET_LABEL_CONFIGURABLE_PROFILE;
export const PALLET_LABEL_LAYOUT_DEFINITION_MAX_BYTES = 16_384;

/** Historical schema V1 ids. They remain readable but are never offered by the editor. */
export const PALLET_LABEL_LAYOUT_LEGACY_BLOCK_IDS = [
  'header',
  'identity',
  'product',
  'rollCodes',
  'qr',
  'summary',
  'packaging',
  'storage',
] as const;

/** The complete, closed catalog for schema V2 and every new draft/publication. */
export const PALLET_LABEL_LAYOUT_BLOCK_IDS = [
  'order',
  'customer',
  'formedAt',
  'rollCount',
  'qr',
  'storage',
] as const;

export type PalletLabelLayoutLegacyBlockId =
  (typeof PALLET_LABEL_LAYOUT_LEGACY_BLOCK_IDS)[number];
export type PalletLabelLayoutBlockId = (typeof PALLET_LABEL_LAYOUT_BLOCK_IDS)[number];
export type PalletLabelLayoutPersistedBlockId =
  | PalletLabelLayoutLegacyBlockId
  | PalletLabelLayoutBlockId;
export type PalletLabelLayoutBlockKind = 'text' | 'list' | 'qr';

type PalletLabelLayoutElementBase<
  TId extends PalletLabelLayoutPersistedBlockId,
  TKind extends PalletLabelLayoutBlockKind,
> = {
  id: TId;
  kind: TKind;
  xDots: number;
  yDots: number;
  widthDots: number;
  heightDots: number;
  maxFontSize: number;
  minFontSize: number;
  locked: boolean;
};

export type PalletLabelLayoutElementV1 = PalletLabelLayoutElementBase<
  PalletLabelLayoutLegacyBlockId,
  PalletLabelLayoutBlockKind
>;

export type PalletLabelLayoutElementV2 = PalletLabelLayoutElementBase<
  PalletLabelLayoutBlockId,
  'text' | 'qr'
>;

export type PalletLabelLayoutDefinitionV1 = {
  schemaVersion: 1;
  profile: typeof PALLET_LABEL_LAYOUT_EDITOR_PROFILE;
  elements: PalletLabelLayoutElementV1[];
};

export type PalletLabelLayoutDefinitionV2 = {
  schemaVersion: 2;
  profile: typeof PALLET_LABEL_LAYOUT_EDITOR_PROFILE;
  elements: PalletLabelLayoutElementV2[];
};

export type PalletLabelLayoutDefinition =
  | PalletLabelLayoutDefinitionV1
  | PalletLabelLayoutDefinitionV2;

/** Frontend-friendly aliases are deliberately V2-only. */
export type EditablePalletLabelLayoutDefinition = PalletLabelLayoutDefinitionV2;
export type PalletLabelLayoutElement = PalletLabelLayoutElementV2;
export type PalletLabelLayout = PalletLabelLayoutDefinitionV2;

export const PALLET_LABEL_LAYOUT_EDITOR_SOURCE_KINDS = ['control', 'document'] as const;
export type PalletLabelLayoutEditorSourceKind =
  (typeof PALLET_LABEL_LAYOUT_EDITOR_SOURCE_KINDS)[number];

export type PalletLabelLayoutEditorSource = {
  documentId: string;
  /** Server-owned source used to keep the editor operable after order-history purge. */
  kind: PalletLabelLayoutEditorSourceKind;
  /** Human-readable source purpose; never an order, customer or device value for control. */
  label: string;
  palletId: string;
  createdAt: string;
  rollCount: number;
};

export type PalletLabelLayoutEditorBootstrap = {
  schemaVersion: 2;
  profile: typeof PALLET_LABEL_LAYOUT_EDITOR_PROFILE;
  canvas: {
    widthDots: 800;
    heightDots: 800;
    dotsPerMm: 8;
    safeInsetDots: 20;
    provenCutYDots: 570;
  };
  editorLayout: PalletLabelLayoutDefinitionV2;
  activePublication: PalletLabelLayoutPublication | null;
  sources: PalletLabelLayoutEditorSource[];
};

export type PalletLabelLayoutEditorPreviewRequest = {
  sourceDocumentId: string;
  layout: PalletLabelLayoutDefinitionV2;
};

export type PalletLabelLayoutEditorDiagnostics = {
  belowProvenCut: PalletLabelLayoutBlockId[];
  outsideSafeArea: PalletLabelLayoutBlockId[];
  overlaps: Array<{
    first: PalletLabelLayoutBlockId;
    second: PalletLabelLayoutBlockId;
  }>;
};

export type PalletLabelLayoutPublication = {
  id: string;
  version: number;
  contentHash: string;
  activatedAt: string;
  layout: PalletLabelLayoutDefinition;
};

export type PublishPalletLabelLayoutCommand = {
  operationKey: string;
  expectedActivePublicationId: string | null;
  sourceDocumentId: string;
  reason: string;
  layout: PalletLabelLayoutDefinitionV2;
};

export type PublishPalletLabelLayoutResult = {
  publication: PalletLabelLayoutPublication;
  replayed: boolean;
};
