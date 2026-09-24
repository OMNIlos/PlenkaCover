# Legacy Windows bench: gateway-агент и устройства

Это руководство сохранено только для legacy Windows bench. Утверждённая production-цель —
Ubuntu-пост Variant B из
[архитектуры интеграции устройств](./Архитектура-интеграции-устройств.md); Windows не является
целевой ОС развёртывания и не даёт физическое S1 evidence.

Режим `serial` — legacy generic ASCII test adapter. Для МАССА-К ТВ-М-300.2-A(RUEW)3 он не
является физическим evidence mode; даже на Windows bench используется только
`massa-k-protocol-100`. Физические identity/zero/load/moving/unplug проверки выполняются на
TG-TPC-150A5 с Ubuntu и пока **PENDING**.

Покрывает два режима:

- **Часть A — Legacy local demo**: вся платформа (backend + frontend + БД) и шлюз
  запускаются локально на одном Windows-ноутбуке, устройства подключены к нему же.
  Ноутбук играет роль автономного поста `POST-1`.
- **Часть B — Legacy remote bench**: backend/frontend работают на сервере, шлюз — на
  Windows-ПК поста. Это проверка совместимости, а не утверждённое production-развёртывание.

---

## 0. Как это работает (прочитать перед запуском)

Принятая архитектура — **Variant B**: у каждого станка свой ПК (пост), устройства
подключены к нему локально, канал к платформе — **только исходящий** (пост сам
опрашивает сервер; на посту не открывается ни один входящий порт).

```
       Windows-ПК поста (POST-1)                        Сервер платформы
┌──────────────────────────────────┐            ┌─────────────────────────────┐
│  gateway-agent (Node.js CLI)     │            │  backend (NestJS, /api)     │
│   ├─ МАССА-К ── USB virtual COM  │──poll────▶ │   GET  /gateway/commands    │
│   ├─ принтер TLP4 ── LAN/USB     │──result──▶ │   POST /gateway/commands/:id/result
│   ├─ event buffer (jsonl)        │──ingest──▶ │   POST /gateway/ingest      │
│   └─ result outbox (jsonl)       │──result──▶ │   leased/idempotent result  │
│                                  │──heartbeat▶│   POST /gateway/heartbeat   │
└──────────────────────────────────┘            │            ▲                │
                                                │            │ адаптеры       │
  сканер SG-110-BT = HID-клавиатура             │  operator/warehouse services│
  (печатает QR-текст в поле браузера) ────────▶ │            ▲                │
                                                └────────────┼────────────────┘
                                                      сайт (frontend, :5173)
```

Поток данных по устройствам:

| Устройство    | Как данные попадают на сайт                                                                                                                                                                                                                                                                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Весы**      | Оператор жмёт «взвесить» на сайте → backend ставит команду `read_scale` → агент выполняет бинарный Protocol 100 запрос, проверяет frame/CRC/identity/stable → отвечает `{status, stable, grossKg}` → backend записывает вес в рулон → сайт перерисовывает карточку. Если агент/весы молчат дольше `GATEWAY_COMMAND_TIMEOUT_MS` — оператор получает **503**, ручной ввод запрещён (ТЗ §9).          |
| **Принтер**   | Оператор запускает печать → backend выдаёт `print` с lease → агент сохраняет результат в локальный outbox до HTTP-подтверждения. Чистая передача RAW 9100 = `submitted`, а не `printed`; только точный HID-скан фактической этикетки даёт physical verification. Ошибка до отправки данных = `failed`; неоднозначный исход после вызова = `delivery_unknown`, автоматическая перепечать запрещена. |
| **Сканер**    | Агент его **не обслуживает**. Это HID keyboard wedge: курсор стоит в поле формы, скан вводит фактический непрозрачный payload этикетки. UI не подставляет ожидаемое значение автоматически; проверку выполняет backend.                                                                                                                                                                            |
| **Raw-кадры** | Сырые кадры устройств агент шлёт отдельным каналом (`/gateway/ingest`) → `GatewayEvent.rawPayload`. Видны **только** в admin diagnostics (ТЗ §8), бизнес-ролям не отдаются.                                                                                                                                                                                                                        |

Аутентификация шлюза — машинная: заголовок `x-agent-token`, свой токен на каждый
пост (на сервере хранится только SHA-256 хэш в `Post.agentTokenHash`).

