#!/usr/bin/env bash
set -Eeuo pipefail

required=(
  POSTGRES_USER
  POSTGRES_DB
  DATABASE_OWNER_USER
  DATABASE_OWNER_PASSWORD
  DATABASE_APP_USER
  DATABASE_APP_PASSWORD
)
for key in "${required[@]}"; do
  [[ -n "${!key:-}" ]] || {
    printf 'database initialization rejected: missing %s\n' "$key" >&2
    exit 1
  }
done

if [[ ! "$POSTGRES_DB" =~ ^[a-z][a-z0-9_]{2,62}$ ]] ||
  [[ "$POSTGRES_DB" =~ ^(postgres|template0|template1)$ ]]; then
  printf '%s\n' 'database initialization rejected: unsafe application database name' >&2
  exit 1
fi

[[ "$POSTGRES_USER" != "$DATABASE_OWNER_USER" && "$POSTGRES_USER" != "$DATABASE_APP_USER" && \
  "$DATABASE_OWNER_USER" != "$DATABASE_APP_USER" ]] || {
  printf '%s\n' 'database initialization rejected: roles must be distinct' >&2
  exit 1
}

psql \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 \
  --set=database_name="$POSTGRES_DB" \
  --set=owner_user="$DATABASE_OWNER_USER" \
  --set=owner_password="$DATABASE_OWNER_PASSWORD" \
  --set=app_user="$DATABASE_APP_USER" \
  --set=app_password="$DATABASE_APP_PASSWORD" <<'SQL'
SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  :'owner_user', :'owner_password'
) \gexec

SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  :'app_user', :'app_password'
) \gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', :'database_name', :'owner_user') \gexec
\connect :database_name

SELECT format('ALTER SCHEMA public OWNER TO %I', :'owner_user') \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'database_name', :'app_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_user') \gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
  :'owner_user', :'app_user'
) \gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I',
  :'owner_user', :'app_user'
) \gexec
SQL

printf '%s\n' 'database owner and least-privileged application role initialized'
