import { Estimator, normalizeQuotaHistory, normalizeRetentionHours } from './metrics.mjs';
import { COST_RATE_VERSION, tokenUsage, usageCredits } from './usage-cost.mjs';

const MAX_SEGMENTS = 200;
const MAX_POINTS = 64;
const HOUR = 3_600_000;
const array = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const finite = Number.isFinite;
const positive = value => finite(value) && value > 0;
const text = value => typeof value === 'string' && value ? value : null;
const close = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const sum = (values, key) => values.reduce((total, value) => total + value[key], 0);

function balancedAmounts(events) {
  const observedPercent = sum(events, 'percent');
  let estimatedPercent = sum(events, 'attributedPercent');
  let unattributedPercent = sum(events, 'unattributedPercent');
  const residual = observedPercent - estimatedPercent - unattributedPercent;
  if (close(residual, 0)) {
    if (unattributedPercent + residual >= 0) unattributedPercent += residual;
    else if (estimatedPercent + residual >= 0) estimatedPercent += residual;
  }
  return { observedPercent, estimatedPercent, attributedPercent: estimatedPercent, unattributedPercent };
}

// Project only observation fields into an isolated estimator. This reuses its
// valid-suffix/retention rules without changing the live state, recovering
// allocations, reading local records, or running a new calibration.
function attributionFor(state, now, events = state.rollingQuotaEvents, cutoff) {
  const reader = new Estimator({
    retentionHours: normalizeRetentionHours(state.retentionHours),
    rollingStartedAt: state.rollingStartedAt,
    sessionTrackingSince: [state.sessionTrackingSince, state.trackingSince, state.since].find(finite) ?? now,
    rollingQuotaEvents: array(events).map(event => event && typeof event === 'object' ? { ...event } : event),
  });
  return reader.rollingAttribution(now, cutoff);
}

function attributionScopes(state, now, supplied, history) {
  const provided = object(supplied);
  const attribution = Array.isArray(provided.events)
    ? { ...attributionFor(state, now, provided.events), ...provided }
    : attributionFor(state, now);
  // Supplied events normally come straight from rollingAttribution. Validate
  // them again rather than allowing a malformed optional argument into JSON.
  const checked = attributionFor(state, now, attribution.events);
  const events = checked.events;
  const historyScope = {
    ...balancedAmounts(events), since: finite(attribution.since) ? attribution.since : checked.since,
    until: now, sampleCount: events.length, coverage: events.length ? 'rolling' : 'none',
    excludedIncompleteHistory: Boolean(attribution.excludedIncompleteHistory || checked.excludedIncompleteHistory),
    startReason: text(attribution.startReason) || checked.startReason,
    startKnown: false, scope: 'retained-history',
  };
  const identity = text(state.previous?.identity);
  const persistedStart = finite(state.currentQuotaStartedAt) && state.currentQuotaStartedAt <= now
    ? state.currentQuotaStartedAt : null;
  const resetAt = history.findLast(point => point.reset &&
    (!point.quotaIdentity || point.quotaIdentity === identity))?.at ?? null;
  const periodStartedAt = persistedStart ?? resetAt;
  const periodEvents = identity ? events.filter(event => event.quotaIdentity === identity) : [];
  const current = attributionFor(state, now, periodEvents, periodStartedAt ?? undefined);
  const startKnown = persistedStart !== null ? state.currentQuotaStartKnown !== false : resetAt !== null;
  const currentScope = {
    ...balancedAmounts(current.events),
    since: current.events.length ? current.since
      : Math.max(historyScope.since, periodStartedAt ?? history[0]?.at ?? now),
    until: now, sampleCount: current.events.length,
    coverage: current.events.length ? 'rolling' : 'none',
    quotaIdentity: identity, periodStartedAt, startKnown,
    startReason: !identity ? 'waiting-for-quota-identity'
      : !startKnown ? 'observed-start'
        : persistedStart !== null ? 'known-period-start' : 'observed-reset',
    excludedIncompleteHistory: historyScope.excludedIncompleteHistory,
    partial: !identity || !startKnown || historyScope.excludedIncompleteHistory ||
      (periodStartedAt !== null && now - normalizeRetentionHours(state.retentionHours) * HOUR > periodStartedAt),
    scope: 'current-quota-period',
  };
  return { events, scopes: { history: historyScope, current: currentScope } };
}

