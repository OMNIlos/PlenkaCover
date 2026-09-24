import assert from 'node:assert/strict';
import test from 'node:test';

import { installBusinessPerformanceSmokeFixture } from './business-performance-smoke-fixture.mjs';

async function fixtureResponse(requestPath, fixtureOptions) {
  const handlers = new Map();
  const browserPage = {
    async route(pattern, routeHandler) {
      handlers.set(pattern, routeHandler);
    },
  };

  await installBusinessPerformanceSmokeFixture(browserPage, fixtureOptions);
  const pattern = requestPath.startsWith('/api/director/analytics')
    ? '**/api/director/analytics**'
    : '**/api/commercial/performance/**';
  const handler = handlers.get(pattern);
  assert.equal(typeof handler, 'function');

  let response;
  const route = {
    request() {
      return {
        url() {
          return `https://plenka.test${requestPath}`;
        },
      };
    },
    async fulfill(options) {
      response = { action: 'fulfill', ...options };
    },
    async abort(errorCode) {
      response = { action: 'abort', errorCode };
    },
  };

  await handler(route);
  return {
    ...response,
    json: response?.body ? JSON.parse(response.body) : undefined,
  };
}

test('serves only the exact business-performance endpoint payloads', async () => {
  const cases = [
    {
      path: '/api/commercial/performance/control?from=2026-08-01&to=2026-08-07',
      assertPayload(body) {
        assert.equal(body.summary.invoicedAmount, 840000);
        assert.equal(body.productionSeries.length, 2);
      },
    },
    {
      path: '/api/commercial/performance/control/shift-balances?from=2026-08-01&to=2026-08-07&bucket=day&limit=20',
      assertPayload(body) {
        assert.deepEqual(body.items, []);
        assert.equal(body.nextCursor, null);
      },
    },
    {
      path: '/api/commercial/performance/control/big-bags?from=2026-08-01&to=2026-08-07&bucket=day&limit=20',
      assertPayload(body) {
        assert.deepEqual(body.items, []);
        assert.equal(body.nextCursor, null);
      },
    },
    {
      path: '/api/commercial/performance/finance?limit=20',
      assertPayload(body) {
        assert.deepEqual(body.items, []);
        assert.equal(body.nextCursor, null);
        assert.equal(body.source.kind, 'platform_runtime');
      },
    },
    {
      path: '/api/commercial/performance/production?limit=20',
      assertPayload(body) {
        assert.deepEqual(body.items, []);
        assert.equal(body.nextCursor, null);
        assert.equal(body.source.kind, 'platform_runtime');
      },
    },
    {
      path: '/api/commercial/performance/warehouse?limit=20',
      assertPayload(body) {
        assert.deepEqual(body.items, []);
        assert.equal(body.nextCursor, null);
        assert.equal(body.source.kind, 'platform_runtime');
      },
    },
    {
      path: '/api/commercial/performance/problems?filter=open&limit=20',
      assertPayload(body) {
        assert.equal(body.items.length, 1);
        assert.equal(body.items[0].id, 'smoke-problem');
        assert.equal(body.nextCursor, null);
      },
    },
    {
      path: '/api/commercial/performance/production/production%2Fid/rolls?limit=20',
      assertPayload(body) {
        assert.deepEqual(body.items, []);
        assert.equal(body.nextCursor, null);
      },
    },
  ];

  for (const fixtureCase of cases) {
    const response = await fixtureResponse(fixtureCase.path);
    assert.equal(response.action, 'fulfill', fixtureCase.path);
    assert.equal(response.status, 200, fixtureCase.path);
    assert.equal(response.contentType, 'application/json', fixtureCase.path);
    fixtureCase.assertPayload(response.json);
  }
});

test('fails closed for an unknown business-performance endpoint', async () => {
  const unknownPaths = [
    '/api/commercial/performance/not-a-real-endpoint?limit=20',
    '/api/commercial/performance/nested/control',
    '/api/commercial/performance/production/production-1/rolls/extra',
  ];

  for (const requestPath of unknownPaths) {
    const response = await fixtureResponse(requestPath);
    assert.ok(
      response.action === 'abort' || response.status === 500,
      `${requestPath}: unexpected fixture response: ${JSON.stringify(response)}`,
    );
  }
});

test('accepts an injected current Control snapshot for focused browser contracts', async () => {
  const injected = { contract: 'current-control' };
  const injectedBigBags = { items: [{ id: 'bag-contract' }], nextCursor: null };
  const response = await fixtureResponse('/api/commercial/performance/control', {
    controlResponse: injected,
  });
  const bigBagResponse = await fixtureResponse(
    '/api/commercial/performance/control/big-bags?limit=20',
    { bigBagEvidenceResponse: injectedBigBags },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(response.json, injected);
  assert.equal(bigBagResponse.status, 200);
  assert.deepEqual(bigBagResponse.json, injectedBigBags);
});

test('serves a query-aligned director analytics snapshot for the shared director workspace', async () => {
  const response = await fixtureResponse(
    '/api/director/analytics?from=2026-07-16&to=2026-08-14&bucket=day',
  );

  assert.equal(response.status, 200);
  assert.deepEqual(response.json.range.requested, {
    from: '2026-07-16',
    to: '2026-08-14',
  });
  assert.equal(response.json.range.bucket, 'day');
  assert.deepEqual(response.json.shiftBalances, []);
  assert.equal(response.json.accountingProduction.source.sourceKind, '1C');
});
