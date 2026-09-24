import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { PenaltySnapshotFilters, PenaltySnapshotRuntime } from '../../api/penalties';
import { SharedPenaltySnapshot } from '../../features/penalties/SharedPenaltySnapshot';

import { SeverityPill } from '../shell/viewPrimitives';
import { trapFocusWithin } from '../shell/focusTrap';
import type { PenaltyRuntime } from '../../domain/runtime';
import {
  penaltyHistoryActionLabel,
  penaltyIdFromWorkListId,
  penaltyStatusLabel,
} from '../../domain/runtime/penaltyView';
import {
  isPenaltyWorkLinkValid,
  resetPenaltyRollOnOrderChange,
  resetPenaltyWorkLinkOnEmployeeChange,
  type PenaltyWorkCatalog,
  type PenaltyWorkOrderOption,
} from '../../domain/penaltyWorkObjects';

export type PenaltyFormPayload = {
  employeeId: string;
  employeeName: string;
  employeeRole: string;
  amountLabel: string;
  reason: string;
  scopeObjectId: string;
  productionOrderId?: string;
  rollCode?: string;
  author: string;
};

type PenaltyCreate = (
  payload: PenaltyFormPayload,
) => void | boolean | Promise<void | boolean>;

export type PenaltyCreateLock = {
  current: Promise<void | boolean> | null;
};

export function executePenaltyCreate(
  payload: PenaltyFormPayload,
  onCreate: PenaltyCreate,
  lock: PenaltyCreateLock,
): Promise<void | boolean> {
  if (lock.current) return lock.current;
  const request = (async () => onCreate(payload))().finally(() => {
    if (lock.current === request) lock.current = null;
  });
  lock.current = request;
  return request;
}

export type EmployeeOption = {
  id: string;
  name: string;
  role: string;
};

type PenaltyAuthorRole = 'director' | 'production';
const defaultEmployee: EmployeeOption = { id: '', name: '', role: '' };

function emptyForm(scopeObjectId = '', author = 'Директор'): PenaltyFormPayload {
  return {
    employeeId: defaultEmployee.id,
    employeeName: defaultEmployee.name,
    employeeRole: defaultEmployee.role,
    amountLabel: '',
    reason: '',
    scopeObjectId,
    author,
  };
}

function normalizePayload(payload: PenaltyFormPayload): PenaltyFormPayload {
  return {
    ...payload,
    amountLabel: payload.amountLabel.trim(),
    reason: payload.reason.trim(),
    scopeObjectId: payload.scopeObjectId.trim() || 'без связанного объекта',
    author: payload.author.trim() || 'Директор',
  };
}

function isComplete(payload: PenaltyFormPayload, requireWorkObject = false) {
  return Boolean(
    payload.employeeId &&
      payload.employeeName &&
      payload.amountLabel.trim() &&
      payload.reason.trim() &&
      payload.author.trim() &&
      (!requireWorkObject || payload.productionOrderId),
  );
}

function allowedEmployeeOptions(
  authorRole: PenaltyAuthorRole,
  options: EmployeeOption[],
) {
  if (authorRole === 'director') return options;
  return options.filter((employee) => employee.role === 'Оператор');
}

function penaltySeverity(penalty: PenaltyRuntime) {
  if (penalty.status === 'created') return 'warning';
  return 'info';
}

function selectEmployee(payload: PenaltyFormPayload, employeeId: string, options: EmployeeOption[]): PenaltyFormPayload {
  const employee = options.find((item) => item.id === employeeId) ?? options[0] ?? defaultEmployee;
  return {
    ...payload,
    employeeId: employee.id,
    employeeName: employee.name,
    employeeRole: employee.role,
  };
}

