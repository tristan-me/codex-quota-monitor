// Estimates are an allocation model, not an official subscription ledger.
export const DEFAULT_RETENTION_HOURS = 24;
export const MIN_RETENTION_HOURS = 1;
export const MAX_RETENTION_HOURS = 168;

export function normalizeRetentionHours(value, fallback = DEFAULT_RETENTION_HOURS) {
  if (!Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  return Math.min(MAX_RETENTION_HOURS, Math.max(MIN_RETENTION_HOURS, value));
}

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
function safeDuration(thread, now, cutoff = -Infinity) {
  if (!Number.isFinite(thread.startedAt)) return null;
  const end =
    thread.status === "active" ? now : thread.completedAt || thread.updatedAt;
  if (!Number.isFinite(end)) return null;
  const clipped = clipInterval([thread.startedAt, end], cutoff, now);
  return clipped ? (clipped[1] - clipped[0]) / 1000 : null;
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

function clipInterval(interval, cutoff, now) {
  if (!Array.isArray(interval) || interval.length < 2) return null;
  const start = Number(interval[0]);
  const end = Number(interval[1]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return null;
  const clipped = [Math.max(start, cutoff), Math.min(end, now)];
  return clipped[1] > clipped[0] ? clipped : null;
}

function quotaEventPosition(event) {
  const startAt = Number(event?.startAt);
  const endAt = Number(event?.endAt);
  if (Number.isFinite(startAt) && Number.isFinite(endAt) && endAt > startAt)
    return { startAt, endAt };
  if (Number.isFinite(startAt) || Number.isFinite(endAt)) {
    const point = Number.isFinite(startAt) && Number.isFinite(endAt)
      ? Math.max(startAt, endAt)
      : Number.isFinite(endAt) ? endAt : startAt;
    return { startAt: point, endAt: point };
  }
  const at = Number(event?.at);
  return Number.isFinite(at) ? { startAt: at, endAt: at } : null;
}

function quotaEventWithinRetention(event, cutoff, now) {
  const position = quotaEventPosition(event);
  return Boolean(position && position.endAt >= cutoff && position.startAt <= now);
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

function latestTurnInterval(thread, now, cutoff = -Infinity) {
  if (thread.status !== "active" && thread.status !== "idle") return null;
  const durationMs = thread.activityEvidence?.lastTurnDurationMs;
  let end = thread.status === "active" ? now : thread.completedAt;
  let start = Number.isFinite(thread.startedAt) ? thread.startedAt : null;
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    // A completed turn is anchored to its real completion. This keeps an
    // explicit duration in the correct retention window even if projected
    // start metadata is incomplete or slightly inconsistent.
    if (thread.status === "idle" && Number.isFinite(end)) start = end - durationMs;
    else if (start !== null) end = Math.min(now, start + durationMs);
    else if (Number.isFinite(end)) start = end - durationMs;
  }
  if (start === null || !Number.isFinite(end)) return null;
  return clipInterval([start, end], cutoff, now);
}

function latestTurnDuration(thread, now, cutoff = -Infinity) {
  const interval = latestTurnInterval(thread, now, cutoff);
  return interval ? (interval[1] - interval[0]) / 1000 : null;
}

function executionIntervals(thread, now, includeLatest = true, cutoff = -Infinity) {
  const intervals = (Array.isArray(thread.executionHistory?.intervals)
    ? thread.executionHistory.intervals : [])
    .map((pair) => clipInterval(pair, cutoff, now))
    .filter(Boolean);
  const latest = includeLatest ? latestTurnInterval(thread, now, cutoff) : null;
  if (latest) intervals.push(latest);
  return intervals;
}

function executionTurns(thread, now) {
  const current = {
    turnId: thread.activityEvidence?.turnId || null,
    startedAt: thread.startedAt,
    completedAt: thread.completedAt,
    durationMs: thread.activityEvidence?.lastTurnDurationMs,
    status: thread.status,
    current: true,
  };
  const history = Array.isArray(thread.executionHistory?.turns)
    ? thread.executionHistory.turns
    : (thread.executionHistory?.intervals || []).map(([startedAt, completedAt]) => ({
        startedAt, completedAt, status: "idle", turnId: null,
      }));
  const unique = new Map();
  for (const raw of [...history, current]) {
    const turn = {
      ...raw,
      startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt
        : Number.isFinite(raw.completedAt) && Number.isFinite(raw.durationMs) && raw.durationMs >= 0
          ? raw.completedAt - raw.durationMs : null,
    };
    if (!Number.isFinite(turn.startedAt) || turn.startedAt > now) continue;
    if (turn.current) {
      for (const [key, old] of unique) {
        if ((turn.turnId && old.turnId === turn.turnId) || old.startedAt === turn.startedAt)
          unique.delete(key);
      }
    }
    const key = turn.turnId ? `id:${turn.turnId}` : `start:${turn.startedAt}`;
    // History rows are newest first. The live projection replaces its history
    // row, while duplicate older projections cannot replace a newer one.
    if (!turn.current && unique.has(key)) continue;
    const active = turn.current && thread.status === "active";
    const completedAt = Number.isFinite(turn.completedAt) ? turn.completedAt
      : turn.status === "idle" && Number.isFinite(turn.durationMs)
        ? turn.startedAt + turn.durationMs : null;
    const endAt = active ? now : completedAt;
    const recorded = turn.current && thread.status === "idle" ? history.find((item) =>
      ((turn.turnId && item.turnId === turn.turnId) || item.startedAt === turn.startedAt) &&
      item.status === "idle" &&
      Number.isFinite(item.startedAt) && Number.isFinite(item.completedAt) &&
      item.completedAt > item.startedAt) : null;
    unique.set(key, {
      ...turn, key, active, endAt,
      // Use the same retained interval as task totals when it is present. The
      // precise-duration fallback handles projections with no history interval.
      interval: recorded ? [recorded.startedAt, Math.min(now, recorded.completedAt)]
        : turn.current ? latestTurnInterval(thread, now)
        : Number.isFinite(endAt) && endAt > turn.startedAt
          ? [turn.startedAt, Math.min(now, endAt)] : null,
    });
  }
  return [...unique.values()];
}

function executionKeyMatches(thread, turn, key, record) {
  if (typeof key !== "string") return false;
  if (turn.current && record && sameTurn(record, turnIdentity(thread)))
    return record.key === key;
  const identity = turn.turnId || turn.startedAt;
  return identity !== null && identity !== undefined &&
    key.startsWith(`${thread.id}:`) && key.endsWith(`:${identity}`);
}

function intervalContained(range, turns, allTurns = turns) {
  if (!Number.isFinite(range?.startAt) || !Number.isFinite(range?.endAt)) return false;
  const intervals = turns.map((turn) => turn.interval).filter(Boolean);
  if (!intervals.length || range.startAt < Math.min(...intervals.map((pair) => pair[0])) ||
      range.endAt > Math.max(...intervals.map((pair) => pair[1]))) return false;
  const selected = new Set(turns.map((turn) => turn.key));
  // A delayed sample can span several selected executions and idle gaps, but
  // must not include an intervening execution belonging to another parent turn.
  return !allTurns.some((turn) => !selected.has(turn.key) && turn.interval &&
    turn.interval[0] < range.endAt && turn.interval[1] > range.startAt);
}

export class Estimator {
  constructor(saved = {}) {
    const trackingSince = [
      saved.sessionTrackingSince,
      saved.trackingSince,
      saved.since,
    ].find(Number.isFinite) ?? Date.now();
    this.state = {
      since: Date.now(),
      totals: {},
      pending: {},
      pendingRanges: {},
      pendingTurnRanges: {},
      pendingSince: null,
      lastTokens: {},
      lastSeenAt: {},
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
      retentionHours: DEFAULT_RETENTION_HOURS,
      rollingStartedAt: null,
      rollingAllocations: [],
      rollingObservations: [],
      rollingQuotaEvents: [],
      rollingCoverage: "timestamped",
      sessionTrackingSince: trackingSince,
      ...saved,
    };
    const s = this.state;
    s.sessionLedger ||= {};
    s.groupObservationSeconds ||= {};
    s.lastSeenAt = s.lastSeenAt && typeof s.lastSeenAt === "object" && !Array.isArray(s.lastSeenAt)
      ? s.lastSeenAt : {};
    s.sessionOrder = Array.isArray(s.sessionOrder)
      ? [...new Set(s.sessionOrder.filter((id) => typeof id === "string" && id))]
      : [];
    s.latestTurns = s.latestTurns && typeof s.latestTurns === "object" && !Array.isArray(s.latestTurns)
      ? s.latestTurns : {};
    s.retentionHours = normalizeRetentionHours(s.retentionHours);
    s.rollingAllocations = Array.isArray(s.rollingAllocations)
      ? s.rollingAllocations : [];
    s.rollingObservations = Array.isArray(s.rollingObservations)
      ? s.rollingObservations : [];
    s.rollingQuotaEvents = Array.isArray(s.rollingQuotaEvents)
      ? s.rollingQuotaEvents : [];
    s.rollingCoverage = typeof s.rollingCoverage === "string"
      ? s.rollingCoverage : "legacy-unbounded";
    if (!Object.hasOwn(saved, "rollingCoverage") &&
        !s.rollingAllocations.length && !s.rollingObservations.length)
      s.rollingCoverage = "legacy-unbounded";
    s.legacyUnboundedReason = typeof s.legacyUnboundedReason === "string"
      ? s.legacyUnboundedReason : null;
    for (const record of Object.values(s.latestTurns)) {
      if (record && typeof record === "object") record.recovered = true;
    }
    // Unconfirmed deltas and recent rates cannot cross a collector restart.
    s.pending = {};
    s.pendingTurns = {};
    s.pendingRanges = {};
    s.pendingTurnRanges = {};
    s.pendingSince = null;
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
    this.preMigrationRepresentedByTask = {};
    this.preMigrationRepresentedByTurn = {};
    for (const event of s.rollingAllocations) {
      if (!Number.isFinite(event?.percent) || event.percent <= 0 || typeof event.id !== "string")
        continue;
      this.preMigrationRepresentedByTask[event.id] =
        (this.preMigrationRepresentedByTask[event.id] || 0) + event.percent;
      if (event.turnKey && Number.isFinite(event.turnPercent) && event.turnPercent > 0) {
        const key = `${event.id}\u0000${event.turnKey}`;
        this.preMigrationRepresentedByTurn[key] =
          (this.preMigrationRepresentedByTurn[key] || 0) + event.turnPercent;
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

  cutoffAt(now) {
    return now - this.state.retentionHours * 60 * 60 * 1000;
  }

  observationSince(now) {
    const cutoff = this.cutoffAt(now);
    const started = Number.isFinite(this.state.rollingStartedAt)
      ? this.state.rollingStartedAt
      : Number.isFinite(this.state.sessionTrackingSince)
        ? this.state.sessionTrackingSince
        : null;
    return started === null ? cutoff : Math.max(cutoff, started);
  }

  sliceAllocation(event, now) {
    if (!event || !Number.isFinite(event.percent) || event.percent <= 0)
      return null;
    const cutoff = this.cutoffAt(now);
    const startAt = Number(event.startAt);
    const endAt = Number(event.endAt);
    const hasInterval = Number.isFinite(startAt) && Number.isFinite(endAt) && endAt > startAt;
    const turnPercent = Number.isFinite(event.turnPercent) && event.turnPercent > 0
      ? Math.min(event.percent, event.turnPercent) : null;
    if (!hasInterval) {
      if (!Number.isFinite(event.at) || event.at < cutoff || event.at > now)
        return null;
      return {
        ...event,
        percent: event.percent,
        tokens: Number.isFinite(event.tokens) && event.tokens > 0 ? event.tokens : null,
        turnPercent,
        coverage: event.coverage || "timestamped",
      };
    }
    const clipped = clipInterval([startAt, endAt], cutoff, now);
    if (!clipped) return null;
    const fraction = (clipped[1] - clipped[0]) / (endAt - startAt);
    return {
      ...event,
      at: clipped[1],
      startAt: clipped[0],
      endAt: clipped[1],
      percent: event.percent * fraction,
      tokens: Number.isFinite(event.tokens) && event.tokens > 0
        ? event.tokens * fraction : null,
      turnPercent: turnPercent === null ? null : turnPercent * fraction,
      coverage: event.coverage || "timestamped",
    };
  }

  sliceQuotaEvent(event, now) {
    if (!event || !Number.isFinite(event.percent) || event.percent <= 0)
      return null;
    const cutoff = this.cutoffAt(now);
    const startAt = Number(event.startAt);
    const endAt = Number(event.endAt);
    const hasInterval = Number.isFinite(startAt) && Number.isFinite(endAt) && endAt > startAt;
    if (!hasInterval) {
      if (!Number.isFinite(event.at) || event.at < cutoff || event.at > now)
        return null;
      return {
        ...event,
        attributedPercent: Math.max(0, Math.min(event.percent, event.attributedPercent || 0)),
        unattributedPercent: Math.max(0, Math.min(
          event.percent, event.unattributedPercent || 0,
        )),
      };
    }
    const clipped = clipInterval([startAt, endAt], cutoff, now);
    if (!clipped) return null;
    const fraction = (clipped[1] - clipped[0]) / (endAt - startAt);
    return {
      ...event,
      at: clipped[1],
      startAt: clipped[0],
      endAt: clipped[1],
      percent: event.percent * fraction,
      attributedPercent: (event.attributedPercent || 0) * fraction,
      unattributedPercent: (event.unattributedPercent || 0) * fraction,
    };
  }

  ensureAttributionEvents() {
    const s = this.state;
    const known = new Set(s.rollingQuotaEvents.map((event) => event.id).filter(Boolean));
    s.attributionSequence = Number.isInteger(s.attributionSequence)
      ? s.attributionSequence : 0;
    for (const allocation of s.rollingAllocations) {
      if (allocation.attributionEventId && known.has(allocation.attributionEventId))
        continue;
      const id = `recovered-allocation:${++s.attributionSequence}`;
      allocation.attributionEventId = id;
      known.add(id);
      s.rollingQuotaEvents.push({
        id,
        at: allocation.at,
        ...(Number.isFinite(allocation.startAt) && Number.isFinite(allocation.endAt)
          ? { startAt: allocation.startAt, endAt: allocation.endAt }
          : {}),
        percent: allocation.percent,
        attributedPercent: allocation.percent,
        unattributedPercent: 0,
        coverage: "recovered-attributed-lower-bound",
      });
    }
  }

  rollingAttribution(now) {
    const cutoff = this.cutoffAt(now);
    const observationSince = this.observationSince(now);
    const retainedPosition = (position) => position &&
      position.endAt >= cutoff && position.startAt <= now;
    const amountIsComplete = (event, sliced) => {
      if (String(event?.coverage) !== "official-quota-sample") return false;
      if (!Number.isFinite(event?.percent) || event.percent <= 0 ||
          !Number.isFinite(event?.attributedPercent) || event.attributedPercent < 0 ||
          !Number.isFinite(event?.unattributedPercent) || event.unattributedPercent < 0)
        return false;
      const rawTotal = event.attributedPercent + event.unattributedPercent;
      const rawTolerance = 1e-9 * Math.max(1, Math.abs(event.percent));
      if (Math.abs(rawTotal - event.percent) > rawTolerance || !sliced)
        return false;
      if (!Number.isFinite(sliced.percent) || sliced.percent <= 0 ||
          !Number.isFinite(sliced.attributedPercent) || sliced.attributedPercent < 0 ||
          !Number.isFinite(sliced.unattributedPercent) || sliced.unattributedPercent < 0)
        return false;
      const slicedTotal = sliced.attributedPercent + sliced.unattributedPercent;
      const slicedTolerance = 1e-9 * Math.max(1, Math.abs(sliced.percent));
      return Math.abs(slicedTotal - sliced.percent) <= slicedTolerance;
    };
    const ordered = this.state.rollingQuotaEvents
      .map((event, index) => ({ event, index, position: quotaEventPosition(event) }))
      .filter(({ position }) => !position || retainedPosition(position))
      .sort((a, b) =>
        (a.position?.endAt ?? -Infinity) - (b.position?.endAt ?? -Infinity) ||
        (a.position?.startAt ?? -Infinity) - (b.position?.startAt ?? -Infinity) ||
        a.index - b.index,
      );
    const events = [];
    let excludedIncompleteHistory = false;
    let boundary = observationSince;
    let restartAfter = null;
    for (const { event, position } of ordered) {
      if (!position) {
        // An in-window record with no usable timestamp cannot be ordered
        // against the retained history. Treat it as an old damaged boundary,
        // while allowing newly sampled points after the monitor start through.
        excludedIncompleteHistory = true;
        events.length = 0;
        restartAfter = Math.max(observationSince, cutoff);
        boundary = Math.max(boundary, restartAfter);
        continue;
      }
      const sliced = this.sliceQuotaEvent(event, now);
      if (!amountIsComplete(event, sliced)) {
        // A recovered lower-bound record or malformed official sample makes all
        // earlier records incomplete. Keep the task allocations, but restart
        // this attribution-only scope after the bad point.
        excludedIncompleteHistory = true;
        events.length = 0;
        const invalidBoundary = Math.min(now, position.endAt);
        restartAfter = Math.max(restartAfter ?? -Infinity, invalidBoundary);
        boundary = Math.max(boundary, invalidBoundary);
        continue;
      }
      if (restartAfter !== null && position.startAt < restartAfter) continue;
      events.push(sliced);
    }
    const observedPercent = events.reduce((sum, event) => sum + event.percent, 0);
    let attributedPercent = events.reduce(
      (sum, event) => sum + event.attributedPercent,
      0,
    );
    let unattributedPercent = events.reduce(
      (sum, event) => sum + event.unattributedPercent,
      0,
    );
    // Preserve each event's values while removing harmless floating-point
    // residue so the three reported amounts always reconcile exactly.
    const residual = observedPercent - attributedPercent - unattributedPercent;
    const tolerance = 1e-9 * Math.max(1, Math.abs(observedPercent));
    if (Number.isFinite(residual) && Math.abs(residual) <= tolerance) {
      if (unattributedPercent + residual >= 0) unattributedPercent += residual;
      else if (attributedPercent + residual >= 0) {
        // This branch only handles a tiny negative residue against a zero
        // unattributed amount; keep the nonnegative invariant intact.
        attributedPercent += residual;
      }
    }
    const since = events.length
      ? Math.min(...events.map((event) =>
        Number.isFinite(event.startAt) ? event.startAt : event.at,
      ))
      : boundary;
    return {
      observedPercent,
      attributedPercent,
      unattributedPercent,
      since,
      coverage: events.length ? "rolling" : "none",
      excludedIncompleteHistory,
      sampleCount: events.length,
      startReason: events.length
        ? excludedIncompleteHistory ? "after-incomplete-history" : "official-samples"
        : excludedIncompleteHistory
          ? "waiting-after-incomplete-history"
          : "waiting-for-quota-change",
    };
  }

  coverageForEvents(events, provisional = false) {
    const legacy = events.some((event) => String(event.coverage || "").startsWith("legacy-"));
    const timestamped = events.some((event) => !String(event.coverage || "").startsWith("legacy-"));
    if ((legacy && timestamped) || (legacy && provisional)) return "mixed";
    if (legacy) return "legacy-aggregate-uniform";
    if (timestamped) return "rolling";
    if (provisional) return "token-calibrated-provisional";
    return this.state.legacyUnboundedReason ? "legacy-unbounded" : "none";
  }

  refreshRollingCoverage() {
    const events = this.state.rollingAllocations;
    const legacy = events.some((event) => String(event.coverage || "").startsWith("legacy-"));
    const timestamped = events.some((event) => !String(event.coverage || "").startsWith("legacy-"));
    const missingLegacy = this.state.legacyUnboundedReason === "missing-thread-time-evidence";
    if (missingLegacy && events.length) {
      this.state.rollingCoverage = legacy && !timestamped
        ? "legacy-partial" : "mixed";
    } else if (legacy && timestamped) {
      this.state.rollingCoverage = "mixed";
    } else if (timestamped) {
      this.state.rollingCoverage = "timestamped";
    } else if (legacy) {
      this.state.rollingCoverage = "legacy-aggregate-uniform";
    } else {
      this.state.rollingCoverage = Number.isFinite(this.state.rollingStartedAt)
        ? "timestamped" : "legacy-unbounded";
    }
  }

  rebuildRollingCaches(now) {
    if (!this.state.legacyAggregateMigrated) return;
    const s = this.state;
    const ledgers = {};
    const totals = {};
    for (const event of s.rollingAllocations) {
      if (!Number.isFinite(event.percent) || event.percent <= 0) continue;
      const ledger = (ledgers[event.id] ||= {
        allocatedPercent: 0,
        timedPercent: 0,
        activeSeconds: 0,
        hasAllocation: false,
      });
      ledger.allocatedPercent += event.percent;
      ledger.hasAllocation = true;
      totals[event.id] = (totals[event.id] || 0) + event.percent;
    }
    const observedIds = new Set(s.rollingObservations.map((event) => event.threadId));
    for (const id of observedIds) {
      const ledger = (ledgers[id] ||= {
        allocatedPercent: 0,
        timedPercent: 0,
        activeSeconds: 0,
        hasAllocation: false,
      });
      ledger.activeSeconds = this.rollingObservationSeconds(id, now);
      if (ledger.activeSeconds > 0 && ledger.allocatedPercent > 0)
        ledger.timedPercent = ledger.allocatedPercent;
    }
    s.sessionLedger = ledgers;
    s.totals = totals;
    for (const [id, record] of Object.entries(s.latestTurns)) {
      if (!record || typeof record !== "object" || !record.key) continue;
      const allocation = this.rollingAllocation(id, now, record.key);
      record.allocatedPercent = allocation.value;
      record.hasAllocation = allocation.hasEvent;
    }
    const calibration = this.rollingCalibration(now);
    s.calibratedTokens = calibration.tokens;
    s.calibratedPercent = calibration.percent;
    const attribution = this.rollingAttribution(now);
    s.observedPercent = attribution.observedPercent;
    s.unattributedPercent = attribution.unattributedPercent;
    s.attributionCoverage = attribution.coverage;
  }

  pruneRolling(now = Date.now()) {
    const s = this.state;
    const cutoff = this.cutoffAt(now);
    s.rollingAllocations = s.rollingAllocations
      .map((event) => this.sliceAllocation(event, now))
      .filter(Boolean);
    s.rollingObservations = s.rollingObservations
      .filter((event) => Number.isFinite(event?.endAt) && event.endAt > cutoff && event.startAt <= now)
      .map((event) => ({
        ...event,
        at: Math.min(now, event.endAt),
        startAt: Math.max(event.startAt, cutoff),
        endAt: Math.min(event.endAt, now),
      }))
      .filter((event) => event.endAt > event.startAt);
    s.rollingQuotaEvents = s.rollingQuotaEvents
      .flatMap((event) => {
        // Do not normalize corrupt split amounts into an apparently complete
        // official sample before rollingAttribution can see the bad boundary.
        const rawSplit = event?.attributedPercent + event?.unattributedPercent;
        const invalidOfficial = event?.coverage === "official-quota-sample" && (
          !Number.isFinite(event.percent) || event.percent <= 0 ||
          !Number.isFinite(event.attributedPercent) || event.attributedPercent < 0 ||
          !Number.isFinite(event.unattributedPercent) || event.unattributedPercent < 0 ||
          Math.abs(rawSplit - event.percent) > 1e-9 * Math.max(1, Math.abs(event.percent))
        );
        if (invalidOfficial) return quotaEventWithinRetention(event, cutoff, now) ||
          !quotaEventPosition(event) ? [event] : [];
        const sliced = this.sliceQuotaEvent(event, now);
        if (sliced) return [sliced];
        // Retain an in-window malformed record as an attribution boundary.
        // It must not affect task ledgers, but dropping it here would let an
        // earlier valid suffix look complete after the next prune.
        return quotaEventWithinRetention(event, cutoff, now) ||
            !quotaEventPosition(event)
          ? [event]
          : [];
      });
    s.groupObservationSeconds = {};
    for (const [id, record] of Object.entries(s.latestTurns)) {
      const lastEvidence = [
        record?.completedAt,
        record?.lastAttachedAt,
        record?.observedSince,
        record?.startedAt,
      ].filter(Number.isFinite).reduce((latest, value) => Math.max(latest, value), -Infinity);
      const retained = record?.key
        ? this.rollingAllocation(id, now, record.key).hasEvent : false;
      if (lastEvidence < cutoff && !retained)
        delete s.latestTurns[id];
    }
    s.history = (s.history || []).filter(
      (event) => Number.isFinite(event?.at) && event.at >= cutoff && event.at <= now,
    );
    for (const [id, points] of Object.entries(s.activity || {})) {
      const retained = Array.isArray(points)
        ? points.filter((point) => Number.isFinite(point?.at) && point.at >= Math.max(cutoff, now - 120000) && point.at <= now)
        : [];
      if (retained.length) s.activity[id] = retained;
      else delete s.activity[id];
    }
    if (Number.isFinite(s.pendingSince) && s.pendingSince < cutoff) {
      s.pending = {};
      s.pendingTurns = {};
      s.pendingRanges = {};
      s.pendingTurnRanges = {};
      s.pendingSince = null;
      s.gap = true;
    }
    const expiredSeenIds = new Set();
    for (const [id, seenAt] of Object.entries(s.lastSeenAt)) {
      if (!Number.isFinite(seenAt) || seenAt >= cutoff) continue;
      const hasAllocation = s.rollingAllocations.some((event) => event.id === id);
      const hasObservation = s.rollingObservations.some((event) => event.threadId === id);
      const hasPending = Number.isFinite(s.pending[id]) && s.pending[id] > 0;
      if (hasAllocation || hasObservation || hasPending || s.latestTurns[id]) continue;
      expiredSeenIds.add(id);
      delete s.lastSeenAt[id];
      delete s.lastTokens[id];
      delete s.activity[id];
    }
    s.sessionOrder = s.sessionOrder.filter((id) =>
      !expiredSeenIds.has(id) ||
      s.rollingAllocations.some((event) => event.id === id) ||
      s.rollingObservations.some((event) => event.threadId === id));
    if (Number.isFinite(s.rollingStartedAt))
      s.rollingStartedAt = Math.max(s.rollingStartedAt, cutoff);
    this.ensureAttributionEvents();
    this.refreshRollingCoverage();
    this.rebuildRollingCaches(now);
  }

  setRetentionHours(value, now = Date.now()) {
    this.state.retentionHours = normalizeRetentionHours(value, this.state.retentionHours);
    this.pruneRolling(now);
    return this.state.retentionHours;
  }

  rollingWindowStarted(now) {
    if (!Number.isFinite(this.state.rollingStartedAt))
      this.state.rollingStartedAt = now;
  }

  migrateLegacyAggregate(now, threads = []) {
    const s = this.state;
    if (s.legacyAggregateMigrated) return;
    const start = Number.isFinite(s.sessionTrackingSince)
      ? s.sessionTrackingSince : null;
    const end = Number.isFinite(s.previous?.at) ? s.previous.at : null;
    const cutoff = this.cutoffAt(now);
    const legacyLedgers = Object.entries(s.sessionLedger || {}).filter(
      ([, ledger]) => Number.isFinite(ledger?.allocatedPercent) && ledger.allocatedPercent > 0,
    );
    if (!legacyLedgers.length && !s.rollingAllocations.length) {
      s.legacyAggregateMigrated = true;
      s.legacyUnboundedReason = null;
      this.refreshRollingCoverage();
      return;
    }
    if (start !== null && end !== null && end > start && end >= cutoff &&
        legacyLedgers.length && (!Array.isArray(threads) || !threads.length)) {
      // A retention-setting update can happen before the first local read.
      // Wait for thread lifecycle evidence instead of assigning every old task
      // the monitor-wide interval.
      return;
    }
    s.legacyAggregateMigrated = true;
    if (start === null || end === null || end <= start || end < cutoff) {
      s.legacyUnboundedReason = s.rollingAllocations.length
        ? null
        : end !== null && end < cutoff
          ? "outside-window" : "missing-time-evidence";
      this.refreshRollingCoverage();
      return;
    }
    const representedByTask = { ...this.preMigrationRepresentedByTask };
    const representedByTurn = { ...this.preMigrationRepresentedByTurn };
    const retainedByTask = {};
    const retainedByTurn = {};
    for (const event of s.rollingAllocations) {
      if (!Number.isFinite(event?.percent) || event.percent <= 0 || typeof event.id !== "string")
        continue;
      retainedByTask[event.id] = (retainedByTask[event.id] || 0) + event.percent;
      if (event.turnKey && Number.isFinite(event.turnPercent) && event.turnPercent > 0) {
        const key = `${event.id}\u0000${event.turnKey}`;
        retainedByTurn[key] = (retainedByTurn[key] || 0) + event.turnPercent;
      }
    }
    for (const [id, amount] of Object.entries(retainedByTask))
      representedByTask[id] = Math.max(representedByTask[id] || 0, amount);
    for (const [key, amount] of Object.entries(retainedByTurn))
      representedByTurn[key] = Math.max(representedByTurn[key] || 0, amount);
    const byId = new Map((Array.isArray(threads) ? threads : []).map((thread) => [thread.id, thread]));
    let unplaced = false;
    for (const [id, ledger] of legacyLedgers) {
      const unrepresented = Math.max(0, ledger.allocatedPercent - (representedByTask[id] || 0));
      if (unrepresented <= 0) continue;
      const thread = byId.get(id);
      const latest = s.latestTurns[id];
      const representedLatest = latest?.key
        ? representedByTurn[`${id}\u0000${latest.key}`] || 0 : 0;
      let latestShare = latest?.hasAllocation && Number.isFinite(latest.allocatedPercent)
        ? Math.min(unrepresented, Math.max(0, latest.allocatedPercent - representedLatest))
        : 0;
      let latestStart = Number.isFinite(latest?.observedSince)
        ? Math.max(start, latest.observedSince)
        : Number.isFinite(latest?.startedAt) ? Math.max(start, latest.startedAt) : null;
      const latestEndCandidate = Number.isFinite(latest?.completedAt)
        ? latest.completedAt
        : Number.isFinite(latest?.lastAttachedAt) ? latest.lastAttachedAt : end;
      let latestEnd = Number.isFinite(latestEndCandidate)
        ? Math.min(end, latestEndCandidate) : null;
      const historyIntervals = (Array.isArray(thread?.executionHistory?.intervals)
        ? thread.executionHistory.intervals : [])
        .map((interval) => clipInterval(interval, start, end))
        .filter(Boolean);
      const projectedLatest = thread
        ? latestTurnInterval(thread, end, start) : null;
      if ((!latestStart || !latestEnd || latestEnd <= latestStart) && projectedLatest) {
        latestStart = projectedLatest[0];
        latestEnd = projectedLatest[1];
      }
      const oneCompleteTurn = thread?.executionHistory?.coverage === "local-records" &&
        historyIntervals.length === 1 && projectedLatest && latest?.key &&
        Math.abs(historyIntervals[0][0] - projectedLatest[0]) <= 1 &&
        Math.abs(historyIntervals[0][1] - projectedLatest[1]) <= 1;
      if (oneCompleteTurn) {
        latestShare = unrepresented;
        latestStart = projectedLatest[0];
        latestEnd = projectedLatest[1];
      }
      const canPlaceLatest = latestShare > 0 && latest?.key && latestStart !== null &&
        latestEnd !== null && latestEnd > latestStart;
      if (canPlaceLatest) {
        s.rollingAllocations.push({
          at: latestEnd,
          id,
          startAt: latestStart,
          endAt: latestEnd,
          percent: latestShare,
          tokens: null,
          turnKey: latest.key,
          turnPercent: latestShare,
          coverage: oneCompleteTurn
            ? "legacy-single-turn-inferred"
            : "legacy-aggregate-uniform",
        });
      }
      const remainder = unrepresented - (canPlaceLatest ? latestShare : 0);
      if (remainder <= 0) continue;
      if (thread?.executionHistory?.coverage === "local-records" && historyIntervals.length) {
        const totalMs = historyIntervals.reduce(
          (sum, interval) => sum + interval[1] - interval[0], 0);
        if (totalMs > 0) {
          for (const interval of historyIntervals) {
            s.rollingAllocations.push({
              at: interval[1],
              id,
              startAt: interval[0],
              endAt: interval[1],
              percent: remainder * (interval[1] - interval[0]) / totalMs,
              tokens: null,
              turnKey: null,
              turnPercent: null,
              coverage: "legacy-thread-history-uniform",
            });
          }
          continue;
        }
      }
      unplaced = true;
    }
    if (!Number.isFinite(s.rollingStartedAt)) s.rollingStartedAt = start;
    s.legacyUnboundedReason = unplaced
      ? "missing-thread-time-evidence"
      : s.rollingAllocations.length ? null : "missing-time-evidence";
    this.refreshRollingCoverage();
  }

  hasRollingWindow() {
    return Number.isFinite(this.state.rollingStartedAt) ||
      this.state.rollingAllocations.length > 0 ||
      this.state.rollingObservations.length > 0;
  }

  appendObservation(threadId, interval, turnKey, now) {
    const clipped = clipInterval(interval, this.cutoffAt(now), now);
    if (!clipped) return;
    const events = this.state.rollingObservations;
    const previous = events.findLast((event) =>
      event.threadId === threadId && event.turnKey === (turnKey || null));
    if (previous && previous.threadId === threadId && previous.turnKey === (turnKey || null) &&
        previous.endAt >= clipped[0] - 1000) {
      previous.endAt = Math.max(previous.endAt, clipped[1]);
      previous.at = now;
      return;
    }
    events.push({
      at: now,
      threadId,
      turnKey: turnKey || null,
      startAt: clipped[0],
      endAt: clipped[1],
    });
  }

  rollingObservationSeconds(threadId, now) {
    const cutoff = this.cutoffAt(now);
    return mergeDuration(
      this.state.rollingObservations
        .filter((event) => event.threadId === threadId)
        .map((event) => clipInterval([event.startAt, event.endAt], cutoff, now))
        .filter(Boolean),
    );
  }

  rollingObservationForThreads(ids, now) {
    const wanted = new Set(ids);
    const cutoff = this.cutoffAt(now);
    return mergeDuration(
      this.state.rollingObservations
        .filter((event) => wanted.has(event.threadId))
        .map((event) => clipInterval([event.startAt, event.endAt], cutoff, now))
        .filter(Boolean),
    );
  }

  rollingObservationIntervals(ids, now) {
    const wanted = new Set(ids);
    const cutoff = this.cutoffAt(now);
    return this.state.rollingObservations
      .filter((event) => wanted.has(event.threadId))
      .map((event) => clipInterval([event.startAt, event.endAt], cutoff, now))
      .filter(Boolean);
  }

  rollingAllocation(id, now, turnKey = null) {
    const events = this.state.rollingAllocations
      .filter((event) => event.id === id)
      .map((event) => this.sliceAllocation(event, now))
      .filter(Boolean);
    if (turnKey) {
      const matching = events.filter((event) =>
        event.turnKey === turnKey && Number.isFinite(event.turnPercent) && event.turnPercent > 0);
      const value = matching.reduce((sum, event) => sum + event.turnPercent, 0);
      return {
        value,
        hasEvent: matching.length > 0,
        events: matching,
        coverage: this.coverageForEvents(matching),
      };
    }
    const value = events.reduce((sum, event) => sum + event.percent, 0);
    return {
      value,
      hasEvent: events.length > 0,
      events,
      coverage: this.coverageForEvents(events),
    };
  }

  rollingCalibration(now) {
    const identity = this.state.previous?.identity;
    let tokens = 0;
    let percent = 0;
    for (const event of this.state.rollingAllocations) {
      const retained = this.sliceAllocation(event, now);
      if (!retained || !identity || retained.quotaIdentity !== identity) continue;
      if (Number.isFinite(retained.tokens) && retained.tokens > 0 && retained.percent > 0) {
        tokens += retained.tokens;
        percent += retained.percent;
      }
    }
    return { tokens, percent };
  }

  provisionalAllocation(id, now, turnKey = null) {
    const calibration = this.rollingCalibration(now);
    if (!(calibration.tokens > 0 && calibration.percent > 0))
      return { value: 0, hasEvent: false, tokens: 0 };
    let tokens = 0;
    if (turnKey) {
      const bucket = this.state.pendingTurns[id];
      if (bucket?.key === turnKey && Number.isFinite(bucket.tokens) && bucket.tokens > 0)
        tokens = bucket.tokens;
    } else if (Number.isFinite(this.state.pending[id]) && this.state.pending[id] > 0) {
      tokens = this.state.pending[id];
    }
    const value = tokens * calibration.percent / calibration.tokens;
    return { value, hasEvent: value > 0, tokens };
  }

  effectiveAllocation(id, now, turnKey = null) {
    const confirmed = this.rollingAllocation(id, now, turnKey);
    const provisional = this.provisionalAllocation(id, now, turnKey);
    const hasEvent = confirmed.hasEvent || provisional.hasEvent;
    const value = confirmed.value + provisional.value;
    const source = provisional.hasEvent
      ? confirmed.hasEvent
        ? "confirmed-plus-token-calibrated-provisional"
        : "token-calibrated-provisional"
      : confirmed.hasEvent
        ? confirmed.events.some((event) => String(event.coverage).startsWith("legacy-"))
          ? "legacy-uniform-estimate"
          : "confirmed-account-delta"
        : null;
    return {
      value,
      hasEvent,
      confirmed: confirmed.value,
      provisional: provisional.value,
      source,
      estimated: provisional.hasEvent || source === "legacy-uniform-estimate",
      coverage: this.coverageForEvents(confirmed.events, provisional.hasEvent),
    };
  }

  extendPendingRange(id, interval, turnKey = null) {
    if (!Array.isArray(interval) || interval[1] <= interval[0]) return;
    const s = this.state;
    const ranges = turnKey ? s.pendingTurnRanges : s.pendingRanges;
    const previous = ranges[id];
    if (turnKey && previous?.key !== turnKey) {
      ranges[id] = { key: turnKey, startAt: interval[0], endAt: interval[1] };
    } else if (previous) {
      previous.startAt = Math.min(previous.startAt, interval[0]);
      previous.endAt = Math.max(previous.endAt, interval[1]);
    } else {
      ranges[id] = {
        ...(turnKey ? { key: turnKey } : {}),
        startAt: interval[0],
        endAt: interval[1],
      };
    }
    s.pendingSince = Number.isFinite(s.pendingSince)
      ? Math.min(s.pendingSince, interval[0]) : interval[0];
  }

  refreshGroupObservationCache(threads, now) {
    const next = {};
    for (const group of groupThreads(threads)) {
      next[group.id] = this.rollingObservationForThreads(
        group.members.map((member) => member.id), now,
      );
    }
    this.state.groupObservationSeconds = next;
  }

  latestTurn(thread, now) {
    const identity = turnIdentity(thread);
    if (!identity) return null;
    const s = this.state;
    let record = s.latestTurns[thread.id];
    const lastThreadEvidence = [thread.completedAt, thread.updatedAt, thread.startedAt]
      .filter(Number.isFinite)
      .reduce((latest, value) => Math.max(latest, value), -Infinity);
    if (thread.status === "idle" && lastThreadEvidence < this.cutoffAt(now)) {
      delete s.latestTurns[thread.id];
      return null;
    }
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
      delete s.pendingTurnRanges[thread.id];
      s.activity[thread.id] = [];
    } else {
      record.turnId ||= identity.turnId;
      record.startedAt ??= identity.startedAt;
      record.sequence ??= identity.sequence;
    }
    record.terminal = thread.status === "idle" && Number.isFinite(thread.completedAt);
    record.completedAt = thread.completedAt ?? null;
    if (thread.status === "active" || this.lastAt === null)
      record.lastAttachedAt = now;
    return record;
  }

  local(threads, now, maxGapMs = 600000) {
    const s = this.state,
      previousAt = this.lastAt;
    this.migrateLegacyAggregate(now, threads);
    this.rollingWindowStarted(now);
    this.pruneRolling(now);
    const continuous =
      previousAt !== null && now >= previousAt && now - previousAt <= maxGapMs;
    if (previousAt !== null && !continuous) {
      s.gap = true;
      s.pending = {};
      s.pendingTurns = {};
      s.pendingRanges = {};
      s.pendingTurnRanges = {};
      s.pendingSince = null;
      s.activity = {};
    }
    const intervals = new Map();
    for (const t of threads) {
      s.lastSeenAt[t.id] = now;
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
        const turnKey = identified ? latest.key : null;
        this.appendObservation(t.id, interval, turnKey, now);
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
        const sampledRange = continuous && previousAt < now
          ? [previousAt, now] : null;
        if (delta > 0 && sampledRange)
          this.extendPendingRange(t.id, sampledRange);
        if (identified && delta > 0) {
          const bucket = s.pendingTurns[t.id];
          if (!bucket || bucket.key !== latest.key)
            s.pendingTurns[t.id] = { key: latest.key, tokens: delta };
          else bucket.tokens += delta;
          if (sampledRange) this.extendPendingRange(t.id, sampledRange, latest.key);
        }
        if (!identified || !continuous) s.activity[t.id] = [];
        const points = (s.activity[t.id] ||= []);
        points.push({ at: now, delta: identified ? delta : 0 });
        s.activity[t.id] = points
          .filter((p) => p.at >= now - 120000)
          .slice(-240);
      }
    }
    this.refreshGroupObservationCache(threads, now);
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
    this.rebuildRollingCaches(now);
  }

  quota(w, now, accountKey) {
    if (!w) return;
    const s = this.state;
    this.migrateLegacyAggregate(now);
    this.rollingWindowStarted(now);
    this.pruneRolling(now);
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
      s.pendingRanges = {};
      s.pendingTurnRanges = {};
      s.pendingSince = null;
      s.rollingAllocations = [];
      s.rollingObservations = [];
      s.rollingQuotaEvents = [];
      s.rollingStartedAt = now;
      s.rollingCoverage = "timestamped";
      s.legacyUnboundedReason = null;
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
        pendingRanges: {},
        pendingTurnRanges: {},
        pendingSince: null,
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
        s.attributionSequence = Number.isInteger(s.attributionSequence)
          ? s.attributionSequence : 0;
        const attributionEventId = `quota:${++s.attributionSequence}:${now}`;
        s.rollingQuotaEvents.push({
          id: attributionEventId,
          at: now,
          percent: delta,
          attributedPercent: sum > 0 && !s.gap ? delta : 0,
          unattributedPercent: sum > 0 && !s.gap ? 0 : delta,
          quotaIdentity: identity,
          coverage: "official-quota-sample",
        });
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
            let turnPercent = 0;
            let turnTokens = 0;
            if (latest && bucket?.key === latest.key && bucket.tokens > 0) {
              turnPercent = allocated * Math.min(1, bucket.tokens / count);
              turnTokens = Math.min(count, bucket.tokens);
            }
            const appendAllocation = ({ percent, tokens, key = null, range = null }) => {
              if (!(percent > 0)) return;
              const hasRange = Number.isFinite(range?.startAt) &&
                Number.isFinite(range?.endAt) && range.endAt > range.startAt;
              s.rollingAllocations.push({
                at: now,
                id,
                ...(hasRange
                  ? { startAt: range.startAt, endAt: Math.min(now, range.endAt) }
                  : {}),
                percent,
                tokens: tokens > 0 ? tokens : null,
                turnKey: key,
                turnPercent: key ? percent : null,
                quotaIdentity: identity,
                attributionEventId,
                coverage: hasRange
                  ? "timestamped-token-interval"
                  : "timestamped-quota-sample",
              });
            };
            appendAllocation({
              percent: allocated - turnPercent,
              tokens: count - turnTokens,
              range: s.pendingRanges[id],
            });
            appendAllocation({
              percent: turnPercent,
              tokens: turnTokens,
              key: latest?.key || null,
              range: s.pendingTurnRanges[id],
            });
          }
        } else s.unattributedPercent += delta;
        s.pending = {};
        s.pendingTurns = {};
        s.pendingRanges = {};
        s.pendingTurnRanges = {};
        s.pendingSince = null;
      }
    }
    if (s.gap) {
      s.pending = {};
      s.pendingTurns = {};
      s.pendingRanges = {};
      s.pendingTurnRanges = {};
      s.pendingSince = null;
      s.gap = false;
    }
    s.accountUnit = unit;
    if (w.planType) s.lastKnownPlanType = w.planType;
    s.previous = { identity, accountKey: owner, used: w.usedPercent, at: now };
    s.history.push({ at: now, remainingPercent: w.remainingPercent });
    this.pruneRolling(now);
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

  recentTokenRate(id, now, includeZero = false) {
    const points = this.state.activity[id] || [];
    if (points.length < 2) return null;
    const start = now - 5_000;
    let tokens = 0;
    let coveredMs = 0;
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      if (!Number.isFinite(previous?.at) || !Number.isFinite(current?.at) ||
          current.at <= previous.at || current.at - previous.at > 7_500)
        continue;
      const overlapStart = Math.max(start, previous.at);
      const overlapEnd = Math.min(now, current.at);
      if (overlapEnd <= overlapStart) continue;
      const fraction = (overlapEnd - overlapStart) / (current.at - previous.at);
      coveredMs += overlapEnd - overlapStart;
      if (Number.isFinite(current.delta) && current.delta > 0)
        tokens += current.delta * fraction;
    }
    // Do not turn one token sample into a made-up five-second observation.
    // A recent rate needs actual adjacent samples covering most of the window.
    return coveredMs >= 4_000 && (tokens > 0 || includeZero)
      ? tokens / (coveredMs / 1000) : null;
  }

  individual(thread, now) {
    const s = this.state;
    const covered = !/spark/.test(thread.model || "");
    const allocation = this.effectiveAllocation(thread.id, now);
    const estimate = covered && allocation.hasEvent ? allocation.value : null;
    const recentTokenRate = this.recentTokenRate(thread.id, now);
    const calibration = this.rollingCalibration(now);
    const percentRate =
      covered && calibration.tokens > 0 && recentTokenRate
        ? (recentTokenRate * calibration.percent) / calibration.tokens
        : null;
    const observedSeconds = this.rollingObservationSeconds(thread.id, now);
    const latest = s.latestTurns[thread.id];
    const currentTurn = sameTurn(latest, turnIdentity(thread));
    const latestAvailable = !latest || currentTurn;
    const cutoff = this.cutoffAt(now);
    const latestSeconds = latestAvailable ? latestTurnDuration(thread, now, cutoff) : null;
    const intervals = executionIntervals(thread, now, latestAvailable, cutoff);
    const observedIntervals = this.rollingObservationIntervals([thread.id], now);
    const totalSeconds = intervals.length || observedIntervals.length
      ? mergeDuration([...intervals, ...observedIntervals]) : null;
    const average = covered && estimate > 0 && totalSeconds > 0
      ? totalSeconds / estimate : null;
    const latestAllocation = currentTurn && latest
      ? this.effectiveAllocation(thread.id, now, latest.key)
      : {
          value: 0,
          hasEvent: false,
          source: null,
          coverage: "none",
          provisional: 0,
        };
    const turnAverage = latestSeconds > 0 && latestAllocation.value > 0
      ? latestSeconds / latestAllocation.value : null;
    const recentRate = currentTurn && thread.status === "active" && percentRate > 0
      ? 1 / percentRate
      : null;
    const latestRate = thread.status === "active"
      ? recentRate ?? turnAverage
      : thread.status === "idle" ? turnAverage : null;
    const futureRate = thread.status === "active" ? latestRate : null;
    const latestRateSource = recentRate !== null
      ? "recent-token-calibrated"
      : latestRate !== null
        ? thread.status === "active"
          ? "turn-average-fallback"
          : "turn-completed-fallback"
        : null;
    return {
      id: thread.id,
      title: thread.title || thread.id,
      model: thread.model,
      reasoningEffort: thread.reasoningEffort,
      status: thread.status,
      parentThreadId: thread.parentThreadId || null,
      childCount: 0,
      elapsedSeconds: safeDuration(thread, now, cutoff),
      estimatedPercent: estimate,
      totalElapsedSeconds: totalSeconds,
      totalEstimatedPercent: estimate,
      estimateCoverage: covered ? allocation.coverage : "unsupported",
      estimateSource: estimate === null ? null : allocation.source,
      estimateEstimated: estimate !== null,
      latestTurnElapsedSeconds: latestSeconds,
      latestTurnStartedAt: [thread.startedAt, latest?.startedAt]
        .filter((at) => Number.isFinite(at) && at <= now)
        .reduce((value, at) => value === null ? at : Math.max(value, at), null)
        ?? latestTurnInterval(thread, now)?.[0] ?? null,
      latestTurnStatus: thread.status,
      latestTurnChildCount: 0,
      latestTurnEstimatedPercent: covered && latestAllocation.hasEvent
        ? latestAllocation.value : null,
      latestTurnEstimateSource: latestAllocation.hasEvent
        ? latestAllocation.source : null,
      latestTurnEstimateEstimated: latestAllocation.hasEvent,
      latestTurnSecondsPerPercent: latestRate,
      latestTurnRateSource: latestRateSource,
      latestTurnRateEstimated: latestRate !== null,
      latestTurnRateObserved: false,
      latestTurnObservationSince: currentTurn ? latest.observedSince : null,
      latestTurnLastAttachedAt: currentTurn ? latest.lastAttachedAt || latest.observedSince : null,
      latestTurnCoverage: currentTurn
        ? latest.recovered ? "partial-after-restart" : "monitoring-partial"
        : "unavailable",
      totalDurationCoverage: thread.executionHistory?.coverage || "partial",
      secondsPerPercent: futureRate,
      rateSource: futureRate === null ? null : latestRateSource,
      rateEstimated: futureRate !== null,
      rateObserved: false,
      averageSecondsPerPercent: average,
      observationSeconds: observedSeconds,
      estimateStatus: estimate === null
        ? "unavailable"
        : latestAllocation.provisional > 0 || allocation.provisional > 0
          ? "provisional"
          : "allocated",
      rateStatus:
        thread.status === "active"
          ? recentRate
            ? "recent-estimate"
            : turnAverage
              ? "turn-average-estimate"
            : "no-recent-sample"
          : average
            ? "observed-average"
            : latestRate
              ? "turn-completed-fallback"
            : "no-timed-sample",
      observationSince: this.observationSince(now),
      confidence: "低：本机归因假设",
      method:
        "按监控期间本机 token 增量分摊账户变化；不同模型权重未知，可能混入其他设备消耗",
      activityEvidence: thread.activityEvidence,
    };
  }

  allocationForTurns(thread, turns, now) {
    if (/spark/.test(thread.model || "")) return { value: 0, hasEvent: false };
    const record = this.state.latestTurns[thread.id];
    const allTurns = executionTurns(thread, now);
    const matches = (key) => turns.some((turn) => executionKeyMatches(thread, turn, key, record));
    let value = 0;
    let hasEvent = false;
    for (const raw of this.state.rollingAllocations) {
      if (raw.id !== thread.id) continue;
      const event = this.sliceAllocation(raw, now);
      if (!event) continue;
      if (event.turnKey && matches(event.turnKey) && event.turnPercent > 0) {
        value += event.turnPercent;
        hasEvent = true;
      } else if ((!event.turnKey || turns.every((turn) => !turn.turnId)) &&
          intervalContained(event, turns, allTurns)) {
        // Unkeyed legacy estimates may be included only when their complete
        // observed interval fits the selected execution, never from a lifetime total.
        value += event.percent;
        hasEvent = true;
      }
    }
    const bucket = this.state.pendingTurns[thread.id];
    let pending = 0;
    if (intervalContained(this.state.pendingRanges[thread.id], turns, allTurns))
      pending = this.state.pending[thread.id] || 0;
    else if (bucket?.key && matches(bucket.key)) pending = bucket.tokens || 0;
    const calibration = this.rollingCalibration(now);
    if (pending > 0 && calibration.tokens > 0 && calibration.percent > 0) {
      value += pending * calibration.percent / calibration.tokens;
      hasEvent = true;
    }
    return { value, hasEvent };
  }

  latestFamily(thread, members, ownRows, now) {
    const own = ownRows.get(thread.id);
    const base = {
      ownLatestTurnElapsedSeconds: own.latestTurnElapsedSeconds,
      ownLatestTurnEstimatedPercent: own.latestTurnEstimatedPercent,
      ownLatestTurnSecondsPerPercent: own.latestTurnSecondsPerPercent,
      latestTurnStartedAt: own.latestTurnStartedAt,
      latestTurnElapsedSeconds: own.latestTurnElapsedSeconds,
      latestTurnEstimatedPercent: own.latestTurnEstimatedPercent,
      latestTurnSecondsPerPercent: own.latestTurnSecondsPerPercent,
      latestTurnRateSource: own.latestTurnRateSource,
      latestTurnRateEstimated: own.latestTurnRateEstimated,
      latestTurnEstimateSource: own.latestTurnEstimateSource,
      latestTurnEstimateEstimated: own.latestTurnEstimateEstimated,
      latestTurnStatus: own.status,
      latestTurnChildCount: 0,
    };
    const record = this.state.latestTurns[thread.id];
    if (thread.status === "unknown" || (record && !sameTurn(record, turnIdentity(thread))))
      return { ...base, latestTurnChildCount: null };
    const current = executionTurns(thread, now).find((turn) => turn.current);
    if (!current || !Number.isFinite(current.endAt))
      return { ...base, latestTurnChildCount: null };
    const selected = new Map([[thread.id, [current]]]);
    const byId = new Map(members.map((member) => [member.id, member]));
    const pending = [thread.id];
    while (pending.length) {
      const parentId = pending.shift();
      const parentTurns = selected.get(parentId);
      for (const child of members) {
        if (child.parentThreadId !== parentId || selected.has(child.id)) continue;
        const turns = executionTurns(child, now).filter((turn) =>
          parentTurns.some((parent) => Number.isFinite(parent.endAt) &&
            turn.startedAt >= parent.startedAt &&
            (parent.active ? turn.startedAt <= parent.endAt : turn.startedAt < parent.endAt)));
        if (turns.length) {
          selected.set(child.id, turns);
          pending.push(child.id);
        }
      }
    }
    if (selected.size === 1) return base;
    const intervals = [];
    let value = own.latestTurnEstimatedPercent || 0;
    let hasQuota = own.latestTurnEstimatedPercent !== null;
    let partial = !hasQuota;
    let uncertain = false;
    const activeRows = [];
    for (const [id, turns] of selected) {
      const member = byId.get(id);
      const row = ownRows.get(id);
      for (const turn of turns) {
        const interval = clipInterval(turn.interval, this.cutoffAt(now), now);
        if (interval) intervals.push(interval);
        if (!Number.isFinite(turn.endAt) || (turn.current && row.status === "unknown")) uncertain = true;
      }
      if (id !== thread.id) {
        const quota = this.allocationForTurns(member, turns, now);
        value += quota.value;
        hasQuota ||= quota.hasEvent;
        partial ||= !quota.hasEvent;
      }
      if (turns.some((turn) => turn.active)) activeRows.push(row);
    }
    const elapsed = intervals.length ? mergeDuration(intervals) : null;
    const average = elapsed > 0 && value > 0 ? elapsed / value : null;
    const calibration = this.rollingCalibration(now);
    const recent = activeRows.map((row) => /spark/.test(row.model || "")
      ? null : this.recentTokenRate(row.id, now, true));
    const recentTokens = recent.reduce((sum, rate) => sum + (rate || 0), 0);
    const recentRate = recent.length && recent.every(Number.isFinite) && recentTokens > 0 &&
      calibration.tokens > 0 && calibration.percent > 0
      ? calibration.tokens / (recentTokens * calibration.percent) : null;
    const active = activeRows.length > 0;
    const prediction = active ? recentRate ?? average : uncertain ? null : average;
    return {
      ...base,
      latestTurnChildCount: selected.size - 1,
      latestTurnElapsedSeconds: elapsed,
      latestTurnEstimatedPercent: hasQuota ? value : null,
      latestTurnSecondsPerPercent: prediction,
      latestTurnStatus: active ? "active" : uncertain ? "unknown" : "idle",
      latestTurnRateSource: prediction === null ? null : recentRate !== null
        ? "family-recent-token-calibrated" : active
          ? "family-turn-average-fallback" : "family-turn-completed-fallback",
      latestTurnRateEstimated: prediction !== null,
      latestTurnEstimateSource: hasQuota ? "family-execution-estimate" : null,
      latestTurnEstimateEstimated: hasQuota,
      latestTurnCoverage: partial || uncertain ? "family-partial" : "family-observed",
    };
  }

  threadInWindow(thread, now) {
    if (thread.status === "active") return true;
    const cutoff = this.cutoffAt(now);
    if (executionIntervals(thread, now, true, cutoff).length) return true;
    if (this.rollingAllocation(thread.id, now).hasEvent) return true;
    if (this.rollingObservationSeconds(thread.id, now) > 0) return true;
    if (Number.isFinite(this.state.pending[thread.id]) && this.state.pending[thread.id] > 0)
      return true;
    return [thread.completedAt, thread.updatedAt, thread.startedAt]
      .some((value) => Number.isFinite(value) && value >= cutoff && value <= now);
  }

  sessions(threads, now) {
    const s = this.state;
    this.migrateLegacyAggregate(now, threads);
    this.rollingWindowStarted(now);
    this.pruneRolling(now);
    const groups = groupThreads(threads).flatMap((group) => {
      const relevant = group.members.filter((member) => this.threadInWindow(member, now));
      if (!relevant.length) return [];
      const root = group.members.find((member) => member.id === group.id);
      const members = root && !relevant.some((member) => member.id === root.id)
        ? [root, ...relevant] : relevant;
      return [{
        ...group,
        members,
        childCount: members.length - 1,
        status: members.some((member) => member.status === "active")
          ? "active"
          : members.some((member) => member.status === "unknown")
            ? "unknown" : "idle",
      }];
    });
    this.refreshGroupObservationCache(
      groups.flatMap((group) => group.members), now,
    );
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
    const startOf = (thread) => [thread.latestTurnStartedAt, thread.startedAt, s.latestTurns[thread.id]?.startedAt]
      .filter((at) => Number.isFinite(at) && at <= now)
      .reduce((latest, at) => Math.max(latest, at), -Infinity);
    const compare = (a, b) => {
      const first = startOf(a), second = startOf(b);
      return first === second ? orderOf(a) - orderOf(b) : second > first ? 1 : -1;
    };
    return groups.map((group) => {
      const members = group.members.slice().sort(compare);
      const ownRows = new Map(members.map((thread) => [thread.id, this.individual(thread, now)]));
      const rows = new Map();
      for (const thread of members) {
        const ids = new Set([thread.id]);
        const queue = [thread.id];
        while (queue.length) {
          const parent = queue.shift();
          for (const child of members) {
            if (child.parentThreadId === parent && !ids.has(child.id)) {
              ids.add(child.id);
              queue.push(child.id);
            }
          }
        }
        const subtree = members.filter((member) => ids.has(member.id));
        const own = ownRows.get(thread.id);
        const contributions = subtree.map((member) => ownRows.get(member.id));
        const known = contributions.some((row) => row.estimatedPercent !== null);
        const estimated = known
          ? contributions.reduce((sum, row) => sum + (row.estimatedPercent || 0), 0) : null;
        const rate = contributions.filter((row) => row.status === "active" && row.secondsPerPercent > 0)
          .reduce((sum, row) => sum + 1 / row.secondsPerPercent, 0);
        const status = subtree.some((member) => member.status === "active") ? "active"
          : subtree.some((member) => member.status === "unknown") ? "unknown" : "idle";
        const sourceIntervals = subtree.flatMap((member) => executionIntervals(
          member, now, !s.latestTurns[member.id] || sameTurn(s.latestTurns[member.id], turnIdentity(member)),
          this.cutoffAt(now),
        ));
        const observedIntervals = this.rollingObservationIntervals([...ids], now);
        const durationIntervals = [...sourceIntervals, ...observedIntervals];
        const totalElapsedSeconds = durationIntervals.length ? mergeDuration(durationIntervals) : null;
        const starts = subtree.filter((member) => member.status === "active" && Number.isFinite(member.startedAt))
          .map((member) => Math.max(this.cutoffAt(now), member.startedAt));
        const coverages = new Set(contributions.map((row) => row.estimateCoverage));
        const sources = [...new Set(contributions.map((row) => row.estimateSource).filter(Boolean))];
        const provisional = contributions.some((row) => row.estimateStatus === "provisional");
        rows.set(thread.id, {
          ...own,
          status,
          childCount: subtree.length - 1,
          children: [],
          elapsedSeconds: starts.length ? Math.max(0, (now - Math.min(...starts)) / 1000)
            : safeDuration(thread, now, this.cutoffAt(now)),
          estimatedPercent: estimated,
          totalEstimatedPercent: estimated,
          totalElapsedSeconds,
          totalDurationCoverage: subtree.every((member) => member.executionHistory?.coverage === "local-records")
            ? "local-records" : "partial",
          averageSecondsPerPercent: estimated > 0 && totalElapsedSeconds > 0
            ? totalElapsedSeconds / estimated : null,
          secondsPerPercent: status === "active" && rate > 0 ? 1 / rate : null,
          rateSource: status === "active" && rate > 0 ? "aggregate-active-task-rates" : null,
          rateEstimated: status === "active" && rate > 0,
          rateObserved: false,
          observationSeconds: this.rollingObservationForThreads([...ids], now),
          estimateCoverage: coverages.size === 1 ? contributions[0]?.estimateCoverage || "none" : "mixed",
          estimateSource: sources.length === 1 ? sources[0] : sources.length ? "mixed" : null,
          estimateEstimated: estimated !== null,
          estimateStatus: known ? provisional ? "provisional" : "allocated" : "unavailable",
          rateStatus: status === "active" ? rate > 0 ? "recent-estimate" : "no-recent-sample"
            : estimated > 0 && totalElapsedSeconds > 0 ? "observed-average" : "no-timed-sample",
          ownStatus: own.status,
          ownEstimatedPercent: own.estimatedPercent,
          ownSecondsPerPercent: own.secondsPerPercent,
          ownAverageSecondsPerPercent: own.averageSecondsPerPercent,
          ownObservationSeconds: own.observationSeconds,
          ownEstimateSource: own.estimateSource,
          ...this.latestFamily(thread, members, ownRows, now),
        });
      }
      const root = rows.get(group.id);
      root.children = [...rows.values()].filter((row) => row.id !== group.id).sort(compare);
      return root;
    }).sort(compare);

  }
}
