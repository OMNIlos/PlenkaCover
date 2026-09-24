import { AdminOneCController } from '../../modules/admin/admin-onec.controller';
import { FinanceController } from '../../modules/finance/finance.controller';
import { OneCNomenclatureController } from '../../modules/material-catalog/onec-nomenclature.controller';
import { WarehouseController } from '../../modules/warehouse/warehouse.controller';

const REQUIRE_ONEC_RUNTIME = 'require_onec_runtime';

describe('1C runtime route boundary', () => {
  it('marks the dedicated 1C controllers as runtime-gated', () => {
    expect(Reflect.getMetadata(REQUIRE_ONEC_RUNTIME, AdminOneCController)).toBe(true);
    expect(Reflect.getMetadata(REQUIRE_ONEC_RUNTIME, OneCNomenclatureController)).toBe(true);
  });

  it('marks every mixed-controller action that can contact 1C', () => {
    for (const route of [
      FinanceController.prototype.invoiceLink,
      FinanceController.prototype.sourceRetry,
      FinanceController.prototype.paymentSourceSync,
      WarehouseController.prototype.pushToOneC,
      WarehouseController.prototype.previewOneCPush,
    ]) {
      expect(Reflect.getMetadata(REQUIRE_ONEC_RUNTIME, route)).toBe(true);
    }
  });
});