export function PenaltyManagementSurface({
  snapshot,
  filters,
  scopedObjectId,
  defaultAuthor = 'Директор',
  authorRole = 'director',
  assignmentEmployees,
  canCreatePenalty,
  workCatalog,
  allowUpdate = true,
  selectedPenaltyId: requestedPenaltyId,
  onFiltersChange,
  onCreate,
  onUpdate,
}: {
  snapshot: PenaltySnapshotRuntime;
  filters: PenaltySnapshotFilters;
  scopedObjectId: string;
  defaultAuthor?: string;
  authorRole?: PenaltyAuthorRole;
  assignmentEmployees?: EmployeeOption[];
  canCreatePenalty: boolean;
  workCatalog?: PenaltyWorkCatalog;
  allowUpdate?: boolean;
  selectedPenaltyId?: string | null;
  onFiltersChange: (filters: PenaltySnapshotFilters) => void | Promise<unknown>;
  onCreate: PenaltyCreate;
  onUpdate: (penaltyId: string, payload: PenaltyFormPayload) => void;
}) {
  const penalties = snapshot.items;
  const snapshotAssignmentEmployees = useMemo<EmployeeOption[]>(
    () =>
      penalties.flatMap((penalty) =>
        penalty.employeeId && penalty.employeeName !== 'Сотрудник не найден'
          ? [
              {
                id: penalty.employeeId,
                name: penalty.employeeName,
                role: penalty.employeeRole,
              },
            ]
          : [],
      ).filter(
        (employee, index, rows) =>
          rows.findIndex((candidate) => candidate.id === employee.id) === index,
      ),
    [penalties],
  );
  const selectableEmployees = useMemo(
    () =>
      allowedEmployeeOptions(
        authorRole,
        assignmentEmployees ?? snapshotAssignmentEmployees,
      ),
    [assignmentEmployees, authorRole, snapshotAssignmentEmployees],
  );
  const [form, setForm] = useState<PenaltyFormPayload>(() => emptyForm(scopedObjectId, defaultAuthor));
  const [selectedPenaltyId, setSelectedPenaltyId] = useState<string | null>(penalties[0]?.penaltyId ?? null);
  const selectedPenalty = penalties.find((penalty) => penalty.penaltyId === selectedPenaltyId) ?? penalties[0] ?? null;
  const [editForm, setEditForm] = useState<PenaltyFormPayload>(() => selectedPenalty ? payloadFromPenalty(selectedPenalty) : emptyForm());
  const selectedHistory = useMemo(() => selectedPenalty?.history ?? [], [selectedPenalty]);
  const usesWorkObjectCatalog = authorRole === 'production' && workCatalog !== undefined;
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [createPending, setCreatePending] = useState(false);
  const createLock = useRef<Promise<void | boolean> | null>(null);
  const formWorkOrders = workCatalog?.[form.employeeId] ?? [];

  useEffect(() => {
    if (!requestedPenaltyId) return;
    const penaltyId = penaltyIdFromWorkListId(requestedPenaltyId);
    if (penalties.some((penalty) => penalty.penaltyId === penaltyId)) {
      setSelectedPenaltyId(penaltyId);
    }
  }, [penalties, requestedPenaltyId]);

  useEffect(() => {
    if (!scopedObjectId) return;
    setForm((current) => ({ ...current, scopeObjectId: scopedObjectId }));
  }, [scopedObjectId]);

  useEffect(() => {
    setForm((current) => ({ ...current, author: current.author || defaultAuthor }));
  }, [defaultAuthor]);

  useEffect(() => {
    if (selectableEmployees.some((employee) => employee.id === form.employeeId)) return;
    if (selectableEmployees.length === 0) {
      setForm((current) => ({
        ...current,
        employeeId: '',
        employeeName: '',
        employeeRole: '',
        scopeObjectId: '',
      }));
      return;
    }
    setForm((current) => ({
      ...resetPenaltyWorkLinkOnEmployeeChange(
        selectEmployee(
          current,
          selectableEmployees[0]?.id ?? defaultEmployee.id,
          selectableEmployees,
        ),
        selectableEmployees[0]?.id ?? defaultEmployee.id,
      ),
      scopeObjectId: '',
    }));
  }, [form.employeeId, selectableEmployees]);

  useEffect(() => {
    if (!selectedPenalty) return;
    setSelectedPenaltyId(selectedPenalty.penaltyId);
    setEditForm(payloadFromPenalty(selectedPenalty));
  }, [selectedPenalty]);

  useEffect(() => {
    if (!canCreatePenalty) setAssignDialogOpen(false);
  }, [canCreatePenalty]);

  async function submitCreate() {
    if (
      !canCreatePenalty ||
      !selectableEmployees.some((employee) => employee.id === form.employeeId) ||
      !isComplete(form, usesWorkObjectCatalog) ||
      createLock.current
    )
      return;
    setCreatePending(true);
    try {
      const created = await executePenaltyCreate(normalizePayload(form), onCreate, createLock);
      if (created === false) return;
      setForm(emptyForm(scopedObjectId, defaultAuthor));
      setAssignDialogOpen(false);
    } finally {
      setCreatePending(false);
    }
  }

  function submitUpdate() {
    if (!selectedPenalty || !isComplete(editForm)) return;
    onUpdate(selectedPenalty.penaltyId, normalizePayload(editForm));
  }

  return (
    <div className={`director-main-grid penalty-workbench ${selectedPenalty ? 'has-drawer' : 'is-empty'}`}>
      <section className="surface director-table-surface" aria-label="Штрафы производства">
        <SharedPenaltySnapshot
          snapshot={snapshot}
          filters={filters}
          selectedPenaltyId={selectedPenalty?.penaltyId}
          onFiltersChange={onFiltersChange}
          onSelectPenalty={setSelectedPenaltyId}
        />

        {canCreatePenalty && (
          <PenaltyAssignCommand
            scopedObjectId={scopedObjectId}
            employeeCount={selectableEmployees.length}
            authorRole={authorRole}
            onOpen={() => setAssignDialogOpen(true)}
          />
        )}

        {canCreatePenalty && assignDialogOpen && (
          <PenaltyAssignDialog
            form={form}
            employeeOptions={selectableEmployees}
            workOrders={formWorkOrders}
            linkWorkObjects={usesWorkObjectCatalog}
            authorRole={authorRole}
            pending={createPending}
            onChange={setForm}
            onSubmit={submitCreate}
            onClose={() => setAssignDialogOpen(false)}
          />
        )}

      </section>

      {selectedPenalty && (
        <PenaltyDetailDrawer
          selectedPenalty={selectedPenalty}
          selectedHistory={selectedHistory}
          editForm={editForm}
          employeeOptions={selectableEmployees}
          allowUpdate={allowUpdate}
          onChange={setEditForm}
          onSubmit={submitUpdate}
        />
      )}
    </div>
  );
}

