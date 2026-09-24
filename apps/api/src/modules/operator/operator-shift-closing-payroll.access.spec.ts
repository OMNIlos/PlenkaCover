import { HttpStatus, RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { DECORATORS, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { capabilitiesForRole, type Capability, type Role } from '@plenka/contracts';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import { RoleInboxProjectionService } from '../../common/role-inbox/role-inbox.service';
import { ProductionShiftCommandService } from '../production/production-shift-command.service';
import { OperatorShiftCloseResponseDto } from './dto/operator-shift-close-response.dto';
import { OperatorController } from './operator.controller';
import { OperatorDefectBagService } from './operator-defect-bag.service';
import { OperatorPhysicalService } from './operator-physical.service';
import { OperatorService } from './operator.service';
import { OperatorSessionService } from './operator-session.service';
import { OperatorShiftService } from './operator-shift.service';
import { OperatorStepBackService } from './operator-step-back.service';

function contextFor(role: Role) {
  return {
    getHandler: () => OperatorController.prototype.closeShift,
    getClass: () => OperatorController,
    switchToHttp: () => ({
      getRequest: () => ({
        actor: { userId: `${role}-user`, role, capabilities: capabilitiesForRole(role) },
      }),
    }),
  } as never;
}

describe('operator shift closing payroll access', () => {
  const handler = OperatorController.prototype.closeShift;
  const guard = new CapabilityGuard(new Reflector());

  it('keeps shift close operator-only behind the existing post-session capability', () => {
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('shift/close');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(HttpStatus.OK);
    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([
      'post_session:manage',
    ]);
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

  it('documents session auth and validation/auth/conflict outcomes', () => {
    expect(Reflect.getMetadata(DECORATORS.API_SECURITY, handler)).toEqual([{ session: [] }]);
    const responses = Reflect.getMetadata(DECORATORS.API_RESPONSE, handler) as Record<
      string,
      { type?: unknown }
    >;
    expect(Object.keys(responses)).toEqual(
      expect.arrayContaining(['200', '400', '401', '403', '409']),
    );
    expect(responses['200'].type).toBe(OperatorShiftCloseResponseDto);
  });

  it('generates the required UUID request and exact nested closing-payroll response', async () => {
    const providers = [
      OperatorService,
      OperatorSessionService,
      OperatorShiftService,
      RoleInboxProjectionService,
      OperatorPhysicalService,
      ProductionShiftCommandService,
      OperatorStepBackService,
      OperatorDefectBagService,
    ].map((provide) => ({ provide, useValue: {} }));
    const module = await Test.createTestingModule({
      controllers: [OperatorController],
      providers,
    }).compile();
    const app = module.createNestApplication();
    await app.init();

    try {
      const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
      const operation = document.paths['/operator/shift/close']?.post;
      const requestSchema =
        operation?.requestBody && 'content' in operation.requestBody
          ? operation.requestBody.content['application/json']?.schema
          : undefined;
      expect(requestSchema).toEqual({ $ref: '#/components/schemas/CloseShiftDto' });
      const schemas = document.components?.schemas ?? {};
      const schema = (name: string) =>
        schemas[name] as { required?: string[]; properties?: Record<string, unknown> } | undefined;

      expect(schema('CloseShiftDto')?.required).toEqual(
        expect.arrayContaining(['operationKey', 'bags']),
      );
      expect(schema('CloseShiftDto')?.properties?.operationKey).toEqual({
        type: 'string',
        format: 'uuid',
        description: 'Стабильный ключ повторной отправки закрытия',
      });
      expect(schema('OperatorShiftCloseResponseDto')?.properties?.closingPayroll).toEqual({
        $ref: '#/components/schemas/OperatorShiftClosingPayrollResponseDto',
      });
      expect(schema('OperatorShiftCloseResponseDto')?.required).toEqual([
        'balance',
        'problemId',
        'releasedRollIds',
        'closingPayroll',
      ]);
      expect(schema('OperatorShiftBalanceResponseDto')?.required).toEqual([
        'producedKg',
        'defectKg',
        'expectedUsageKg',
        'actualUsageKg',
        'deviationPercent',
        'status',
      ]);
      const closing = schema('OperatorShiftClosingPayrollResponseDto')?.properties ?? {};
      expect(closing.appliedTariffOrders).toEqual({
        type: 'array',
        items: { $ref: '#/components/schemas/PayrollTariffOrderReferenceResponseDto' },
      });
      expect(closing.summary).toEqual({
        $ref: '#/components/schemas/OperatorPayrollSummaryResponseDto',
      });
      expect(closing.breakdown).toEqual({
        type: 'array',
        items: { $ref: '#/components/schemas/OperatorPayrollBreakdownResponseDto' },
      });
      expect(closing).not.toHaveProperty('rateKopecksPerKg');
      expect(closing).not.toHaveProperty('basisLabel');
      expect(schema('OperatorPayrollSummaryResponseDto')?.properties).not.toHaveProperty(
        'operatorCount',
      );
      expect(schema('OperatorPayrollBreakdownResponseDto')?.properties).toEqual(
        expect.objectContaining({
          rateKopecksPerKg: { type: 'integer', format: 'int32' },
          amountKopecks: { type: 'integer', format: 'int64' },
          basisLabel: { type: 'string' },
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('forwards only the authenticated actor and validated close command', async () => {
    const result = { closingPayroll: { status: 'empty' } };
    const shift = { close: jest.fn().mockResolvedValue(result) };
    const controller = new (OperatorController as any)(
      {},
      {},
      shift,
      {},
      {},
      {},
      {},
    ) as OperatorController;
    const actor = {
      userId: 'operator-a',
      role: 'operator' as const,
      capabilities: ['post_session:manage' as const],
    };
    const dto = {
      operationKey: '11111111-1111-4111-8111-111111111111',
      bags: [{ bigBagId: 'bag-1', endKg: 10 }],
    };

    await expect(controller.closeShift(actor, dto)).resolves.toBe(result);
    expect(shift.close).toHaveBeenCalledWith({ userId: 'operator-a', role: 'operator' }, dto);
  });
});
