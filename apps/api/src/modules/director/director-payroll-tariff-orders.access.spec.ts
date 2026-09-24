import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { DECORATORS, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import {
  capabilitiesForRole,
  type Capability,
  type Role,
} from '@plenka/contracts';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import { PayrollTariffOrderService } from '../../common/payroll-tariffs/payroll-tariff-order.service';
import { PayrollTariffModule } from '../../common/payroll-tariffs/payroll-tariff.module';
import { ADMIN_CAPABILITY_METADATA } from '../admin/admin-capability-catalog';
import { DirectorModule } from './director.module';
import { DirectorPayrollTariffOrdersController } from './director-payroll-tariff-orders.controller';
import {
  PayrollTariffOrderErrorResponseDto,
  PayrollTariffOrderListResponseDto,
  PayrollTariffOrderResultResponseDto,
  PayrollTariffOrderReviewResponseDto,
  PayrollTariffOrderViewResponseDto,
} from './dto/payroll-tariff-order.dto';

type HandlerName = 'list' | 'detail' | 'create' | 'update' | 'review' | 'publish';

const routeCases = [
  ['list', '/', RequestMethod.GET, 'director:read'],
  ['detail', ':id', RequestMethod.GET, 'director:read'],
  ['create', '/', RequestMethod.POST, 'payroll_tariff:manage'],
  ['update', ':id', RequestMethod.PATCH, 'payroll_tariff:manage'],
  ['review', ':id/review', RequestMethod.POST, 'payroll_tariff:manage'],
  ['publish', ':id/publish', RequestMethod.POST, 'payroll_tariff:manage'],
] as const satisfies ReadonlyArray<readonly [HandlerName, string, RequestMethod, Capability]>;

function contextFor(handlerName: HandlerName, role: Role, capabilities: readonly Capability[]) {
  return {
    getHandler: () => DirectorPayrollTariffOrdersController.prototype[handlerName],
    getClass: () => DirectorPayrollTariffOrdersController,
    switchToHttp: () => ({
      getRequest: () => ({ actor: { userId: `${role}-1`, role, capabilities } }),
    }),
  } as never;
}

describe('director payroll tariff order access', () => {
  const guard = new CapabilityGuard(new Reflector());

  it.each(routeCases)('registers %s with the exact path, method and capability', (
    handlerName,
    path,
    method,
    capability,
  ) => {
    const handler = DirectorPayrollTariffOrdersController.prototype[handlerName];
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([
      capability,
    ]);
  });

  it('enforces base capabilities for all seven roles and honors an explicit grant', () => {
    for (const role of [
      'commercial',
      'production_lead',
      'operator',
      'warehouse',
      'finance',
      'director',
      'admin',
    ] as const) {
      const base = capabilitiesForRole(role);
      const canRead = base.includes('director:read');
      const canManage = base.includes('payroll_tariff:manage');
      const read = () => guard.canActivate(contextFor('list', role, base));
      const manage = () => guard.canActivate(contextFor('create', role, base));
      if (canRead) expect(read()).toBe(true);
      else expect(read).toThrow();
      if (canManage) expect(manage()).toBe(true);
      else expect(manage).toThrow();
    }

    expect(
      guard.canActivate(
        contextFor('create', 'finance', [
          ...capabilitiesForRole('finance'),
          'payroll_tariff:manage',
        ]),
      ),
    ).toBe(true);
  });

  it('has no delete handler and wires the cross-cutting module into director', () => {
    const methods = Object.getOwnPropertyNames(DirectorPayrollTariffOrdersController.prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => ({
        name,
        method: Reflect.getMetadata(
          METHOD_METADATA,
          DirectorPayrollTariffOrdersController.prototype[name as HandlerName],
        ),
      }));
    expect(methods).toHaveLength(routeCases.length);
    expect(methods.some(({ method }) => method === RequestMethod.DELETE)).toBe(false);

    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      DirectorModule,
    ) as unknown[];
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, DirectorModule) as unknown[];
    expect(controllers).toContain(DirectorPayrollTariffOrdersController);
    expect(imports).toContain(PayrollTariffModule);
  });

  it('publishes clear Russian metadata without granting admin a base capability', () => {
    expect(ADMIN_CAPABILITY_METADATA['payroll_tariff:manage']).toEqual({
      label: 'Управление приказами по тарифам',
      description: 'Создавать, проверять и публиковать версии приказов по сдельным тарифам.',
      group: 'Директор',
    });
    expect(capabilitiesForRole('director')).toContain('payroll_tariff:manage');
    expect(capabilitiesForRole('admin')).not.toContain('payroll_tariff:manage');
  });

  it('documents safe success/conflict/validation responses and nested matrix schemas', async () => {
    for (const [handlerName] of routeCases) {
      const handler = DirectorPayrollTariffOrdersController.prototype[handlerName];
      expect(Reflect.getMetadata(DECORATORS.API_SECURITY, handler)).toEqual([{ session: [] }]);
      const responses = Reflect.getMetadata(DECORATORS.API_RESPONSE, handler) as Record<
        string,
        { type?: unknown }
      >;
      expect(Object.keys(responses)).toEqual(expect.arrayContaining(['401', '403']));
      if (!['list', 'detail'].includes(handlerName)) {
        expect(responses['409']?.type).toBe(PayrollTariffOrderErrorResponseDto);
        expect(responses['422']?.type).toBe(PayrollTariffOrderErrorResponseDto);
      }
    }

    const module = await Test.createTestingModule({
      controllers: [DirectorPayrollTariffOrdersController],
      providers: [{ provide: PayrollTariffOrderService, useValue: {} }],
    }).compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
      const path = document.paths['/director/payroll-tariff-orders'];
      expect(path?.get?.responses['200']).toBeDefined();
      expect(path?.post?.responses['201']).toBeDefined();
      const schemas = document.components?.schemas ?? {};
      for (const dto of [
        PayrollTariffOrderListResponseDto,
        PayrollTariffOrderViewResponseDto,
        PayrollTariffOrderResultResponseDto,
        PayrollTariffOrderReviewResponseDto,
        PayrollTariffOrderErrorResponseDto,
      ]) {
        expect(schemas[dto.name]).toBeDefined();
      }
      expect(JSON.stringify(schemas)).not.toMatch(/rawPayload|oneC|device/iu);
    } finally {
      await app.close();
    }
  });
});
