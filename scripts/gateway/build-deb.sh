#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

usage() {
  printf 'usage: %s [--stage-only] OUTPUT_DIR\n' "${0##*/}" >&2
  exit 2
}

stage_only=false
if [[ "${1:-}" == '--stage-only' ]]; then
  stage_only=true
  shift
fi
[[ $# -eq 1 ]] || usage

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
mkdir -p "$output/root"
package_root="$output/root"

head_sha="$(git rev-parse HEAD)"
release_sha="${PLENKA_RELEASE_SHA:-$head_sha}"
[[ "$release_sha" =~ ^[0-9a-f]{12,64}$ ]] || {
  printf 'ERROR: PLENKA_RELEASE_SHA must be 12-64 lowercase hex characters\n' >&2
  exit 1
}
actual_source_tree="$(git rev-parse "${release_sha}^{tree}" 2>/dev/null || true)"
source_tree="${PLENKA_SOURCE_TREE:-$actual_source_tree}"
[[ "$source_tree" =~ ^[0-9a-f]{40}$|^[0-9a-f]{64}$ ]] || {
  printf 'ERROR: PLENKA_SOURCE_TREE must be a full Git tree object ID\n' >&2
  exit 1
}
actual_release_revision="$(git rev-list --count "$release_sha" 2>/dev/null || true)"
release_revision="${PLENKA_RELEASE_REVISION:-$actual_release_revision}"
[[ "$release_revision" =~ ^[1-9][0-9]{0,8}$ ]] || {
  printf 'ERROR: PLENKA_RELEASE_REVISION must be a positive full-history revision count\n' >&2
  exit 1
}
if ! $stage_only; then
  [[ "$(git rev-parse --is-shallow-repository)" == false ]] || {
    printf 'ERROR: final package requires a complete Git history\n' >&2
    exit 1
  }
  [[ "$release_sha" == "$head_sha" ]] || {
    printf 'ERROR: PLENKA_RELEASE_SHA must equal the checked-out HEAD\n' >&2
    exit 1
  }
  git diff-index --quiet HEAD -- || {
    printf 'ERROR: final package requires a clean tracked tree\n' >&2
    exit 1
  }
  [[ -z "$(git status --porcelain --untracked-files=normal)" ]] || {
    printf 'ERROR: final package requires a clean tree without untracked files\n' >&2
    exit 1
  }
  [[ "$source_tree" == "$actual_source_tree" ]] || {
    printf 'ERROR: PLENKA_SOURCE_TREE must equal the release commit tree\n' >&2
    exit 1
  }
  [[ "$release_revision" == "$actual_release_revision" ]] || {
    printf 'ERROR: PLENKA_RELEASE_REVISION must equal the full-history revision count\n' >&2
    exit 1
  }
fi

source_date_epoch="${SOURCE_DATE_EPOCH:-}"
commit_epoch="$(git show -s --format=%ct "$release_sha" 2>/dev/null || true)"
if [[ -z "$source_date_epoch" ]]; then
  source_date_epoch="$commit_epoch"
  [[ -n "$source_date_epoch" ]] || {
    printf 'ERROR: SOURCE_DATE_EPOCH is required when release SHA is not a local commit\n' >&2
    exit 1
  }
fi
[[ "$source_date_epoch" =~ ^[1-9][0-9]{8,}$ ]] || {
  printf 'ERROR: SOURCE_DATE_EPOCH must be a positive Unix timestamp\n' >&2
  exit 1
}
if ! $stage_only && [[ "$source_date_epoch" != "$commit_epoch" ]]; then
  printf 'ERROR: SOURCE_DATE_EPOCH must equal the release commit timestamp\n' >&2
  exit 1
fi
export SOURCE_DATE_EPOCH="$source_date_epoch"

base_version="$(node -p "require('./apps/gateway-agent/package.json').version")"
artifact_version="${base_version}+git${release_revision}.${source_date_epoch}.${release_sha:0:12}"
debian_version="1:${artifact_version}"

for command in node npm; do
  command -v "$command" >/dev/null || {
    printf 'ERROR: required command is missing: %s\n' "$command" >&2
    exit 1
  }
done
[[ -x node_modules/.bin/esbuild ]] || {
  printf 'ERROR: run npm ci at the monorepo root before packaging\n' >&2
  exit 1
}
contracts_dist='packages/contracts/dist/index.js'
[[ -f "$contracts_dist" ]] || {
  printf 'ERROR: build @plenka/contracts before packaging\n' >&2
  exit 1
}
gateway_protocol_version="$(
  node -e '
    const { GATEWAY_PROTOCOL_VERSION } = require("./packages/contracts/dist/index.js");
    process.stdout.write(String(GATEWAY_PROTOCOL_VERSION));
  '
)"
gateway_capabilities="$(
  node -e '
    const { GATEWAY_CAPABILITIES } = require("./packages/contracts/dist/index.js");
    process.stdout.write(GATEWAY_CAPABILITIES.join(","));
  '
)"
[[ "$gateway_protocol_version" =~ ^[1-9][0-9]*$ ]] || {
  printf 'ERROR: gateway protocol contract is invalid\n' >&2
  exit 1
}
[[ "$gateway_capabilities" =~ ^[a-z0-9][a-z0-9.-]*(,[a-z0-9][a-z0-9.-]*)*$ ]] || {
  printf 'ERROR: gateway capability contract is invalid\n' >&2
  exit 1
}

