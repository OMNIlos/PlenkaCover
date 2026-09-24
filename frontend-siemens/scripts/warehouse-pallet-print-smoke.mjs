import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8').catch(() => '');

const [panel, helper, resources, workbench, scanSurface, app] = await Promise.all([
  read('src/components/workbenches/PalletLabelPanel.tsx'),
  read('src/components/workbenches/warehousePalletPrint.ts'),
  read('src/components/workbenches/warehousePalletResources.ts'),
  read('src/components/workbenches/warehouseWorkbench.tsx'),
  read('src/components/workbenches/WarehouseScanStationSurface.tsx'),
  read('src/App.tsx'),
]);

const source = [panel, helper, resources, workbench, scanSurface, app].join('\n');

assert.doesNotMatch(source, /window\.print\s*\(/);
assert.match(source, /Задание отправлено/);
assert.match(source, /printerId/);
assert.match(source, /requestId/);
assert.match(source, /Причина повторной печати/);
assert.match(source, /fetchWarehousePalletPreview/);
assert.match(panel, /Палетный лист 100 на 150 мм, одна копия/);
assert.equal((panel.match(/<img\b/g) ?? []).length, 1);
assert.doesNotMatch(workbench, /warehouse-pallet-sheet/);

console.log('Warehouse pallet direct-print source smoke passed.');