function sessionIndex(sessions) {
  const rows = new Map();
  const parents = new Map();
  const pending = array(sessions).map(row => [row, null]);
  const expanded = new Set();
  while (pending.length) {
    const [candidate, parent] = pending.pop();
    const row = object(candidate);
    const id = text(row.id);
    if (!id) continue;
    if (!rows.has(id)) rows.set(id, row);
    const parentId = text(row.parentThreadId) || parent;
    if (parentId && parentId !== id && !parents.has(id)) parents.set(id, parentId);
    if (expanded.has(id)) continue;
    expanded.add(id);
    for (const child of array(row.children)) pending.push([child, id]);
  }
  const children = new Map();
  for (const [id, parent] of parents) {
    const ids = children.get(parent) || [];
    ids.push(id); children.set(parent, ids);
  }
  return { rows, children };
}

function turnCost(turn, calibration, accountStart) {
  if (!positive(calibration?.percentPerCredit) || turn.startedAt < accountStart ||
      turn.costRateVersion !== COST_RATE_VERSION || !positive(turn.costCredits) || !positive(turn.costTokens)) return null;
  const usage = tokenUsage(turn.tokenUsage);
  let credits = turn.costCredits;
  let partial = turn.costCoverage !== 'recorded-turn' || !usage;
  if (turn.tokenUsage != null) {
    if (!usage || turn.costTokens < usage.totalTokens) return null;
    if (turn.costCoverage === 'recorded-turn') {
      const computed = usageCredits(usage, turn.model, turn.serviceTier);
      // A last-known model cannot reprice a mixed or inconsistent execution.
      if (!finite(computed) || !close(computed, credits)) return null;
      credits = computed;
      partial = false;
    }
  }
  const amount = credits * calibration.percentPerCredit;
  return positive(amount) ? { amount, partial } : null;
}

