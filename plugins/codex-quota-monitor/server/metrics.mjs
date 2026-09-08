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

function turnIdentity(thread) {
  const evidence = thread.activityEvidence || {};
  const turnId = typeof evidence.turnId === "string" && evidence.turnId
    ? evidence.turnId : null;
  const startedAt = Number.isFinite(thread.startedAt) ? thread.startedAt : null;
  const sequence = Number.isFinite(evidence.turnSequence) ? evidence.turnSequence : null;
  return turnId || startedAt !== null ? { turnId, startedAt, sequence } : null;
}

function sameTurn(record, identity) {
  if (!record || !identity) return false;
  if (record.turnId && identity.turnId) {
    // Projection ordinals can advance while a turn is being completed.
    return record.turnId === identity.turnId;
  }
  return record.startedAt !== null && record.startedAt === identity.startedAt;
}

function latestTurnDuration(thread, now) {
  if (thread.status !== "active" && thread.status !== "idle") return null;
  const durationMs = thread.activityEvidence?.lastTurnDurationMs;
  if (thread.status !== "active" && Number.isFinite(durationMs) && durationMs >= 0)
    return durationMs / 1000;
  if (!Number.isFinite(thread.startedAt)) return null;
  const end = thread.status === "active" ? now : thread.completedAt;
  return Number.isFinite(end) && end >= thread.startedAt
    ? (end - thread.startedAt) / 1000 : null;
}

