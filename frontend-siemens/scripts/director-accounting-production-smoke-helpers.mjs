function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function numericValue(text) {
  return Number(
    text
      .replace(/\u2212/gu, '-')
      .replace(',', '.')
      .replace(/[^\d.-]/gu, ''),
  );
}

export function buildDirectorAccountingProductionFixture({
  latestImportedAt,
  latestDocumentDate,
  documentCount,
  excludedOutputLineCount = 0,
  excludedMaterialLineCount = 0,
  productionSeries,
  materialSeries,
  stale = false,
}) {
  return {
    source: {
      sourceKind: '1C',
      label: '1С · Отчет производства за смену',
      latestImportedAt,
      latestDocumentDate,
      stale,
    },
    coverage: {
      documentCount,
      excludedOutputLineCount,
      excludedMaterialLineCount,
    },
    productionSeries,
    materialSeries,
  };
}

export function emptyDirectorAccountingProductionFixture(accounting) {
  return {
    ...accounting,
    coverage: {
      ...accounting.coverage,
      documentCount: 0,
      excludedOutputLineCount: 0,
      excludedMaterialLineCount: 0,
    },
    productionSeries: accounting.productionSeries.map((point) => ({
      ...point,
      documentCount: 0,
      producedKg: 0,
    })),
    materialSeries: accounting.materialSeries.map((point) => ({
      ...point,
      consumedKg: 0,
    })),
  };
}

export async function assertDirectorAccountingProductionChart(analytics) {
  const legend = analytics.getByLabel('Обозначения качества производства');
  await legend.getByText('Факт ERP', { exact: true }).waitFor();
  await legend.getByText('Учёт 1С', { exact: true }).waitFor();
  const bar = analytics.locator('.director-analytics-bar.is-onec[data-series-id="onec-produced"]');
  await bar.waitFor();
  const style = await bar.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      backgroundImage: computed.backgroundImage,
      borderStyle: computed.borderStyle,
    };
  });
  assert(style.backgroundImage.includes('repeating-linear-gradient'), '1C series has no pattern');
  assert(style.borderStyle === 'dashed', '1C series has no dashed border');
}

export async function assertDirectorAccountingExcludedFromCountMode(analytics, documentCount) {
  assert(
    (await analytics.locator('[data-series-id="onec-produced"]').count()) === 0,
    'count mode rendered 1C documents as a physical bar',
  );
  await analytics.getByText(`Документов 1С: ${documentCount}`, { exact: true }).waitFor();
}

export async function assertDirectorAccountingMaterialSemantics(analytics) {
  await analytics
    .getByText('Расход материала: BigBag и учёт 1С', { exact: true })
    .waitFor();
  await analytics
    .getByRole('group', { name: 'Ось расхода материалов, кг', exact: true })
    .waitFor();
  await analytics
    .getByLabel('Обозначения расхода материалов', { exact: true })
    .waitFor();
  const obsoleteCaption = 'Расход гранул по закрытым фактам BigBag: ERP и учёт 1С';
  const captions = await analytics.locator('figcaption').allTextContents();
  assert(
    !captions.some((caption) => caption.trim() === obsoleteCaption),
    `obsolete shared material caption is visible: ${obsoleteCaption}`,
  );
  assert(
    (await analytics
      .getByRole('group', { name: 'Ось расхода гранул, кг', exact: true })
      .count()) === 0,
    'obsolete shared material axis is visible: Ось расхода гранул, кг',
  );
}

export async function assertDirectorAccountingProductionRow(table, expected) {
  const row = table.locator('tbody tr').first();
  const producedText = await row.locator('[data-column-id="onec-produced-kg"]').innerText();
  const documentText = await row.locator('[data-column-id="onec-document-count"]').innerText();
  assert(
    numericValue(producedText) === expected.producedKg,
    `1C production exact value is ${producedText}`,
  );
  assert(
    numericValue(documentText) === expected.documentCount,
    `1C document count is ${documentText}`,
  );
}

export async function assertDirectorAccountingMaterialRow(table, expectedConsumedKg) {
  const text = await table
    .locator('tbody tr')
    .first()
    .locator('[data-column-id="onec-consumed-kg"]')
    .innerText();
  assert(numericValue(text) === expectedConsumedKg, `1C material fact is ${text}`);
}

export async function assertDirectorAccountingSourceAbsentViewport({
  browser,
  diagnostics,
  aggregateRequests,
  createContext,
  openDirectorPage,
  waitForRequest,
  assertExactQuery,
  expectedQuery,
}) {
  const viewport = { width: 390, height: 844 };
  const scenario = 'accounting-source-absent-390x844';
  const before = aggregateRequests.length;
  const context = await createContext(browser, 'director', viewport, diagnostics, { scenario });
  try {
    const page = await openDirectorPage(context, diagnostics);
    const analytics = page.locator('.director-production-analytics');
    await analytics
      .locator('.director-analytics-summary-card[data-analytics-tab="production"]')
      .click();
    assert(
      (await analytics.getByLabel('Источник производственных данных 1С').count()) === 0,
      `${viewport.width}px analytics restored the removed accounting source banner`,
    );
    const request = await waitForRequest(aggregateRequests, before);
    assertExactQuery(request, expectedQuery);
    assert(
      request.scenario === scenario,
      `${scenario} request was attributed to ${request.scenario}`,
    );
  } finally {
    await context.close();
  }
}

export async function assertEmptyDirectorAccountingSourceAbsent(page) {
  assert(
    (await page.getByLabel('Источник производственных данных 1С').count()) === 0,
    'empty analytics restored the removed accounting source banner',
  );
}