function threadRecords(id, row, state, allocations, now, calibration) {
  const known = object(state.knownThreads?.[id]);
  const title = text(row.title) || text(known.title) || id;
  const accountStart = finite(state.costAccountStart) ? state.costAccountStart : -Infinity;
  const turns = new Map();
  let partial = false;
  const addTurn = (raw, usage = false) => {
    const turn = object(raw);
    if (!finite(turn.startedAt) || turn.startedAt > now ||
        (finite(turn.completedAt) && turn.completedAt < turn.startedAt)) {
      partial = true; return;
    }
    const turnId = text(turn.turnId);
    const key = turnId ? `id:${turnId}` : `at:${turn.startedAt}`;
    const old = turns.get(key);
    // Lifecycle projections can fill completion timestamps but cannot erase a
    // turn's recorded model/token costs.
    const merged = usage ? { ...old?.turn, ...turn } : { ...turn, ...old?.turn };
    if (!finite(merged.completedAt) && finite(turn.completedAt)) merged.completedAt = turn.completedAt;
    turns.set(key, { ...old, turn: { ...merged, turnId }, allocated: old?.allocated || 0,
      observedUntil: old?.observedUntil ?? null, synthetic: old?.synthetic || false });
  };
  for (const turn of array(known.executionHistory?.turns)) addTurn(turn);
  for (const turn of array(known.usageTurns)) addTurn(turn, true);
  const latest = object(state.latestTurns?.[id]);
  const currentStart = finite(known.startedAt) ? known.startedAt
    : finite(latest.startedAt) ? latest.startedAt : row.latestTurnStartedAt;
  const currentId = text(known.activityEvidence?.turnId) || text(latest.turnId);
  if (finite(currentStart) && ![...turns.values()].some(record =>
    currentId ? record.turn.turnId === currentId : record.turn.startedAt === currentStart)) {
    addTurn({ turnId: currentId, startedAt: currentStart,
      completedAt: known.completedAt ?? latest.completedAt });
  }
  const ownStatus = row.ownStatus || known.status || row.status;
  const endpoint = record => record.synthetic ? record.observedUntil
    : finite(record.turn.completedAt) ? Math.min(now, record.turn.completedAt)
    : ownStatus === 'active' && record.turn.startedAt === currentStart ? now
      : finite(known.lastMetadataAt) && known.lastMetadataAt >= record.turn.startedAt ? Math.min(now, known.lastMetadataAt) : null;
  const byTurnIdentity = new Map();
  const indexTurn = record => {
    const key = String(record.turn.turnId || record.turn.startedAt);
    const matches = byTurnIdentity.get(key) || [];
    matches.push(record); byTurnIdentity.set(key, matches);
  };
  for (const record of turns.values()) {
    record.cost = turnCost(record.turn, calibration, accountStart);
    indexTurn(record);
  }
  const keyedTurns = key => {
    if (typeof key !== 'string' || !key.startsWith(`${id}:`)) return [];
    const suffix = key.slice(id.length + 1);
    const identities = [suffix, suffix.slice(suffix.indexOf(':') + 1)];
    return [...new Set(identities.flatMap(value => byTurnIdentity.get(value) || []))];
  };

  for (const allocation of allocations) {
    if (!positive(allocation?.percent) || !finite(allocation.at) || allocation.at > now || allocation.at < accountStart) {
      partial = true; continue;
    }
    const hasRange = finite(allocation.startAt) && finite(allocation.endAt) && allocation.endAt > allocation.startAt;
    let candidates = keyedTurns(allocation.turnKey);
    if (!allocation.turnKey && hasRange) candidates = [...turns.values()].filter(record =>
      record.turn.startedAt <= allocation.startAt && endpoint(record) !== null && endpoint(record) >= allocation.endAt);
    if (candidates.length === 1 && candidates[0].cost) continue;
    // Older task-wide records sometimes retained a turn key without a share.
    // The key alone must not promote the whole task amount to that execution.
    if (allocation.turnKey && !positive(allocation.turnPercent)) { partial = true; continue; }
    if (!candidates.length && text(allocation.turnKey) && allocation.turnKey.startsWith(`${id}:`) && hasRange) {
      const key = `allocation:${allocation.turnKey}`;
      const record = turns.get(key) || {
        turn: { turnId: allocation.turnKey.slice(id.length + 1).replace(/^[^:]*:/, ''),
          startedAt: allocation.startAt, completedAt: null },
        allocated: 0, observedUntil: allocation.endAt, synthetic: true,
      };
      record.turn.startedAt = Math.min(record.turn.startedAt, allocation.startAt);
      turns.set(key, record);
      indexTurn(record);
      candidates = [record];
    }
    if (candidates.length !== 1) { partial = true; continue; }
    const record = candidates[0];
    if (record.synthetic && hasRange)
      record.turn.startedAt = Math.min(record.turn.startedAt, allocation.startAt);
    const amount = allocation.turnKey ? Math.min(allocation.percent, allocation.turnPercent) : allocation.percent;
    record.allocated += amount;
    record.observedUntil = Math.max(record.observedUntil ?? -Infinity,
      hasRange ? Math.min(now, allocation.endAt) : allocation.at);
  }

  const records = [];
  for (const record of turns.values()) {
    const turn = record.turn;
    const cost = record.cost;
    const amount = cost?.amount ?? (positive(record.allocated) ? record.allocated : null);
    if (amount === null) { partial = true; continue; }
    const endAt = endpoint(record) ?? record.observedUntil;
    if (!finite(endAt) || endAt < turn.startedAt) { partial = true; continue; }
    const completedAt = finite(turn.completedAt) && turn.completedAt <= now ? turn.completedAt : null;
    const active = ownStatus === 'active' && turn.startedAt === currentStart;
    const durationKnown = !record.synthetic && (completedAt !== null || active);
    records.push({
      id: `${id}:${turn.turnId || turn.startedAt}`, turnId: turn.turnId,
      taskId: id, title, startedAt: turn.startedAt, completedAt, endAt,
      elapsedSeconds: durationKnown ? (endAt - turn.startedAt) / 1000 : null,
      amount, source: cost ? 'model-token-cost-calibrated' : 'timestamped-allocations',
      partial: cost ? cost.partial || !durationKnown || completedAt === null : true,
      model: text(turn.model), reasoningEffort: text(turn.reasoningEffort),
    });
  }
  return { records, partial };
}

