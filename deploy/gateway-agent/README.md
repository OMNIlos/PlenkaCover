# Plenka gateway agent package

This package is built for the Ubuntu x86_64 industrial post. It never contains a post token or
device identity. Installation creates a disabled service account and persistent state directory;
the service is not enabled or started until a root operator installs the physical configuration.
The pinned Node.js 22 runtime is bundled in the package, so stock Ubuntu 24.04 does not need an
external Node repository or a system-wide Node upgrade.

Release builds require a clean, non-shallow Git checkout. The Debian version starts with the
full-history revision count, so every descendant release sorts after its ancestor even when Git
commit timestamps are equal or decrease. Do not build an upgrade from a divergent history.

Verify the adjacent checksum from the directory containing both files, then install:

```bash
sha256sum -c plenka-gateway-agent_*.deb.sha256
sudo apt install ./plenka-gateway-agent_*.deb
```

After copying the example to `/etc/plenka-gateway/agent.env`, replace every placeholder, set
`root:plenka-gateway 0640`, run `sudo plenka-gateway-probe`, and only then enable the service:

```bash
sudo systemctl enable --now plenka-gateway.service
sudo systemctl status plenka-gateway.service --no-pager
sudo journalctl -u plenka-gateway.service --since '10 minutes ago' --no-pager
```

The unit uses `Restart=always`, so an unexpected clean exit is recovered as well as a crash.
`systemctl stop plenka-gateway.service` remains an intentional maintenance stop and is not
auto-started until the operator starts it again.

The probe can report physical PASS only for the authoritative Massa-K Protocol 100 path. A
simulator, generic serial adapter, TCP connect by itself, or an expected QR copied into the UI is
not physical evidence.

For a USB-connected MERTECH TLP4, install the official HT600 203 DPI CUPS driver and create stable
queues. Every physical `cups-zpl` configuration must set both destinations explicitly:
`PRINTER_CUPS_QUEUE=TLP4` for roll and operator defect-bag labels, and
`PRINTER_WAREHOUSE_CUPS_QUEUE=TLP4_WH` for warehouse Big-Bag and 100 x 150 mm pallet labels.
Physical mode rejects equal queue names: warehouse media must never
be submitted to the operator's roll-label queue. Before each warehouse submission the agent checks
that the dedicated queue is enabled and accepting jobs. Missing, empty, equal, or unavailable
warehouse destinations fail safely instead of silently sending a pallet sheet to the roll printer.
The agent submits raw ZPL through `/usr/bin/lp`; CUPS acceptance remains `physical_pending` until a
person confirms the setup label physically exited the correct printer.

Normal package removal preserves `/etc/plenka-gateway` and `/var/lib/plenka-gateway` so a token or
durable outbox is never destroyed implicitly. After evidence review, an administrator may delete
those paths manually only while the service is disabled; package upgrades always preserve them.

## Release compatibility manifest

An installable release is a set, not an isolated `.deb`. Before the package reaches a post,
generate and verify `physical-device-manifest.json` with:

- the exact backend and frontend commits and image digests;
- the gateway source commit, Debian version and package SHA-256;
- the backend protocol version and required capabilities;
- the capabilities compiled into gateway `BUILD-INFO`.

`scripts/gateway/build-deb.sh` now reads protocol and capabilities from the compiled
`@plenka/contracts`; it does not maintain a second handwritten list. The release verifier rejects
an old protocol, a missing/unknown capability, a mismatched package checksum, `latest`, malformed
commit/digest values and an attempt to overwrite an existing manifest.

Example from the backend repository after the three immutable artifacts are built:

```bash
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

All variables above are mandatory release metadata, not default values. Keep the manifest,
package, adjacent checksum and previous installable package together. Do not install when the
manifest verifier fails.

## Controlled upgrade and rollback

Before an upgrade, record the current package version and retain the exact previous `.deb` with a
verified checksum. Stop the service before `apt install`; the package lifecycle only restarts an
agent that was active when upgrade began, so the explicit stop prevents an unverified candidate
from starting. Installation must not replace
`/etc/plenka-gateway/agent.env` or `/var/lib/plenka-gateway`.

After installation:

1. run the bundled config check with the existing root-owned environment;
2. start the service;
3. require a compatible heartbeat within 60 seconds;
4. verify exactly one enabled scale, printer and scanner binding;
5. run separate scale, printer and browser-HID checks.

If configuration, service start, heartbeat compatibility or topology fails, stop the candidate,
install the retained previous `.deb`, start it and confirm its heartbeat. Never repair readiness
with direct SQL. Never auto-repeat a print whose result may already be `delivery_unknown`.
