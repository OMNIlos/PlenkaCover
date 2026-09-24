import { PlenkiModal } from '../../../components/plenki-ui/PlenkiPrimitives';
import { editPayrollTariffOrderIdentity } from './payrollTariffOrderModel';
import { PayrollTariffMatrixEditor } from './PayrollTariffMatrixEditor';
import type { PayrollTariffOrdersController } from './usePayrollTariffOrders';

const statusLabels = {
  draft: 'Черновик',
  published: 'Опубликован',
} as const;

function formatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

function fieldError(
  controller: PayrollTariffOrdersController,
  path: string,
): string | null {
  return controller.state.fieldErrors.find((error) => error.path === path)?.message ?? null;
}

function VersionList({ controller }: { controller: PayrollTariffOrdersController }) {
  const { list, listStatus, mutationStatus, selectedOrderId } = controller.state;
  const busy = mutationStatus !== 'idle';
  return (
    <aside className="payroll-tariff-order-versions" aria-label="Версии приказов по тарифам">
      <header>
        <div>
          <span className="eyebrow">История</span>
          <h4>Версии приказа</h4>
        </div>
        <button
          type="button"
          className="payroll-tariff-refresh"
          disabled={busy || listStatus === 'loading'}
          onClick={() => void controller.refreshList()}
        >
          Обновить
        </button>
      </header>
      {listStatus === 'loading' && !list ? <p role="status">Загрузка версий</p> : null}
      {list ? (
        <div className="payroll-tariff-order-version-list">
          {list.items.map((order) => (
            <button
              key={order.id}
              type="button"
              className={selectedOrderId === order.id ? 'is-selected' : undefined}
              aria-pressed={selectedOrderId === order.id}
              disabled={busy}
              onClick={() => void controller.selectOrder(order.id)}
            >
              <strong>{order.name}</strong>
              <span>
                {statusLabels[order.status]} · редакция {order.revision}
              </span>
              <time dateTime={order.effectiveFrom}>{formatDate(order.effectiveFrom)}</time>
              {list.activeOrderId === order.id ? <em>Действует сейчас</em> : null}
            </button>
          ))}
        </div>
      ) : null}
      <button
        type="button"
        className="primary-button payroll-tariff-new-version"
        disabled={busy}
        onClick={() => void controller.startNew()}
      >
        Новый приказ
      </button>
    </aside>
  );
}

function WorkflowStatus({ controller }: { controller: PayrollTariffOrdersController }) {
  const { editor, lastMutationReplayed, mutationStatus } = controller.state;
  if (!editor) return null;
  const mutationLabel = {
    saving: 'Сохраняем черновик',
    reviewing: 'Проверяем приказ',
    publishing: 'Публикуем приказ',
  } as const;
  return (
    <div className="payroll-tariff-workflow-status" role="status" aria-live="polite">
      {mutationStatus !== 'idle' ? (
        <strong>{mutationLabel[mutationStatus]}</strong>
      ) : editor.status === 'published' ? (
        <strong>Опубликованная версия доступна только для чтения</strong>
      ) : editor.review?.publishable ? (
        <strong>Редакция {editor.review.revision} проверена</strong>
      ) : editor.review ? (
        <strong>Проверка нашла ошибки: {editor.review.fieldErrors.length}</strong>
      ) : editor.status === 'local' ? (
        <span>Новая версия ещё не сохранена</span>
      ) : (
        <span>Сначала сохраните и проверьте текущую редакцию</span>
      )}
      {lastMutationReplayed ? <small>Повтор операции подтверждён сервером</small> : null}
    </div>
  );
}