install -d "$package_root/DEBIAN"
install -d "$package_root/opt/plenka-gateway"
install -d "$package_root/lib/systemd/system"
install -d "$package_root/usr/bin"
install -d "$package_root/usr/share/doc/plenka-gateway-agent"

sed "s/@VERSION@/$debian_version/g" deploy/gateway-agent/DEBIAN/control.in \
  >"$package_root/DEBIAN/control"
install -m 0755 deploy/gateway-agent/DEBIAN/postinst "$package_root/DEBIAN/postinst"
install -m 0755 deploy/gateway-agent/DEBIAN/prerm "$package_root/DEBIAN/prerm"
install -m 0755 deploy/gateway-agent/DEBIAN/postrm "$package_root/DEBIAN/postrm"
install -m 0644 deploy/gateway-agent/plenka-gateway.service \
  "$package_root/lib/systemd/system/plenka-gateway.service"
install -m 0755 deploy/gateway-agent/plenka-gateway-probe \
  "$package_root/usr/bin/plenka-gateway-probe"
install -m 0644 deploy/gateway-agent/agent.env.example \
  "$package_root/usr/share/doc/plenka-gateway-agent/agent.env.example"
install -m 0644 deploy/gateway-agent/README.md \
  "$package_root/usr/share/doc/plenka-gateway-agent/README.md"
{
  printf 'Release-Commit: %s\n' "$release_sha"
  printf 'Release-Revision: %s\n' "$release_revision"
  printf 'Debian-Version: %s\n' "$debian_version"
  printf 'Source-Tree: %s\n' "$source_tree"
  printf 'Source-Date-Epoch: %s\n' "$source_date_epoch"
  printf 'Node-Runtime: 22.23.1\n'
  printf 'Gateway-Protocol-Version: %s\n' "$gateway_protocol_version"
  printf 'Gateway-Capabilities: %s\n' "$gateway_capabilities"
} >"$package_root/usr/share/doc/plenka-gateway-agent/BUILD-INFO"

node_modules/.bin/esbuild apps/gateway-agent/src/main.ts \
  --bundle --platform=node --format=cjs --target=node20 --external:serialport \
  --sources-content=false --sourcemap \
  --outfile="$package_root/opt/plenka-gateway/main.js" >/dev/null
node_modules/.bin/esbuild apps/gateway-agent/src/probe-scale.ts \
  --bundle --platform=node --format=cjs --target=node20 --external:serialport \
  --sources-content=false --sourcemap \
  --outfile="$package_root/opt/plenka-gateway/probe-scale.js" >/dev/null
node_modules/.bin/esbuild apps/gateway-agent/src/check-config.ts \
  --bundle --platform=node --format=cjs --target=node22 \
  --sources-content=false --sourcemap \
  --outfile="$package_root/opt/plenka-gateway/check-config.js" >/dev/null

install -m 0644 deploy/gateway-agent/runtime/package.json \
  "$package_root/opt/plenka-gateway/package.json"
install -m 0644 deploy/gateway-agent/runtime/package-lock.json \
  "$package_root/opt/plenka-gateway/package-lock.json"

if ! $stage_only; then
  [[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || {
    printf 'ERROR: final amd64 package must be built on Linux x86_64\n' >&2
    exit 1
  }
  for command in dpkg dpkg-deb; do
    command -v "$command" >/dev/null || {
      printf 'ERROR: required Debian packaging command is missing: %s\n' "$command" >&2
      exit 1
    }
  done
  previous_revision=$((release_revision - 1))
  worst_previous_version="1:${base_version}+git${previous_revision}.99999999999999999999.ffffffffffff"
  legacy_timestamp_version="${base_version}+git99999999999999999999.ffffffffffff"
  dpkg --compare-versions "$debian_version" gt "$worst_previous_version" &&
    dpkg --compare-versions "$debian_version" gt "$legacy_timestamp_version" || {
    printf 'ERROR: release version is not monotonic under Debian ordering\n' >&2
    exit 1
  }
  [[ "$(node -p 'process.arch')" == x64 && "$(node -p 'process.versions.node')" == 22.23.1 ]] || {
    printf 'ERROR: final package must be built with the pinned Node.js 22.23.1 x64 runtime\n' >&2
    exit 1
  }
  install -m 0755 "$(command -v node)" "$package_root/opt/plenka-gateway/node"
  npm ci --omit=dev --no-audit --no-fund --prefix "$package_root/opt/plenka-gateway"
fi

if command -v sha256sum >/dev/null; then
  (
    cd "$package_root"
    find opt lib usr -type f -print0 | sort -z | xargs -0 sha256sum
  ) >"$output/SHA256SUMS"
else
  (
    cd "$package_root"
    find opt lib usr -type f -print0 | sort -z | xargs -0 shasum -a 256
  ) >"$output/SHA256SUMS"
fi

if $stage_only; then
  printf 'Gateway package staging tree: %s\n' "$package_root"
  exit 0
fi

artifact="$output/plenka-gateway-agent_${artifact_version}_amd64.deb"
find "$package_root" -print0 | xargs -0 touch -h -d "@$SOURCE_DATE_EPOCH"
dpkg-deb --root-owner-group --uniform-compression -Zxz \
  --build "$package_root" "$artifact" >/dev/null
(
  cd "$output"
  sha256sum "${artifact##*/}" >"${artifact##*/}.sha256"
)
printf 'Gateway package: %s\n' "$artifact"
