#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

[[ $# -eq 1 ]] || {
  printf 'usage: %s OUTPUT_DIR\n' "${0##*/}" >&2
  exit 2
}

for command in docker git; do
  command -v "$command" >/dev/null || {
    printf 'ERROR: required command is missing: %s\n' "$command" >&2
    exit 1
  }
done

[[ -d "$ROOT/.git" ]] || {
  printf 'ERROR: run the release wrapper from the canonical checkout, not a linked worktree\n' >&2
  exit 1
}
[[ "$(git rev-parse --is-shallow-repository)" == false ]] || {
  printf 'ERROR: release package requires a complete Git history, not a shallow checkout\n' >&2
  exit 1
}
git diff-index --quiet HEAD -- || {
  printf 'ERROR: release package requires a clean tracked tree\n' >&2
  exit 1
}
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || {
  printf 'ERROR: release package requires a clean tree without untracked files\n' >&2
  exit 1
}

output="$1"
[[ "$output" == /* ]] || output="$ROOT/$output"
if [[ -e "$output" ]]; then
  [[ -d "$output" && -z "$(find "$output" -mindepth 1 -maxdepth 1 -print -quit)" ]] || {
    printf 'ERROR: OUTPUT_DIR must be empty: %s\n' "$output" >&2
    exit 1
  }
else
  mkdir -p -- "$output"
fi
output="$(cd "$output" && pwd -P)"

image='node:22.23.1-bookworm@sha256:5647be709086c696ff32edaaf1c70cd26d1da6ab2b39c32f3c7b4c4a31957e37'
docker run --rm --platform linux/amd64 \
  -e "HOST_UID=$(id -u)" \
  -e "HOST_GID=$(id -g)" \
  -v "$ROOT:/source:ro" \
  -v "$output:/out" \
  "$image" bash -lc '
    set -Eeuo pipefail
    git clone --quiet --no-local /source /build
    cd /build
    npm ci --no-audit --no-fund >/dev/null
    npm run build -w @plenka/contracts >/dev/null
    ./scripts/gateway/build-deb.sh /out
    chown -R "$HOST_UID:$HOST_GID" /out
  '
