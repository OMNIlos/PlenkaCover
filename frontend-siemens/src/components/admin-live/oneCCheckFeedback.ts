import type { OneCHealth } from '../../api/admin';

export type OneCCheckFeedback = {
  kind: 'notice' | 'error';
  message: string;
};

export function oneCCheckFeedback(result: OneCHealth): OneCCheckFeedback {
  if (result.mode !== 'http') {
    return {
      kind: 'error',
      message: 'Проверка вернула mock-адаптер; live-обмен с 1С не подтверждён.',
    };
  }
  if (result.status !== 'ready') {
    return {
      kind: 'error',
      message: result.message ?? `Демо-1С недоступна: статус ${result.status}.`,
    };
  }
  return { kind: 'notice', message: 'Демо-1С доступна: HTTP-проверка прошла.' };
}
