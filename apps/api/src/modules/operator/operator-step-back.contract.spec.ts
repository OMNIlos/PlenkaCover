import {
  DOMAIN_EVENTS,
  type OperatorRollStepBackResult,
} from '@plenka/contracts';

describe('operator roll step back contract', () => {
  it('registers the append-only step reopen audit event', () => {
    expect(DOMAIN_EVENTS).toContain('audit:operator_roll_step_reopened');
  });

  it('exposes only the safe step transition projection', () => {
    const result: OperatorRollStepBackResult = {
      rollCode: 'ROLL-001',
      previousStep: 'qr_print',
      step: 'roll_weight',
    };

    expect(result).toEqual({
      rollCode: 'ROLL-001',
      previousStep: 'qr_print',
      step: 'roll_weight',
    });
  });
});
