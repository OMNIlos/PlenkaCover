import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addIcons } from '@siemens/ix-icons';
import { describe, expect, it, vi } from 'vitest';

import { PLENKA_ICONS, registerPlenkaIcons } from './registerIcons';

vi.mock('@siemens/ix-icons', () => ({ addIcons: vi.fn() }));

const EXPECTED_ICON_NAMES = [
  'iconAdd',
  'iconAddCircle',
  'iconAppDocumentFilled',
  'iconBoxClosed',
  'iconBoxOpen',
  'iconCalendar',
  'iconCapacityCheck',
  'iconCheck',
  'iconCheckOut',
  'iconChevronLeftSmall',
  'iconChevronRightSmall',
  'iconCloudSuccess',
  'iconClose',
  'iconContextMenu',
  'iconEditDocument',
  'iconFactoryReset',
  'iconGaugechart',
  'iconHand',
  'iconHistory',
  'iconHistoryList',
  'iconInfo',
  'iconLockKey',
  'iconNetworkDevice',
  'iconPackage',
  'iconPlantUser',
  'iconPlayStepwiseFilled',
  'iconPrint',
  'iconProjectNew',
  'iconQrCode',
  'iconReorder',
  'iconRulesFilled',
  'iconSaveAll',
  'iconScale',
  'iconSearch',
  'iconShieldCheck',
  'iconStop',
  'iconTableSettings',
  'iconTableTag',
  'iconTasksOpen',
  'iconTrashcan',
  'iconTruck',
  'iconUserManagementSettingsFilled',
  'iconWarning',
  'iconWarningRhomb',
  'iconWarningSquare',
] as const;

const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(directoryPath: string): string[] {
  return readdirSync(directoryPath, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directoryPath, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : [];
  });
}

function productionSources() {
  // Demo fixtures ship with the application and remain in scope; only test/spec modules are skipped.
  return sourceFiles(SOURCE_ROOT)
    .filter((path) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path))
    .map((path) => ({
      path,
      source: readFileSync(path, 'utf8'),
    }));
}

function registeredIconName(iconData: string): string {
  const name = iconData.match(/<desc>([^<]+)<\/desc>/)?.[1];
  if (!name) throw new Error('Siemens icon data is missing its registry name');
  return name;
}

function literalIconNames(source: string): string[] {
  return [...source.matchAll(/<(?:ix-icon|SiemensIcon)\b[^>]*\bname\s*=\s*(["'])([^"']+)\1/g)].map(
    (match) => match[2],
  );
}

describe('Siemens icon registry', () => {
  it('contains the exact icon union used by the application', () => {
    expect(Object.keys(PLENKA_ICONS)).toHaveLength(45);
    expect(Object.keys(PLENKA_ICONS).sort()).toEqual([...EXPECTED_ICON_NAMES].sort());
  });

  it('registers every literal direct or wrapped Siemens icon name in production source', () => {
    const registeredNames = new Set(Object.values(PLENKA_ICONS).map(registeredIconName));
    const literalNames = new Set(
      productionSources().flatMap(({ source }) => literalIconNames(source)),
    );
    const missingNames = [...literalNames].filter((name) => !registeredNames.has(name)).sort();

    // Dynamic name={...} producers in either supported tag are outside this literal assertion.
    // The exact registry-union assertion above independently prevents accidental registry shrinkage.
    expect(registeredNames.size).toBe(45);
    expect(literalNames.size).toBeGreaterThan(0);
    expect(missingNames).toEqual([]);
  });

  it('registers the icon map idempotently', () => {
    registerPlenkaIcons();
    registerPlenkaIcons();

    expect(addIcons).toHaveBeenCalledTimes(1);
    expect(addIcons).toHaveBeenCalledWith(PLENKA_ICONS);
  });

  it('is invoked exactly once at startup and owns every addIcons call', () => {
    const sources = productionSources();
    const startupCalls = sources.flatMap(
      ({ source }) => source.match(/registerPlenkaIcons\(\);/g) ?? [],
    );
    const nonRegistryRegistrations = sources.filter(
      ({ path, source }) => !path.endsWith('registerIcons.ts') && source.includes('addIcons('),
    );

    expect(startupCalls).toHaveLength(1);
    expect(readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')).toContain(
      'registerPlenkaIcons();',
    );
    expect(nonRegistryRegistrations).toEqual([]);
  });

  it('uses the registered save-all icon for the admin device action', () => {
    const source = readFileSync(
      new URL('../components/workbenches/adminDevicesSurface.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('<ix-icon name="save-all" size="16" />');
    expect(source).not.toContain('<ix-icon name="save"');
  });
});
