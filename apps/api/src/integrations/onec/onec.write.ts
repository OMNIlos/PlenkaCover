import type { OneCStockItem } from './onec.adapter';

/** GUID refs a goods-posting document needs (org / warehouse / goods account / nomenclature). */
export interface GoodsPostingRefs {
  orgKey: string;
  warehouseKey: string;
  accountKey: string;
  nomenclatureKey: string;
}

/**
 * Build the OData create body for the controlled demo `Document_ОприходованиеТоваров` posting.
 * The demo base has no `ТоварыНаСкладах` register; this path posts one line per platform stock row
 * to a deliberately shared technical nomenclature on the configured account. It proves real OData
 * create + `/Post`, not per-material balance synchronization. The tabular part is sent inline
 * (unlike `$expand` on read). Historically verified against the demo base: create → 201,
 * `/Post` → 200, Posted=true.
 */
export function buildGoodsPostingBody(
  items: OneCStockItem[],
  refs: GoodsPostingRefs,
  date: string,
): Record<string, unknown> {
  return {
    Date: date,
    Организация_Key: refs.orgKey,
    Склад_Key: refs.warehouseKey,
    Товары: items.map((it, i) => ({
      LineNumber: String(i + 1),
      Номенклатура_Key: refs.nomenclatureKey,
      Количество: it.qty,
      Цена: 1,
      Сумма: it.qty,
      СчетУчета_Key: refs.accountKey,
    })),
  };
}

/** 1С OData datetime literal — `YYYY-MM-DDThh:mm:ss`, no timezone suffix. */
export function onecDateTime(d: Date): string {
  return d.toISOString().slice(0, 19);
}