---

## 1. Устройства: подключение и настройка (общее для обоих режимов)

Что подключить к Windows-ПК:

- **Сканер SG-110-BT** — USB-донгл, режим HID (заводской). Драйверы не нужны.
- **Весы МАССА-К ТВ-М-300.2-A(RUEW)3** — USB virtual COM; для резервного прямого RS-232
  использовать режим терминала `1C`, скорость `57600`, формат `8-N-1`.
- **Принтер TLP4** — предпочтительно **Ethernet** (печать на RAW-порт `:9100`,
  драйвер не нужен) или USB с родным драйвером Windows.
- **USB/USB-C hub** — портов может не хватить (донгл + адаптер + принтер).
- HDMI для устройств не нужен.

### 1.1 Весы: найти COM-порт Windows bench и проверить Protocol 100

1. Подключите весы (или USB-COM адаптер), включите их.
2. `Win+X` → **Диспетчер устройств** → **Порты (COM и LPT)**.
3. Строка вида `USB-SERIAL CH340 (COM3)` → `COM3` — это значение `SCALE_SERIAL_PORT`.
   Порт не появился = не установлен драйвер адаптера.
4. Для USB virtual COM используется `SCALE_SERIAL_BAUD=57600` без изменения terminal setup;
   для резервного прямого RS-232 — режим терминала `1C`, скорость `57600`, формат `8-N-1`.
5. Соберите агент и запустите локальную диагностическую проекцию:
   `npm run build -w @plenka/gateway-agent`, затем
   `npm run --silent probe:scale -w @plenka/gateway-agent`.

Driver посылает `CMD_GET_MASSA`, проверяет header/Len/CRC и читает stable/net/zero/tare и цену
деления из `CMD_ACK_MASSA`. Windows-результат годится только для legacy bench diagnostics;
авторитетный физический S1 gate выполняется на Ubuntu по
[hardware guide](./hardware-integration-guide.md). Raw frame, serial/scale ID и токены не копируются в Git,
тикеты или скриншоты; безопасный `scaleId` редактируется до передачи evidence наружу.

### 1.2 Принтер MERTECH TLP4

Палетный лист печатается как **одна** этикетка 100 × 150 мм в фиксированном
профиле 203 dpi (800 × 1200 точек). Агент отправляет один бинарный TSPL-буфер с
одной командой `PRINT 1,1`; дубль из исходного Excel-примера не печатается.

Перед первым боевым запуском на самом принтере нужно выбрать материал 100 × 150 мм,
тип датчика (зазор или чёрная метка) и выполнить калибровку на реальном рулоне этикеток.

**Вариант 1 — Ethernet / RAW 9100 (рекомендуется).**
Дайте принтеру статический IP (через утилиту принтера или DHCP-резервирование).
Проверка: `Test-NetConnection <IP принтера> -Port 9100` в PowerShell → `TcpTestSucceeded: True`.
В `.env` агента: `PRINTER_MODE=tcp9100`, `PRINTER_TCP_HOST=<IP>`.

**Вариант 2 — USB через Windows spooler (`windows-command`).**
Честный путь, когда есть только USB: агент пишет этикетку (TSPL2) в файл и
вызывает вашу команду печати, подставляя путь вместо `{file}`.

1. Установите драйвер принтера, убедитесь что он печатает тестовую страницу.
2. Откройте принтеру общий доступ: Параметры → Принтеры → TLP4 → Управление →
   Свойства принтера → Доступ → «Общий доступ», имя например `TLP4`.
3. В `.env` агента:

   ```
   PRINTER_MODE=windows-command
   PRINTER_WINDOWS_COMMAND=cmd /c copy /b "{file}" "\\localhost\TLP4"
   ```

   Подойдёт и свой PowerShell-скрипт:
   `PRINTER_WINDOWS_COMMAND=powershell -ExecutionPolicy Bypass -File C:\plenka\print-label.ps1 -Path {file}`.
   Код возврата ≠ 0 = печать не удалась (и это правильно заблокирует этикетку).

### 1.3 Сканер: проверка в Notepad

1. Вставьте USB-донгл, откройте «Блокнот», кликните в окно.
2. Отсканируйте любой QR — в блокноте появится его текст и перевод строки.
3. Появился текст — сканер готов. На сайте он будет так же «печатать»
   непрозрачный `prt_<64 hex>` с реально напечатанной этикетки в активное поле формы. UI не знает
   и не подставляет ожидаемое значение; никакой настройки сканера в агенте не нужно.

