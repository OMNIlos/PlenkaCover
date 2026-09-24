import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  inspectWarehouseQr,
  type WarehouseQrInspection,
} from '../../api/warehouseQrInspection';
import { warehouseRequestErrorMessage } from './warehousePalletResources';

const QR_PATTERN = /^(?:prt|bbt|plt)_[0-9a-f]{64}$/u;

export type WarehouseQrInspectionDependencies = {
  inspect(payload: string): Promise<WarehouseQrInspection>;
};

const defaultDependencies: WarehouseQrInspectionDependencies = {
  inspect: inspectWarehouseQr,
};

function formatKg(value: number | null): string {
  return value === null
    ? '—'
    : `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(value)} кг`;
}

function formatMoney(value: number | null): string {
  return value === null
    ? '—'
    : new Intl.NumberFormat('ru-RU', {
        style: 'currency',
        currency: 'RUB',
        minimumFractionDigits: value % 100 === 0 ? 0 : 2,
        maximumFractionDigits: 2,
      }).format(value / 100);
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

function display(value: string | number | null): string {
  return value === null || value === '' ? '—' : String(value);
}

function displayList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : '—';
}

const productionStatusLabels: Record<string, string> = {
  new: 'Новый',
  assigned: 'Назначен',
  in_progress: 'В работе',
  completed: 'Готов',
  defect: 'Брак',
  cancelled: 'Отменён',
  not_linked: 'Без производственной операции',
};

const warehouseStatusLabels: Record<string, string> = {
  not_ready: 'Не передан',
  sent: 'Передан на склад',
  received: 'Принят на склад',
  defect: 'Брак',
  delivered: 'Выдан',
  shipped: 'Отгружен',
};

function statusLabel(value: string, labels: Record<string, string>): string {
  return labels[value] ?? value;
}

function RollResult({
  inspection,
}: {
  inspection: Extract<WarehouseQrInspection, { kind: 'roll' }>;
}) {
  const roll = inspection.roll;
  return (
    <article className="warehouse-qr-result" aria-label={`Рулон ${roll.rollCode}`}>
      <header>
        <div>
          <span>Рулон</span>
          <strong>{roll.rollCode}</strong>
        </div>
        <small>{statusLabel(roll.warehouseStatus, warehouseStatusLabels)}</small>
      </header>
      <dl>
        <div>
          <dt>Заявка</dt>
          <dd>{roll.orderNumber ?? 'Без заявки'}</dd>
        </div>
        <div>
          <dt>Контрагент</dt>
          <dd>{roll.customerAlias ?? '—'}</dd>
        </div>
        <div>
          <dt>Создана</dt>
          <dd>{formatDate(roll.requestCreatedAt)}</dd>
        </div>
        <div>
          <dt>Готова к отгрузке</dt>
          <dd>{formatDate(roll.readyForShipmentAt)}</dd>
        </div>
        <div>
          <dt>Номер рулона</dt>
          <dd>{display(roll.sequence)}</dd>
        </div>
        <div>
          <dt>Производство</dt>
          <dd>{statusLabel(roll.productionStatus, productionStatusLabels)}</dd>
        </div>
        <div>
          <dt>План</dt>
          <dd>{formatKg(roll.plannedKg)}</dd>
        </div>
        <div>
          <dt>Нетто</dt>
          <dd>{formatKg(roll.netKg)}</dd>
        </div>
        <div>
          <dt>Брутто</dt>
          <dd>{formatKg(roll.grossKg)}</dd>
        </div>
        <div>
          <dt>Шпуля</dt>
          <dd>{formatKg(roll.spoolKg)}</dd>
        </div>
        <div>
          <dt>Тип плёнки</dt>
          <dd>{display(roll.filmType)}</dd>
        </div>
        <div>
          <dt>Толщина факт / бух.</dt>
          <dd>
            {display(roll.actualThickness)} / {display(roll.accountingThickness)}
          </dd>
        </div>
        <div>
          <dt>Ширина</dt>
          <dd>{roll.widthMm === null ? '—' : `${display(roll.widthMm)} мм`}</dd>
        </div>
        <div>
          <dt>Метраж</dt>
          <dd>{roll.plannedLengthM === null ? '—' : `${display(roll.plannedLengthM)} м`}</dd>
        </div>
        <div>
          <dt>Тип шпули</dt>
          <dd>{display(roll.spoolType)}</dd>
        </div>
        <div>
          <dt>Бирка</dt>
          <dd>{display(roll.birka)}</dd>
        </div>
        <div>
          <dt>Произведён</dt>
          <dd>{formatDate(roll.producedAt)}</dd>
        </div>
        <div>
          <dt>Принят складом</dt>
          <dd>{formatDate(roll.receivedAt)}</dd>
        </div>
      </dl>
    </article>
  );
}

