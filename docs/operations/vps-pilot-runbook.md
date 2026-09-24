# PlenkaCover: первый pilot-релиз на VPS

Этот runbook разворачивает backend и frontend через отдельный production Compose. Корневой
`docker-compose.yml` остаётся только локальной PostgreSQL-конфигурацией.

Статусы доказательств разделяются строго:

- local Compose smoke — проверяет образы, migration/seed, readiness, volume и restore-check;
- VPS smoke — проверяет публичный TLS, readiness и реальный login;
- live-demo 1С smoke — отдельно доказывает, что выбран HTTP-адаптер и свежий read/import прошёл;
- physical smoke — отдельный документ, выполняется человеком на промышленном посту;
- simulator и legacy serial никогда не являются physical PASS;
- `ONEC_LIVE=true`, mock-ответ или исторический успешный probe сами по себе никогда не являются
  live-demo 1С PASS.

## Топология

```text
internet :80/:443 -> web/Caddy -> /api/* -> api:3000 -> db:5432
                                            ^           ^
                                            |           |
                                   migrate/seed     db-data volume

api -> dedicated api-egress network -> outbound DNS/HTTPS -> demo 1C
```

Только `web` имеет host ports. `api`, `db`, `migrate` и `seed-pilot` находятся во внутренней
Docker-сети; `api` дополнительно подключён к отдельной `api-egress` без опубликованных портов,
чтобы live HTTP-адаптер мог выполнять исходящие DNS/HTTPS-запросы к 1С. `db`, `migrate`,
`seed-pilot` и `web` к этой сети не подключаются. Caddy certificate state и PostgreSQL вынесены в
именованные volumes.

## 1. Требования к VPS

- Ubuntu 24.04 или совместимый Linux;
- Docker Engine с Compose plugin и Buildx;
- минимум 2 GiB RAM; для 2 GiB-хоста рекомендуется 2 GiB swap;
- входящие TCP 80/443 и исходящие HTTPS/DNS;
- DNS A/AAAA на VPS либо публичный IP, доступный из интернета.
- для ручного API-варианта 1С smoke — `curl` и `jq` в root operator shell.

Не меняйте provider firewall/monitoring, пока владелец сервера не подтвердил их назначение.
Compose сам не публикует 3000/5432.

Проверка:

```bash
docker version
docker compose version
docker buildx version
free -h
curl --version
jq --version
```

## 2. Размещение релиза и секретов

Рекомендуемая структура. Backend и frontend — два независимых Git-репозитория, поэтому релиз
идентифицируется парой их commit SHA:

```text
/opt/plenka/incoming/<backend-sha>-<frontend-sha>/
/opt/plenka/releases/<backend-sha>-<frontend-sha>/backend
/opt/plenka/releases/<backend-sha>-<frontend-sha>/frontend
/opt/plenka/current -> /opt/plenka/releases/<backend-sha>-<frontend-sha>
/opt/plenka/shared/pilot.env        # 0600, вне Git
/opt/plenka/shared/pilot.previous.env
/opt/plenka/shared/pilot.previous.release
/opt/plenka/backups                 # 0700, вне Git
```

### 2.1. Сборка двух committed source artifacts

Не копируйте на VPS рабочее дерево, `node_modules`, незакоммиченные изменения или архив всего
каталога проекта. На доверенной workstation сначала зафиксируйте и проверьте именно два commit,
затем создайте отдельные архивы средствами Git. `git archive` включает только committed tree
указанного SHA и намеренно не включает local/untracked files:

```bash
BACKEND_REPO=/absolute/path/to/PlenkaCover
FRONTEND_REPO=/absolute/path/to/frontend-repository
ARTIFACT_DIR=/absolute/path/to/empty-release-artifacts

BACKEND_SHA="$(git -C "$BACKEND_REPO" rev-parse --verify 'HEAD^{commit}')"
FRONTEND_SHA="$(git -C "$FRONTEND_REPO" rev-parse --verify 'HEAD^{commit}')"
RELEASE_ID="${BACKEND_SHA}-${FRONTEND_SHA}"

git -C "$BACKEND_REPO" status --short
git -C "$FRONTEND_REPO" status --short
git -C "$BACKEND_REPO" archive --format=tar.gz \
  --output="$ARTIFACT_DIR/plenka-backend-$BACKEND_SHA.tar.gz" "$BACKEND_SHA"
git -C "$FRONTEND_REPO" archive --format=tar.gz \
  --output="$ARTIFACT_DIR/plenka-frontend-$FRONTEND_SHA.tar.gz" "$FRONTEND_SHA"
(
  cd "$ARTIFACT_DIR"
  shasum -a 256 "plenka-backend-$BACKEND_SHA.tar.gz" \
    >"plenka-backend-$BACKEND_SHA.tar.gz.sha256"
  shasum -a 256 "plenka-frontend-$FRONTEND_SHA.tar.gz" \
    >"plenka-frontend-$FRONTEND_SHA.tar.gz.sha256"
)
```

Ненулевой `git status` не попадает в эти архивы и означает, что такие изменения **не входят** в
релиз; если они нужны, сначала оформите отдельный reviewed commit и заново вычислите SHA/архивы.
Передайте на VPS только два `.tar.gz` и два `.sha256` по защищённому каналу. Не переиспользуйте
имена и release-каталог для другого содержимого.

Создать каталоги и распаковать artifacts нужно от root. Checksums проверяются **до** распаковки,
а существующий release ID отклоняется, а не перезаписывается:

```bash
sudo install -d -m 0750 /opt/plenka/incoming /opt/plenka/releases /opt/plenka/shared
sudo install -d -m 0700 /opt/plenka/backups

sudo -i
RELEASE_ID=<backend-full-sha>-<frontend-full-sha>
BACKEND_SHA=<backend-full-sha>
FRONTEND_SHA=<frontend-full-sha>
INCOMING=/opt/plenka/incoming/$RELEASE_ID
RELEASE_DIR=/opt/plenka/releases/$RELEASE_ID

install -d -m 0750 "$INCOMING"
# Поместите четыре переданных файла в $INCOMING, затем:
cd "$INCOMING"
sha256sum -c "plenka-backend-$BACKEND_SHA.tar.gz.sha256"
sha256sum -c "plenka-frontend-$FRONTEND_SHA.tar.gz.sha256"
test ! -e "$RELEASE_DIR"
install -d -m 0750 "$RELEASE_DIR/backend" "$RELEASE_DIR/frontend"
tar --extract --gzip --file="plenka-backend-$BACKEND_SHA.tar.gz" \
  --directory="$RELEASE_DIR/backend" --no-same-owner --no-same-permissions
tar --extract --gzip --file="plenka-frontend-$FRONTEND_SHA.tar.gz" \
  --directory="$RELEASE_DIR/frontend" --no-same-owner --no-same-permissions
# Root может работать со строгим umask 077. Верните read/search всем runtime users,
# сохранив executable bit только у уже исполняемых файлов, и затем запретите запись.
chmod -R a+rX "$RELEASE_DIR"
chmod -R a-w "$RELEASE_DIR"
```

Release directory после распаковки неизменяем: не запускайте в нём редактор, `npm install` или
генератор, который пишет в source tree. Docker build только читает этот context. Исправление
всегда получает новый commit, новые archives/checksums и новый `RELEASE_ID`. Символическая ссылка
`current` переключается атомарно только после pre-deploy gates из §5.

Секретный файл остаётся `root:root 0600`. Все команды `scripts/vps/*`, которые читают его или
управляют Docker, выполняются из явной root-сессии; обычный deploy-пользователь не должен получать
доступ к секретам. Реальные значения нельзя копировать в issue, shell history, CI log или
`docker compose config` output.

```bash
sudo install -m 0600 "$RELEASE_DIR/backend/deploy/vps/.env.example" \
  /opt/plenka/shared/pilot.env # только для первой установки; не выполнять при upgrade
sudo chown root:root /opt/plenka/shared/pilot.env
```

После размещения release открыть отдельную операторскую сессию и до atomic activation выполнять
команды из конкретного нового release. Выйти из root-сессии сразу после работ:

```bash
sudo -i
cd "$RELEASE_DIR/backend"
export PLENKA_ENV_FILE=/opt/plenka/shared/pilot.env
```

