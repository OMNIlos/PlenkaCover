import { existsSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { mapCommercialOrder, type ServerCommercialOrder } from '../../api/commercial';
import { roleAccessPolicies } from '../../domain/accessPolicy';
import {
  acquireCommercialMutationLock,
  CommercialWorkspace,
  COMMERCIAL_LIVE_SECTIONS,
  isCommercialOrderLiveSection,
  nextCommercialMobileSurface,
  type CommercialMobileSurface,
} from './CommercialWorkspace';
import { createEmptyCommercialIntakeDraft } from './CommercialIntakeForm';
import { nextCommercialQueueSelection } from './CommercialQueue';
import { replaceCommercialOrders } from './useCommercialWorkspace';

const serverOrder: ServerCommercialOrder = {
  id: 'server-order',
  orderNumber: 'CO-1',
  creatorRole: 'commercial',
  counterpartyId: 'counterparty-1',
  requestType: 'client_order',
  productionIndicator: 'not_started',
  warehouseCoverStatus: 'not_checked',
  paymentStatus: 'unpaid',
  shipmentStatus: 'not_shipped',
  createdAt: '2026-07-14T08:00:00.000Z',
  updatedAt: '2026-07-14T09:00:00.000Z',
  externalId: null,
  sourceVersion: null,
  counterparty: {
    id: 'counterparty-1',
    displayName: 'ООО Сервер',
    legalName: 'ООО Сервер',
    inn: null,
  },
  positions: [
    {
      id: 'position-1',
      rollCount: 2,
      filmType: 'Рукав',
      actualThickness: '80 мкм',
      accountingThickness: '80 мкм',
      rawMaterialId: 'raw-1',
      spoolType: null,
      birka: null,
      recipe: null,
    },
  ],
  coverProposals: [],
  problems: [],
};

describe('commercial live boundary', () => {
  it('replaces commercial data with the server page and never retains fixture-only orders', () => {
    const next = replaceCommercialOrders([{ id: 'fixture-only' }], [{ id: 'server-order' }]);

    expect(next.map(({ id }) => id)).toEqual(['server-order']);
  });

  it('exposes exactly one problems workspace in commercial navigation and access policy', () => {
    expect(COMMERCIAL_LIVE_SECTIONS).toEqual([
      'Входящие заявки',
      'Черновики',
      'В работе',
      'Выполненные',
      'Сырьё',
      'Проблемы',
      'Контроль',
      'Финансы',
      'Производство',
      'Склад',
    ]);
    expect(COMMERCIAL_LIVE_SECTIONS.filter((section) => section === 'Проблемы')).toHaveLength(1);
    expect(roleAccessPolicies.commercial.visibleSections).toContain('Проблемы');
  });

  it('keeps the order queue hook disabled while the problems workspace is active', () => {
    expect(isCommercialOrderLiveSection('Проблемы')).toBe(false);
  });

  it('uses an explicit queue-to-detail mobile flow', () => {
    const queue: CommercialMobileSurface = { mode: 'queue' };
    const detail = nextCommercialMobileSurface(queue, { type: 'open', orderId: 'order-1' });

    expect(detail).toEqual({ mode: 'detail', orderId: 'order-1' });
    expect(nextCommercialMobileSurface(detail, { type: 'back' })).toEqual({ mode: 'queue' });
    expect(nextCommercialMobileSurface(detail, { type: 'section_changed' })).toEqual({
      mode: 'queue',
    });
  });

  it('renders queue as the default mobile surface while keeping detail mounted', () => {
    const markup = renderToStaticMarkup(
      <CommercialWorkspace
        activeSection="Входящие заявки"
        selectedOrderId={null}
        onChangeSection={vi.fn()}
        onSelectOrder={vi.fn()}
      />,
    );

    expect(markup).toContain('data-mobile-active="true"');
    expect(markup).toContain('class="commercial-live-filters"');
    expect(markup).toContain('class="commercial-live-skeleton"');
    expect(markup).toContain('data-mobile-active="false"');
    expect(markup).toContain('К очереди');
  });

  it('starts intake without fixture counterparty, template, weights or material facts', () => {
    const draft = createEmptyCommercialIntakeDraft();

    expect(draft).toMatchObject({
      counterparty: '',
      templateId: undefined,
      template: '',
      comment: '',
    });
    expect(draft.positions).toHaveLength(1);
    expect(draft.positions[0]).toMatchObject({
      rollCount: '1',
      actualThickness: '',
      accountingThickness: '',
      plannedWeightKg: '',
      rawMaterial: '',
      rawMaterialId: '',
      baseRawMaterialDefinitionId: '',
      recipeDefinitionVersionId: '',
    });
    expect(JSON.stringify(draft)).not.toMatch(/УралПак|15803|10803|41\.2|34\.5/);
  });

  it('wires the persisted catalog and nested recipe editor into both live intake owners', () => {
    const appSource = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
    const workspaceSource = readFileSync(
      new URL('./CommercialWorkspace.tsx', import.meta.url),
      'utf8',
    );

    for (const source of [appSource, workspaceSource]) {
      expect(source).toContain('useMaterialRecipeCatalog(');
      expect(source).toContain('<RecipeEditorModal');
      expect(source).toContain('isEventFromNestedDialog(event.currentTarget, event.target)');
      expect(source).toContain('applyCreatedRecipeToIntakeDraft(');
    }
    expect(appSource).toMatch(
      /createCommercialOrderFromDraft\([\s\S]*?intakeClientRequestId,\s*'client_order',\s*\)/u,
    );
    expect(appSource).not.toMatch(
      /createCommercialOrderFromDraft\([\s\S]*?templateCatalog\.find\([\s\S]*?activeVersionId/u,
    );
    expect(appSource).toContain('setIntakeClientRequestId(createClientRequestId())');
    expect(appSource).toContain('setIntakeMaterialSelectionInvalidPositionIds(');
    expect(appSource).toMatch(
      /refreshIntakeDraftFromSelectedTemplate\([\s\S]*?templateDraftPositions,\s*materialRecipeCatalog\.status === 'ready'/u,
    );
  });

  it('keeps the commercial live smoke on the public structured material selector contract', () => {
    const smokeSource = readFileSync(
      new URL('../../../scripts/commercial-live-smoke.mjs', import.meta.url),
      'utf8',
    );
    const createCoverScenarioSource = smokeSource.match(
      /async function createCoverScenario[\s\S]*?(?=async function waitForAppShell)/u,
    )?.[0];

    expect(smokeSource).toContain("apiRequest('/api/material-catalog'");
    expect(smokeSource).toContain('baseRawMaterialDefinitionId');
    expect(createCoverScenarioSource).toBeDefined();
    expect(createCoverScenarioSource).not.toMatch(/\brawMaterialId\s*:/u);
    expect(createCoverScenarioSource).not.toMatch(/\brecipeParameters\s*:/u);
    expect(smokeSource.match(/warehouse-cover\/recheck/gu)).toHaveLength(2);
    expect(smokeSource.match(/\{ forceRefresh: true \}/gu)).toHaveLength(3);
    expect(smokeSource).toContain('const paymentOperationKey = randomUUID()');
    expect(smokeSource.match(/operationKey: paymentOperationKey/gu)).toHaveLength(2);
    expect(smokeSource).toContain('Legacy correction fixture');
    expect(smokeSource).toContain("recipeParameters: [{ label: 'Сырьё', value: 'Первичное' }]");
    expect(smokeSource).toContain('responseBody.items.some((item) => item.id === scenario.id)');
    expect(smokeSource).toContain("error !== 'net::ERR_ABORTED'");
  });

  it('does not synthesize audit, QR, roll or source facts in the legacy compatibility map', () => {
    const mapped = mapCommercialOrder(serverOrder);

    expect(mapped.audit).toEqual([]);
    expect(mapped.rollGroups).toBeUndefined();
    expect(mapped.qrActionPanelContext).toBeUndefined();
    expect(mapped.commercialOrder?.positions[0]?.rawMaterials).toBeUndefined();
    expect(JSON.stringify(mapped)).not.toMatch(
      /integration:commercial_order_loaded|1C snapshot|backend API/,
    );
  });

  it('renders the five-section live shell without a create action in active or completed work', () => {
    for (const activeSection of ['В работе', 'Выполненные'] as const) {
      const markup = renderToStaticMarkup(
        <CommercialWorkspace
          activeSection={activeSection}
          selectedOrderId={null}
          onChangeSection={vi.fn()}
          onSelectOrder={vi.fn()}
        />,
      );

      expect(markup).toContain('Выполненные');
      expect(markup).toContain('Сырьё');
      expect(markup).toContain('aria-label="Входящие заявки"');
      expect(markup).not.toContain('Создать заявку');
      expect(markup).toContain('aria-live="polite"');
      expect(markup).toContain('class="commercial-live-skeleton"');
      expect(markup).toContain('aria-label="Загрузка коммерческих заявок"');
    }
  });

  it('supports deterministic arrow-key selection in the queue', () => {
    const items = [{ id: 'order-1' }, { id: 'order-2' }, { id: 'order-3' }];

    expect(nextCommercialQueueSelection(items, 'order-1', 'ArrowDown')).toBe('order-2');
    expect(nextCommercialQueueSelection(items, 'order-1', 'ArrowUp')).toBe('order-3');
    expect(nextCommercialQueueSelection(items, 'order-2', 'Enter')).toBeNull();
  });

  it('rejects a second mutation before React rerenders the disabled action', () => {
    const lock = { current: false };

    expect(acquireCommercialMutationLock(lock)).toBe(true);
    expect(acquireCommercialMutationLock(lock)).toBe(false);
  });

  it('keeps critical actions usable at a 390px viewport', () => {
    const css = readFileSync(
      new URL('../../styles/94-commercial-mobile.css', import.meta.url),
      'utf8',
    );

    expect(css).toContain('@media (max-width: 390px)');
    expect(css).toMatch(/\.commercial-live-primary-action[^{]*\{[^}]*width:\s*100%/s);
  });

  it('keeps queue support text at the project 13px minimum', () => {
    const css = readFileSync(
      new URL('../../styles/91-commercial-live.css', import.meta.url),
      'utf8',
    );

    for (const selector of ['commercial-queue-count', 'commercial-queue-meta']) {
      expect(css).toMatch(new RegExp(`\\.${selector}[^{}]*\\{[^}]*font-size:\\s*13px`, 's'));
    }
  });

  it('scopes Task 4 coverage and correction styles to the live decision stack', () => {
    const css = readFileSync(
      new URL('../../styles/91-commercial-live.css', import.meta.url),
      'utf8',
    );
    const task4Classes = [
      'commercial-cover-panel',
      'commercial-correction-panel',
      'commercial-cover-summary',
      'commercial-cover-actions',
      'commercial-cover-evidence',
      'commercial-problem-impact',
      'commercial-correction-decision-title',
    ];
    const task4Selectors = [...css.matchAll(/([^{}]+)\{/g)]
      .map(([, selectorList]) => selectorList.trim())
      .filter((selectorList) => !selectorList.startsWith('@'))
      .flatMap((selectorList) => selectorList.split(',').map((selector) => selector.trim()))
      .filter((selector) => task4Classes.some((className) => selector.includes(`.${className}`)));
    const liveScope = ':where(.commercial-live-decision-stack) ';

    expect(task4Selectors.length).toBeGreaterThan(0);
    expect(task4Selectors.filter((selector) => !selector.startsWith(liveScope))).toEqual([]);
    expect(task4Selectors).toContain(`${liveScope}.commercial-cover-summary`);
    expect(task4Selectors).not.toContain('.commercial-cover-summary');
  });

  it('applies each semantic indicator tone to the visible status value', () => {
    const stylesEntryUrl = new URL('../../styles.css', import.meta.url);
    const stylesEntry = readFileSync(stylesEntryUrl, 'utf8');
    const commercialCss = [...stylesEntry.matchAll(/@import '([^']*commercial[^']*\.css)';/g)]
      .map(([, importPath]) => readFileSync(new URL(importPath, stylesEntryUrl), 'utf8'))
      .join('\n');

    for (const tone of ['info', 'success', 'warning', 'critical']) {
      expect(commercialCss).toMatch(
        new RegExp(
          `\\.commercial-status-step\\.is-${tone}\\s+dd\\s*\\{[^}]*` +
            `color:\\s*var\\(--state-${tone}-text\\)`,
          's',
        ),
      );
    }
  });

  it('keeps order-detail styles in a scoped owner after the commercial live stylesheet', () => {
    const stylesEntry = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
    const commercialLiveCss = readFileSync(
      new URL('../../styles/91-commercial-live.css', import.meta.url),
      'utf8',
    );
    const queueStatesCss = readFileSync(
      new URL('../../styles/91-commercial-queue-states.css', import.meta.url),
      'utf8',
    );
    const detailStylesUrl = new URL('../../styles/92-commercial-order-detail.css', import.meta.url);
    const detailCss = existsSync(detailStylesUrl) ? readFileSync(detailStylesUrl, 'utf8') : '';
    const positionsStylesUrl = new URL(
      '../../styles/92-commercial-order-positions.css',
      import.meta.url,
    );
    const positionsCss = existsSync(positionsStylesUrl)
      ? readFileSync(positionsStylesUrl, 'utf8')
      : '';

    expect(stylesEntry).toContain(
      "@import './styles/91-commercial-live.css';\n" +
        "@import './styles/91-commercial-queue-states.css';\n" +
        "@import './styles/92-commercial-order-detail.css';\n" +
        "@import './styles/92-commercial-order-positions.css';",
    );
    expect(commercialLiveCss).not.toContain('.commercial-order-overview');
    expect(commercialLiveCss.split(/\r?\n/).length).toBeLessThan(450);
    expect(queueStatesCss).toContain(".commercial-live-results[data-state='empty']");
    expect(queueStatesCss.split(/\r?\n/).length).toBeLessThan(120);
    expect(detailCss).toContain('.commercial-order-overview');
    expect(detailCss.split(/\r?\n/).length).toBeLessThan(300);
    expect(detailCss).not.toContain('.commercial-position-editor');
    expect(positionsCss).toContain('.commercial-position-editor');
    expect(positionsCss.split(/\r?\n/).length).toBeLessThan(180);
  });

  it('keeps the raw-material workspace in its own bounded stylesheet after order detail', () => {
    const stylesEntry = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
    const commercialLiveCss = readFileSync(
      new URL('../../styles/91-commercial-live.css', import.meta.url),
      'utf8',
    );
    const detailCss = readFileSync(
      new URL('../../styles/92-commercial-order-detail.css', import.meta.url),
      'utf8',
    );
    const rawMaterialStylesUrl = new URL(
      '../../styles/93-commercial-raw-materials.css',
      import.meta.url,
    );
    const rawMaterialCss = existsSync(rawMaterialStylesUrl)
      ? readFileSync(rawMaterialStylesUrl, 'utf8')
      : '';
    const rawMaterialSelector =
      /\.(?:commercial-live-raw-shell|commercial-raw-material(?:s|-list)|commercial-material-(?:summary|orders))/;

    expect(stylesEntry).toContain(
      "@import './styles/91-commercial-live.css';\n" +
        "@import './styles/91-commercial-queue-states.css';\n" +
        "@import './styles/92-commercial-order-detail.css';\n" +
        "@import './styles/92-commercial-order-positions.css';\n" +
        "@import './styles/93-commercial-raw-materials.css';",
    );
    expect(commercialLiveCss).not.toMatch(rawMaterialSelector);
    expect(detailCss).not.toMatch(rawMaterialSelector);
    expect(rawMaterialCss).toContain('.commercial-live-raw-shell');
    expect(rawMaterialCss).toContain('.commercial-material-summary');
    expect(rawMaterialCss).toContain('.commercial-raw-material-list');
    expect(rawMaterialCss).toContain('.commercial-material-orders');
    expect(rawMaterialCss.split(/\r?\n/).length).toBeLessThan(500);
  });

  it('keeps responsive commercial navigation in a bounded stylesheet after its surface owners', () => {
    const stylesEntry = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
    const commercialLiveCss = readFileSync(
      new URL('../../styles/91-commercial-live.css', import.meta.url),
      'utf8',
    );
    const mobileCss = readFileSync(
      new URL('../../styles/94-commercial-mobile.css', import.meta.url),
      'utf8',
    );

    expect(stylesEntry).toContain(
      "@import './styles/91-commercial-live.css';\n" +
        "@import './styles/91-commercial-queue-states.css';\n" +
        "@import './styles/92-commercial-order-detail.css';\n" +
        "@import './styles/92-commercial-order-positions.css';\n" +
        "@import './styles/93-commercial-raw-materials.css';\n" +
        "@import './styles/94-commercial-mobile.css';",
    );
    expect(commercialLiveCss.split(/\r?\n/).length).toBeLessThan(450);
    expect(mobileCss).toContain(".commercial-live-list-panel[data-mobile-active='false']");
    expect(mobileCss).toContain('@media (min-width: 901px)');
    expect(mobileCss.split(/\r?\n/).length).toBeLessThan(200);
  });
});
