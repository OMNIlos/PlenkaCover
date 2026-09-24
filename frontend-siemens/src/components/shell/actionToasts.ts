import { setToastPosition, toast, type ShowToastResult, type ToastConfig } from '@siemens/ix';
import { defineCustomElement as defineIxToast } from '@siemens/ix/components/ix-toast.js';
import { defineCustomElement as defineIxToastContainer } from '@siemens/ix/components/ix-toast-container.js';

import type { Role } from '../../domain/types';

export type ActionToastTone = 'success' | 'info' | 'warning' | 'critical';

export type ActionToastInput = {
  tone: ActionToastTone;
  title: string;
  detail?: string;
  role?: Role;
  objectId?: string;
  actionId?: string;
};

type OperatorActionToastContext = {
  orderId?: string;
  rollId?: string;
};

const toastTypeByTone: Record<ActionToastTone, ToastConfig['type']> = {
  success: 'success',
  info: 'info',
  warning: 'warning',
  critical: 'error',
};

const MAX_VISIBLE_ACTION_TOASTS = 2;
const activeActionToasts: ShowToastResult[] = [];

function registerActionToast(handle: ShowToastResult) {
  activeActionToasts.push(handle);
  handle.onClose.once(() => {
    const index = activeActionToasts.indexOf(handle);
    if (index >= 0) activeActionToasts.splice(index, 1);
  });
  while (activeActionToasts.length > MAX_VISIBLE_ACTION_TOASTS) {
    activeActionToasts.shift()?.close();
  }
}

export function setupActionToastPosition() {
  defineIxToast();
  defineIxToastContainer();
  setToastPosition('top-right');
}

export function showActionToast(input: ActionToastInput) {
  const title = input.title.trim();
  const detail = input.detail?.trim();
  if (!title) return;

  void toast({
    title,
    message: detail || undefined,
    type: toastTypeByTone[input.tone],
    autoClose: true,
    autoCloseDelay: input.tone === 'warning' || input.tone === 'critical' ? 4400 : 3600,
  })
    .then(registerActionToast)
    .catch(() => undefined);
}

export function operatorActionToast(actionId: string, context: OperatorActionToastContext = {}) {
  const rollLabel = context.rollId ?? 'текущий рулон';
  if (actionId.startsWith('operator-start-bigbag:')) {
    return {
      tone: 'success' as const,
      title: 'Смена открыта',
      detail: 'Стартовый вес Big-bag записан.',
    };
  }
  if (actionId.startsWith('operator-end-bigbag:')) {
    return {
      tone: 'success' as const,
      title: 'Финальный вес записан',
      detail: 'Big-bag готов к закрытию смены.',
    };
  }

  const map: Record<string, { tone: ActionToastTone; title: string; detail?: string }> = {
    'operator-close-shift-request': {
      tone: 'warning',
      title: 'Сдача смены начата',
      detail: 'Зафиксируйте финальный вес Big-bag.',
    },
    'operator-close-shift': {
      tone: 'success',
      title: 'Смена закрыта',
      detail: 'Расход смены рассчитан.',
    },
    'operator-accept-order': {
      tone: 'success',
      title: 'Заказ принят',
      detail: context.orderId ? `${context.orderId}: открыт шаг шпули.` : 'Открыт шаг шпули.',
    },
    'operator-activate-spool-scale': {
      tone: 'info',
      title: 'Сигнал весов готов',
      detail: `${rollLabel}: можно фиксировать шпулю.`,
    },
    'operator-spool-weight': {
      tone: 'success',
      title: 'Вес шпули записан',
      detail: `${rollLabel}: вес получен с весов.`,
    },
    'operator-activate-scale': {
      tone: 'info',
      title: 'Сигнал весов готов',
      detail: `${rollLabel}: ожидается факт веса.`,
    },
    'operator-roll-weight': {
      tone: 'success',
      title: 'Вес рулона записан',
      detail: `${rollLabel}: можно печатать QR.`,
    },
    'operator-print-qr': {
      tone: 'info',
      title: 'Задание печати отправлено',
      detail: `${rollLabel}: физический выход подтвердите сканером.`,
    },
    'operator-verify-qr': {
      tone: 'success',
      title: 'QR проверен',
      detail: `${rollLabel}: рулон готов к передаче.`,
    },
    'operator-handover': {
      tone: 'success',
      title: 'Передано на склад',
      detail: `${rollLabel}: склад получил приемку.`,
    },
    'operator-defect': {
      tone: 'warning',
      title: 'Брак записан',
      detail: `${rollLabel}: зав. производства получил разбор.`,
    },
    'operator-reprint-label': {
      tone: 'warning',
      title: 'Переиздание этикетки записано',
      detail: `${rollLabel}: причина сохранена в истории.`,
    },
    'operator-defer-order': {
      tone: 'warning',
      title: 'Заказ отложен',
      detail: context.orderId ? `${context.orderId}: остаток сохранен.` : 'Остаток сохранен.',
    },
    'operator-resume-order': {
      tone: 'success',
      title: 'Заказ возобновлен',
      detail: context.orderId
        ? `${context.orderId}: продолжайте текущий шаг.`
        : 'Продолжайте текущий шаг.',
    },
  };
  return map[actionId];
}
