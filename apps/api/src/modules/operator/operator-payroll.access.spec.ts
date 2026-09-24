import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { capabilitiesForRole, type Capability, type Role } from '@plenka/contracts';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import { OperatorPayrollController } from './operator-payroll.controller';
import { OperatorPayrollService } from './operator-payroll.service';

function contextFor(role: Role) {
  return {
    getHandler: () => OperatorPayrollController.prototype.self,
    getClass: () => OperatorPayrollController,
    switchToHttp: () => ({
      getRequest: () => ({
        actor: { userId: `${role}-user`, role, capabilities: capabilitiesForRole(role) },
      }),
    }),
  } as never;
}

describe('operator self-payroll access', () => {
  const handler = OperatorPayrollController.prototype.self;
  const guard = new CapabilityGuard(new Reflector());

  it('registers GET /operator/payroll with the granular self capability', () => {
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('payroll');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([
      'operator_payroll:read_self',
    ]);
  });

  it('allows an operator and rejects every other role', () => {
    expect(guard.canActivate(contextFor('operator'))).toBe(true);
    for (const role of [
      'commercial',
      'production_lead',
      'warehouse',
      'finance',
      'director',
      'admin',
    ] as const) {
      expect(() => guard.canActivate(contextFor(role))).toThrow();
    }
  });

  it('passes the authenticated actor and range without accepting an operator id', async () => {
    const result = { status: 'empty' };
    const payroll = { getSelf: jest.fn().mockResolvedValue(result) };
    const controller = new OperatorPayrollController(payroll as unknown as OperatorPayrollService);
    const actor = {
      userId: 'operator-a',
      role: 'operator' as const,
      capabilities: ['operator_payroll:read_self' as const],
    };
    const query = { from: '2026-07-01', to: '2026-07-31' };

    await expect(controller.self(actor, query)).resolves.toBe(result);
    expect(payroll.getSelf).toHaveBeenCalledWith(actor, query);
  });
});