function PenaltyAssignCommand({ scopedObjectId, employeeCount, authorRole, onOpen }: { scopedObjectId: string; employeeCount: number; authorRole: PenaltyAuthorRole; onOpen: () => void }) {
  const isProduction = authorRole === 'production';
  return (
    <section className="penalty-assign-command" aria-label="Назначение штрафа">
      <div>
        <span className="eyebrow">Назначение</span>
        <h3>{isProduction ? 'Назначить штраф оператору' : 'Назначить штраф'}</h3>
        <p>{isProduction ? 'Доступны только операторы.' : 'Доступны операторы и зав. производства.'}</p>
      </div>
      <dl>
        <div>
          <dt>Кому</dt>
          <dd>{employeeCount} сотрудников</dd>
        </div>
        <div>
          <dt>Объект</dt>
          <dd>{scopedObjectId || 'выбрать при назначении'}</dd>
        </div>
        <div>
          <dt>История</dt>
          <dd>создание + уведомление</dd>
        </div>
      </dl>
      <button type="button" className="action-tile action-recommended penalty-assign-command-button" onClick={onOpen}>
        <ix-icon name="add" size="24" />
        <span>{isProduction ? 'Назначить оператору' : 'Назначить штраф'}</span>
      </button>
    </section>
  );
}

function PenaltyAssignDialog({
  form,
  employeeOptions: options,
  workOrders,
  linkWorkObjects,
  authorRole,
  pending,
  onChange,
  onSubmit,
  onClose,
}: {
  form: PenaltyFormPayload;
  employeeOptions: EmployeeOption[];
  workOrders: PenaltyWorkOrderOption[];
  linkWorkObjects: boolean;
  authorRole: PenaltyAuthorRole;
  pending: boolean;
  onChange: (next: PenaltyFormPayload) => void;
  onSubmit: () => void | Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const isProduction = authorRole === 'production';

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (pending) return;
      onClose();
      return;
    }
    trapFocusWithin(event);
  }

  return (
    <div className="penalty-dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="penalty-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="penalty-assign-dialog-title"
        aria-busy={pending}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="penalty-dialog-header">
          <div>
            <span className="eyebrow">Назначение</span>
            <h2 id="penalty-assign-dialog-title">{isProduction ? 'Назначить штраф оператору' : 'Назначить штраф'}</h2>
            <p>{isProduction ? 'Оператор, его реальный заказ и необязательный рулон.' : 'Сотрудник, сумма, объект и причина.'}</p>
          </div>
          <button className="drawer-close-button" type="button" onClick={onClose} aria-label="Закрыть" disabled={pending}>
            <ix-icon name="close" size="24" />
          </button>
        </header>
        <div className="penalty-dialog-body">
          <PenaltyForm
            value={form}
            employeeOptions={options}
            workOrders={workOrders}
            linkWorkObjects={linkWorkObjects}
            authorRole={authorRole}
            pending={pending}
            submitLabel={isProduction ? 'Назначить оператору' : 'Назначить штраф'}
            disabledText={isProduction ? 'Выберите оператора и его заказ, укажите сумму, причину и автора.' : 'Заполните сотрудника, сумму, причину и автора.'}
            onChange={onChange}
            onSubmit={onSubmit}
          />
        </div>
      </section>
    </div>
  );
}

