import assert from 'node:assert/strict';
import test from 'node:test';

import { entriesForRoute } from './show-ready-audit-support.mjs';

test('console errors are scoped to the role route that emitted them', () => {
  const consoleErrors = [
    'warehouse: GET /api/warehouse/tasks/WH-1 401',
    'admin: GET /api/admin/users 500',
  ];

  assert.deepEqual(entriesForRoute(consoleErrors, 1), [
    'admin: GET /api/admin/users 500',
  ]);
  assert.deepEqual(entriesForRoute(consoleErrors, 2), []);
});

test('request errors are scoped to the role route that emitted them', () => {
  const requestErrors = [
    '401 GET /api/warehouse/tasks/WH-1',
    '500 GET /api/admin/users',
  ];

  assert.deepEqual(entriesForRoute(requestErrors, 1), ['500 GET /api/admin/users']);
});