function EditorForm({
  controller,
  canManage,
}: {
  controller: PayrollTariffOrdersController;
  canManage: boolean;
}) {
  const { editor, list, detailStatus, mutationStatus } = controller.state;
  if (!editor) {
    return (
      <div className="payroll-tariff-order-loading" role="status">
        {detailStatus === 'error' ? 'Приказ не загружен' : 'Загрузка приказа'}
      </div>
    );
  }

  const busy = mutationStatus !== 'idle';
  const readOnly = editor.status === 'published' || !canManage || busy;
  const nameError = fieldError(controller, 'name');
  const effectiveFromError = fieldError(controller, 'effectiveFrom');
  return (
    <main className="payroll-tariff-order-editor" aria-busy={busy || undefined}>
      <WorkflowStatus controller={controller} />
      {!canManage && editor.status !== 'published' ? (
        <p className="payroll-tariff-order-notice" role="note">
          Изменение и публикация приказов недоступны в этом режиме.
        </p>
      ) : null}
      <section className="payroll-tariff-order-identity" aria-labelledby="payroll-order-identity">
        <header>
          <span className="eyebrow">Основание расчёта</span>
          <h4 id="payroll-order-identity">Реквизиты приказа</h4>
        </header>
        <div>
          <label className={nameError ? 'has-error' : undefined}>
            <span>Название приказа</span>
            <input
              type="text"
              value={editor.name}
              disabled={readOnly}
              aria-label="Название приказа"
              aria-invalid={nameError ? true : undefined}
              onChange={(event) =>
                controller.edit((current) =>
                  editPayrollTariffOrderIdentity(current, 'name', event.currentTarget.value),
                )
              }
            />
            {nameError ? <em role="alert">{nameError}</em> : null}
          </label>
          <label className={effectiveFromError ? 'has-error' : undefined}>
            <span>Дата вступления в силу</span>
            <input
              type="date"
              value={editor.effectiveFrom}
              min={list?.minimumPublishEffectiveFrom}
              disabled={readOnly}
              aria-label="Дата вступления в силу"
              aria-invalid={effectiveFromError ? true : undefined}
              onChange={(event) =>
                controller.edit((current) =>
                  editPayrollTariffOrderIdentity(
                    current,
                    'effectiveFrom',
                    event.currentTarget.value,
                  ),
                )
              }
            />
            <small>Дата указана по Москве</small>
            {effectiveFromError ? <em role="alert">{effectiveFromError}</em> : null}
          </label>
        </div>
      </section>

      <PayrollTariffMatrixEditor
        editor={editor}
        fieldErrors={controller.state.fieldErrors}
        onChange={(next) => controller.edit(() => next)}
        readOnly={readOnly}
      />
    </main>
  );
}

function DialogFeedback({ controller }: { controller: PayrollTariffOrdersController }) {
  const { conflict, editor, error, fieldErrors } = controller.state;
  const rejectedReview = editor?.review?.publishable === false && fieldErrors.length > 0;
  if (!conflict && !error && !rejectedReview) return null;
  return (
    <div className="payroll-tariff-order-feedback" role="alert">
      <strong>
        {conflict?.message ??
          error ??
          `Приказ не готов к публикации: исправьте ошибки (${fieldErrors.length})`}
      </strong>
      {conflict ? (
        <button type="button" onClick={() => void controller.reloadLatestRevision()}>
          Загрузить актуальную редакцию
        </button>
      ) : null}
    </div>
  );
}

function WorkflowActions({ controller }: { controller: PayrollTariffOrdersController }) {
  const { editor, mutationStatus } = controller.state;
  if (!editor || editor.status === 'published') return null;
  const busy = mutationStatus !== 'idle';
  const savedDraft = editor.status === 'draft' && editor.orderId !== null && editor.revision !== null;
  const publishable =
    savedDraft &&
    editor.review?.publishable === true &&
    editor.review.orderId === editor.orderId &&
    editor.review.revision === editor.revision;
  return (
    <div className="payroll-tariff-order-actions">
      <button type="button" disabled={busy} onClick={() => void controller.save()}>
        Сохранить черновик
      </button>
      <button
        type="button"
        disabled={busy || !savedDraft}
        onClick={() => void controller.review()}
      >
        Проверить приказ
      </button>
      <button
        type="button"
        className="primary-button"
        disabled={busy || !publishable}
        onClick={() => void controller.publish()}
      >
        Опубликовать
      </button>
    </div>
  );
}

export function PayrollTariffOrderDialog({
  controller,
  canManage,
}: {
  controller: PayrollTariffOrdersController;
  canManage: boolean;
}) {
  if (!controller.state.isOpen) return null;
  const busy = controller.state.mutationStatus !== 'idle';
  return (
    <PlenkiModal
      title="Приказы по тарифам"
      eyebrow="Зарплата операторов"
      className="payroll-tariff-order-dialog"
      bodyClassName="payroll-tariff-order-dialog-body"
      footerClassName="payroll-tariff-order-dialog-footer"
      onClose={controller.close}
      closeDisabled={busy}
      footer={
        <>
          <DialogFeedback controller={controller} />
          {canManage ? <WorkflowActions controller={controller} /> : null}
        </>
      }
    >
      <VersionList controller={controller} />
      <EditorForm controller={controller} canManage={canManage} />
    </PlenkiModal>
  );
}