Заполните файл через `sudoedit /opt/plenka/shared/pilot.env`. Генерируйте каждое значение отдельно:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'; echo
```

Agent token имеет форму `ptk_` плюс результат команды для 32 байт. Нужны девять уникальных
паролей аккаунтов, пять уникальных post token и три уникальных DB-пароля; повтор между всеми
секретами запрещён. Значения задаются plain-text без кавычек, пробелов, `$` или shell/Caddy
выражений. Image tag — только git-SHA-подобный lowercase hex (7–64 знака) либо digest.

База использует три разные роли:

- `POSTGRES_ADMIN_USER` — bootstrap-superuser только внутри DB container и recovery-команд;
- `DATABASE_OWNER_USER` — владелец схемы для `prisma migrate deploy`, backup/restore;
- `DATABASE_APP_USER` — runtime API/seed без superuser/CREATEDB/CREATEROLE и без schema DDL.

`MIGRATION_DATABASE_URL` и `DATABASE_URL` должны точно соответствовать своим ролям и private host
`db`, например:

```text
MIGRATION_DATABASE_URL=postgresql://<owner>:<owner-password>@db:5432/<database>?schema=public
DATABASE_URL=postgresql://<app>:<app-password>@db:5432/<database>?schema=public
```

Используйте отдельное application-имя базы вроде `plenka_pilot`. Системные базы `postgres`,
`template0` и `template1` запрещены: recovery-команды никогда не используют их как live target.
`BACKUP_DIR` для VPS обязан быть ровно `/opt/plenka/backups`, реальным root-owned каталогом mode
`0700` без symlink-компонентов. Скрипты не исправляют permissions произвольного существующего
каталога и останавливаются при несовпадении owner/mode.

#### First install safe values

Автоматическое складское покрытие V2 включается только отдельным согласованным действием. Для
первой установки сохраните безопасное значение:

```text
WAREHOUSE_COVERAGE_V2_ENABLED=false
PILOT_SHORT_PASSWORDS_ENABLED=false
PRODUCTION_COST_RECONCILER_ENABLED=true
ONEC_FINANCE_SYNC_ENABLED=false
ONEC_FINANCE_SYNC_INTERVAL_MS=300000
ONEC_INVOICE_ORDER_REFERENCE_FIELD=Комментарий
ONEC_PAYMENT_SYNC_ENABLED=false
ONEC_PAYMENT_AUTO_APPLY_ENABLED=false
```

Обязательные безопасные значения: `APP_ENV=pilot`, `NODE_ENV=production`,
`AUTH_DEV_XROLE=off`, `SEED_PROFILE=pilot`, `GATEWAY_SIMULATOR=off`, `ONEC_LIVE=true`,
`ONEC_WRITE=false`, `ONEC_WRITE_CONFIRM=off`. Первый VPS-пилот обязан запускать реальный bounded
`HttpOneCAdapter`; validator отклоняет `ONEC_LIVE=false`, чтобы mock нельзя было выдать за live
integration. `ONEC_BASE_URL`, `ONEC_USERNAME` и `ONEC_PASSWORD` обязательны и хранятся только в
root-owned `pilot.env`/внешнем secret store. Не переносите их в Git, команды shell, screenshots или
evidence.

`ONEC_LIVE=true` — только wiring gate. Он не обещает, что внешняя 1С доступна. Последний
authenticated probe текущего `ONEC_BASE_URL` от 2026-08-03 вернул `mode=http`,
`status=ready`; после него безопасный импорт контрагентов вернул реальные `sourceKind=1C`
snapshots без `rawPayload` в пользовательской проекции. Этот факт не заменяет свежий gate перед
следующим изменением endpoint/credentials или включением фоновых задач. Не выключайте live-режим
ради зелёного mock-check.

### 2.2. Upgrade: сначала сделать старый env совместимым

#### Upgrade compatibility before validation

При обновлении существующего VPS нельзя сначала переключать source/images, а затем пытаться
запустить новый validator на устаревшем env. Пока `pilot.env` ещё содержит **предыдущие** image
tags, через `sudoedit` добавьте/исправьте новые обязательные переменные:

```text
WAREHOUSE_COVERAGE_V2_ENABLED=false
PILOT_SHORT_PASSWORDS_ENABLED=true
PRODUCTION_COST_RECONCILER_ENABLED=true
ONEC_LIVE=true
ONEC_BASE_URL=<https OData service root>
ONEC_USERNAME=<secret outside Git>
ONEC_PASSWORD=<secret outside Git>
ONEC_WRITE=false
ONEC_WRITE_CONFIRM=off
ONEC_FINANCE_SYNC_ENABLED=false
ONEC_FINANCE_SYNC_INTERVAL_MS=300000
ONEC_INVOICE_ORDER_REFERENCE_FIELD=Комментарий
ONEC_PAYMENT_SYNC_ENABLED=false
ONEC_PAYMENT_AUTO_APPLY_ENABLED=false
```

Этот upgrade использует утверждённый режим коротких PIN: одновременно с флагом задайте в
root-owned `pilot.env` все 9 значений `SEED_PILOT_PASSWORD_*` как различные четырёхзначные
цифровые PIN. Нельзя включать флаг отдельно от замены всех девяти значений или повторять PIN между
ролями. Pilot seed устанавливает эти PIN как текущие пароли с `mustChangePassword=false`; требовать
от сотрудников дополнительную bootstrap-замену после seed не нужно.

Перед validation нового release безопасно удалите retired password requirement из уже существующего
`pilot.env`: команда читает файл только с root-правами, не печатает его содержимое и публикует
изменение атомарно только после проверки отсутствия строки.

```bash
PILOT_ENV=/opt/plenka/shared/pilot.env
PILOT_ENV_NEXT=/opt/plenka/shared/pilot.env.operator-4-retired
sudo sh -c '
set -eu
umask 077
source_env="$1"
next_env="$2"
if [ ! -f "$source_env" ] || [ -L "$source_env" ]; then
  printf "%s\n" "STOP: pilot env source must be a regular non-symlink file." >&2
  exit 1
fi
if [ -e "$next_env" ] || [ -L "$next_env" ]; then
  printf "%s\n" "STOP: pilot env temporary path already exists." >&2
  exit 1
fi
cleanup() { rm -f -- "$next_env"; }
trap cleanup EXIT INT TERM
awk "!/^SEED_PILOT_PASSWORD_OPERATOR_4=/" "$source_env" >"$next_env"
if grep -q "^SEED_PILOT_PASSWORD_OPERATOR_4=" "$next_env"; then
  printf "%s\n" "STOP: retired operator password key is still present." >&2
  exit 1
fi
mv -f "$next_env" "$source_env"
trap - EXIT INT TERM
' sh "$PILOT_ENV" "$PILOT_ENV_NEXT"
unset PILOT_ENV_NEXT PILOT_ENV
```

Проверьте модернизированный старый env validator-ом **нового committed release**, не выводя
значения. Только после PASS определите rollback source по фактически запущенным immutable images.
Не доверяйте `/opt/plenka/current`: symlink мог остаться на другом source tree после прерванного
или ручного переключения. Запущенные image refs, старый env, release ID, исходные archives и
распакованный read-only source должны согласоваться одновременно:

```bash
cd "$RELEASE_DIR/backend"
export PLENKA_ENV_FILE=/opt/plenka/shared/pilot.env
./scripts/vps/validate-env.sh "$PLENKA_ENV_FILE"
source ./scripts/vps/lib.sh

API_CONTAINER="$(compose ps --status running -q api)"
WEB_CONTAINER="$(compose ps --status running -q web)"
test -n "$API_CONTAINER"
test -n "$WEB_CONTAINER"
[[ "$API_CONTAINER" != *$'\n'* ]]
[[ "$WEB_CONTAINER" != *$'\n'* ]]

RUNNING_API_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$API_CONTAINER")"
RUNNING_WEB_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$WEB_CONTAINER")"
RUNNING_MIGRATION_IMAGE="$(env_value PLENKA_MIGRATION_IMAGE)"
test "$RUNNING_API_IMAGE" = "$(env_value PLENKA_API_IMAGE)"
test "$RUNNING_WEB_IMAGE" = "$(env_value PLENKA_WEB_IMAGE)"

RUNNING_BACKEND_SHA="${RUNNING_API_IMAGE##*:}"
RUNNING_MIGRATION_SHA="${RUNNING_MIGRATION_IMAGE##*:}"
RUNNING_FRONTEND_SHA="${RUNNING_WEB_IMAGE##*:}"
test "$RUNNING_BACKEND_SHA" = "$RUNNING_MIGRATION_SHA"
[[ "$RUNNING_BACKEND_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$RUNNING_FRONTEND_SHA" =~ ^[0-9a-f]{40}$ ]]
RUNNING_RELEASE_ID="${RUNNING_BACKEND_SHA}-${RUNNING_FRONTEND_SHA}"
RUNNING_RELEASE="/opt/plenka/releases/$RUNNING_RELEASE_ID"
RUNNING_INCOMING="/opt/plenka/incoming/$RUNNING_RELEASE_ID"
test -d "$RUNNING_RELEASE/backend"
test -d "$RUNNING_RELEASE/frontend"

(
  cd "$RUNNING_INCOMING"
  sha256sum -c "plenka-backend-$RUNNING_BACKEND_SHA.tar.gz.sha256"
  sha256sum -c "plenka-frontend-$RUNNING_FRONTEND_SHA.tar.gz.sha256"
)
VERIFY_SOURCE="$(mktemp -d)"
trap 'rm -rf -- "$VERIFY_SOURCE"' EXIT
install -d "$VERIFY_SOURCE/backend" "$VERIFY_SOURCE/frontend"
tar --extract --gzip \
  --file="$RUNNING_INCOMING/plenka-backend-$RUNNING_BACKEND_SHA.tar.gz" \
  --directory="$VERIFY_SOURCE/backend" --no-same-owner --no-same-permissions
tar --extract --gzip \
  --file="$RUNNING_INCOMING/plenka-frontend-$RUNNING_FRONTEND_SHA.tar.gz" \
  --directory="$VERIFY_SOURCE/frontend" --no-same-owner --no-same-permissions
diff -qr "$VERIFY_SOURCE/backend" "$RUNNING_RELEASE/backend"
diff -qr "$VERIFY_SOURCE/frontend" "$RUNNING_RELEASE/frontend"
rm -rf -- "$VERIFY_SOURCE"
trap - EXIT

install -o root -g root -m 0600 "$PLENKA_ENV_FILE" \
  /opt/plenka/shared/pilot.previous.env.next
mv -Tf /opt/plenka/shared/pilot.previous.env.next \
  /opt/plenka/shared/pilot.previous.env
printf '%s\n' "$RUNNING_RELEASE" >/opt/plenka/shared/pilot.previous.release.next
chown root:root /opt/plenka/shared/pilot.previous.release.next
chmod 0600 /opt/plenka/shared/pilot.previous.release.next
mv -Tf /opt/plenka/shared/pilot.previous.release.next \
  /opt/plenka/shared/pilot.previous.release