function PenaltyDetailDrawer({ selectedPenalty, selectedHistory, editForm, employeeOptions: options, allowUpdate, onChange, onSubmit }: { selectedPenalty: PenaltyRuntime; selectedHistory: PenaltyRuntime['history']; editForm: PenaltyFormPayload; employeeOptions: EmployeeOption[]; allowUpdate: boolean; onChange: (next: PenaltyFormPayload) => void; onSubmit: () => void }) {
  return (
    <aside className={`surface director-drawer severity-${penaltySeverity(selectedPenalty)}`} aria-label="Карточка штрафа">
      <header className="drawer-header">
        <div>
          <span className="eyebrow">Штраф</span>
          <h2 className="penalty-detail-id" title={selectedPenalty.penaltyId}>
            {selectedPenalty.penaltyId}
          </h2>
        </div>
      </header>

      <div className="drawer-evidence-grid">
        <div><span>Сотрудник</span><strong>{selectedPenalty.employeeName}</strong></div>
        <div><span>Сумма</span><strong>{selectedPenalty.amountLabel}</strong></div>
        <div><span>Статус</span><strong>{penaltyStatusLabel(selectedPenalty.status)}</strong></div>
        <div><span>Объект</span><strong>{selectedPenalty.scopeObjectId}</strong></div>
      </div>

      {allowUpdate ? (
        <section className="drawer-section">
          <h3>Изменить штраф</h3>
          <PenaltyForm
            value={editForm}
            employeeOptions={options}
            submitLabel="Сохранить изменения"
            disabledText="Нельзя сохранить без сотрудника, суммы, причины и автора."
            onChange={onChange}
            onSubmit={onSubmit}
          />
        </section>
      ) : (
        <section className="drawer-section">
          <h3>Основание</h3>
          <p>{selectedPenalty.reason}</p>
          <small>Изменение недоступно; оформите новое решение.</small>
        </section>
      )}

      <section className="drawer-section">
        <h3>История изменений</h3>
        <div className="audit-list compact">
          {selectedHistory.map((item) => (
            <article key={item.id} className="audit-entry">
              <span>{item.time} · {item.actorLabel}</span>
              <strong>{penaltyHistoryActionLabel(item.actionLabel)}</strong>
              <p>{item.detail}</p>
              {(item.oldValue || item.newValue) && <small>Было: {item.oldValue ?? 'нет'} · Стало: {item.newValue ?? 'нет'}</small>}
            </article>
          ))}
        </div>
      </section>
    </aside>
  );
}

function payloadFromPenalty(penalty: PenaltyRuntime): PenaltyFormPayload {
  return {
    employeeId: penalty.employeeId,
    employeeName: penalty.employeeName,
    employeeRole: penalty.employeeRole,
    amountLabel: penalty.amountLabel,
    reason: penalty.reason,
    scopeObjectId: penalty.scopeObjectId,
    author: penalty.author,
  };
}

