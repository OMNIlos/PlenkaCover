export type PalletListPrintProfile = {
  live: boolean;
  printTransport: 'gateway' | 'browser';
  editorRole: 'current' | 'legacy' | null;
  widthMm: number;
  heightMm: number;
  previewWidthPx: number;
  previewHeightPx: number;
  rotationDegrees: 0 | 90;
  imageWidthMm?: number;
  imageHeightMm?: number;
  imageMarginMm?: number;
  layoutMarker?: string;
};

export const PALLET_LIST_PROFILE_REGISTRY = {
  'pallet-100x150-v1': {
    live: true,
    printTransport: 'gateway',
    editorRole: null,
    widthMm: 100,
    heightMm: 150,
    previewWidthPx: 800,
    previewHeightPx: 1200,
    rotationDegrees: 0,
  },
  'pallet-100x150-compact-v2': {
    live: true,
    printTransport: 'gateway',
    editorRole: null,
    widthMm: 100,
    heightMm: 150,
    previewWidthPx: 800,
    previewHeightPx: 1200,
    rotationDegrees: 0,
  },
  'pallet-100x100-square-v4': {
    live: true,
    printTransport: 'browser',
    editorRole: null,
    widthMm: 100,
    heightMm: 100,
    previewWidthPx: 800,
    previewHeightPx: 800,
    rotationDegrees: 0,
    imageWidthMm: 71.5,
    imageHeightMm: 71.5,
    imageMarginMm: 2,
    layoutMarker: 'square-v4-safe-71_5',
  },
  'pallet-100x100-safe-v5': {
    live: true,
    printTransport: 'browser',
    editorRole: null,
    widthMm: 100,
    heightMm: 100,
    previewWidthPx: 800,
    previewHeightPx: 800,
    rotationDegrees: 0,
    layoutMarker: 'safe-v5-immutable',
  },
  'pallet-100x100-extended-v6': {
    live: true,
    printTransport: 'browser',
    editorRole: 'legacy',
    widthMm: 100,
    heightMm: 100,
    previewWidthPx: 800,
    previewHeightPx: 800,
    rotationDegrees: 0,
    layoutMarker: 'extended-v6-immutable',
  },
  'pallet-100x100-configurable-v7': {
    live: true,
    printTransport: 'browser',
    editorRole: 'current',
    widthMm: 100,
    heightMm: 100,
    previewWidthPx: 800,
    previewHeightPx: 800,
    rotationDegrees: 0,
    imageWidthMm: 96,
    imageHeightMm: 96,
    imageMarginMm: 2,
    layoutMarker: 'configurable-v7-immutable',
  },
} as const satisfies Record<string, PalletListPrintProfile>;

type PalletListProfileRegistry = typeof PALLET_LIST_PROFILE_REGISTRY;

export type PalletListTemplateVersion = keyof PalletListProfileRegistry;

export type BrowserPalletListTemplateVersion = {
  [Version in PalletListTemplateVersion]: PalletListProfileRegistry[Version]['printTransport'] extends 'browser'
    ? Version
    : never;
}[PalletListTemplateVersion];

type EditorPalletListTemplateVersion<Role extends 'current' | 'legacy'> = {
  [Version in PalletListTemplateVersion]: PalletListProfileRegistry[Version]['editorRole'] extends Role
    ? Version
    : never;
}[PalletListTemplateVersion];

function templateVersionForEditorRole<Role extends 'current' | 'legacy'>(
  role: Role,
): EditorPalletListTemplateVersion<Role> {
  const matches = Object.entries(PALLET_LIST_PROFILE_REGISTRY).filter(
    ([, profile]) => profile.editorRole === role,
  );
  if (matches.length !== 1) {
    throw new Error(`Для роли редактора палетного листа «${role}» нужен ровно один профиль.`);
  }
  return matches[0][0] as EditorPalletListTemplateVersion<Role>;
}

export const PALLET_LABEL_LAYOUT_PROFILE = templateVersionForEditorRole('current');
export const LEGACY_PALLET_LABEL_LAYOUT_PROFILE = templateVersionForEditorRole('legacy');

export function isLivePalletListTemplateVersion(
  value: unknown,
): value is PalletListTemplateVersion {
  return (
    typeof value === 'string' &&
    Object.hasOwn(PALLET_LIST_PROFILE_REGISTRY, value) &&
    PALLET_LIST_PROFILE_REGISTRY[value as PalletListTemplateVersion].live
  );
}

export function usesPalletBrowserSystemPrint(
  value: unknown,
): value is BrowserPalletListTemplateVersion {
  return (
    isLivePalletListTemplateVersion(value) &&
    PALLET_LIST_PROFILE_REGISTRY[value].printTransport === 'browser'
  );
}

export function palletListPrintProfile(
  templateVersion: PalletListTemplateVersion,
): PalletListPrintProfile {
  const profile: PalletListPrintProfile | undefined = PALLET_LIST_PROFILE_REGISTRY[templateVersion];
  if (!profile) throw new Error('Неизвестный формат палетного листа.');
  return profile;
}
