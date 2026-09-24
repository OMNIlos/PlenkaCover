# запуск локального демо на Windows

## 1. Что нужно установить заранее

Установите:

- Node.js 20 LTS: https://nodejs.org
- Docker Desktop: https://www.docker.com/products/docker-desktop/
- драйвер USB-COM адаптера весов, если весы подключаются через RS-232/USB-COM;
- драйвер принтера, если принтер подключается по USB через Windows.

После установки перезагрузите компьютер, если установщик драйвера или Docker этого попросит.

## 2. Распаковка

Распакуйте архив в папку, например:

```text
C:\plenka\protected-demo
```

Не запускайте проект прямо из zip-архива. Сначала распакуйте.

## 3. Установка demo

Откройте cmd в папке `protected-demo` и выполните:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

- установит нужные библиотеки;
- поднимет локальную базу Postgres в Docker;
- применит миграции базы;
- создаст демо-пользователей, посты, устройства и демо-заказ.

Если Docker Desktop ещё запускается, дождитесь его готовности и повторите команду.

## 4. Настройка устройств

Файл настроек:

```text
apps\gateway-agent\.env
```

### Физические весы МАССА-К через Protocol 100

В файле `apps\gateway-agent\.env` укажите:

```env
SCALE_MODE=massa-k-protocol-100
SCALE_SERIAL_PORT=COM3
SCALE_SERIAL_BAUD=57600
SCALE_READ_TIMEOUT_MS=1500
```

Подключение USB virtual COM не требует настройки режима терминала. Для резервного прямого
RS-232 выберите в терминале режим `1C`, скорость `57600` и формат `8-N-1`.

Где найти COM-порт:

1. Нажмите `Win + X`.
2. Откройте `Диспетчер устройств`.
3. Откройте `Порты (COM и LPT)`.
4. Найдите строку вида `USB-SERIAL CH340 (COM3)`.
5. Значение `COM3` укажите в `SCALE_SERIAL_PORT`.

### Вариант без физических устройств

Для demo без железа явно установите:

```env
SCALE_MODE=simulated
PRINTER_MODE=simulated
```

Так demo будет работать без весов и принтера; физическая проверка весов будет пропущена.

### Принтер по сети

Если принтер подключён по Ethernet и печатает через RAW-порт 9100:

```env
PRINTER_MODE=tcp9100
PRINTER_TCP_HOST=192.168.1.50
PRINTER_TCP_PORT=9100
```

Замените `192.168.1.50` на IP-адрес принтера.

### Принтер через Windows

Если принтер подключён по USB и настроен в Windows:

```env
PRINTER_MODE=windows-command
PRINTER_WINDOWS_COMMAND=print /D:"\\localhost\TLP4" {file}
```

`TLP4` замените на имя общего принтера в Windows.

### Сканер

Сканер работает как клавиатура. Отдельно в агенте он не настраивается.

Проверка:

1. Откройте Блокнот.
2. Поставьте курсор в документ.
3. Отсканируйте QR.
4. Если текст появился в Блокноте, на сайте сканер будет работать так же.

## 5. Запуск demo

В cmd из папки `protected-demo`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-demo.ps1
```

Откройте в браузере:

```text
http://localhost:5173
```

Backend:

```text
http://localhost:3000/api
```

Swagger/API-документация:

```text
http://localhost:3000/api/docs
```

## 6. Логины

Пароль по умолчанию:

```text
plenka-dev
```

Пользователи:

```text
operator
warehouse
commercial
production
finance
director
admin
```

Для проверки цикла с весами и этикетками зайдите как:

```text
operator / plenka-dev
```

## 7. Проверка устройств

После запуска demo выполните:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\test-hardware.ps1
```

Скрипт проверит:

- доступность backend;
- физический Protocol 100 через prebuilt `apps\gateway-agent\dist\probe-scale.js`;
- авторитетный ответ весов `ready + stable`;
- доступность принтера.

Для физических весов проверка успешна только при коде `0` безопасного probe. Ошибка запуска,
неавторитетный ответ или некорректная JSON-проекция завершают проверку с ошибкой. Режим
`SCALE_MODE=simulated` явно пропускает проверку весов и предназначен только для demo без железа.

Для тестовой печати этикетки:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\test-hardware.ps1 -PrintTest
```

## 8. Как понять, что всё работает

Минимальный успешный сценарий:

1. `start-demo.ps1` запустил API, frontend и gateway-agent.
2. Открывается `http://localhost:5173`.
3. Вход `operator / plenka-dev` успешен.
4. `test-hardware.ps1` показывает успешную проверку backend и устройств.
5. При взвешивании на сайте вес приходит с физических весов.
6. При печати QR принтер печатает этикетку.
7. При сканировании QR текст попадает в поле сайта.

## 9. Остановка

Остановить demo:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\stop-demo.ps1
```

Остановить demo вместе с базой данных:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\stop-demo.ps1 -StopDatabase
```

## 10. Если что-то не работает

### Не открывается сайт

Проверьте:

- запущен ли `start-demo.ps1`;
- нет ли ошибки в `logs\frontend.err.log`;
- открываете ли именно `http://localhost:5173`.

### Backend не отвечает

Проверьте:

- `logs\api.err.log`;
- запущен ли Docker Desktop;
- свободен ли порт `3000`.

### Весы не работают

Проверьте:

- установлен ли `SCALE_MODE=massa-k-protocol-100`;
- правильный ли `SCALE_SERIAL_PORT`;
- установлен ли `SCALE_SERIAL_BAUD=57600`;
- виден ли порт в Диспетчере устройств;
- для прямого RS-232 выбран ли в терминале режим `1C`, `57600`, `8-N-1`;
- для USB virtual COM не менялись ли настройки терминала.

### Принтер не печатает

Для сетевого принтера:

```powershell
Test-NetConnection 192.168.1.50 -Port 9100
```

IP замените на IP принтера.

Для Windows-принтера проверьте имя принтера и тестовую печать из Windows.

### Сканер не вводит QR

Проверьте сканер в Блокноте. Если в Блокноте текст не появляется, проблема в режиме
сканера или USB-подключении.

## 11. Что отправить разработчику при ошибке

Пришлите:

- скриншот ошибки;
- файл `logs\api.err.log`;
- файл `logs\agent.err.log`;
- безопасный категориальный результат команды:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\test-hardware.ps1
```
