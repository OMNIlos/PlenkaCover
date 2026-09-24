# Первый аппаратный smoke: Ubuntu-пост → VPS

> **Подтверждённый профиль от 2026-07-21.** На первом посту рабочая схема отличается от раннего
> Ethernet-предположения: МАССА-К подключена через RS-232→USB (`4800/even`, Protocol 100),
> MERTECH TLP4 — напрямую по USB через CUPS queue `TLP4` и raw ZPL, SG-110-BT — как 2.4G HID.
> Перед повторением теста сначала прочитайте
> [полевую базу знаний](./2026-07-21-physical-devices-field-knowledge.md). Она имеет приоритет над
> оставшимися в этом runbook альтернативными Ethernet/TSPL2 разделами для данного комплекта.

Этот документ — пошаговая инструкция для первого теста платформы рядом с реальными устройствами.
Он рассчитан на человека, который умеет открыть терминал и выполнить команду, но не обязан знать
Linux, Docker, COM-порты или сетевые протоколы.

Если проверка проводится дома через Zoom, ведущий работает с Mac, а коллега находится рядом с
пустым Ubuntu-постом и устройствами, сначала используйте линейный master-сценарий
[«Домашний beta-тест ERP на VPS через Zoom»](./home-zoom-vps-beta-test.md). Текущий документ
остаётся расширенным техническим справочником для точных hardware gates и диагностики.

До выполнения фактических шагов все аппаратные статусы равны **PENDING**. Автоматические тесты,
simulator, generic `serial`, успешное TCP-соединение с принтером и сохранённый в базе статус
устройства не являются физическим `PASS`.

Связанные документы:

- [подтверждённые полевые знания первого поста](./2026-07-21-physical-devices-field-knowledge.md);
- [VPS smoke перед аппаратным тестом](./first-vps-smoke.md);
- [проверка VPS с Mac без оборудования](./mac-vps-browser-only.md);
- [техническое руководство по устройствам](../hardware-integration-guide.md);
- [принятая архитектура Variant B](../Архитектура-интеграции-устройств.md);
- [организация удалённого подключения](../Оборудование-и-развитие/01-Подключение-оборудования-удалённо.md);
- [описание Debian-пакета агента](../../deploy/gateway-agent/README.md);
- [эталон физической конфигурации агента](../../deploy/gateway-agent/agent.env.example).

## 0. Самое важное простыми словами

На промышленном Ubuntu-компьютере одновременно работают **две независимые программы**:

1. Chromium показывает сайт, размещённый на VPS. В нём оператор входит по своему логину и
   выполняет производственный цикл.
2. `plenka-gateway-agent` работает в фоне как системная служба. Он читает локальные весы,
   отправляет байты на локальный принтер и сам делает только исходящие HTTPS-запросы к VPS.

У этих программ разные секреты:

- пароль/Bearer-сессия оператора принадлежат только браузеру;
- gateway token поста принадлежит только root-owned файлу агента;
- token нельзя вводить в Chromium, а пароль оператора нельзя записывать в конфиг агента.

Физические устройства **не подключаются к VPS**. Они подключаются к компьютеру у станка.

```text
                                         интернет
                                  только исходящий HTTPS
                                             │
┌────────────────────────────────────────────┼────────────────────────┐
│ Ubuntu-пост у станка                       │                        │
│                                            ▼                        │
│  Chromium ─────────────────────────────► frontend/API на VPS         │
│  gateway-agent ────────────────────────► /api/gateway/* на VPS       │
│      ▲                         ▲                                     │
│      │ RS-232 → USB           │ USB → CUPS raw ZPL                   │
│      │ Protocol 100           │                                     │
│  весы МАССА-К              MERTECH TLP4                              │
│                                                                      │
│  POScenter SG-110-BT + 2.4G USB-донгл ── HID-клавиатура ──► Chromium │
└──────────────────────────────────────────────────────────────────────┘
```

### 0.1. Что именно подключается к чему в этом release candidate

| Устройство                  | Физическое подключение                       | Кто им управляет             | Авторитетный режим первого теста                         |
| --------------------------- | -------------------------------------------- | ---------------------------- | -------------------------------------------------------- |
| МАССА-К ТВ-М-300.2-A(RUEW)3 | RS-232 терминала → USB adapter → Ubuntu-пост | gateway-agent                | Protocol 100, by-id, `4800/even`                         |
| MERTECH TLP4                | USB принтера → USB Ubuntu-поста              | gateway-agent через CUPS     | `cups-zpl`, queue `TLP4`, raw ZPL                        |
| POScenter SG-110-BT         | фирменный 2.4G USB-донгл → USB Ubuntu-поста  | Chromium, как HID-клавиатура | фактический ввод в пустое сфокусированное поле + `Enter` |

В текущем физическом профиле:

- подтверждённый первый пост использует USB/CUPS: `PRINTER_MODE=cups-zpl`,
  `PRINTER_CUPS_QUEUE=TLP4`; Ethernet `tcp9100` остаётся отдельной альтернативой и требует
  самостоятельного physical gate;
- встроенный `/dev/ttyS*`, Windows `COM3` и generic ASCII `serial` не являются physical PASS
  для МАССА-К;
- поле `GATEWAY_SCANNER_DEVICE_ID` связывает конфигурацию с каталогом устройств VPS, но агент
  не читает HID-сканер и не получает от него QR;
- scanner payload идёт из сканера прямо в активное поле сайта, как ввод с клавиатуры;
- на VPS не открывается маршрут к USB, COM или локальному RAW-порту принтера.

### 0.2. Значения статусов

Использовать только эти значения:

- `PENDING` — шаг ещё не выполняли;
- `BLOCKED` — шаг нельзя выполнить из-за отсутствующей предпосылки, документации или железа;
- `FAIL` — шаг выполняли и получили результат, противоречащий критерию;
- `PASS` — шаг выполнен на реальном устройстве и получено указанное доказательство.

Нельзя заменять `FAIL/BLOCKED` на «почти PASS». Общий аппаратный статус равен `PASS` только после
фактического прохождения всех обязательных строк итоговой матрицы.

## 1. Кто участвует и кто за что отвечает

Перед началом назначить четырёх ответственных. Один человек может совмещать роли, но действия
должны оставаться разделены.

| Роль в тесте                 | Ответственность                                                        |
| ---------------------------- | ---------------------------------------------------------------------- |
| Владелец VPS / администратор | release, POST-1, device bindings, одноразовый token, admin diagnostics |
| Начальник производства       | заранее создаёт/планирует смену и назначает оператора на POST-1        |
| Тестировщик у оборудования   | подключает кабели, запускает команды, смотрит табло/этикетку           |
| Оператор                     | входит своей учёткой и сам подключается к уже назначенной смене        |

Ключевой доменный порядок:

1. Начальник производства **заранее** планирует смену, оператора и станок.
2. До входа оператора смена остаётся `planned`, назначение — `planned`, `lockedAt` отсутствует,
   активной operator-on-post session нет.
3. Оператор видит «Нужен старт», выбирает и физически взвешивает Big-bag.
4. Только кнопка оператора «Открыть смену» создаёт active session, открывает смену и блокирует
   назначение.

Если сразу после входа оператора отображается «Смена открыта», а оператор не нажимал кнопку в
текущем тесте, это не нормальный baseline. Остановить тест и разбирать существующую active session
через поддерживаемый API/UI; не исправлять состояние SQL-командами.

## 2. Карточка теста

Заполнить карточку до начала. Не помещать в неё секреты и физические идентификаторы.

| Поле                             | Значение                         |
| -------------------------------- | -------------------------------- |
| Backend commit/image             | `PENDING`                        |
| Frontend commit/image            | `PENDING`                        |
| Gateway package version          | `PENDING`                        |
| Gateway package SHA-256 verified | `PENDING`                        |
| VPS smoke                        | `PENDING`                        |
| UTC start/end                    | `PENDING`                        |
| Тестировщик и площадка           | `PENDING`                        |
| Пост                             | `POST-1` / подтвердить в handoff |
| Ubuntu version/architecture      | `PENDING`                        |
| Agent version                    | `PENDING`                        |
| Scale gate                       | `PENDING`                        |
| Printer gate                     | `PENDING`                        |
| Scanner gate                     | `PENDING`                        |

В карточку, Git, issue и общий чат запрещено копировать:

- gateway token, пользовательские пароли, Bearer token или cookie;
- IP/hostname, если локальная политика владельца считает их закрытыми;
- serial/scale ID, USB identity, MAC-адрес и полный `/dev/serial/by-id/...`;
- raw Protocol 100 frame, необработанный `udevadm`, durable outbox;
- QR payload и содержимое коммерческой этикетки;
- фотографии реальной продукции, документы и дампы БД.

## 3. Полный список того, что должно лежать рядом до начала

### 3.1. Компьютер и сеть

- промышленный компьютер TG-TPC-150A5 либо согласованный x86_64-пост;
- Ubuntu 24.04 LTS;
- временные клавиатура и мышь для настройки, если сенсорного экрана недостаточно;
- Ethernet или Wi-Fi с исходящим доступом Ubuntu-поста к VPS;
- исправный USB-кабель MERTECH TLP4;
- свободные USB-порты либо качественный powered USB hub;
- источник точного времени/NTP;
- ИБП либо защищённое питание поста и принтера;
- доступ к trusted HTTPS URL платформы без certificate warning.

### 3.2. Весы

- МАССА-К ТВ-М-300.2-A(RUEW)3 с терминалом A(RUEW);
- штатный communication USB-кабель, который создаёт virtual COM;
- безопасный контрольный груз с известной массой в пределах НПВ весов;
- свободная и ровная платформа;
- человек, имеющий право эксплуатировать весы.

Весы имеют НПВ около 300 кг. **Никогда не ставить на них объект тяжелее разрешённой нагрузки.**
Seed Big-bag с учётным остатком 500 кг нельзя ставить на эти весы целиком. Для стартового веса
Big-bag нужен либо отдельный аттестованный весовой прибор подходящей грузоподъёмности, либо заранее
согласованный тестовый мешок, фактическая масса которого безопасна для используемых весов. Если
такого способа нет, открытие смены с физическим стартовым весом Big-bag имеет статус `BLOCKED`;
значение из seed нельзя вводить как будто оно измерено.

### 3.3. Принтер

- MERTECH TLP4 с блоком питания;
- USB-кабель;
- материал этикетки и риббон, установленные по руководству производителя;
- материал для первого рулонного теста, совместимый с макетом `58 × 40 mm`, gap `2 mm`;
- для отдельного палетного теста — материал `100 × 150 mm`;
- подтверждение, что принтер имеет 203 dpi и переведён в ZPL.

Агент формирует ZPL и передаёт его через CUPS raw queue. Реальная совместимость конкретной ревизии
TLP4, сторона риббона, media
sensor, скорость, darkness и точная кнопочная последовательность калибровки должны быть подтверждены
по паспорту именно этого экземпляра. Не сканировать случайные service barcodes и не угадывать
меню принтера.

### 3.4. Сканер

- POScenter SG-110-BT (не MERTECH: это важно для выбора правильного руководства);
- его собственный 2.4G USB-донгл;
- заряженный аккумулятор;
- база/кредл и питание базы, если они входят в комплект;
- руководство именно к этой ревизии сканера;
- setup barcodes производителя для режима `2.4G HID keyboard` и suffix `Enter`, если режим не
  настроен с завода.

