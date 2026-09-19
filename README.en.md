# Codex Quota Monitor

Codex Quota Monitor is a Codex plugin that shows how much quota remains, what each task may have used, and how long your quota might last at the current pace. Monitoring itself does not consume Codex quota. Codex conversations used to install, open or discuss the plugin, and the tasks being monitored, still consume quota normally. Account balances are official; task values and runtime predictions are estimates.

Use the **Monitoring source** selector at the top to switch between your **Codex account, Muse, and other custom APIs configured in the desktop app**. It initially selects the desktop's current provider and changes only the monitoring view. API views separately show recorded input, cached input, output, and total tokens. They do not invent monetary costs or quota percentages when trusted provider pricing and balance data are unavailable.

When a task changes providers, identifiable executions remain separate and ambiguous history appears under **Unknown historical provider**. Later continuously observed increments are assigned to the provider observed at the time and marked as partial; offline usage is not guessed. Existing statistics are backed up before migration. Unproven Codex allocations become unattributed while official account consumption stays intact. Configure custom APIs in the desktop app first; the monitor reads provider labels and usage without asking for API keys again.

[中文 README](./README.md) · [Diagnosis guide](./docs/diagnosis.md) · [Validation notes](./docs/validation.md)

## Quick start

You need a ChatGPT/Codex desktop build with local-plugin support, Node.js `>=22.13.0`, and a Codex CLI compatible with that desktop build.

To let Codex install and start the plugin, send it this prompt:

```text
Please install and start this plugin, confirm the page displays correctly, then provide a clickable URL in the chat: https://github.com/tristan-me/codex-quota-monitor
```

Then open a new local Codex conversation, type `@`, select **Codex Quota Monitor**, and ask it to open the monitor. On first opening, allow a moment for account and task data to load.

![Open the monitor from a new Codex conversation](docs/media/open-plugin.gif)

If you need a copyable mention example, use:

```markdown
[@Codex Quota Monitor](plugin://codex-quota-monitor@codex-quota-monitor) 打开 Codex 额度监控器。
```

In the composer, type `@` and select the installed plugin. Pasting the Markdown by itself may leave it as ordinary text.

Account and task values in these screenshots are synthetic examples. Reset announcements and forecasts are public references captured at screenshot time, not current forecasts.

![Overview — synthetic demo data](docs/images/overview.jpg)

| Sessions and child tasks | Model and effort comparison |
| --- | --- |
| [![Sessions — synthetic demo data](docs/images/sessions.jpg)](docs/images/sessions.jpg) | [![Models — synthetic demo data](docs/images/models.jpg)](docs/images/models.jpg) |

![Public reset announcements and forecast evidence](docs/images/resets.jpg)

## What it shows

| View | What you can check |
| --- | --- |
| Account | Official remaining and used percentages, a reset countdown showing seconds and the latest sample time, and an estimate of when quota might run out based on observed usage over the last 24 hours. |
| Tasks | Total estimated consumption and mean time per 1% of quota; colored charts show each execution's start, end, recorded duration, and consumption. |
| Child tasks | Expand child rows and see their contribution to the parent task. |
| Search | Find tasks by title keywords or full IDs, including multiple search terms. Browse five tasks per page, show more, or expand child tasks. Filters and expanded rows stay as you left them during refreshes. |
| Allocation summary | Switch between retained history and the current quota period to compare task-attributed and unattributed usage. Historical coverage follows the account statistics window. |
| Quota trend | Defaults to 0–100% remaining quota per period, rising at resets; switch to cumulative consumption across periods. Hover for time and quota, or select a sample and expand its task shares. |
| Theoretical usage check | Input, cached input, output, and credits at official prices, plus a comparison of predicted and actual quota changes using earlier samples for calibration. |
| Models | Colors and labels distinguish own-turn means with an identified execution model and effort, recent local estimates, and missing samples. External costs remain reference information. |

Task estimates prefer each execution's recorded model, cached input, and output usage, weighted with [published Codex rates](https://learn.chatgpt.com/docs/pricing#token-rates) and calibrated against the current account's quota changes. Historical totals can include multiple models. Reconstructed records replace older equal-token estimates; remaining legacy records are labeled. Published credit weights are not subscription percentages and cannot fully resolve other-device usage, workload differences, or historical pricing changes.

The theoretical usage check separately shows complete executions inside the monitoring window and matched account samples. The earlier half of the samples calibrates the quota conversion; the later half independently tests it. Insufficient samples show a waiting state, without fitting and validating against the same deductions. Both scopes are labeled: complete-execution credits cannot be subtracted directly from total account percentages.

Codex task totals cover all locally readable and previously recorded sessions, independently of the account statistics window. Mean time per 1% divides known total duration by known estimated quota; differing coverage makes it only a rough reference. Parent and child quota is added, while parallel elapsed time is counted once. Parent charts include discovered child executions, and child rows can be expanded individually. API tasks count tokens independently, without adding child usage into the parent again. Unrecorded or unreadable history cannot be filled in.

Parents always stay above their descendants. Default ordering follows the most recent activity in each task group, including child activity, newest first. Total usage and mean consumption speed support ascending or descending order. Drag a handle to reorder siblings; moving a parent carries its descendants with it. Ordering is saved per provider in the current browser.

