import { createElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DirectorQrScanSurface } from './directorTraceabilitySurface';

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  context: vi.fn(),
}));

vi.mock('../../api/director', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/director')>();
  return {
    ...actual,
    fetchDirectorTraceabilitySearch: mocks.search,
    fetchDirectorTraceabilityContext: mocks.context,
  };
});

function renderedText(renderer: ReactTestRenderer) {
  return JSON.stringify(renderer.toJSON());
}

function flushPromises() {
  return Promise.resolve().then(() => Promise.resolve());
}

describe('director traceability surface', () => {
  beforeEach(() => {
    mocks.search.mockReset();
    mocks.context.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('searches on submit, renders bounded candidates and opens the selected safe context', async () => {
    mocks.search.mockResolvedValue({
      items: [
        {
          objectType: 'roll',
          objectId: 'roll-1',
          displayName: 'Рулон A-1/1',
          secondaryLabel: 'Заказ A-1',
          matchKind: 'exact',
        },
        {
          objectType: 'order',
          objectId: 'order-1',
          displayName: 'Заказ A-1',
          secondaryLabel: 'Плёнка 80 мкм',
          matchKind: 'prefix',
        },
      ],
      nextCursor: null,
    });
    mocks.context.mockImplementation(async (objectType: string) => ({
      objectType,
      objectId: objectType === 'roll' ? 'roll-1' : 'order-1',
      displayName: objectType === 'roll' ? 'Рулон A-1/1' : 'Заказ A-1',
      statuses: [{ title: 'Производство', valueLabel: 'Выпущен' }],
      links:
        objectType === 'roll'
          ? [
              {
                objectType: 'order',
                objectId: 'order-1',
                displayName: 'Заказ A-1',
                relationLabel: 'Заказ',
              },
            ]
          : [],
      timeline: [
        {
          eventId: 'event-1',
          actionLabel: 'Рулон выпущен',
          reason: null,
          actor: { displayName: 'Анна Операторова', roleLabel: 'Оператор' },
          occurredAt: '2026-07-27T01:00:00.000Z',
        },
      ],
      problems: [],
      defects: [],
      productionFacts: [
        {
          title: 'Вес',
          valueLabel: '45 кг',
          recordedAt: '2026-07-27T01:00:00.000Z',
          isCurrent: true,
        },
      ],
      warehouseFacts: [
        {
          title: 'Операция склада',
          valueLabel: 'Приёмка',
          recordedAt: '2026-07-27T01:10:00.000Z',
          isCurrent: null,
        },
      ],
    }));

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(DirectorQrScanSurface));
    });

    const input = renderer.root.findByProps({ 'aria-label': 'QR, номер или название' });
    await act(async () => {
      input.props.onChange({ target: { value: 'A-1' } });
    });
    await act(async () => {
      renderer.root
        .findByProps({ 'aria-label': 'Поиск прослеживаемости' })
        .props.onSubmit({ preventDefault: vi.fn() });
      await flushPromises();
    });

    expect(mocks.search).toHaveBeenCalledWith({ q: 'A-1', limit: 12 });
    expect(mocks.context).toHaveBeenCalledWith('roll', 'roll-1');
    expect(renderedText(renderer)).toContain('Рулон A-1/1');
    expect(renderedText(renderer)).toContain('Заказ A-1');
    expect(renderedText(renderer)).toContain('Рулон выпущен');
    expect(renderedText(renderer)).toContain('Приёмка');

    await act(async () => {
      renderer.root.findByProps({ 'data-traceability-candidate': 'order:order-1' }).props.onClick();
      await flushPromises();
    });
    expect(mocks.context).toHaveBeenLastCalledWith('order', 'order-1');
    expect(renderedText(renderer)).toContain('Заказ A-1');
    expect(renderedText(renderer)).not.toMatch(/rawPayload|tokenHash|legalName/);
    renderer.unmount();
  });

  it.each([
    {
      token: `prt_${'a'.repeat(64)}`,
      objectType: 'roll',
      objectId: 'roll-1',
      typeLabel: 'Рулон',
      displayName: 'Рулон ROLL-001',
      factTitle: 'Текущий вес',
      factValue: '40 кг',
    },
    {
      token: `bbt_${'b'.repeat(64)}`,
      objectType: 'big_bag',
      objectId: 'bag-1',
      typeLabel: 'Big-Bag',
      displayName: 'Big-Bag BB-ПВД-01',
      factTitle: 'Материал',
      factValue: 'ПВД первичный',
    },
    {
      token: `plt_${'c'.repeat(64)}`,
      objectType: 'pallet',
      objectId: 'pallet-document-1',
      typeLabel: 'Палетный лист',
      displayName: 'Палетный лист PALLET-001',
      factTitle: 'Количество рулонов',
      factValue: '12',
    },
  ])(
    'submits a scanner $objectType QR with Enter semantics and opens its safe exact context',
    async ({ token, objectType, objectId, typeLabel, displayName, factTitle, factValue }) => {
      mocks.search.mockResolvedValue({
        items: [
          {
            objectType,
            objectId,
            displayName,
            secondaryLabel: null,
            matchKind: 'exact',
          },
        ],
        nextCursor: null,
      });
      mocks.context.mockResolvedValue({
        objectType,
        objectId,
        displayName,
        statuses: [],
        links: [],
        timeline: [],
        problems: [],
        defects: [],
        productionFacts: [
          {
            title: factTitle,
            valueLabel: factValue,
            recordedAt: '2026-08-14T06:00:00.000Z',
            isCurrent: null,
          },
        ],
        warehouseFacts: [],
      });

      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(createElement(DirectorQrScanSurface));
      });
      await act(async () => {
        renderer.root
          .findByProps({ 'aria-label': 'QR, номер или название' })
          .props.onChange({ target: { value: token } });
      });
      await act(async () => {
        renderer.root
          .findByProps({ 'aria-label': 'Поиск прослеживаемости' })
          .props.onSubmit({ preventDefault: vi.fn() });
        await flushPromises();
      });

      expect(mocks.search).toHaveBeenCalledWith({ q: token, limit: 12 });
      expect(mocks.context).toHaveBeenCalledWith(objectType, objectId);
      const candidate = renderer.root.findByProps({
        'data-traceability-candidate': `${objectType}:${objectId}`,
      });
      expect(candidate.findByType('span').children).toEqual([typeLabel]);
      expect(renderedText(renderer)).toContain(factTitle);
      expect(renderedText(renderer)).toContain(factValue);
      expect(renderedText(renderer)).not.toContain(token);
      expect(renderedText(renderer)).not.toMatch(/rawPayload|tokenHash|gatewayCommandId|secret/u);
      renderer.unmount();
    },
  );

  it('shows honest error and not-found states with a working retry action', async () => {
    mocks.search
      .mockRejectedValueOnce(new Error('Сервис прослеживаемости недоступен'))
      .mockResolvedValueOnce({ items: [], nextCursor: null });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(DirectorQrScanSurface));
    });
    const input = renderer.root.findByProps({ 'aria-label': 'QR, номер или название' });
    await act(async () => {
      input.props.onChange({ target: { value: 'UNKNOWN' } });
    });
    await act(async () => {
      renderer.root
        .findByProps({ 'aria-label': 'Поиск прослеживаемости' })
        .props.onSubmit({ preventDefault: vi.fn() });
      await flushPromises();
    });
    expect(renderedText(renderer)).toContain('Сервис прослеживаемости недоступен');

    await act(async () => {
      renderer.root.findByProps({ 'data-traceability-retry': true }).props.onClick();
      await flushPromises();
    });
    expect(mocks.search).toHaveBeenCalledTimes(2);
    expect(renderedText(renderer)).toContain('Ничего не найдено');
    renderer.unmount();
  });

  it('renders current and previous measurements without leaking technical codes', async () => {
    mocks.search.mockResolvedValue({
      items: [
        {
          objectType: 'roll',
          objectId: 'roll-1',
          displayName: 'Рулон A-11/1',
          secondaryLabel: null,
          matchKind: 'exact',
        },
      ],
      nextCursor: null,
    });
    mocks.context.mockResolvedValue({
      objectType: 'roll',
      objectId: 'roll-1',
      displayName: 'Рулон A-11/1',
      statuses: [{ title: 'Статус на складе', valueLabel: 'Принят складом' }],
      links: [],
      timeline: [
        {
          eventId: 'event-1',
          actionLabel: 'Рулон исключён из палетного листа',
          reason: 'Повреждена упаковка',
          actor: { displayName: 'Анна Складова', roleLabel: 'Склад' },
          occurredAt: '2026-08-10T12:00:00.000Z',
        },
        {
          eventId: 'event-unknown',
          actionLabel: 'Действие аудита',
          reason: null,
          actor: { displayName: 'Система', roleLabel: 'Система' },
          occurredAt: '2026-08-10T11:00:00.000Z',
        },
      ],
      problems: [],
      defects: [],
      productionFacts: [
        {
          title: 'Текущий принятый вес шпули',
          valueLabel: '1,9 кг',
          recordedAt: '2026-08-10T12:00:00.000Z',
          isCurrent: true,
        },
        {
          title: 'Предыдущее измерение шпули',
          valueLabel: '1,8 кг',
          recordedAt: '2026-08-10T10:00:00.000Z',
          isCurrent: false,
        },
      ],
      warehouseFacts: [
        {
          title: 'Операция склада',
          valueLabel: 'Приёмка по QR',
          recordedAt: '2026-08-10T12:00:00.000Z',
          isCurrent: null,
        },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(DirectorQrScanSurface));
    });
    await act(async () => {
      renderer.root
        .findByProps({ 'aria-label': 'QR, номер или название' })
        .props.onChange({ target: { value: 'A-11/1' } });
    });
    await act(async () => {
      renderer.root
        .findByProps({ 'aria-label': 'Поиск прослеживаемости' })
        .props.onSubmit({ preventDefault: vi.fn() });
      await flushPromises();
    });

    const output = renderedText(renderer);
    expect(output).toContain('Принят складом');
    expect(output).toContain('Текущий принятый вес шпули');
    expect(output).toContain('Предыдущее измерение шпули');
    expect(output).toContain('Рулон исключён из палетного листа');
    expect(output).toContain('Склад');
    expect(output).toContain('Повреждена упаковка');
    expect(output).toContain('10.08.2026');
    expect(output).toContain('Действие аудита');
    expect(output).not.toContain('Неизвестное событие');
    expect(output).not.toMatch(
      /received|receiving[_ ]scan|production[_ ]handover|audit:|manual_deselection/u,
    );
    renderer.unmount();
  });
});
