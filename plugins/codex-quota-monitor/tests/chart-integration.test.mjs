import test from 'node:test';
import assert from 'node:assert/strict';
import { Collector } from '../server/collector.mjs';
import { Estimator } from '../server/metrics.mjs';
import { ProviderLedger } from '../server/provider-ledger.mjs';
import { COST_RATE_VERSION, tokenUsage, usageCredits } from '../server/usage-cost.mjs';

// These fixtures only call snapshot()/ingest()/quota(); they start no polling,
// filesystem persistence, app-server connection, or external request.
const collector = () => new Collector({
  dataDir: '.', reader: { read: () => ({ threads: [], diagnostics: {} }) },
  client: {}, resetFetcher: null,
});
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1e-8 * Math.max(1, Math.abs(expected)),
  `${actual} should equal ${expected}`);
const usage = amount => ({ inputTokens: amount, cachedInputTokens: 0, outputTokens: 0, totalTokens: amount });
const apiTurn = (id, amount, startedAt, completedAt, modelProvider = 'sample-api') => ({
  turnId: id, startedAt, completedAt, model: 'sample-model', modelProvider,
  usageCoverage: 'recorded-turn', tokenUsage: usage(amount),
});
const apiThread = (id, turns, extra = {}) => ({
  id, title: `${id} title`, model: 'sample-model', modelProvider: 'sample-api',
  status: 'idle', startedAt: turns.at(-1).startedAt, completedAt: turns.at(-1).completedAt,
  activityEvidence: { turnId: turns.at(-1).turnId },
  tokens: turns.reduce((total, turn) => total + turn.tokenUsage.totalTokens, 0), tokensKnown: true,
  executionHistory: { turns }, ...extra,
});
const config = { activeProvider: 'sample-api', providers: [{ id: 'sample-api', name: 'Sample API' }] };

function assertApiConservation(snapshot) {
  for (const row of snapshot.sessions) {
    const chart = snapshot.sessionCharts[row.id];
    assert.equal(chart.unit, 'tokens');
    near(chart.totalAmount, row.totalTokens);
    assert.ok(chart.segments.every(segment => segment.taskId === row.id));
    if (chart.segments.length) near(chart.segments.at(-1).points.at(-1).value, chart.totalAmount);
  }
  near(Object.values(snapshot.sessionCharts).reduce((total, chart) => total + chart.totalAmount, 0), snapshot.summary.totalTokens);
}

test('collector session charts receive the current cost calibration rather than the token calibration', () => {
  const c = collector();
  const now = Date.now();
  const unit = 'integration-account:codex:10080';
  const tokens = tokenUsage(usage(1_000_000));
  const model = 'gpt-5.6-luna';
  const turn = { turnId: 'priced-run', startedAt: now - 20_000, completedAt: now - 10_000,
    model, costCredits: usageCredits(tokens, model), costTokens: tokens.totalTokens,
    costRateVersion: COST_RATE_VERSION, costCoverage: 'recorded-turn', tokenUsage: tokens };
  c.estimator = new Estimator({
    legacyAggregateMigrated: true, accountUnit: unit,
    sessionTrackingSince: now - 30_000, rollingStartedAt: now - 30_000,
    previous: { accountKey: 'integration-account', identity: 'integration-account:codex:primary:period', at: now },
    costCalibrationSamples: [{ id: 'synthetic-calibration', at: now - 1000,
      version: COST_RATE_VERSION, accountUnit: unit, credits: 10, percent: 2 }],
  });
  c.threads = [{ id: 'priced-task', title: 'Priced task', model, status: 'idle',
    startedAt: turn.startedAt, completedAt: turn.completedAt, tokens: tokens.totalTokens, tokensKnown: true,
    usageTurns: [turn], activityEvidence: { turnId: turn.turnId },
    executionHistory: { turns: [turn], intervals: [[turn.startedAt, turn.completedAt]], coverage: 'local-records' } }];
  c.account.lastFetchedAt = now;

  const first = c.snapshot();
  assert.equal(c.estimator.rollingCalibration(first.now).tokens, 0);
  assert.equal(c.estimator.costCalibration.percentPerCredit, 0.2);
  near(first.sessionCharts['priced-task'].totalAmount, 1);
  near(first.sessions[0].totalEstimatedPercent, 1);
  assert.equal(first.sessionCharts['priced-task'].segments[0].source, 'model-token-cost-calibrated');
  assert.equal(first.attributionScopes.history.observedPercent, 0);

  c.estimator.state.costCalibrationSamples[0].percent = 4;
  const recalibrated = c.snapshot();
  near(recalibrated.sessionCharts['priced-task'].totalAmount, 2);
  near(recalibrated.sessions[0].totalEstimatedPercent, 2);
});

