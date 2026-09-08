# Codex Quota Monitor

Codex Quota Monitor is a local v0.2.0 beta plugin for observing Codex account windows, discovering local sessions, and presenting transparent estimates of per-session subscription usage. It does not present an estimate as an official itemized bill.

[中文 README](./README.md) · [Diagnosis guide](./docs/diagnosis.md)

## What this beta does

- Reads local SQLite metadata in read-only mode to discover sessions through both the new paginated path and the legacy path. It does not write to the Codex database.
- Refreshes the local cache every 5 seconds by default and polls account quota every 30 seconds by default. Both intervals are configurable in the panel.
- Shows official account remaining/used percentages and reset time without requiring a manually selected plan multiplier. When the service only returns Pro, the monitor does not guess 5x versus 20x.
- Tracks samples after monitoring starts and displays consumption, observed speed, reset countdowns, and a linear exhaustion estimate based on the observed trend.
- Probes `threadUsage` availability. This release allocates account-window changes by local token deltas; credit-based calibration remains future work. The tested account returns `threadUsage=null`.
- Shows this notice every time the panel opens, with a “Do not remind me again” checkbox and a confirmation control:

  > Important: per-session percentages and speeds are transparent estimates, not official exact itemization or a guarantee about future usage.

Three decimal places are a display format only. They do not imply that the underlying data or an official account breakdown has three-decimal accuracy. Insufficient samples remain marked as warming up instead of being shown as a fabricated zero rate.

## Cost and accuracy boundaries

The UI reads the local cache every 5 seconds by default, about 720 local reads per hour. While the service is running, account quota is polled every 30 seconds by default, about 120 reads per hour. Model-list and thread-usage capability probes run at most hourly after success, with one-minute minimum retry after failure. Counters measure RPC calls; authentication and retries may cause additional HTTP requests. Refreshing the panel makes zero model calls, but local HTTP, SQLite, CPU, and network metadata reads still have a cost. The underlying Codex session that uses the tool continues to consume tokens and subscription quota normally.

Account windows are account-level data. Per-session numbers are estimates covering samples after monitoring started, not lifetime session history. When `threadUsage=null`, the monitor can only allocate account changes by local token-delta proportions. The true weights of different models are unknown, and activity from other devices, background work, or undiscovered threads can contaminate the account window, so this mode is low confidence. If the account window changes without a matching local token delta, the difference remains in `unattributed` instead of being forced onto a session.

Reset timing follows the account window's reported countdown. Exhaustion timing is a linear estimate from the latest observed speed. Surprise grants, manual changes, and other unknown reset events cannot be predicted and are not presented as certain.

## Boundary with the native Codex UI

There is currently no official mount point that guarantees a custom popup every time the native Codex window opens, and no official interface for embedding “processed for xx minutes, live rate, and consumed quota” into native Codex text. Therefore v0.2.0 beta uses an independent/compact panel for the notice and metrics; it does not claim to have completed those native UI requirements.

Mode switching is opt-in in the UI. When enabled, it writes only the default `model` and `model_reasoning_effort` for the next new task. It does not take over a running task and does not claim to be globally optimal or the official best value choice. Codex Radar and Codex Reset are reference entry points only: <https://codexradar.com/#model-ratings> and <https://codex-reset.com/zh/>.

The plugin does not intercept composer input or submit turns on the user's behalf, and it does not promise to fix `failed to submit turn input: EmptyInput`. Use the [diagnosis guide](./docs/diagnosis.md) to separate host Codex, CLI/App Server, and local-panel failures.

## Install and run locally

Requirements: Node.js `>=22.13.0`. The runtime has zero npm dependencies. `node:sqlite` is still experimental on Node 22.13, and is supported by this project.

From the repository root, start the independent panel:

```bash
node plugins/codex-quota-monitor/server/launcher.mjs
```

In a second terminal, add the local marketplace to Codex and install the plugin:

```bash
codex plugin marketplace add "$PWD"
codex plugin add codex-quota-monitor@codex-quota-monitor
```

Prefer the Codex CLI that is compatible with the desktop build. If PATH resolves to an older CLI, its App Server capabilities may not match the desktop configuration. Check `codex --version` before treating a compatibility error as a quota-data error.

After startup, open Codex Quota Monitor in Codex. The panel uses a local `127.0.0.1` HTTP service with a random access token; it is not a public website. Do not post a token-bearing local URL in an issue, chat, or screenshot.

## Privacy

The plugin does not collect credentials, prompts, answers, or telemetry, and does not upload data to a third-party service. It reads local Codex metadata and local SQLite and stores derived state locally. Remove access tokens, account quota values, private session IDs, working directories, and conversation text before filing an issue.

## Development and validation

The project intentionally has zero npm dependencies. CI covers Node 22.13 and Node 24:

```bash
cd plugins/codex-quota-monitor
node --test tests/*.test.mjs
```

If the local Node 22.13 build requires the experimental SQLite flag, run:

```bash
node --experimental-sqlite --test tests/*.test.mjs
```



The monitor does not read authentication files. The legacy adapter reads a bounded JSONL tail and extracts only lifecycle and token metadata; it does not retain or upload conversation text. Titles can originate from the first prompt line and remain private local data.

Stop the background service with `node plugins/codex-quota-monitor/scripts/stop.mjs`. Turning off automation stops future changes; the restore button restores the original defaults only if no external edit conflicts.

Live and demo state, credentials, and endpoints are isolated. Demo pages are explicitly marked as synthetic. Offline pages withdraw live values and explain how to reopen the launcher. Clean restarts reuse the saved loopback endpoint; an occupied port is reported without terminating another application.

## Session browsing and model overview

The right-edge table of contents expands on hover or keyboard focus. Sessions support title keywords, exact IDs, five-row pagination, incremental expansion, and child-thread details. Search and expansion survive refreshes. Known session allocations survive quota resets; missing historical observations are not invented. Completed tasks use measured average rates when timing evidence exists.

Model overview uses a dated Codex Radar DeepSWE reference snapshot together with local observations. API-equivalent benchmark cost is not subscription quota billing. Spark's separate quota pool is not extrapolated from the main Codex pool.