function executionIntervals(thread, now, includeLatest = true) {
  const intervals = (Array.isArray(thread.executionHistory?.intervals)
    ? thread.executionHistory.intervals : [])
    .filter((pair) => Array.isArray(pair) && Number.isFinite(pair[0]) && Number.isFinite(pair[1]) && pair[1] >= pair[0])
    .map((pair) => [pair[0], pair[1]]);
  const latestSeconds = includeLatest ? latestTurnDuration(thread, now) : null;
  if (Number.isFinite(thread.startedAt) && latestSeconds !== null) {
    const end = thread.status === "active" ? now
      : Number.isFinite(thread.completedAt) ? thread.completedAt
      : thread.startedAt + latestSeconds * 1000;
    if (end >= thread.startedAt) intervals.push([thread.startedAt, end]);
  }
  return intervals;
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
      sessionOrder: [],
      latestTurns: {},
      pendingTurns: {},
      sessionTrackingSince: saved.since || Date.now(),
      ...saved,
    };
    const s = this.state;
    s.sessionLedger ||= {};
    s.groupObservationSeconds ||= {};
    s.sessionOrder = Array.isArray(s.sessionOrder)
      ? [...new Set(s.sessionOrder.filter((id) => typeof id === "string" && id))]
      : [];
    s.latestTurns = s.latestTurns && typeof s.latestTurns === "object" && !Array.isArray(s.latestTurns)
      ? s.latestTurns : {};
    for (const record of Object.values(s.latestTurns)) {
      if (record && typeof record === "object") record.recovered = true;
    }
    // Unconfirmed deltas and recent rates cannot cross a collector restart.
    s.pending = {};
    s.pendingTurns = {};
    s.lastTokens = {};
    s.activity = {};
    s.gap = true;
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

  latestTurn(thread, now) {
    const identity = turnIdentity(thread);
    if (!identity) return null;
    const s = this.state;
    let record = s.latestTurns[thread.id];
    // A temporarily regressed projection must not replace the latest ledger.
    if (record && identity.startedAt !== null && record.startedAt !== null &&
        identity.startedAt < record.startedAt && !sameTurn(record, identity)) return null;
    const reopened = record?.terminal && this.previousThreads.has(thread.id) &&
      thread.status === "active" && !thread.completedAt;
    if (!sameTurn(record, identity) || reopened) {
      const generation = (record?.generation || 0) + 1;
      record = s.latestTurns[thread.id] = {
        ...identity,
        generation,
        key: `${thread.id}:${generation}:${identity.turnId || identity.startedAt}`,
        allocatedPercent: 0,
        observedSeconds: 0,
        hasAllocation: false,
        observedSince: now,
        partial: true,
      };
      // Keep old tokens in the task-wide pending total, never reassign them
      // to this turn. Only subsequent, identified deltas enter this bucket.
      s.pendingTurns[thread.id] = { key: record.key, tokens: 0 };
      s.activity[thread.id] = [];
    } else {
      record.turnId ||= identity.turnId;
      record.startedAt ??= identity.startedAt;
      record.sequence ??= identity.sequence;
    }
    record.terminal = thread.status === "idle" && Number.isFinite(thread.completedAt);
    record.completedAt = thread.completedAt ?? null;
    if (this.lastAt === null) record.lastAttachedAt = now;
    return record;
  }

  local(threads, now, maxGapMs = 600000) {
    const s = this.state,
      previousAt = this.lastAt;
    const continuous =
      previousAt !== null && now >= previousAt && now - previousAt <= maxGapMs;
    if (previousAt !== null && !continuous) {
      s.gap = true;
      s.pending = {};
      s.pendingTurns = {};
      s.activity = {};
    }
    const intervals = new Map();
    for (const t of threads) {
      const old = this.previousThreads.get(t.id);
      const latest = this.latestTurn(t, now);
      const identified = Boolean(latest && old?.turnKey === latest.key &&
        old.status !== "unknown" && t.status !== "unknown");
      let interval = null;
      if (continuous && old && old.status !== "unknown" && t.status !== "unknown") {
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
        if (identified) latest.observedSeconds += (interval[1] - interval[0]) / 1000;
      }
      const previous = s.lastTokens[t.id];
      const tokenKnown = Number.isFinite(t.tokens) && t.tokens >= 0 && t.tokensKnown !== false;
      const tokens = tokenKnown ? t.tokens : null;
      const delta =
        previous == null || !continuous || !old?.tokensKnown || !tokenKnown
          ? 0
          : Math.max(0, tokens - previous);
      s.lastTokens[t.id] = tokens;
      if (!/spark/.test(t.model || "")) {
        s.pending[t.id] = (s.pending[t.id] || 0) + delta;
        if (identified && delta > 0) {
          const bucket = s.pendingTurns[t.id];
          if (!bucket || bucket.key !== latest.key)
            s.pendingTurns[t.id] = { key: latest.key, tokens: delta };
          else bucket.tokens += delta;
        }
        if (!identified || !continuous) s.activity[t.id] = [];
        const points = (s.activity[t.id] ||= []);
        points.push({ at: now, delta: identified ? delta : 0 });
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
          turnKey: sameTurn(s.latestTurns[t.id], turnIdentity(t)) ? s.latestTurns[t.id]?.key : null,
          tokensKnown: Number.isFinite(t.tokens) && t.tokens >= 0 && t.tokensKnown !== false,
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
      s.latestTurns = {};
      s.pendingTurns = {};
      s.sessionTrackingSince = now;
    }
    const reset =
      !s.previous || unitChanged || ownerChanged ||
      s.previous.identity !== identity ||
      w.usedPercent < s.previous.used;
    if (reset) {
      // A quota-window reset must not erase already observed session history.
      Object.assign(s, {
        since: now,
        totals: {},
        pending: {},
        pendingTurns: {},
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
            const latest = s.latestTurns[id];
            const bucket = s.pendingTurns[id];
            if (latest && bucket?.key === latest.key && bucket.tokens > 0) {
              latest.allocatedPercent += allocated * Math.min(1, bucket.tokens / count);
              latest.hasAllocation = true;
            }
          }
          s.calibratedTokens += sum;
          s.calibratedPercent += delta;
        } else s.unattributedPercent += delta;
        s.pending = {};
        s.pendingTurns = {};
      }
    }
    if (s.gap) {
      s.pending = {};
      s.pendingTurns = {};
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
    const latest = s.latestTurns[thread.id];
    const currentTurn = sameTurn(latest, turnIdentity(thread));
    const latestAvailable = !latest || currentTurn;
    const latestSeconds = latestAvailable ? latestTurnDuration(thread, now) : null;
    const intervals = executionIntervals(thread, now, latestAvailable);
    const totalSeconds = intervals.length || latestSeconds !== null || ledger?.activeSeconds > 0
      ? Math.max(mergeDuration(intervals), latestSeconds || 0, ledger?.activeSeconds || 0) : null;
    const futureRate = currentTurn && thread.status === "active" && percentRate > 0 ? 1 / percentRate : null;
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
      totalElapsedSeconds: totalSeconds,
      totalEstimatedPercent: estimate,
      latestTurnElapsedSeconds: latestSeconds,
      latestTurnEstimatedPercent: covered && currentTurn && latest.hasAllocation
        ? latest.allocatedPercent : null,
      latestTurnSecondsPerPercent: futureRate,
      latestTurnObservationSince: currentTurn ? latest.observedSince : null,
      latestTurnLastAttachedAt: currentTurn ? latest.lastAttachedAt || latest.observedSince : null,
      latestTurnCoverage: currentTurn
        ? latest.recovered ? "partial-after-restart" : "monitoring-partial"
        : "unavailable",
      totalDurationCoverage: thread.executionHistory?.coverage || "partial",
      secondsPerPercent: futureRate,
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
    const groups = groupThreads(threads);
    const known = new Set(s.sessionOrder);
    for (const group of groups) {
      if (!known.has(group.id)) {
        s.sessionOrder.push(group.id);
        known.add(group.id);
      }
      for (const member of group.members) {
        if (!known.has(member.id)) {
          s.sessionOrder.push(member.id);
          known.add(member.id);
        }
      }
    }
    const order = new Map(s.sessionOrder.map((id, index) => [id, index]));
    const orderOf = (thread) => order.get(thread.id) ?? Number.MAX_SAFE_INTEGER;
    const compare = (a, b) => Number(b.status === "active") - Number(a.status === "active") || orderOf(a) - orderOf(b);
    return groups
      .map((group) => {
        const members = group.members
          .slice()
          .sort(compare);
        const ownThread = members.find((t) => t.id === group.id) || group;
        const own = this.individual(ownThread, now);
        const rows = members.map((t) => this.individual(t, now));
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
          totalElapsedSeconds: rows.some((row) => row.totalElapsedSeconds !== null)
            ? Math.max(mergeDuration(group.members.flatMap((t) => executionIntervals(t, now,
                !s.latestTurns[t.id] || sameTurn(s.latestTurns[t.id], turnIdentity(t))))), measured,
                ...rows.map((row) => row.totalElapsedSeconds || 0)) : null,
          totalEstimatedPercent: estimated,
          latestTurnElapsedSeconds: own.latestTurnElapsedSeconds,
          latestTurnEstimatedPercent: own.latestTurnEstimatedPercent,
          latestTurnSecondsPerPercent: own.latestTurnSecondsPerPercent,
          totalDurationCoverage: group.members.every((t) => t.executionHistory?.coverage === "local-records")
            ? "local-records" : "partial",
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
      .sort(compare);
  }
}
