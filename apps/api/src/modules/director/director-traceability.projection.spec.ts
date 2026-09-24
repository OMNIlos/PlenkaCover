import {
  BIG_BAG_LOCATIONS,
  BIG_BAG_PRINT_STATUSES,
  BIG_BAG_REGISTRATION_STATUSES,
  BIG_BAG_STATUSES,
  COMMERCIAL_STAGES,
  DEVICE_STATUSES,
  DISPATCH_ITEM_STATUSES,
  DOMAIN_EVENTS,
  LABEL_LIFECYCLE,
  OPERATOR_MACHINE_ASSIGNMENT_STATUSES,
  OPERATOR_STEPS,
  PAYMENT_STATUSES,
  POST_AGENT_STATUSES,
  POST_STATUSES,
  PRODUCTION_INDICATORS,
  PRODUCTION_PROBLEM_STATUSES,
  ROLL_WAREHOUSE_STATES,
  SCAN_STATUSES,
  SHIPMENT_STATUSES,
  SHIFT_STATUSES,
  SOURCE_HEALTH_STATUSES,
  WAREHOUSE_COVER_STATUSES,
} from '@plenka/contracts';
import {
  projectTraceabilityEvent,
  projectTraceabilityFact,
  projectTraceabilityStatus,
} from './director-traceability.projection';

const RECORDED_AT = '2026-08-14T06:00:00.000Z';

describe('director traceability presentation', () => {
  it('projects every shared runtime status without unknown or internal-code labels', () => {
    const values = [
      ...PRODUCTION_INDICATORS,
      ...WAREHOUSE_COVER_STATUSES,
      ...PAYMENT_STATUSES,
      ...SHIPMENT_STATUSES,
      ...COMMERCIAL_STAGES,
      ...DISPATCH_ITEM_STATUSES,
      ...OPERATOR_STEPS,
      ...LABEL_LIFECYCLE,
      ...ROLL_WAREHOUSE_STATES,
      ...PRODUCTION_PROBLEM_STATUSES,
      ...SCAN_STATUSES,
      ...BIG_BAG_STATUSES,
      ...BIG_BAG_REGISTRATION_STATUSES,
      ...BIG_BAG_LOCATIONS,
      ...BIG_BAG_PRINT_STATUSES,
      ...DEVICE_STATUSES,
      ...SOURCE_HEALTH_STATUSES,
      ...POST_STATUSES,
      ...POST_AGENT_STATUSES,
      ...SHIFT_STATUSES,
      ...OPERATOR_MACHINE_ASSIGNMENT_STATUSES,
    ];

    for (const value of new Set(values)) {
      const status = projectTraceabilityStatus('status', value);
      expect(status.valueLabel).not.toMatch(/Неизвест/u);
      expect(status.valueLabel).not.toBe(value);
      expect(status.valueLabel.trim()).not.toHaveLength(0);
    }

    expect(projectTraceabilityStatus('big_bag', 'in_use')).toEqual({
      title: 'Big-Bag',
      valueLabel: 'Используется',
    });
    expect(projectTraceabilityStatus('registration', 'registered')).toEqual({
      title: 'Регистрация',
      valueLabel: 'Зарегистрирован',
    });
    expect(projectTraceabilityStatus('location', 'production')).toEqual({
      title: 'Местоположение',
      valueLabel: 'На производстве',
    });
    expect(projectTraceabilityStatus('pallet', 'voided')).toEqual({
      title: 'Палета',
      valueLabel: 'Аннулирована',
    });
    expect(projectTraceabilityStatus('print', 'submitted')).toEqual({
      title: 'Печать',
      valueLabel: 'Передана на печать',
    });
  });

  it('projects every registered DomainEvent without exposing technical event names', () => {
    for (const eventType of DOMAIN_EVENTS) {
      const event = projectTraceabilityEvent({
        eventId: `event-${eventType}`,
        eventType,
        label: null,
        reason: null,
        actorRole: 'system',
        actor: null,
        occurredAt: RECORDED_AT,
      });
      expect(event.actionLabel).not.toMatch(/Неизвест/u);
      expect(event.actionLabel).not.toBe(eventType);
      expect(event.actionLabel).not.toMatch(/^[a-z]+:[a-z0-9_]+$/u);
    }
  });

  it('prefers a safe business label and rejects an internal-looking stored label', () => {
    expect(
      projectTraceabilityEvent({
        eventId: 'safe-label',
        eventType: 'audit:future_event',
        label: 'Палетный лист проверен',
        reason: null,
        actorRole: 'warehouse',
        actor: null,
        occurredAt: RECORDED_AT,
      }).actionLabel,
    ).toBe('Палетный лист проверен');

    expect(
      projectTraceabilityEvent({
        eventId: 'unsafe-label',
        eventType: 'audit:future_event',
        label: 'raw_payload_gateway_token_hash',
        reason: null,
        actorRole: null,
        actor: null,
        occurredAt: RECORDED_AT,
      }).actionLabel,
    ).toBe('Действие аудита');
  });

  it.each([
    ['big_bag_material', 'ПВД первичный', null, 'Материал', 'ПВД первичный'],
    ['big_bag_current_weight', 420, 'kg', 'Текущий вес', '420 кг'],
    [
      'big_bag_shift_usage',
      'Смена 14.08 · Иван · 425 кг',
      null,
      'Использование в смене',
      'Смена 14.08 · Иван · 425 кг',
    ],
    [
      'big_bag_movement',
      'Со склада → На производство',
      null,
      'Движение Big-Bag',
      'Со склада → На производство',
    ],
    ['pallet_roll_count', 2, null, 'Количество рулонов', '2'],
    ['pallet_orders', 'ORD-001, ORD-002', null, 'Заказы', 'ORD-001, ORD-002'],
    ['pallet_customers', 'Альфа, Бета', null, 'Заказчики', 'Альфа, Бета'],
    ['pallet_rolls', 'ROLL-001, ROLL-002', null, 'Рулоны', 'ROLL-001, ROLL-002'],
    ['pallet_void_reason', 'Ошибка состава', null, 'Аннулирование', 'Ошибка состава'],
  ])(
    'projects the %s fact through its explicit safe presenter',
    (kind, value, unit, title, valueLabel) => {
      expect(
        projectTraceabilityFact({
          kind,
          value,
          unit,
          recordedAt: RECORDED_AT,
          source: 'platform',
        }),
      ).toEqual({ title, valueLabel, recordedAt: RECORDED_AT, isCurrent: null });
    },
  );

  it('uses a non-reflective fallback for a future fact kind', () => {
    expect(
      projectTraceabilityFact({
        kind: 'future_raw_payload_fact',
        value: 'secret_internal_value',
        unit: null,
        recordedAt: RECORDED_AT,
        source: 'device_gateway',
      }),
    ).toEqual({
      title: 'Зафиксированный факт',
      valueLabel: 'Зафиксировано',
      recordedAt: RECORDED_AT,
      isCurrent: null,
    });
  });
});
