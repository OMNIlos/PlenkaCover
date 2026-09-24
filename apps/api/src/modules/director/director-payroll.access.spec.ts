import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { DECORATORS, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import {
  capabilitiesForRole,
  type Capability,
  type DirectorPayrollPreview,
  type Role,
} from '@plenka/contracts';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import { DirectorPayrollPreviewResponseDto } from './dto/payroll-response.dto';
import { DirectorPayrollController } from './director-payroll.controller';
import { DirectorPayrollFactsService } from './director-payroll-facts.service';
import { DirectorPayrollService } from './director-payroll.service';
import { DirectorModule } from './director.module';

function contextFor(role: Role) {
  return {
    getHandler: () => DirectorPayrollController.prototype.preview,
    getClass: () => DirectorPayrollController,
    switchToHttp: () => ({
      getRequest: () => ({
        actor: { userId: null, role, capabilities: capabilitiesForRole(role) },
      }),
    }),
  } as never;
}

describe('director payroll preview access', () => {
  const handler = DirectorPayrollController.prototype.preview;
  const guard = new CapabilityGuard(new Reflector());

  it('registers the director payroll-preview GET route with director:read', () => {
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('payroll-preview');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([
      'director:read',
    ]);
  });

  it('allows only the director role through CapabilityGuard', () => {
    expect(guard.canActivate(contextFor('director'))).toBe(true);

    for (const role of [
      'commercial',
      'finance',
      'production_lead',
      'operator',
      'warehouse',
      'admin',
    ] as const) {
      expect(() => guard.canActivate(contextFor(role))).toThrow();
    }
  });

  it('documents session auth and all client/auth response outcomes', () => {
    expect(Reflect.getMetadata(DECORATORS.API_SECURITY, handler)).toEqual([{ session: [] }]);

    const responses = Reflect.getMetadata(DECORATORS.API_RESPONSE, handler) as Record<
      string,
      { type?: unknown }
    >;
    expect(Object.keys(responses)).toEqual(expect.arrayContaining(['200', '400', '401', '403']));
    expect(responses['200'].type).toBe(DirectorPayrollPreviewResponseDto);
  });

  it('generates integer OpenAPI schemas for nested payroll kopeck fields', async () => {
    const module = await Test.createTestingModule({
      controllers: [DirectorPayrollController],
      providers: [{ provide: DirectorPayrollService, useValue: { getPreview: jest.fn() } }],
    }).compile();
    const app = module.createNestApplication();
    await app.init();

    try {
      const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
      const schemas = document.components?.schemas ?? {};
      const schema = (name: string) =>
        schemas[name] as { properties: Record<string, unknown> } | undefined;
      const integer32 = { type: 'integer', format: 'int32' };
      const integer64 = { type: 'integer', format: 'int64' };

      expect(schema('DirectorPayrollPreviewResponseDto')?.properties).not.toHaveProperty('policy');
      expect(schema('DirectorPayrollPreviewResponseDto')?.properties.appliedTariffOrders).toEqual({
        type: 'array',
        items: { $ref: '#/components/schemas/AppliedPayrollTariffOrderResponseDto' },
      });
      expect(schema('DirectorPayrollBreakdownResponseDto')?.properties.tariffOrderId).toEqual({
        type: 'string',
      });
      expect(schema('DirectorPayrollBreakdownResponseDto')?.properties.rateKopecksPerKg).toEqual(
        integer32,
      );

      expect(schema('DirectorPayrollSummaryResponseDto')?.properties.payableAmountKopecks).toEqual(
        integer64,
      );
      expect(schema('DirectorPayrollOperatorSummaryResponseDto')?.properties.amountKopecks).toEqual(
        integer64,
      );
      expect(schema('DirectorPayrollBreakdownResponseDto')?.properties.amountKopecks).toEqual(
        integer64,
      );
      expect(schema('DirectorPayrollSummaryResponseDto')?.properties.machineShiftCount).toEqual(
        integer32,
      );
    } finally {
      await app.close();
    }
  });

  it('passes the query to payroll service once and returns its result unchanged', async () => {
    const preview = { status: 'empty' } as DirectorPayrollPreview;
    const payroll = {
      getPreview: jest.fn().mockResolvedValue(preview),
    } as unknown as DirectorPayrollService;
    const controller = new DirectorPayrollController(payroll);
    const query = { from: '2026-07-01', to: '2026-07-31' };

    await expect(controller.preview(query)).resolves.toBe(preview);
    expect(payroll.getPreview).toHaveBeenCalledTimes(1);
    expect(payroll.getPreview).toHaveBeenCalledWith(query);
  });

  it('registers payroll boundary and services without dropping existing module wiring', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      DirectorModule,
    ) as unknown[];
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, DirectorModule) as unknown[];

    expect(controllers).toContain(DirectorPayrollController);
    expect(providers).toEqual(
      expect.arrayContaining([DirectorPayrollFactsService, DirectorPayrollService]),
    );
  });
});
