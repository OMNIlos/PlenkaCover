import { warehouseInventoryFixtureResponse } from './warehouse-inventory-smoke-fixture.mjs';

export async function installWarehouseApiFixture(page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.fallback();
    const json = (body) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });

    const inventoryResponse = warehouseInventoryFixtureResponse(url);
    if (inventoryResponse !== undefined) {
      return inventoryResponse === null
        ? route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'Складской рулон не найден' }),
          })
        : json(inventoryResponse);
    }
    if (url.pathname === '/api/auth/me') {
      return json({
        userId: 'qa-warehouse',
        role: 'warehouse',
        capabilities: ['warehouse.view'],
        displayName: 'QA Склад',
        isActive: true,
        sessionPurpose: 'full',
        session: {
          id: 'qa-warehouse-session',
          purpose: 'full',
          state: 'active',
          createdAt: '2026-08-07T00:00:00.000Z',
          expiresAt: '2030-01-01T00:00:00.000Z',
          lastSeenAt: null,
        },
        workContext: { kind: 'office', assignment: null },
        passwordChangeRequired: false,
      });
    }
    if (url.pathname === '/api/finance/reconciliation') return json([]);
    if (url.pathname === '/api/warehouse/notifications') {
      return json({ items: [], nextCursor: null, unreadCount: 0 });
    }
    if (url.pathname === '/api/warehouse/raw-materials') return json([]);
    if (url.pathname === '/api/warehouse/cover-checks') {
      return json({ items: [], nextCursor: null });
    }
    if (url.pathname === '/api/warehouse/rolls') return json([]);
    if (url.pathname === '/api/warehouse/intake') {
      return json({
        stats: { todayOps: 0, remainingQr: 1, errors: 0 },
        tasks: [
          {
            taskId: 'qa-role-display-intake',
            operationCode: 'ПР-QA-001',
            orderNumbers: ['WH-2606-042'],
            customerAliases: ['УралПак'],
            orderNumber: 'WH-2606-042',
            customerAlias: 'УралПак',
            status: 'awaiting_rolls',
            expected: 1,
            accepted: 0,
            errors: 0,
            closable: false,
            lastScanResult: null,
            rolls: [],
            activePallet: null,
            palletHistory: [],
            palletHistoryHasMore: false,
            palletList: null,
            createdAt: '2026-08-07T08:00:00.000Z',
            updatedAt: '2026-08-07T08:00:00.000Z',
          },
        ],
        generatedAt: '2026-08-07T08:00:00.000Z',
      });
    }
    if (url.pathname === '/api/warehouse/tasks') return json([]);
    const decisionTaskMatch = /^\/api\/warehouse\/tasks\/([^/]+)$/u.exec(url.pathname);
    if (decisionTaskMatch) {
      return json({
        taskId: decodeURIComponent(decisionTaskMatch[1]),
        status: 'open',
        generation: 1,
        stateVersion: 0,
        updatedAt: '2026-08-07T08:00:00.000Z',
        rows: [],
      });
    }
    if (url.pathname === '/api/material-catalog' || url.pathname === '/api/recipe-catalog') {
      return json([]);
    }

    return route.fallback();
  });
}