function PenaltyForm({
  value,
  employeeOptions: options,
  workOrders = [],
  linkWorkObjects = false,
  authorRole = 'director',
  pending = false,
  submitLabel,
  disabledText,
  onChange,
  onSubmit,
}: {
  value: PenaltyFormPayload;
  employeeOptions: EmployeeOption[];
  workOrders?: PenaltyWorkOrderOption[];
  linkWorkObjects?: boolean;
  authorRole?: PenaltyAuthorRole;
  pending?: boolean;
  submitLabel: string;
  disabledText: string;
  onChange: (next: PenaltyFormPayload) => void;
  onSubmit: () => void;
}) {
  const selectedWorkOrder = workOrders.find(
    (order) => order.productionOrderId === value.productionOrderId,
  );
  const complete =
    isComplete(value, linkWorkObjects) &&
    (!linkWorkObjects ||
      isPenaltyWorkLinkValid(workOrders, value.productionOrderId, value.rollCode));
  const disabledReason = complete ? undefined : disabledText;
  const disabledRecovery = complete
    ? undefined
    : 'Заполнить поля.';
  const disabledHelp = disabledReason ? `${disabledReason} ${disabledRecovery}` : undefined;

  return (
    <div className="template-edit-form penalty-form">
      <label>
        <span>Сотрудник</span>
        <select
          value={value.employeeId}
          onChange={(event) => {
            const next = selectEmployee(value, event.target.value, options);
            onChange(
              linkWorkObjects
                ? {
                    ...resetPenaltyWorkLinkOnEmployeeChange(next, event.target.value),
                    scopeObjectId: '',
                  }
                : next,
            );
          }}
        >
          {options.map((employee) => (
            <option key={employee.id} value={employee.id}>{employee.name} · {employee.role}</option>
          ))}
        </select>
      </label>
      <label>
        <span>Сумма</span>
        <input value={value.amountLabel} onChange={(event) => onChange({ ...value, amountLabel: event.target.value })} placeholder="2 000 ₽" />
      </label>
      {linkWorkObjects ? (
        <>
          <label>
            <span>Связанный заказ</span>
            <select
              aria-label="Связанный заказ"
              value={value.productionOrderId ?? ''}
              onChange={(event) => {
                const order = workOrders.find(
                  (item) => item.productionOrderId === event.target.value,
                );
                onChange({
                  ...resetPenaltyRollOnOrderChange(value, event.target.value),
                  scopeObjectId: order ? `Заказ ${order.orderNumber} целиком` : '',
                });
              }}
            >
              <option value="">Выберите реальный заказ</option>
              {workOrders.map((order) => (
                <option key={order.productionOrderId} value={order.productionOrderId}>
                  Заказ {order.orderNumber}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Связанный рулон</span>
            <select
              aria-label="Связанный рулон"
              value={value.rollCode ?? ''}
              disabled={!selectedWorkOrder}
              onChange={(event) =>
                onChange({
                  ...value,
                  rollCode: event.target.value,
                  scopeObjectId: selectedWorkOrder
                    ? event.target.value
                      ? `Заказ ${selectedWorkOrder.orderNumber} · рулон ${event.target.value}`
                      : `Заказ ${selectedWorkOrder.orderNumber} целиком`
                    : '',
                })
              }
            >
              <option value="">Весь заказ</option>
              {(selectedWorkOrder?.rollCodes ?? []).map((rollCode) => (
                <option key={rollCode} value={rollCode}>
                  Рулон {rollCode}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <label>
          <span>Связанный объект</span>
          <input value={value.scopeObjectId} onChange={(event) => onChange({ ...value, scopeObjectId: event.target.value })} placeholder="ЗН-2606-014 / WH-2606-044" />
        </label>
      )}
      <label>
        <span>Автор</span>
        <input value={value.author} onChange={(event) => onChange({ ...value, author: event.target.value })} placeholder="Директор" />
      </label>
      <label className="is-wide">
        <span>Причина</span>
        <textarea value={value.reason} onChange={(event) => onChange({ ...value, reason: event.target.value })} placeholder="Что произошло и почему назначается штраф" />
      </label>
      <div className="template-editor-actions">
        <button
          className="action-tile action-recommended create-intake-button"
          type="button"
          disabled={pending || !complete}
          title={disabledHelp}
          aria-label={disabledHelp ? `${submitLabel}. ${disabledHelp}` : submitLabel}
          onClick={onSubmit}
        >
          {pending ? 'Сохраняем…' : submitLabel}
        </button>
        {!complete && (
          <span className="penalty-disabled-recovery">
            <strong>{disabledText}</strong>
            <small>{disabledRecovery}</small>
          </span>
        )}
      </div>
    </div>
  );
}
