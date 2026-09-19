import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUsageComparison } from '../server/usage-comparison.mjs';
import { COST_RATE_VERSION } from '../server/usage-cost.mjs';

const now = 1_800_000_000_000;
const since = now - 100_000;
const turn = (extra = {}) => ({ turnId: 'synthetic-turn', startedAt: since + 1,
  completedAt: now - 1, model: 'gpt-6-astra', reasoningEffort: 'max',
  tokenUsage: { inputTokens: 1_000_000, cachedInputTokens: 900_000, outputTokens: 100_000 },
  costCredits: 172.5, costTokens: 1_100_000, costRateVersion: COST_RATE_VERSION,
  costCoverage: 'recorded-turn', ...extra });
const sample = (id, offset, credits, percent, extra = {}) => ({ id, at: since + offset,
  credits, percent, accountUnit: 'synthetic:codex:weekly', version: COST_RATE_VERSION,
  source: 'recorded-cost-increments', ...extra });
const state = (turns = [], samples = []) => ({ accountUnit: 'synthetic:codex:weekly',
  knownThreads: { task: { usageTurns: turns } }, costCalibrationSamples: samples,
  rollingQuotaEvents: [...new Map(samples.map(s => [s.id, s])).values()].map(s => ({
    id: s.id, at: s.at, percent: s.percent, attributedPercent: s.percent,
    unattributedPercent: 0, coverage: 'official-quota-sample', quotaIdentity: 'synthetic:weekly:1' })),
  rollingAllocations: [...new Map(samples.map(s => [s.id, s])).values()].map(s => ({
    attributionEventId: s.id, at: s.at, startAt: s.startAt ?? s.at - 10,
    endAt: s.endAt ?? s.at, percent: s.percent, costCredits: s.credits,
    costRateVersion: COST_RATE_VERSION, quotaIdentity: 'synthetic:weekly:1' })),
});
const compare = value => buildUsageComparison({ state: value, now, since });

test('official pricing separates cached input and output and counts an execution once', () => {
  const value = compare(state([turn(), turn()]));
  assert.equal(value.recorded.credits, 172.5);
  assert.equal(value.recorded.inputTokens, 1_000_000);
  assert.equal(value.recorded.cachedInputTokens, 900_000);
  assert.equal(value.recorded.outputTokens, 100_000);
  assert.equal(value.recorded.turnCount, 1);
  assert.equal(value.recorded.modelRows[0].reasoningEffort, 'max');
});

test('crossing, running, unsupported, partial and mixed-model executions cannot masquerade as complete costs', () => {
  const bad = [turn({ turnId: 'cross', startedAt: since - 1 }),
    turn({ turnId: 'running', completedAt: null }),
    turn({ turnId: 'unknown', model: 'unknown' }),
    turn({ turnId: 'partial', costCoverage: 'partial-turn' }),
    turn({ turnId: 'mixed', costCredits: 500 }),
    turn({ turnId: 'unknown-tokens', costTokens: 100 })];
  const value = compare(state(bad)).recorded;
  assert.equal(value.credits, 0);
  assert.equal(value.excludedTurnCount, 6);
  assert.equal(value.partialTurnCount, 1);
});

test('validation uses earlier calibration only, exposing a real later discrepancy', () => {
  const value = compare(state([], [sample('first', 100, 100, 1), sample('second', 200, 200, 1)]));
  assert.equal(value.validation.status, 'ready');
  assert.equal(value.validation.calibration.percentPerCredit, 0.01);
  assert.equal(value.validation.evaluation.credits, 200);
  assert.equal(value.validation.evaluation.expectedPercent, 2);
  assert.equal(value.validation.evaluation.actualPercent, 1);
  assert.equal(value.validation.evaluation.differencePercent, 1);
  assert.equal(value.validation.evaluation.relativeErrorPercent, 100);
});

test('simultaneous, duplicate and contaminated samples do not leak into both halves', () => {
  const value = compare(state([], [sample('a', 100, 100, 1), sample('a', 100, 100, 1,
    {startAt: since + 70, endAt: since + 80}),
    sample('b', 100, 100, 1), sample('c', 200, 100, 3),
    sample('other-account', 300, 100, 99, { accountUnit: 'other' }),
    sample('legacy', 300, 100, 99, { source: 'recorded-turn-mix' }),
    sample('future', 200_000, 100, 99),
    sample('old', -1, 100, 99)]));
  assert.equal(value.validation.calibration.sampleCount, 2);
  assert.equal(value.validation.evaluation.sampleCount, 1);
  assert.equal(value.validation.evaluation.expectedPercent, 1);
  assert.equal(value.validation.evaluation.actualPercent, 3);
  assert.equal(value.validation.excludedSampleCount, 5);
});

test('insufficient independent samples show no quota prediction', () => {
  const value = compare(state([], [sample('one', 100, 100, 1)]));
  assert.equal(value.validation.status, 'insufficient-independent-samples');
  assert.equal(value.validation.evaluation, null);
});

test('account switch cutoff excludes costs and calibration from the previous account period', () => {
  const value = compare({ ...state([turn()], [sample('early', 100, 100, 1)]), costAccountStart: since + 500 });
  assert.equal(value.recorded.credits, 0);
  assert.equal(value.validation.status, 'insufficient-independent-samples');
});

test('unbounded, overlapping, unlinked and boundary-crossing cost samples are excluded', () => {
  const s = state([], [sample('train', 100, 100, 1),
    sample('overlap', 150, 100, 1, { startAt: since + 90 }),
    sample('test', 200, 100, 1), sample('unbounded', 300, 100, 1),
    sample('unlinked', 400, 100, 1)]);
  s.rollingAllocations.find(e => e.attributionEventId === 'unbounded').startAt = null;
  s.rollingQuotaEvents = s.rollingQuotaEvents.filter(e => e.id !== 'unlinked');
  const v = compare(s).validation;
  assert.equal(v.status, 'ready');
  assert.equal(v.calibration.sampleCount, 1);
  assert.equal(v.evaluation.sampleCount, 1);
  assert.equal(v.excludedSampleCount, 3);
  const crossing = state([], [sample('train', 100, 100, 1, { endAt: since + 80 }),
    sample('test', 200, 100, 1, { startAt: since + 90 })]);
  assert.equal(compare(crossing).validation.status, 'insufficient-independent-samples');
});

test('known executions with no token record are included in the excluded count', () => {
  const s = state([turn()]);
  s.knownThreads.task.executionHistory = { turns: [turn(), turn({turnId:'missing'})] };
  assert.equal(compare(s).recorded.excludedTurnCount, 1);
});
