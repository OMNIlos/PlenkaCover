import { ConflictException } from '@nestjs/common';
import {
  assertOperatorRollReweighTransition,
  assertOperatorRollStepBack,
  assertOperatorRollTransition,
  assertOperatorRollMutable,
  operatorRollTransition,
  type OperatorRollAction,
} from './operator-roll-state';

describe('operator roll physical state', () => {
  it('stops new production after cancellation but permits packing an already made roll', () => {
    const line = {
      warehouseState: 'not_ready',
      rollDispatchItem: {
        status: 'assigned',
        productionOrder: { commercialOrder: { cancellationStatus: 'cancelled' } },
      },
    };
    expect(() => assertOperatorRollMutable('spool_weight', line)).toThrow(ConflictException);
    expect(() => assertOperatorRollMutable('roll_weight', line)).toThrow(ConflictException);
    expect(() => assertOperatorRollMutable('handover', line)).not.toThrow();
  });
  it.each([
    ['accept', 'assigned', 'spool_weight'],
    ['spool_weight', 'spool_weight', 'roll_weight'],
    ['roll_weight', 'roll_weight', 'qr_print'],
    ['qr_print', 'qr_print', 'qr_check'],
    ['qr_verify', 'qr_check', 'handover'],
    ['handover', 'handover', 'warehouse'],
  ] as const)('%s advances only from %s to %s', (action, predecessor, result) => {
    expect(operatorRollTransition(action)).toEqual({ predecessor, result });
    expect(assertOperatorRollTransition(action, predecessor)).toBe(result);
  });

  it.each([
    ['accept', 'spool_weight'],
    ['spool_weight', 'assigned'],
    ['roll_weight', 'assigned'],
    ['qr_print', 'roll_weight'],
    ['qr_verify', 'assigned'],
    ['qr_verify', 'qr_print'],
    ['handover', 'assigned'],
    ['handover', 'qr_check'],
  ] as Array<[OperatorRollAction, string]>)('%s rejects illegal predecessor %s', (action, step) => {
    expect(() => assertOperatorRollTransition(action, step)).toThrow(ConflictException);
    try {
      assertOperatorRollTransition(action, step);
    } catch (error) {
      expect((error as ConflictException).getResponse()).toEqual(
        expect.objectContaining({ code: 'OPERATOR_STEP_CONFLICT' }),
      );
    }
  });

  it('does not admit compatibility-only roll_scale_activation into the pilot sequence', () => {
    expect(() => assertOperatorRollTransition('roll_weight', 'roll_scale_activation')).toThrow(
      ConflictException,
    );
  });

  it.each(['qr_print', 'handover'] as const)(
    'keeps reweigh at its explicitly supported %s step',
    (currentStep) => {
      expect(assertOperatorRollReweighTransition(currentStep)).toBe(currentStep);
    },
  );

  it.each(['assigned', 'spool_weight', 'roll_weight', 'qr_check', 'warehouse'])(
    'rejects reweigh from unsupported step %s',
    (currentStep) => {
      expect(() => assertOperatorRollReweighTransition(currentStep)).toThrow(ConflictException);
      try {
        assertOperatorRollReweighTransition(currentStep);
      } catch (error) {
        expect((error as ConflictException).getResponse()).toEqual(
          expect.objectContaining({ code: 'OPERATOR_STEP_CONFLICT' }),
        );
      }
    },
  );

  it.each([
    ['qr_print', 'roll_weight'],
    ['roll_weight', 'spool_weight'],
  ] as const)('steps back from %s to %s', (currentStep, expectedStep) => {
    expect(assertOperatorRollStepBack(currentStep)).toBe(expectedStep);
  });

  it.each(['assigned', 'spool_weight', 'qr_check', 'handover', 'warehouse'])(
    'rejects step back from unsupported step %s',
    (currentStep) => {
      expect(() => assertOperatorRollStepBack(currentStep)).toThrow(ConflictException);
      try {
        assertOperatorRollStepBack(currentStep);
      } catch (error) {
        expect((error as ConflictException).getResponse()).toEqual(
          expect.objectContaining({ code: 'OPERATOR_STEP_CONFLICT' }),
        );
      }
    },
  );
});
