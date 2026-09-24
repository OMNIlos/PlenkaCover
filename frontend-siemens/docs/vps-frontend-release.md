# Frontend image for the VPS pilot

The production frontend is an immutable Vite build served by Caddy. Browser API calls remain
same-origin under `/api`; the image accepts no API-base or secret build arguments.

## Verify and build

Run from `frontend-siemens` with Node 22.19.0 or newer and Docker available:

```bash
npm ci
npm test -- --run src/deployment/productionImageContract.test.ts
npm test -- --run
npm run check:warehouse-coverage-v2
npm run build
npm run check:director-analytics:max-label
test -z "$(git status --porcelain)"
WEB_TAG="$(git rev-parse --verify HEAD)"
docker build --pull --tag "plenka-web:${WEB_TAG}" .
docker image inspect "plenka-web:${WEB_TAG}"
```

Coverage V2 acceptance allocates separate loopback ports and disposable PostgreSQL schemas for
both required viewports. It requires the matching backend checkout with the guarded browser
fixture and a local development PostgreSQL listener on port `5433`.

The director maximum-label check rebuilds the frontend and fails closed unless the tied maximum,
leader geometry, URL-restored filters and 1024px overflow contract all pass. The extended
`check:nightly` composition invokes the same package check.

`WEB_TAG` is the full Git commit and remains a useful registry locator. Release publication must
produce one manifest for the VPS (`linux/amd64`) and Apple Silicon/operator-post verification
(`linux/arm64`), then resolve that mutable locator to an immutable digest:

```bash
REGISTRY_IMAGE="${REGISTRY_IMAGE:?set the registry/repository path}"
RELEASE_REF="${REGISTRY_IMAGE}:${WEB_TAG}"
docker buildx inspect --bootstrap
docker buildx build \
  --pull \
  --platform linux/amd64,linux/arm64 \
  --tag "$RELEASE_REF" \
  --push .

MANIFEST="$(docker buildx imagetools inspect "$RELEASE_REF")"
printf '%s\n' "$MANIFEST"
printf '%s\n' "$MANIFEST" | grep -Eq 'Platform:[[:space:]]+linux/amd64'
printf '%s\n' "$MANIFEST" | grep -Eq 'Platform:[[:space:]]+linux/arm64'
WEB_DIGEST="$(
  printf '%s\n' "$MANIFEST" |
    sed -n 's/^Digest:[[:space:]]*//p' |
    head -n 1
)"
test "${WEB_DIGEST#sha256:}" != "$WEB_DIGEST"
test "${#WEB_DIGEST}" -eq 71
PLENKA_WEB_IMAGE="${REGISTRY_IMAGE}@${WEB_DIGEST}"
printf 'PLENKA_WEB_IMAGE=%s\n' "$PLENKA_WEB_IMAGE"
```

Set backend Task 9's `PLENKA_WEB_IMAGE` to the printed digest reference, not the Git tag. Keep
registry credentials outside this repository.

## Integration contract

The image-default `Caddyfile` is deliberately local-only: it listens on `:8080`, serves `/srv`,
supports SPA deep links, and returns `503` for `/api/*`. It does not configure a backend or
certificate.

The VPS Compose deployment bind-mounts its authoritative `deploy/vps/Caddyfile` at
`/etc/caddy/Caddyfile`. That file publishes ports 80/443, obtains the pilot certificate, routes
`/api/*` to the private API service before the SPA fallback, and keeps `/srv` as the static root.
The Compose healthcheck uses the runtime image's BusyBox `wget` against Caddy's local admin API.

The Vite production build always evaluates `import.meta.env.PROD` to `true`. Do not add
`VITE_REQUIRE_AUTH=off`; authenticated production mode does not render the demo role switcher.
With no explicit development override, the production build enables all seven live contours;
operator and warehouse therefore use the same-origin VPS API rather than fixture data.

## Standalone smoke

This smoke does not exercise the VPS proxy or public certificate:

```bash
CONTAINER="plenka-web-smoke-$$"
docker run --detach --rm --name "$CONTAINER" \
  --cap-drop ALL \
  --cap-add NET_BIND_SERVICE \
  --security-opt no-new-privileges:true \
  --publish 127.0.0.1:18080:8080 "plenka-web:${WEB_TAG}"
trap 'docker rm --force "$CONTAINER" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 40); do
  test "$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER")" = 'healthy' && break
  sleep 0.5
done
test "$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER")" = 'healthy'
curl --fail --silent --show-error --output /dev/null http://127.0.0.1:18080/
curl --fail --silent --show-error --output /dev/null \
  http://127.0.0.1:18080/operator/deep-link
curl --fail --silent --show-error --output /dev/null \
  http://127.0.0.1:18080/brand/logo-plenki.svg
test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  http://127.0.0.1:18080/api/health)" = '503'
test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  http://127.0.0.1:18080/assets/app.js.map)" = '404'
docker rm --force "$CONTAINER"
trap - EXIT
```

Public VPS TLS smoke and physical-post smoke remain `PENDING` until the release candidate is
deployed to the rented VPS and exercised from the industrial post.
