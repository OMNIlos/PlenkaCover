import type { WorkObject } from '../types';
import { materialCostReferences } from '../inventoryContracts';
import { zn2606014RollGroups } from './rollGroups';

export const directorWorkObjects: WorkObject[] = [
    {
      id: 'DIR-2606-004',
      kind: 'directorDecision',
      title: 'Плановое решение DIR-2606-004',
      statusLabel: 'Плановое подтверждение',
      nextOwner: 'Директор',
      severity: 'info',
      filterTags: ['Требуют решения', 'Производство'],
      facts: [
        { label: 'Номер', value: 'ЗН-2606-015' },
        { label: 'Компания', value: 'СеверПласт', scope: 'legal' },
        { label: 'Состояние', value: 'Плановое подтверждение' },
        { label: 'Риск', value: 'Нет' },
      ],
      sections: [
        {
          id: 'planned-decision-flow',
          title: 'Нормальный сценарий',
          facts: [
            { label: 'Что решить', value: 'Подтвердить плановый переход в производство' },
            { label: 'Рецептура', value: 'По активному шаблону v2.8', scope: 'recipeAnalytics' },
            { label: 'Стоимость', value: 'Без изменения', scope: 'sensitiveFinance' },
            { label: 'Склад', value: 'Действий не требуется' },
            { label: 'Действие', value: 'Подтвердить и вернуть зав. производства' },
          ],
        },
      ],
      actions: [
        { id: 'approve-planned', label: 'Подтвердить', level: 'peer', enabled: true },
        { id: 'return-planned', label: 'Вернуть', level: 'peer', enabled: true },
        { id: 'assign-planned', label: 'Назначить ответственного', level: 'secondary', enabled: true },
      ],
      problems: [],
      audit: [
        { id: 'a-director-planned-created', objectId: 'DIR-2606-004', time: '10:12', actorLabel: 'Зав. производства', actionLabel: 'Решение создано', detail: 'Плановое подтверждение создано без проблем и финансовых отклонений.' },
      ],
    },
    {
      id: 'DIR-2606-006',
      kind: 'directorDecision',
      title: 'Решение DIR-2606-006',
      statusLabel: 'Рецепт / стоимость',
      nextOwner: 'Директор',
      severity: 'warning',
      facts: [
        { label: 'Номер', value: 'ЗН-2606-014' },
        { label: 'Заказчик', value: 'УралПак', scope: 'legal' },
        { label: 'Влияние на стоимость', value: 'source-aware: цена сырья/добавки × рецептура', scope: 'sensitiveFinance' },
        { label: 'Причина', value: 'Замена сырья', scope: 'recipeAnalytics' },
      ],
      sections: [
        {
          id: 'evidence',
          title: 'Что изменилось',
          facts: [
            { label: 'Было', value: 'М1 по шаблону', scope: 'recipeAnalytics' },
            { label: 'Стало', value: 'М2 для оставшегося рулона', scope: 'recipeAnalytics' },
            { label: 'Группа', value: 'Группа 2 · R-A17-03', scope: 'recipeAnalytics' },
            { label: 'Применение', value: 'с рулона 3, выпущенные рулоны не меняются', scope: 'recipeAnalytics' },
            { label: 'План', value: '1 рулон · 36.8 кг · втулка 102 мм', scope: 'recipeAnalytics' },
            { label: 'Деньги', value: 'рублевый эффект считается из состава рецептуры и price reference по каждой строке', scope: 'sensitiveFinance' },
            { label: 'Учетная цена', value: 'ПВД 15803-020: 147,50 ₽/кг · учётный снимок; ПВД 10803-020: 151,00 ₽/кг · ручное утверждение; добавка: 186,00 ₽/кг', scope: 'sensitiveFinance' },
            { label: 'Комментарий', value: 'М1 не хватает на весь заказ' },
          ],
        },
      ],
      rollGroups: zn2606014RollGroups,
      materialCostReferences,
      actions: [
        { id: 'approve', label: 'Подтвердить', level: 'peer', enabled: true },
        { id: 'return', label: 'Вернуть', level: 'peer', enabled: true },
        { id: 'assign', label: 'Назначить ответственного', level: 'secondary', enabled: true },
        {
          id: 'director-queue-reorder-global',
          label: 'Изменить порядок очереди...',
          level: 'secondary',
          enabled: true,
          helpText: 'Директор может менять общую производственную очередь до начала или закрытия работ по заказу. Изменение сохраняется в истории действий.',
        },
      ],
      problems: [],
      audit: [
        { id: 'a-director-queue-reorder', objectId: 'DIR-2606-006', time: '10:48', actorLabel: 'Директор', actionLabel: 'Порядок очереди изменен', detail: 'Директор поднял строку в общей очереди до начала работ по заказу.' },
        { id: 'a-director-created', objectId: 'DIR-2606-006', time: '10:45', actorLabel: 'Зав. производства', actionLabel: 'Решение создано', detail: 'Передана причина замены сырья.' },
      ],
    },
    {
      id: 'DIR-2606-009',
      kind: 'directorDecision',
      title: 'Проблема склада DIR-2606-009',
      statusLabel: 'Склад',
      nextOwner: 'Директор',
      severity: 'critical',
      facts: [
        { label: 'Номер', value: 'WH-2606-044' },
        { label: 'Что решить', value: 'Частичная приемка' },
        { label: 'Риск', value: 'Не хватает 1 рулона' },
      ],
      sections: [
        {
          id: 'warehouse-evidence',
          title: 'Что показал склад',
          facts: [
            { label: 'Ожидалось', value: '3' },
            { label: 'Принято', value: '2' },
            { label: 'Не хватает', value: 'R-A17-03' },
          ],
        },
      ],
      actions: [
        { id: 'approve-exception', label: 'Подтвердить', level: 'peer', enabled: true },
        { id: 'return-warehouse', label: 'Вернуть на склад', level: 'peer', enabled: true },
        { id: 'open-scans', label: 'Открыть складской контекст', level: 'secondary', enabled: true },
      ],
      problems: [
        {
          id: 'p-director-warehouse',
          objectId: 'DIR-2606-009',
          stage: 'Приемка',
          title: 'Частичная приемка',
          severity: 'critical',
          ownerRole: 'Директор',
          due: 'сегодня',
          reason: 'Закрытие приемки требует решения по недостающему рулону.',
          recovery: 'Подтвердить частичную приемку или вернуть на склад',
          status: 'open',
        },
      ],
      audit: [
        { id: 'a-director-warehouse', objectId: 'DIR-2606-009', time: '12:05', actorLabel: 'Склад', actionLabel: 'Проблема создана', detail: 'Счетчик приемки не совпал с ожиданием.' },
      ],
    },
  ];