```

Не копируйте `pilot.previous.env` до этой модернизации: такой файл может не пройти новый secure
startup во время rollback. Если проверенные running images указывают не на цель `current`, это
подтверждённый symlink mismatch: rollback-парой всё равно остаётся `RUNNING_RELEASE`; слепо
сохранять цель `current` запрещено. После создания rollback-пары через `sudoedit` замените в
основном `pilot.env` только три image tags на SHA нового backend/frontend, снова запустите
`validate-env.sh` и `check-compose.sh`. На первой установке rollback-пары ещё нет; её создают
только перед следующим release.

В текущей фиксированной контейнерной топологии `PORT` обязан быть ровно `3000`; healthcheck и
Caddy upstream используют тот же внутренний порт. `PUBLIC_HOST` должен быть canonical DNS name
или canonical dotted-decimal IPv4, пригодным для публичного ACME. Loopback, unspecified, private,
shared, link-local, protocol-assignment, TEST-NET, benchmark, multicast и reserved IPv4 ranges,
обфусцированные numeric-формы вроде `0x7f.1`, numeric final DNS labels и детерминированно
непубличные namespaces `.localhost`, `.test`, `.invalid`, `.example`, `.local`, `.onion`,
`.internal`, `.alt`, `.home.arpa`, `example.com`, `example.net`, `example.org` отклоняются до
рендеринга Compose. Инфраструктурная зона `.arpa` и IDN/punycode labels также запрещены: shell
preflight намеренно не реализует частичный URL/IDNA parser. Literal IPv6 в этом pilot не
поддержан; для IPv6 используйте ASCII DNS name с AAAA. Статический preflight не доказывает DNS
routing или выпуск сертификата — это даёт только VPS smoke. `BACKUP_RETENTION_COUNT` задаётся
canonical base-10 числом без ведущих нулей.

Проверка не печатает значения:

```bash
./scripts/vps/validate-env.sh "$PLENKA_ENV_FILE"
./scripts/vps/check-compose.sh
```

## 3. TLS host

Предпочтителен DNS name. Укажите его одновременно в `PUBLIC_HOST` и
`PUBLIC_ORIGIN=https://<host>`. Caddy использует публичный Let's Encrypt ACME issuer с профилем
`shortlived`; Caddy data volume обязателен для account/certificate state.

IP certificates Let's Encrypt доступны, но имеют короткий срок (около шести дней). Поэтому
IP-only запуск принимается только после реальной browser/curl проверки доверенной цепочки и
автоматического renewal. `tls internal`, self-signed certificate и HTTP не считаются VPS PASS.
Для IP-host клиенты могут отправлять TLS ClientHello без SNI. Глобальный
`default_sni {$PUBLIC_HOST}` в Caddyfile в этом случае выбирает сертификат публичного host;
без него уже выпущенный IP-сертификат может не обслуживаться и клиент получит TLS internal error.

До запуска убедитесь, что 80/443 не заняты:

```bash
sudo ss -ltnp '( sport = :80 or sport = :443 )'
```

## 4. Сборка образов

В `pilot.env` задаются immutable release tags, не `latest`:

```text
PLENKA_API_IMAGE=plenka-api:<git-sha>
PLENKA_MIGRATION_IMAGE=plenka-migration:<git-sha>
PLENKA_WEB_IMAGE=plenka-web:<frontend-git-sha>
```

Backend-образы собираются из корня backend release:

```bash
./scripts/vps/build-backend-images.sh
```

Web image собирается по Dockerfile frontend-репозитория. Он должен содержать immutable Vite
assets в `/srv`, Caddy >= 2.10 с поддержкой ACME profiles и `wget` для healthcheck. Сборку/тест
frontend выполняйте по его release runbook. Секреты не передаются как build args.

Для pilot root filesystem web-контейнера read-only; writable остаются только bounded `/tmp` и
именованные Caddy volumes `/data`, `/config`. Образ пока запускает Caddy от root для инициализации
этих volumes и bind 80/443, но Compose удаляет все capabilities, кроме `NET_BIND_SERVICE`, и
включает `no-new-privileges`. Переход на non-root требует отдельного ownership bootstrap для
внешнего frontend image и не должен делаться неявно в боевом deploy.

## 5. Migration, bootstrap и запуск

### 5.1. Обязательные pre-deploy gates

Сначала объявите maintenance window и прекратите все бизнес-записи. Операторы должны выйти из
цикла, локальный physical gateway agent `POST-1` и Mac simulator `POST-5` должны быть остановлены,
а admin diagnostics — подтвердить отсутствие команд `queued`/`in_flight` на этих постах. Не
продолжайте, если кто-либо ещё использует seeded test lanes.

На пустой БД pilot seed создаёт `pilot-test-shift-001` как `planned`, два назначения
`seed-operator` (Ахметов Булат) → `POST-1` и `seed-operator-3` (Гайнулин Ильназ) → `POST-5`
как `planned` без `lockedAt`, а соответствующие
Big-bag — как `available`. Seed не создаёт operator-on-post session и не фиксирует стартовый вес.
После bootstrap ожидается ноль active operator sessions; смену открывает сам оператор через UI,
когда начинается physical или simulated smoke.

При upgrade любая active operator-on-post session, включая оставшуюся от более старого pilot
release, должна быть штатно закрыта через UI/API с аудитом до maintenance. Active session не
является допустимым seeded precondition. Не исправляйте её прямым SQL и не запускайте seed
«поверх» в расчёте на reset: pilot fixtures create-only и не откатывают записанные веса, статус
рулона, `open/locked` состояние или закрытую сессию. Если прежний release уже создал одноимённую
`open` смену/`locked` назначения, повторный seed не превратит их в новый planned baseline. Такой
upgrade требует отдельного согласованного reconciliation либо чистой pilot-БД после проверенного
backup; до решения это deployment/smoke blocker.

Для первого официального smoke после legacy release используйте чистую pilot generation, не
переписывая `open/locked` обратно в `planned`. Сначала штатно закройте все operator sessions,
подтвердите отсутствие физических фактов и создайте свежий проверенный backup. Затем остановите
API и web и выполните одноразовое архивирование БД:

```bash
cd /opt/plenka/current/backend
./scripts/vps/backup.sh --check
source ./scripts/vps/lib.sh
compose stop api web
./scripts/vps/fresh-pilot-database.sh --confirm-archive \
  /opt/plenka/backups/plenka-YYYYMMDDTHHMMSSZ.dump
```

Команда под общим `/opt/plenka/backups/.maintenance.lock` сама повторно проверяет строгую привязку
checksum к выбранному dump и выполняет disposable restore-check. Она откажется работать при active
session, открытом Big-bag usage, ожидающей gateway-команде или любом
weight/print/operator-operation fact. Старая БД не удаляется: она получает имя
`*_legacy_<UTC>` длиной не более PostgreSQL limit, переводится в `ALLOW_CONNECTIONS=false`, а имя
application DB занимает пустая БД с теми же owner/app grants. При перехваченной ошибке или сигнале
скрипт возвращает прежнее имя, разрешает подключения к нему и проверяет конечное состояние.

До первого DDL атомарно создаётся root-only marker
`/opt/plenka/shared/pilot.legacy.database` со `state=pending`. После полного PASS он атомарно
становится `state=complete`; при обработанной ошибке — `state=failed`. Даже после автоматического
rollback `pending/failed` намеренно запрещает повторную архивацию: не удаляйте marker и не
перезапускайте команду вслепую. Сначала сохраните marker как incident evidence, проверьте указанные
в нём `database`/`legacy_database` через `pg_database` (`datallowconn`), ещё раз выполните
`restore.sh --check` для указанного backup и согласуйте recovery с владельцем БД. Необработанный
kill может оставить `pending`: наличие application DB и frozen legacy DB означает, что archive,
вероятно, завершился и повторять его нельзя; любое другое сочетание является blocker для ручного
recovery. После `state=complete` примените migration и дважды запустите create-only pilot seed. Не
используйте `down -v`.

Перед migration любого upgrade/повторного deploy создайте проверенный backup текущей БД **и
перенесите его поколение за пределы VPS**. Новый backend image должен быть уже собран, но ссылка
`current` пока остаётся на старом release:

```bash
cd "$RELEASE_DIR/backend"
export PLENKA_ENV_FILE=/opt/plenka/shared/pilot.env
./scripts/vps/validate-env.sh "$PLENKA_ENV_FILE"
BACKUP_RESULT="$(mktemp)"
trap 'rm -f "$BACKUP_RESULT"' EXIT
./scripts/vps/backup.sh --check | tee "$BACKUP_RESULT"
BACKUP_ARTIFACT="$(tail -n 1 "$BACKUP_RESULT")"
rm -f "$BACKUP_RESULT"
trap - EXIT
test -f "$BACKUP_ARTIFACT"
test -f "$BACKUP_ARTIFACT.sha256"
test -f "$BACKUP_ARTIFACT.complete"
printf 'Pre-deploy backup: %s\n' "$(basename "$BACKUP_ARTIFACT")"
```

Из отдельной доверенной operator workstation скопируйте `.dump`, `.dump.sha256` и
`.dump.complete` в зашифрованное внешнее хранилище, затем там выполните checksum check, например:

```bash
scp <vps-alias>:/opt/plenka/backups/plenka-<UTC-timestamp>.dump \
  <external-backup-directory>/
scp <vps-alias>:/opt/plenka/backups/plenka-<UTC-timestamp>.dump.sha256 \
  <external-backup-directory>/
scp <vps-alias>:/opt/plenka/backups/plenka-<UTC-timestamp>.dump.complete \
  <external-backup-directory>/
cd <external-backup-directory>
shasum -a 256 -c plenka-<UTC-timestamp>.dump.sha256
test "$(cat plenka-<UTC-timestamp>.dump.complete)" = complete
```

После внешнего checksum PASS и до переключения `current` обязательно прогоните миграции
кандидата на disposable restore этой же backup generation. `EXPECTED_MIGRATION` — точное имя
последней новой committed migration этого release, которой ещё нет в live backup; если оно не
определено однозначно, deployment блокируется:

