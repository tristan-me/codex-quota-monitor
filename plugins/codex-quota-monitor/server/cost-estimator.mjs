import { COST_RATE_VERSION } from './usage-cost.mjs';

const turnMatches = (turn, key) => typeof key === 'string' &&
  (turn.turnId ? key.endsWith(`:${turn.turnId}`) : key.endsWith(`:${turn.startedAt}`));
const bounds = (turn, now) => [turn.startedAt,
  Number.isFinite(turn.completedAt) ? turn.completedAt : now];
const validTurn = turn => turn?.costRateVersion === COST_RATE_VERSION &&
  Number.isFinite(turn.costCredits) && turn.costCredits > 0 &&
  Number.isFinite(turn.costTokens) && turn.costTokens > 0;

export function allocationCredits(event, thread, now) {
  if (event.costRateVersion === COST_RATE_VERSION && event.costCredits > 0)
    return event.costCredits;
  if (!(event.tokens > 0)) return null;
  const turns = thread?.usageTurns || [];
  let matched = event.turnKey ? turns.filter(t => turnMatches(t, event.turnKey)) : [];
  if (!matched.length && Number.isFinite(event.startAt) && Number.isFinite(event.endAt)) {
    matched = turns.filter(t => {
      const [start, end] = bounds(t, now);
      return Number.isFinite(start) && start < event.endAt && end > event.startAt;
    });
    // Unknown intervening execution records must not silently borrow another model.
    const uncovered = (thread?.executionHistory?.turns || []).some(t =>
      t.startedAt < event.endAt && (t.completedAt ?? now) > event.startAt &&
      !matched.some(m => m.turnId ? m.turnId === t.turnId : m.startedAt === t.startedAt));
    if (uncovered) return null;
  }
  if (!matched.length || !matched.every(t => validTurn(t) &&
      (!t.tokenUsage || t.costTokens >= t.tokenUsage.totalTokens))) return null;
  const tokens = matched.reduce((sum, turn) => sum + turn.costTokens, 0);
  const credits = matched.reduce((sum, turn) => sum + turn.costCredits, 0);
  // Historical intervals lack their own input/cache/output split. Use the
  // recorded mix of their identified executions and label this as an estimate.
  return tokens > 0 ? event.tokens * credits / tokens : null;
}

export function calibrateCosts(state, now) {
  const owner = state.previous?.accountKey || state.previous?.identity?.split(':')[0];
  const cutoff = now - state.retentionHours * 3600000;
  const samples = new Map((state.costCalibrationSamples || [])
    .filter(s => s.version === COST_RATE_VERSION && s.accountUnit === state.accountUnit &&
      Number.isFinite(s.at) && s.at >= cutoff && s.at <= now &&
      Number.isFinite(s.credits) && s.credits > 0 && Number.isFinite(s.percent) && s.percent > 0)
    .map(s => [s.id, s]));
  const grouped = new Map();
  for (const event of state.rollingAllocations) {
    if (!event.attributionEventId) continue;
    const group = grouped.get(event.attributionEventId) || [];
    group.push(event); grouped.set(event.attributionEventId, group);
  }
  for (const quota of state.rollingQuotaEvents) {
    if (quota.coverage !== 'official-quota-sample' || !Number.isFinite(quota.percent) || quota.percent <= 0 ||
        !Number.isFinite(quota.at) || !Number.isFinite(quota.attributedPercent) || !(quota.attributedPercent > 0) ||
        Math.abs(quota.percent - quota.attributedPercent) > 1e-8 * Math.max(1, quota.percent) ||
        quota.unattributedPercent !== 0 || !owner ||
        !quota.quotaIdentity?.startsWith(`${owner}:`) || quota.at < cutoff || quota.at > now) continue;
    const events = grouped.get(quota.id) || [];
    if (!events.length || events.some(e => e.quotaIdentity !== quota.quotaIdentity ||
        !Number.isFinite(e.percent) || e.percent <= 0)) continue;
    const amount = events.reduce((sum, event) => sum + event.percent, 0);
    if (Math.abs(amount - quota.attributedPercent) > 1e-8 * Math.max(1, amount)) continue;
    const costs = events.map(event => allocationCredits(event, state.knownThreads[event.id], now));
    if (!costs.every(value => Number.isFinite(value) && value > 0)) continue;
    samples.set(quota.id, {
      id: quota.id, at: quota.at, accountUnit: state.accountUnit,
      credits: costs.reduce((sum, cost) => sum + cost, 0), percent: amount,
      version: COST_RATE_VERSION,
      source: events.every(e => e.costRateVersion === COST_RATE_VERSION)
        ? 'recorded-cost-increments' : 'recorded-turn-mix',
    });
  }
  state.costCalibrationSamples = [...samples.values()];
  const credits = state.costCalibrationSamples.reduce((sum, sample) => sum + sample.credits, 0);
  const percent = state.costCalibrationSamples.reduce((sum, sample) => sum + sample.percent, 0);
  return { credits, percent, sampleCount: samples.size,
    percentPerCredit: credits > 0 && percent > 0 ? percent / credits : null };
}

export function estimateKnownCost(state, threadId, now, calibration, turnKey = null, selectedTurns = null) {
  if (!(calibration?.percentPerCredit > 0)) return null;
  const known = state.knownThreads[threadId];
  const turns = (known?.usageTurns || []).filter(t => validTurn(t) &&
    t.startedAt <= now && (!Number.isFinite(state.costAccountStart) || t.startedAt >= state.costAccountStart) && (!turnKey || turnMatches(t, turnKey)) &&
    (!selectedTurns || selectedTurns.some(s => s.turnId ? s.turnId === t.turnId : s.startedAt === t.startedAt)));
  if (!turns.length) return null;
  const value = turns.reduce((sum, turn) => sum + turn.costCredits, 0) * calibration.percentPerCredit;
  const covered = event => {
    if (event.turnKey && turns.some(t => turnMatches(t, event.turnKey))) return true;
    if (!Number.isFinite(event.startAt) || !Number.isFinite(event.endAt)) return true;
    return turns.some(t => { const [start, end] = bounds(t, now);
      return start < event.endAt && end > event.startAt; });
  };
  // Retain only disjoint older observations. Ambiguous overlapping records
  // cannot be added to a reconstructed execution without double counting.
  const legacy = turnKey || selectedTurns ? [] : state.rollingAllocations.filter(e =>
    e.id === threadId && !covered(e));
  return {
    value: value + legacy.reduce((sum, e) => sum + e.percent, 0),
    hasEvent: true, confirmed: 0, provisional: 0,
    source: 'model-token-cost-calibrated', coverage: 'model-token-cost-calibrated',
    estimated: true, includesCompletionRecovery: false,
    includesLegacy: legacy.length > 0,
    partial: turns.some(t => t.costCoverage !== 'recorded-turn') || legacy.length > 0,
  };
}
