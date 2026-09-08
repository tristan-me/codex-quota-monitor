---
name: query-session-quota
description: Open the local Codex quota monitor or explain its session quota estimates, refresh costs, burn rate, and reset countdown.
---

Use `open_quota_monitor` to get the local dashboard URL. Read the exact `url` returned by the tool; when `open_in_codex` is available, open that exact URL in a Codex browser side panel. Whether or not the side panel opens, the final reply must include the same exact URL as a clickable Markdown link, for example `[打开 Codex 额度监控器](<EXACT_URL>)`. Do not reconstruct, shorten, redact, or replace the port/token-bearing URL with a generic localhost link. Opening does not wait for upstream quota queries. For a one-off answer, `get_quota_snapshot` reads the cached snapshot. Use `diagnose_quota_monitor` for startup or stale-data errors.

The saved loopback endpoint keeps its port/token on the same machine, so a bookmark works while that monitor service is running. A bookmark cannot start a stopped service and cannot automatically open the ChatGPT desktop app; tell the user to run/open the monitor tool again when the service is stopped. A Codex side-panel open is not proof that the native desktop window was opened.

Keep these distinctions visible:
- Account windows come from `account/rateLimits/read`; show their sample time and error state.
- Session percentages use a low-confidence allocation of the account change by local token increments. Different model weights and usage on other devices are unknown. Display three decimal places without implying three-decimal accuracy.
- Quota totals cover monitored samples, not the entire lifetime of the task; window attribution uses `attribution.since` while task totals can retain earlier observed windows. Include unattributed usage when nonzero. Execution durations use retained local lifecycle records and can cover a longer period than quota observations.
- Task rows distinguish `totalElapsedSeconds` / `totalEstimatedPercent` / `averageSecondsPerPercent` from `latestTurnElapsedSeconds` / `latestTurnEstimatedPercent` / `latestTurnSecondsPerPercent`. The latest turn is the task's own latest execution; child tasks have their own latest turns. Never substitute cumulative quota for a missing latest-turn estimate. Missing evidence remains `—`.
- No calibration or recent progress means the rate is unavailable, not zero. For an unfinished task, format a known rate as “每下降 1% 预计耗时 11分57秒”; for an idle/completed task, use “每下降 1% 平均耗时 11分57秒” with its measured average.
- Format processing and rate durations with integer hours, minutes, and seconds, for example “1时2分3秒”, “11分57秒”, or “48秒”; omit unused leading units and do not imply sub-second precision.
- Local dashboard refreshes make no model calls; the conversation used to open or explain the monitor still consumes normal model usage.
- Only describe native inline status and native window callbacks as supported if the capability flags say so. This version uses a separate dashboard.
- Model automation requires the user's explicit dashboard choice and affects future defaults. It does not switch an active turn or submit a prompt.

Never resolve monitor failures by patching the Codex application, editing its conversation databases, resuming existing threads in the collector, or sending empty turns. Keep monitoring separate from user work.
