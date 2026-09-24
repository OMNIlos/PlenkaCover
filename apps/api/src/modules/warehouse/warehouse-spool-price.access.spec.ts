import { HttpStatus, RequestMethod } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { capabilitiesForRole, ROLES, type Capability, type Role } from '@plenka/contracts';
import { validate } from 'class-validator';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import {
  RecordSpoolPriceReferenceDto,
  RecordSpoolStockReceiptDto,
} from './dto/warehouse-spool-price.dto';
import { WarehouseSpoolPriceController } from './warehouse-spool-price.controller';
import { WarehouseModule } from './warehouse.module';
import { WarehouseSpoolPriceService } from './warehouse-spool-price.service';

function contextFor(handler: (...args: never[]) => unknown, role: Role) {
  return {
    getHandler: () => handler,
    getClass: () => WarehouseSpoolPriceController,
    switchToHttp: () => ({
      getRequest: () => ({
        actor: { userId: `${role}-user`, role, capabilities: capabilitiesForRole(role) },
      }),
    }),
  } as never;
}

describe('WarehouseSpoolPriceController contract', () => {
  const reflector = new Reflector();
  const proto = WarehouseSpoolPriceController.prototype;

  it.each([
    [proto.listTypes, 'spool-price-types', RequestMethod.GET],
    [proto.record, 'spool-price-references', RequestMethod.POST],
  ] as const)(
    'gates the bounded %s route with only spool_price:manage',
    (handler, path, method) => {
      expect(Reflect.getMetadata(PATH_METADATA, WarehouseSpoolPriceController)).toBe('warehouse');
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
      expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([
        'spool_price:manage',
      ]);
    },
  );

  it('returns both create and exact replay as HTTP 200', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.record)).toBe(HttpStatus.OK);
  });

  it('exposes separate guarded receipt read and write routes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, proto.listStock)).toBe('spool-stock');
    expect(Reflect.getMetadata(METHOD_METADATA, proto.listStock)).toBe(RequestMethod.GET);
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.listStock)).toEqual([
      'spool_stock:read',
    ]);
    expect(Reflect.getMetadata(PATH_METADATA, proto.recordReceipt)).toBe('spool-stock-receipts');
    expect(Reflect.getMetadata(METHOD_METADATA, proto.recordReceipt)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.recordReceipt)).toBe(HttpStatus.OK);
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.recordReceipt)).toEqual([
      'spool_stock:receive',
    ]);
  });

  it('allows Warehouse and rejects every other default role on both routes', () => {
    const guard = new CapabilityGuard(reflector);
    for (const handler of [proto.listTypes, proto.record]) {
      expect(guard.canActivate(contextFor(handler, 'warehouse'))).toBe(true);
      for (const role of ROLES.filter((candidate) => candidate !== 'warehouse')) {
        expect(() => guard.canActivate(contextFor(handler, role))).toThrow();
      }
    }
  });

  it('allows warehouse receipt writes and warehouse or production-lead receipt reads only', () => {
    const guard = new CapabilityGuard(reflector);
    expect(guard.canActivate(contextFor(proto.listStock, 'warehouse'))).toBe(true);
    expect(guard.canActivate(contextFor(proto.listStock, 'production_lead'))).toBe(true);
    expect(guard.canActivate(contextFor(proto.recordReceipt, 'warehouse'))).toBe(true);
    expect(() => guard.canActivate(contextFor(proto.recordReceipt, 'production_lead'))).toThrow();

    for (const role of ROLES.filter(
      (candidate) => candidate !== 'warehouse' && candidate !== 'production_lead',
    )) {
      expect(() => guard.canActivate(contextFor(proto.listStock, role))).toThrow();
      expect(() => guard.canActivate(contextFor(proto.recordReceipt, role))).toThrow();
    }
  });

  it('rejects unsafe money, non-UUID keys, and unknown public fields at DTO boundary', async () => {
    const dto = Object.assign(new RecordSpoolPriceReferenceDto(), {
      operationKey: 'not-a-uuid',
      spoolTypeLabel: 'Шпуля 76 мм',
      priceKopecksPerMeter: Number.MAX_SAFE_INTEGER + 1,
      source: 'Прайс',
      effectiveFrom: 'not-a-date',
      reason: 'Причина',
    });
    expect((await validate(dto)).map(({ property }) => property)).toEqual(
      expect.arrayContaining(['operationKey', 'priceKopecksPerMeter', 'effectiveFrom']),
    );
  });

  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe receipt quantity %s at the DTO boundary',
    async (quantityMillimeters) => {
      const dto = Object.assign(new RecordSpoolStockReceiptDto(), {
        operationKey: '11111111-1111-4111-8111-111111111111',
        spoolTypeLabel: 'Шпуля 76 мм',
        priceKopecksPerMeter: 6_000,
        quantityMillimeters,
        source: 'Прайс',
        effectiveFrom: '2026-08-01T00:00:00.000Z',
        reason: 'Причина',
      });

      expect((await validate(dto)).map(({ property }) => property)).toContain(
        'quantityMillimeters',
      );
    },
  );

  it('registers the isolated non-physical controller and command service', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, WarehouseModule)).toContain(
      WarehouseSpoolPriceController,
    );
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, WarehouseModule)).toContain(
      WarehouseSpoolPriceService,
    );
  });
});
