import { Reflector } from '@nestjs/core';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { OperatorController } from './operator.controller';
import { capabilitiesForRole, type Capability, type Role } from '@plenka/contracts';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctxFor(handler: (...args: any[]) => unknown, role: Role) {
  return {
    getHandler: () => handler,
    getClass: () => OperatorController,
    switchToHttp: () => ({
      getRequest: () => ({
        actor: { userId: null, role, capabilities: capabilitiesForRole(role) },
      }),
    }),
  } as never;
}

describe('operator role-leakage', () => {
  const guard = new CapabilityGuard(new Reflector());
  const proto = OperatorController.prototype;

  it('operator notification routes are capability-gated without leaking to other roles', () => {
    const reflector = new Reflector();
    const inboxProto = proto as unknown as {
      notifications?: typeof proto.current;
      markNotificationRead?: typeof proto.current;
    };

    for (const handler of [inboxProto.notifications, inboxProto.markNotificationRead]) {
      expect(handler).toBeDefined();
      if (!handler) continue;

      expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([
        'operator_task:read',
      ]);
      expect(guard.canActivate(ctxFor(handler, 'operator'))).toBe(true);
      for (const role of [
        'commercial',
        'finance',
        'production_lead',
        'warehouse',
        'director',
      ] as const) {
        expect(() => guard.canActivate(ctxFor(handler, role))).toThrow();
      }
    }
  });

  it('warehouse cannot capture a roll weight', () => {
    expect(() => guard.canActivate(ctxFor(proto.rollWeight, 'warehouse'))).toThrow();
    expect(() => guard.canActivate(ctxFor(proto.reweighRoll, 'warehouse'))).toThrow();
    expect(() => guard.canActivate(ctxFor(proto.stepBack, 'warehouse'))).toThrow();
  });

  it('commercial cannot record a defect', () => {
    expect(() => guard.canActivate(ctxFor(proto.defect, 'commercial'))).toThrow();
  });

  it('operator CAN weigh and hand over', () => {
    expect(guard.canActivate(ctxFor(proto.spoolWeight, 'operator'))).toBe(true);
    expect(guard.canActivate(ctxFor(proto.reweighRoll, 'operator'))).toBe(true);
    expect(guard.canActivate(ctxFor(proto.stepBack, 'operator'))).toBe(true);
    expect(guard.canActivate(ctxFor(proto.handover, 'operator'))).toBe(true);
  });

  it('keeps defect-bag weighing and printing operator-only', () => {
    const reflector = new Reflector();
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.defectBagWeigh)).toEqual([
      'defect_bag:weigh',
    ]);
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.defectBagPrint)).toEqual([
      'defect_bag:print',
    ]);
    expect(guard.canActivate(ctxFor(proto.defectBagWeigh, 'operator'))).toBe(true);
    expect(guard.canActivate(ctxFor(proto.defectBagPrint, 'operator'))).toBe(true);
    for (const role of [
      'commercial',
      'production_lead',
      'warehouse',
      'finance',
      'director',
    ] as const) {
      expect(() => guard.canActivate(ctxFor(proto.defectBagWeigh, role))).toThrow();
      expect(() => guard.canActivate(ctxFor(proto.defectBagPrint, role))).toThrow();
    }
  });

  it('requires both QR and handover capabilities for the automatic scan route', () => {
    const reflector = new Reflector();
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.qrVerifyAndHandover)).toEqual([
      'roll:qr',
      'roll:handover',
    ]);
    expect(guard.canActivate(ctxFor(proto.qrVerifyAndHandover, 'operator'))).toBe(true);
  });

  it('gates pre-print reweigh with roll:weigh for every non-operator role', () => {
    const reflector = new Reflector();
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.reweighRoll)).toEqual([
      'roll:weigh',
    ]);
    for (const role of [
      'commercial',
      'production_lead',
      'warehouse',
      'finance',
      'director',
      'admin',
    ] as const) {
      expect(() => guard.canActivate(ctxFor(proto.reweighRoll, role))).toThrow();
    }
  });

  it('gates step back with roll:weigh for every non-operator role', () => {
    const reflector = new Reflector();
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.stepBack)).toEqual([
      'roll:weigh',
    ]);
    for (const role of [
      'commercial',
      'production_lead',
      'warehouse',
      'finance',
      'director',
      'admin',
    ] as const) {
      expect(() => guard.canActivate(ctxFor(proto.stepBack, role))).toThrow();
    }
  });

  it('operator can read only the operator penalty projection', () => {
    expect(guard.canActivate(ctxFor(proto.penalties, 'operator'))).toBe(true);
    expect(() => guard.canActivate(ctxFor(proto.penalties, 'production_lead'))).toThrow();
  });

  it('warehouse cannot manage a post session (post_session:manage is operator-only)', () => {
    expect(() => guard.canActivate(ctxFor(proto.openSession, 'warehouse'))).toThrow();
    expect(() => guard.canActivate(ctxFor(proto.closeSession, 'production_lead'))).toThrow();
  });

  it('operator CAN open/close their own post session', () => {
    expect(guard.canActivate(ctxFor(proto.openSession, 'operator'))).toBe(true);
    expect(guard.canActivate(ctxFor(proto.closeSession, 'operator'))).toBe(true);
    expect(guard.canActivate(ctxFor(proto.finalizeMachineChange, 'operator'))).toBe(true);
    expect(guard.canActivate(ctxFor(proto.currentMachineChange, 'operator'))).toBe(true);
    expect(() =>
      guard.canActivate(ctxFor(proto.finalizeMachineChange, 'production_lead')),
    ).toThrow();
  });

  it('allows only operators to report operator-contour problems', () => {
    expect(guard.canActivate(ctxFor(proto.problem, 'operator'))).toBe(true);
    expect(guard.canActivate(ctxFor(proto.reportMachineBreakdown, 'operator'))).toBe(true);
    for (const role of ['commercial', 'production_lead', 'warehouse', 'finance'] as const) {
      expect(() => guard.canActivate(ctxFor(proto.problem, role))).toThrow();
      expect(() => guard.canActivate(ctxFor(proto.reportMachineBreakdown, role))).toThrow();
    }
  });

  it('every operator mutation route declares a capability', () => {
    const reflector = new Reflector();
    for (const handler of [
      proto.accept,
      proto.spoolWeight,
      proto.rollWeight,
      proto.reweighRoll,
      proto.stepBack,
      proto.defect,
      proto.defer,
      proto.resume,
      proto.qrPrint,
      proto.qrVerify,
      proto.qrVerifyAndHandover,
      proto.handover,
      proto.bigBag,
      proto.defectBagWeigh,
      proto.defectBagPrint,
      proto.problem,
      proto.reportMachineBreakdown,
      proto.openShift,
      proto.addShiftBag,
      proto.releaseShiftBag,
      proto.closeShift,
      proto.openSession,
      proto.closeSession,
      proto.finalizeMachineChange,
    ]) {
      const caps = reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler);
      expect(caps && caps.length).toBeTruthy();
    }
  });
});