function BigBagResult({
  inspection,
}: {
  inspection: Extract<WarehouseQrInspection, { kind: 'big_bag' }>;
}) {
  const bag = inspection.bigBag;
  return (
    <article className="warehouse-qr-result" aria-label={`Big-Bag ${bag.code}`}>
      <header>
        <div>
          <span>Big-Bag</span>
          <strong>{bag.code}</strong>
        </div>
        <small>{bag.location === 'warehouse' ? 'На складе' : 'В производстве'}</small>
      </header>
      <dl>
        <div>
          <dt>Сырьё</dt>
          <dd>{bag.material}</dd>
        </div>
        <div>
          <dt>Текущий вес</dt>
          <dd>{formatKg(bag.currentKg)}</dd>
        </div>
        <div>
          <dt>Начальный вес</dt>
          <dd>{formatKg(bag.initialKg)}</dd>
        </div>
        <div>
          <dt>Последнее измерение</dt>
          <dd>{formatDate(bag.lastMeasuredAt)}</dd>
        </div>
        <div>
          <dt>Цена</dt>
          <dd>
            {bag.priceKopecksPerKg === null
              ? '—'
              : `${formatMoney(bag.priceKopecksPerKg)}/кг`}
          </dd>
        </div>
        <div>
          <dt>Текущая стоимость</dt>
          <dd>{formatMoney(bag.totalKopecks)}</dd>
        </div>
      </dl>
    </article>
  );
}