function pointsWithin(timeline, startedAt, endAt) {
  const boundary = (at, after = false) => {
    let left = 0, right = timeline.length;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (timeline[middle].at < at || (after && timeline[middle].at === at)) left = middle + 1;
      else right = middle;
    }
    return left;
  };
  const first = boundary(startedAt), last = boundary(endAt, true);
  const count = last - first;
  return { clipped: count > MAX_POINTS,
    points: count <= MAX_POINTS ? timeline.slice(first, last)
      : Array.from({ length: MAX_POINTS }, (_, index) =>
        timeline[first + Math.round(index * (count - 1) / (MAX_POINTS - 1))]) };
}

/**
 * Add a cumulative time axis to independently estimated executions. Values are
 * the sum of each execution's linear progress, including concurrent children.
 * They are interpolated estimates, never a per-second account meter.
 *
 * `endAt` is the observed endpoint for an unfinished execution; `completedAt`
 * remains null. Omitted older segments still contribute to the visible baseline.
 */
export function buildSessionSegments(records, { unit = 'percent', now, partial = false } = {}) {
  const unique = new Map();
  for (const raw of array(records)) {
    const record = object(raw);
    const recordedEnd = finite(record.endAt) ? record.endAt : finite(record.completedAt) ? record.completedAt : now;
    const endAt = finite(now) && finite(recordedEnd) ? Math.min(now, recordedEnd) : recordedEnd;
    if (!finite(record.startedAt) || !finite(endAt) || endAt < record.startedAt ||
        !finite(record.amount) || record.amount < 0) { partial = true; continue; }
    const id = text(record.id) || `${record.taskId || 'task'}:${record.turnId || record.startedAt}`;
    if (unique.has(id)) continue;
    const elapsedSeconds = Object.hasOwn(record, 'elapsedSeconds')
      ? finite(record.elapsedSeconds) && record.elapsedSeconds >= 0 ? record.elapsedSeconds : null
      : (endAt - record.startedAt) / 1000;
    let runningIntervals;
    if (Array.isArray(record.runningIntervals)) {
      runningIntervals = [];
      for (const span of record.runningIntervals.filter(span => Array.isArray(span) && finite(span[0]) && finite(span[1]))
        .map(([a,b]) => [Math.max(a,record.startedAt),Math.min(b,endAt)])
        .filter(([a,b]) => b >= a).sort((a,b) => a[0]-b[0])) {
        const previous = runningIntervals.at(-1);
        if (previous && span[0] <= previous[1]) previous[1] = Math.max(previous[1],span[1]);
        else runningIntervals.push(span);
      }
      if (!runningIntervals.length) { partial = true; continue; }
    }
    unique.set(id, { ...record, id, endAt, elapsedSeconds,
      ...(runningIntervals ? { runningIntervals } : {}),
      completedAt: finite(record.completedAt) && record.completedAt <= endAt ? record.completedAt : null });
  }
  const all = [...unique.values()].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  const kept = all.slice(-MAX_SEGMENTS);
  const spansFor = record => record.runningIntervals || [[record.startedAt, record.endAt]];
  const times = [...new Set(all.flatMap(record => [record.startedAt, record.endAt, ...spansFor(record).flat()]))].sort((a, b) => a - b);
  const changes = new Map();
  for (const record of all) {
    const spans = spansFor(record), runningMs = spans.reduce((total,[a,b]) => total+b-a,0);
    if (runningMs === 0) continue;
    const slope = record.amount / runningMs;
    for (const [a,b] of spans) {
      changes.set(a, (changes.get(a) || 0) + slope);
      changes.set(b, (changes.get(b) || 0) - slope);
    }
  }
  const jumps = new Map();
  for (const record of all.filter(record => spansFor(record).every(([a,b]) => a===b)))
    jumps.set(record.startedAt, (jumps.get(record.startedAt) || 0) + record.amount);
  let value = 0, slope = 0, previousAt = times[0];
  const timeline = times.map(at => {
    value += Math.max(0, slope) * (at - previousAt) + (jumps.get(at) || 0);
    slope += changes.get(at) || 0;
    previousAt = at;
    return { at, value };
  });
  if (timeline.length) timeline.at(-1).value = sum(all, 'amount');
  const segments = kept.map(record => {
    const selected = pointsWithin(timeline, record.startedAt, record.endAt);
    const ratio = positive(record.amount) && positive(record.elapsedSeconds) ? record.elapsedSeconds / record.amount : null;
    const segmentPartial = Boolean(record.partial || selected.clipped);
    partial ||= segmentPartial;
    return {
      ...record, completedAt: finite(record.completedAt) ? record.completedAt : null,
      secondsPerUnit: ratio, secondsPerPercent: unit === 'percent' ? ratio : null,
      estimated: true, interpolation: 'linear-per-execution', partial: segmentPartial,
      points: selected.points.map(point => ({ ...point })),
    };
  });
  return { unit, segments, partial: partial || kept.length < all.length,
    estimated: true, interpolation: 'linear-per-execution',
    omittedTurnCount: all.length - kept.length, totalAmount: sum(all, 'amount'),
    since: kept[0]?.startedAt ?? null, until: timeline.at(-1)?.at ?? null };
}

