import { DECORATORS } from '@nestjs/swagger';
import { DOMAIN_EVENTS } from '@plenka/contracts';
import { RoleInboxCtaResponseDto, RoleInboxPageResponseDto } from './dto/role-inbox-response.dto';
import { ROLE_INBOX_PRESENTATIONS, presentationFor, recipientsFor } from './role-inbox.registry';

describe('role inbox presentation registry', () => {
  it('routes each required cross-contour fact to its next owner', () => {
    expect(recipientsFor('audit:invoice_handoff_created')).toContain('finance');
    expect(recipientsFor('audit:invoice_status_updated')).toContain('commercial');
    expect(recipientsFor('audit:production_order_created')).toContain('production_lead');
    expect(recipientsFor('audit:task_assigned')).toContain('operator');
    expect(recipientsFor('audit:task_reassigned')).toContain('operator');
    expect(recipientsFor('audit:warehouse_cover_recheck_requested')).toContain('warehouse');
    expect(recipientsFor('audit:warehouse_coverage_calculated')).toContain('finance');
    expect(recipientsFor('audit:warehouse_coverage_recheck_requested')).toContain('warehouse');
    expect(recipientsFor('audit:warehouse_coverage_recheck_resolved')).toContain('finance');
    expect(recipientsFor('audit:warehouse_cover_proposed')).toContain('commercial');
    expect(recipientsFor('audit:operator_roll_handed_over')).toContain('warehouse');
    expect(recipientsFor('problem:payment_overdue')).toContain('director');
    expect(recipientsFor('problem:warehouse_defect_reported')).toContain('production_lead');
    expect(recipientsFor('notification:penalty_created')).toEqual(
      expect.arrayContaining(['operator', 'production_lead']),
    );
  });

  it('fans a post-error correction out to every related business contour', () => {
    expect(recipientsFor('notification:commercial_correction_applied')).toEqual([
      'commercial',
      'production_lead',
      'operator',
      'warehouse',
      'finance',
      'director',
    ]);
  });

  it('routes a recipient-aware commercial amendment to finance, production and warehouse', () => {
    expect(recipientsFor('notification:commercial_order_amended')).toEqual([
      'finance',
      'production_lead',
      'warehouse',
    ]);
  });

  it.each([
    'notification:commercial_order_cancelled',
    'notification:commercial_order_reactivated',
  ] as const)('routes %s only to the four affected business contours', (eventType) => {
    expect(recipientsFor(eventType)).toEqual([
      'commercial',
      'production_lead',
      'finance',
      'warehouse',
    ]);
    expect(recipientsFor(eventType)).not.toContain('operator');
    expect(recipientsFor(eventType)).not.toContain('director');
  });

  it('covers defect, machine-change, override, replacement and recovery alerts', () => {
    expect(recipientsFor('problem:operator_defect_reported')).toEqual(
      expect.arrayContaining(['operator', 'production_lead', 'director']),
    );
    expect(recipientsFor('problem:production_defect_reported')).toEqual(
      expect.arrayContaining(['operator', 'production_lead', 'director']),
    );
    expect(recipientsFor('problem:warehouse_defect_reported')).toEqual(
      expect.arrayContaining(['operator', 'production_lead', 'warehouse', 'director']),
    );
    for (const eventType of [
      'notification:operator_machine_change_requested',
      'notification:operator_machine_change_ready',
      'notification:operator_machine_change_completed',
    ] as const) {
      expect(recipientsFor(eventType)).toEqual(['operator', 'production_lead', 'director']);
    }
    expect(recipientsFor('notification:operator_machine_change_cancelled')).toEqual([
      'operator',
      'production_lead',
    ]);
    expect(recipientsFor('audit:director_finance_override_applied')).toEqual(
      expect.arrayContaining(['finance', 'director']),
    );
    expect(recipientsFor('audit:director_production_override_applied')).toEqual(
      expect.arrayContaining(['production_lead', 'director']),
    );
    expect(recipientsFor('audit:director_warehouse_override_applied')).toEqual(
      expect.arrayContaining(['warehouse', 'director']),
    );
    expect(recipientsFor('audit:replacement_roll_created')).toEqual(
      expect.arrayContaining(['operator', 'production_lead', 'warehouse', 'director']),
    );
    expect(recipientsFor('audit:defect_resolved_rework')).toEqual(
      expect.arrayContaining(['operator', 'production_lead', 'warehouse', 'director']),
    );
    expect(recipientsFor('audit:operator_physical_operation_recovered')).toEqual(
      expect.arrayContaining(['operator', 'production_lead']),
    );
    expect(recipientsFor('audit:warehouse_physical_operation_recovered')).toEqual(
      expect.arrayContaining(['warehouse', 'production_lead']),
    );
  });

  it('keeps planning and approval audit facts outside the operator inbox', () => {
    for (const eventType of [
      'audit:roll_dispatch_assigned',
      'audit:roll_dispatch_bulk_assigned',
      'audit:production_order_approved',
    ] as const) {
      expect(recipientsFor(eventType)).not.toContain('operator');
    }
  });

  it('routes automatic delivery creation only to warehouse', () => {
    expect(recipientsFor('audit:warehouse_delivery_task_created')).toEqual(['warehouse']);
  });

  it('routes a fully handed-over production order only to the production lead', () => {
    expect(DOMAIN_EVENTS).toContain('notification:production_order_fully_handed_over');
    expect(recipientsFor('notification:production_order_fully_handed_over')).toEqual([
      'production_lead',
    ]);
    expect(
      presentationFor('notification:production_order_fully_handed_over', 'production_lead'),
    ).toMatchObject({
      nextOwnerRole: 'production_lead',
      cta: { kind: 'production_order', section: 'Заказ-наряды' },
    });
  });

  it('keeps V2 coverage actions with their owning roles', () => {
    expect(presentationFor('audit:warehouse_coverage_calculated', 'finance')).toMatchObject({
      nextOwnerRole: 'finance',
      cta: { kind: 'finance_order', section: 'Обзор' },
    });
    expect(
      presentationFor('audit:warehouse_coverage_recheck_requested', 'warehouse'),
    ).toMatchObject({
      nextOwnerRole: 'warehouse',
      cta: { kind: 'warehouse_cover', section: 'Запасы / резерв' },
    });
    expect(presentationFor('audit:warehouse_coverage_recheck_resolved', 'finance')).toMatchObject({
      nextOwnerRole: 'finance',
      cta: { kind: 'finance_order', section: 'Обзор' },
    });
  });

  it('keeps replacement-roll creation canonical', () => {
    expect(DOMAIN_EVENTS).toContain('audit:replacement_roll_created');
  });

  it('declares complete, pair-addressable safe presentations', () => {
    const routeKeys = new Set<string>();

    for (const presentation of ROLE_INBOX_PRESENTATIONS) {
      const key = `${presentation.eventType}\u0000${presentation.recipientRole}`;

      expect(routeKeys.has(key)).toBe(false);
      routeKeys.add(key);
      expect(presentation.title.trim()).not.toBe('');
      expect(presentation.body.trim()).not.toBe('');
      expect(presentation.severity).toBeTruthy();
      expect(presentation.cta.kind).toBeTruthy();
      expect(presentation.cta.section.trim()).not.toBe('');
      expect(presentation.nextOwnerRole).toBeTruthy();
      expect(presentationFor(presentation.eventType, presentation.recipientRole)).toBe(
        presentation,
      );
    }
  });

  it('keeps automatic delivery creation in the canonical event vocabulary', () => {
    expect(DOMAIN_EVENTS).toContain('audit:warehouse_delivery_task_created');
  });

  it('declares safe non-order notification foundations', () => {
    expect(DOMAIN_EVENTS).toContain('admin.incident.opened');
    expect(DOMAIN_EVENTS).toContain('admin.incident.reopened');
    expect(
      presentationFor('notification:production_problem_received', 'production_lead')?.cta.kind,
    ).toBe('production_problem');
    expect(presentationFor('admin.incident.opened', 'admin')?.cta.kind).toBe('admin_incident');
    expect(presentationFor('admin.incident.reopened', 'admin')?.cta.kind).toBe('admin_incident');
    expect(recipientsFor('admin.incident.acknowledged')).toEqual([]);
    expect(recipientsFor('admin.incident.resolved')).toEqual([]);
  });

  it('documents every inbox CTA and the complete unread count in Swagger', () => {
    const ctaKind = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      RoleInboxCtaResponseDto.prototype,
      'kind',
    ) as { enum: string[] };
    const unreadCount = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      RoleInboxPageResponseDto.prototype,
      'unreadCount',
    );

    expect(ctaKind.enum).toEqual([
      'commercial_order',
      'finance_order',
      'production_order',
      'operator_roll',
      'warehouse_cover',
      'warehouse_intake',
      'director_decision',
      'penalty',
      'production_problem',
      'operator_queue',
      'admin_incident',
    ]);
    expect(unreadCount).toEqual(expect.objectContaining({ type: Number }));
  });
});
