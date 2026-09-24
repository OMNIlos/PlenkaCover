import type { DeviceMockContract } from './types';

export const scaleMock: DeviceMockContract = {
  id: 'SCALE-A-01',
  kind: 'scale',
  label: 'Весы линии A-01',
  workplaceId: 'Линия A-01',
  connectionKind: 'USB',
  status: 'ready',
  statusLabel: 'Готово',
  testActionLabel: 'Проверить стабильность',
  ownerRole: 'Админ',
  lastSeenAt: '12:22',
  rawPayload: 'device_id=SCALE-A-01;status=ready;stable=1;kg=41.2',
  parsedPayload: 'Стабильный ответ',
  recovery: 'Проверить подключение весов и рабочее место',
};

export const offlineScaleMock: DeviceMockContract = {
  id: 'SCALE-E-04',
  kind: 'scale',
  label: 'Весы линии E-04',
  workplaceId: 'Линия E-04',
  connectionKind: 'Ethernet',
  status: 'offline',
  statusLabel: 'Офлайн',
  testActionLabel: 'Проверить связь',
  ownerRole: 'Админ',
  lastSeenAt: '11:48',
  rawPayload: 'device_id=E-04;last_signal=empty',
  parsedPayload: 'Нет ответа',
  recovery: 'Проверить питание, кабель/USB или Ethernet; передать админу смены до повторного взвешивания',
};

export const scannerMock: DeviceMockContract = {
  id: 'SCANNER-S-01',
  kind: 'scanner',
  label: 'Сканер склада S-01',
  workplaceId: 'Склад приемки',
  connectionKind: 'Клавиатурный ввод',
  status: 'unstable',
  severity: 'critical',
  statusLabel: 'Требует настройки',
  testActionLabel: 'Проверить привязку',
  ownerRole: 'Админ',
  lastSeenAt: '12:05',
  rawPayload: 'device_id=S-01;binding=empty',
  parsedPayload: 'Ответ есть, привязки нет',
  recovery: 'Назначить устройство складскому рабочему месту или передать владельцу склада',
};

export const printerMock: DeviceMockContract = {
  id: 'PRINTER-P-03',
  kind: 'printer',
  label: 'Принтер этикеток P-03',
  workplaceId: 'Операторская этикетка',
  connectionKind: 'Очередь печати',
  status: 'error',
  severity: 'warning',
  statusLabel: 'Тест не пройден',
  testActionLabel: 'Проверить очередь печати',
  ownerRole: 'Админ',
  lastSeenAt: '12:18',
  rawPayload: 'device_id=P-03;last_test=failed',
  parsedPayload: 'Тест не пройден',
  recovery: 'Проверить очередь печати и бумагу',
  secondaryActions: [{ id: 'admin-forward-owner', label: 'Передать владельцу', level: 'secondary' }],
};

export const paymentSourceMock: DeviceMockContract = {
  id: '1c-payment-status',
  kind: 'financeSource',
  label: 'Учётный источник: оплаты',
  workplaceId: 'Финансовый контур',
  connectionKind: 'Снимок',
  sourceSystem: 'Учётный источник: оплаты',
  status: 'ready',
  statusLabel: 'Учётный источник отвечает',
  testActionLabel: 'Повторить проверку учётного источника',
  ownerRole: 'Бухгалтерия',
  lastSeenAt: '12:24',
  rawPayload: 'source_id=1c-payment-status;health=ok',
  parsedPayload: 'Учётные оплаты читаются',
  recovery: 'Повторить проверку источника или создать проблему',
};

export const financeSourceMock: DeviceMockContract = {
  id: '1c-invoice-status',
  kind: 'financeSource',
  label: 'Учётный источник: счета',
  workplaceId: 'Финансовый контур',
  connectionKind: 'Снимок',
  sourceSystem: 'Учётный источник: счета',
  status: 'unstable',
  severity: 'warning',
  statusLabel: 'Учётный счет требует проверки',
  testActionLabel: 'Повторить проверку учётного источника',
  ownerRole: 'Бухгалтерия',
  lastSeenAt: '12:24',
  rawPayload: 'source_id=1c-invoice-status;health=manual_check',
  parsedPayload: 'Учётный счет требует проверки',
  recovery: 'Повторить проверку источника и передать результат бухгалтерии',
  secondaryActions: [{ id: 'admin-forward-finance-source', label: 'Передать бухгалтерии', level: 'secondary' }],
};

export const runtimeDeviceMocks = [scaleMock, offlineScaleMock, scannerMock, printerMock, paymentSourceMock, financeSourceMock];
