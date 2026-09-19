import { COST_RATE_VERSION, COST_RATE_SOURCE, COST_RATE_CHECKED_AT,
  tokenUsage, usageCredits } from './usage-cost.mjs';

const emptyUsage = () => ({ credits: 0, inputTokens: 0, cachedInputTokens: 0,
  outputTokens: 0, turnCount: 0 });
const add = (target, usage, credits) => {
  target.credits += credits;
  target.inputTokens += usage.inputTokens;
  target.cachedInputTokens += usage.cachedInputTokens;
  target.outputTokens += usage.outputTokens;
  target.turnCount += 1;
};

// This view deliberately keeps two scopes separate: complete execution records
// have token breakdowns; matched quota samples have independently observed %.
export function buildUsageComparison({ state, now, since }) {
  const cutoff = Math.max(Number.isFinite(since) ? since : now,
    Number.isFinite(state.costAccountStart) ? state.costAccountStart : -Infinity);
  const recorded = { ...emptyUsage(), since: cutoff, until: now,
    partialTurnCount: 0, excludedTurnCount: 0,
    scope: 'complete-turns-in-monitoring-window', modelRows: [] };
  const rows = new Map();
  for (const thread of Object.values(state.knownThreads || {})) {
    const seen = new Set();
    for (const turn of thread.usageTurns || []) {
      const key = `${turn.turnId || ''}:${turn.startedAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!(turn.startedAt <= now) || (Number.isFinite(turn.completedAt) && turn.completedAt < cutoff)) continue;
      const usage = tokenUsage(turn.tokenUsage);
      const credits = usageCredits(usage, turn.model, turn.serviceTier);
      const recordedCost = turn.costCredits;
      // A last-known model cannot reconstruct a mixed/partial execution's cost.
      const complete = turn.startedAt >= cutoff && Number.isFinite(turn.completedAt) &&
        turn.completedAt >= turn.startedAt && turn.completedAt <= now &&
        turn.costCoverage === 'recorded-turn' && turn.costRateVersion === COST_RATE_VERSION &&
        usage?.totalTokens > 0 && turn.costTokens >= usage.totalTokens &&
        Number.isFinite(credits) && credits >= 0 && Number.isFinite(recordedCost) &&
        Math.abs(credits - recordedCost) <= 1e-8 * Math.max(1, credits);
      if (!complete) {
        recorded.excludedTurnCount++;
        if (turn.costCoverage !== 'recorded-turn') recorded.partialTurnCount++;
        continue;
      }
      add(recorded, usage, credits);
      const rowKey = JSON.stringify([turn.model, turn.reasoningEffort || null, turn.serviceTier || 'standard']);
      const row = rows.get(rowKey) || { ...emptyUsage(), model: turn.model,
        reasoningEffort: turn.reasoningEffort || null, serviceTier: turn.serviceTier || 'standard' };
      add(row, usage, credits);
      rows.set(rowKey, row);
    }
    for (const turn of thread.executionHistory?.turns || []) {
      if (!Number.isFinite(turn.startedAt) || turn.startedAt < cutoff || turn.startedAt > now ||
          !Number.isFinite(turn.completedAt) || turn.completedAt > now ||
          turn.completedAt < turn.startedAt) continue;
      const key = `${turn.turnId || ''}:${turn.startedAt}`;
      if (!seen.has(key)) { recorded.excludedTurnCount++; seen.add(key); }
    }
  }
  recorded.modelRows = [...rows.values()].sort((a, b) => b.credits - a.credits);

  const allSamples = state.costCalibrationSamples || [];
  const quotas = new Map((state.rollingQuotaEvents || []).map(event => [event.id, event]));
  const allocations = new Map();
  for (const allocation of state.rollingAllocations || []) {
    const group = allocations.get(allocation.attributionEventId) || [];
    group.push(allocation);
    allocations.set(allocation.attributionEventId, group);
  }
  const close = (left, right) => Number.isFinite(left) && Number.isFinite(right) &&
    Math.abs(left - right) <= 1e-8 * Math.max(1, Math.abs(left), Math.abs(right));
  const byId = new Map();
  for (const sample of allSamples) {
    if (!sample.id || sample.source !== 'recorded-cost-increments' ||
        sample.accountUnit !== state.accountUnit || !state.accountUnit ||
        sample.version !== COST_RATE_VERSION || !Number.isFinite(sample.at) ||
        sample.at < cutoff || sample.at > now ||
        !Number.isFinite(sample.credits) || sample.credits <= 0 ||
        !Number.isFinite(sample.percent) || sample.percent <= 0) continue;
    const quota = quotas.get(sample.id);
    const linked = allocations.get(sample.id) || [];
    if (quota?.coverage !== 'official-quota-sample' || quota.at !== sample.at ||
        !close(quota.percent, sample.percent) || !close(quota.attributedPercent, sample.percent) ||
        quota.unattributedPercent !== 0 || !linked.length ||
        linked.some(event => event.costRateVersion !== COST_RATE_VERSION ||
          event.quotaIdentity !== quota.quotaIdentity ||
          !Number.isFinite(event.startAt) || !Number.isFinite(event.endAt) ||
          event.startAt < cutoff || event.endAt <= event.startAt || event.endAt > sample.at ||
          !Number.isFinite(event.costCredits) || event.costCredits <= 0 ||
          !Number.isFinite(event.percent) || event.percent <= 0) ||
        !close(linked.reduce((sum, event) => sum + event.costCredits, 0), sample.credits) ||
        !close(linked.reduce((sum, event) => sum + event.percent, 0), sample.percent)) continue;
    byId.set(sample.id, { ...sample,
      startAt: Math.min(...linked.map(event => event.startAt)),
      endAt: Math.max(...linked.map(event => event.endAt)) });
  }
  const samples = [];
  for (const sample of [...byId.values()].sort((a, b) => a.at - b.at)) {
    // Overlapping ranges in different quota events cannot independently price
    // the same activity. Parallel allocations inside one event remain valid.
    if (samples.length && sample.startAt < samples.at(-1).endAt) continue;
    samples.push(sample);
  }
  const times = [...new Set(samples.map(sample => sample.at))];
  const validation = { status: 'insufficient-independent-samples', calibration: null,
    evaluation: null, excludedSampleCount: allSamples.length - samples.length };
  // Split at a timestamp boundary. A simultaneous sample must never leak into
  // both calibration and validation, and no evaluation sample fits its own rate.
  if (times.length >= 2) {
    const boundary = times[Math.ceil(times.length / 2)];
    const summarize = group => ({ since: Math.min(...group.map(sample => sample.startAt)), until: group.at(-1).at,
      credits: group.reduce((sum, sample) => sum + sample.credits, 0),
      actualPercent: group.reduce((sum, sample) => sum + sample.percent, 0),
      sampleCount: group.length });
    const calibration = summarize(samples.filter(sample => sample.at < boundary));
    const heldOut = samples.filter(sample => sample.at >= boundary && sample.startAt >= calibration.until);
    validation.excludedSampleCount += samples.filter(sample => sample.at >= boundary).length - heldOut.length;
    if (heldOut.length) {
      const evaluation = summarize(heldOut);
      calibration.percentPerCredit = calibration.actualPercent / calibration.credits;
      evaluation.expectedPercent = evaluation.credits * calibration.percentPerCredit;
      evaluation.differencePercent = evaluation.expectedPercent - evaluation.actualPercent;
      evaluation.relativeErrorPercent = evaluation.differencePercent / evaluation.actualPercent * 100;
      validation.status = 'ready';
      validation.calibration = calibration;
      validation.evaluation = evaluation;
    }
  }
  return { pricing: { source: COST_RATE_SOURCE, checkedAt: COST_RATE_CHECKED_AT,
    unit: 'credits', formula: '非缓存输入 × 输入单价 + 缓存输入 × 缓存单价 + 输出 × 输出单价；单价按每百万 token，Fast 另乘倍率。' },
  recorded, validation,
  explanation: 'credits 按官方 token 定价计算，不等于订阅额度百分比。前半段账户样本校准换算系数，后半段独立核对；跨设备使用、上报延迟和额度规则变化都会影响差值。完整执行记录与核对样本分别显示统计范围。无法读取或未记录的执行不在 token 汇总内，排除数只计已知记录。' };
}