Codex task rows show total consumption and mean time per 1% of quota. Charts start collapsed as small previews on the right; expand or collapse each independently, with that choice retained after refresh. The horizontal axis tracks cumulative task running time, removing idle gaps between executions and counting concurrent execution spans once. Executions use different colors. Endpoint labels retain the original earliest start and latest end; hover or keyboard-focus for exact wall-clock times, recorded duration, consumption, and mean rate. When only execution boundaries and totals are known, intermediate progress is explicitly estimated.

API charts show one execution per turn, with known tokens and whole-turn duration, without quota percentages or time per 1%. Duration follows the original lifecycle, including tool waits and periods with no token increase. A turn spanning providers can appear in each applicable view with that provider's known tokens and the same whole-turn duration; this is not provider-exclusive runtime. If lifecycle timings are missing, only recorded observation duration is shown and marked partial.

Task estimates depend on the model, other-device usage, and record completeness, so they are not official task bills. Waiting, unrecorded, or “—” values indicate missing reliable data. Chart progress is not a per-second measurement, and account runtime estimates do not guarantee future usage.

The account statistics window is 24 hours by default and can be set from 1 to 168 hours; it controls account trends, attribution, and current rate calibration. Known task totals are retained independently. A single refresh interval updates local tasks, account quota, and the page every 5 seconds by default, adjustable from 5 to 3600 seconds, and you can pause background reads while keeping access to existing records. Changing the account window does not delete Codex conversations; increasing it cannot restore previously removed samples. Amounts use two decimals by default, four below 0.01%, six below 0.0001%, and progressively more for smaller values; extremely small values use scientific notation so positive usage never appears as zero.

Trend-point task shares include unattributed usage and are sorted largest first. A sample may combine more than 1% of account consumption; the details show its actual observed amount rather than inventing separate exact 1% bills.

Some completed short tasks can have missing usage estimated when enough records are available. These recovered estimates are labeled and retained across restarts and later sessions, updated when more complete usage records become available. The attribution panel starts from usable records when older history is incomplete and displays the effective start time. It counts observed account changes; recovered values remain task-level estimates. Not every missing historical value can be recovered.

Historical attribution accumulates retained observations across quota periods; current-period attribution includes only retained observations from the current period. An unknown period start, late monitoring start, or removed older samples can leave that period partly covered, so these values are not a complete bill for the period.

Use the right-edge navigation to jump between sections.

The panel includes a reminder with a “Do not remind me again” checkbox, a confirmation control, and a restore control. You can choose **Economy**, **Balanced**, or **Quality** as the default-model preference. Automatic default changes must be explicitly enabled and affect new tasks only. They can be turned off, and the original defaults restored. If you have changed those defaults elsewhere, the restore action reports the conflict.

Model comparisons use local executions whose actual model and reasoning effort can be identified, preferring matched own-turn means with recent rates as a fallback. Without a local sample for that effort, external costs remain reference information and quota speed stays blank; another effort's cost ratio is never used to invent a quota rate. Workload, caching, output volume, and tool waits mean hourly usage need not rise with reasoning effort.

Depletion estimates use observed account consumption over the last 24 hours across resets, with effective coverage shown when less than a day is available. Personal reset timing follows the account window shown by Codex, with a seconds countdown and the latest sample time. The reset panel separates “Local resets” (the current account countdown and depletion estimate) from “Official notices” (the two latest global completion announcements). Third-party predictions are available separately under a clearly labeled unofficial-reference disclosure. Global announcements and third-party forecasts do not guarantee when your account will receive a reset.

The monitor opens as an independent local panel; its statistics are not inserted into the chat text.

<details>
<summary>Optional manual installation and controls</summary>

Alternatively, run these commands in a compatible Codex CLI with GitHub access:

```bash
codex plugin marketplace add https://github.com/tristan-me/codex-quota-monitor
codex plugin add codex-quota-monitor@codex-quota-monitor
```

You can confirm that **Codex Quota Monitor** is enabled in the desktop app’s plugin settings.

![Install and launch the plugin](docs/media/install-and-launch.gif)

![Installed plugin details](docs/images/plugin-details.jpg)

After downloading or cloning the repository, double-click `Open-Monitor.command` on macOS, or run `node plugins/codex-quota-monitor/server/launcher.mjs` from the repository directory. If you stop it manually, the optional stop command is:

```bash
node plugins/codex-quota-monitor/scripts/stop.mjs
```

</details>

## Local URL and privacy

The complete bookmark URL contains a private access token. It works only on the same computer while the monitor service is running, so do not share the full URL in an issue, chat, or screenshot.

Closing the web page does not stop the service; the bookmark can be reopened while it is running. After a service stop or reboot, the old bookmark cannot start anything. Run `Open-Monitor.command` again, or open the plugin from a new local conversation to receive a current URL.

![Save the current valid URL with its complete token](docs/images/bookmark.jpg)

The plugin extracts only task names, models, times, status and usage information needed for monitoring. Statistics stay on this computer; prompts and answers are not stored or uploaded, and credential files are not read. Requests for public model and reset references do not include local task data. Remove private local URLs, account values, task names and IDs, working paths, and conversation text before filing an issue.

The project is MIT-licensed. Rights to third-party reference data and public endpoint responses remain with their sources; see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). For host, CLI, or local-panel failures, use the [diagnosis guide](./docs/diagnosis.md); the [validation notes](./docs/validation.md) describe the supported checks.

If opening shows an error or only a connection strip, see the [startup and page checks](docs/diagnosis.md#启动与页面检查). Closing the page does not stop its background service; after moving or updating the plugin, stop the old monitor if necessary and reopen from the current installation.
