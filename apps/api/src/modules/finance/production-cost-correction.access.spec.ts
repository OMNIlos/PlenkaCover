import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { capabilitiesForRole, ROLES, type Capability, type Role } from '@plenka/contracts';
import { validate } from 'class-validator';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import { CorrectRollProductionCostDto } from './dto/production-cost-correction.dto';
import { ProductionCostCorrectionController } from './production-cost-correction.controller';
import { FinanceModule } from './finance.module';
import { DirectorModule } from '../director/director.module';

function contextFor(role: Role) {
  return {
    getHandler: () => ProductionCostCorrectionController.prototype.correct,
    getClass: () => ProductionCostCorrectionController,
    switchToHttp: () => ({
      getRequest: () => ({
        actor: { userId: `${role}-user`, role, capabilities: capabilitiesForRole(role) },
      }),
    }),
  } as never;
}

describe('ProductionCostCorrectionController contract', () => {
  it('exposes one capability-gated append-only correction command', () => {
    const handler = ProductionCostCorrectionController.prototype.correct;
    expect(Reflect.getMetadata(PATH_METADATA, ProductionCostCorrectionController)).toBe(
      'finance/production-costs',
    );
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':rollDispatchItemId/corrections');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([
      'production_cost:correct',
    ]);
  });

  it('requires a UUID key, positive expected version, and bounded nonempty reason', async () => {
    const dto = Object.assign(new CorrectRollProductionCostDto(), {
      operationKey: 'bad',
      expectedVersion: 0,
      reason: '',
    });
    expect((await validate(dto)).map(({ property }) => property)).toEqual(
      expect.arrayContaining(['operationKey', 'expectedVersion', 'reason']),
    );
  });

  it('allows Finance and rejects every other default role', () => {
    const guard = new CapabilityGuard(new Reflector());
    expect(guard.canActivate(contextFor('finance'))).toBe(true);
    for (const role of ROLES.filter((candidate) => candidate !== 'finance')) {
      expect(() => guard.canActivate(contextFor(role))).toThrow();
    }
  });

  it('registers the correction controller through the shared snapshot module', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, FinanceModule)).toContain(
      ProductionCostCorrectionController,
    );
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, FinanceModule)).toContain(DirectorModule);
  });
});