```bash
EXPECTED_MIGRATION=<YYYYMMDDHHMMSS_committed_candidate_migration>
test -d "apps/api/prisma/migrations/$EXPECTED_MIGRATION"
./scripts/vps/restore.sh --check-migrate "$BACKUP_ARTIFACT" "$EXPECTED_MIGRATION"
```

Только `Migration rehearsal: PASS` разрешает atomic source activation и последующий
`deploy.sh`. Обычный `restore.sh --check` или успешный checksum без `--check-migrate` не заменяют
этот gate перед применением DDL к live database.

Для действительно первой установки без прежнего DB volume pre-deploy backup помечается `N/A`
только после проверки, что application DB/volume ещё не существуют и бизнес-данных нет. Наличие
любого прежнего volume или pilot data автоматически делает внешний backup обязательным.
Для upgrade migration запрещена, пока external checksum не имеет PASS. Не сохраняйте dump в Git,
CI artifact или публичное облачное хранилище. После backup PASS либо доказанного first-install
`N/A` активируйте уже проверенный immutable source target атомарной заменой symlink и немедленно
перейдите в него:

```bash
test -d "$RELEASE_DIR/backend"
test -d "$RELEASE_DIR/frontend"
test ! -e /opt/plenka/current.next
test ! -L /opt/plenka/current.next
ln -s "$RELEASE_DIR" /opt/plenka/current.next
mv -Tf /opt/plenka/current.next /opt/plenka/current
cd /opt/plenka/current/backend
test "$(pwd -P)" = "$RELEASE_DIR/backend"
```

`current` никогда не направляется на incoming/unverified tree и не переключается по частям.
Artifact checksum, external backup и сохранённая rollback-пара из §2.2 относятся к точным SHA
этого запуска.

### 5.2. Migration и bootstrap

`deploy.sh` останавливает API в состояниях `running`/`restarting` на явное migration maintenance
window, запускает и проверяет DB, применяет только `prisma migrate deploy`, затем возвращает API в
исходное running-состояние. Ранее остановленный API обновляется, но остаётся остановленным; при
первой установке отсутствующий API запускается. Если migration завершается ошибкой, API не
запускается: сначала устраните причину/восстановите совместимую БД, не запускайте writer поверх
неизвестной схемы. После успешной миграции web-контейнер принудительно пересоздаётся, чтобы bind
mount Caddyfile перешёл с предыдущей цели `/opt/plenka/current` на текущий release. Seed
автоматически не запускается:

```bash
./scripts/vps/deploy.sh
./scripts/vps/seed-pilot.sh
./scripts/vps/seed-pilot.sh   # обязательное доказательство идемпотентности при первом bootstrap
./scripts/vps/restart.sh api  # seed не должен запускаться снова
```

Порядок для новой пустой базы: `deploy.sh`, затем seed дважды, затем VPS smoke. Если API запущен до
seed, readiness остаётся техническим; вход пользователей появится после bootstrap. На upgrade
повторный seed допустим только при выполненных session preconditions §5.1; его PASS означает
сохранение существующих physical facts, а не сброс тестовой дорожки. Gateway agents `POST-1` и
`POST-5` запускаются заново только после migration/seed, readiness и проверки очереди команд.
После чистого bootstrap не создавайте post-session служебной командой: назначенный оператор сам
открывает смену через frontend, выбирает соответствующий available Big-bag и вводит стартовый вес.
Только успешное открытие переводит смену в `open`, блокирует назначение и создаёт active session.

Операции:

```bash
./scripts/vps/status.sh
./scripts/vps/logs.sh api
./scripts/vps/restart.sh api
./scripts/vps/restart.sh web
./scripts/vps/down.sh          # volumes не удаляет
```

Никогда не используйте `docker compose down -v` на VPS. Никогда не запускайте
`prisma migrate dev`.

## 6. Smoke

Evidence привязан к точной паре committed SHA из `RELEASE_ID`. Результаты build/test/smoke,
полученные для предыдущего HEAD или ранее развёрнутого VPS release, не переносятся на новый HEAD,
даже если diff кажется «только документацией». После любого нового commit заново создаются
archives/checksums и повторяются применимые проверки exact artifacts.

До отправки на сервер, на точных backend/frontend commits:

```bash
npm run build
npm test
npm run test:e2e -w @plenka/api
npm run lint
./scripts/vps/test/run.sh
./scripts/vps/check-caddy.sh
./scripts/vps/smoke-local.sh
```

В frontend-репозитории на точном `FRONTEND_SHA` отдельно обязательны его `npm test` и
`npm run build`. PASS из другого worktree/commit нельзя подписывать SHA этого release.

На VPS:

```bash
./scripts/vps/smoke-vps.sh
```

Скрипт намеренно возвращает `PARTIAL`: он проверяет доверенный HTTPS без `-k`, оба health endpoint,
ровно 9 login-попыток canonical Russian pilot accounts, для каждой проверяет token, ожидаемую роль
и `passwordChangeRequired=false` через login response и `/api/auth/me`, отзывает созданную session,
а также проверяет отсутствие host-портов API/DB. Десятой login-попытки нет, поэтому smoke
укладывается в настроенный лимит 10 попыток на окно. Для VPS PASS тестировщик обязан завершить
браузерный чек-лист:

Приватность API/DB проверяется по числу фактических Docker PortBinding в
`.NetworkSettings.Ports` running-контейнера; raw inspect output не печатается. `docker compose port`
для этой проверки не используется: отдельные версии Compose при отсутствии binding возвращают
служебную строку `invalid IP:0` с exit code 0.

1. открыть тот же HTTPS origin в Chromium без certificate warning;
2. войти утверждённым pilot admin PIN из root-owned secret store;
3. убедиться, что `/api/auth/me` подтверждает admin, возвращает
   `passwordChangeRequired=false`, а форма смены пароля не перехватывает вход;
4. обновить страницу и убедиться, что demo role switcher в
   production-сборке отсутствует;
5. выйти и повторно войти тем же утверждённым PIN;
6. снова запустить `smoke-vps.sh`: все 9 аккаунтов должны пройти, а DB/API bindings остаться
   private;
7. сохранить только время, HTTP/status facts и redacted screenshot; PIN/token не сохранять.

Только совокупность скрипта и этого чек-листа даёт VPS PASS:

- доверенный HTTPS без `-k`;
- `/api/health` и `/api/health/ready` возвращают 2xx;
- все 9 canonical pilot logins и их `/api/auth/me` проходят с ожидаемыми ролями и
  `passwordChangeRequired=false`;
- DB/API не слушают public host ports;
- browser logout/re-login проходит тем же утверждённым PIN.

Скрипт не печатает login/PIN/Bearer token/response и удаляет временный response. До завершения
браузерного re-login evidence итоговый статус остаётся `VPS PENDING/PARTIAL`.

## 7. Live-demo 1С: check, read/import и controlled write

### 7.1. Обязательный read gate

Начальное и штатное состояние — live read с выключенной записью:

```text
ONEC_LIVE=true
ONEC_WRITE=false
ONEC_WRITE_CONFIRM=off
```

После любого изменения endpoint/credentials через `sudoedit` проверьте env без вывода значений и
перезапустите API: `OneCRuntimeOptions` фиксируются на startup.

```bash
./scripts/vps/validate-env.sh "$PLENKA_ENV_FILE"
./scripts/vps/restart.sh api
./scripts/vps/status.sh
```

Предпочтительный путь — production UI:

1. войти текущим (уже сменённым) pilot admin-паролем;
2. открыть экран администрирования 1С и выполнить проверку соединения;
3. требовать `mode=http` и `status=ready`; `mode=mock` — `FAIL`, даже если status равен `ready`;
4. только после ready запустить read/import «Контрагенты»;
5. убедиться, что новый safe snapshot имеет `sourceKind=1C`, свежий `capturedAt` и не показывает
   `rawPayload`; raw доступен только отдельной admin-diagnostics capability и не входит в evidence.

Эквивалентный API smoke ниже не записывает credentials/token в history и не печатает token.
Выполняйте его с `set +x`; функция запрашивает current admin credentials интерактивно.

```bash
set +x
read -r -p 'Pilot origin (https://...): ' ORIGIN

api_login() {
  local login password response
  read -r -p 'Pilot login: ' login
  read -r -s -p 'Pilot password: ' password
  printf '\n'
  response="$(
    printf '%s' "$password" |
      jq -Rsc --arg login "$login" '{login:$login,password:.}' |
      curl --fail-with-body --silent --show-error \
        -H 'Content-Type: application/json' \
        --data-binary @- \
        "$ORIGIN/api/auth/login"
  )" || return 1
  API_TOKEN="$(jq -er '.token' <<<"$response")" || return 1
  unset password response login
}

api_login
ONEC_CHECK="$(
  curl --fail-with-body --silent --show-error \
    -X POST \
    -H "Authorization: Bearer $API_TOKEN" \
    "$ORIGIN/api/admin/onec/check"
)"
jq '{mode,status,errorCategory,message,checkedAt,latencyMs,endpointLabel}' <<<"$ONEC_CHECK"
jq -e '.mode == "http" and .status == "ready"' <<<"$ONEC_CHECK"
```

Последний `jq -e` обязан завершиться с exit code `0`. Если status — `unavailable`, включая текущий
HTTP `420`, остановитесь: не запускайте import/write, не подменяйте результат mock-ответом и
зафиксируйте `1C PENDING — external endpoint blocker`.

Только после успешного check выполните один безопасный импорт:

