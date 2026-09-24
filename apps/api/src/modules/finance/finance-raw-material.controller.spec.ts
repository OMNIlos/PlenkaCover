import { Reflector } from '@nestjs/core';
import type { Capability } from '@plenka/contracts';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import { FinanceRawMaterialController } from './finance-raw-material.controller';

describe('FinanceRawMaterialController', () => {
  it('keeps BigBag financial facts behind finance read capability', () => {
    expect(
      new Reflector().get<Capability[]>(
        REQUIRE_CAPABILITIES,
        FinanceRawMaterialController.prototype.list,
      ),
    ).toEqual(['finance_order:read']);
  });
});