Не использовать баркоды настройки от похожей модели: они могут изменить интерфейс, раскладку,
prefix/suffix или сбросить pairing.

До выезда сохранить локально или распечатать именно эти источники:

- [официальная карточка MERTECH TLP4](https://mertech.ru/termotransfernyj-printer-ehtiketok-tlp4-ethernet-rs232-usb/),
  артикул `1025`, 203 dpi;
- [официальное подключение TLP4 (HT600) по локальной сети](https://help.mertech.ru/label_printers/HT600_HT630/HT600_630_ethernet.html);
- [официальный раздел MERTECH о network port 6101](https://help.mertech.ru/label_printers/HT600_HT630/ht600_6101_closed.html);
- [официальное руководство POScenter SG-110-BT, версия 1.0](https://pos-center.ru/files/downloads/instructions/instruction_sg-110-bt.pdf).

Для SG-110-BT заранее отметить страницы руководства версии 1.0:

- страницы 5–7 — автоматическое соединение, 2.4G и HID-клавиатура;
- страница 13 — принудительное соединение с USB-приёмником и `2.4G HID-клавиатура`;
- страницы 21–22 — suffix беспроводного модуля;
- страницы 31–33 — prefix/suffix сканирующего модуля и «только CR».

Если надпись модели/ревизии на реальном устройстве не совпадает, не использовать эти баркоды.
Записать `BLOCKED: другая ревизия`, сфотографировать только шильдик без serial и запросить у
поставщика руководство именно к этому экземпляру.

### 3.5. Release-файлы и доступы

- ровно один `.deb` вида `plenka-gateway-agent_<version>_amd64.deb`;
- соседний файл `<имя-deb>.sha256` из того же release;
- backend/frontend release handoff;
- точные `POST-1` и три platform device ID из admin-каталога;
- новый canonical gateway token `POST-1`, переданный вне браузера оператора;
- отдельные реальные учётки admin, production lead, operator и warehouse.

## 3A. Точный handoff: что владелец поста получает у администратора

Перед поездкой к оборудованию администратор и владелец поста вместе заполняют закрытый handoff.
Значения не угадываются по старому `.env` и не берутся из screenshot другого запуска.

| Что получить                    | Пример только формата        | Откуда берётся                 | Кому можно передать              |
| ------------------------------- | ---------------------------- | ------------------------------ | -------------------------------- |
| Frontend origin                 | `https://<trusted-host>`     | владелец VPS/release handoff   | оператору и тестировщику         |
| Gateway API URL                 | `https://<trusted-host>/api` | frontend origin + ровно `/api` | администратору поста             |
| Backend/frontend SHA            | `<git-sha>`                  | release manifest               | тестировщику, без секретов       |
| Gateway package version/SHA-256 | `<version>` / `<sha256>`     | release artifacts              | тестировщику, без секретов       |
| Post code                       | `POST-1`                     | admin → «Посты»                | тестировщику                     |
| Scale platform ID               | `<точный-scale-ID>`          | admin → «Устройства»           | администратору поста             |
| Printer platform ID             | `<точный-printer-ID>`        | admin → «Устройства»           | администратору поста             |
| Scanner platform ID             | `<точный-scanner-ID>`        | admin → «Устройства»           | администратору поста             |
| Одноразовый post token          | `ptk_<скрыто>`               | admin → POST-1 → «Новый токен» | только root-администратору поста |
| Назначенный operator login      | `<выданная-учётка>`          | production/admin handoff       | назначенному оператору           |
| Локальный host/IP TLP4          | `<локальный-адрес>`          | сетевой администратор          | администратору поста             |
| Scale serial path               | `/dev/serial/by-id/<скрыто>` | обнаруживается только на посту | остаётся только root-конфигу     |

Проверить перед передачей:

- [ ] origin открывается по HTTPS без warning и без `-k`;
- [ ] gateway URL заканчивается ровно `/api`;
- [ ] `POST-1` относится к физическому станку, а `POST-5` оставлен simulator lane;
- [ ] все три device ID включены и привязаны к тому же `POST-1`;
- [ ] token выпущен **после** остановки старого агента и показан один раз;
- [ ] token не передан оператору и не открыт в operator browser;
- [ ] пароль оператора и gateway token переданы отдельно;
- [ ] package checksum получен из того же release, что и `.deb`;
- [ ] локальный IP принтера не является адресом-примером и не опубликован наружу;
- [ ] смена/назначение planned, active session отсутствует.

Файл этой инструкции хранит названия полей, но не их реальные секретные значения. Реальный token
должен сразу попасть через `sudoedit` в `/etc/plenka-gateway/agent.env`, а затем исчезнуть из
временного канала передачи по правилам владельца VPS.

## 3B. Совсем без весов: Mac → размещённый frontend

Этот сценарий можно выполнить дома или в офисе **до поездки к промышленному посту**. Нужны только
Mac, интернет, Chrome и выданные пользовательские учётки. Не нужны `.deb`, Node.js, Docker,
gateway token, SSH, весы, принтер или сканер.

Результат называется только `BROWSER PASS/FAIL`. Даже идеальный результат означает:

- `BROWSER PASS`;
- `SIMULATED PENDING`, если отдельный simulator не запускался;
- `PHYSICAL/HARDWARE PENDING`;
- никакой принтер, сканер или весы физически не проверены.

Полная версия сценария находится в
[Mac → VPS: browser-only проверка](./mac-vps-browser-only.md). Короткий пошаговый вариант:

### 3B.1. Получить только browser-данные

У владельца VPS получить через secure handoff:

- frontend origin вида `https://<trusted-host>` без `/api`;
- pilot login/password для `admin`, `warehouse`, `гайнулин ильназ`;
- подтверждение, что текущий release и clean pilot seed уже развёрнуты.

Для browser-only теста **не просить** и не принимать gateway token. Он не нужен Mac/Chrome.

### 3B.2. Проверить health с Mac

Открыть Terminal и ввести:

```zsh
read -r 'PLENKA_ORIGIN?Trusted platform origin (https://...): '
if [[ "$PLENKA_ORIGIN" != https://* ]]; then
  print -u2 'STOP: нужен https:// URL'
  unset PLENKA_ORIGIN
else
  curl --fail-with-body --silent --show-error --write-out '\nHTTP %{http_code}\n' \
    "$PLENKA_ORIGIN/api/health" &&
    curl --fail-with-body --silent --show-error --write-out '\nHTTP %{http_code}\n' \
      "$PLENKA_ORIGIN/api/health/ready"
fi
```

Обе команды должны вернуть `HTTP 200`. Не использовать `curl -k`/`--insecure`. Пароль, Bearer
token и gateway token в команды не добавляются.

### 3B.3. Открыть чистую browser-сессию

```zsh
open -na 'Google Chrome' --args --incognito "$PLENKA_ORIGIN"
```

Проверить:

1. адрес остаётся `https://`, certificate warning отсутствует;
2. вход выполняется реальным pilot login/password;
3. demo role switcher и `x-role` отсутствуют;
4. `Cmd+R` сохраняет текущую роль и сессию;
5. logout закрывает только browser auth-session и возвращает на login; он не открывает и не
   закрывает производственную смену; Back/refresh не открывают рабочий стол из cache.

Каждую роль проверять в новом Incognito-сеансе: logout → закрыть **все** Incognito-окна → открыть
новое. Одновременные admin/operator окна могут разделить временное browser storage и исказить
результат.

### 3B.4. Проверить Гайнулина Ильназа без открытия смены

1. Войти `гайнулин ильназ` (Гайнулин Ильназ, `seed-operator-3`, пароль
   `SEED_PILOT_PASSWORD_OPERATOR_3`) в новом Incognito-сеансе.
2. Убедиться, что его seeded simulator lane — `POST-5`, не физический `POST-1`.
3. Убедиться, что видно «Нужен старт», а не «Смена открыта».
4. Убедиться, что active operator-on-post session и стартовый вес отсутствуют.
5. Не нажимать «Открыть смену» в browser-only тесте.
6. Не нажимать device actions и не вводить фиктивный roll weight.
7. Убедиться, что operator не видит admin raw diagnostics/token/чужой пост.
8. Выполнить logout и проверить закрытие сессии.

Если нужен программный цикл с simulated-agent, использовать отдельную инструкцию
[Mac → VPS: simulated-agent на POST-5](./mac-vps-and-simulator-smoke.md) и отдельный token
`POST-5`. Его итог называется только `SIMULATED PASS/FAIL` и никогда не становится hardware PASS.

### 3B.5. PASS browser-only

- [ ] health и ready вернули trusted HTTPS `200` без bypass;
- [ ] Chrome открыл frontend без TLS warning;
- [ ] admin/warehouse/гайнулин ильназ показывают правильные роли;
- [ ] refresh сохраняет, logout закрывает сессию;
- [ ] гайнулин ильназ видит planned `POST-5` и «Нужен старт»;
- [ ] бизнес-роли не видят raw/token;
- [ ] без агента UI не показал fake device success;
- [ ] ни один бизнес-факт не создан только ради browser smoke;
- [ ] token/password/raw не попали в Terminal output, screenshot или Git.

После этого можно записать `BROWSER PASS`, но итоговая строка данного аппаратного runbook всё ещё
остаётся `PHYSICAL PENDING`.

## 4. Безопасно соединить кабели

### 4.1. До подключения

1. Остановить станок или перейти в разрешённое технологическое окно.
2. Убрать груз с весов.
3. Выключить принтер его штатным выключателем.
4. Не трогать кабель тензодатчика, пломбы, калибровочные винты и сервисные настройки весов.
5. Подписать кабели бумажными метками: `SCALE RS232-USB`, `SCANNER 2.4G`, `PRINTER USB`, `POST LAN`.
6. Не подключать одновременно несколько неизвестных USB-COM устройств на первом поиске порта.

### 4.2. Подтверждённая схема первого поста

```text
интернет/роутер
      │
цеховой Ethernet switch/Wi-Fi
      └──────── сеть ────── Ubuntu-пост

Ubuntu-пост USB №1 ─────── RS-232→USB adapter МАССА-К
Ubuntu-пост USB №2 ─────── MERTECH TLP4
Ubuntu-пост USB №3 ─────── 2.4G dongle SG-110-BT
```

Последовательность:

1. Подключить основной LAN Ubuntu-поста к switch.
2. Подключить TLP4 к USB Ubuntu-поста.
3. Подключить RS-232→USB adapter терминала МАССА-К к другому USB-порту.
4. Вставить фирменный 2.4G-донгл SG-110-BT в третий USB-порт.
5. Подать питание на пост, весы и принтер.
6. Убедиться, что нигде нет повреждённых, натянутых или лежащих в проходе кабелей.

Ethernet TLP4 остаётся альтернативой, но требует отдельного network/RAW physical gate. Не смешивать
его с подтверждённым USB/CUPS profile в одном тесте.

### 4.3. Что не подключать

- не подключать Ethernet принтера одновременно с рабочим USB/CUPS без отдельного плана;
- не подключать два communication transport весов одновременно;
- не включать port forwarding/DMZ на роутере;
- не публиковать локальный RAW port принтера (`9100`/`6101`) на VPS или в интернет;
- не вставлять gateway token в адресную строку, форму входа или DevTools Chromium;
- не включать simulator «временно для зелёного статуса».

## 5. Подготовить Ubuntu 24.04

Все команды этого раздела выполняются **на компьютере у станка**, не на VPS и не на Mac.
Открыть приложение «Терминал». Команды вводятся по одной. Если команда завершилась ошибкой,
остановиться на её подразделе и не продолжать вслепую.

### 5.1. Проверить ОС, архитектуру и свободное место

```bash
. /etc/os-release
printf 'OS: %s %s\n' "$NAME" "$VERSION_ID"
uname -m
df -h / /var
```

Ожидается:

- Ubuntu `24.04`;
- архитектура `x86_64`;
- в `/var` есть как минимум несколько гигабайт свободного места.

Если архитектура `aarch64`, `arm64`, `i386` или другая — `.deb` устанавливать нельзя, статус
`BLOCKED`: текущий пакет выпускается только для `amd64/x86_64`.

### 5.2. Проверить сеть поста

```bash
ip -br link
ip route
nmcli device status
```

Нужно увидеть:

- рабочий Ethernet-интерфейс в состоянии `UP/connected`;
- строку `default via ...` в `ip route`;
- отсутствие постоянно переключающегося Wi-Fi/Ethernet маршрута.

Локальные IP и MAC из вывода нужны только для диагностики на месте. Не копировать весь вывод в
Git или общий чат.

### 5.3. Проверить точное время

```bash
sudo timedatectl set-ntp true
timedatectl status
timedatectl show --property=NTPSynchronized --value
date -u
```

Последняя проверка синхронизации должна вывести `yes`. Если несколько минут остаётся `no`:

```bash
systemctl status systemd-timesyncd.service --no-pager || true
```

Если на площадке используется `chrony` или корпоративный NTP, настройку делает сетевой
администратор. Нельзя вручную «подогнать» часы ради теста: неверное время ломает TLS, дедлайны
gateway-команд, heartbeat freshness и аудит.

### 5.4. Проверить Chromium до поездки к устройствам

```bash
if command -v chromium >/dev/null 2>&1; then
  chromium --version
elif command -v chromium-browser >/dev/null 2>&1; then
  chromium-browser --version
else
  printf 'BLOCKED: Chromium не установлен\n' >&2
fi
```

Если версия не вывелась, согласовать установку с администратором поста. Для обычной Ubuntu 24.04
официальный пакет Canonical устанавливается из stable-канала Snap:

```bash
sudo snap install chromium
chromium --version
```

Официальная карточка пакета: [Chromium в Snap Store](https://snapcraft.io/chromium). Если на
предприятии Snap Store запрещён, не скачивать случайный `.deb` и не добавлять сторонний репозиторий:
статус `BLOCKED`, пока локальный администратор не установит утверждённую корпоративную сборку.
Первый запуск Chromium выполнить до аппаратного окна, чтобы принять только штатный browser setup,
проверить английскую раскладку и убедиться, что окно нормально помещается в разрешение поста.

### 5.5. Установить только диагностические утилиты

Node.js отдельно ставить не нужно: Node 22 уже находится внутри `.deb`.

```bash
sudo apt update
sudo apt install --yes ca-certificates curl jq netcat-openbsd
```

Если APT недоступен, но утилиты уже стоят, проверить:

```bash
curl --version
jq --version
nc -h 2>&1 | head -n 1
```

### 5.6. Проверить VPS без обхода TLS

Получить у владельца release точный публичный origin, например `https://<доверенное-имя>`.
Ввести его интерактивно, чтобы случайно не оставить неправильный адрес в документации:

```bash
read -r -p 'Trusted platform origin (https://...): ' PLATFORM_ORIGIN
if [[ "$PLATFORM_ORIGIN" != https://* ]]; then
  printf 'STOP: нужен https:// URL\n' >&2
  unset PLATFORM_ORIGIN
else
  curl --fail --silent --show-error --output /dev/null \
    --write-out 'frontend HTTP %{http_code}\n' "$PLATFORM_ORIGIN/" &&
    curl --fail --silent --show-error --output /dev/null \
      --write-out 'health HTTP %{http_code}\n' "$PLATFORM_ORIGIN/api/health" &&
    curl --fail --silent --show-error --output /dev/null \
      --write-out 'ready HTTP %{http_code}\n' "$PLATFORM_ORIGIN/api/health/ready"
fi
```

Ожидается `200` для всех трёх запросов. Запрещено добавлять `-k`, `--insecure`, менять системную
дату или отключать проверку сертификата. Certificate error означает `BLOCKED` до исправления TLS.

## 6. Подготовить VPS и смену до выдачи token

Этот раздел выполняет владелец VPS/admin. Тестировщику у поста передают только подтверждённые
значения и одноразовый token через защищённый канал.

### 6.1. Обязательные серверные гейты

Продолжать можно только когда:

- [VPS smoke](./first-vps-smoke.md) имеет фактический `PASS` на текущем release;
- backend запущен с `AUTH_DEV_XROLE=off` и `GATEWAY_SIMULATOR=off`;
- `npm run test:protected-demo` и `npm run test:gateway-package` зелёные на том же commit;
- pilot seed выполнен повторно и идемпотентно;
- `POST-1` активен;
- фактические scale/printer/scanner ID из admin-каталога включены и привязаны только к `POST-1`;
  для текущего canonical pilot seed ожидаются `scale-post-1`, `printer-post-1`,
  `scanner-post-1`, но handoff обязан сверить их с реально развёрнутой БД;
- нет active operator-on-post session на `POST-1`;
- `pilot-test-shift-001` имеет `planned`, `startedAt=null`;
- назначение физического оператора на `POST-1` имеет `planned`, `lockedAt=null`;
- назначенный рулон `PILOT-PHYSICAL-ROLL-001` и ожидающая приёмка существуют;
- `PILOT-BAG-PHYSICAL-001` доступен, а способ его **реального безопасного** взвешивания согласован.

### 6.2. Проверить каталог через интерфейс admin

1. Открыть frontend с отдельного административного компьютера.
2. Войти реальным admin-пользователем.
3. Открыть раздел «Посты».
4. Найти `POST-1`, убедиться, что он включён и имеет ровно три ожидаемые привязки.
5. Открыть раздел «Устройства».
6. Проверить типы `scale`, `printer`, `scanner`, их platform ID и привязку `POST-1`.
7. Не считать сохранённый `ready` доказательством физической работы.

Если ID отличаются от handoff текущего release, не угадывать их и не переименовывать устройство
во время smoke. Сначала исправить каталог/привязку с причиной и audit.

### 6.3. Выпустить token именно для POST-1

1. Убедиться, что старый агент `POST-1` остановлен.
2. В admin-разделе «Посты» нажать «Новый токен» только в строке `POST-1`.
3. Ввести непустую причину, например «Первый аппаратный smoke, дата и ответственный».
4. В окне «Новый gateway-токен» скопировать значение `ptk_...` ровно один раз.
5. Передать token администратору Ubuntu-поста через защищённый канал.
6. Закрыть окно только после подтверждения, что token помещён в root-owned конфиг.

Token не хранится в localStorage и второй раз не показывается. Ротация немедленно отзывает старый
token. Token одного поста нельзя использовать на другом.

Лучше выпускать token не в Chromium оператора на промышленном посту. Так browser profile
оператора никогда не владеет agent credential.

## 7. Получить и проверить `.deb`

### 7.1. Как release engineer создаёт пакет

Release engineer собирает пакет на доверенной машине из чистого canonical checkout с полной Git-
историей, не из linked worktree:

```bash
./scripts/gateway/build-deb-container.sh release/gateway
(cd release/gateway && sha256sum -c *.deb.sha256)
```

Builder закреплён на Linux/amd64 и включает Node.js `22.23.1`. Техническая гарантия пакета:
`Node.js 22 runtime is bundled` — на Ubuntu-пост не нужно и нельзя отдельно устанавливать Node.js
для запуска агента. Пакет и checksum передаются вместе. На промышленном посту не выполняются
`git clone`, `npm install` или самостоятельная сборка.

### 7.2. Как физически передать два файла на Ubuntu-пост

Нужны ровно два файла из **одного** release:

1. `plenka-gateway-agent_<version>_amd64.deb`;
2. тот же полный filename плюс `.sha256`.

Самый простой безопасный способ для первого выезда — чистая USB-флешка:

1. Владелец VPS на своей администраторской машине скачивает оба файла из каталога handoff
   `/opt/plenka/artifacts/gateway/<backend-SHA>/`.
2. Он сверяет backend SHA с карточкой теста, а не выбирает «самый новый» каталог на глаз.
3. Копирует на пустую флешку только `.deb` и `.deb.sha256`.
4. Безопасно извлекает флешку.
5. На Ubuntu-посту открывает приложение «Файлы».
6. В левой панели выбирает флешку и визуально проверяет, что файлов два.
7. Создаёт папку `Домашняя папка/plenka-gateway-release`.
8. Копирует туда оба файла, дожидается завершения и безопасно извлекает флешку.
9. Открывает Terminal и выполняет команды проверки из раздела 7.3.

USB-флешка не должна содержать `.env`, token, пользовательские пароли, SSH private key или DB
dump. После передачи release-файлов её очищают по политике владельца оборудования.

Если владелец VPS сам находится у Ubuntu-поста и ему разрешён SSH, можно скачать без флешки.
Команды не содержат пароль: `scp` запросит его скрыто, символы в Terminal отображаться не будут.

```bash
mkdir -p "$HOME/plenka-gateway-release"
cd "$HOME/plenka-gateway-release"
find . -mindepth 1 -maxdepth 1 -type f -print -quit | grep -q . && {
  printf 'STOP: папка не пустая; не смешивайте два release\n' >&2
  false
}
read -r -p 'SSH адрес VPS, например root@host: ' VPS_SSH
read -r -p 'Backend SHA из release handoff: ' BACKEND_SHA
case "$BACKEND_SHA" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]* ) ;;
  *) printf 'STOP: неверный формат SHA\n' >&2; false ;;
esac
scp "${VPS_SSH}:/opt/plenka/artifacts/gateway/${BACKEND_SHA}/plenka-gateway-agent_*_amd64.deb*" .
unset VPS_SSH BACKEND_SHA
```

Если `scp` сообщает `Permission denied`, `No such file` или копирует не ровно два файла, не
менять права `/opt/plenka` и не просить пароль в общем чате. Владелец VPS должен подготовить
handoff заново. Не включать SSH server на промышленном посту ради передачи: архитектуре нужен
только исходящий доступ поста.

### 7.3. Как тестировщик проверяет полученные файлы

Создать отдельную папку и положить туда ровно `.deb` и его `.sha256`:

```bash
mkdir -p "$HOME/plenka-gateway-release"
cd "$HOME/plenka-gateway-release"
find . -maxdepth 1 -type f -printf '%f\n'
```

Проверить, что пакет ровно один:

```bash
mapfile -t DEBS < <(find . -maxdepth 1 -type f \
  -name 'plenka-gateway-agent_*_amd64.deb' -print | sort)
test "${#DEBS[@]}" -eq 1
DEB="${DEBS[0]}"
test -f "${DEB}.sha256"
sha256sum -c "${DEB}.sha256"
dpkg-deb --field "$DEB" Package Version Architecture
```

Ожидается:

- строка checksum заканчивается `OK`;
- Package: `plenka-gateway-agent`;
- Architecture: `amd64`;
- version совпадает с release handoff.

При `FAILED`, отсутствующем checksum, лишнем `.deb` или другой архитектуре пакет **не ставить**.
Не скачивать «похожую» сборку из чата или старой папки.

### 7.4. Установить пакет

```bash
sudo apt install "$DEB"
dpkg-query -W -f='${Package} ${Version} ${Architecture}\n' plenka-gateway-agent
sudo cat /usr/share/doc/plenka-gateway-agent/BUILD-INFO
sudo systemctl is-enabled plenka-gateway.service || true
sudo systemctl is-active plenka-gateway.service || true
```

После первой установки служба должна быть `disabled` и `inactive`. Установка создаёт:

- пользователя и группу `plenka-gateway`;
- `/opt/plenka-gateway` с bundled runtime;
- `/etc/plenka-gateway` для закрытой конфигурации;
- `/var/lib/plenka-gateway` для durable state;
- `plenka-gateway.service`, но не запускает её автоматически при первой установке.

Проверить владельцев:

```bash
getent passwd plenka-gateway
getent group plenka-gateway
sudo stat -c '%U %G %a %n' /etc/plenka-gateway /var/lib/plenka-gateway
```

Ожидается:

- `/etc/plenka-gateway`: `root plenka-gateway 750`;
- `/var/lib/plenka-gateway`: `plenka-gateway plenka-gateway 750`.

## 8. Настроить доступ к serial и создать `agent.env`

### 8.1. Дать служебному пользователю доступ к группе dialout

Systemd unit добавляет `dialout` как supplementary group. Для отдельного root-wrapper
`plenka-gateway-probe`, который запускает процесс через `runuser`, также зафиксировать членство
пользователя в группе:

```bash
getent group dialout
sudo usermod --append --groups dialout plenka-gateway
id plenka-gateway
```

В выводе `id` должна присутствовать группа `dialout`.

### 8.2. Создать конфиг только при первой установке

Не перезаписывать существующий конфиг при upgrade:

```bash
if sudo test -e /etc/plenka-gateway/agent.env; then
  printf 'STOP: agent.env уже существует; сначала сверить его с владельцем поста\n'
else
  sudo install -m 0640 -o root -g plenka-gateway \
    /usr/share/doc/plenka-gateway-agent/agent.env.example \
    /etc/plenka-gateway/agent.env
fi
```

Открыть конфиг безопасным редактором:

```bash
sudoedit /etc/plenka-gateway/agent.env
```

Не создавать файл через `echo`, heredoc или команду с token: это оставляет секрет в shell history
или process list.

### 8.3. Правила заполнения

Одна строка имеет формат `KEY=value`, без пробелов вокруг `=` и без комментария после значения.
Угловые скобки ниже являются пояснениями и не должны остаться в файле.

```text
GATEWAY_DEPLOYMENT_MODE=physical
GATEWAY_API_URL=https://<trusted-vps-host>/api
GATEWAY_AGENT_TOKEN=<одноразовый-token-POST-1>
GATEWAY_POST_CODE=POST-1
GATEWAY_SCALE_DEVICE_ID=<точный-scale-ID-из-admin>
GATEWAY_PRINTER_DEVICE_ID=<точный-printer-ID-из-admin>
GATEWAY_SCANNER_DEVICE_ID=<точный-scanner-ID-из-admin>
SCANNER_HID_PATH=/dev/input/by-id/<точный-scanner-event-kbd>

GATEWAY_POLL_INTERVAL_MS=1000
GATEWAY_HEARTBEAT_INTERVAL_MS=5000
GATEWAY_BUFFER_DIR=/var/lib/plenka-gateway

SCALE_MODE=massa-k-protocol-100
SCALE_SERIAL_PORT=/dev/serial/by-id/<будет-заполнено-после-поиска>
SCALE_SERIAL_BAUD=4800
SCALE_SERIAL_PARITY=even
SCALE_READ_TIMEOUT_MS=1500
SCALE_ASSUME_STABLE=off
SCALE_SIMULATED_OFFLINE=off

PRINTER_MODE=cups-zpl
PRINTER_CUPS_QUEUE=TLP4
PRINTER_DPI=203
PRINTER_MAX_WIDTH_DOTS=864
PRINTER_SIMULATED_FAIL=off
```

Важно:

- `GATEWAY_API_URL` заканчивается ровно на `/api`;
- URL содержит trusted `https://`, без login/password/query/fragment;
- `GATEWAY_AGENT_TOKEN` начинается `ptk_` и относится только к `POST-1`;
- platform device ID копируются из admin-каталога, а не придумываются;
- `SCALE_SERIAL_BAUD=4800` и `SCALE_SERIAL_PARITY=even` относятся к подтверждённому RS-232→USB
  профилю; native USB alternative требует отдельной проверки `57600/none`;
- `PRINTER_CUPS_QUEUE=TLP4` должна существовать, быть enabled и указывать на точный MERTECH USB;
- scanner ID присутствует для привязки, но сканер остаётся browser-owned HID;
- physical mode не принимает `simulated`, legacy `serial`, `/dev/ttyUSB0`, `COM3` или адреса-
  примеры.

### 8.4. Проверить права и отсутствие placeholder

```bash
sudo chown root:plenka-gateway /etc/plenka-gateway/agent.env
sudo chmod 0640 /etc/plenka-gateway/agent.env
sudo stat -c '%U %G %a %n' /etc/plenka-gateway/agent.env
sudo -u plenka-gateway test -r /etc/plenka-gateway/agent.env
if sudo grep -Eiq 'replace|example|placeholder|changeme|<|>' \
  /etc/plenka-gateway/agent.env; then
  printf 'FAIL: в конфиге остался placeholder\n'
else
  printf 'PASS: явных placeholder нет\n'
fi
```

Ожидаемые права: `root plenka-gateway 640`.

Пока serial path, scanner by-id и CUPS queue ещё не найдены, `--check-config` закономерно будет
`invalid`. Не
пытаться сделать его зелёным simulator-значениями.

## 9. Подключить и проверить весы МАССА-К

### 9.1. Безопасность и ограничения

- Платформа весов должна быть свободна при поиске порта и нулевой проверке.
- Не изменять калибровку, пломбы и сервисные коэффициенты.
- Подтверждённый transport — RS-232→PL2303 USB adapter, Protocol 100, `4800/even`.
- Совместимый native USB profile `57600/none` остаётся альтернативой с отдельным gate.
- Не запускать `plenka-gateway-probe`, пока systemd-служба активна: два процесса будут спорить за
  один serial port.

### 9.2. Найти стабильный `/dev/serial/by-id`

1. Отключить от поста лишние USB-COM адаптеры.
2. Оставить подключённым communication USB весов.
3. Выполнить:

```bash
sudo udevadm settle
if test ! -d /dev/serial/by-id; then
  printf 'FAIL: каталог /dev/serial/by-id отсутствует\n' >&2
  false
fi
mapfile -t SCALE_PORTS < <(find /dev/serial/by-id -maxdepth 1 -type l -print | sort)
printf 'Найдено serial-by-id: %s\n' "${#SCALE_PORTS[@]}"
printf '%s\n' "${SCALE_PORTS[@]}"
```

Идеальный первый стенд показывает один путь. Если путей несколько:

1. локально посмотреть список;
2. отключить только communication USB весов;
3. повторить список;
4. вернуть кабель и дождаться `udevadm settle`;
5. выбрать путь, который исчез и появился снова с тем же именем.

Не выбирать порт по номеру `/dev/ttyUSB0` или `/dev/ttyACM0`: после reboot номер может измениться.
Полный by-id используется локально и не копируется в публичный evidence.

Сохранить выбранный путь в переменную. Если путь один, команда выберет его автоматически; если
путей несколько, вручную вставить только локально подтверждённый by-id (ввод `read` не попадает в
shell history):

```bash
if test "${#SCALE_PORTS[@]}" -eq 1; then
  SCALE_PORT="${SCALE_PORTS[0]}"
else
  read -r -p 'Подтверждённый /dev/serial/by-id путь весов: ' SCALE_PORT
fi
case "$SCALE_PORT" in
  /dev/serial/by-id/*) ;;
  *) printf 'FAIL: нужен стабильный /dev/serial/by-id путь\n' >&2; false ;;
esac
test -L "$SCALE_PORT"
readlink -f "$SCALE_PORT"
```

Последний вывод нужен только локально. Затем вставить значение `SCALE_PORT` в строку
`SCALE_SERIAL_PORT=` через `sudoedit`:

```bash
sudoedit /etc/plenka-gateway/agent.env
```

### 9.3. Проверить права служебного пользователя

```bash
sudo runuser -u plenka-gateway -- test -r "$SCALE_PORT"
sudo runuser -u plenka-gateway -- test -w "$SCALE_PORT"
```

Обе команды должны завершиться без текста и с exit code `0`. Если `Permission denied`:

```bash
id plenka-gateway
stat -Lc '%U %G %a %n' "$SCALE_PORT"
```

Обычно реальное устройство принадлежит `root:dialout`. Если группа другая, не делать `chmod 777`
и не создавать широкое udev-правило: остановиться и передать вывод локальному администратору.

### 9.3A. Проверить локальную CUPS queue перед полным config check

Проверка полного physical config требует уже созданной queue `TLP4` и заполненного
`SCANNER_HID_PATH`. Правильный порядок:

1. закончить поиск serial path в разделах 9.1–9.3;
2. выполнить раздел 10.0 и создать USB/CUPS queue `TLP4`;
3. проверить HID path сканера в разделе 11;
4. записать `PRINTER_MODE=cups-zpl`, `PRINTER_CUPS_QUEUE=TLP4` и scanner path в `agent.env`;
5. вернуться сюда и продолжить с раздела 9.4;
6. после scale gate ещё раз проверить config целиком.

Если вместо реальной queue или scanner path временно вписать placeholder/simulator, physical gate
недействителен.

### 9.4. Проверить полный конфиг без вывода секретов

После заполнения printer host и serial path:

```bash
sudo /opt/plenka-gateway/node \
  --env-file=/etc/plenka-gateway/agent.env \
  /opt/plenka-gateway/main.js --check-config
```

Единственный успешный текст: `gateway configuration valid: physical`.

При `gateway configuration invalid` программа специально не сообщает, какое секретное значение
ошибочно. Сверить файл строка за строкой через `sudoedit`; не печатать его командой `cat`.

### 9.5. Создать временную папку evidence

```bash
umask 077
EVIDENCE_DIR="$(mktemp -d -t plenka-hardware.XXXXXX)"
chmod 0700 "$EVIDENCE_DIR"
printf 'Временная папка создана; её содержимое нельзя коммитить.\n'
```

Probe выводит безопасную JSON-проекцию, но она всё равно содержит scale identity. Файлы остаются
только локально до редактирования и затем удаляются.

### 9.6. Gate A: пустая стабильная платформа

1. Снять весь груз.
2. Дождаться стабильного индикатора на табло.
3. Выполнить:

```bash
if sudo plenka-gateway-probe > "$EVIDENCE_DIR/scale-zero.json"; then
  SCALE_ZERO_RC=0
else
  SCALE_ZERO_RC=$?
fi
printf 'scale-zero exit=%s\n' "$SCALE_ZERO_RC"
test "$SCALE_ZERO_RC" -eq 0
jq -e '
  .probe.ok == true and
  .probe.simulated == false and
  .probe.protocol == "massa-k-protocol-100" and
  .probe.status == "ready" and
  .reading.status == "ready" and
  .reading.stable == true and
  .reading.grossKg >= 0 and
  (.reading.divisionKg | IN(0.0001, 0.001, 0.01, 0.1, 1))
' "$EVIDENCE_DIR/scale-zero.json" >/dev/null
```

Exit `0` выдаётся только при корректных Protocol 100 identity/parameters, CRC, стабильном reading
и допустимой цене деления. Simulator и legacy adapter не могут дать этот physical exit `0`.

Сравнить число с табло. Расхождение не должно превышать одну показанную цену деления. Если табло
не на нуле, использовать только штатную пользовательскую процедуру обнуления из руководства весов;
не выполнять калибровку.

### 9.7. Gate B: известный неподвижный груз

1. Убедиться, что контрольный груз заведомо легче НПВ.
2. Поставить его по центру без удара.
3. Дождаться стабильного индикатора.
4. Выполнить:

```bash
if sudo plenka-gateway-probe > "$EVIDENCE_DIR/scale-load.json"; then
  SCALE_LOAD_RC=0
else
  SCALE_LOAD_RC=$?
fi
printf 'scale-load exit=%s\n' "$SCALE_LOAD_RC"
test "$SCALE_LOAD_RC" -eq 0
read -r -p 'Число на табло в кг, с точкой вместо запятой: ' DISPLAY_KG
jq -e --arg display "$DISPLAY_KG" '
  ($display | tonumber) as $shown |
  .reading.status == "ready" and
  .reading.stable == true and
  ((.reading.grossKg - $shown) |
    if . < 0 then -. else . end) <= .reading.divisionKg
' "$EVIDENCE_DIR/scale-load.json" >/dev/null
```

Если значение на табло `25,40`, ввести `25.40`. Не вводить ожидаемую массу из паспорта вместо
фактического табло.

### 9.8. Gate C: движущийся груз должен быть нестабильным

Этот шаг выполняют два человека: один безопасно и непрерывно шевелит контрольный груз, другой
запускает probe. Не двигать тяжёлый объект руками и не находиться под грузом.

```bash
if sudo plenka-gateway-probe > "$EVIDENCE_DIR/scale-moving.json"; then
  SCALE_MOVING_RC=0
else
  SCALE_MOVING_RC=$?
fi
printf 'scale-moving exit=%s\n' "$SCALE_MOVING_RC"
test "$SCALE_MOVING_RC" -eq 2
jq -e '
  .probe.simulated == false and
  .reading.status == "unstable" and
  .reading.stable == false
' "$EVIDENCE_DIR/scale-moving.json" >/dev/null
```

Если получен exit `0`, физический unstable gate не пройден. Убедиться, что груз действительно
двигался весь период чтения, повторить один раз безопасно; затем зафиксировать `FAIL`, а не
подменять результат.

### 9.9. Gate D: отключение и восстановление USB

1. Снять груз.
2. Отключить только communication USB, не кабель платформы/тензодатчика.
3. Выполнить probe:

```bash
if sudo plenka-gateway-probe > "$EVIDENCE_DIR/scale-unplugged.json"; then
  SCALE_UNPLUG_RC=0
else
  SCALE_UNPLUG_RC=$?
fi
printf 'scale-unplugged exit=%s\n' "$SCALE_UNPLUG_RC"
test "$SCALE_UNPLUG_RC" -ne 0
jq -e '.probe.ok == false or .probe.status == "offline"' \
  "$EVIDENCE_DIR/scale-unplugged.json" >/dev/null
```

В зависимости от места transport failure допустим безопасный non-zero exit `1` или `2`; exit `0`
при отключённом кабеле — `FAIL`.

4. Подключить тот же USB-кабель в тот же порт.
5. Выполнить:

```bash
sudo udevadm settle
test -L "$SCALE_PORT"
if sudo plenka-gateway-probe > "$EVIDENCE_DIR/scale-recovered.json"; then
  SCALE_RECOVER_RC=0
else
  SCALE_RECOVER_RC=$?
fi
printf 'scale-recovered exit=%s\n' "$SCALE_RECOVER_RC"
test "$SCALE_RECOVER_RC" -eq 0
```

Symlink должен восстановиться с тем же by-id именем. Новый by-id после обычного reconnect —
`FAIL/BLOCKED` до выяснения identity/cable/adapter.

### 9.10. Результат scale gate

Scale physical gate = `PASS`, только если одновременно:

- config mode = `massa-k-protocol-100`;
- zero probe exit `0` и совпадает с табло;
- load probe exit `0` и отклонение ≤ одной цены деления;
- moving probe exit `2`, `unstable`, `stable=false`;
- unplug probe non-zero;
- recovery по тому же by-id снова exit `0`;
- не использовались simulator, legacy `serial`, ручная подстановка roll weight или raw frame.

## 10. Подключить принтер MERTECH TLP4

### 10.0. Подтверждённый путь первого поста: USB + CUPS + ZPL

Для фактически проверенного комплекта используйте этот путь:

1. Подключите TLP4 к Ubuntu по USB.
2. Убедитесь, что устройство видно в `lsusb` и `lpinfo -v`.
3. Установите официальный MERTECH/HT600 Linux driver для 203 dpi.
4. Удалите автоматически созданную очередь с чужим драйвером вроде HP DesignJet.
5. Создайте одну CUPS queue `TLP4` на точном `usb://MERTECH/...` URI и официальном PPD.
6. Включите queue и назначьте её default: `cupsenable`, `cupsaccept`, `lpadmin -d TLP4`.
7. Переведите принтер в ZPL; режим материала должен соответствовать наличию риббона.
8. Установите `PRINTER_MODE=cups-zpl` и `PRINTER_CUPS_QUEUE=TLP4`.
9. Проверьте заранее известный ZPL: `lp -d TLP4 -o raw test-label.zpl`.
10. Только фактически вышедшая этикетка означает physical PASS.

Полные команды, симптомы и решения находятся в
[полевой базе знаний](./2026-07-21-physical-devices-field-knowledge.md#5-принтер-mertech-tlp4tlp42).

Разделы 10.1–10.4 ниже описывают **непроверенный альтернативный Ethernet transport**. На первом
посту их не выполнять и не смешивать с USB/CUPS.

### 10.1. Зафиксировать сетевую схему

Для первого теста рекомендован один switch и одна локальная подсеть:

- Ubuntu-пост получает адрес от цехового DHCP;
- TLP4 получает адрес от DHCP, после чего сетевой администратор закрепляет его по MAC;
- либо администратор задаёт принтеру статический адрес вне динамического пула;
- адрес принтера не публикуется в интернет;
- на роутере не создаётся port forward локального RAW port (`9100`/`6101`).

Нужно заполнить локальный лист, который не коммитится:

| Поле                 | Кто сообщает                                   |
| -------------------- | ---------------------------------------------- |
| подсеть/маска        | сетевой администратор                          |
| DHCP pool            | сетевой администратор                          |
| закреплённый IP TLP4 | сетевой администратор                          |
| MAC TLP4             | configuration/self-test page или администратор |
| RAW printing port    | `9100` или `6101`, подтверждённый ниже         |

Для модели TLP4 производитель также использует внутреннее обозначение `HT600`. В официальном
[руководстве по локальной сети](https://help.mertech.ru/label_printers/HT600_HT630/HT600_630_ethernet.html)
описан безопасный способ узнать адрес без сканирования всей сети:

1. подключить Ethernet-кабель к включённому принтеру;
2. убедиться, что внутри установлены этикетки;
3. зажать кнопку подачи бумаги (`Feed`) примерно на две секунды;
4. отпустить кнопку;
5. дождаться одной self-test/configuration page;
6. найти на ней IP, не фотографируя и не публикуя MAC/serial;
7. передать IP только администратору локального поста.

Если эта последовательность не печатает self-test, остановиться: шильдик/firmware может относиться
к другой ревизии. Не удерживать кнопки в случайных комбинациях. Для смены DHCP/static IP
официальная статья использует vendor utility и USB на отдельной административной машине; не
устанавливать непроверенную утилиту на промышленный пост и не менять сетевые параметры без
сетевого администратора.

### 10.2. Установить материал и выполнить калибровку

1. Выключить принтер.
2. Установить этикетки и риббон строго по маркировке и руководству TLP4.
3. Проверить, что media sensor находится в правильном положении для gap-этикетки.
4. Закрыть печатающую головку и крышку.
5. Включить принтер.
6. Выполнить штатную media calibration по официальному руководству этой ревизии.
7. Нажать штатный `Feed` один раз и убедиться, что вышла ровно одна этикетка, а следующий gap
   остановился у линии отрыва.

Не приводим выдуманную комбинацию кнопок: она должна быть подтверждена паспортом устройства.
Если `Feed` выдаёт несколько этикеток, принтер не откалиброван — platform test пока не запускать.

Текущий код формирует:

- roll label: `58 × 40 mm`, gap `2 mm`, одна копия, QR + roll code;
- pallet label: `100 × 150 mm`, одна копия, bitmap 800 dots wide при 203 dpi;
- `PRINTER_DPI=203`, `PRINTER_MAX_WIDTH_DOTS=864`.

Если фактический материал или язык принтера несовместимы, сначала требуется discovery/изменение
профиля и новый release. Нельзя объявлять физический PASS по пустой или обрезанной этикетке.

### 10.3. Проверить адрес, маршрут и реальный RAW port с Ubuntu-поста

Ввести локальный адрес без сохранения в shell history. Затем проверить только два документированных
кандидата: pilot default `9100` и vendor port `6101`. Это не сканирование сети и не отправка данных
на печать — `nc -z` только открывает и закрывает TCP-соединение.

```bash
read -r -p 'Локальный IP/hostname TLP4: ' PRINTER_HOST
ip route get "$PRINTER_HOST"
for candidate in 9100 6101; do
  if nc -zvw3 "$PRINTER_HOST" "$candidate"; then
    printf 'OPEN RAW candidate: %s\n' "$candidate"
  else
    printf 'closed/unreachable candidate: %s\n' "$candidate"
  fi
done
read -r -p 'Подтверждённый открытый RAW port (9100 или 6101): ' PRINTER_PORT
case "$PRINTER_PORT" in
  9100|6101) ;;
  *) printf 'STOP: разрешены только подтверждённые 9100 или 6101\n' >&2; false ;;
esac
nc -zvw3 "$PRINTER_HOST" "$PRINTER_PORT"
```

Ожидается exit `0` и сообщение об успешном соединении. `ping` может быть запрещён принтером и не
является обязательным. Если `nc` не проходит:

1. проверить питание и link lights принтера/switch;
2. проверить оба Ethernet-кабеля;
3. сверить адрес с configuration page;
4. убедиться, что пост и принтер находятся в маршрутизируемой локальной подсети;
5. сверить RAW port с self-test/официальным разделом exact TLP4 (HT600); не считать `6101`
   ошибкой только потому, что default агента равен `9100`;
6. исключить конфликт IP с сетевым администратором.

`Connection refused` обычно означает, что адрес достижим, но порт закрыт. `Timed out` обычно
означает неверный адрес, маршрут, firewall или кабель. Не отключать весь firewall ради теста.

Успешный `nc -z` доказывает **только открытый TCP-порт**. Запрещено отправлять TSPL через
`echo | nc`: это обходит gateway command, audit, idempotency и `delivery_unknown` semantics.

Вставить **оба** проверенных значения через `sudoedit`:

```bash
sudoedit /etc/plenka-gateway/agent.env
```

Должны получиться две отдельные строки без пробелов вокруг `=`:

```text
PRINTER_TCP_HOST=<проверенный-local-host-без-http-и-порта>
PRINTER_TCP_PORT=<проверенный-9100-или-6101>
```

`PRINTER_MODE` при этом остаётся `tcp9100`: это имя adapter mode, а не требование всегда ставить
число `9100`. Не менять принтер с `6101` на `9100` случайной service-командой только ради имени
режима.

### 10.4. Проверить физическую конфигурацию целиком

```bash
sudo /opt/plenka-gateway/node \
  --env-file=/etc/plenka-gateway/agent.env \
  /opt/plenka-gateway/main.js --check-config
```

Ожидается только `gateway configuration valid: physical`.

## 11. Подключить POScenter SG-110-BT как 2.4G HID

### 11.1. Понять границу сканера

Сканер в первом release **не отправляет данные через gateway-agent**. Донгл представляется Ubuntu
как клавиатура. Когда в Chromium активно поле QR, сканер «нажимает» символы и затем `Enter`.

Это значит:

- служба агента может быть остановлена, а scanner typing всё равно виден;
- сканер не должен появиться как serial port;
- QR не пишется в `agent.env` и не попадает в journal агента;
- platform scanner device ID — каталог/привязка, а не Linux device path;
- физическое доказательство — строка, введённая настоящим лучом/камерой сканера в пустое поле.

Не нажимать admin-кнопку «Тест» для scanner как замену этому шагу: текущий Ubuntu agent исполняет
gateway-команды только для scale и printer, а HID-сканер принадлежит браузеру. Ответ
`misconfigured` от gateway scanner test означает отсутствие agent-owned scanner transport; он не
проверяет и не опровергает работу USB-HID. Авторитетный gate ниже выполняется в Text Editor и затем
в реальном пустом scan input Chromium.

### 11.2. Вставить донгл и проверить pairing

1. Зарядить сканер.
2. Прочитать на корпусе/паспорте точное название `POScenter SG-110-BT`.
3. Вставить именно комплектный 2.4G USB-приёмник/подключённый кредл в USB Ubuntu-поста.
4. Не использовать визуально похожий донгл от другого сканера.
5. Разместить сканер рядом с приёмником для первого pairing.
6. Включить сканер и подождать до 30 секунд.
7. Открыть пустой несохраняемый документ и один раз отсканировать обычный товарный QR.
8. Если символы появились, автоматическое соединение уже работает — **не сканировать никакие
   setup barcodes**.
9. Только если автоматического соединения нет, открыть
   [официальное руководство POScenter SG-110-BT версии 1.0](https://pos-center.ru/files/downloads/instructions/instruction_sg-110-bt.pdf):
   - сначала выполнить раздел страниц 5–7 о возврате в беспроводной `2.4G HID-клавиатура`;
   - если связи всё ещё нет, использовать на странице 13 barcode «Принудительное соединение с
     USB-приёмником»/«Подключение сканера к базе (донглу) в режиме HID-клавиатуры»;
   - после каждого изменения снова проверить обычный QR в пустом документе.

Не переводить его наугад в Bluetooth или virtual COM. Если документа нет и pairing не происходит,
статус `BLOCKED: нужен официальный setup sheet SG-110-BT`.

Для локальной диагностики можно сравнить список до и после подключения:

```bash
lsusb
```

Вывод использовать только локально; USB serial/identity не помещать в evidence.

### 11.3. Настроить HID-режим и suffix Enter

По официальному руководству версии 1.0 подтвердить:

- интерфейс `2.4G HID keyboard`;
- один scan → один payload;
- prefix отсутствует;
- suffix равен ровно `CR`, который Chromium воспринимает как клавишу `Enter`;
- continuous/multiple-read выключен для первого smoke;
- нужные QR/штрих-код symbologies включены.

Если после обычного QR курсор уже переходит ровно на одну новую строку, suffix настроен и менять
его не нужно. Если перехода нет:

1. открыть страницы 31–33 **того же официального PDF версии 1.0**;
2. найти barcode «Добавить только суффикс CR для всех штрих-кодов»;
3. выполнить вход/выход из режима настройки именно так, как показано на этих страницах;
4. отсканировать этот config barcode ровно один раз;
5. снова проверить обычный QR в новом пустом документе.

Не добавлять CR одновременно в беспроводной модуль и сканирующий модуль. Руководство прямо
предупреждает избегать двойного применения одинакового suffix. Две новые строки или два submit
означают `FAIL`: удалить дублирующий suffix по страницам 21–22/31–37, а не компенсировать это во
frontend.

Точные изображения setup barcodes в этот документ намеренно не копируются: у разных ревизий они
могут различаться. После изменения записать `POScenter SG-110-BT manual v1.0` и использованную
страницу, но не фотографировать сам конфигурационный barcode.

### 11.4. Проверить в пустом текстовом редакторе

1. Переключить раскладку Ubuntu на английскую.
2. Открыть «Text Editor»/`gedit`.
3. Создать новый пустой документ.
4. Щёлкнуть в пустой документ и убедиться, что виден курсор.
5. Для первичной HID-проверки взять обычный **не конфигурационный** QR с тестовой строкой, не
   содержащей password/token/коммерческие данные. Не использовать vendor setup barcode: он меняет
   настройки вместо ввода текста.
6. Нажать trigger сканера ровно один раз.
7. Не касаться клавиатуры во время скана.

PASS локального HID-теста:

- появилась ровно одна строка;
- строка не пустая и не удвоена;
- нет prefix/suffix символов, кроме завершающего `Enter`;
- после ввода курсор перешёл на новую строку — это подтверждает `Enter`;
- символы не искажены раскладкой;
- строка появилась только после фактического сканирования.

Закрыть документ **без сохранения**. Не фотографировать и не копировать payload в issue.

Если символы неправильные, сначала проверить английскую раскладку. Если нет `Enter`, использовать
официальный barcode настройки suffix. Если скан дублируется, отключить continuous mode по manual.

### 11.5. Правило фокуса в Chromium

Сканер вводит текст туда, где находится курсор. Перед каждым фактическим сканом:

1. дождаться именно шага QR;
2. убедиться, что поле пустое;
3. нажать/тапнуть в поле;
4. увидеть курсор/визуальный focus;
5. не нажимать другие элементы до завершения скана;
6. сканировать один раз.

Автоподстановка expected QR, paste из документации, ввод с клавиатуры и заранее заполненное поле
дают `FAIL` scanner gate, даже если backend принял строку.

## 12. Запустить gateway-agent

До запуска должны проходить:

- trusted VPS curl без `-k`;
- `gateway configuration valid: physical`;
- scale zero/load/moving/unplug/recovery gates;
- подтверждённый RAW port принтера прошёл `nc -zvw3` в разделе 10.3;
- локальный HID scanner test.

### 12.1. Проверить, что агент не открывает входящий порт

Сохранить только локальный baseline listeners:

```bash
sudo ss -ltnup
```

Не копировать весь вывод в общий чат. После запуска повторить и убедиться, что новая служба не
добавила listening socket.

### 12.2. Включить службу

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now plenka-gateway.service
sudo systemctl is-enabled plenka-gateway.service
sudo systemctl is-active plenka-gateway.service
sudo systemctl status plenka-gateway.service --no-pager
```

Ожидается `enabled`, `active` и отсутствие restart loop.

Посмотреть последние записи:

```bash
sudo journalctl -u plenka-gateway.service --since '10 minutes ago' --no-pager
```

Допустимые смысловые признаки:

- `gateway agent started`;
- правильный `POST-1`;
- `scaleMode=massa-k-protocol-100`;
- `printerMode=cups-zpl`;
- `platform reachable`;
- heartbeat обновляется на VPS.

В journal не должно быть token, пароля, QR, raw Protocol 100 frame или содержимого label. Если
секрет всё-таки попал в лог, остановить службу, ограничить доступ к журналу, rotate token и открыть
security incident; не пересылать строку дальше.

### 12.3. Проверить outbound-only

```bash
sudo ss -ltnup
```

Сравнить с baseline. `plenka-gateway` не должен слушать TCP/UDP порт. Не требуется менять UFW,
открывать входящий порт или настраивать NAT.

### 12.4. Проверить admin status

1. С отдельной admin-сессии открыть «Посты».
2. Обновить страницу.
3. `POST-1` должен стать `online` после свежего heartbeat.
4. Открыть «Качество» и проверить свежий `lastSeenAt`.
5. Открыть «Устройства» и убедиться, что scale/printer относятся к `POST-1`.

Статус принтера до реальной печати — только last-known transport status. Он не доказывает, что
этикетка вышла. Scanner HID вообще проверяется в браузере, а не heartbeat агента.

### 12.5. Если service не запускается

```bash
sudo systemctl status plenka-gateway.service --no-pager
sudo journalctl -u plenka-gateway.service -n 100 --no-pager
sudo /opt/plenka-gateway/node \
  --env-file=/etc/plenka-gateway/agent.env \
  /opt/plenka-gateway/main.js --check-config
```

Частые причины:

- `invalid` — placeholder, неверный URL/mode/token/ID/port;
- `Permission denied` — пользователь не имеет `dialout`/доступа к serial;
- `401` — token неверный, отозван или принадлежит другому посту;
- TLS error — недоверенный сертификат/неверное время;
- restart loop — не продолжать физические команды, сначала исправить причину.

### 12.6. Обязательная проверка после полной перезагрузки Ubuntu-поста

Первый test-ready пост должен восстановиться после обычного отключения питания/перезагрузки без
ручного запуска агента. Этот gate выполнять до production roll cycle:

1. Убедиться, что оператор ещё не открыл смену либо уже безопасно завершил тестовый цикл.
2. Убедиться, что нет выполняющейся print command и никто не держит груз в движении.
3. Снять контрольный груз с весов.
4. Закрыть несохранённые документы Text Editor.
5. Выполнить:

```bash
sudo systemctl is-enabled plenka-gateway.service
sudo systemctl is-active plenka-gateway.service
sudo reboot
```

Terminal/SSH разорвётся — это ожидаемо. Подождать загрузки Ubuntu, войти тем же локальным
пользователем и открыть новый Terminal. **Не выполнять `systemctl start` вручную.** Проверить:

```bash
sudo systemctl is-enabled plenka-gateway.service
sudo systemctl is-active plenka-gateway.service
sudo systemctl status plenka-gateway.service --no-pager
sudo journalctl -u plenka-gateway.service -b --no-pager -n 100
```

Ожидается `enabled` и `active`; в journal текущей загрузки есть нормальный старт без restart loop,
secret или raw payload.

Проверить, что стабильный serial path из root-конфига существует и доступен службе, не печатая
весь `agent.env`:

```bash
SCALE_PORT="$(sudo awk -F= '$1 == "SCALE_SERIAL_PORT" { print substr($0, index($0, "=") + 1); exit }' \
  /etc/plenka-gateway/agent.env)"
case "$SCALE_PORT" in
  /dev/serial/by-id/*) ;;
  *) printf 'FAIL: в конфиге нет стабильного by-id\n' >&2; false ;;
esac
test -L "$SCALE_PORT"
sudo runuser -u plenka-gateway -- test -r "$SCALE_PORT"
sudo runuser -u plenka-gateway -- test -w "$SCALE_PORT"
```

Не запускать `plenka-gateway-probe`, пока служба активна: она уже владеет serial port. Вместо этого:

1. в admin → «Посты» дождаться свежего heartbeat `POST-1`;
2. убедиться, что stale/offline перешёл в online без ручной правки БД;
3. в admin → «Устройства» убедиться, что scale/printer остаются привязаны к `POST-1`;
4. открыть новый пустой несохраняемый Text Editor;
5. отсканировать обычный не-конфигурационный QR и подтвердить одну строку + один `Enter`;
6. закрыть документ без сохранения;
7. открыть trusted frontend в Chromium и убедиться, что HTTPS работает без warning.

PASS reboot gate означает одновременно: agent auto-start, тот же `/dev/serial/by-id`, сохранённый
2.4G HID pairing/suffix, восстановленный heartbeat и доступный frontend. Если сканер требует
повторного pairing после каждого reboot или serial by-id меняется, это `FAIL/BLOCKED`, а не
«особенность запуска».

## 13. Физический test label TLP4

### 13.1. Подготовка

1. Убедиться, что print tray свободен.
2. Отметить текущее количество этикеток визуально.
3. Убедиться, что операторский production print ещё не запускался.
4. Открыть admin → «Устройства» → строка принтера `POST-1`.

### 13.2. Отправить ровно одну setup label

1. Нажать «Тест» **один раз**.
2. Не нажимать повторно, пока команда выполняется.
3. Дождаться результата команды.
4. Физически посмотреть на TLP4.

Gateway формирует специальную этикетку `PLENKA-SETUP-TEST`. Даже успешная отправка возвращает
`physical_pending`, `physicalPass=false`, `confirmationRequired=true`: CUPS не умеет доказать, что
бумага реально вышла.

Printer gate setup PASS только если:

- вышла ровно одна этикетка;
- материал остановился на правильном gap;
- печать не пустая и не обрезана;
- текст читаем;
- QR фактически считывается SG-110-BT;
- не было второй самопроизвольной копии.

Setup-label QR проверяется **не в операторском поле**:

1. открыть новый пустой несохраняемый документ Text Editor;
2. щёлкнуть в него и увидеть курсор;
3. отсканировать физически вышедшую `PLENKA-SETUP-TEST` label ровно один раз;
4. убедиться, что появилась одна непустая строка и один переход на новую строку;
5. закрыть документ без сохранения.

QR setup-label не является QR реального рулона. Его ввод в live operator/warehouse workflow может
создать ошибочный бизнес-запрос и не считается scanner PASS. Скриншот/копию payload не сохранять.

### 13.3. Если label не вышла или результат неоднозначен

Не нажимать «Тест» снова. Проверить:

1. нет ли уже этикетки внутри/в выходном лотке;
2. material/ribbon/head lock;
3. calibration и sensor;
4. `lpstat -p -d` и `lpstat -v TLP4`;
5. journal агента без пересылки секретов;
6. admin command status.

Если байты могли уйти, это `delivery_unknown`: автоматический retry запрещён, потому что может
выйти дубликат. Для business label судьба задания устанавливается через документированную admin
reconciliation; reasoned reprint разрешается только после `not_printed`. Setup test при
неопределённом исходе остановить и разобрать до повторной команды.

### 13.4. Если печать физически неправильная

- пустая этикетка: проверить сторону риббона/media type по manual;
- смещение/несколько этикеток: повторить штатную calibration;
- обрезанный макет: сверить реальный размер материала с `58 × 40 mm`;
- нечитаемый QR: проверить darkness/speed/головку/материал по manual;
- набор команд вместо изображения: принтер не в ZPL либо job ушёл не как raw; проверить queue,
  language и `-o raw`.

Не менять макет случайными командами на production-посту.

## 14. Сквозной операторский цикл

### 14.1. Открыть сайт

1. На Ubuntu-посту открыть Chromium.
2. Ввести frontend origin без `/api`.
3. Убедиться, что нет TLS warning.
4. Не использовать `--ignore-certificate-errors`.
5. При первом тесте не включать kiosk, пока обычный режим не прошёл полностью.

Версию Chromium можно посмотреть:

```bash
chromium --version 2>/dev/null || chromium-browser --version 2>/dev/null || \
  snap run chromium --version
```

После успешной приёмки kiosk можно настраивать отдельным эксплуатационным шагом, например
запуском trusted URL с `--kiosk`; это не часть physical PASS и не должно скрывать браузерные
ошибки первого теста.

### 14.2. Проверить плановую смену

1. Войти назначенным реальным оператором.
2. Убедиться, что интерфейс показывает назначенное рабочее место `POST-1`.
3. Убедиться, что состояние равно «Нужен старт», а не «Смена открыта».
4. Сверить, что оператор и станок заранее назначены начальником производства.
5. Не создавать новую смену/назначение из operator UI.

Если нет назначения — обращается начальник производства. Если смена уже active — тест остановить:
не открывать вторую session и не исправлять таблицы SQL.

### 14.3. Безопасно открыть смену с Big-bag

1. Выбрать `PILOT-BAG-PHYSICAL-001`.
2. Физически взвесить его на приборе с достаточной грузоподъёмностью.
3. Сверить единицы измерения — килограммы.
4. Ввести **фактическое** число с табло в «Стартовый вес Big-bag».
5. Один раз нажать «Открыть смену».
6. Дождаться success и обновления страницы.

Ручной ввод разрешён только для фактически взвешенного Big-bag и всегда аудируется. Значение
`500` из seed — учётная заготовка, не физическое evidence.

После success сервер должен атомарно:

- создать active operator-on-post session на `POST-1`;
- перевести плановую смену в `open`;
- перевести назначение в `locked`/заполнить `lockedAt`;
- создать использование выбранного Big-bag;
- записать append-only audit.

Повторный клик, параллельная вкладка, ручная admin-session или SQL запрещены.

### 14.4. Выполнить рулонный цикл

1. Выбрать только назначенный `PILOT-PHYSICAL-ROLL-001`.
2. Проверить, что UI показывает `POST-1` и физические устройства.
3. Запустить предусмотренный шаг веса шпули, если он требуется текущим runtime.
4. Снять физический стабильный вес; браузер не должен иметь поля ручного roll weight.
5. Запустить шаг веса рулона.
6. Дождаться стабильного результата МАССА-К.
7. Сверить отображённое число с табло в пределах одной цены деления.
8. Unstable/offline/timeout должны дать честную ошибку и блокировать продолжение.
9. Подтвердить вес только один раз.
10. Запросить печать ровно одной roll label.
11. Дождаться состояния `submitted/awaiting scan`.
12. Физически убедиться, что TLP4 выдал ровно одну правильную этикетку.

`submitted` не означает `printed`. Физическая печать подтверждается человеком и последующим
точным сканом.

### 14.5. Фактически отсканировать напечатанную label

1. Дождаться формы «Сканирование наклеенного QR».
2. Убедиться, что поле пустое.
3. Тапнуть поле и увидеть focus/cursor.
4. Не копировать expected token и не открывать admin raw diagnostics.
5. Поднести SG-110-BT к реальной вышедшей этикетке.
6. Нажать trigger один раз.
7. Дождаться автоматического `Enter` и ответа backend.

PASS:

- backend принял точный фактически введённый opaque payload;
- строка не была видна/подставлена заранее;
- повторный или изменённый scan не меняет подтверждённый факт;
- рулон перешёл на следующий бизнес-шаг;
- reload страницы сохраняет вес, scan и audit.

### 14.6. Закрытие смены

Для полного smoke закрывать смену только после завершения согласованного набора операций:

1. нажать «Сдать смену»;
2. физически взвесить каждый использованный Big-bag безопасным подходящим прибором;
3. ввести каждый фактический конечный вес;
4. подтвердить закрытие один раз;
5. проверить balance result и возможную problem escalation;
6. убедиться, что active session закрыта.

Нельзя придумывать конечный вес для получения зелёного balance.

## 15. Проверка отказов и восстановления

Эти шаги выполняются после первого успешного нормального цикла на отдельной тестовой операции.

### 15.1. Принтер offline до отправки

1. Убедиться, что нет in-flight print.
2. Отключить USB принтера или питание.
3. Запросить отдельную тестовую печать.
4. Ожидать `failed/offline/503`, без `submitted` и без перехода дальше.
5. Убедиться, что агент автоматически не повторяет физическую команду.
6. Восстановить кабель/питание.
7. Проверить `lpstat -p -d` и `lpstat -v TLP4`.
8. В admin выполнить `Recovery` с непустой причиной.
9. Выполнить новый reasoned reprint по разрешённому workflow.
10. Получить ровно одну label и фактически отсканировать её.

Audit должен содержать failure, recovery и reprint reason. Бизнес-роли не видят raw.

### 15.2. Неоднозначная доставка `delivery_unknown`

Если связь оборвалась после начала отправки байтов:

1. не нажимать print/reprint;
2. проверить, вышла ли label физически;
3. admin выполняет reconciliation задания;
4. `label_observed` разрешает только точный scan существующей label;
5. `not_printed` разблокирует reasoned reprint;
6. решение и причина попадают в audit.

### 15.3. Весы offline и recovery при работающем агенте

Не запускать standalone probe одновременно со службой.

1. Убедиться, что нет активного read command.
2. Отключить communication USB.
3. В UI запросить вес.
4. Ожидать честную ошибку, без manual roll weight fallback.
5. Вернуть USB и дождаться того же by-id.
6. В admin выполнить `Recovery`/`Тест`.
7. Физический scale test должен снова показать Protocol 100 и `physicalPass=true` только после
   стабильного чтения.

Если нужен локальный `plenka-gateway-probe`, сначала:

```bash
sudo systemctl stop plenka-gateway.service
sudo plenka-gateway-probe
sudo systemctl start plenka-gateway.service
```

### 15.4. Потеря интернета/VPS

Gateway содержит durable journals для ingest events и результатов команд. Это не означает, что
оператор может продолжать весь браузерный workflow без VPS.

1. До отключения убедиться, что физическая print-команда не in-flight.
2. Временно отключить только uplink поста согласованным способом.
3. Проверить, что агент не падает навсегда и журнал сообщает `platform unreachable` один раз при
   переходе состояния.
4. Не запускать новые физические print-команды из обходного интерфейса.
5. Восстановить uplink.
6. Убедиться, что `platform reachable` восстановлен, heartbeat свежий, сохранённые результаты
   доставлены идемпотентно.

Проверить только метаданные durable state, не содержимое:

```bash
sudo find /var/lib/plenka-gateway -maxdepth 1 -type f \
  -printf '%u %g %m %f %s bytes\n'
```

Не выполнять `cat`, `truncate` или `rm` для `events.jsonl`, `command-results.jsonl`, `.corrupt` и
`.quarantine` до инженерного разбора.

### 15.5. Heartbeat stale/offline/recovered

1. Остановить агент:

```bash
sudo systemctl stop plenka-gateway.service
```

2. В admin наблюдать переход `online → stale → offline` по фактическому `lastSeenAt`.
3. Порог берётся из VPS `GATEWAY_STALE_AFTER_SEC`/`GATEWAY_OFFLINE_AFTER_SEC`; не угадывать его.
   Значения по умолчанию в коде — 90 и 300 секунд, но VPS может быть настроен иначе.
4. Запустить агент:

```bash
sudo systemctl start plenka-gateway.service
```

5. Убедиться в новом heartbeat и `online/recovered`.

## 16. Проверка склада

1. Корректно завершить/выйти из operator browser session.
2. Войти реальным warehouse-пользователем.
3. При необходимости привязать warehouse session к согласованному посту поддерживаемым UI.
4. Открыть приёмку ожидаемого `PILOT-PHYSICAL-ROLL-001`.
5. Убедиться, что QR input пустой и сфокусирован.
6. Фактически отсканировать ту же physical label.
7. Ожидать `accepted`.
8. Повторно отсканировать её для контролируемой проверки — ожидать `duplicate`, без второго факта.
9. Чужой тестовый код должен дать `wrong`, не менять accepted row.
10. Если warehouse flow требует контрольный вес, получить его физически; ручную подстановку не
    использовать.
11. Завершить приёмку явным подтверждением.
12. Reload/restart API не должен терять результат.

После приёмки production, warehouse cover, payment и shipment остаются независимыми индикаторами;
тест не закрывает заказ одним общим статусом.

## 17. Cross-post и raw boundary

### 17.1. Cross-post isolation

Негативную проверку выполняет backend/admin reviewer, не оператор:

- token/agent `POST-1` не может получить или завершить команду другого поста;
- он не может изменить чужой device binding или event;
- сервер отвечает 403/404 без утечки существования чужого объекта;
- device ID в команде должен совпадать с локально настроенным ID, иначе агент возвращает
  `misconfigured` и не вызывает физическое устройство.

Нельзя проверять изоляцию, подменяя token в browser DevTools или публикуя два token в скрипте.

### 17.2. Raw payload boundary

Проверить реальными role sessions:

- admin diagnostics видит разрешённую диагностическую запись/safe projection;
- operator, warehouse, commercial, production и director не видят `rawPayload`, raw frame,
  agent token hash, expected opaque QR или serial identity;
- эти поля отсутствуют в UI, обычном API, export и browser console/network response бизнес-роли.

Если raw оказался у бизнес-роли, общий тест = `FAIL` независимо от работы железа.

## 18. Подробная диагностика частых проблем

| Симптом                                 | Что проверить                                                                       | Что нельзя делать                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `gateway configuration invalid`         | HTTPS `/api`, physical, Protocol 100, `4800/even`, cups-zpl/TLP4, token, IDs, by-id | печатать весь env, включать simulator                        |
| Agent получает 401                      | token выпущен для POST-1, не ротирован после записи, нет лишнего пробела            | вставлять token в curl/чат                                   |
| TLS/certificate error                   | NTP=`yes`, правильный host, доверенная цепочка, curl без `-k`                       | `--insecure`, отключение проверки TLS                        |
| `/dev/serial/by-id` отсутствует         | питание весов, communication USB, кабель, `udevadm settle`, USB-порт                | выбирать `/dev/ttyUSB0`, `chmod 777`                         |
| Probe `Permission denied`               | `id plenka-gateway`, группа `dialout`, владелец реального tty                       | запускать постоянную службу от root                          |
| Probe exit `1`                          | transport/config/cleanup failure; локально изучить безопасный JSON                  | считать это hardware PASS                                    |
| Probe exit `2` на стабильном грузе      | unstable/offline/неполный physical evidence                                         | включать `SCALE_ASSUME_STABLE=on`                            |
| Лёгкий вес есть, тяжёлый не фиксируется | Protocol 100 мог вернуть массу с `Stable=0`; `dYn` для человека, `StAt` для рулона  | отключать проверку стабильности                              |
| Moving probe exit `0`                   | груз не двигался весь timeout или stable bit неверен                                | переписать evidence как unstable                             |
| `nc` timeout                            | IP, route, cable, switch, VLAN, printer power, confirmed RAW port 9100/6101         | выключать firewall целиком, открывать RAW port наружу        |
| `nc` OK, label нет                      | TCP — не печать; media/ribbon/calibration/language/outcome                          | бесконечно нажимать «Тест»                                   |
| USB/CUPS печатает чёрную полосу         | чужой PPD, plain text вместо ZPL, не-raw job, неверный язык/размер                  | считать CUPS request физической печатью                      |
| Label пустая/обрезана                   | ribbon side, media size, sensor, ZPL/raw queue                                      | отправлять случайные команды в `nc`                          |
| Scanner ничего не вводит                | заряд, 2.4G pairing, HID mode, донгл, focus                                         | вводить expected QR руками                                   |
| Scanner вводит кракозябры               | English layout, HID keyboard profile, manual revision                               | менять QR в базе                                             |
| Scanner не отправляет форму             | suffix Enter и focus                                                                | постоянно нажимать Enter вручную и называть это scanner PASS |
| Scanner вводит дважды                   | continuous mode/single trigger по manual                                            | принимать duplicate как нормальный первый scan               |
| POST-1 stale/offline                    | service, trusted HTTPS, token, clock, journal transitions                           | вручную ставить online в БД                                  |
| Смена уже открыта после login           | существующая active session, baseline seed/cutover                                  | создавать вторую session, UPDATE SQL                         |
| Оператор не видит смену                 | production lead assignment, operator identity, planned window                       | назначать себя через operator UI                             |
| Print завис после network loss          | result outbox, command status, physical label, reconciliation                       | повторять print до выяснения outcome                         |

## 19. Evidence: что сохранить и что удалить

Сохранить в контролируемый test record:

- backend/frontend/package commit или image SHA;
- SHA-256 verification = PASS;
- Ubuntu/agent versions;
- UTC начала/окончания;
- safe status facts и HTTP status class;
- Protocol `massa-k-protocol-100`, `simulated=false`, без identity;
- scale deviation в количестве делений;
- moving/unplug/recovery outcomes;
- количество фактически вышедших labels;
- scanner actual-input PASS без payload;
- PASS/FAIL/BLOCKED и краткую причину.

Не сохранять:

- token/password/cookie/session;
- raw frame/USB identity/scale ID/MAC;
- полный local IP inventory;
- QR/label payload;
- содержимое durable outbox;
- коммерческие данные и фотографии продукции.

После извлечения только redacted facts удалить временные scale JSON:

```bash
find "$EVIDENCE_DIR" -type f -delete
rmdir "$EVIDENCE_DIR"
unset EVIDENCE_DIR SCALE_ZERO_RC SCALE_LOAD_RC SCALE_MOVING_RC SCALE_UNPLUG_RC SCALE_RECOVER_RC
unset DISPLAY_KG PRINTER_HOST PRINTER_PORT PLATFORM_ORIGIN SCALE_PORT SCALE_PORTS
unset DEB DEBS NEW_DEB NEW_DEBS
```

Не удалять `/var/lib/plenka-gateway` до завершения разбора — там может быть единственная копия
неподтверждённого результата команды.

## 20. Итоговая матрица

| Gate                                             | Статус    | Evidence/примечание          |
| ------------------------------------------------ | --------- | ---------------------------- |
| VPS trusted HTTPS/login без bypass               | `PENDING` |                              |
| Planned shift/assignment, zero active session    | `PENDING` |                              |
| Verified `.deb` SHA-256/version/amd64            | `PENDING` |                              |
| Physical config valid, no placeholders           | `PENDING` |                              |
| Agent outbound-only + fresh heartbeat            | `PENDING` |                              |
| Ubuntu reboot: agent/by-id/HID/heartbeat recover | `PENDING` |                              |
| Protocol 100 identity + complete parameters      | `PENDING` |                              |
| Stable zero/display agreement                    | `PENDING` |                              |
| Stable known load ≤ 1 division                   | `PENDING` |                              |
| Moving load = unstable/non-PASS                  | `PENDING` |                              |
| USB unplug = non-PASS, same by-id recovery       | `PENDING` |                              |
| TLP4 USB/CUPS queue + raw ZPL                    | `PENDING` | заполнить для текущего поста |
| One physical setup label, readable QR            | `PENDING` |                              |
| SG-110-BT 2.4G HID + Enter                       | `PENDING` |                              |
| Operator self-connects to planned shift          | `PENDING` |                              |
| Physical roll weight → one label → actual scan   | `PENDING` |                              |
| Printer failure/recovery/reprint audit           | `PENDING` |                              |
| Agent/VPS outage recovery/idempotency            | `PENDING` |                              |
| Warehouse actual scan/duplicate handling         | `PENDING` |                              |
| Cross-post isolation                             | `PENDING` |                              |
| Raw payload role boundary                        | `PENDING` |                              |

Общий статус равен `PASS` только если все обязательные строки имеют фактический PASS. Отсутствие
устройства, неподтверждённый vendor protocol/menu, simulator или невозможность выполнить шаг
оставляют `PENDING/BLOCKED`.

## 21. Что делать после теста

### 21.1. Если пост остаётся в пилотной эксплуатации

```bash
sudo systemctl is-enabled plenka-gateway.service
sudo systemctl is-active plenka-gateway.service
sudo systemctl status plenka-gateway.service --no-pager
```

Оставить службу `enabled/active`, сохранить root-owned config и durable state. Не копировать env в
backup без шифрования и согласованной политики.

### 21.2. Если тестовый пост временно выключается

```bash
sudo systemctl disable --now plenka-gateway.service
sudo systemctl is-enabled plenka-gateway.service || true
sudo systemctl is-active plenka-gateway.service || true
```

Ожидается `disabled/inactive`. Затем владелец VPS решает, нужно ли rotate token. Если token мог
быть раскрыт, rotation обязательна.

### 21.3. Upgrade пакета

Положить только новый `.deb` и его `.sha256` в пустую release-папку, затем:

```bash
cd "$HOME/plenka-gateway-release"
mapfile -t NEW_DEBS < <(find . -maxdepth 1 -type f \
  -name 'plenka-gateway-agent_*_amd64.deb' -print | sort)
test "${#NEW_DEBS[@]}" -eq 1
NEW_DEB="${NEW_DEBS[0]}"
test -f "${NEW_DEB}.sha256"
sha256sum -c "${NEW_DEB}.sha256"
sudo apt install "$NEW_DEB"
dpkg-query -W -f='${Package} ${Version} ${Architecture}\n' plenka-gateway-agent
sudo systemctl status plenka-gateway.service --no-pager
```

Upgrade сохраняет `/etc/plenka-gateway` и `/var/lib/plenka-gateway`. Если служба была активна,
package scripts останавливают и запускают её вокруг upgrade. После обновления повторить config,
heartbeat и сокращённый physical regression.

### 21.4. Удаление пакета

Обычное удаление отключает службу, но намеренно сохраняет конфиг и durable state:

```bash
sudo apt remove plenka-gateway-agent
```

Не удалять `/etc/plenka-gateway` и `/var/lib/plenka-gateway` автоматически. Ручное удаление
разрешено только после:

1. остановки службы;
2. подтверждения/сверки всех pending command outcomes;
3. сохранения разрешённого redacted evidence;
4. ротации/revoke token;
5. письменного разрешения владельца поста.

Глобальный journal не ротировать и не очищать ради красивого теста. Simulator никогда не
превращать в physical PASS.