function PalletResult({
  inspection,
}: {
  inspection: Extract<WarehouseQrInspection, { kind: 'pallet' }>;
}) {
  const pallet = inspection.pallet;
  const palletStatus =
    pallet.status === 'sealed'
      ? 'Закрыта'
      : pallet.status === 'open'
        ? 'Открыта'
        : 'Статус не указан';
  const documentStatus =
    pallet.documentStatus === 'voided'
      ? 'Аннулирован'
      : pallet.documentStatus === 'sealed'
        ? 'Действует'
        : 'Не указан';
  const documentVoided = pallet.documentStatus === 'voided';
  return (
    <article className="warehouse-qr-result" aria-label={`Палета ${pallet.palletCode}`}>
      <header>
        <div>
          <span>Палета</span>
          <strong>{pallet.palletCode}</strong>
        </div>
        <small className={documentVoided ? 'is-voided' : undefined}>
          {documentVoided ? 'Палетный лист аннулирован' : palletStatus}
        </small>
      </header>
      <dl>
        <div>
          <dt>Материал</dt>
          <dd>{pallet.materialMark}</dd>
        </div>
        <div>
          <dt>Продукция</dt>
          <dd>{displayList(pallet.productNames)}</dd>
        </div>
        <div>
          <dt>Артикул</dt>
          <dd>{display(pallet.article)}</dd>
        </div>
        <div>
          <dt>Рулоны</dt>
          <dd>{pallet.rollCount} рул.</dd>
        </div>
        {pallet.rollCodes.length > 0 ? (
          <div className="warehouse-qr-roll-composition">
            <dt>Состав палеты</dt>
            <dd>
              <ul className="warehouse-qr-roll-code-list" aria-label="Рулоны на палете">
                {pallet.rollCodes.map((rollCode, index) => (
                  <li key={`${rollCode}:${index}`}>{rollCode}</li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Вес</dt>
          <dd>
            Нетто {formatKg(pallet.netKg)} · Брутто {formatKg(pallet.grossKg)}
          </dd>
        </div>
        <div>
          <dt>Упаковка</dt>
          <dd>
            {display(pallet.packagingMaterial)}
            {pallet.packagingCount === null ? '' : ` · ${pallet.packagingCount} шт.`}
          </dd>
        </div>
        <div>
          <dt>Срок годности</dt>
          <dd>
            {display(
              pallet.shelfLifeMonths === null ? null : `${pallet.shelfLifeMonths} мес.`,
            )}
          </dd>
        </div>
        <div>
          <dt>Хранение</dt>
          <dd>{display(pallet.storageConditions)}</dd>
        </div>
        <div>
          <dt>Заказы</dt>
          <dd>{displayList(pallet.orderNumbers)}</dd>
        </div>
        <div>
          <dt>Контрагенты</dt>
          <dd>{displayList(pallet.customerAliases)}</dd>
        </div>
        <div>
          <dt>Произведено</dt>
          <dd>{display(pallet.productionDate)}</dd>
        </div>
        <div>
          <dt>Поставка</dt>
          <dd>{display(pallet.deliveryDate)}</dd>
        </div>
        <div>
          <dt>Статус палетного листа</dt>
          <dd className={`warehouse-qr-document-status${documentVoided ? ' is-voided' : ''}`}>
            {documentStatus}
          </dd>
        </div>
        <div>
          <dt>Палетный лист создан</dt>
          <dd>{formatDate(pallet.createdAt)}</dd>
        </div>
        <div>
          <dt>Закрыта</dt>
          <dd>{formatDate(pallet.sealedAt)}</dd>
        </div>
      </dl>
    </article>
  );
}

export function WarehouseQrInspectionPanel({
  dependencies = defaultDependencies,
}: {
  dependencies?: WarehouseQrInspectionDependencies;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const restoreFocusRef = useRef(false);
  const [payload, setPayload] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WarehouseQrInspection | null>(null);
  const normalizedPayload = payload.trim();
  const valid = QR_PATTERN.test(normalizedPayload);

  useEffect(() => {
    if (pending || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    inputRef.current?.focus();
  }, [pending]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || pending) return;
    restoreFocusRef.current = true;
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const inspection = await dependencies.inspect(normalizedPayload);
      setResult(inspection);
      setPayload('');
    } catch (reason) {
      setError(warehouseRequestErrorMessage(reason));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="warehouse-qr-inspection" aria-label="Проверка QR">
      <header>
        <div>
          <span className="eyebrow">Рулоны, палеты и Big-Bag</span>
          <h2>Проверка QR</h2>
          <p>Показывает актуальные данные без приёмки и перемещения.</p>
        </div>
      </header>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          <span>QR-код</span>
          <input
            ref={inputRef}
            value={payload}
            onChange={(event) => setPayload(event.currentTarget.value)}
            aria-label="QR-код рулона, палеты или Big-Bag"
            placeholder="Отсканируйте метку"
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
          />
        </label>
        <button type="submit" className="action-recommended" disabled={!valid || pending}>
          {pending ? 'Проверяем…' : 'Показать'}
        </button>
      </form>
      {error ? (
        <p className="warehouse-qr-error" role="alert">
          {error}
        </p>
      ) : null}
      <div aria-live="polite">
        {result?.kind === 'roll' ? <RollResult inspection={result} /> : null}
        {result?.kind === 'big_bag' ? <BigBagResult inspection={result} /> : null}
        {result?.kind === 'pallet' ? <PalletResult inspection={result} /> : null}
      </div>
    </section>
  );
}
