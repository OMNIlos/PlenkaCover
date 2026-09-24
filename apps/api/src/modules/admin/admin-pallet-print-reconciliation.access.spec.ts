import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { capabilitiesForRole, type Capability } from '@plenka/contracts';
import type { ExecutionContext } from '@nestjs/common';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import { AdminPalletPrintReconciliationController } from './admin-pallet-print-reconciliation.controller';

function contextFor(
  handler: (...args: never[]) => unknown,
  role: 'admin' | 'warehouse',
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        actor: { userId: `${role}-1`, role, capabilities: capabilitiesForRole(role) },
      }),
    }),
    getHandler: () => handler,
    getClass: () => AdminPalletPrintReconciliationController,
  } as unknown as ExecutionContext;
}

describe('Admin pallet print reconciliation access', () => {
  it('requires admin:devices and rejects warehouse capability leakage', () => {
    const controller = AdminPalletPrintReconciliationController.prototype;
    const reflector = new Reflector();
    const guard = new CapabilityGuard(reflector);
    for (const handler of [controller.listUnresolved, controller.reconcile]) {
      expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual(['admin:devices']);
      expect(guard.canActivate(contextFor(handler, 'admin'))).toBe(true);
      expect(() => guard.canActivate(contextFor(handler, 'warehouse'))).toThrow(ForbiddenException);
    }
  });
});
