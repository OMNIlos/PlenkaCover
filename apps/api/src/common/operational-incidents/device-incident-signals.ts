import type { IncidentSignal } from '@plenka/contracts';

export type PhysicalDeviceKind = 'scale' | 'scanner' | 'printer';

const DEVICE_LABELS: Record<PhysicalDeviceKind, string> = {
  scale: 'Весы',
  scanner: 'Сканер',
  printer: 'Принтер',
};

export function safeDeviceKind(kind: string): PhysicalDeviceKind | 'device' {
  return kind === 'scale' || kind === 'scanner' || kind === 'printer' ? kind : 'device';
}

export function bindingIncidentFingerprint(postId: string, kind: PhysicalDeviceKind): string {
  return `post:${postId}:binding:${kind}`;
}

export function deviceConnectionFingerprint(deviceId: string): string {
  return `device:${deviceId}:connection`;
}

export function postLivenessFingerprint(postId: string): string {
  return `gateway:post:${postId}:liveness`;
}

export function postCompatibilityFingerprint(postId: string): string {
  return `gateway:post:${postId}:compatibility`;
}

export function postCapabilitiesFingerprint(postId: string): string {
  return `gateway:post:${postId}:capabilities`;
}

export function gatewayCommandFingerprint(postId: string, failureClass: string): string {
  return `gateway:post:${postId}:command:${failureClass}`;
}

export function bindingIncident(postId: string, kind: PhysicalDeviceKind): IncidentSignal {
  return {
    fingerprint: bindingIncidentFingerprint(postId, kind),
    scope: 'post',
    targetType: `${kind}_binding`,
    targetId: postId,
    severity: 'warning',
    title: `${DEVICE_LABELS[kind]} поста не настроены`,
    message: 'Пост не имеет одной готовой привязки требуемого устройства.',
    recovery: 'Проверить привязку и готовность устройства на этом посту.',
  };
}

export function deviceConnectionIncident(deviceId: string, kind: string): IncidentSignal {
  const safeKind = safeDeviceKind(kind);
  return {
    fingerprint: deviceConnectionFingerprint(deviceId),
    scope: 'device',
    targetType: safeKind,
    targetId: deviceId,
    severity: 'warning',
    title:
      safeKind === 'device' ? 'Устройство недоступно' : `${DEVICE_LABELS[safeKind]} недоступны`,
    message: 'Устройство не подтвердило готовность к физической операции.',
    recovery: 'Проверить питание, подключение и локальный gateway.',
  };
}

export function postLivenessIncident(postId: string): IncidentSignal {
  return {
    fingerprint: postLivenessFingerprint(postId),
    scope: 'post',
    targetType: 'liveness',
    targetId: postId,
    severity: 'warning',
    title: 'Gateway поста не отвечает',
    message: 'Пост не передал свежий heartbeat.',
    recovery: 'Проверить питание промышленного компьютера, сеть и gateway-agent.',
  };
}

export function postCompatibilityIncident(postId: string): IncidentSignal {
  return {
    fingerprint: postCompatibilityFingerprint(postId),
    scope: 'post',
    targetType: 'gateway_compatibility',
    targetId: postId,
    severity: 'warning',
    title: 'Gateway поста несовместим',
    message: 'Версия gateway-agent не соответствует протоколу платформы.',
    recovery: 'Установить совместимый подписанный пакет gateway-agent и проверить heartbeat.',
  };
}

export function postCapabilitiesIncident(postId: string): IncidentSignal {
  return {
    fingerprint: postCapabilitiesFingerprint(postId),
    scope: 'post',
    targetType: 'gateway_capabilities',
    targetId: postId,
    severity: 'warning',
    title: 'Gateway поста поддерживает не все операции',
    message: 'Агент не подтвердил полный набор функций физических устройств.',
    recovery: 'Проверить состав пакета, драйверы и повторно выполнить ввод поста в эксплуатацию.',
  };
}

export function gatewayCommandIncident(postId: string, failureClass: string): IncidentSignal {
  return {
    fingerprint: gatewayCommandFingerprint(postId, failureClass),
    scope: 'post',
    targetType: 'gateway_command',
    targetId: postId,
    severity: 'warning',
    title: 'Команда gateway не завершена',
    message: 'Физическая команда требует проверки результата.',
    recovery: 'Проверить состояние поста и выполнить безопасное восстановление команды.',
  };
}
