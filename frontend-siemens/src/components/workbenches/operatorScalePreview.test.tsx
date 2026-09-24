import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  OperatorScalePreview,
  calculateOperatorScaleReading,
  canSubmitOperatorDefect,
  formatOperatorScaleKg,
  operatorDefectRecoveryMessage,
} from './operatorScalePreview';

describe('operator scale preview', () => {
  it('keeps raw scale precision before calculating net weight', () => {
    const reading = calculateOperatorScaleReading({
      grossKg: 0.05,
      spoolKg: 0.05,
      plannedNetKg: 42.3,
      stable: true,
    });

    expect(formatOperatorScaleKg(reading.gross)).toBe('0,05');
    expect(formatOperatorScaleKg(reading.net)).toBe('0,0');
    expect(formatOperatorScaleKg(reading.gross)).not.toBe('0,1');
  });

  it('renders the same full measurement structure in critical defect mode', () => {
    const markup = renderToStaticMarkup(
      <OperatorScalePreview
        rollCode="A-9-roll-1"
        grossKg={0.05}
        spoolKg={0.05}
        plannedNetKg={42.3}
        stable
        tone="critical"
      />,
    );

    expect(markup).toContain('operator-live-scale is-stable is-critical');
    expect(markup).toContain('Брутто');
    expect(markup).toContain('0,05 кг');
    expect(markup).toContain('нетто 0,0 кг');
    expect(markup).toContain('план 42,3 кг');
    expect(markup).toContain('Отклонение');
    expect(markup).toContain('Масса брака 0 кг');
    expect(markup).toContain('положите бракованный рулон');
    expect(markup).not.toContain('можно фиксировать');
  });

  it('can hide the duplicated roll code in the normal weighing card', () => {
    const markup = renderToStaticMarkup(
      <OperatorScalePreview
        rollCode="A-9-roll-1"
        showRollCode={false}
        grossKg={43}
        spoolKg={1.8}
        plannedNetKg={41.2}
        stable
      />,
    );

    expect(markup).not.toContain('<em>A-9-roll-1</em>');
  });

  it('blocks defect submission until a stable gross weight exceeds the spool', () => {
    expect(canSubmitOperatorDefect({ status: 'ready', stable: true, grossKg: 0.05 }, 0.05)).toBe(
      false,
    );
    expect(canSubmitOperatorDefect({ status: 'ready', stable: false, grossKg: 0.06 }, 0.05)).toBe(
      false,
    );
    expect(canSubmitOperatorDefect({ status: 'ready', stable: true, grossKg: 0.06 }, 0.05)).toBe(
      true,
    );
  });

  it('explains the current recovery instead of always telling the operator to add weight', () => {
    expect(operatorDefectRecoveryMessage(null, 0.05)).toBe('Получаем показания весов…');
    expect(
      operatorDefectRecoveryMessage({ status: 'offline', stable: false, grossKg: 0 }, 0.05),
    ).toContain('Весы поста недоступны');
    expect(
      operatorDefectRecoveryMessage({ status: 'ready', stable: false, grossKg: 0.06 }, 0.05),
    ).toBe('Дождитесь стабильного сигнала весов.');
    expect(
      operatorDefectRecoveryMessage({ status: 'ready', stable: true, grossKg: 0.05 }, 0.05),
    ).toContain('больше шпули 0,05 кг');
    expect(
      operatorDefectRecoveryMessage({ status: 'ready', stable: true, grossKg: 0.06 }, 0.05),
    ).toBeNull();
  });
});
