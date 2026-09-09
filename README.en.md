# Codex Quota Monitor

Codex Quota Monitor is a Codex plugin that shows how much quota remains, what each task may have used, and how long your quota might last at the current pace. Monitoring itself does not consume Codex quota. Codex conversations used to install, open or discuss the plugin, and the tasks being monitored, still consume quota normally. Account balances are official; task values and runtime predictions are estimates.

[中文 README](./README.md) · [Diagnosis guide](./docs/diagnosis.md) · [Validation notes](./docs/validation.md)

## Quick start

You need a ChatGPT/Codex desktop build with local-plugin support, Node.js `>=22.13.0`, and a Codex CLI compatible with that desktop build.

To let Codex install and start the plugin, send it this prompt:

```text
Please install and start this plugin, then provide a clickable URL in the chat when it is ready: https://github.com/tristan-me/codex-quota-monitor
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
| Account | Official remaining and used percentages, the account reset countdown, and an estimate of when quota might run out at the current pace. |
| Tasks | Total and latest-session time, estimated quota use, and average or predicted time per 1% of quota. |
| Child tasks | Expand child rows and see their contribution to the parent task. |
| Search | Find tasks by title keywords or full IDs, including multiple search terms. Browse five tasks per page, show more, or expand child tasks. Filters and expanded rows stay as you left them during refreshes. |
| Allocation summary | How much observed account usage can be attributed to local tasks, and how much remains unattributed. |
| Trend | A sliding-window trend that retains valid samples across quota resets, labels its start and latest values, and connects missing or damaged intervals with dimmer straight lines between known samples. |
| Models | Compare model and effort rows with local observations clearly separated from dated external reference data. External comparisons provide context; they are not subscription prices. |

Task totals cover every session in the selected window. The latest-session line includes that session and child work launched within it; a reused child contributes only the matching execution. Parent and child quota is added, while parallel elapsed time is counted once. Running tasks appear first, ordered by their latest session start, newest first. Idle tasks follow, ordered by their last completion, newest first. Elapsed totals are labeled with the selected window; once continuous work fills that window, new time replaces old time leaving the window, so the total can stay constant.

Running predictions prefer the most recent five seconds when enough samples are available. Otherwise they use the current session average if available, or show `—`. Completed tasks retain an available session prediction. Missing reliable samples are shown as `—`; predictions do not guarantee future usage.

The statistics window is 24 hours by default and can be set from 1 to 168 hours. The UI refreshes every 5 seconds and account data every 30 seconds by default; both intervals are adjustable, and you can pause background reads while keeping access to existing records. Changing the statistics window does not delete Codex conversations; increasing it cannot restore usage samples already removed. Very small positive estimates keep a few extra readable decimal places instead of appearing as zero.

Some completed short tasks can have missing usage estimated when enough records are available. These recovered estimates are labeled and retained across restarts and later sessions, updated when more complete usage records become available, and removed when they leave the statistics window. The attribution panel starts from usable records when older history is incomplete and displays the effective start time. It counts observed account changes; recovered values remain task-level estimates. Not every missing historical value can be recovered.

Use the right-edge navigation to jump between sections.

The panel includes a reminder with a “Do not remind me again” checkbox, a confirmation control, and a restore control. You can choose **Economy**, **Balanced**, or **Quality** as the default-model preference. Automatic default changes must be explicitly enabled and affect new tasks only. They can be turned off, and the original defaults restored. If you have changed those defaults elsewhere, the restore action reports the conflict.

Personal reset timing follows the account window shown by Codex. The two latest official global completion announcements are shown separately, while a clearly labeled third-party forecast is only reference evidence. Global announcements and third-party forecasts do not guarantee when your account will receive a reset.

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
