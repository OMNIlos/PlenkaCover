import assert from 'node:assert/strict';
import test from 'node:test';

import { warehouseInventoryFixtureResponse } from './warehouse-inventory-smoke-fixture.mjs';

function fixturePage(query) {
  const response = warehouseInventoryFixtureResponse(
    `http://smoke.test/api/warehouse/inventory/rolls?${query}`,
  );
  assert(response && !Array.isArray(response), 'inventory fixture must return a page');
  return response;
}

test('models only backend-reachable warehouse lifecycle combinations', () => {
  const current = fixturePage('view=current&limit=100').items;
  const processed = fixturePage('view=processed&limit=100').items;

  assert.deepEqual([...new Set(current.map((item) => item.lifecycleStatus))].sort(), [
    'available',
    'awaiting_shipment',
    'reserved',
  ]);
  assert(
    current
      .filter((item) => item.origin === 'client')
      .every((item) => item.lifecycleStatus === 'awaiting_shipment'),
  );
  assert(
    current
      .filter((item) => item.origin === 'reserve')
      .every((item) => ['available', 'reserved'].includes(item.lifecycleStatus)),
  );
  assert(
    processed.every((item) => item.origin === 'reserve' && item.lifecycleStatus === 'processed'),
  );
});

test('keeps deterministic cursor and search scenarios', () => {
  const first = fixturePage('view=current&sort=receivedAt&direction=desc&limit=25');
  const second = fixturePage(
    `view=current&sort=receivedAt&direction=desc&limit=25&cursor=${first.nextCursor}`,
  );
  const searched = fixturePage('view=current&q=R-STOCK-001&limit=25');

  assert.equal(first.items.length, 25);
  assert.equal(first.nextCursor, 'qa-inventory-25');
  assert.equal(second.items.length, 2);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 27);
  assert.deepEqual(
    searched.items.map((item) => item.rollCode),
    ['R-STOCK-001'],
  );
});