```bash
ONEC_IMPORT="$(
  curl --fail-with-body --silent --show-error \
    -X POST \
    -H "Authorization: Bearer $API_TOKEN" \
    -H 'Content-Type: application/json' \
    --data-binary '{"subjectType":"counterparty"}' \
    "$ORIGIN/api/admin/onec/imports"
)"
jq '{count:length,sourceKinds:([.[].sourceKind]|unique),subjectTypes:([.[].subjectType]|unique)}' \
  <<<"$ONEC_IMPORT"
jq -e 'length > 0 and all(.[]; .sourceKind == "1C")' <<<"$ONEC_IMPORT"
jq -e 'all(.[]; (has("rawPayload") | not))' <<<"$ONEC_IMPORT"

curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $API_TOKEN" \
  "$ORIGIN/api/admin/onec/snapshots?subjectType=counterparty&page=1&pageSize=5" |
  jq '{total,latest:(.items[0]|{sourceKind,subjectType,staleness,capturedAt})}'

unset ONEC_IMPORT ONEC_CHECK API_TOKEN ORIGIN
unset -f api_login
```

Live-demo read получает `PASS` только при свежих `mode=http/status=ready` **и** import
`sourceKind=1C`. Оба пункта подтверждены 2026-08-03; их нельзя переиспользовать после изменения
endpoint/credentials. Корректная формулировка — «live-demo read/import проверен», не
«production-ready интеграция с 1С заказчика».

### 7.2. Фоновая загрузка счетов и банковских поступлений

Включайте её только после свежего PASS из §7.1 и при сохранённом read-only режиме:

```text
ONEC_LIVE=true
ONEC_WRITE=false
ONEC_WRITE_CONFIRM=off
ONEC_FINANCE_SYNC_ENABLED=true
ONEC_FINANCE_SYNC_INTERVAL_MS=300000
ONEC_INVOICE_ORDER_REFERENCE_FIELD=Комментарий
ONEC_PAYMENT_SYNC_ENABLED=true
ONEC_PAYMENT_AUTO_APPLY_ENABLED=true
```

В опубликованном реквизите `Комментарий` бухгалтер указывает точный маркер из заявки без
дополнительного текста: `PLENKA_ORDER=<номер заявки>`. Публикация этой базы запрещает OData
`WHERE` для строковых полей документов, поэтому API читает счета стабильными ограниченными
страницами и выполняет только локальное точное сравнение; выбора «последнего счёта» нет.
Параллельные заявки используют один короткоживущий индекс. Поступления также читаются всеми
страницами, с защитой от дублей и верхним предохранительным лимитом.

`ONEC_PAYMENT_AUTO_APPLY_ENABLED=true` автоматически распределяет только однозначные точные
совпадения. Неоднозначные совпадения и совпадения только по номеру счёта остаются предложениями
для ручной сверки бухгалтером.

После изменения root-owned env выполните validator, перезапустите API и проверьте readiness:

```bash
./scripts/vps/validate-env.sh "$PLENKA_ENV_FILE"
./scripts/vps/restart.sh api
./scripts/vps/status.sh
```

Не печатайте env контейнера целиком. Проверяйте только факт, что пять перечисленных переменных
присутствуют и имеют ожидаемые non-secret значения. Для приёмки выполните один ручной цикл через
finance API, затем дождитесь следующего интервала и подтвердите новый завершённый sync journal /
audit event системного actor `onec_finance_sync`. Ошибочные и неоднозначные поступления не
исправляйте SQL-запросом — используйте штатную сверку финансового контура.

### 7.3. Controlled stock write — только отдельное согласованное окно

Не выполняйте этот раздел, пока read gate выше не имеет свежий PASS. Это реальная операция по
demo-базе: согласованный snapshot всех текущих `RawMaterialStock` создаёт и проводит один
`Document_ОприходованиеТоваров`. Текущие runtime refs и номенклатура demo-specific; для базы
заказчика этот путь не считается готовым.

Контур server-side идемпотентен и консервативен:

- клиент сначала получает preview и его SHA-256 `snapshotHash`, затем отправляет этот hash вместе с
  новым UUIDv4 `operationKey`;
- preview явно возвращает `writeReady/readinessCode/readinessMessage`; при выключенной записи,
  mock-адаптере или неготовом HTTP endpoint POST останавливается **до** создания долговечного
  idempotency-claim и до обращения к write adapter;
- hash включает серверные версии строк склада: неизменившийся revision дедуплицируется, но
  законный цикл остатков `A → B → A` получает новый hash и может быть проведён как новая операция;
- изменившийся snapshot отклоняется до обращения к 1С;
- сервер дедуплицирует и `operationKey`, и `snapshotHash`: успешный повтор возвращает сохранённый
  safe-result с `replayed=true`, не создавая второй документ;
- `in_progress`, `outcome_unknown`, конфликт ключа/исполнителя или неполный сохранённый результат
  блокируют повтор и требуют ручной сверки;
- timeout, сетевой сбой или любой неоднозначный ответ — **не повод повторять POST**, даже с новым
  UUID. Сначала сверка в 1С и журнале аудита.

Предусловия: письменное разрешение владельца demo-1С, согласованное UTC-окно, оператор в самой 1С
для немедленной сверки, подтверждённый состав/количество сырья и один назначенный исполнитель.
Затем через `sudoedit /opt/plenka/shared/pilot.env` временно выставить **обе** строки:

```text
ONEC_WRITE=true
ONEC_WRITE_CONFIRM=I_UNDERSTAND_DEMO_1C_STOCK_POSTING
```

Без точного confirmation validator и secure startup отклонят write. После редактирования:

```bash
./scripts/vps/validate-env.sh "$PLENKA_ENV_FILE"
./scripts/vps/restart.sh api
```

Повторите admin connection check из §7.1. Затем повторите блок определения `ORIGIN`/`api_login` из
§7.1 и вызовите `api_login`, войдя **реальным warehouse-аккаунтом** с capability
`raw_material:adjust`. `x-role` для live write запрещён. Получите авторитетный preview:

```bash
STOCK_PREVIEW="$(
  curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer $API_TOKEN" \
    "$ORIGIN/api/warehouse/raw-materials/onec-push-preview"
)"
jq '{items,count,totalQty,snapshotHash,writeReady,readinessCode,readinessMessage}' \
  <<<"$STOCK_PREVIEW"
jq -e '.writeReady == true and .readinessCode == "ready"' <<<"$STOCK_PREVIEW"
SNAPSHOT_HASH="$(jq -er '.snapshotHash | select(test("^[0-9a-f]{64}$"))' \
  <<<"$STOCK_PREVIEW")"

read -r -p 'Paste the exact snapshotHash shown above: ' CONFIRMED_HASH
if [[ "$CONFIRMED_HASH" != "$SNAPSHOT_HASH" ]]; then
  echo 'STOP: snapshotHash was not confirmed; do not call the write endpoint.' >&2
else
  echo 'snapshotHash confirmed; continue only if every item and quantity is approved.'
fi
```

Если hash или список не совпадают с согласованными, остановитесь. Только после точного подтверждения
создайте один новый UUIDv4 и подготовьте JSON-body. Не переиспользуйте ключ от другой операции:

```bash
OPERATION_KEY="$(cat /proc/sys/kernel/random/uuid)"
WRITE_BODY="$(
  jq -cn \
    --arg operationKey "$OPERATION_KEY" \
    --arg snapshotHash "$SNAPSHOT_HASH" \
    '{operationKey:$operationKey,snapshotHash:$snapshotHash}'
)"

read -r -p 'Type POST_DEMO_1C_STOCK_ONCE to continue: ' WRITE_CONFIRMATION
[[ "$WRITE_CONFIRMATION" == 'POST_DEMO_1C_STOCK_ONCE' ]]
```

При точном локальном подтверждении выполните endpoint **один раз** с JSON-body. Guard ниже не
обращается к endpoint, если hash или контрольная фраза не совпадают:

```bash
if [[ "$CONFIRMED_HASH" != "$SNAPSHOT_HASH" || \
      "$WRITE_CONFIRMATION" != 'POST_DEMO_1C_STOCK_ONCE' ]]; then
  echo 'STOP: controlled write was not confirmed; endpoint was not called.' >&2
else
  WRITE_RESULT="$(
    curl --fail-with-body --silent --show-error \
      -X POST \
      -H "Authorization: Bearer $API_TOKEN" \
      -H 'Content-Type: application/json' \
      --data-binary "$WRITE_BODY" \
      "$ORIGIN/api/warehouse/raw-materials/push-to-1c"
  )"
  jq '{operationKey,snapshotHash,replayed,pushed,count,totalQty,
    ack:{mode:.ack.mode,accepted:.ack.accepted,documentCreated:.ack.documentCreated,
    count:.ack.count,ref:.ack.ref}}' <<<"$WRITE_RESULT"
  jq -e --arg operationKey "$OPERATION_KEY" --arg snapshotHash "$SNAPSHOT_HASH" '
    .operationKey == $operationKey and
    .snapshotHash == $snapshotHash and
    .replayed == false and
    .ack.mode == "http" and
    .ack.accepted == true and
    .ack.documentCreated == true and
    .ack.count == .pushed and
    .pushed == .count and
    (.ack.ref | type == "string" and length > 0)
  ' <<<"$WRITE_RESULT"
fi
```

PASS требует одновременно:

- ответ echo'ит подтверждённый `snapshotHash` и использованный `operationKey`;
- `replayed=false` для первого вызова, `ack.mode=http`, `ack.documentCreated=true` и
  `ack.accepted=true`;
- `ack.count == pushed == count`, `ack.ref` непустой;
- ручная проверка в 1С подтверждает ровно один ожидаемый документ с `Posted=true` и согласованными
  строками.

Повтор успешно завершённой команды допустим только как проверка сохранённого результата: тот же
actor + `operationKey` + `snapshotHash` должен вернуть `replayed=true` и тот же `ref`, не обращаясь к
1С. Для пилотного evidence такой повтор не требуется. Если клиент/API timed out, соединение
оборвалось, сервер вернул `ONEC_STOCK_PUSH_OUTCOME_UNKNOWN`,
`ONEC_STOCK_PUSH_COMPLETION_UNKNOWN` или reconciliation-required `409`, outcome считается
неизвестным: **не повторять POST с тем же или новым ключом** до ручной сверки в 1С и журнале аудита.

