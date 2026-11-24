# Octobooth diner canvas

The diner has exactly five dishes, with a shared catalog for attendee and staff-led paths: Copilot Fusion Fusilli, Microsoft Copilot SDK Fried Chicken, Agentic Alphabet Soup, Autofix Artichoke Dip, and GitHub Delivery Club Sandwich. Staff variations stay inside those dishes. Agentic Workflows and coding agent are separate mechanisms in Soup; stacked PRs are an optional Sandwich variation.

## Open

Use the Copilot app with this repository trusted and project extensions enabled. Ask it to reload extensions and open the **Octobooth diner** canvas (`octobooth-diner`) with a stable `station` such as `booth-1`. The default `preview` station opens the real menu without creating any environments. Opening the canvas never enables provisioning.

The worker requires Node.js 22.13 or newer with `node:sqlite`. Use a supported Node LTS release; the SDK itself is supplied by the app. No npm installation is required. The original [Chez Mona launcher](../../../launcher/) remains independent; machine setup, installed default launchers, QR printing, receipt printing, and fridge endpoints are not changed by this extension.

## Event and station configuration

Staff use the native `configure_event` action. Supply the actual event end, account, owner, existing provisioner checkout, per-recipe reserve counts, resource budget, readiness deadline, and QR choice. Configuration is persisted and leaves provisioning paused. The separate `set_kitchen_enabled` action starts actual creation and must only be used after approval for those resources and costs. Pausing prevents new jobs; it does not cancel a running adapter.

```json
{
  "event": "example-event",
  "station": "booth-1",
  "eventEnd": "2026-12-01T18:00:00Z",
  "account": "YOUR-BOOTH-ACCOUNT",
  "owner": "YOUR-APPROVED-OWNER",
  "provisionerPath": "/absolute/path/to/repo-setup-scripts",
  "qrEnabled": false,
  "allowCodespaces": false,
  "reserve": {"sdk": 1},
  "maxResources": 4,
  "readinessMinutes": 30
}
```

These are illustrative values, not event policy or approved capacity. `reserve` supports `fusion`, `fusion-blank`, `sdk`, `soup`, `dip`, `dip-agent`, `delivery`, and `delivery-stack`; omitted recipes have no reserve. `dip` consumes two repositories per environment; other recipes consume one repository or local SDK folder. The hard budget counts reserved, assigned, quarantined, and retired resources until deletion. Configure enough headroom for replenishment and retained attendee work. A reserve of one cannot guarantee availability through a burst or a long preparation. Size the reserve from measured arrival rates and preparation latency, and choose a budget explicitly.

Soup creates a Codespace in addition to the issue-to-PR setup. It requires `allowCodespaces: true` and the appropriate account entitlements. The inherited Agentic Workflow is an inspection-only example: its safe outputs target the shared source repository, so the diner disables that workflow in the newly generated repository and never dispatches it unchanged. A live Agentic Workflow exercise requires a separately adapted and validated workflow scoped to the guest repository. Security recipes can consume security and agent entitlements. Nothing automatically expands the budget, installs dependencies, changes accounts, or enables unavailable organization features.

## QR entry

`set_qr_experience` persists the event's `enabled` choice without disturbing running orders. When enabled, attendees can select **Scan my ticket** or select the same five dishes directly. The scanner uses Chez Mona's existing bundled [jsQR decoder](../../../launcher/static/vendor/jsQR.js) and its existing ticket contract: the QR payload is the dish ID (`fusilli`, `fried-chicken`, `soup`, `dip`, or `sandwich`). Existing tickets for the first four dishes work unchanged; a Sandwich ticket must contain `sandwich`. The original fridge's four-dish ticket menu remains unchanged.

When disabled, the scan entry is absent, any active camera stream is stopped, and direct selection never asks for camera permission. QR and direct entry call the same exclusive assignment operation. The setting does not disable receipt or ticket printing in the original launcher. No printer, camera, or fridge is required for the canvas.

