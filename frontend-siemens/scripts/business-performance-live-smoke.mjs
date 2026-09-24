import {
  SHARED_BUSINESS_SECTIONS,
  assertBusinessPerformanceRoleParity,
  assertSafeBusinessRollPage,
} from './business-performance-live-smoke-contract.mjs';

function normalizedText(value) {
  return value.replace(/\s+/gu, ' ').trim();
}

function dateAtOffset(offsetDays) {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + offsetDays);
  return value.toISOString().slice(0, 10);
}

export function createBusinessPerformanceLiveSmoke({
  apiRequest,
  assert,
  focusRefresh,
  refreshRolePage = focusRefresh,
  openTopNavigationSection,
  waitUntil,
}) {
  const range = { from: dateAtOffset(-2), to: dateAtOffset(1) };

  function endpoint(section, role) {
    if (section === 'Склад') {
      const contour = role === 'director' ? 'director' : 'commercial';
      return `/api/${contour}/performance/warehouse?page=1&pageSize=100`;
    }
    const params = new URLSearchParams({ from: range.from, to: range.to });
    if (section === 'Контроль') {
      params.set('bucket', 'day');
      return `/api/commercial/performance/control?${params}`;
    }
    if (section === 'Проблемы') {
      return '/api/commercial/performance/problems?filter=all&limit=100';
    }
    const name = {
      Финансы: 'finance',
      Производство: 'production',
      Склад: 'warehouse',
    }[section];
    assert(name, `Unknown business-performance section: ${section}`);
    params.set('limit', '100');
    return `/api/commercial/performance/${name}?${params}`;
  }

  async function loadRolePair(section, sessions) {
    const commercialPath = endpoint(section, 'commercial');
    const directorPath = endpoint(section, 'director');
    const [commercial, director] = await Promise.all([
      apiRequest(commercialPath, { token: sessions.commercial.token }),
      apiRequest(directorPath, { token: sessions.director.token }),
    ]);
    assertBusinessPerformanceRoleParity(section, commercial, director);
    return commercial;
  }

  async function assertApiContract(sessions, orderNumber, productionOrderId) {
    const snapshots = {};
    for (const section of SHARED_BUSINESS_SECTIONS) {
      snapshots[section] = await loadRolePair(section, sessions);
    }

    const financeItem = snapshots.Финансы.items.find((item) => item.orderNumber === orderNumber);
    assert(
      financeItem?.paymentPlanKind === 'full' && financeItem.paymentPlanLabel === '100%',
      `Shared finance did not expose the persisted 100% payment policy for ${orderNumber}`,
    );
    assert(
      snapshots.Производство.items.some(
        (item) => item.id === productionOrderId && item.orderNumber === orderNumber,
      ),
      `Shared production omitted ${orderNumber}`,
    );

    const rollPath =
      `/api/commercial/performance/production/${encodeURIComponent(productionOrderId)}` +
      '/rolls?limit=100';
    const [commercialRolls, directorRolls] = await Promise.all([
      apiRequest(rollPath, { token: sessions.commercial.token }),
      apiRequest(rollPath, { token: sessions.director.token }),
    ]);
    assertSafeBusinessRollPage(commercialRolls);
    assertSafeBusinessRollPage(directorRolls);
    assert(
      JSON.stringify(commercialRolls) === JSON.stringify(directorRolls),
      `${orderNumber} roll drilldown differs between commercial and director`,
    );
    assert(
      commercialRolls.items.some(
        (item) =>
          item.orderNumber === orderNumber &&
          item.parameters.filmType &&
          item.parameters.actualThicknessUm !== null &&
          item.parameters.accountingThicknessUm !== null &&
          item.parameters.widthMm !== null &&
          item.parameters.plannedLengthM !== null &&
          item.parameters.weightKg !== null,
      ),
      `${orderNumber} roll drilldown omitted safe business parameters`,
    );
  }

  async function openSection(page, section) {
    await openTopNavigationSection(page, section);
    await refreshRolePage(page);
    const selector =
      section === 'Проблемы' ? '.commercial-problems' : '.commercial-performance-workspace';
    const workspace = page.locator(selector);
    await waitUntil(`${section} shared workspace ready`, async () => {
      if ((await workspace.count()) !== 1 || !(await workspace.isVisible())) return false;
      const text = await workspace.innerText();
      return (
        text.includes(section) &&
        !text.includes('Загрузка показателей') &&
        !text.includes('Загрузка проблем')
      );
    });
    return workspace;
  }

  async function assertUiSection(pages, section, orderNumber) {
    const [commercial, director] = await Promise.all([
      openSection(pages.commercial, section),
      openSection(pages.director, section),
    ]);
    const directorOnlyLabels = [
      'Назначить владельца',
      'Поднять приоритет',
      'Вернуть производству',
      'Подтвердить исключение',
      'Подтвердить складское исключение',
      'Вернуть складу',
    ];
    const commercialButtons = await commercial.getByRole('button').allTextContents();
    assert(
      directorOnlyLabels.every((label) => !commercialButtons.includes(label)),
      `Commercial ${section} exposed a director-only action`,
    );

    if (section === 'Контроль') {
      await Promise.all([
        commercial.getByRole('button', { name: 'Таблица', exact: true }).click(),
        director.getByRole('button', { name: 'Таблица', exact: true }).click(),
      ]);
      const expected = [
        'Период',
        'Изготовлено, рул.',
        'Изготовлено, кг',
        'Рулонов с браком',
        'Брак, кг',
      ];
      for (const [role, workspace] of [
        ['commercial', commercial],
        ['director', director],
      ]) {
        const table = workspace.locator(
          '.director-production-quality-panel[aria-label="Производство и брак"] table',
        );
        assert((await table.count()) === 1, `${role} Control production table is not exact`);
        const headings = (await table.locator('th[scope="col"]').allTextContents()).map(
          normalizedText,
        );
        assert(
          JSON.stringify(headings) === JSON.stringify(expected),
          `${role} Control production columns are not exact: ${JSON.stringify(headings)}`,
        );
      }
    }

    const [commercialText, directorText] = await Promise.all([
      section === 'Проблемы'
        ? commercial.innerText()
        : commercial.locator('.commercial-performance-content').innerText(),
      section === 'Проблемы'
        ? director.innerText()
        : director.locator('.commercial-performance-content').innerText(),
    ]);
    const directorRefresh = director.locator('.director-refresh-button');
    const directorRefreshText =
      (await directorRefresh.count()) === 1 ? await directorRefresh.innerText() : '';
    const normalizedCommercialText = normalizedText(commercialText);
    const normalizedDirectorText = normalizedText(
      directorRefreshText ? directorText.replace(directorRefreshText, '') : directorText,
    );
    assert(
      normalizedCommercialText === normalizedDirectorText,
      `${section} rendered business content differs between commercial and director: ${JSON.stringify(
        {
          commercial: normalizedCommercialText,
          director: normalizedDirectorText,
        },
      )}`,
    );
    if (section === 'Финансы') {
      assert(
        commercialText.includes(orderNumber) && commercialText.includes('100%'),
        `Shared Finance omitted ${orderNumber} or its payment label`,
      );
    }
  }

  async function assertProductionDrilldown(pages, orderNumber) {
    const workspaces = await Promise.all([
      openSection(pages.commercial, 'Производство'),
      openSection(pages.director, 'Производство'),
    ]);
    const drilldownTexts = [];
    for (const [role, workspace] of [
      ['commercial', workspaces[0]],
      ['director', workspaces[1]],
    ]) {
      const toggle = workspace
        .locator('.production-roll-drilldown-toggle')
        .filter({ hasText: orderNumber })
        .first();
      await toggle.click();
      const table = workspace.locator('.production-roll-drilldown-table');
      await table.waitFor({ state: 'visible' });
      const headings = (await table.locator('th[scope="col"]').allTextContents()).map(
        normalizedText,
      );
      assert(
        JSON.stringify(headings) ===
          JSON.stringify([
            'Рулон',
            'Заказ',
            'Параметры',
            'Оператор',
            'Станок',
            'Приоритет',
            'План нетто',
            'Факт нетто',
            'Факт брутто',
            'Отклонение',
            'Статус',
            'Себестоимость',
          ]),
        `${role} roll drilldown columns are not exact`,
      );
      const chips = (await table.locator('.production-roll-parameter-chip').allTextContents()).map(
        normalizedText,
      );
      for (const prefix of ['Тип:', 'Факт:', 'Бух.:', 'Ширина:', 'Метраж:', 'Вес:']) {
        assert(
          chips.some((chip) => chip.startsWith(prefix)),
          `${role} roll drilldown omitted the ${prefix} semantic chip`,
        );
      }
      const drilldownText = normalizedText(await table.innerText());
      assert(
        drilldownText.includes('План, актуально сейчас') ||
          drilldownText.includes('Версия') ||
          drilldownText.includes('Не рассчитана:'),
        `${role} roll drilldown omitted the cost basis`,
      );
      drilldownTexts.push(drilldownText);
    }
    assert(
      drilldownTexts[0] === drilldownTexts[1],
      `${orderNumber} roll drilldown content differs between commercial and director`,
    );
  }

  async function assertDirectorOnlyBoundary(pages) {
    const directorOnlySections = ['Зарплаты', 'Аудит / QR'];
    const [commercialNavigationLabels, directorNavigationLabels] = await Promise.all([
      pages.commercial.locator('.section-nav-button, .role-top-nav-item').allTextContents(),
      pages.director.locator('.section-nav-button, .role-top-nav-item').allTextContents(),
    ]);
    const commercialNavigation = commercialNavigationLabels.join('\n');
    const directorNavigation = directorNavigationLabels.join('\n');
    for (const section of directorOnlySections) {
      assert(
        !commercialNavigation.includes(section),
        `Commercial navigation exposed director-only ${section}`,
      );
      assert(
        directorNavigation.includes(section),
        `Director navigation omitted director-only ${section}`,
      );
    }
    assert(
      !directorNavigationLabels.some((label) => normalizedText(label) === 'Требуют решения'),
      'Director navigation retained the obsolete decision-queue route',
    );
    assert(
      !directorNavigationLabels.some((label) => normalizedText(label) === 'Себестоимость'),
      'Director navigation retained the removed standalone roll-cost route',
    );
    const normalizedDirectorLabels = directorNavigationLabels.map(normalizedText);
    assert(
      normalizedDirectorLabels.indexOf('Зарплаты') ===
        normalizedDirectorLabels.indexOf('Производство') + 1,
      'Director navigation must place Зарплаты directly after Производство',
    );
  }

  async function assertProblemsRefresh(pages, marker) {
    const workspaces = await Promise.all([
      openSection(pages.commercial, 'Проблемы'),
      openSection(pages.director, 'Проблемы'),
    ]);
    assert(
      (await workspaces[0].innerText()).includes(marker) === false &&
        (await workspaces[1].innerText()).includes(marker) === false,
      'The unique problem marker existed before the live-refresh fixture was created',
    );

    return async function verifyRefresh(sessions, expectedProblemId) {
      for (const [role, page] of [
        ['commercial', pages.commercial],
        ['director', pages.director],
      ]) {
        await refreshRolePage(page);
        const exactProblem = page.locator(
          `.commercial-problem-row[data-problem-id="${expectedProblemId}"]`,
        );
        await waitUntil(
          `${role} Problems refreshes after focus`,
          async () => (await exactProblem.count()) === 1 && (await exactProblem.isVisible()),
        );
      }
      const snapshot = await loadRolePair('Проблемы', sessions);
      assert(
        snapshot.items.some(
          (item) =>
            item.id === expectedProblemId && item.kind === 'defect' && item.reason === marker,
        ),
        'Shared Problems omitted the newly created safe defect fact',
      );
      await assertUiSection(pages, 'Проблемы', '');
    };
  }

  return {
    assertApiContract,
    assertDirectorOnlyBoundary,
    assertProblemsRefresh,
    assertProductionDrilldown,
    assertUiSection,
  };
}