test('collector API charts preserve parent links and independent task totals even when execution output is capped', () => {
  const c = collector();
  const now = Date.now(), start = now - 300_000;
  const turns = Array.from({ length: 205 }, (_, index) =>
    apiTurn(`parent-run-${index}`, 10, start + index * 1000, start + index * 1000 + 500));
  c.providerLedger.ingest([
    apiThread('parent', turns),
    apiThread('child', [apiTurn('child-run', 50, start + 1000, start + 1900)], { parentThreadId: 'parent' }),
  ], now, config);
  c.providerAware = true;
  c.settings.selectedProvider = 'sample-api';

  const snapshot = c.snapshot();
  const api = snapshot.apiUsage;
  assert.equal(snapshot.dataSource, 'local-api-provider-records');
  assert.deepEqual(snapshot.sessionCharts, api.sessionCharts);
  assert.equal(api.sessions.find(row => row.id === 'child').parentThreadId, 'parent');
  assert.equal(api.sessions.find(row => row.id === 'parent').parentThreadId, null);
  assert.equal(api.summary.totalTokens, 2100);
  assert.equal(api.summary.taskCount, 2);
  assert.equal(api.sessionCharts.parent.totalAmount, 2050);
  assert.equal(api.sessionCharts.child.totalAmount, 50);
  assert.equal(api.sessionCharts.parent.segments.length, 200);
  assert.equal(api.sessionCharts.parent.partial, true);
  near(api.sessionCharts.parent.segments[0].points[0].value, 50);
  assertApiConservation(api);
});

test('API chart totals partition sampled suffixes and unknown history, then replace them with the proven complete turn', () => {
  const ledger = new ProviderLedger();
  const start = Date.now() - 200_000;
  const observe = (amount, at, proven = false) => ledger.ingest([
    apiThread('sampled-task', [apiTurn('same-run', amount, start, proven ? at : null,
      proven ? 'sample-api' : null)], { status: proven ? 'idle' : 'active' }),
  ], at, config);
  observe(100, start);
  observe(130, start + 1000);
  observe(200, start + 100_000); // An offline gap establishes a new baseline.
  observe(240, start + 101_000);
  const api = ledger.apiSnapshot('sample-api', start + 101_000);
  const unknown = ledger.apiSnapshot('unknown', start + 101_000);
  assert.equal(api.summary.totalTokens, 70);
  assert.equal(unknown.summary.totalTokens, 170);
  assert.equal(api.sessionCharts['sampled-task'].segments.length, 1);
  assert.equal(api.sessionCharts['sampled-task'].partial, true);
  assert.equal(api.sessions[0].totalElapsedSeconds, 101);
  assert.equal(api.sessions[0].observedElapsedSeconds, 2);
  assertApiConservation(api);
  assertApiConservation(unknown);
  near(api.summary.totalTokens + unknown.summary.totalTokens, 240);

  observe(240, start + 102_000, true);
  const recovered = ledger.apiSnapshot('sample-api', start + 102_000);
  assert.equal(recovered.summary.totalTokens, 240);
  assert.equal(recovered.sessionCharts['sampled-task'].segments.length, 1);
  assert.equal(ledger.apiSnapshot('unknown', start + 102_000).summary.totalTokens, 0);
  assertApiConservation(recovered);
});

