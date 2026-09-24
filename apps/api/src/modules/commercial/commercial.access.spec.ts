import { Reflector } from '@nestjs/core';
import { ROLES, capabilitiesForRole, type Capability, type Role } from '@plenka/contracts';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { CommercialNotificationController } from './commercial-notification.controller';
import { CommercialRawMaterialsController } from './commercial-raw-materials.controller';
import { CommercialController } from './commercial.controller';
import { CounterpartyTemplateController } from './counterparty-template.controller';

function ctxFor(handler: (...args: any[]) => unknown, role: Role) {
  return {
    getHandler: () => handler,
    getClass: () => CommercialController,
    switchToHttp: () => ({
      getRequest: () => ({
        actor: { userId: null, role, capabilities: capabilitiesForRole(role) },
      }),
    }),
  } as never;
}

describe('commercial role-leakage', () => {
  const guard = new CapabilityGuard(new Reflector());
  const proto = CommercialController.prototype;

  it('operator cannot create an order', () => {
    expect(() => guard.canActivate(ctxFor(proto.create, 'operator'))).toThrow();
  });

  it('warehouse cannot apply a correction', () => {
    expect(() => guard.canActivate(ctxFor(proto.correction, 'warehouse'))).toThrow();
  });

  it('material shortage correction is commercial-only', () => {
    expect(guard.canActivate(ctxFor(proto.materialShortageCorrection, 'commercial'))).toBe(true);
    expect(() => guard.canActivate(ctxFor(proto.materialShortageCorrection, 'operator'))).toThrow();
    expect(() => guard.canActivate(ctxFor(proto.materialShortageCorrection, 'finance'))).toThrow();
    expect(
      new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, proto.materialShortageCorrection),
    ).toEqual(['correction:create']);
  });

  it('problem-scoped recipe correction is commercial-only', () => {
    expect(guard.canActivate(ctxFor(proto.problemCorrection, 'commercial'))).toBe(true);
    expect(() => guard.canActivate(ctxFor(proto.problemCorrection, 'production_lead'))).toThrow();
    expect(() => guard.canActivate(ctxFor(proto.problemCorrection, 'warehouse'))).toThrow();
    expect(
      new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, proto.problemCorrection),
    ).toEqual(['correction:create']);
  });

  it('commercial CAN create an order', () => {
    expect(guard.canActivate(ctxFor(proto.create, 'commercial'))).toBe(true);
  });

  it('only commercial can update the finance note', () => {
    expect(guard.canActivate(ctxFor(proto.updateFinanceNote, 'commercial'))).toBe(true);
    for (const role of ROLES.filter((candidate) => candidate !== 'commercial')) {
      expect(() => guard.canActivate(ctxFor(proto.updateFinanceNote, role))).toThrow();
    }
    expect(
      new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, proto.updateFinanceNote),
    ).toEqual(['order:update_finance_note']);
  });

  it('only commercial can update an order comment', () => {
    expect(guard.canActivate(ctxFor(proto.updateOrderComment, 'commercial'))).toBe(true);
    for (const role of [
      'production_lead',
      'operator',
      'warehouse',
      'finance',
      'director',
      'admin',
    ] as const) {
      expect(() => guard.canActivate(ctxFor(proto.updateOrderComment, role))).toThrow();
    }
    expect(
      new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, proto.updateOrderComment),
    ).toEqual(['order:update_position']);
  });

  it('only commercial can amend the desired order specification', () => {
    expect(guard.canActivate(ctxFor(proto.amend, 'commercial'))).toBe(true);
    for (const role of ROLES.filter((candidate) => candidate !== 'commercial')) {
      expect(() => guard.canActivate(ctxFor(proto.amend, role))).toThrow();
    }
    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, proto.amend)).toEqual([
      'order:amend',
    ]);
  });

  it('only director can cancel unfinished production rolls', () => {
    expect(guard.canActivate(ctxFor(proto.cancelUnfinished, 'director'))).toBe(true);
    for (const role of ROLES.filter((candidate) => candidate !== 'director')) {
      expect(() => guard.canActivate(ctxFor(proto.cancelUnfinished, role))).toThrow();
    }
    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, proto.cancelUnfinished)).toEqual(
      ['override:production'],
    );
  });

  it('only commercial can permanently delete an order', () => {
    expect(guard.canActivate(ctxFor(proto.delete, 'commercial'))).toBe(true);
    for (const role of ROLES.filter((candidate) => candidate !== 'commercial')) {
      expect(() => guard.canActivate(ctxFor(proto.delete, role))).toThrow();
    }
    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, proto.delete)).toEqual([
      'order:cancel',
    ]);
  });

  it('only commercial can cancel an order with downstream work', () => {
    expect(guard.canActivate(ctxFor(proto.cancel, 'commercial'))).toBe(true);
    for (const role of ROLES.filter((candidate) => candidate !== 'commercial')) {
      expect(() => guard.canActivate(ctxFor(proto.cancel, role))).toThrow();
    }
    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, proto.cancel)).toEqual([
      'order:cancel',
    ]);
  });

  it('only commercial can use the explicit paid-order production handoff route', () => {
    expect(guard.canActivate(ctxFor(proto.sendToProduction, 'commercial'))).toBe(true);
    expect(() => guard.canActivate(ctxFor(proto.sendToProduction, 'production_lead'))).toThrow();
    expect(() => guard.canActivate(ctxFor(proto.sendToProduction, 'operator'))).toThrow();
    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, proto.sendToProduction)).toEqual(
      ['production_order:handoff'],
    );
  });

  it('production_lead CAN create an order (on-behalf-of-commercial delegation)', () => {
    expect(guard.canActivate(ctxFor(proto.create, 'production_lead'))).toBe(true);
  });

  it('only commercial has warehouse_cover:override', () => {
    expect(capabilitiesForRole('commercial')).toContain('warehouse_cover:override');
    for (const role of ROLES.filter((r) => r !== 'commercial')) {
      expect(capabilitiesForRole(role)).not.toContain('warehouse_cover:override');
    }
  });

  it('grants order amendment and cancellation only to commercial', () => {
    expect(capabilitiesForRole('commercial')).toEqual(
      expect.arrayContaining(['order:amend', 'order:cancel']),
    );
    for (const role of ROLES.filter((candidate) => candidate !== 'commercial')) {
      expect(capabilitiesForRole(role)).not.toContain('order:amend');
      expect(capabilitiesForRole(role)).not.toContain('order:cancel');
    }
  });

  it('commercial has raw_material:read but cannot adjust raw materials', () => {
    expect(capabilitiesForRole('commercial')).toContain('raw_material:read');
    expect(capabilitiesForRole('commercial')).not.toContain('raw_material:adjust');
  });

  it('commercial can read templates and production_lead can write them', () => {
    expect(capabilitiesForRole('commercial')).toContain('counterparty_template:read');
    expect(capabilitiesForRole('commercial')).not.toContain('counterparty_template:write');
    expect(capabilitiesForRole('production_lead')).toEqual(
      expect.arrayContaining(['counterparty_template:read', 'counterparty_template:write']),
    );
  });

  it('force-production route requires warehouse_cover:override', () => {
    const reflector = new Reflector();
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.forceProduction)).toEqual([
      'warehouse_cover:override',
    ]);
  });

  it('separates commercial route approval from production technical approval', () => {
    const reflector = new Reflector();
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.approveWarehouseCover)).toEqual([
      'warehouse_cover:confirm',
    ]);
    expect(
      reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.approveWarehouseCoverTechnically),
    ).toEqual(['warehouse_cover:technical_approve']);

    expect(guard.canActivate(ctxFor(proto.approveWarehouseCover, 'commercial'))).toBe(true);
    expect(() =>
      guard.canActivate(ctxFor(proto.approveWarehouseCover, 'production_lead')),
    ).toThrow();
    expect(
      guard.canActivate(ctxFor(proto.approveWarehouseCoverTechnically, 'production_lead')),
    ).toBe(true);
    expect(() =>
      guard.canActivate(ctxFor(proto.approveWarehouseCoverTechnically, 'commercial')),
    ).toThrow();
    expect(() =>
      guard.canActivate(ctxFor(proto.approveWarehouseCoverTechnically, 'warehouse')),
    ).toThrow();
  });

  it('commercial raw materials route requires raw_material:read', () => {
    const reflector = new Reflector();
    for (const handler of [
      CommercialRawMaterialsController.prototype.list,
      CommercialRawMaterialsController.prototype.bigBagValues,
    ]) {
      expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([
        'raw_material:read',
      ]);
      expect(guard.canActivate(ctxFor(handler, 'commercial'))).toBe(true);
      expect(() => guard.canActivate(ctxFor(handler, 'operator'))).toThrow();
    }
  });

  it('commercial notification routes are capability-gated without leaking to other roles', () => {
    const reflector = new Reflector();
    const notificationProto = CommercialNotificationController.prototype;

    for (const handler of [notificationProto.list, notificationProto.markRead]) {
      expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([
        'commercial_notification:read',
      ]);
      expect(guard.canActivate(ctxFor(handler, 'commercial'))).toBe(true);
      expect(() => guard.canActivate(ctxFor(handler, 'production_lead'))).toThrow();
      expect(() => guard.canActivate(ctxFor(handler, 'warehouse'))).toThrow();
      expect(() => guard.canActivate(ctxFor(handler, 'finance'))).toThrow();
      expect(() => guard.canActivate(ctxFor(handler, 'operator'))).toThrow();
      expect(() => guard.canActivate(ctxFor(handler, 'director'))).toThrow();
    }
  });

  it('counterparty template routes declare read/write capabilities', () => {
    const reflector = new Reflector();
    expect(
      reflector.get<Capability[]>(
        REQUIRE_CAPABILITIES,
        CounterpartyTemplateController.prototype.list,
      ),
    ).toEqual(['counterparty_template:read']);
    expect(
      reflector.get<Capability[]>(
        REQUIRE_CAPABILITIES,
        CounterpartyTemplateController.prototype.create,
      ),
    ).toEqual(['counterparty_template:write']);
    expect(
      reflector.get<Capability[]>(
        REQUIRE_CAPABILITIES,
        (
          CounterpartyTemplateController.prototype as never as {
            updateStatus: (...args: never[]) => unknown;
          }
        ).updateStatus,
      ),
    ).toEqual(['counterparty_template:write']);
  });

  it('every commercial mutation route declares a capability', () => {
    const reflector = new Reflector();
    for (const handler of [
      proto.create,
      proto.delete,
      proto.sendToProduction,
      proto.updateOrderComment,
      proto.updatePosition,
      proto.updateFinanceNote,
      proto.approveWarehouseCover,
      proto.approveWarehouseCoverTechnically,
      proto.requestPositionCoverRecheck,
      proto.forceProduction,
      proto.correction,
      proto.problemCorrection,
      proto.materialShortageCorrection,
      proto.invoiceHandoff,
      proto.submitToFinance,
    ]) {
      const caps = reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler);
      expect(caps && caps.length).toBeTruthy();
    }
  });
});
