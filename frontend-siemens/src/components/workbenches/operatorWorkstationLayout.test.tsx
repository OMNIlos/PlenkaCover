import { readFileSync } from 'node:fs';
import type { ComponentType, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import * as operatorHubModule from './OperatorRollsHubSurface';

const appSource = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');

type LayoutProps = {
  detailFirst: boolean;
  hasDetail: boolean;
  navigation: ReactNode;
  hub: ReactNode;
  detail: ReactNode;
};

type ScrollTarget = {
  scrollTo: (options: { top: number; behavior: 'auto' }) => void;
};

const moduleUnderTest = operatorHubModule as unknown as {
  OperatorRollsHubPageLayout?: ComponentType<LayoutProps>;
  isOperatorWorkstationWidth?: (
    viewportWidth: number,
    outerWidth?: number,
    devicePixelRatio?: number,
  ) => boolean;
  resetOperatorScrollTargets?: (
    viewportWidth: number,
    targets: Array<ScrollTarget | null | undefined>,
  ) => boolean;
  resetOperatorSectionScrollTargets?: (
    targets: Array<ScrollTarget | null | undefined>,
  ) => void;
};

describe('operator workstation layout', () => {
  it('keeps list-first DOM order at 1024 and reserves detail-first order for narrower widths', () => {
    const usesDetailFirst = moduleUnderTest.isOperatorWorkstationWidth;
    expect(usesDetailFirst).toBeTypeOf('function');
    if (!usesDetailFirst) return;

    expect(usesDetailFirst(390)).toBe(true);
    expect(usesDetailFirst(640)).toBe(true);
    expect(usesDetailFirst(900)).toBe(true);
    expect(usesDetailFirst(901)).toBe(true);
    expect(usesDetailFirst(999)).toBe(true);
    expect(usesDetailFirst(1000)).toBe(false);
    expect(usesDetailFirst(1024)).toBe(false);
    expect(usesDetailFirst(1240)).toBe(false);
    expect(usesDetailFirst(819, 819, 1.25)).toBe(false);
    expect(usesDetailFirst(900, 900, 1)).toBe(true);
    expect(usesDetailFirst(799, 1024, 1)).toBe(true);
    expect(appSource).toContain('window.outerWidth');
    expect(appSource).toContain('window.devicePixelRatio');
    expect(appSource).toContain("window.addEventListener('resize', syncViewport)");
    expect(appSource).not.toContain("window.matchMedia('(max-width: 999px)')");
    expect(appSource).not.toContain(
      "window.matchMedia('(min-width: 901px) and (max-width: 1240px)')",
    );
  });

  it('keeps DOM order aligned with the responsive visual order', () => {
    const Layout = moduleUnderTest.OperatorRollsHubPageLayout;
    expect(Layout).toBeTypeOf('function');
    if (!Layout) return;

    const render = (detailFirst: boolean, hasDetail = true) =>
      renderToStaticMarkup(
        <Layout
          detailFirst={detailFirst}
          hasDetail={hasDetail}
          navigation={<nav data-region="navigation" />}
          hub={<section data-region="hub" />}
          detail={<article data-region="detail" />}
        />,
      );
    const workstationMarkup = render(true);
    const defaultMarkup = render(false);

    expect(workstationMarkup).toContain('data-detail-first="true"');
    expect(defaultMarkup).toContain('data-detail-first="false"');
    expect(workstationMarkup.indexOf('data-region="detail"')).toBeLessThan(
      workstationMarkup.indexOf('data-region="hub"'),
    );
    expect(defaultMarkup.indexOf('data-region="hub"')).toBeLessThan(
      defaultMarkup.indexOf('data-region="detail"'),
    );
  });

  it('omits the empty detail row until an operator selects a roll', () => {
    const Layout = moduleUnderTest.OperatorRollsHubPageLayout;
    expect(Layout).toBeTypeOf('function');
    if (!Layout) return;

    const markup = renderToStaticMarkup(
      <Layout
        detailFirst
        hasDetail={false}
        navigation={<nav data-region="navigation" />}
        hub={<section data-region="hub" />}
        detail={<article data-region="detail" />}
      />,
    );

    expect(markup).toContain('data-has-detail="false"');
    expect(markup).not.toContain('data-region="detail"');
    expect(markup.indexOf('data-region="navigation"')).toBeLessThan(
      markup.indexOf('data-region="hub"'),
    );
  });

  it('resets every distinct operator scroll target only where the detail stacks first', () => {
    const resetScrollTargets = moduleUnderTest.resetOperatorScrollTargets;
    expect(resetScrollTargets).toBeTypeOf('function');
    if (!resetScrollTargets) return;

    const calls: string[] = [];
    const target = (id: string): ScrollTarget => ({
      scrollTo: (options) => calls.push(`${id}:${options.top}:${options.behavior}`),
    });
    const appShell = target('app-shell');
    const detail = target('detail');
    const application = target('application');
    const windowTarget = target('window');

    expect(resetScrollTargets(999, [appShell, detail, application, windowTarget, appShell])).toBe(
      true,
    );
    expect(calls).toEqual([
      'app-shell:0:auto',
      'detail:0:auto',
      'application:0:auto',
      'window:0:auto',
    ]);

    calls.length = 0;
    expect(resetScrollTargets(1241, [appShell, detail, application, windowTarget])).toBe(false);
    expect(calls).toEqual([]);
  });

  it('keeps the operator scroll position when a roll is picked at workstation width', () => {
    const resetScrollTargets = moduleUnderTest.resetOperatorScrollTargets;
    expect(resetScrollTargets).toBeTypeOf('function');
    if (!resetScrollTargets) return;

    const calls: string[] = [];
    const target = (id: string): ScrollTarget => ({
      scrollTo: (options) => calls.push(`${id}:${options.top}:${options.behavior}`),
    });
    const targets = [
      target('app-shell'),
      target('detail'),
      target('application'),
      target('window'),
    ];

    for (const width of [1000, 1024, 1240]) {
      calls.length = 0;
      expect(resetScrollTargets(width, targets)).toBe(false);
      expect(calls).toEqual([]);
    }
  });

  it('gates the operator roll-select scroll jump on the detail-first width', () => {
    expect(appSource).not.toContain("activeRole === 'operator' && window.innerWidth <= 1240");
  });

  it('resets the Siemens shadow scroll root on every operator section change', () => {
    const resetSectionScrollTargets = moduleUnderTest.resetOperatorSectionScrollTargets;
    expect(resetSectionScrollTargets).toBeTypeOf('function');
    if (!resetSectionScrollTargets) return;

    const calls: string[] = [];
    const target = (id: string): ScrollTarget => ({
      scrollTo: (options) => calls.push(`${id}:${options.top}:${options.behavior}`),
    });
    const application = target('application');
    resetSectionScrollTargets([target('shell'), application, target('detail'), application]);

    expect(calls).toEqual(['shell:0:auto', 'application:0:auto', 'detail:0:auto']);
  });

  it('renders Shift as one direct-detail workspace instead of a duplicate list and detail pair', () => {
    expect(appSource).toMatch(
      /data-direct-detail=\{[\s\S]*?isOperatorShiftSection[\s\S]*?\? 'true'/u,
    );
    expect(appSource).toMatch(
      /!isOperatorRollsHubSection\s*&&\s*!isOperatorShiftSection\s*&&/u,
    );
    expect(appSource).toContain('className="operator-shift-page"');
    expect(appSource).not.toContain('<OperatorShiftListSummary runtime={operatorRuntime} />');
  });
});