test('quota observation, restart and actual reset flow through the collector with the correct period-start certainty', () => {
  const c = collector();
  const start = Date.now() - 30_000;
  const quota = (used, resetAt) => ({ id: 'codex:primary', bucket: 'codex', windowMinutes: 10080,
    usedPercent: used, remainingPercent: 100 - used, resetsAt: resetAt });
  const firstReset = start + 7 * 24 * 3_600_000;
  c.estimator.quota(quota(40, firstReset), start, 'integration-account');
  let scope = c.snapshot().attributionScopes.current;
  assert.equal(c.estimator.state.currentQuotaStartedAt, start);
  assert.equal(c.estimator.state.currentQuotaStartKnown, false);
  assert.equal(scope.periodStartedAt, start);
  assert.equal(scope.startKnown, false);
  assert.equal(scope.startReason, 'observed-start');

  c.estimator = new Estimator(structuredClone(c.estimator.state));
  c.estimator.quota(quota(42, firstReset), start + 5000, 'integration-account');
  scope = c.snapshot().attributionScopes.current;
  assert.equal(scope.startKnown, false);
  assert.equal(scope.periodStartedAt, start);
  assert.equal(scope.observedPercent, 2);

  const actualResetAt = start + 10_000, nextReset = firstReset + 7 * 24 * 3_600_000;
  c.estimator.quota(quota(0, nextReset), actualResetAt, 'integration-account');
  c.estimator.quota(quota(3, nextReset), start + 15_000, 'integration-account');
  const afterReset = c.snapshot();
  assert.equal(c.estimator.state.currentQuotaStartKnown, true);
  assert.equal(afterReset.attributionScopes.current.startKnown, true);
  assert.equal(afterReset.attributionScopes.current.periodStartedAt, actualResetAt);
  assert.equal(afterReset.attributionScopes.current.observedPercent, 3);
  assert.equal(afterReset.attributionScopes.history.observedPercent, 5);
  assert.equal(afterReset.quotaTrend.points.find(point => point.at === actualResetAt).reset, true);

  c.estimator = new Estimator(structuredClone(c.estimator.state));
  c.estimator.quota(quota(4, nextReset), start + 20_000, 'integration-account');
  scope = c.snapshot().attributionScopes.current;
  assert.equal(scope.startKnown, true);
  assert.equal(scope.periodStartedAt, actualResetAt);
  assert.equal(scope.observedPercent, 4);
});

test('changing account or quota unit starts another observation without claiming to have seen that cycle begin', () => {
  const c = collector();
  const start = Date.now() - 10_000;
  const quota = (used, windowMinutes = 10080) => ({ id: 'codex:primary', bucket: 'codex', windowMinutes,
    usedPercent: used, remainingPercent: 100 - used, resetsAt: start + 3_600_000 });
  c.estimator.quota(quota(40), start, 'first-account');
  c.estimator.quota(quota(0), start + 1000, 'first-account');
  assert.equal(c.snapshot().attributionScopes.current.startKnown, true);
  c.estimator.quota(quota(70), start + 2000, 'second-account');
  let scope = c.snapshot().attributionScopes.current;
  assert.equal(scope.startKnown, false);
  assert.equal(scope.periodStartedAt, start + 2000);
  assert.equal(scope.observedPercent, 0);
  assert.equal(scope.startReason, 'observed-start');
  c.estimator.quota(quota(2, 300), start + 3000, 'second-account');
  scope = c.snapshot().attributionScopes.current;
  assert.equal(scope.startKnown, false);
  assert.equal(scope.periodStartedAt, start + 3000);
  assert.equal(c.estimator.state.history.length, 1);
});
