# VPS deployment assets

- `compose.yml` — production/pilot topology; only web publishes 80/443. API has a dedicated
  outbound-only network for live 1C DNS/HTTPS, while the database remains on the internal network.
- `init-database.sh` — one-time creation of separate schema-owner and least-privileged API roles.
- `Caddyfile` — same-origin API reverse proxy and public short-lived ACME profile.
- `.env.example` — non-deployable shape; all `replace-me` values are intentionally rejected.
- `plenka-recovery-guard.{service,timer}` — host-level timer that restarts only an unhealthy API
  or web container; it never restarts PostgreSQL or runs business/1C operations.

The real env is `root:root 0600`; deployment scripts run from an explicit root operator shell.
Backups are complete only when dump, `.sha256` and `.complete` exist. Use
`scripts/vps/validate-env.sh` and follow
`docs/operations/vps-pilot-runbook.md`. Never place the real `pilot.env`, TLS keys or database
artifacts in this directory.

The VPS backup root is exactly `/opt/plenka/backups` (`root:root`, mode `0700`, no symlinks).
Restore accepts only a canonical `plenka-<UTC timestamp>.dump` generation directly in that root;
the dump, checksum and completion marker must all be regular non-symlink files.
Application database names must not use the PostgreSQL maintenance databases `postgres`,
`template0` or `template1`. Live restore verifies both its selected artifact and a fresh
pre-restore artifact in disposable databases before dropping the live database.

The reviewed immutable backend base is Node.js 22.23.1 and the database image is PostgreSQL
16.14. Both tags are additionally pinned to their official multi-platform image digests.

`PUBLIC_HOST` must be a canonical DNS name or globally routable canonical IPv4 literal for the
public ACME profile. Numeric aliases, numeric final DNS labels, IANA special-purpose IPv4 ranges
and deterministic non-public DNS namespaces (`.localhost`, `.test`, `.invalid`, `.example`,
`.local`, `.onion`, `.internal`, `.alt`, `.home.arpa` and the reserved example domains) fail
preflight. The pilot also rejects `.arpa` infrastructure names and IDN/punycode labels instead of
partially reimplementing URL/IDNA canonicalization in shell. Literal IPv6 is intentionally
unsupported; use an ASCII DNS name with A/AAAA. Preflight validates a static policy, while real
DNS routing and certificate issuance remain VPS smoke evidence. Retention counts are canonical
base-10 integers without leading zeroes.

The web container currently retains the image's root user because Caddy binds 80/443 and must
initialize its `/data` and `/config` volumes. Its image filesystem is read-only, `/tmp` is a bounded
tmpfs, those two named volumes are its only durable writable paths, all ambient capabilities are
dropped, and only `NET_BIND_SERVICE` is restored. Moving Caddy to a non-root user requires an
explicit volume-ownership bootstrap plus high internal ports and is not safe to infer from an
externally built frontend image during this pilot.