Сразу после единственного вызова — успешного или неоднозначного — вернуть через `sudoedit`:

```text
ONEC_WRITE=false
ONEC_WRITE_CONFIRM=off
```

И применить read-only режим:

```bash
./scripts/vps/validate-env.sh "$PLENKA_ENV_FILE"
./scripts/vps/restart.sh api
unset WRITE_RESULT WRITE_BODY WRITE_CONFIRMATION OPERATION_KEY CONFIRMED_HASH SNAPSHOT_HASH
unset STOCK_PREVIEW API_TOKEN ORIGIN
unset -f api_login
```

На текущем checkpoint 2026-07-17 controlled write имеет статус `PENDING / DO NOT RUN`, потому что
внешний endpoint возвращает HTTP 420 и read gate не закрыт. Live write evidence 2026-07-02 — только
история, а не текущий PASS.

## 8. Backup и restore-check

Создать backup и сразу проверить его восстановлением в новой disposable DB:

```bash
./scripts/vps/backup.sh --check
```

Завершённое поколение состоит из custom-format dump, `.sha256` и публикуемого последним
`.complete`, permissions 0600. Неполная пара без marker не считается backup. Retention запускается
только у `backup.sh --check` и только после успешного восстановления нового поколения; при failure
новое поколение удаляется, а прежние backups сохраняются. Проверка создаёт отдельную БД владельцем
схемы, восстанавливает runtime grants, проверяет завершённые Prisma migrations и безопасные counts,
затем удаляет её.

Повторная проверка существующего файла:

```bash
./scripts/vps/restore.sh --check /opt/plenka/backups/plenka-<timestamp>.dump
```

Restore принимает только файлы поколения `plenka-<UTC timestamp>.dump` непосредственно внутри
настроенного `BACKUP_DIR`. Dump, `.sha256` и `.complete` должны быть обычными файлами; symlink и
путь за пределами backup root отклоняются до обращения к PostgreSQL.

Live restore — аварийная операция. Общий maintenance lock не позволяет backup пересечься с
target-check/pre-backup/check/drop/restore/verify окном. Сам `--live` до первого destructive
`DROP DATABASE` восстанавливает выбранный target в disposable DB, затем создаёт свежий pre-restore
backup и отдельно доказывает его восстановимость во второй disposable DB. Ошибка любого gate
оставляет live database нетронутой и завершает команду с ошибкой:

1. остановить API и подтвердить окно простоя;
2. предварительно проверить backup через `--check` (live-команда всё равно повторит gate);
3. убедиться, что backup хранится ещё и вне VPS;
4. выполнить команду ниже; она machine-enforce проверит target и свежий pre-restore backup;
5. запустить API и полный VPS smoke.

```bash
./scripts/vps/down.sh
./scripts/vps/database-up.sh
./scripts/vps/restore.sh --live /opt/plenka/backups/plenka-<timestamp>.dump RESTORE_LIVE_PLENKA
./scripts/vps/deploy.sh
./scripts/vps/smoke-vps.sh
```

Если restore завершился ошибкой, не запускайте API: восстановите pre-restore artifact либо
переключитесь на предыдущий проверенный volume/backup по incident-плану.

### 8.1. Одноразовая очистка pilot order/notification history

Эта owner-only операция допустима только после успешного deploy/migration и отдельного
maintenance approval. Она физически удаляет всю pilot-историю заказов и её role-inbox
проекции, но не является demo reset и не запускает seed. Перед окном штатно закройте active
operator sessions и связанную с заказами open-смену, завершите operator/warehouse operations,
разрешите все неоднозначные print/Gateway commands. Остановите **каждый** физический POST gateway
вне VPS и отдельно архивируйте его offline queue. Одного server-side `compose stop` для этого
gate недостаточно. Purge также блокируется, пока `onec_sync_runs` содержит `status=running` или
непустой `activeScopeKey`: сохранённый claim нельзя заморозить maintenance-окном. Отдельный
fail-closed gate применяется ко всему `sync_journals`, включая payment/source rows без
`financeOrderId`: допустимы только terminal `ready`/`error` с пустыми `activeScopeKey` и
`leaseExpiresAt`. Любой иной status и любая сохранённая lease (включая просроченную) требуют
штатного completion/recovery до окна; один terminal `operationKey` active claim не означает.

В maintenance-preflight `submitted` означает только завершённое platform/Gateway-подтверждение
нулевого exit code попытки локальной CUPS-submit; это не доказательство печати на бумаге. Такой
исторический статус, как и browser `intent_recorded`, допустим только при выполненном внешнем
gateway-stop assertion и нулевых nonterminal Gateway commands. `queued`, `in_flight`,
`reprint_requested` и `uncertain` остаются fail-closed. `delivery_unknown` допустим только для
roll/pallet print-команды с terminal job и отдельным append-only reconciliation; для BigBag и
мешка брака он остаётся fail-closed.

До вызова уже должна существовать проверенная внешняя копия полного поколения
`.dump`/`.sha256`/`.complete`. На доверенной operator workstation повторите checksum и TOC check;
deploy controller передаёт в root shell точное имя и SHA-256 этой копии. Не подставляйте hash
локального непроверенного файла и не переносите эти assertions в `pilot.env`:

```bash
cd <external-backup-directory>
shasum -a 256 -c plenka-<UTC-timestamp>.dump.sha256
test "$(cat plenka-<UTC-timestamp>.dump.complete)" = complete
pg_restore --list plenka-<UTC-timestamp>.dump >/dev/null
```

```bash
cd /opt/plenka/current/backend
export PLENKA_ENV_FILE=/opt/plenka/shared/pilot.env
export PILOT_GATEWAYS_STOPPED=yes
export PILOT_OFFHOST_BACKUP_VERIFIED=yes
export PILOT_OFFHOST_BACKUP_REFERENCE='plenka-YYYYMMDDTHHMMSSZ.dump:<64-lowercase-hex-sha256>'
./scripts/vps/purge-pilot-order-history.sh --confirm PURGE_PILOT_ORDER_HISTORY
unset PILOT_GATEWAYS_STOPPED PILOT_OFFHOST_BACKUP_VERIFIED PILOT_OFFHOST_BACKUP_REFERENCE
```

Чтобы вместе с заказами удалить накопленные смены, часы, зафиксированные расчёты зарплаты и мешки
брака, нужен второй независимый confirmation. Приказы/тарифы зарплаты, их команды и audit-события
эта команда сохраняет:

```bash
./scripts/vps/purge-pilot-order-history.sh --confirm PURGE_PILOT_ORDER_HISTORY \
  --include-accumulated-runtime PURGE_ACCUMULATED_RUNTIME
```

Команду нужно запускать именно как executable из фактической root-сессии (не через
`/bin/bash script`): shebang требует privileged Bash (`-p`). Первый executable construct wrapper
— единственный `if [[...]]`: только shell grammar требует флаг `p`, readonly Bash `EUID=0` и
effective uid `0` из `/proc/self/status`, прочитанного redirection-only substitution. Вся
maintenance-логика лексически находится только в true-ветке. False-ветка обращается к заведомо
unset out-of-range элементу readonly Bash `BASH_VERSINFO` через `${...:?…}`; expansion завершает
non-interactive shell до выполнения simple command.
Wrapper намеренно не вызывает до этого `set +T` или `trap -`: это уже commands на той же
startup-trap boundary, а не trust source.

Поэтому caller `EUID`/`UID`, `BASH_ENV` functions/sentinel, а также inherited `DEBUG`, `RETURN` и
`ERR` traps не могут открыть maintenance-ветку для non-root: они не способны изменить readonly
`EUID` или kernel credentials из `/proc`; Docker не запускается. Root-запуск non-privileged
`/bin/bash script` с attacker-controlled `BASH_ENV` не является поддерживаемым путём — такой env
уже исполняет произвольный root-код до wrapper. `PLENKA_LOCAL_SMOKE` и test-only переменные также
не ослабляют root, env-file или backup ownership gates.

Wrapper проверяет `APP_ENV=pilot` и `SEED_PROFILE=pilot`, берёт общий
`BACKUP_DIR/.maintenance.lock`, останавливает API/web и под тем же lock создаёт ещё один
`backup.sh --check --lock-held`. Purge выполняется owner connection одной Serializable
транзакцией с advisory xact lock; FK остаются включёнными. Любая ошибка откатывает все удаления и
временные изменения USER triggers.

Удаляются order-linked commercial/production/operator/warehouse/pallet/finance runtime facts,
operational order incidents/checks, все notification receipts, все role-inbox events и события с
явной typed-ссылкой на удалённые runtime identifiers. Из 1С evidence удаляются только доказуемо
связанные с удаляемыми заказами invoice/payment/shipment mirrors, их lines, snapshots и sync
journals; совпадение произвольного JSON-текста, номера документа, counterparty/nomenclature id или
source fingerprint доказательством не является. Global `onec_sync_runs`, stock pushes,
reference/stock catalogs and snapshots и все 1С production reports/lines сохраняются, чтобы не
изменить accounting/inventory freshness и `sourceUnavailable`.

