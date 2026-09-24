import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { capabilitiesForRole, ROLES, type Capability, type Role } from '@plenka/contracts';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import { DirectorRollCostController } from './director-roll-cost.controller';
import { DirectorRollCostService } from './director-roll-cost.service';
import { DirectorModule } from './director.module';
import { RollProductionCostAssemblerService } from './roll-production-cost-assembler.service';
import { RollProductionCostReconcilerScheduler } from './roll-production-cost-reconciler.scheduler';
import { RollProductionCostSnapshotService } from './roll-production-cost-snapshot.service';

function contextFor(role: Role) {
  return {
    getHandler: () => DirectorRollCostController.prototype.preview,
    getClass: () => DirectorRollCostController,
    switchToHttp: () => ({
      getRequest: () => ({
        actor: { userId: `${role}-user`, role, capabilities: capabilitiesForRole(role) },
      }),
    }),
  } as never;
}

describe('director roll-cost access', () => {
  const handler = DirectorRollCostController.prototype.preview;
  const guard = new CapabilityGuard(new Reflector());

  it('registers GET /director/roll-costs with both director and cost read capabilities', () => {
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('roll-costs');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([
      'director:read',
      'production_cost:read',
    ]);
  });

  it('allows the director and rejects every other role', () => {
    expect(guard.canActivate(contextFor('director'))).toBe(true);
    for (const role of ROLES.filter((candidate) => candidate !== 'director')) {
      expect(() => guard.canActivate(contextFor(role))).toThrow();
    }
  });

  it('registers the isolated boundary and service in DirectorModule', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, DirectorModule)).toContain(
      DirectorRollCostController,
    );
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, DirectorModule)).toContain(
      DirectorRollCostService,
    );
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, DirectorModule)).toEqual(
      expect.arrayContaining([
        RollProductionCostAssemblerService,
        RollProductionCostSnapshotService,
        RollProductionCostReconcilerScheduler,
      ]),
    );
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, DirectorModule)).toContain(
      RollProductionCostSnapshotService,
    );
  });
});