## Provisioner integration

Use an existing, separately obtained checkout of [octobooth/repo-setup-scripts](https://github.com/octobooth/repo-setup-scripts). The extension verifies its `origin`, snapshots the current committed revision with `git archive`, and invokes its actual `create-repo.sh` or `create-repo.ps1` plus `config.json` and resources. Uncommitted checkout changes are not consumed. Each run records the provisioner revision; moving the checkout to another revision affects future preparations only. Git, tar, gh, and the adapter's own prerequisites must already be available on the extension's PATH.

The private per-order snapshot changes the generated name to include station and order ownership and disables local serving. Delivery basics selects the existing Booth Bingo template with `repo_only` plus Pages; the optional staff variation keeps the upstream stacked-PR workflow. The upstream checkout is never modified. The adapters run with `--no-clone`/`-NoClone` and `DEMO_NO_BROWSER=1`. The account returned by `gh api user` must equal the configured booth account; there is no silent token or account fallback.

Readiness is checked against GitHub, not the script's exit status: repository identity/default revision, expected PRs, submitted Copilot reviews at the PR head, current CodeQL and AI findings, successful Autofix generation, completed agent PRs and their checks, an available booth Codespace, the Agentic Workflow source for inspection, and a successful, responding Pages deployment as applicable. SDK preparation copies the bundled starter into a fresh private folder and hashes its contents. Assignment rechecks the recipe and compares its recorded evidence before releasing links. These integration contracts must be rehearsed against the chosen provisioner revision and real account before the event; no live provisioning is part of the isolated test suite.

The station will withhold unavailable or unsupported results rather than pretending they are usable. Examples include absent security entitlements, pending/draft agent work, or an unexpected API shape. Review `operator_status`, `operator.log`, and `worker.log`; failures never appear as an attendee dashboard, and genuine start errors tell the attendee to contact the host.

## Ownership and cleanup

State is stored outside the repository at `$COPILOT_HOME/octobooth-diner/<station>/` (or `~/.copilot/octobooth-diner/<station>/`). SQLite records ownership, lifecycle, resources, readiness evidence, and errors. A leased single worker owns each station. The worker survives canvas closure and re-opening; the active station order is rehydrated even after a worker restart. Only one order can be assigned at a station at a time. Separate physical stations must use separate station IDs and booth accounts as appropriate.

Used environments never become reserves again. **Finish this order** retires the environment permanently and schedules fresh reserves within the budget. Retired work stays retained. Interrupted creation, assignment validation, or deletion is quarantined for operator review, never blindly retried. A resource whose creation cannot be confirmed requires manual reconciliation against that exact order's log, not account-wide cleanup.

`retire_order` removes an exact recorded environment from circulation. `teardown_order` additionally requires explicit review, separate authorization, and expiry of the retention deadline (seven days after event end). It deletes only the recorded repository IDs, their booth-owned Codespaces, and that order's local folder. It never invokes the upstream `--cleanup`, an account-wide sweep, or a reset/reuse operation. Partial deletion is quarantined rather than replayed. A shorter transient-attendee retention policy requires a separate product decision.

To stop a worker after pausing and waiting for in-flight work, inspect its exact PID in the private `endpoint.json` and terminate that PID. Do not use name-based process killing. Never publish this state directory, endpoint credentials, logs, or attendee work.

## Validation

Run `node --test .github/extensions/octobooth-diner/tests/*.test.mjs`. Tests use temporary isolated state and injected fake GitHub/adapter responses; the local SDK copy test uses the real bundled starter. No test creates or deletes live GitHub resources, installs software, or provisions Codespaces.

The canvas uses the existing Mona asset and fonts. Keep their [font license](../../../launcher/static/fonts/OFL.txt) and [jsQR license](../../../launcher/static/vendor/jsQR.LICENSE) with the original assets. Source attribution: [madebygps/chez-mona-ignite-26](https://github.com/madebygps/chez-mona-ignite-26).