Legacy `admin.onec.import_requested` не содержит provenance, отличающего retry локального
`FinanceOrder.id` от ручного импорта реального invoice Ref_Key. Любое fallback-shaped событие с
`objectId=detail.externalId=FinanceOrder.id` и `subjectType=invoice` завершает preflight всей
транзакции ошибкой `PILOT_PURGE_ONEC_INVOICE_IDENTITY_COLLISION` до identifier capture и удалений:
неважно, является ли id UUID и есть ли уже mirror/snapshot/import evidence. Отдельно такая же
ошибка применяется к local finance id, совпавшему с известной invoice identity в mirror, snapshot
или import evidence. Удаляются только independently typed invoice-события с уже захваченным
`onec_invoice_external_id`; fallback-event никогда не служит delete predicate. Force/ignore-флага
нет: сохраните API/web остановленными, установите происхождение id по 1С evidence и audit trail и
согласуйте отдельное исправление данных; повторять purge до устранения коллизии нельзя.

Gateway journals удаляются только после внешнего stopped assertion. Сохраняются users/access,
counterparties, template definitions и versions, material/recipe/price/reference catalogs, raw
stock, posts/device runtimes, payroll tariff orders/commands/audit, physical BigBag inventory,
coverage epoch и active pallet-layout versions/commands/hash. Без второго confirmation также
сохраняются shifts/assignments, shift BigBag usage и мешки брака. Template usage counters
сбрасываются.
`spool_stock_movements` также сохраняются: удаление defect только обнуляет nullable provenance
link, не меняя quantity, tare, spool type или location; reverse/opening movements не создаются.

После commit wrapper независимым SQL проверяет нули, отсутствие active 1С run и любого
active/unresolved `sync_journals` claim, а также preserved fingerprints, включая 1С
stock/reference freshness. API/web перезапускаются только при полном
`PASS`. Если post-commit validation **или сам restart/readiness** не прошли, cleanup повторно
останавливает оба сервиса, а stderr содержит точную
`restore.sh --live ... RESTORE_LIVE_PLENKA` инструкцию для созданного checked backup. Сохраните
incident evidence и восстановите по §8; не запускайте writers до reconciliation. Этот wrapper не
удаляет VPS backup generations и frozen legacy database: это отдельный Task 5 только после
off-host checksum/TOC verification и live smoke.

## 9. Rollback образов

Rollback-пара создаётся **до** release в §2.2: совместимый `pilot.previous.env` с предыдущими
image tags и `pilot.previous.release` с точным immutable source path. Начните отдельное maintenance
window, остановите agents `POST-1`/`POST-5`, убедитесь в отсутствии writers и проверьте, что оба
файла root-owned mode `0600`. Сначала проверьте previous env текущим validator-ом:

```bash
cd /opt/plenka/current/backend
./scripts/vps/validate-env.sh /opt/plenka/shared/pilot.previous.env
PREVIOUS_RELEASE="$(cat /opt/plenka/shared/pilot.previous.release)"
case "$PREVIOUS_RELEASE" in
  /opt/plenka/releases/*) ;;
  *) printf 'Unexpected previous release target\n' >&2; exit 1 ;;
esac
test -d "$PREVIOUS_RELEASE/backend"
test -d "$PREVIOUS_RELEASE/frontend"
```

Нельзя просто передать `pilot.previous.env` в `rollback.sh`, оставив основной `pilot.env` с
новыми tags: следующий restart/deploy снова поднимет неверный release. Восстановите **основной**
env атомарным rename, затем так же переключите source symlink на сохранённую пару:

```bash
install -o root -g root -m 0600 /opt/plenka/shared/pilot.previous.env \
  /opt/plenka/shared/pilot.env.rollback-next
mv -Tf /opt/plenka/shared/pilot.env.rollback-next /opt/plenka/shared/pilot.env

test ! -e /opt/plenka/current.rollback-next
test ! -L /opt/plenka/current.rollback-next
ln -s "$PREVIOUS_RELEASE" /opt/plenka/current.rollback-next
mv -Tf /opt/plenka/current.rollback-next /opt/plenka/current

cd /opt/plenka/current/backend
export PLENKA_ENV_FILE=/opt/plenka/shared/pilot.env
./scripts/vps/validate-env.sh "$PLENKA_ENV_FILE"
./scripts/vps/rollback.sh "$PLENKA_ENV_FILE"
./scripts/vps/smoke-vps.sh
```

Обе замены являются atomic для своего filesystem entry; контейнеры получают согласованную пару
только после validator/deploy. Если любой gate до `deploy.sh` падает, не перезапускайте сервисы,
устраните несогласованность source/env под maintenance.

Rollback приложения не откатывает миграции автоматически. Если новый schema не
backward-compatible, до запуска старого API восстановите внешний pre-deploy backup по §8; не
запускайте старый API поверх несовместимой схемы. Rollback считается PASS только после проверки
точных source SHA, image tags, primary env, readiness/login и отсутствия public DB/API bindings.

## 10. Что сохранять как evidence

Сохраняйте только redacted факты: git SHA/image tags, время, exit status, health state,
certificate issuer/expiry, имя backup artifact и checksum verification result. Не сохраняйте
пароли, tokens, `.env`, TLS private keys, dump contents, raw frames, QR/customer data или device
serial IDs.

Каждая запись evidence обязана содержать оба SHA и checksum двух source archives. Любой факт без
этой пары или факт от предыдущего release имеет статус `HISTORICAL`, а не `PASS` нового HEAD.
Актуальный VPS PASS появляется только после deploy exact archives, нового `smoke-vps.sh` и нового
browser checklist; существующие healthy containers и старый screenshot этого не доказывают.

Для 1С дополнительно допустимы только UTC-время, `mode/status/errorCategory`, HTTP status без
credentials/body, количество импортированных safe projections, `sourceKind` и факт ручной сверки
controlled write. Не прикладывайте OData body, `rawPayload`, Basic/Bearer credentials или полный
складской payload. Пока фактический результат — HTTP `420 Not found`, evidence маркируется
`PENDING (external endpoint blocker)`, не `PASS`.

После успешного VPS smoke статус физического теста всё ещё `PENDING`, пока тестировщик не выполнит
отдельный аппаратный runbook на реальных Massa-K/MERTECH/SG-110-BT.

## 11. Единый physical release и staged rollout gateway

Backend/frontend deployment и пакет gateway считаются одним release candidate. Для него обязателен
неизменяемый `physical-device-manifest.json` по схеме
`deploy/release/physical-device-manifest.schema.json`. Manifest не хранится как «последний» файл в
Git: он создаётся для конкретных собранных artifacts и затем архивируется вместе с evidence.

### 11.1. Сформировать и проверить candidate

Предусловия: оба source archive уже проверены, образы собраны под точными commit tags, gateway
`.deb` собран `scripts/gateway/build-deb-container.sh`, а новый каталог candidate не содержит
старого manifest.

```bash
test -n "${BACKEND_SHA:?exact backend commit is required}"
test -n "${FRONTEND_SHA:?exact frontend commit is required}"
test -n "${RELEASE_ARTIFACT_DIR:?candidate artifact directory is required}"
test -d "$RELEASE_ARTIFACT_DIR/gateway"
test ! -e "$RELEASE_ARTIFACT_DIR/physical-device-manifest.json"

BACKEND_IMAGE_DIGEST="$(
  docker image inspect "plenka-api:$BACKEND_SHA" --format '{{.Id}}'
)"
FRONTEND_IMAGE_DIGEST="$(
  docker image inspect "plenka-web:$FRONTEND_SHA" --format '{{.Id}}'
)"
[[ "$BACKEND_IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  { printf 'STOP: backend image digest is invalid\n' >&2; exit 1; }
[[ "$FRONTEND_IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  { printf 'STOP: frontend image digest is invalid\n' >&2; exit 1; }

mapfile -t GATEWAY_DEBS < <(
  find "$RELEASE_ARTIFACT_DIR/gateway" -maxdepth 1 -type f \
    -name 'plenka-gateway-agent_*_amd64.deb' -print
)
test "${#GATEWAY_DEBS[@]}" -eq 1
GATEWAY_DEB="${GATEWAY_DEBS[0]}"
test -f "$GATEWAY_DEB"
test ! -L "$GATEWAY_DEB"
GATEWAY_EXTRACT="$(mktemp -d)"
dpkg-deb --extract "$GATEWAY_DEB" "$GATEWAY_EXTRACT"
mapfile -t GATEWAY_BUILD_INFOS < <(
  find "$GATEWAY_EXTRACT/usr/share/doc/plenka-gateway-agent" -maxdepth 1 \
    -type f -name BUILD-INFO -print
)
test "${#GATEWAY_BUILD_INFOS[@]}" -eq 1
GATEWAY_BUILD_INFO="${GATEWAY_BUILD_INFOS[0]}"
test -s "$GATEWAY_BUILD_INFO"

node scripts/release/physical-device-manifest.mjs create \
  --output "$RELEASE_ARTIFACT_DIR/physical-device-manifest.json" \
  --backend-commit "$BACKEND_SHA" \
  --backend-image-digest "$BACKEND_IMAGE_DIGEST" \
  --frontend-commit "$FRONTEND_SHA" \
  --frontend-image-digest "$FRONTEND_IMAGE_DIGEST" \
  --gateway-package "$GATEWAY_DEB" \
  --gateway-build-info "$GATEWAY_BUILD_INFO"

node scripts/release/physical-device-manifest.mjs verify \
  --manifest "$RELEASE_ARTIFACT_DIR/physical-device-manifest.json" \
  --gateway-package "$GATEWAY_DEB" \
  --gateway-build-info "$GATEWAY_BUILD_INFO"
```

После PASS сохраните package `.sha256`, manifest SHA-256, source archive checksums и read-only
копию manifest вне VPS. Manifest нельзя перезаписать: изменился любой artifact — создаётся новый
release directory и новый manifest.

### 11.2. Preflight и rollback package POST-1

До передачи candidate на POST-1:

- backend/frontend exact candidate уже прошли migration и smoke либо staging endpoint;
- off-host DB backup проверен восстановлением;
- предыдущая VPS release pair сохранена;
- предыдущий exact gateway `.deb` и его checksum доступны локально на посту;
- `/etc/plenka-gateway/agent.env` и `/var/lib/plenka-gateway` не копируются и не очищаются;
- открытых неоднозначных print commands нет.

