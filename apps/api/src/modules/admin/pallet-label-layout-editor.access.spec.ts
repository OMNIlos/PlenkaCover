import { Reflector } from '@nestjs/core';
import { capabilitiesForRole, type Capability, type Role } from '@plenka/contracts';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import { PalletLabelLayoutEditorController } from './pallet-label-layout-editor.controller';

type Handler = (...args: never[]) => unknown;

function context(handler: Handler, role: Role) {
  return {
    getHandler: () => handler,
    getClass: () => PalletLabelLayoutEditorController,
    switchToHttp: () => ({
      getRequest: () => ({
        actor: { userId: `${role}-1`, role, capabilities: capabilitiesForRole(role) },
      }),
    }),
  } as never;
}

describe('pallet-label layout editor role leakage', () => {
  const reflector = new Reflector();
  const guard = new CapabilityGuard(reflector);
  const controller = PalletLabelLayoutEditorController.prototype;
  const handlers = [controller.bootstrap, controller.preview, controller.publish] as Handler[];

  it('declares the dedicated capability on every route', () => {
    for (const handler of handlers) {
      expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([
        'pallet_label_layout:manage',
      ]);
    }
  });

  it('allows canonical admins and rejects every non-admin base role', () => {
    for (const handler of handlers) {
      expect(guard.canActivate(context(handler, 'admin'))).toBe(true);
      for (const role of [
        'commercial',
        'production_lead',
        'operator',
        'warehouse',
        'finance',
        'director',
      ] as const) {
        expect(() => guard.canActivate(context(handler, role))).toThrow();
      }
    }
  });
});
