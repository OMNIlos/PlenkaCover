# Protected Legacy Windows Bench Package

> Этот пакет сохранён только для legacy Windows bench. Утверждённое production-развёртывание —
> Ubuntu-пост Variant B из
> [архитектуры интеграции устройств](./Архитектура-интеграции-устройств.md). Windows-проверка не
> заменяет физический S1 gate на TG-TPC-150A5 с МАССА-К; он пока **PENDING**.

Цель: отдать заказчику локальное demo, которое запускает backend, Postgres,
gateway-agent и, если приложен собранный frontend, сайт на Windows, но не содержит
TypeScript-исходники проекта.

Это не абсолютная криптографическая защита: любой локально исполняемый JS можно
реверсить при достаточной мотивации. Практическая модель защиты здесь такая:
исходники не поставляются, source maps/types удаляются, runtime JS обфусцирован,
секреты остаются в `.env`, а клиент получает только demo-артефакт.

## Что уже есть в проекте

- NestJS API (`apps/api`) с real login/session, capability guard, Prisma/Postgres.
- Legacy Windows gateway-agent (`apps/gateway-agent`) для Variant B: пост сам ходит в API,
  читает МАССА-К по USB virtual COM/Protocol 100, печатает на TLP4 через TCP 9100 или
  Windows command.
- Seed создаёт `POST-1..POST-5`, demo-заказ `A-1024`, users по ролям и dev-токен
  агента `agent-post-1`.
- Unit build/test baseline перед этой веткой: `npm run build` и `npm test` зелёные.

## Сборка защищённого пакета

Из корня backend-репозитория:

```bash
npm run protected:demo
```

Результат появится в:

```text
release/protected-demo/
```

В пакет попадает:

- `apps/api/dist` и `apps/gateway-agent/dist` после obfuscation;
- `apps/api/prisma/schema.prisma`, migrations и compiled `seed.js`;
- `packages/contracts/dist` без `src`;
- минимальный `package.json` для установки runtime dependencies;
- `docker-compose.yml`;
- Windows scripts: `scripts/install.ps1`, `scripts/start-demo.ps1`, `scripts/stop-demo.ps1`;
- `frontend/`, если перед сборкой уже существует `Plenki/frontend-siemens/dist`.

В пакет не попадает:

- `apps/**/src`, `packages/**/src`;
- тесты, docs разработки, superpowers plans/specs;
- `.env`, реальные токены, nested frontend sources.

Если нужен свежий frontend, собери его в nested repo отдельно, не коммитя туда изменения:

```bash
cd Plenki/frontend-siemens
npm run build
cd ../..
npm run protected:demo
```

Для передачи заказчику заархивируй папку `release/protected-demo`.

## Запуск legacy bench у заказчика на Windows

Предварительно поставить:

- Node.js 20 LTS;
- Docker Desktop;
- драйвер USB-COM адаптера весов, если Windows не видит COM-порт;
- драйвер/настройку принтера, если печать идёт через Windows spooler.

В PowerShell из распакованного пакета:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

Скрипт:

- создаст `.env` и `apps\gateway-agent\.env` из examples, если их нет;
- выполнит `npm ci --omit=dev` по lock-файлу внутри protected-пакета;
- поднимет Postgres через Docker;
- выполнит Prisma generate/migrate/seed.

Для диагностического Windows bench открыть `apps\gateway-agent\.env` и выставить:

```env
SCALE_MODE=massa-k-protocol-100
SCALE_SERIAL_PORT=COM3
SCALE_SERIAL_BAUD=57600
SCALE_READ_TIMEOUT_MS=1500

PRINTER_MODE=tcp9100
PRINTER_TCP_HOST=192.168.1.50
```

USB virtual COM не требует настройки режима терминала. Для резервного прямого RS-232
выбрать в терминале режим `1C`, скорость `57600` и формат `8-N-1`.

Для demo без железа оставить:

```env
SCALE_MODE=simulated
PRINTER_MODE=simulated
```

