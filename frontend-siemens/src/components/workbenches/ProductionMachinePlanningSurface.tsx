import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  OperatorMachineAssignment,
  ProductionPost,
  ProductionShift,
} from '../../api/production';
import { currentAssignmentByOperator, currentProductionAssignments } from '../../domain/operators';
import { SiemensIcon } from '../shell/SiemensIcon';
import { ProductionActionCancellationDialog } from './ProductionActionCancellationDialog';
import {
  dirtyStringDraftBaselineValue,
  dirtyStringDraftValue,
  reconcileDirtyStringDrafts,
  setDirtyStringDraft,
  settleDirtyStringMutation,
  type DirtyStringDrafts,
} from './productionAssignmentDrafts';

export const POST_STATUS_LABEL: Record<string, string> = {
  active: 'Исправен',
  broken: 'Сломан',
  maintenance: 'В ремонте',
  inactive: 'Выведен',
};

export function ProductionMachinePlanningSurface({
  shifts,
  posts,
  operators,
  busy = false,
  onCreateShift,
  onAssignMachine,
  onBreakdownReassign,
  onIntentionalMachineChange,
  onCancelAssignment,
  onCancelMachineChange,
  onReportBreakdown,
  onStartRepair,
  onCompleteRepair,
}: {
  shifts: ProductionShift[];
  posts: ProductionPost[];
  operators: Array<{ id: string; displayName: string }>;
  busy?: boolean;
  onCreateShift: (draft: {
    operatorId: string;
    postId: string;
    label?: string;
  }) => Promise<boolean> | boolean;
  onAssignMachine: (
    shiftId: string,
    operatorId: string,
    postId: string,
  ) => Promise<boolean> | boolean;
  onBreakdownReassign: (assignmentId: string, postId: string, reason: string) => void;
  onIntentionalMachineChange?: (
    assignmentId: string,
    postId: string,
    reason: string,
  ) => Promise<boolean> | boolean;
  onCancelAssignment?: (shiftId: string, assignmentId: string, reason: string) => Promise<boolean>;
  onCancelMachineChange?: (changeId: string, reason: string) => Promise<boolean>;
  /** Поломка/ремонт станка (дизайн 2026-07-14); без обработчиков блок парка read-only. */
  onReportBreakdown?: (postId: string, reason: string) => void;
  onStartRepair?: (postId: string) => void;
  onCompleteRepair?: (postId: string) => void;
}) {
  const pendingOperatorIdsRef = useRef(new Set<string>());
  const [pendingOperatorIds, setPendingOperatorIds] = useState(() => new Set<string>());
  const [breakdownReasonByPost, setBreakdownReasonByPost] = useState<Record<string, string>>({});
  const [postByOperator, setPostByOperator] = useState<DirtyStringDrafts>({});
  const [breakdownPostByAssignment, setBreakdownPostByAssignment] = useState<
    Record<string, string>
  >({});
  const [breakdownReasonByAssignment, setBreakdownReasonByAssignment] = useState<
    Record<string, string>
  >({});
  const [machineChangeAssignmentId, setMachineChangeAssignmentId] = useState<string | null>(null);
  const [machineChangePostId, setMachineChangePostId] = useState('');
  const [machineChangeReason, setMachineChangeReason] = useState('');
  const [cancellationTarget, setCancellationTarget] = useState<
    | {
        kind: 'assignment';
        shiftId: string;
        assignmentId: string;
        detail: string;
      }
    | {
        kind: 'machine_change';
        changeId: string;
        detail: string;
      }
    | null
  >(null);
  const machineChangeDialogRef = useRef<HTMLElement>(null);
  const machineChangeSubmitStateRef = useRef({
    dialogAssignmentId: null as string | null,
    assignmentId: null as string | null,
    eligiblePostIds: new Set<string>(),
  });
  const currentAssignments = useMemo(() => currentProductionAssignments(shifts), [shifts]);
  const currentByOperator = useMemo(() => currentAssignmentByOperator(shifts), [shifts]);
  const postById = useMemo(() => new Map(posts.map((post) => [post.id, post])), [posts]);
  const currentOperatorIds = useMemo(
    () => new Set(currentAssignments.map(({ assignment }) => assignment.operatorId)),
    [currentAssignments],
  );
  const activeOccupiedPostIds = useMemo(
    () =>
      new Set(
        currentAssignments
          .filter(({ assignment }) =>
            ['locked', 'breakdown_reassigned'].includes(assignment.status),
          )
          .map(({ assignment }) => assignment.postId),
      ),
    [currentAssignments],
  );
  const machineChangeUnavailablePostIds = useMemo(() => {
    const unavailable = new Set(activeOccupiedPostIds);
    for (const draft of Object.values(postByOperator)) {
      if (draft.accepted?.value) unavailable.add(draft.accepted.value);
    }
    return unavailable;
  }, [activeOccupiedPostIds, postByOperator]);
  const machineChangeAssignment = currentAssignments.find(
    ({ assignment }) => assignment.id === machineChangeAssignmentId,
  )?.assignment;
  machineChangeSubmitStateRef.current = {
    dialogAssignmentId: machineChangeAssignmentId,
    assignmentId: machineChangeAssignment?.id ?? null,
    eligiblePostIds: new Set(
      machineChangeAssignment
        ? availableReplacementPosts(machineChangeAssignment).map((post) => post.id)
        : [],
    ),
  };

  const serverPostByOperator = useMemo(
    () =>
      Object.fromEntries(
        operators.map((operator) => {
          const current = currentByOperator.get(operator.id);
          return [operator.id, current?.state === 'assigned' ? current.assignment.postId : ''];
        }),
      ),
    [currentByOperator, operators],
  );
  const shiftScopeKey = useMemo(
    () =>
      shifts
        .map((shift) => shift.id)
        .sort()
        .join('|'),
    [shifts],
  );
  const shiftScopeKeyRef = useRef(shiftScopeKey);
  const shiftScopeGenerationRef = useRef(0);

  useEffect(() => {
    if (shiftScopeKeyRef.current !== shiftScopeKey) {
      shiftScopeKeyRef.current = shiftScopeKey;
      shiftScopeGenerationRef.current += 1;
      pendingOperatorIdsRef.current.clear();
      setPendingOperatorIds(new Set());
      setPostByOperator(
        Object.fromEntries(
          Object.entries(serverPostByOperator).map(([id, value]) => [id, { value, dirty: false }]),
        ),
      );
      return;
    }
    setPostByOperator((current) => reconcileDirtyStringDrafts(current, serverPostByOperator));
  }, [serverPostByOperator, shiftScopeKey]);

  useEffect(() => {
    if (!machineChangeAssignmentId) return;
    const frame = window.requestAnimationFrame(() => machineChangeDialogRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [machineChangeAssignmentId]);

  useEffect(() => {
    if (
      !machineChangeAssignment ||
      !machineChangePostId ||
      isEligibleReplacementPost(machineChangeAssignment, machineChangePostId)
    ) {
      return;
    }
    setMachineChangePostId('');
  }, [machineChangeAssignment, machineChangePostId, machineChangeUnavailablePostIds, posts]);

  async function assignOperatorPost(
    operatorId: string,
    postId: string,
    assignment?: OperatorMachineAssignment,
  ) {
    const pendingOperators = pendingOperatorIdsRef.current;
    const requestScopeGeneration = shiftScopeGenerationRef.current;
    const serverPostId = assignment?.postId ?? '';
    const baselinePostId = dirtyStringDraftBaselineValue(postByOperator, operatorId, serverPostId);
    const optimisticAssignment = Boolean(postByOperator[operatorId]?.accepted);
    if (
      busy ||
      pendingOperators.has(operatorId) ||
      !postId ||
      postId === baselinePostId ||
      (!assignment && (optimisticAssignment || currentOperatorIds.has(operatorId)))
    ) {
      return;
    }
    pendingOperators.add(operatorId);
    setPendingOperatorIds((current) => new Set(current).add(operatorId));
    try {
      const accepted = assignment
        ? await onAssignMachine(assignment.shiftId, operatorId, postId)
        : await onCreateShift({ operatorId, postId });
      if (shiftScopeGenerationRef.current === requestScopeGeneration && accepted !== false) {
        setPostByOperator((current) =>
          settleDirtyStringMutation(current, operatorId, true, serverPostId),
        );
      }
    } catch {
      // The parent owns failure messaging. Keep the selected post available for retry.
    } finally {
      if (shiftScopeGenerationRef.current !== requestScopeGeneration) return;
      pendingOperators.delete(operatorId);
      setPendingOperatorIds((current) => {
        const next = new Set(current);
        next.delete(operatorId);
        return next;
      });
    }
  }

  async function removeOperatorPost(
    operatorId: string,
    assignment: OperatorMachineAssignment,
  ) {
    const pendingOperators = pendingOperatorIdsRef.current;
    const requestScopeGeneration = shiftScopeGenerationRef.current;
    if (
      busy ||
      pendingOperators.has(operatorId) ||
      assignment.status !== 'planned' ||
      !onCancelAssignment
    ) {
      return;
    }
    pendingOperators.add(operatorId);
    setPendingOperatorIds((current) => new Set(current).add(operatorId));
    try {
      const accepted = await onCancelAssignment(
        assignment.shiftId,
        assignment.id,
        'Станок снят с оператора',
      );
      if (shiftScopeGenerationRef.current === requestScopeGeneration && accepted) {
        setPostByOperator((current) => ({
          ...current,
          [operatorId]: { value: '', dirty: false },
        }));
      }
    } catch {
      // The parent owns failure messaging. Keep «Без станка» selected for retry.
    } finally {
      if (shiftScopeGenerationRef.current !== requestScopeGeneration) return;
      pendingOperators.delete(operatorId);
      setPendingOperatorIds((current) => {
        const next = new Set(current);
        next.delete(operatorId);
        return next;
      });
    }
  }

  function availableReplacementPosts(assignment: OperatorMachineAssignment) {
    return posts.filter(
      (post) =>
        post.status === 'active' &&
        post.id !== assignment.postId &&
        !machineChangeUnavailablePostIds.has(post.id),
    );
  }

  function isEligibleReplacementPost(
    assignment: OperatorMachineAssignment,
    postId: string,
  ): boolean {
    return availableReplacementPosts(assignment).some((post) => post.id === postId);
  }

  async function submitIntentionalMachineChange() {
    const latest = machineChangeSubmitStateRef.current;
    if (
      !machineChangeAssignment ||
      !machineChangePostId ||
      latest.dialogAssignmentId !== machineChangeAssignmentId ||
      latest.assignmentId !== machineChangeAssignment.id ||
      !latest.eligiblePostIds.has(machineChangePostId) ||
      !machineChangeReason.trim()
    ) {
      return;
    }
    const accepted = await onIntentionalMachineChange?.(
      machineChangeAssignment.id,
      machineChangePostId,
      machineChangeReason.trim(),
    );
    if (accepted) {
      setMachineChangeAssignmentId(null);
      setMachineChangePostId('');
      setMachineChangeReason('');
    }
  }

  const machineChangeTargetEligible = Boolean(
    machineChangeAssignment &&
    machineChangePostId &&
    isEligibleReplacementPost(machineChangeAssignment, machineChangePostId),
  );

  async function cancelSelectedAction(reason: string): Promise<boolean> {
    if (!cancellationTarget) return false;
    if (cancellationTarget.kind === 'assignment') {
      return (
        (await onCancelAssignment?.(
          cancellationTarget.shiftId,
          cancellationTarget.assignmentId,
          reason,
        )) ?? false
      );
    }
    return (await onCancelMachineChange?.(cancellationTarget.changeId, reason)) ?? false;
  }

  return (
    <section
      className="surface production-workbench production-machine-planning-surface severity-info"
      aria-label="Назначение станков операторам по смене"
    >
      <header className="production-machine-planning-head">
        <div>
          <span className="eyebrow">До начала смены</span>
          <h2>
            <SiemensIcon name="network-device" size="24" /> Станки операторов
          </h2>
          <p>
            Назначьте оператору рабочий пост. Время открытия и закрытия смены фиксируется системой
            по фактическим действиям оператора.
          </p>
        </div>
      </header>

      {operators.length === 0 ? (
        <div className="production-machine-planning-empty">
          Нет доступных операторов для назначения.
        </div>
      ) : (
        <div className="production-machine-planning-table" role="table">
          <div className="production-machine-planning-row is-head" role="row">
            <span role="columnheader">Оператор</span>
            <span role="columnheader">Станок смены</span>
            <span role="columnheader">Состояние</span>
            <span role="columnheader">Действие</span>
          </div>
          {operators.map((operator) => {
            const current = currentByOperator.get(operator.id);
            const conflict = current?.state === 'conflict';
            const assignment = current?.state === 'assigned' ? current.assignment : undefined;
            const assignmentShift = current?.state === 'assigned' ? current.shift : undefined;
            const locked = Boolean(
              assignment &&
              (assignment.lockedAt ||
                assignment.status === 'locked' ||
                assignment.status === 'breakdown_reassigned'),
            );
            const planned = Boolean(assignment && assignmentShift?.status === 'planned' && !locked);
            const pending = pendingOperatorIds.has(operator.id);
            const optimisticAssignment = Boolean(postByOperator[operator.id]?.accepted);
            const postId = dirtyStringDraftValue(
              postByOperator,
              operator.id,
              assignment?.postId ?? '',
            );
            const baselinePostId = dirtyStringDraftBaselineValue(
              postByOperator,
              operator.id,
              assignment?.postId ?? '',
            );
            const replacementPosts = assignment ? availableReplacementPosts(assignment) : [];
            const replacementPostId = assignment
              ? (breakdownPostByAssignment[assignment.id] ?? '')
              : '';
            const reason = assignment ? (breakdownReasonByAssignment[assignment.id] ?? '') : '';
            const pendingMachineChange = assignment?.machineChanges?.find((change) =>
              ['requested', 'awaiting_final_weight', 'ready'].includes(change.status),
            );

            return (
              <div key={operator.id} className="production-machine-planning-row" role="row">
                <span role="cell" data-label="Оператор">
                  <strong>{operator.displayName}</strong>
                  <small>оператор смены</small>
                </span>
                <span role="cell" data-label="Станок смены">
                  <select
                    aria-label={`Станок смены для ${operator.displayName}`}
                    value={postId}
                    disabled={busy || pending || optimisticAssignment || locked || conflict}
                    onChange={(event) =>
                      setPostByOperator((current) =>
                        setDirtyStringDraft(current, operator.id, event.target.value),
                      )
                    }
                  >
                    <option value="">Без станка</option>
                    {posts.map((post) => (
                      <option
                        key={post.id}
                        value={post.id}
                        disabled={post.status !== 'active'}
                      >
                        {post.name} · {post.code}
                      </option>
                    ))}
                  </select>
                  <small>
                    {!postId && assignment
                      ? 'станок будет снят после сохранения'
                      : assignment
                      ? (assignment.post?.name ?? postById.get(assignment.postId)?.name ?? postId)
                      : 'выберите станок и нажмите «Назначить»'}
                  </small>
                </span>
                <span role="cell" data-label="Состояние">
                  <strong>
                    {conflict
                      ? 'Конфликт назначений'
                      : locked
                        ? 'Смена начата'
                        : optimisticAssignment
                          ? 'Назначено'
                          : assignment
                            ? 'Запланировано'
                            : 'Не назначено'}
                  </strong>
                  <small>
                    {conflict
                      ? 'обновите назначения перед продолжением'
                      : locked
                        ? pendingMachineChange
                          ? `${pendingMachineChange.fromPost.code} → ${pendingMachineChange.toPost.code}`
                          : 'используйте специальную смену станка'
                        : optimisticAssignment
                          ? 'ожидаем обновление данных'
                          : planned
                            ? 'можно изменить до начала'
                            : 'после назначения оператор сможет начать смену'}
                  </small>
                </span>
                <span
                  role="cell"
                  data-label="Действие"
                  className="production-machine-planning-actions"
                >
                  {!locked && !conflict ? (
                    <>
                      <button
                        type="button"
                        className="action-recommended"
                        disabled={
                          busy ||
                          pending ||
                          postId === baselinePostId ||
                          (!postId && (!assignment || assignment.status !== 'planned'))
                        }
                        onClick={() =>
                          void (!postId && assignment
                            ? removeOperatorPost(operator.id, assignment)
                            : assignOperatorPost(operator.id, postId, assignment))
                        }
                      >
                        {pending
                          ? assignment
                            ? postId
                              ? 'Переназначаем…'
                              : 'Снимаем…'
                            : 'Назначаем…'
                          : assignment
                            ? postId
                              ? 'Переназначить'
                              : 'Снять станок'
                            : 'Назначить'}
                      </button>
                      {planned && assignment && onCancelAssignment && (
                        <button
                          type="button"
                          className="action-destructive"
                          disabled={busy || pending}
                          onClick={() =>
                            setCancellationTarget({
                              kind: 'assignment',
                              shiftId: assignment.shiftId,
                              assignmentId: assignment.id,
                              detail: `${operator.displayName} · ${
                                assignment.post?.name ??
                                postById.get(assignment.postId)?.name ??
                                assignment.postId
                              }`,
                            })
                          }
                        >
                          Отменить назначение
                        </button>
                      )}
                    </>
                  ) : assignment ? (
                    <div className="production-machine-change-actions">
                      {pendingMachineChange ? (
                        onCancelMachineChange && (
                          <button
                            type="button"
                            className="action-destructive"
                            disabled={busy}
                            onClick={() =>
                              setCancellationTarget({
                                kind: 'machine_change',
                                changeId: pendingMachineChange.id,
                                detail: `${operator.displayName} · ${pendingMachineChange.fromPost.code} → ${pendingMachineChange.toPost.code}`,
                              })
                            }
                          >
                            Отменить смену станка
                          </button>
                        )
                      ) : (
                        <button
                          type="button"
                          className="action-recommended"
                          disabled={busy || !onIntentionalMachineChange}
                          onClick={() => {
                            setMachineChangeAssignmentId(assignment.id);
                            setMachineChangePostId('');
                            setMachineChangeReason('');
                          }}
                        >
                          Смена станка
                        </button>
                      )}
                      <details>
                        <summary>Станок сломан</summary>
                        <div className="production-breakdown-reassign">
                          <select
                            aria-label={`Новый станок после поломки для ${operator.displayName}`}
                            value={replacementPostId}
                            disabled={busy}
                            onChange={(event) =>
                              setBreakdownPostByAssignment((current) => ({
                                ...current,
                                [assignment.id]: event.target.value,
                              }))
                            }
                          >
                            <option value="">Резервный станок</option>
                            {replacementPosts.map((post) => (
                              <option key={post.id} value={post.id}>
                                {post.name} · {post.code}
                              </option>
                            ))}
                          </select>
                          <input
                            aria-label={`Причина поломки для ${operator.displayName}`}
                            placeholder="Причина поломки"
                            value={reason}
                            onChange={(event) =>
                              setBreakdownReasonByAssignment((current) => ({
                                ...current,
                                [assignment.id]: event.target.value,
                              }))
                            }
                          />
                          <button
                            type="button"
                            className="action-peer"
                            disabled={busy || !replacementPostId || !reason.trim()}
                            onClick={() =>
                              onBreakdownReassign(assignment.id, replacementPostId, reason.trim())
                            }
                          >
                            Сменить по поломке
                          </button>
                        </div>
                      </details>
                    </div>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {machineChangeAssignment && (
        <section
          ref={machineChangeDialogRef}
          className="production-machine-change-dialog severity-warning"
          role="dialog"
          aria-modal="false"
          aria-label="Преднамеренная смена станка"
          tabIndex={-1}
        >
          <header>
            <div>
              <span className="eyebrow">Действующая смена</span>
              <h3>Смена станка</h3>
            </div>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => setMachineChangeAssignmentId(null)}
            >
              Закрыть
            </button>
          </header>
          <p>
            История смены и очередь сохранятся. Оператор сначала завершит вес всех открытых Big-Bag,
            затем продолжит работу на новом посту.
          </p>
          <p className="production-machine-change-current">
            Текущий станок:{' '}
            {machineChangeAssignment.post?.name ??
              postById.get(machineChangeAssignment.postId)?.name ??
              machineChangeAssignment.postId}{' '}
            ·{' '}
            {machineChangeAssignment.post?.code ??
              postById.get(machineChangeAssignment.postId)?.code ??
              machineChangeAssignment.postId}
          </p>
          <div className="production-machine-change-form">
            <label>
              <span>Новый станок / пост</span>
              <select
                aria-label="Новый станок / пост"
                value={machineChangePostId}
                disabled={busy}
                onChange={(event) => setMachineChangePostId(event.target.value)}
              >
                <option value="">Выберите пост</option>
                {availableReplacementPosts(machineChangeAssignment).map((post) => (
                  <option key={post.id} value={post.id}>
                    {post.name} · {post.code}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Причина</span>
              <input
                aria-label="Причина смены станка"
                value={machineChangeReason}
                disabled={busy}
                placeholder="Почему оператор переходит на другой станок"
                onChange={(event) => setMachineChangeReason(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="action-recommended"
              disabled={busy || !machineChangeTargetEligible || !machineChangeReason.trim()}
              onClick={() => void submitIntentionalMachineChange()}
            >
              Подтвердить смену станка
            </button>
          </div>
        </section>
      )}

      {cancellationTarget && (
        <ProductionActionCancellationDialog
          title={
            cancellationTarget.kind === 'assignment'
              ? 'Отменить назначение'
              : 'Отменить смену станка'
          }
          detail={cancellationTarget.detail}
          busy={busy}
          onClose={() => setCancellationTarget(null)}
          onConfirm={cancelSelectedAction}
        />
      )}

      {onReportBreakdown && (
        <div className="production-machine-park" aria-label="Парк станков и их состояние">
          <h3>
            <SiemensIcon name="network-device" size="24" /> Парк станков
          </h3>
          <div className="production-machine-planning-table" role="table">
            <div className="production-machine-planning-row is-head" role="row">
              <span role="columnheader">Станок</span>
              <span role="columnheader">Состояние</span>
              <span role="columnheader">Поломка</span>
              <span role="columnheader">Ремонт</span>
            </div>
            {posts.map((post) => {
              const reason = breakdownReasonByPost[post.id] ?? '';
              return (
                <div
                  key={post.id}
                  className={`production-machine-planning-row post-status-${post.status}`}
                  role="row"
                >
                  <span role="cell" data-label="Станок">
                    <strong>{post.name}</strong>
                    <small>{post.code}</small>
                  </span>
                  <span role="cell" data-label="Состояние">
                    <strong className={`machine-status-badge is-${post.status}`}>
                      {POST_STATUS_LABEL[post.status] ?? post.status}
                    </strong>
                    <small>
                      {post.status === 'broken'
                        ? 'назначения запрещены до ремонта'
                        : post.status === 'maintenance'
                          ? 'ремонт идет'
                          : post.status === 'active'
                            ? 'доступен для назначения'
                            : 'вне эксплуатации'}
                    </small>
                  </span>
                  <span role="cell" data-label="Поломка">
                    {post.status === 'active' ? (
                      <span className="production-breakdown-reassign">
                        <input
                          aria-label={`Причина поломки станка ${post.name}`}
                          placeholder="Причина поломки"
                          value={reason}
                          disabled={busy}
                          onChange={(event) =>
                            setBreakdownReasonByPost((current) => ({
                              ...current,
                              [post.id]: event.target.value,
                            }))
                          }
                        />
                        <button
                          type="button"
                          className="action-destructive"
                          disabled={busy || !reason.trim()}
                          onClick={() => {
                            onReportBreakdown(post.id, reason.trim());
                            setBreakdownReasonByPost((current) => ({ ...current, [post.id]: '' }));
                          }}
                        >
                          Сломался
                        </button>
                      </span>
                    ) : (
                      <small>—</small>
                    )}
                  </span>
                  <span
                    role="cell"
                    data-label="Ремонт"
                    className="production-machine-planning-actions"
                  >
                    {post.status === 'broken' && onStartRepair && (
                      <button
                        type="button"
                        className="action-peer"
                        disabled={busy}
                        onClick={() => onStartRepair(post.id)}
                      >
                        В ремонт
                      </button>
                    )}
                    {(post.status === 'broken' || post.status === 'maintenance') &&
                      onCompleteRepair && (
                        <button
                          type="button"
                          className="action-recommended"
                          disabled={busy}
                          onClick={() => onCompleteRepair(post.id)}
                        >
                          Отремонтирован
                        </button>
                      )}
                    {post.status === 'active' && <small>исправен</small>}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
