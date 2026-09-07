// Estimates are an allocation model, not an official subscription ledger.
export function normalizeWindows(result, at = Date.now()) {
  const legacy = result?.rateLimits
    ? { [result.rateLimits.limitId || "codex"]: result.rateLimits }
    : {};
  const buckets = { ...legacy };
  for (const [id, bucket] of Object.entries(
    result?.rateLimitsByLimitId || {},
  )) {
    if (bucket && typeof bucket === "object")
      buckets[id] = { ...legacy[id], ...bucket };
  }
  const windows = Object.entries(buckets).flatMap(([bucket, b]) =>
    ["primary", "secondary"].flatMap((slot) => {
      const w = b?.[slot];
      if (
        !w ||
        typeof w.usedPercent !== "number" ||
        !Number.isFinite(w.usedPercent)
      )
        return [];
      return [
        {
          id: `${bucket}:${slot}`,
          bucket,
          label: `${b.limitName || bucket} · ${w.windowDurationMins === 10080 ? "周额度" : `${w.windowDurationMins ?? "?"} 分钟窗口`}`,
          usedPercent: w.usedPercent,
          remainingPercent: Math.max(0, 100 - w.usedPercent),
          resetsAt:
            typeof w.resetsAt === "number" &&
            Number.isFinite(w.resetsAt) &&
            w.resetsAt > 0 &&
            w.resetsAt < 100_000_000_000
              ? w.resetsAt * 1000
              : null,
          planType: typeof b.planType === "string" ? b.planType : null,
          source: "account/rateLimits/read",
          windowMinutes: w.windowDurationMins,
          observedAt: at,
        },
      ];
    }),
  );
  // The legacy view can include a weekly window omitted from a partial multi-bucket view.
  if (result?.rateLimitsByLimitId && result?.rateLimits) {
    for (const old of normalizeWindows({ rateLimits: result.rateLimits }, at)) {
      if (
        !windows.some(
          (w) =>
            w.bucket === old.bucket && w.windowMinutes === old.windowMinutes,
        )
      ) {
        windows.push({ ...old, id: old.id.replace(":", ":legacy-") });
      }
    }
  }
  return windows;
}
export function mainWindow(windows) {
  return (
    windows.find(
      (w) =>
        w.bucket === "codex" &&
        w.windowMinutes >= 9000 &&
        w.windowMinutes <= 11000,
    ) ??
    windows.find((w) => w.bucket === "codex") ??
    null
  );
}
export function accountDisplay(result, sampledAt = Date.now()) {
  const windows = normalizeWindows(result, sampledAt);
  const selected = mainWindow(windows);
  const planType = selected?.planType ?? result?.rateLimits?.planType ?? null;
  return {
    windows,
    summary: selected
      ? {
          usedPercent: selected.usedPercent,
          remainingPercent: selected.remainingPercent,
          windowLabel: selected.label,
          windowMinutes: selected.windowMinutes,
          resetsAt: selected.resetsAt,
          observedAt: sampledAt,
          source: "account/rateLimits/read",
        }
      : null,
    plan: {
      type: planType,
      multiplier: null,
      source: "account/rateLimits/read",
      detail:
        planType === "pro"
          ? "官方接口标明 Pro，未区分 5x/20x；账户百分比及重置时间已针对当前订阅计算，无需手动选择套餐。"
          : "使用当前登录账户的官方额度窗口；不根据本机模型配置推断套餐。",
    },
    error: null,
    lastFetchedAt: sampledAt,
  };
}
export function groupThreads(threads) {
  const byId = new Map(threads.map((t) => [t.id, t]));
  const groups = new Map();
  for (const t of threads) {
    let root = t;
    const seen = new Set([t.id]);
    while (
      root.parentThreadId &&
      byId.has(root.parentThreadId) &&
      !seen.has(root.parentThreadId)
    ) {
      root = byId.get(root.parentThreadId);
      seen.add(root.id);
    }
    if (!groups.has(root.id))
      groups.set(root.id, { ...root, members: [], childCount: 0 });
    groups.get(root.id).members.push(t);
  }
  return [...groups.values()].map((g) => ({
    ...g,
    childCount: g.members.length - 1,
    status: g.members.some((t) => t.status === "active")
      ? "active"
      : g.members.some((t) => t.status === "unknown")
        ? "unknown"
        : "idle",
  }));
}
export class Estimator {
  constructor(saved = {}) {
    this.state = {
      since: Date.now(),
      totals: {},
      pending: {},
      lastTokens: {},
      activity: {},
      history: [],
      observedPercent: 0,
      unattributedPercent: 0,
      calibratedTokens: 0,
      calibratedPercent: 0,
      ...saved,
    };
    this.lastAt = null;
  }
  local(threads, now) {
    const s = this.state;
    for (const t of threads) {
      if (/spark/.test(t.model || "")) continue; // Spark has a separate quota bucket.
      const previous = s.lastTokens[t.id];
      const delta = previous == null ? 0 : Math.max(0, t.tokens - previous);
      s.lastTokens[t.id] = t.tokens;
      s.pending[t.id] = (s.pending[t.id] || 0) + delta;
      const points = (s.activity[t.id] ||= []);
      points.push({ at: now, delta });
      s.activity[t.id] = points.filter((p) => p.at >= now - 120000).slice(-240);
    }
    this.lastAt = now;
  }
  quota(w, now, accountKey) {
    if (!w) return;
    const s = this.state,
      identity = `${accountKey || "unknown"}:${w.id}:${w.resetsAt}`;
    if (
      !s.previous ||
      s.previous.identity !== identity ||
      w.usedPercent < s.previous.used
    ) {
      Object.assign(s, {
        since: now,
        totals: {},
        pending: {},
        observedPercent: 0,
        unattributedPercent: 0,
        calibratedTokens: 0,
        calibratedPercent: 0,
        history: [],
        activity: {},
      });
    } else {
      const delta = Math.max(0, w.usedPercent - s.previous.used);
      if (delta > 0) {
        const sum = Object.values(s.pending).reduce((a, b) => a + b, 0);
        s.observedPercent += delta;
        if (sum > 0 && !s.gap) {
          for (const [id, count] of Object.entries(s.pending))
            s.totals[id] = (s.totals[id] || 0) + (delta * count) / sum;
          s.calibratedTokens += sum;
          s.calibratedPercent += delta;
        } else s.unattributedPercent += delta;
        s.pending = {};
      }
    }
    if (s.gap) {
      s.pending = {};
      s.gap = false;
    }
    s.previous = { identity, used: w.usedPercent, at: now };
    s.history.push({ at: now, remainingPercent: w.remainingPercent });
    s.history = s.history.slice(-2880);
  }
  sessions(threads, now) {
    const s = this.state;
    return groupThreads(threads)
      .map((g) => {
        const known = g.members.some((t) => Object.hasOwn(s.totals, t.id));
        const estimate = known
          ? g.members.reduce((v, t) => v + (s.totals[t.id] || 0), 0)
          : null;
        let tokenRate = 0;
        for (const t of g.members) {
          const pts = s.activity[t.id] || [],
            elapsed = pts.length ? (now - pts[0].at) / 1000 : 0;
          if (elapsed >= 20)
            tokenRate +=
              pts
                .filter((p) => p.at > pts[0].at)
                .reduce((a, p) => a + p.delta, 0) / elapsed;
        }
        const percentRate =
          s.calibratedTokens > 0
            ? (tokenRate * s.calibratedPercent) / s.calibratedTokens
            : 0;
        const starts = g.members
          .filter((t) => t.status === "active" && t.startedAt)
          .map((t) => t.startedAt);
        const started = starts.length
          ? Math.min(...starts)
          : g.startedAt || null;
        return {
          id: g.id,
          title: g.title || g.id,
          model: g.model,
          reasoningEffort: g.reasoningEffort,
          status: g.status,
          childCount: g.childCount,
          elapsedSeconds: started
            ? Math.max(
                0,
                ((g.status === "active"
                  ? now
                  : g.completedAt || g.updatedAt || now) -
                  started) /
                  1000,
              )
            : 0,
          estimatedPercent: /spark/.test(g.model || "") ? null : estimate,
          secondsPerPercent:
            g.status === "active" && percentRate > 0 ? 1 / percentRate : null,
          confidence: "低：本机归因假设",
          method:
            "按监控期间本机 token 增量分摊账户变化；不同模型权重未知，可能混入其他设备消耗",
          activityEvidence: g.activityEvidence,
        };
      })
      .sort(
        (a, b) =>
          ({ active: 0, unknown: 1, idle: 2 })[a.status] -
          { active: 0, unknown: 1, idle: 2 }[b.status],
      );
  }
}