function taskCharts(state, sessions, now, calibration) {
  const { rows, children } = sessionIndex(sessions);
  const allocations = new Map();
  for (const event of array(state.rollingAllocations)) {
    const id = text(event?.id);
    if (!id) continue;
    const records = allocations.get(id) || [];
    records.push(event); allocations.set(id, records);
  }
  const own = new Map([...rows].map(([id, row]) =>
    [id, threadRecords(id, row, state, allocations.get(id) || [], now, calibration)]));
  const charts = [];
  for (const id of rows.keys()) {
    const ids = new Set([id]);
    const pending = [id];
    while (pending.length) for (const child of children.get(pending.pop()) || []) {
      if (ids.has(child)) continue;
      ids.add(child); pending.push(child);
    }
    const members = [...ids].map(member => own.get(member)).filter(Boolean);
    charts.push([id, buildSessionSegments(members.flatMap(member => member.records), {
      now, partial: members.some(member => member.partial),
    })]);
  }
  return { charts: Object.fromEntries(charts), rows };
}

function contributorsFor(delta, events, linked, rows, knownThreads) {
  if (!(delta > 0)) return { contributors: [], partial: false };
  const recorded = sum(events, 'percent');
  const sampleScale = recorded > delta ? delta / recorded : 1;
  const amounts = new Map();
  let partial = !close(recorded, delta);
  for (const event of events) {
    const allocations = (linked.get(event.id) || []).filter(allocation =>
      text(allocation.id) && positive(allocation.percent) && allocation.at === event.at &&
      (!event.quotaIdentity || allocation.quotaIdentity === event.quotaIdentity));
    const allocated = sum(allocations, 'percent');
    partial ||= !close(allocated, event.attributedPercent);
    const scale = allocated > 0 ? Math.min(1, event.attributedPercent / allocated) * sampleScale : 0;
    for (const allocation of allocations)
      amounts.set(allocation.id, (amounts.get(allocation.id) || 0) + allocation.percent * scale);
  }
  const contributors = [...amounts].filter(([, percent]) => percent > 0).map(([id, percent]) => ({
    id, title: text(rows.get(id)?.title) || text(knownThreads[id]?.title) || id,
    percent, sharePercent: percent / delta * 100, kind: 'task',
  })).sort((a, b) => b.percent - a.percent || a.id.localeCompare(b.id));
  const known = sum(contributors, 'percent');
  contributors.push({ id: '__unattributed__', title: '未归因',
    percent: Math.max(0, delta - known), sharePercent: Math.max(0, 100 - sum(contributors, 'sharePercent')),
    kind: 'unattributed' });
  return { contributors, partial };
}

