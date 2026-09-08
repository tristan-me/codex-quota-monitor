---
name: query-session-quota
description: Open the local Codex quota monitor or explain its session quota estimates, refresh costs, burn rate, and reset countdown.
---

Use `open_quota_monitor` to get the local dashboard URL. Read the exact `url` returned by the tool; when `open_in_codex` is available, open that exact URL in a Codex browser side panel. Whether or not the side panel opens, the final reply must include the same exact URL as a clickable Markdown link, using `[打开 Codex 额度监控器](<EXACT_URL>)`. Use the product name directly; do not prefix normal monitor links with “真实” or “真实账户”. Do not reconstruct, shorten, redact, or replace the port/token-bearing URL with a generic localhost link. Opening does not wait for upstream quota queries. For a one-off answer, `get_quota_snapshot` reads the cached snapshot. Use `diagnose_quota_monitor` for startup or stale-data errors.

The saved loopback endpoint keeps its port/token on the same machine, so a bookmark works while that monitor service is running. A bookmark cannot start a stopped service and cannot automatically open the ChatGPT desktop app; tell the user to run/open the monitor tool again when the service is stopped. A Codex side-panel open is not proof that the native desktop window was opened.

Keep these distinctions visible:
- Account windows come from `account/rateLimits/read`; show their sample time and error state.
- Session percentages use a low-confidence allocation of the account change by local token increments. Different model weights and usage on other devices are unknown. Display two decimal places while retaining full precision for calculation; display precision does not imply official itemization accuracy.
- Task totals, execution durations, and attribution use the configured sliding statistics window (24 hours by default, adjustable from 1 to 168 hours). The attribution panel skips incomplete history and computes from the subsequent complete quota samples, displaying its effective start time; task estimates can still include retained historical observations. If no quota change has been observed yet, show a waiting state instead of a dash or a fabricated ratio. Increasing the window cannot recover observations already removed.
- Task rows distinguish `totalElapsedSeconds` / `totalEstimatedPercent` / `averageSecondsPerPercent` from `latestTurnElapsedSeconds` / `latestTurnEstimatedPercent` / `latestTurnSecondsPerPercent`. Parent task quota totals include discovered children; parent elapsed time merges concurrent intervals without counting them twice. Thus equal durations can have different quota values. The latest turn is the task's own latest execution; child tasks have their own latest turns. Never substitute cumulative quota for a missing latest-turn estimate. Missing evidence remains `—`.
- An active turn prefers the latest 5-second calibrated estimate and falls back to its elapsed time divided by its quota estimate. A completed turn retains that turn’s elapsed/quota prediction. When no positive quota denominator exists, the rate is unavailable, not zero. These are estimates rather than exact five-second official charges.
- Format processing and rate durations with integer hours, minutes, and seconds, for example “1时2分3秒”, “11分57秒”, or “48秒”; omit unused leading units and do not imply sub-second precision.
- Local dashboard refreshes make no model calls; the conversation used to open or explain the monitor still consumes normal model usage.
- Only describe native inline status and native window callbacks as supported if the capability flags say so. This version uses a separate dashboard.
- Model automation requires the user's explicit dashboard choice and affects future defaults. It does not switch an active turn or submit a prompt.

Never resolve monitor failures by patching the Codex application, editing its conversation databases, resuming existing threads in the collector, or sending empty turns. Keep monitoring separate from user work.