---

## Часть A. Legacy local demo: всё на одном Windows-ноутбуке

Ноутбук = сервер платформы + пост `POST-1` одновременно.

### A.1 Предварительные требования

- **Node.js 20+** (LTS) — [nodejs.org](https://nodejs.org), при установке отметить «Add to PATH».
- **Docker Desktop** (для Postgres) — запустить и дождаться зелёного статуса.
- **Git**.
- Репозитории: backend `PlenkaCover` и внутри него `Plenki/` (отдельный репо с фронтом).

Проверка в PowerShell:

```powershell
node --version    # v20.x+
docker --version
```

### A.2 Установка и база данных

Из корня `PlenkaCover`:

```powershell
npm install          # ставит все workspace, включая agent (+ optional serialport)
npm run db:up        # Postgres в docker (порт 5433)
npm run db:generate
npm run db:deploy    # миграции (на чистой базе); либо npm run db:migrate
npm run db:seed
```

Seed создаёт: посты `POST-1..POST-5`; у `POST-1` устройства `dev-scale-1`,
`dev-printer-1`, `dev-scanner-1`; dev-токен агента `agent-post-1`; пользователей
по ролям (`operator`, `warehouse`, `admin`, …) с паролем `plenka-dev`
(меняется через `SEED_PASSWORD`); демо-заказ `A-1024` с рулонами, назначенными
на `POST-1`, и открытую операторскую сессию.

### A.3 Backend

Скопируйте `.env.example` → `.env` в корне и выставьте:

```
AUTH_DEV_XROLE=on
DEVICE_GATEWAY_SCALE=on          # весы через шлюз (не мок)
DEVICE_GATEWAY_PRINTER=on        # принтер через шлюз
GATEWAY_SIMULATOR=off            # off = команды пойдут РЕАЛЬНОМУ агенту
GATEWAY_COMMAND_TIMEOUT_MS=5000
```

Запуск (отдельное окно PowerShell):

```powershell
npm run dev          # NestJS на http://localhost:3000, Swagger: /api/docs
```

> Хотите сначала прогнать цикл вообще без агента — поставьте `GATEWAY_SIMULATOR=on`:
> in-process симулятор ответит за пост. Потом верните `off` и запустите агента —
> бизнес-логика не меняется, это тот же контракт.

### A.4 Gateway-агент

```powershell
cd apps\gateway-agent
copy .env.example .env
```

`.env` агента для локального демо с железом:

```
GATEWAY_API_URL=http://localhost:3000/api
GATEWAY_DEPLOYMENT_MODE=development
GATEWAY_AGENT_TOKEN=agent-post-1
GATEWAY_POST_CODE=POST-1
GATEWAY_SCALE_DEVICE_ID=dev-scale-1
GATEWAY_PRINTER_DEVICE_ID=dev-printer-1
GATEWAY_SCANNER_DEVICE_ID=dev-scanner-1

SCALE_MODE=massa-k-protocol-100
SCALE_SERIAL_PORT=COM3
SCALE_SERIAL_BAUD=57600
SCALE_READ_TIMEOUT_MS=1500

PRINTER_MODE=tcp9100             # или windows-command / simulated
PRINTER_TCP_HOST=192.0.2.10      # пример; замените на реальный IP принтера
PRINTER_DPI=203
PRINTER_MAX_WIDTH_DOTS=864
```

Нет под рукой железа — оставьте `GATEWAY_DEPLOYMENT_MODE=development` и поставьте
`SCALE_MODE=simulated`, `PRINTER_MODE=simulated`:
агент останется настоящим (HTTP, poll, буфер), устройства будут эмулироваться.
Simulated probe всегда неавторитетен и завершает CLI кодом `2`, а не `0`.
Статус `submitted` означает только подтверждённую транспортом передачу байтов. В S1 это ещё не
physical verification: `printed` не присваивается по TCP close, а строка переходит в `qr_check`
без раскрытия ожидаемого токена браузеру. Точный фактический HID-скан подтверждает этикетку;
визуальное качество и геометрия MERTECH TLP4 остаются физическим S4 gate.

Запуск (отдельное окно, из корня репо):

```powershell
npm run dev -w @plenka/gateway-agent
# compiled legacy bench: npm run build -w @plenka/gateway-agent && npm start -w @plenka/gateway-agent
```

Ожидаемый лог (JSON-строки):

```json
{"level":"info","msg":"gateway agent started","post":"POST-1","scaleMode":"massa-k-protocol-100","printerMode":"tcp9100",...}
{"level":"info","msg":"platform reachable","apiUrl":"http://localhost:3000/api"}
```

### A.5 Frontend (сайт)

Отдельное окно:

```powershell
cd Plenki\frontend-siemens
npm install
npm run dev          # Vite на http://localhost:5173, /api проксируется на :3000
```

Откройте `http://localhost:5173` — экран входа. Логин `operator`, пароль
`plenka-dev` (или значение `SEED_PASSWORD`).

### A.6 Проверить heartbeat (пост «на связи»)

- В логе агента каждые 5 с уходит heartbeat; после первого — на сервере audit
  `gateway:post_online`.
- Через API (в dev работает заголовок `x-role`):

  ```powershell
  curl.exe -s http://localhost:3000/api/admin/posts -H "x-role: admin"
  ```

  У `POST-1` должно быть `"online": true`, свежий `lastSeenAt`, устройства со
  статусами (`dev-scale-1: ready`, …).

### A.7 Полный цикл на сайте

Предусловие: seed-рулоны `A-1024-roll-*` уже назначены на `POST-1`, операторская
сессия открыта (тоже из seed; иначе оператор открывает пост на сайте после входа).

1. **Вес шпули.** Положите шпулю (или груз) на весы, дождитесь стабилизации.
   На сайте в контуре оператора у текущего рулона выполните действие взвешивания
   шпули. Вес на карточке должен совпасть с табло весов — это значение пришло
   по цепочке сайт → backend → агент → COM-порт.
2. **Вес рулона.** Груз потяжелее → действие «взвесить рулон». Платформа сама
   посчитает net = gross − шпуля и допуск ±5% от плана.
3. **Печать QR.** Действие «печать этикетки» → TLP4 печатает этикетку с QR
   с непрозрачным `prt_<64 hex>` и кодом рулона. После чистой отправки сайт показывает
   `submitted`, но ещё не `verified`.
4. **Проверка QR сканом.** Курсор в поле проверки этикетки на сайте → отсканируйте
   напечатанную этикетку. Верная → рулон проходит шаг `qr_check`. Чужая → **400**
   и audit `device.scan.mismatch`.
5. **Handover.** Действие передачи на склад → создаётся приёмочная задача склада.
6. **Приёмка на складе.** Войдите как `warehouse` / `plenka-dev` (другой браузер
   или вкладка-инкогнито). В задаче приёмки поставьте курсор в поле скана и
   отсканируйте этикетку → строка `accepted`; закройте задачу → рулон `received`.

Эквиваленты через API, если хочется проверить без UI:

```powershell
# токен оператора
$TOKEN = (curl.exe -s -X POST http://localhost:3000/api/auth/login -H "content-type: application/json" -d '{\"login\":\"operator\",\"password\":\"plenka-dev\"}' | ConvertFrom-Json).token
# сессия на POST-1 (если не открыта)
curl.exe -s -X POST http://localhost:3000/api/operator/post-sessions -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{\"postCode\":\"POST-1\"}'
# вес шпули / рулона / печать / verify сканом
curl.exe -s -X POST http://localhost:3000/api/operator/rolls/A-1024-roll-1/spool-weight -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{}'
curl.exe -s -X POST http://localhost:3000/api/operator/rolls/A-1024-roll-1/roll-weight  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{}'
curl.exe -s -X POST http://localhost:3000/api/operator/rolls/A-1024-roll-1/qr-print     -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{}'
# payload вводится только фактическим сканером с напечатанной этикетки; не извлекайте его из БД/UI
curl.exe -s -X POST http://localhost:3000/api/operator/rolls/A-1024-roll-1/qr-verify    -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{\"payload\":\"<фактический-prt_...-из-HID-сканера>\"}'
curl.exe -s -X POST http://localhost:3000/api/operator/rolls/A-1024-roll-1/handover     -H "Authorization: Bearer $TOKEN"
```

### A.8 Проверка отказов (стоит показать на демо)

| Сценарий             | Действие                                                                            | Ожидаемое поведение                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Весы offline         | выдернуть кабель весов (в simulated: `SCALE_SIMULATED_OFFLINE=on` + рестарт агента) | взвешивание на сайте даёт **503**, audit `device.scale.offline`, ручной ввод невозможен (исключение big-bag — всегда с аудитом)                                                |
| Вес не стабилен      | качнуть груз в момент взвешивания                                                   | **503 unstable** — платформа не принимает нестабильный вес                                                                                                                     |
| Принтер offline      | выключить принтер / неверный IP                                                     | до физической отправки: `failed`; после вызова транспорта без надёжного ACK: `delivery_unknown`; автоматического retry нет, ручная reprint требует причину и audit             |
| Агент выключен       | остановить агента (Ctrl+C)                                                          | команда истекает (`expired`) через `GATEWAY_COMMAND_TIMEOUT_MS` → **503**                                                                                                      |
| Платформа недоступна | остановить backend                                                                  | агент копит ingest в `events.jsonl`, а выполненный command result — в `command-results.jsonl`; после рестарта досылает тот же `eventId`/lease, не выполняя устройство повторно |
| Чужая этикетка       | отсканировать QR другого рулона в verify                                            | **400** + audit `device.scan.mismatch`                                                                                                                                         |
| Границы raw (§8)     | `GET /api/admin/diagnostics/dev-scale-1` под admin                                  | raw-кадры видны admin'у; в проекциях оператора/склада их нет                                                                                                                   |

`delivery_unknown` всегда блокирует прямой retry оператора. Администратор сначала проверяет
физический выход принтера и с capability `admin:devices` вызывает
`POST /api/admin/label-print-jobs/:printJobId/reconcile` с новым UUID `operationKey`, причиной и
одним исходом: `label_observed` переводит рулон в `qr_check/submitted` (дальше обязателен точный
HID-скан), `not_printed` переводит задание в `failed`, а строку — в
`qr_print/reprint_requested`. Решение идемпотентно, append-only и пишется событием
`audit:operator_label_print_reconciled`; token/raw payload в ответ и audit не попадают.

---

## Часть B. Legacy remote Windows bench: сервер + посты

Отличия от локального demo: backend/frontend живут на сервере; на каждом Windows bench-посту —
только gateway-агент и отдельный токен; агент можно проверить как службу Windows. Это не меняет
утверждённую production-цель: Ubuntu и последующий self-contained `.deb`/systemd slice.

### B.1 Сервер платформы

1. Node 20+, Postgres (managed или docker), reverse-proxy с **TLS**
   (nginx/caddy) перед NestJS.
2. `.env` сервера:

   ```
   NODE_ENV=production          # x-role-мок инертен в production в любом случае
   AUTH_DEV_XROLE=off
   DATABASE_URL=postgresql://...
   SEED_PASSWORD=<сильный пароль для сид-аккаунтов>
   DEVICE_GATEWAY_SCALE=on
   DEVICE_GATEWAY_PRINTER=on
   GATEWAY_SIMULATOR=off        # ОБЯЗАТЕЛЬНО off: иначе симулятор будет отвечать за посты
   GATEWAY_COMMAND_TIMEOUT_MS=5000
   ```

3. Развёртывание:

   ```bash
   npm ci
   npm run db:generate
   npm run build
   npm run db:deploy            # prisma migrate deploy
   npm run db:seed              # первичные данные (посты/устройства/роли)
   node apps/api/dist/main.js   # под systemd/pm2
   ```

4. Посты и устройства — данные, не код: новый станок = ещё одна запись `Post`
   (`POST /api/admin/posts`) + записи `DeviceRuntime` с его `postId`.

### B.2 Production-токен агента (обязательно заменить dev-токен)

Seed ставит dev-токены вида `agent-post-1` — в production они **не годятся**.
Эндпоинта ротации токена пока нет (осознанный пробел), поэтому токен задаётся
напрямую в БД: сервер хранит только SHA-256 хэш.

На своей машине сгенерируйте токен и хэш (PowerShell):

```powershell
# 32 случайных байта -> токен
$bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$TOKEN = [Convert]::ToHexString($bytes).ToLower(); $TOKEN
# SHA-256 хэш токена
$sha = [Security.Cryptography.SHA256]::Create()
[Convert]::ToHexString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($TOKEN))).ToLower()
```

На сервере запишите хэш посту:

```sql
UPDATE posts SET "agentTokenHash" = '<sha256-hex>' WHERE code = 'POST-1';
```

Токен (не хэш!) кладётся в `.env` агента на посту. Один пост = один токен;
компрометация одного поста не открывает остальные. При утечке — сгенерировать
новый и повторить UPDATE.

### B.3 Установка агента на ПК поста

1. Установите Node.js 20 LTS.
2. Получите код (git clone репозитория или копия каталога с уже собранным
   `apps/gateway-agent/dist`).
3. В каталоге репо:

   ```powershell
   npm ci
   npm run build -w @plenka/gateway-agent
   ```

   > `serialport` — optional-зависимость с нативной сборкой. Если при `npm ci`
   > она не встала (агент напишет `serialport module is not installed`):
   > `npm install serialport -w @plenka/gateway-agent`.

4. `apps\gateway-agent\.env` (по `.env.example`):

   ```
   GATEWAY_API_URL=https://erp.<ваш-домен>/api    # HTTPS, исходящий 443
   GATEWAY_AGENT_TOKEN=<production-токен из B.2>
   GATEWAY_POST_CODE=POST-1
   GATEWAY_SCALE_DEVICE_ID=dev-scale-1            # id устройств ЭТОГО поста
   GATEWAY_PRINTER_DEVICE_ID=dev-printer-1
   SCALE_MODE=massa-k-protocol-100
   SCALE_SERIAL_PORT=COM3
   SCALE_SERIAL_BAUD=57600
   SCALE_READ_TIMEOUT_MS=1500
   PRINTER_MODE=tcp9100
   PRINTER_TCP_HOST=<IP принтера поста>
   ```

5. Пробный запуск руками: `npm start -w @plenka/gateway-agent` → в логе
   `platform reachable`, на сервере `GET /api/admin/posts` показывает пост online.

### B.4 Автозапуск legacy bench как служба Windows (NSSM)

Рекомендуемый способ — [NSSM](https://nssm.cc) (служба с рестартом при падении):

```powershell
nssm install PlenkaGatewayAgent "C:\Program Files\nodejs\node.exe" "C:\plenka\PlenkaCover\apps\gateway-agent\dist\main.js"
nssm set PlenkaGatewayAgent AppDirectory "C:\plenka\PlenkaCover\apps\gateway-agent"   # тут лежит .env
nssm set PlenkaGatewayAgent AppStdout "C:\plenka\logs\gateway-agent.log"
nssm set PlenkaGatewayAgent AppStderr "C:\plenka\logs\gateway-agent.err.log"
nssm set PlenkaGatewayAgent AppRotateFiles 1
nssm set PlenkaGatewayAgent AppExit Default Restart
nssm start PlenkaGatewayAgent
```

Альтернатива без NSSM — Планировщик заданий: задача «При запуске компьютера»,
программа `node.exe`, аргумент `dist\main.js`, рабочая папка `apps\gateway-agent`,
«Перезапускать при сбое».

Обязательные настройки Windows на посту:

- **Электропитание**: схема «Высокая производительность»; сон = «Никогда»;
  Панель управления → Электропитание → Дополнительные параметры → USB →
  **Параметр временного отключения USB — Запрещено** (иначе Windows усыпит
  USB-COM адаптер и весы «пропадут»).
- Автовход в Windows не нужен — служба стартует до входа пользователя.

### B.5 Сеть и безопасность

- Агенту нужен только **исходящий** HTTPS (443) до сервера платформы. Входящих
  портов на посту нет — в файрволе ничего открывать не надо.
- Токен живёт только в `apps\gateway-agent\.env` на посту. Ограничьте права на
  файл (пользователь службы), не коммитьте `.env` (он в `.gitignore`).
- Raw-кадры устройств уходят на сервер только в admin-канал (`GatewayEvent.rawPayload`,
  `DeviceRuntime.rawPayload`) — бизнес-роли их не видят (ТЗ §8).
- `.gateway-buffer/events.jsonl` и `.gateway-buffer/command-results.jsonl` создаются с правами
  `0600`, каталог — `0700`. Первый файл ограничен по размеру; второй является evidence
  недоставленного результата. Файлы `.corrupt`/`.quarantine` не публикуют и не коммитят.

### B.6 Обновление агента

```powershell
nssm stop PlenkaGatewayAgent
git pull
npm ci
npm run build -w @plenka/gateway-agent
nssm start PlenkaGatewayAgent
```

Недоставленные ingest-события досылаются с теми же `eventId`. Результат уже выполненной
команды сначала сохраняется локально и после рестарта отправляется с исходным lease token;
устройство повторно не вызывается. Сервер дедуплицирует точное повторение и отклоняет
конфликтующий или устаревший результат.

### B.7 Масштабирование: ещё один пост

1. Создать `Post` (`POST /api/admin/posts`, code `POST-N`) и его `DeviceRuntime`-записи.
2. Сгенерировать токен + записать хэш (B.2).
3. Поставить агента на ПК нового поста (B.3–B.4) с его `GATEWAY_POST_CODE`,
   токеном и id устройств.

Кода это не требует — пост это данные (инвариант Variant B).

---

## 2. Чек-лист «данные передаются корректно»

Пройдите сверху вниз — каждый пункт проверяет свой участок цепочки:

1. **Безопасный Protocol 100 probe отвечает** → Windows bench видит COM и распознаёт весы;
   это не физическое S1 evidence.
2. **Лог агента содержит `platform reachable`** → агент видит сервер.
3. **`GET /api/admin/posts`: пост `online: true`, `lastSeenAt` свежий** → heartbeat доходит, `Post.agentStatus`/`DeviceRuntime.lastSeenAt` обновляются.
4. **Взвешивание на сайте возвращает вес, совпадающий с табло весов** → команда `read_scale` проходит полный круг; в логе агента `command handled ... kind read_scale`.
5. **`GatewayCommand` со статусом `done`** (видно в БД) и безопасная нормализованная проекция
   веса → результат дошёл; raw остаётся только в admin diagnostics и не переносится в Git/evidence.
6. **TLP4 принял задание, на сайте этикетка `submitted`** → transport submission подтверждён,
   но это ещё не physical verification и не доказательство выхода/качества бумаги; S4 остаётся PENDING.
7. **Фактический скан этикетки в поле сайта проходит verify / приёмку** → scanner-wedge и
   scan-flow работают с непрозрачным `prt_<64 hex>`; UI не подставлял ожидаемый payload.
8. **Отказы дают 503/400 + audit, а не тихий успех** → защитные инварианты на месте (прогнать A.8).

## 3. Траблшутинг

| Симптом                                        | Причина / что делать                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Агент: `gateway API ... HTTP 401`              | Неверный `GATEWAY_AGENT_TOKEN`, либо в БД не тот хэш (`posts.agentTokenHash` = SHA-256 токена)                           |
| Агент: `platform unreachable` постоянно        | `GATEWAY_API_URL` (протокол/порт/`/api` на конце), файрвол, TLS-сертификат                                               |
| Агент: `serialport module is not installed`    | optional-зависимость не собралась: `npm install serialport -w @plenka/gateway-agent`                                     |
| Взвешивание всегда 503, probe сообщает timeout | Проверить COM-порт/USB/питание; для RS-232 — режим `1C`, `57600`, `8-N-1`; raw frame и идентификаторы не пересылать      |
| Probe сообщает frame/CRC failure               | Проверить кабель и выбранный Protocol 100 профиль; сохранить только безопасную категорию ошибки                          |
| Вес есть, но 503 `unstable`                    | Дождаться `Stable=1`; нестабильный ответ обязан оставаться неавторитетным и завершает probe кодом `2`                    |
| Печать 503 (tcp9100)                           | `Test-NetConnection <IP> -Port 9100`; IP принтера, кабель, питание                                                       |
| Печать 503 (windows-command)                   | Команда вернула ≠ 0 — текст ошибки в логе агента; проверить имя общего принтера, запустить команду руками с любым файлом |
| Сканер «не работает»                           | Это клавиатура: курсор должен стоять в поле ввода на сайте; проверить в Notepad (п. 1.3)                                 |
| Весы «пропадают» через часы работы             | Windows усыпляет USB: запретить selective suspend и сон (B.4)                                                            |
| Пост offline после перезагрузки ПК             | Служба не стартовала: `nssm status PlenkaGatewayAgent`, логи в `C:\plenka\logs`                                          |
| На демо не хочется железа                      | Backend: `GATEWAY_SIMULATOR=on` (агент не нужен) или агент с `SCALE_MODE=simulated`, `PRINTER_MODE=simulated`            |
