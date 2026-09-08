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
function safeDuration(thread, now) {
  if (!Number.isFinite(thread.startedAt)) return null;
  const end =
    thread.status === "active" ? now : thread.completedAt || thread.updatedAt;
  return Number.isFinite(end)
    ? Math.max(0, (end - thread.startedAt) / 1000)
    : null;
}

function mergeDuration(intervals) {
  const ordered = intervals
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  let seconds = 0,
    end = -Infinity;
  for (const [a, b] of ordered) {
    seconds += Math.max(0, b - Math.max(a, end)) / 1000;
    end = Math.max(end, b);
  }
  return seconds;
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
      sessionLedger: {},
      groupObservationSeconds: {},
      sessionTrackingSince: saved.since || Date.now(),
      ...saved,
    };
    const s = this.state;
    s.sessionLedger ||= {};
    s.groupObservationSeconds ||= {};
    // Preserve allocations from the prior format. A zero allocation did not prove
    // that a historical task consumed nothing, so it is not migrated as evidence.
    for (const [id, amount] of Object.entries(s.totals || {})) {
      if (Number.isFinite(amount) && amount > 0 && !s.sessionLedger[id]) {
        s.sessionLedger[id] = {
          allocatedPercent: amount,
          timedPercent: 0,
          activeSeconds: 0,
          hasAllocation: true,
        };
      }
    }
    this.lastAt = null;
    this.previousThreads = new Map();
  }

  ledger(id) {
    return (this.state.sessionLedger[id] ||= {
      allocatedPercent: 0,
      timedPercent: 0,
      activeSeconds: 0,
      hasAllocation: false,
    });
  }

  local(threads, now, maxGapMs = 600000) {
    const s = this.state,
      previousAt = this.lastAt;
    const continuous =
      previousAt !== null && now >= previousAt && now - previousAt <= maxGapMs;
    if (previousAt !== null && !continuous) {
      s.gap = true;
      s.pending = {};
    }
    const intervals = new Map();
    for (const t of threads) {
      const old = this.previousThreads.get(t.id);
      let interval = null;
      if (continuous && old) {
        if (t.status === "active" && Number.isFinite(t.startedAt)) {
          interval = [Math.max(previousAt, t.startedAt), now];
        } else if (
          old.status === "active" &&
          t.status === "idle" &&
          Number.isFinite(t.completedAt) &&
          t.startedAt === old.startedAt
        ) {
          interval = [
            Math.max(previousAt, old.startedAt),
            Math.min(now, t.completedAt),
          ];
        }
      }
      const ledger = this.ledger(t.id);
      if (interval && interval[1] > interval[0]) {
        ledger.activeSeconds += (interval[1] - interval[0]) / 1000;
        intervals.set(t.id, interval);
      }
      const previous = s.lastTokens[t.id];
      const tokens = Number.isFinite(t.tokens) ? t.tokens : 0;
      const delta =
        previous == null || (!continuous && previousAt !== null)
          ? 0
          : Math.max(0, tokens - previous);
      s.lastTokens[t.id] = tokens;
      if (!/spark/.test(t.model || "")) {
        s.pending[t.id] = (s.pending[t.id] || 0) + delta;
        const points = (s.activity[t.id] ||= []);
        points.push({ at: now, delta });
        s.activity[t.id] = points
          .filter((p) => p.at >= now - 120000)
          .slice(-240);
      }
    }
    for (const group of groupThreads(threads)) {
      const seconds = mergeDuration(
        group.members.map((t) => intervals.get(t.id)).filter(Boolean),
      );
      s.groupObservationSeconds[group.id] =
        (s.groupObservationSeconds[group.id] || 0) + seconds;
    }
    this.previousThreads = new Map(
      threads.map((t) => [
        t.id,
        {
          status: t.status,
          startedAt: t.startedAt,
          completedAt: t.completedAt,
        },
      ]),
    );
    this.lastAt = now;
  }

  quota(w, now, accountKey) {
    if (!w) return;
    const s = this.state;
    const owner = accountKey || "unknown";
    const identity = `${owner}:${w.id}:${w.resetsAt}`;
    const unit = `${owner}:${w.bucket || w.id.split(":")[0]}:${w.windowMinutes ?? "unknown"}`;
    const priorOwner =
      s.previous?.accountKey || s.previous?.identity?.split(":")[0];
    const unitChanged =
      Boolean(s.accountUnit && s.accountUnit !== unit) ||
      Boolean(
        s.lastKnownPlanType && w.planType && s.lastKnownPlanType !== w.planType,
      );
    const ownerChanged = Boolean(priorOwner && priorOwner !== owner);
    if (unitChanged || ownerChanged) {
      s.sessionLedger = {};
      s.groupObservationSeconds = {};
      s.sessionTrackingSince = now;
    }
    const reset =
      !s.previous ||
      s.previous.identity !== identity ||
      w.usedPercent < s.previous.used;
    if (reset) {
      // A quota-window reset must not erase already observed session history.
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
        const entries = Object.entries(s.pending).filter(
          ([, count]) => Number.isFinite(count) && count > 0,
        );
        const sum = entries.reduce((total, [, count]) => total + count, 0);
        s.observedPercent += delta;
        if (sum > 0 && !s.gap) {
          for (const [id, count] of entries) {
            const allocated = (delta * count) / sum;
            s.totals[id] = (s.totals[id] || 0) + allocated;
            const ledger = this.ledger(id);
            ledger.allocatedPercent += allocated;
            ledger.hasAllocation = true;
            if (ledger.activeSeconds > 0) ledger.timedPercent += allocated;
          }
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
    s.accountUnit = unit;
    if (w.planType) s.lastKnownPlanType = w.planType;
    s.previous = { identity, accountKey: owner, used: w.usedPercent, at: now };
    s.history.push({ at: now, remainingPercent: w.remainingPercent });
    s.history = s.history.slice(-2880);
  }

  tokenRate(id, now) {
    const points = this.state.activity[id] || [];
    if (!points.length) return null;
    const elapsed = (now - points[0].at) / 1000;
    if (elapsed < 20) return null;
    const tokens = points
      .filter((p) => p.at > points[0].at)
      .reduce((sum, p) => sum + p.delta, 0);
    return tokens > 0 ? tokens / elapsed : null;
  }

  individual(thread, now) {
    const s = this.state,
      ledger = s.sessionLedger[thread.id];
    const covered = !/spark/.test(thread.model || "");
    const estimate =
      covered && ledger?.hasAllocation ? ledger.allocatedPercent : null;
    const tokenRate = this.tokenRate(thread.id, now);
    const percentRate =
      covered && s.calibratedTokens > 0 && tokenRate
        ? (tokenRate * s.calibratedPercent) / s.calibratedTokens
        : null;
    const average =
      covered && ledger?.timedPercent > 0 && ledger.activeSeconds > 0
        ? ledger.activeSeconds / ledger.timedPercent
        : null;
    return {
      id: thread.id,
      title: thread.title || thread.id,
      model: thread.model,
      reasoningEffort: thread.reasoningEffort,
      status: thread.status,
      parentThreadId: thread.parentThreadId || null,
      childCount: 0,
      elapsedSeconds: safeDuration(thread, now),
      estimatedPercent: estimate,
      secondsPerPercent:
        thread.status === "active" && percentRate > 0 ? 1 / percentRate : null,
      averageSecondsPerPercent: average,
      observationSeconds: ledger?.activeSeconds || 0,
      estimateStatus: estimate === null ? "unavailable" : "allocated",
      rateStatus:
        thread.status === "active"
          ? percentRate
            ? "recent-estimate"
            : "no-recent-sample"
          : average
            ? "observed-average"
            : "no-timed-sample",
      observationSince: s.sessionTrackingSince,
      confidence: "低：本机归因假设",
      method:
        "按监控期间本机 token 增量分摊账户变化；不同模型权重未知，可能混入其他设备消耗",
      activityEvidence: thread.activityEvidence,
    };
  }

  sessions(threads, now) {
    const s = this.state;
    return groupThreads(threads)
      .map((group) => {
        const own = this.individual(
          group.members.find((t) => t.id === group.id) || group,
          now,
        );
        const rows = group.members.map((t) => this.individual(t, now));
        const children = rows.filter((t) => t.id !== group.id);
        const known = rows.some((t) => t.estimatedPercent !== null);
        const estimated = known
          ? rows.reduce((sum, t) => sum + (t.estimatedPercent || 0), 0)
          : null;
        const rate = rows
          .filter((t) => t.status === "active" && t.secondsPerPercent > 0)
          .reduce((sum, t) => sum + 1 / t.secondsPerPercent, 0);
        const measured = s.groupObservationSeconds[group.id] || 0;
        const timedPercent = group.members.reduce(
          (sum, t) => sum + (s.sessionLedger[t.id]?.timedPercent || 0),
          0,
        );
        const starts = group.members
          .filter((t) => t.status === "active" && Number.isFinite(t.startedAt))
          .map((t) => t.startedAt);
        const elapsed = starts.length
          ? Math.max(0, (now - Math.min(...starts)) / 1000)
          : safeDuration(group, now);
        return {
          ...own,
          status: group.status,
          childCount: children.length,
          children,
          elapsedSeconds: elapsed,
          estimatedPercent: estimated,
          secondsPerPercent:
            group.status === "active" && rate > 0 ? 1 / rate : null,
          averageSecondsPerPercent:
            timedPercent > 0 && measured > 0 ? measured / timedPercent : null,
          observationSeconds: measured,
          estimateStatus: known ? "allocated" : "unavailable",
          rateStatus:
            group.status === "active"
              ? rate > 0
                ? "recent-estimate"
                : "no-recent-sample"
              : timedPercent > 0 && measured > 0
                ? "observed-average"
                : "no-timed-sample",
          ownStatus: own.status,
          ownEstimatedPercent: own.estimatedPercent,
          ownSecondsPerPercent: own.secondsPerPercent,
          ownAverageSecondsPerPercent: own.averageSecondsPerPercent,
          ownObservationSeconds: own.observationSeconds,
        };
      })
      .sort(
        (a, b) =>
          ({ active: 0, unknown: 1, idle: 2 })[a.status] -
          { active: 0, unknown: 1, idle: 2 }[b.status],
      );
  }
}
