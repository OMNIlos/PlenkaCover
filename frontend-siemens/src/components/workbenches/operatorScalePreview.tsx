import type { OperatorScaleReading } from '../../api/operator';

export function formatOperatorScaleKg(value: number) {
  const roundedToTenth = Math.round(value * 10) / 10;
  const digits = Math.abs(value - roundedToTenth) >= 0.001 ? 2 : 1;
  return value.toFixed(digits).replace('.', ',');
}

export function calculateOperatorScaleReading({
  grossKg,
  spoolKg,
  plannedNetKg,
  stable,
}: {
  grossKg: number;
  spoolKg: number;
  plannedNetKg: number;
  stable: boolean;
}) {
  const gross = Math.max(0, grossKg);
  const net = Math.max(0, gross - spoolKg);
  const deviation =
    plannedNetKg > 0 ? Number((((net - plannedNetKg) / plannedNetKg) * 100).toFixed(1)) : 0;
  return { gross, net, deviation, stable, offline: false };
}

export function canSubmitOperatorDefect(
  reading: Pick<OperatorScaleReading, 'status' | 'stable' | 'grossKg'> | null,
  spoolKg: number,
) {
  return Boolean(
    reading?.status === 'ready' &&
      reading.stable &&
      Number.isFinite(reading.grossKg) &&
      reading.grossKg > spoolKg,
  );
}

export function operatorDefectRecoveryMessage(
  reading: Pick<OperatorScaleReading, 'status' | 'stable' | 'grossKg'> | null,
  spoolKg: number,
) {
  if (!reading) return 'Получаем показания весов…';
  if (reading.status !== 'ready') {
    return 'Весы поста недоступны. Проверьте подключение и повторите.';
  }
  if (!reading.stable) return 'Дождитесь стабильного сигнала весов.';
  if (!Number.isFinite(reading.grossKg) || reading.grossKg <= spoolKg) {
    return `Положите бракованный рулон: масса должна быть больше шпули ${formatOperatorScaleKg(spoolKg)} кг.`;
  }
  return null;
}

export function OperatorScalePreview({
  rollCode,
  grossKg,
  spoolKg,
  plannedNetKg,
  stable,
  offline = false,
  waiting = false,
  isSpoolStep = false,
  tone = 'standard',
  sourceLabel,
  showRollCode = true,
}: {
  rollCode: string;
  grossKg: number;
  spoolKg: number;
  plannedNetKg: number;
  stable: boolean;
  offline?: boolean;
  waiting?: boolean;
  isSpoolStep?: boolean;
  tone?: 'standard' | 'critical';
  sourceLabel?: string;
  showRollCode?: boolean;
}) {
  const reading = isSpoolStep
    ? { gross: Math.max(0, grossKg), net: 0, deviation: 0, stable, offline }
    : { ...calculateOperatorScaleReading({ grossKg, spoolKg, plannedNetKg, stable }), offline };
  const measurementReady = stable && (tone !== 'critical' || reading.net > 0);
  const headLabel = offline
    ? 'Весы недоступны'
    : waiting
      ? 'Ждем сигнал весов'
      : tone === 'critical' && stable && !measurementReady
        ? 'Масса брака 0 кг'
      : stable
        ? 'Стабильное значение'
        : 'Стабилизация';

  return (
    <section
      className={`operator-live-scale ${stable ? 'is-stable' : 'is-settling'}${tone === 'critical' ? ' is-critical' : ''}`}
      aria-label="Показания весов в реальном времени"
      aria-live="polite"
    >
      <div className="operator-live-scale-head">
        <div>
          <strong>{headLabel}</strong>
          {sourceLabel && <small> · {sourceLabel}</small>}
        </div>
        {showRollCode ? <em>{rollCode}</em> : null}
      </div>
      <div className="operator-live-scale-body">
        <div className="scale-dial" aria-hidden="true">
          <div className="scale-dial-arc" />
          <div className="scale-dial-needle" />
          <span>{offline ? '!' : stable ? 'OK' : '...'}</span>
        </div>
        <div className="scale-reading">
          <span>{isSpoolStep ? 'Шпуля' : 'Брутто'}</span>
          <strong>
            {offline || waiting ? '—' : `${formatOperatorScaleKg(reading.gross)} кг`}
          </strong>
          <small>
            {offline
              ? 'проверьте весы и шлюз поста'
              : waiting
                ? 'подключаемся к весам…'
                : isSpoolStep
                  ? 'сигнал весов готов к фиксации'
                  : `нетто ${formatOperatorScaleKg(reading.net)} кг · план ${formatOperatorScaleKg(plannedNetKg)} кг`}
          </small>
        </div>
        <div className="scale-stability">
          <span>Отклонение</span>
          <strong>
            {offline || waiting
              ? '—'
              : isSpoolStep
                ? '0,0%'
                : `${reading.deviation > 0 ? '+' : ''}${reading.deviation.toFixed(1).replace('.', ',')}%`}
          </strong>
          <small>
            {offline
              ? 'фиксация недоступна'
              : measurementReady
                ? 'можно фиксировать'
                : tone === 'critical' && stable
                  ? 'положите бракованный рулон'
                  : 'ждем стабильный сигнал'}
          </small>
        </div>
      </div>
    </section>
  );
}
