---
name: query-session-quota
description: Open the local Codex quota monitor or explain its session quota estimates, refresh costs, burn rate, and reset countdown.
---

Use `open_quota_monitor` to get the local dashboard URL. Open that exact URL in a Codex browser side panel with `open_in_codex` when available; otherwise present the local link. Opening does not wait for upstream quota queries. For a one-off answer, `get_quota_snapshot` reads the cached snapshot. Use `diagnose_quota_monitor` for startup or stale-data errors.

Keep these distinctions visible:
- Account windows come from `account/rateLimits/read`; show their sample time and error state.
- Session percentages use a low-confidence allocation of the account change by local token increments. Different model weights and usage on other devices are unknown. Display three decimal places without implying three-decimal accuracy.
- Totals cover the observation period shown by `attribution.since`, not the entire lifetime of the task. Include unattributed usage when nonzero.
- No calibration or recent progress means the rate is unavailable, not zero. Format a known rate as “每下降 1% 耗时 xxx.xxx 秒”.
- Local dashboard refreshes make no model calls; the conversation used to open or explain the monitor still consumes normal model usage.
- Only describe native inline status and native window callbacks as supported if the capability flags say so. This version uses a separate dashboard.
- Model automation requires the user's explicit dashboard choice and affects future defaults. It does not switch an active turn or submit a prompt.

Never resolve monitor failures by patching the Codex application, editing its conversation databases, resuming existing threads in the collector, or sending empty turns. Keep monitoring separate from user work.
