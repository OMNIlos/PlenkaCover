import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { workObjects } from '../../domain/demoData';
import {
  buildDirectorDashboardProjection,
  initialProductionRuntimeState,
} from '../../domain/runtime';
import { DirectorWorkbench } from '../../components/workbenches/directorWorkbench';
import { DirectorFinanceSituations } from '../../components/workbenches/directorFinanceQrSurfaces';
import { DirectorPayrollSurface } from '../../components/workbenches/DirectorPayrollSurface';
import { DirectorQrScanSurface } from '../../components/workbenches/directorTraceabilitySurface';
import { CommercialWorkspace } from '../commercial/CommercialWorkspace';
import {
  BUSINESS_PERFORMANCE_SECTIONS,
  BusinessPerformanceWorkspace,
} from './BusinessPerformanceWorkspace';
import { BusinessProblemsWorkspace } from './BusinessProblemsWorkspace';

vi.mock('../../api/businessPerformance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/businessPerformance')>();
  const pending = () => new Promise<never>(() => undefined);
  return {
    ...actual,
    loadBusinessPerformanceSection: vi.fn(pending),
    loadBusinessProductionRolls: vi.fn(pending),
    loadBusinessOperationalProblems: vi.fn(pending),
    loadBusinessOperationalProblem: vi.fn(pending),
  };
});

function director(
  activeSection: string,
  refreshGeneration = 7,
  selectedId: string | null = null,
  isMobileViewport = false,
  selectedProblemId: string | null = null,
) {
  return (
    <DirectorWorkbench
      activeSection={activeSection}
      selectedId={selectedId}
      selectedProblemId={selectedProblemId}
      isMobileViewport={isMobileViewport}
      workObjectsByRole={workObjects}
      dashboard={buildDirectorDashboardProjection(initialProductionRuntimeState)}
      viewMode="orders"
      quickFilter="all"
      onSelect={vi.fn()}
      onOpenRole={vi.fn()}
      onAction={vi.fn()}
      onClose={vi.fn()}
      onDashboardDrilldown={vi.fn()}
      penaltySnapshot={{
        items: [],
        summary: { totalCount: 0, totalAmountKopecks: 0, topReason: null },
      }}
      penaltyFilters={{}}
      penaltyScopeObjectId=""
      canCreatePenalty={true}
      allowPenaltyUpdate={false}
      onPenaltyCreate={vi.fn()}
      onPenaltyUpdate={vi.fn()}
      onPenaltyFiltersChange={vi.fn()}
      onViewModeChange={vi.fn()}
      onQuickFilterChange={vi.fn()}
      onRefresh={vi.fn()}
      refreshing={false}
      refreshGeneration={refreshGeneration}
      useLiveData={false}
    />
  );
}

function commercial(
  activeSection: (typeof BUSINESS_PERFORMANCE_SECTIONS)[number] | 'Проблемы',
  refreshGeneration = 7,
  selectedProblemId: string | null = null,
) {
  return (
    <CommercialWorkspace
      activeSection={activeSection}
      selectedOrderId={null}
      selectedProblemId={selectedProblemId}
      refreshGeneration={refreshGeneration}
      onChangeSection={vi.fn()}
      onSelectOrder={vi.fn()}
    />
  );
}

function unmount(renderer: ReactTestRenderer) {
  act(() => renderer.unmount());
}

const DIRECTOR_ONLY_ACTION_LABELS = [
  'Назначить владельца',
  'Поднять приоритет',
  'Вернуть производству',
  'Подтвердить исключение',
  'Подтвердить складское исключение',
  'Вернуть складу',
] as const;

afterEach(() => {
  vi.clearAllMocks();
});

