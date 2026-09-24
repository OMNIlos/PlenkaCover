import { describe, expect, it } from 'vitest';
import { financeInvoiceActionNeedsAmountInput } from './financeInvoiceAmount';

describe('financeInvoiceActionNeedsAmountInput', () => {
  it('does not ask for amount when the selected finance order already has a positive price', () => {
    expect(financeInvoiceActionNeedsAmountInput('1 284 000 ₽')).toBe(false);
    expect(financeInvoiceActionNeedsAmountInput('1284000 ₽')).toBe(false);
  });

  it('uses fallback finance facts when the selected command has no amount', () => {
    expect(financeInvoiceActionNeedsAmountInput('сумма не введена', '150 000 ₽')).toBe(false);
  });

  it('asks for amount when the selected finance order has no usable price', () => {
    expect(financeInvoiceActionNeedsAmountInput('сумма не введена')).toBe(true);
    expect(financeInvoiceActionNeedsAmountInput('0 ₽')).toBe(true);
    expect(financeInvoiceActionNeedsAmountInput(undefined)).toBe(true);
  });
});