На POST-1 сначала укажите exact absolute paths из проверенного manifest bundle. Каталог и имена
заполняются без wildcard:

```bash
test -n "${POST_CANDIDATE_DIR:?exact candidate directory is required}"
test -n "${POST_CANDIDATE_DEB:?exact candidate deb is required}"
test -n "${POST_CANDIDATE_SHA256:?exact candidate checksum file is required}"
[[ "$POST_CANDIDATE_DIR" == /* ]]
[[ "$POST_CANDIDATE_DEB" == "$POST_CANDIDATE_DIR/"* ]]
[[ "$POST_CANDIDATE_SHA256" == "$POST_CANDIDATE_DIR/"* ]]
test -d "$POST_CANDIDATE_DIR"
test ! -L "$POST_CANDIDATE_DIR"
test -f "$POST_CANDIDATE_DEB"
test ! -L "$POST_CANDIDATE_DEB"
test -f "$POST_CANDIDATE_SHA256"
test ! -L "$POST_CANDIDATE_SHA256"

test "$(wc -l <"$POST_CANDIDATE_SHA256" | tr -d ' ')" -eq 1
read -r POST_EXPECTED_SHA POST_EXPECTED_NAME <"$POST_CANDIDATE_SHA256"
[[ "$POST_EXPECTED_SHA" =~ ^[0-9a-f]{64}$ ]]
test "$POST_EXPECTED_NAME" = "${POST_CANDIDATE_DEB##*/}"
POST_ACTUAL_SHA="$(sha256sum "$POST_CANDIDATE_DEB")"
POST_ACTUAL_SHA="${POST_ACTUAL_SHA%% *}"
test "$POST_ACTUAL_SHA" = "$POST_EXPECTED_SHA"

sudo dpkg-query -W -f='${Package} ${Version}\n' plenka-gateway-agent
sudo systemctl stop plenka-gateway.service
sudo apt install "$POST_CANDIDATE_DEB"
sudo /opt/plenka-gateway/node \
  --env-file=/etc/plenka-gateway/agent.env \
  /opt/plenka-gateway/main.js --check-config
sudo systemctl start plenka-gateway.service
sudo systemctl --no-pager --full status plenka-gateway.service
```

Checksum-файл в bundle обязан соответствовать `gateway.packageSha256` manifest. Ручное
переименование `.deb`, wildcard и установка файла вне проверенного candidate directory запрещены.

В течение 60 секунд admin matrix должна показать:

- `connectionState=online`;
- exact package/source commit/protocol из manifest;
- `agentCompatibility=compatible`;
- полный capability set;
- ровно по одному enabled scale/printer/scanner binding;
- свежие device heartbeat и probe.

Любое несовпадение — `NO-GO`. Остановите candidate, установите exact предыдущий `.deb`, запустите
его и подтвердите прежний compatible heartbeat. Environment и durable outbox при rollback не
заменяются. Если print мог попасть в CUPS до потери ответа, command остаётся `delivery_unknown`;
автоматический повтор запрещён.

### 11.3. Commissioning и физическая приёмка

`Post.status=active`, binding и heartbeat отдельно не дают готовность. POST-1 вводится в
эксплуатацию audited действием «Ввести» только после:

1. пустой платформы, известного груза, нестабильного груза и реального рулона;
2. по одной физически вышедшей roll, Big-Bag и pallet label;
3. реального HID-скана в RU и EN раскладках;
4. operator → handover → warehouse flow;
5. unplug/replug весов, printer-off, restart agent/API и network-loss сценариев;
6. трёх последовательных roll cycles без simulator, direct SQL и duplicate print.

Результат фиксируется в
`docs/qa/2026-08-04-physical-device-recovery-acceptance.md`. POST-2…POST-7 остаются
`uncommissioned` и недоступными для назначения, пока каждый отдельно не пройдёт тот же checklist.

## 12. Recovery Guard: штатное восстановление после отказов

Recovery Guard не создаёт второй механизм бизнес-состояний. Он использует существующие Docker
healthchecks, durable gateway queue/outbox, admin platform health и проверенные backup/restore
скрипты. `ONEC_WRITE=false` остаётся обязательным; guard не вызывает 1С и не меняет данные
весов, принтеров или сканеров.

### 12.1. Установка и проверенный откат VPS watchdog

До установки проверьте exact candidate и сохраните текущие unit-файлы, если они уже существуют:

```bash
cd /opt/plenka/current/backend
systemd-analyze verify \
  deploy/vps/plenka-recovery-guard.service \
  deploy/vps/plenka-recovery-guard.timer
UNIT_BACKUP="/opt/plenka/backups/recovery-guard-units-$(date -u +%Y%m%dT%H%M%SZ)"
test ! -e "$UNIT_BACKUP"
install -d -o root -g root -m 0700 "$UNIT_BACKUP"
for UNIT in plenka-recovery-guard.service plenka-recovery-guard.timer; do
  if test -e "/etc/systemd/system/$UNIT"; then
    install -o root -g root -m 0644 "/etc/systemd/system/$UNIT" \
      "$UNIT_BACKUP/$UNIT"
    cmp -s "/etc/systemd/system/$UNIT" "$UNIT_BACKUP/$UNIT"
  else
    install -o root -g root -m 0600 /dev/null "$UNIT_BACKUP/$UNIT.absent"
  fi
done
printf 'Rollback evidence: UNIT_BACKUP=%s\n' "$UNIT_BACKUP"
```

Проверенный откат выполняется точными целями (укажите сохранённый каталог этого rollout):

```bash
UNIT_BACKUP='/opt/plenka/backups/recovery-guard-units-<UTC-from-backup-step>'
systemctl disable --now plenka-recovery-guard.timer || true
for UNIT in plenka-recovery-guard.service plenka-recovery-guard.timer; do
  if test -f "$UNIT_BACKUP/$UNIT"; then
    install -o root -g root -m 0644 "$UNIT_BACKUP/$UNIT" "/etc/systemd/system/$UNIT"
  elif test -f "$UNIT_BACKUP/$UNIT.absent"; then
    rm -f -- "/etc/systemd/system/$UNIT"
  else
    echo "STOP: rollback evidence missing for $UNIT" >&2
    exit 1
  fi
done
systemctl daemon-reload
systemctl reset-failed plenka-recovery-guard.service || true
```

Только после проверки backup и этой rollback-команды устанавливайте candidate:

```bash
install -o root -g root -m 0644 deploy/vps/plenka-recovery-guard.service \
  /etc/systemd/system/plenka-recovery-guard.service
install -o root -g root -m 0644 deploy/vps/plenka-recovery-guard.timer \
  /etc/systemd/system/plenka-recovery-guard.timer
systemctl daemon-reload
systemctl enable --now plenka-recovery-guard.timer
systemctl start plenka-recovery-guard.service
systemctl --no-pager --full status plenka-recovery-guard.timer
journalctl -u plenka-recovery-guard.service --since '10 minutes ago' --no-pager
```

Timer проверяет состояние раз в минуту. Он перезапускает только `api` с healthy PostgreSQL и
отдельно `web`, только когда встроенный Docker healthcheck уже перешёл в `unhealthy`. Состояния
`starting`, `healthy`, отсутствующий или явно остановленный container не мутируются. PostgreSQL
автоматически не перезапускается: при его отказе нужен §8, а не цикл рестартов.

### 12.2. Электричество и интернет на посту

Canonical gateway unit использует `Restart=always` и `WantedBy=multi-user.target`. После возврата
питания агент стартует с Ubuntu, загружает durable event/result outbox и восстанавливает исходящее
соединение сам. Полная потеря интернета блокирует новые физические команды: локальная автономная
смена не входит в v1.

Команда печати, которую агент не успел забрать, получает `expired` и может быть повторена обычным
операторским действием. Уже забранная печать остаётся `delivery_unknown`, поэтому слепого дубля
нет. Точный поздний ответ принимается только с прежней lease и получает отдельный audit fact;
если бизнес-задание всё ещё неоднозначно, администратор использует существующее audited
согласование этикетки, а не SQL.

### 12.3. Потеря VPS

Active-active и автоматическое переключение DNS не входят в v1. Для нового VPS нужны exact
backend/frontend release archives, `pilot.env`, gateway package/manifest и проверенное внешнее
backup generation (`.dump`, `.sha256`, `.complete`). После базовой установки Docker скопируйте
generation непосредственно в `BACKUP_DIR`, выставьте `root:root 0600` и активируйте exact release,
которым это поколение было создано. На новом хосте `api`/`web` не должны быть запущены, а
application DB обязана быть пустой. Затем выполните одну guarded-команду:

```bash
cd /opt/plenka/current/backend
export PLENKA_ENV_FILE=/opt/plenka/shared/pilot.env
./scripts/vps/disaster-recover.sh \
  /opt/plenka/backups/plenka-<timestamp>.dump \
  RECOVER_EMPTY_VPS_PLENKA
```

Команда проверяет backup в disposable DB до проверки/изменения схемы, отказывается от непустой
БД и от `ONEC_WRITE!=false`, создаёт проверяемый pre-restore baseline, вызывает существующий live
restore, deploy и полный VPS smoke. Любая ошибка оставляет `api`/`web` остановленными. Для живого
VPS применяется §8, а не этот new-host wrapper. Непроверенный dump, backup только на потерянном VPS
или отсутствующая exact release pair являются blocker.

### 12.4. Evidence

К §10 добавьте UTC-время, `systemctl is-enabled/is-active` timer, redacted строки watchdog journal,
состояния `db/api/web`, gateway package version, факт автоматического reconnect, имя backup и
checksum/restore-check result. Не сохраняйте env, токены, QR, raw payload или device serial ID.
