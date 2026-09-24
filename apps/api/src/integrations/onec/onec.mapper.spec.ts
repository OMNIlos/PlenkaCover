import {
  mapBalanceRecord,
  mapCounterpartyRecord,
  mapInvoiceRecord,
  mapList,
  mapPaymentRecord,
  mapShipmentRecord,
} from './onec.mapper';
import counterparties from './__fixtures__/counterparties.json';
import invoice from './__fixtures__/invoice.json';
import shipment from './__fixtures__/shipment.json';
import balance from './__fixtures__/balance.json';
import payments from './__fixtures__/payments.json';

const AT = '2026-07-02T00:00:00.000Z';

describe('onec.mapper (real demo OData JSON → OneCSnapshot)', () => {
  it('counterparty: Ref_Key→externalId, DataVersion→sourceVersion, Description→displayName', () => {
    const rec = (counterparties as any).value[0];
    const snap = mapCounterpartyRecord(rec, AT);
    expect(snap.subjectType).toBe('counterparty');
    expect(snap.sourceKind).toBe('1C');
    expect(snap.externalId).toBe(rec.Ref_Key);
    expect(snap.sourceVersion).toBe(rec.DataVersion);
    expect(snap.parsed.displayName).toBe(rec.Description);
    expect(snap.parsed.inn).toBe(rec['ИНН'] ?? null);
    expect(snap.rawPayload).toEqual(rec);
  });

  it('invoice: Number→invoiceNo, СуммаДокумента→total, Posted→posted', () => {
    const rec = (invoice as any).value[0];
    const snap = mapInvoiceRecord(rec, AT);
    expect(snap.externalId).toBe(rec.Ref_Key);
    expect(snap.parsed.invoiceNo).toBe(rec.Number);
    expect(snap.parsed.total).toBe(rec['СуммаДокумента']);
    expect(snap.parsed.posted).toBe(rec.Posted);
    expect(snap.parsed.counterpartyExternalId).toBe(rec['Контрагент_Key']);
  });

  it('shipment: maps Document_РеализацияТоваровУслуг record', () => {
    const rec = (shipment as any).value[0];
    const snap = mapShipmentRecord(rec, AT);
    expect(snap.subjectType).toBe('shipment');
    expect(snap.externalId).toBe(rec.Ref_Key);
    expect(snap.parsed.total).toBe(rec['СуммаДокумента']);
  });

  it('balance: КоличествоBalance→qty, СуммаBalance→amount (no Ref_Key ⇒ null externalId)', () => {
    const rec = (balance as any).value[0];
    const snap = mapBalanceRecord(rec, AT);
    expect(snap.subjectType).toBe('stock');
    expect(snap.externalId).toBeNull();
    expect(snap.parsed.qty).toBe(Number(rec['КоличествоBalance']));
    expect(snap.parsed.amount).toBe(Number(rec['СуммаBalance']));
  });

  it('payment: Number→number, СуммаДокумента→amount, composite Контрагент→counterpartyExternalId', () => {
    const rec = (payments as any).value[0];
    const snap = mapPaymentRecord(rec, AT);
    expect(snap.subjectType).toBe('payment');
    expect(snap.externalId).toBe(rec.Ref_Key);
    expect(snap.sourceVersion).toBe(rec.DataVersion);
    expect(snap.parsed.number).toBe(rec.Number);
    expect(snap.parsed.amount).toBe(rec['СуммаДокумента']);
    expect(snap.parsed.posted).toBe(rec.Posted);
    // ПоступлениеНаРасчетныйСчет has a COMPOSITE `Контрагент` (value), not `Контрагент_Key`.
    expect(snap.parsed.counterpartyExternalId).toBe(rec['Контрагент']);
  });

  it('mapList on an empty value array returns []', () => {
    expect(mapList([], mapPaymentRecord, AT)).toEqual([]);
    expect(mapList(undefined as any, mapPaymentRecord, AT)).toEqual([]);
  });
});