describe('shared commercial/director business workspaces', () => {
  it.each([
    'Контроль',
    'Финансы',
    'Производство',
    'Зарплаты',
    'Проблемы',
    'Склад',
    'Штрафы',
    'Аудит / QR',
  ])('renders one manual refresh action in the director %s tab', (section) => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(director(section));
    });

    expect(
      renderer.root.findAllByProps({ 'aria-label': 'Обновить данные вкладки' }),
    ).toHaveLength(1);

    unmount(renderer);
  });

  it.each(BUSINESS_PERFORMANCE_SECTIONS)(
    'mounts the same BusinessPerformanceWorkspace for %s in both role shells',
    (section) => {
      let commercialRenderer!: ReactTestRenderer;
      let directorRenderer!: ReactTestRenderer;
      act(() => {
        commercialRenderer = TestRenderer.create(commercial(section));
        directorRenderer = TestRenderer.create(director(section));
      });

      const commercialWorkspace = commercialRenderer.root.findByType(BusinessPerformanceWorkspace);
      const directorWorkspace = directorRenderer.root.findByType(BusinessPerformanceWorkspace);
      expect(commercialWorkspace.props).toMatchObject({ section, refreshGeneration: 7 });
      expect(directorWorkspace.props).toMatchObject({ section, refreshGeneration: 7 });
      if (section === 'Контроль') expect(directorWorkspace.props).toHaveProperty('defectBags');

      unmount(commercialRenderer);
      unmount(directorRenderer);
    },
  );

  it('mounts the same BusinessProblemsWorkspace for Problems in both role shells', () => {
    let commercialRenderer!: ReactTestRenderer;
    let directorRenderer!: ReactTestRenderer;
    act(() => {
      commercialRenderer = TestRenderer.create(commercial('Проблемы', 7, 'commercial-problem'));
      directorRenderer = TestRenderer.create(
        director('Проблемы', 7, null, false, 'director-problem'),
      );
    });

    const commercialProblems =
      commercialRenderer.root.findByType(BusinessProblemsWorkspace);
    const directorProblems = directorRenderer.root.findByType(BusinessProblemsWorkspace);
    expect(commercialProblems.props).toMatchObject({
      refreshGeneration: 7,
      selectedProblemId: 'commercial-problem',
      onOpenMaterialShortageCorrection: expect.any(Function),
    });
    expect(Boolean(commercialProblems.props.allowProductionOverride)).toBe(false);
    expect(directorProblems.props).toMatchObject({
      refreshGeneration: 7,
      allowProductionOverride: true,
      selectedProblemId: 'director-problem',
    });
    expect(directorProblems.props.onOpenMaterialShortageCorrection).toBeUndefined();

    unmount(commercialRenderer);
    unmount(directorRenderer);
  });

  it.each([...BUSINESS_PERFORMANCE_SECTIONS, 'Проблемы'] as const)(
    'keeps director-only actions and surfaces out of the commercial %s workspace',
    (section) => {
      let renderer!: ReactTestRenderer;
      act(() => {
        renderer = TestRenderer.create(commercial(section));
      });

      const labels = renderer.root
        .findAllByType('button')
        .map((candidate) => candidate.children.join(''));
      expect(
        labels.filter((label) =>
          DIRECTOR_ONLY_ACTION_LABELS.some((directorLabel) => directorLabel === label),
        ),
      ).toEqual([]);
      expect(renderer.root.findAllByType(DirectorFinanceSituations)).toHaveLength(0);
      expect(renderer.root.findAllByType(DirectorPayrollSurface)).toHaveLength(0);
      expect(
        renderer.root.findAll(
          (candidate) => candidate.props['aria-label'] === 'Себестоимость рулонов',
        ),
      ).toHaveLength(0);
      expect(renderer.root.findAllByType(DirectorQrScanSurface)).toHaveLength(0);

      unmount(renderer);
    },
  );

  it('renders finance as the same shared workspace without director-only situations', () => {
    let commercialRenderer!: ReactTestRenderer;
    let directorRenderer!: ReactTestRenderer;
    act(() => {
      commercialRenderer = TestRenderer.create(commercial('Финансы'));
      directorRenderer = TestRenderer.create(director('Финансы'));
    });

    expect(directorRenderer.root.findAllByType(BusinessPerformanceWorkspace)).toHaveLength(1);
    expect(commercialRenderer.root.findAllByType(BusinessPerformanceWorkspace)).toHaveLength(1);
    expect(directorRenderer.root.findAllByType(DirectorFinanceSituations)).toHaveLength(0);
    expect(commercialRenderer.root.findAllByType(DirectorFinanceSituations)).toHaveLength(0);

    unmount(commercialRenderer);
    unmount(directorRenderer);
  });

  it('normalizes the legacy director Money alias to the shared finance workspace', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(director('Деньги'));
    });

    expect(renderer.root.findByType(BusinessPerformanceWorkspace).props).toMatchObject({
      section: 'Финансы',
      refreshGeneration: 7,
    });
    expect(renderer.root.findAllByType(DirectorFinanceSituations)).toHaveLength(0);

    unmount(renderer);
  });

  it.each([
    {
      selectedId: 'DIR-2606-006',
      actions: [
        'Назначить владельца',
        'Поднять приоритет',
        'Вернуть производству',
        'Подтвердить исключение',
      ],
    },
    {
      selectedId: 'DIR-2606-009',
      actions: ['Подтвердить складское исключение', 'Вернуть складу'],
    },
  ])(
    'exposes director production/warehouse overrides for $selectedId in the decision queue',
    ({ selectedId, actions }) => {
      let renderer!: ReactTestRenderer;
      act(() => {
        renderer = TestRenderer.create(director('Требуют решения', 7, selectedId));
      });

      const labels = renderer.root
        .findAllByType('button')
        .map((candidate) => candidate.children.join(''));
      expect(labels).toEqual(expect.arrayContaining(actions));

      unmount(renderer);
    },
  );

  it('opens the decision drawer with overrides from a decision row on mobile', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(director('Требуют решения', 7, null, true));
    });

    const warehouseRow = renderer.root
      .findAllByType('tr')
      .find((candidate) => String(candidate.props.title).includes('WH-2606-044'));
    if (!warehouseRow) throw new Error('Warehouse decision row is missing.');
    act(() => warehouseRow.props.onClick());

    expect(
      renderer.root.findAllByType('button').map((candidate) => candidate.children.join('')),
    ).toContain('Подтвердить складское исключение');

    unmount(renderer);
  });

  it.each([
    ['Зарплаты', DirectorPayrollSurface],
    ['Аудит / QR', DirectorQrScanSurface],
  ] as const)('keeps the director-only %s route unchanged', (section, Surface) => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(director(section));
    });

    expect(renderer.root.findAllByType(Surface)).toHaveLength(1);
    expect(renderer.root.findAllByType(BusinessPerformanceWorkspace)).toHaveLength(0);

    unmount(renderer);
  });

  it('does not expose the removed standalone roll-cost surface for a stale section value', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(director('Себестоимость'));
    });

    expect(
      renderer.root.findAll(
        (candidate) => candidate.props['aria-label'] === 'Себестоимость рулонов',
      ),
    ).toHaveLength(0);

    unmount(renderer);
  });
});