function quotaTrend(state, history, events, rows, now) {
  const byTime = new Map();
  const linked = new Map();
  for (const event of events) {
    const group = byTime.get(event.at) || [];
    group.push(event); byTime.set(event.at, group);
  }
  for (const event of array(state.rollingAllocations)) {
    if (!text(event?.attributionEventId)) continue;
    const group = linked.get(event.attributionEventId) || [];
    group.push(event); linked.set(event.attributionEventId, group);
  }
  const ordered = [...events].sort((a, b) => a.at - b.at);
  // Polling produces long identical plateaus. Retain their endpoints and every
  // changed sample, linked event, reset, and identity boundary. No consumption
  // point or contributor drilldown is lost when unchanged polls are omitted.
  const retained = new Set(history.length ? [0, history.length - 1] : []);
  for (let index = 0; index < history.length; index++) {
    const sample = history[index], previous = history[index - 1];
    if (sample.reset || byTime.has(sample.at) || (previous &&
        (sample.remainingPercent !== previous.remainingPercent || sample.quotaIdentity !== previous.quotaIdentity))) {
      retained.add(index);
      if (index > 0) retained.add(index - 1);
    }
  }
  const samples = history.filter((_, index) => retained.has(index));
  let cursor = 0, observed = 0, estimated = 0, cycle = 0;
  const points = samples.map((sample, index) => {
    while (cursor < ordered.length && ordered[cursor].at <= sample.at) {
      observed += ordered[cursor].percent;
      estimated += ordered[cursor].attributedPercent;
      cursor++;
    }
    const previous = samples[index - 1];
    const reset = Boolean(sample.reset || (previous && (sample.remainingPercent > previous.remainingPercent ||
      (previous.quotaIdentity && sample.quotaIdentity && previous.quotaIdentity !== sample.quotaIdentity))));
    if (reset) cycle++;
    const matched = byTime.get(sample.at) || [];
    const deltaPercent = reset ? 0 : previous
      ? Math.max(0, previous.remainingPercent - sample.remainingPercent) : sum(matched, 'percent');
    const drilldown = contributorsFor(deltaPercent, reset ? [] : matched, linked, rows, object(state.knownThreads));
    return { id: `quota-sample:${sample.at}`, at: sample.at, remainingPercent: sample.remainingPercent,
      cumulativePercent: observed, estimatedPercent: Math.min(observed, estimated),
      unattributedPercent: Math.max(0, observed - estimated), reset, cycle, breakBefore: reset,
      deltaPercent, contributors: drilldown.contributors,
      attributionCoverage: matched.length ? 'official-quota-sample' : 'none',
      partial: drilldown.partial || (matched.length > 0 && !close(sum(matched, 'percent'), deltaPercent)),
    };
  });
  return { points, since: points[0]?.at ?? null, until: points.at(-1)?.at ?? null,
    observedUntil: now, cumulativeSince: events[0]?.startAt ?? events[0]?.at ?? null,
    sampleCount: history.length, omittedUnchangedSampleCount: history.length - points.length,
    source: 'official-quota-samples', defaultView: 'remaining',
    partial: points.some(point => point.partial) || (events.length > 0 && cursor < events.length) };
}

/** Build serializable chart data without changing estimator or session state. */
export function buildChartData({ state: rawState, sessions, now: suppliedNow, calibration, attribution } = {}) {
  const state = object(rawState);
  const now = finite(suppliedNow) ? suppliedNow : 0;
  const history = normalizeQuotaHistory(state.history, now - normalizeRetentionHours(state.retentionHours) * HOUR, now);
  const scoped = attributionScopes(state, now, attribution, history);
  const tasks = taskCharts(state, sessions, now, calibration);
  return { sessionCharts: tasks.charts, attributionScopes: scoped.scopes,
    quotaTrend: quotaTrend(state, history, scoped.events, tasks.rows, now) };
}