Запуск:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-demo.ps1
```

Открыть:

- API: `http://localhost:3000/api`
- Swagger: `http://localhost:3000/api/docs`
- Frontend, если он включён в пакет: `http://localhost:5173`

Legacy smoke после запуска demo:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\test-hardware.ps1
```

Что проверяется этим Windows smoke:

- `http://localhost:3000/api/health`;
- prebuilt `apps\gateway-agent\dist\probe-scale.js`: физический Protocol 100 `ready+stable`
  с безопасной allowlisted-проекцией и кодом завершения `0`;
- доступность принтера по TCP 9100 или наличие `windows-command`.

Protected package уже содержит prebuilt `apps\gateway-agent\dist\probe-scale.js`; TypeScript
sources и build toolchain намеренно не поставляются, поэтому пересборка на Windows bench не нужна.
`test-hardware.ps1` запускает этот CLI с рабочей папкой `apps\gateway-agent`, поэтому он читает
agent `.env`; проверки только существования COM-порта недостаточно.
Из корня распакованного package запустить безопасную JSON-проекцию так, чтобы agent прочитал свой
`apps\gateway-agent\.env`:

```powershell
Push-Location apps\gateway-agent
try {
  node .\dist\probe-scale.js
} finally {
  Pop-Location
}
```

Прямой вызов prebuilt Node CLI не добавляет npm lifecycle headers: stdout остаётся одной JSON-строкой.
Этот результат остаётся Windows bench diagnostic и не является физическим S1 evidence. Коды CLI:
`0` — только авторитетный physical Protocol 100 `ready+stable`; `2` — simulated, offline, unstable
или иной неавторитетный результат; `1` — ошибка config/probe/cleanup.

Для тестовой печати этикетки:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\test-hardware.ps1 -PrintTest
```

Seed users: `operator`, `warehouse`, `commercial`, `production`, `finance`,
`director`, `admin`; пароль по умолчанию `plenka-dev` или значение `SEED_PASSWORD`.

Остановка:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\stop-demo.ps1
```

Остановка вместе с Postgres:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\stop-demo.ps1 -StopDatabase
```

## Физические устройства

Весы:

- МАССА-К ТВ-М-300.2-A(RUEW)3 подключить как USB virtual COM;
- найти порт в Device Manager: `Ports (COM & LPT)` → `COM3` только как Windows-пример;
- для USB terminal setup не требуется; для прямого RS-232 использовать режим терминала `1C`,
  скорость `57600`, формат `8-N-1`;
- использовать `SCALE_MODE=massa-k-protocol-100`: driver проверяет header/Len/CRC и `Stable=1`;
- `serial` — legacy generic ASCII test adapter, он никогда не является physical evidence mode
  для этих весов;
- утверждённые identity/zero/load/moving/unplug команды выполняются только на Ubuntu по
  [hardware guide](./hardware-integration-guide.md), с `/dev/serial/by-id/...`.

Принтер:

- предпочтительно `PRINTER_MODE=tcp9100` и `PRINTER_TCP_HOST=<IP>`;
- для USB/Windows spooler использовать `PRINTER_MODE=windows-command` и команду с
  `{file}`, например `print /D:"\\localhost\TLP4" {file}`.

Сканер:

- agent его не обслуживает; SG-110-BT работает как HID keyboard wedge;
- курсор должен стоять в поле сайта, сканер "печатает" QR-текст.

## Безопасность поставки

- Не отправлять заказчику этот git-репозиторий.
- Отправлять только zip из `release/protected-demo`.
- Перед реальным пилотом заменить `GATEWAY_AGENT_TOKEN` и записать SHA-256 hash в
  `posts.agentTokenHash`; dev-токен `agent-post-1` годится только для demo.
- Не класть `.env` в архив, если там уже реальные токены.
- Не переносить в Git raw frame, serial/scale ID, production token, коммерческие изображения или
  документы. Даже безопасный `scaleId` из probe редактируется до передачи evidence из
  контролируемого локального output.
- Для сильной защиты бизнес-логики лучше держать API на своём сервере, а заказчику
  отдавать только gateway-agent. Полностью локальная поставка всегда слабее.
