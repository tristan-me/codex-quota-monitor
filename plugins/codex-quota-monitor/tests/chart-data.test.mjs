import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChartData, buildSessionSegments } from '../server/chart-data.mjs';
import { Estimator } from '../server/metrics.mjs';
import { COST_RATE_VERSION, tokenUsage, usageCredits } from '../server/usage-cost.mjs';

const start = 1_800_000_000_000;
const minute = 60_000;
const now = start + 20 * minute;
const oldIdentity = 'sample-account:codex:primary:old';
const identity = 'sample-account:codex:primary:current';
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8,
  `${actual} should equal ${expected}`);
const official = (id, at, percent, attributedPercent = percent, unattributedPercent = 0, quotaIdentity = identity) => ({
  id, at, percent, attributedPercent, unattributedPercent, quotaIdentity, coverage: 'official-quota-sample',
});
const allocation = (id, event, percent, extra = {}) => ({
  id, at: event.at, percent, quotaIdentity: event.quotaIdentity,
  attributionEventId: event.id, coverage: 'timestamped-quota-sample', ...extra,
});
const stateWith = extra => ({
  retentionHours: 24, rollingStartedAt: start, sessionTrackingSince: start,
  previous: { identity, at: now }, knownThreads: {}, history: [],
  rollingQuotaEvents: [], rollingAllocations: [], ...extra,
});
const usage = tokenUsage({ inputTokens: 1_000_000, cachedInputTokens: 900_000, outputTokens: 100_000 });
const pricedTurn = (turnId, startedAt, completedAt, model = 'gpt-5.6-luna', extra = {}) => ({
  turnId, startedAt, completedAt, model, serviceTier: 'standard',
  costCredits: usageCredits(usage, model), costTokens: usage.totalTokens,
  costRateVersion: COST_RATE_VERSION, costCoverage: 'recorded-turn', tokenUsage: { ...usage }, ...extra,
});
const thread = (id, turns, extra = {}) => ({
  id, title: `${id} title`, status: 'idle', usageTurns: turns,
  executionHistory: { turns: turns.filter(Boolean).map(({ turnId, startedAt, completedAt }) => ({ turnId, startedAt, completedAt })),
    coverage: 'local-records' }, ...extra,
});
const contributorTotals = point => {
  near(point.contributors.reduce((total, row) => total + row.percent, 0), point.deltaPercent);
  near(point.contributors.reduce((total, row) => total + row.sharePercent, 0), 100);
  assert.ok(point.contributors.every(row => row.percent >= 0 && row.percent <= point.deltaPercent));
};

test('resets preserve historical consumption, scope the current period, and conserve actual sample shares', () => {
  const before = official('before', start + 5 * minute, 3, 2, 1, oldIdentity);
  const after = official('after', start + 15 * minute, 2);
  const state = stateWith({
    currentQuotaStartedAt: start + 10 * minute,
    history: [
      { at: start, remainingPercent: 80 },
      { at: before.at, remainingPercent: 77 },
      { at: start + 10 * minute, remainingPercent: 100, reset: true },
      { at: after.at, remainingPercent: 98 },
    ],
    rollingQuotaEvents: [before, after],
    rollingAllocations: [allocation('parent', before, 1.5), allocation('child', before, 0.5), allocation('child', after, 2)],
  });
  const result = buildChartData({ state, now, sessions: [{ id: 'parent', title: 'Parent', children: [{ id: 'child', title: 'Child' }] }] });
  const scopes = result.attributionScopes;
  assert.equal(scopes.history.observedPercent, 5);
  assert.equal(scopes.history.estimatedPercent, 4);
  assert.equal(scopes.history.unattributedPercent, 1);
  assert.equal(scopes.history.sampleCount, 2);
  assert.equal(scopes.current.observedPercent, 2);
  assert.equal(scopes.current.quotaIdentity, identity);
  assert.equal(scopes.current.periodStartedAt, start + 10 * minute);
  assert.equal(scopes.current.startKnown, true);
  const points = result.quotaTrend.points;
  assert.deepEqual(points.map(point => point.remainingPercent), [80, 77, 100, 98]);
  assert.deepEqual(points.map(point => point.cumulativePercent), [0, 3, 3, 5]);
  assert.deepEqual(points.map(point => point.cycle), [0, 0, 1, 1]);
  assert.equal(points[2].breakBefore, true);
  assert.equal(points[2].deltaPercent, 0);
  assert.deepEqual(points[2].contributors, []);
  assert.equal(points[1].deltaPercent, 3);
  assert.equal(points[1].contributors.find(row => row.id === 'parent').title, 'Parent');
  contributorTotals(points[1]);
  contributorTotals(points[3]);
  assert.equal(points[1].contributors.find(row => row.kind === 'unattributed').percent, 1);
  assert.equal(points[3].contributors.find(row => row.kind === 'unattributed').percent, 0);
});

test('an unsampled drop is wholly unattributed and top-ups never become cumulative consumption', () => {
  const result = buildChartData({ now, state: stateWith({ history: [
    { at: start, remainingPercent: 60 },
    { at: start + minute, remainingPercent: 55.5 },
    { at: start + 2 * minute, remainingPercent: 100 },
  ] }) });
  assert.equal(result.attributionScopes.history.observedPercent, 0);
  assert.deepEqual(result.quotaTrend.points.map(point => point.cumulativePercent), [0, 0, 0]);
  const dropped = result.quotaTrend.points[1];
  assert.equal(dropped.deltaPercent, 4.5);
  assert.equal(dropped.contributors.length, 1);
  assert.equal(dropped.contributors[0].kind, 'unattributed');
  assert.equal(dropped.contributors[0].percent, 4.5);
  contributorTotals(dropped);
  assert.equal(result.quotaTrend.points[2].reset, true);
  assert.equal(result.quotaTrend.points[2].deltaPercent, 0);
});

test('oversized allocations are capped to the official attributed amount and invalid links cannot claim a share', () => {
  const event = official('fractional', start + minute, 2.5, 2, 0.5);
  const state = stateWith({
    history: [{ at: start, remainingPercent: 100 }, { at: event.at, remainingPercent: 97.5 }],
    rollingQuotaEvents: [event], rollingAllocations: [
      allocation('a', event, 8), allocation('b', event, 2),
      allocation('wrong-account', event, 99, { quotaIdentity: oldIdentity }),
      allocation('untimed', event, 99, { at: null }),
      allocation('unlinked', event, 99, { attributionEventId: 'another-sample' }),
    ],
  });
  const point = buildChartData({ state, now }).quotaTrend.points[1];
  assert.deepEqual(point.contributors.map(row => row.id), ['a', 'b', '__unattributed__']);
  near(point.contributors[0].percent, 1.6);
  near(point.contributors[1].percent, 0.4);
  near(point.contributors[2].percent, 0.5);
  contributorTotals(point);
  assert.equal(point.partial, true);
});

test('missing task allocations remain unknown rather than scaling the remaining tasks upward', () => {
  const event = official('missing-link', start + minute, 4, 3, 1);
  const point = buildChartData({ now, state: stateWith({
    history: [{ at: start, remainingPercent: 100 }, { at: event.at, remainingPercent: 96 }],
    rollingQuotaEvents: [event], rollingAllocations: [allocation('known', event, 1)],
  }) }).quotaTrend.points[1];
  assert.equal(point.contributors[0].percent, 1);
  assert.equal(point.contributors[1].percent, 3);
  contributorTotals(point);
});

test('a mismatched history delta bounds drilldown while cumulative totals still use official events', () => {
  const event = official('mismatched', start + minute, 5);
  const result = buildChartData({ now, state: stateWith({
    history: [{ at: start, remainingPercent: 100 }, { at: event.at, remainingPercent: 97 }],
    rollingQuotaEvents: [event], rollingAllocations: [allocation('known', event, 5)],
  }) });
  const point = result.quotaTrend.points[1];
  assert.equal(point.deltaPercent, 3);
  assert.equal(point.cumulativePercent, 5);
  assert.equal(result.attributionScopes.history.observedPercent, 5);
  contributorTotals(point);
  assert.equal(point.partial, true);
});

test('history uses the same valid official suffix as the estimator, including damaged boundaries', () => {
  const retained = official('valid-suffix', start + 6 * minute, 2, 1, 1);
  const state = stateWith({ rollingQuotaEvents: [
    official('older-valid', start + minute, 7),
    official('bad-split', start + 3 * minute, 2, 2, 2),
    { ...official('crosses-boundary', start + 5 * minute, 8), startAt: start + 2 * minute, endAt: start + 5 * minute },
    retained,
  ], history: [{ at: start + minute, remainingPercent: 93 }, { at: retained.at, remainingPercent: 80 }] });
  const attribution = new Estimator(structuredClone(state)).rollingAttribution(now);
  const fromState = buildChartData({ state, now });
  const supplied = buildChartData({ state, now, attribution });
  for (const result of [fromState, supplied]) {
    const scope = result.attributionScopes.history;
    assert.equal(scope.observedPercent, attribution.observedPercent);
    assert.equal(scope.estimatedPercent, attribution.attributedPercent);
    assert.equal(scope.unattributedPercent, attribution.unattributedPercent);
    assert.equal(scope.since, attribution.since);
    assert.equal(scope.sampleCount, attribution.sampleCount);
    assert.equal(scope.excludedIncompleteHistory, true);
    assert.deepEqual(result.quotaTrend.points.map(point => point.cumulativePercent), [0, 2]);
  }
});

test('current-period scope requires the exact identity and labels an unknown cycle start', () => {
  const state = stateWith({ rollingQuotaEvents: [
    official('another-period', start + minute, 7, 7, 0, `${identity}-similar`),
    { ...official('legacy-no-identity', start + 2 * minute, 5), quotaIdentity: undefined },
    official('current', start + 3 * minute, 2),
  ] });
  const result = buildChartData({ state, now });
  assert.equal(result.attributionScopes.history.observedPercent, 14);
  assert.equal(result.attributionScopes.current.observedPercent, 2);
  assert.equal(result.attributionScopes.current.startKnown, false);
  assert.equal(result.attributionScopes.current.startReason, 'observed-start');
  assert.equal(result.attributionScopes.current.partial, true);
});

test('legacy tracking timestamps preserve the estimator boundary after an unlocated damaged record', () => {
  const state = stateWith({ rollingStartedAt: undefined, sessionTrackingSince: undefined, since: start,
    rollingQuotaEvents: [{ ...official('unlocated', start, 1), at: undefined }, official('valid', start + minute, 2)] });
  const expected = new Estimator(structuredClone(state)).rollingAttribution(now);
  const result = buildChartData({ state, now }).attributionScopes.history;
  assert.equal(result.observedPercent, expected.observedPercent);
  assert.equal(result.since, expected.since);
  assert.equal(result.excludedIncompleteHistory, true);
});

test('a same-identity replenishment marker limits current-period consumption', () => {
  const resetAt = start + 5 * minute;
  const result = buildChartData({ now, state: stateWith({
    history: [{ at: start, remainingPercent: 80 }, { at: resetAt, remainingPercent: 100, reset: true }],
    rollingQuotaEvents: [official('old-cycle', start + minute, 8), official('new-cycle', start + 6 * minute, 2)],
  }) });
  assert.equal(result.attributionScopes.history.observedPercent, 10);
  assert.equal(result.attributionScopes.current.observedPercent, 2);
  assert.equal(result.attributionScopes.current.periodStartedAt, resetAt);
  assert.equal(result.attributionScopes.current.startReason, 'observed-reset');
});

test('the first monitor observation does not claim to know the quota cycle start', () => {
  const state = stateWith({ currentQuotaStartedAt: start, currentQuotaStartKnown: false,
    rollingQuotaEvents: [official('current', start + minute, 2)] });
  const scope = buildChartData({ state, now }).attributionScopes.current;
  assert.equal(scope.observedPercent, 2);
  assert.equal(scope.periodStartedAt, start);
  assert.equal(scope.startKnown, false);
  assert.equal(scope.partial, true);
  assert.equal(scope.startReason, 'observed-start');
});

test('unchanged polls compact to plateau endpoints without losing a changed sample, reset, or event', () => {
  const event = official('drop', start + 6 * minute, 2, 2, 0, oldIdentity);
  const history = Array.from({ length: 15 }, (_, index) => ({
    at: start + index * minute, remainingPercent: index < 6 ? 100 : index < 10 ? 98 : 100,
    quotaIdentity: index < 10 ? oldIdentity : identity,
    ...(index === 10 ? { reset: true } : {}),
  }));
  const result = buildChartData({ now, state: stateWith({ history, rollingQuotaEvents: [event] }) });
  assert.deepEqual(result.quotaTrend.points.map(point => (point.at - start) / minute), [0, 5, 6, 9, 10, 14]);
  assert.equal(result.quotaTrend.sampleCount, 15);
  assert.equal(result.quotaTrend.omittedUnchangedSampleCount, 9);
  const changed = result.quotaTrend.points.find(point => point.at === event.at);
  assert.equal(changed.deltaPercent, 2);
  contributorTotals(changed);
  assert.equal(result.quotaTrend.points.at(-1).cumulativePercent, 2);
});

test('a quota identity change breaks the remaining line even when the sampled remaining value falls', () => {
  const result = buildChartData({ now, state: stateWith({ history: [
    { at: start, remainingPercent: 90, quotaIdentity: oldIdentity },
    { at: start + minute, remainingPercent: 85, quotaIdentity: identity },
  ] }) });
  assert.equal(result.quotaTrend.points[1].reset, true);
  assert.equal(result.quotaTrend.points[1].deltaPercent, 0);
  assert.deepEqual(result.quotaTrend.points[1].contributors, []);
});

test('retention clips an interval consistently and marks a cycle whose start is outside retention as partial', () => {
  const end = start + 3 * 3_600_000;
  const event = { ...official('interval', end, 6), startAt: start, endAt: end };
  const state = stateWith({ retentionHours: 1, currentQuotaStartedAt: start,
    rollingQuotaEvents: [event], history: [{ at: start, remainingPercent: 100 }, { at: end, remainingPercent: 94 }] });
  const result = buildChartData({ state, now: end });
  assert.equal(result.attributionScopes.history.observedPercent, 2);
  assert.equal(result.attributionScopes.current.observedPercent, 2);
  assert.equal(result.attributionScopes.current.partial, true);
  assert.equal(result.quotaTrend.points.length, 1);
  assert.equal(result.quotaTrend.points[0].cumulativePercent, 2);
});

test('differently priced turns use their recorded models and replace old sampled allocations', () => {
  const turns = [pricedTurn('astra', start, start + minute, 'gpt-6-astra'),
    pricedTurn('luna', start + 2 * minute, start + 3 * minute)];
  const state = stateWith({ knownThreads: { task: thread('task', [...turns, { ...turns[1] }]) },
    rollingAllocations: [{ id: 'task', at: start + minute, percent: 99, turnKey: 'task:1:astra' },
      { id: 'task', at: start + 3 * minute, percent: 99, turnKey: 'task:2:luna' }] });
  const chart = buildChartData({ state, now, sessions: [{ id: 'task' }], calibration: { percentPerCredit: 0.01 } }).sessionCharts.task;
  assert.equal(chart.segments.length, 2);
  near(chart.segments[0].amount, 1.725);
  near(chart.segments[1].amount, 0.0395);
  near(chart.segments[0].secondsPerPercent, 60 / 1.725);
  near(chart.segments[1].secondsPerPercent, 60 / 0.0395);
  near(chart.segments.at(-1).points.at(-1).value, 1.7645);
  assert.equal(chart.partial, false);
  assert.ok(chart.segments.every(segment => segment.estimated && segment.interpolation === 'linear-per-execution'));
});

test('inconsistent or old pricing falls back to timestamped per-turn allocations, never a lifetime total', () => {
  const turns = [pricedTurn('old', start, start + minute, 'gpt-6-astra', { costRateVersion: 'obsolete' }),
    pricedTurn('inconsistent', start + 2 * minute, start + 3 * minute, 'gpt-5.6-luna', { costCredits: 999 }),
    pricedTurn('unsupported', start + 4 * minute, start + 5 * minute, 'gpt-5.6-luna', { costRateVersion: 'obsolete' })];
  const state = stateWith({ totals: { task: 9999 }, knownThreads: { task: thread('task', turns) },
    rollingAllocations: [
      { id: 'task', at: start + minute, percent: 2, turnKey: 'task:1:old', turnPercent: 2 },
      { id: 'task', at: start + 3 * minute, percent: 1.5, turnKey: 'task:2:inconsistent', turnPercent: 1.5 },
      { id: 'task', at: start + 5 * minute, percent: 99 },
    ] });
  const chart = buildChartData({ state, now, sessions: [{ id: 'task' }], calibration: { percentPerCredit: 1 } }).sessionCharts.task;
  assert.equal(chart.segments.length, 2);
  assert.equal(chart.totalAmount, 3.5);
  assert.equal(chart.partial, true);
  assert.ok(chart.segments.every(segment => segment.source === 'timestamped-allocations'));
});

test('flattened parents and descendants contribute once, including concurrent execution progress', () => {
  const parentTurn = pricedTurn('p', start, start + 2 * minute);
  const childTurn = pricedTurn('c', start + minute, start + 3 * minute);
  const grandchildTurn = pricedTurn('g', start + minute, start + 2 * minute);
  const child = { id: 'child', parentThreadId: 'parent', children: [] };
  const grandchild = { id: 'grandchild', parentThreadId: 'child', children: [] };
  const state = stateWith({ knownThreads: {
    parent: thread('parent', [parentTurn]), child: thread('child', [childTurn]), grandchild: thread('grandchild', [grandchildTurn]),
  } });
  const charts = buildChartData({ state, now, calibration: { percentPerCredit: 1 },
    sessions: [{ id: 'parent', children: [child, grandchild, { ...child }] }] }).sessionCharts;
  assert.equal(charts.parent.segments.length, 3);
  assert.equal(charts.child.segments.length, 2);
  assert.equal(charts.grandchild.segments.length, 1);
  near(charts.parent.totalAmount, 3 * 3.95);
  near(charts.child.totalAmount, 2 * 3.95);
  const parentPoints = charts.parent.segments.find(segment => segment.taskId === 'parent').points;
  near(parentPoints.find(point => point.at === start + minute).value, 3.95 / 2);
  near(parentPoints.find(point => point.at === start + 2 * minute).value, 3.95 * 2.5);
  near(charts.parent.segments.find(segment => segment.taskId === 'child').points.at(-1).value, 3.95 * 3);
});

test('a keyed task allocation with an unknown execution share cannot become a turn estimate', () => {
  for (const turnPercent of [undefined, null, 0, -1]) {
    const known = thread('task', [{ turnId: 'old', startedAt: start, completedAt: start + minute }]);
    const state = stateWith({ knownThreads: { task: known }, rollingAllocations: [
      { id: 'task', at: start + minute, percent: 5, turnKey: 'task:1:old', turnPercent },
    ] });
    const chart = buildChartData({ state, now, sessions: [{ id: 'task' }] }).sessionCharts.task;
    assert.equal(chart.segments.length, 0);
    assert.equal(chart.partial, true);
  }
});

test('an unkeyed timestamp interval attaches only when it fits one known execution completely', () => {
  const state = stateWith({ knownThreads: { task: thread('task', [
    { turnId: 'first', startedAt: start, completedAt: start + minute },
    { turnId: 'second', startedAt: start + 2 * minute, completedAt: start + 3 * minute },
  ]) }, rollingAllocations: [
    { id: 'task', at: start + minute, startAt: start + 10_000, endAt: start + 30_000, percent: 1.5 },
    { id: 'task', at: start + 3 * minute, startAt: start + 50_000, endAt: start + 150_000, percent: 9 },
  ] });
  const chart = buildChartData({ state, now, sessions: [{ id: 'task' }] }).sessionCharts.task;
  assert.equal(chart.segments.length, 1);
  assert.equal(chart.segments[0].turnId, 'first');
  assert.equal(chart.totalAmount, 1.5);
  assert.equal(chart.partial, true);
});

test('active duration stops at now while stale unfinished records do not invent a completed duration', () => {
  const active = pricedTurn('running', start, null);
  const state = stateWith({ knownThreads: { task: thread('task', [active], {
    status: 'active', startedAt: start, completedAt: null, lastMetadataAt: start + minute,
    activityEvidence: { turnId: 'running' },
  }) } });
  const input = { state, now, calibration: { percentPerCredit: 1 } };
  const current = buildChartData({ ...input, sessions: [{ id: 'task', ownStatus: 'active' }] }).sessionCharts.task.segments[0];
  assert.equal(current.completedAt, null);
  assert.equal(current.elapsedSeconds, 20 * 60);
  assert.equal(current.points.at(-1).at, now);
  const stale = buildChartData({ ...input, sessions: [{ id: 'task', ownStatus: 'unknown' }] }).sessionCharts.task.segments[0];
  assert.equal(stale.completedAt, null);
  assert.equal(stale.elapsedSeconds, null);
  assert.equal(stale.secondsPerPercent, null);
  assert.equal(stale.points.at(-1).at, start + minute);
  assert.equal(stale.partial, true);
});

test('keyed observed intervals can show a partial execution without claiming its real duration', () => {
  const state = stateWith({ rollingAllocations: [
    { id: 'task', at: start + 3 * minute, startAt: start + minute, endAt: start + 2 * minute,
      turnKey: 'task:1:recovered-turn', percent: 2, turnPercent: 2 },
    { id: 'task', at: start + 4 * minute, startAt: start, endAt: start + minute,
      turnKey: 'task:1:recovered-turn', percent: 1, turnPercent: 1 },
  ] });
  const chart = buildChartData({ state, now, sessions: [{ id: 'task' }] }).sessionCharts.task;
  assert.equal(chart.segments.length, 1);
  assert.equal(chart.segments[0].startedAt, start);
  assert.equal(chart.segments[0].points.at(-1).at, start + 2 * minute);
  assert.equal(chart.segments[0].elapsedSeconds, null);
  assert.equal(chart.totalAmount, 3);
  assert.equal(chart.partial, true);
});

test('shared segment builder supports tokens, deduplicates IDs, and retains the older cumulative baseline when capped', () => {
  const records = Array.from({ length: 205 }, (_, index) => ({ id: `run-${index}`,
    turnId: `turn-${index}`, taskId: 'api-task', title: 'API task', startedAt: start + index * minute,
    completedAt: start + (index + 1) * minute, amount: 1000, elapsedSeconds: 60 }));
  const chart = buildSessionSegments([...records, { ...records[204] }], { unit: 'tokens' });
  assert.equal(chart.segments.length, 200);
  assert.equal(chart.omittedTurnCount, 5);
  assert.equal(chart.partial, true);
  assert.equal(chart.unit, 'tokens');
  assert.equal(chart.totalAmount, 205_000);
  near(chart.segments[0].points[0].value, 5000);
  near(chart.segments.at(-1).points.at(-1).value, 205_000);
  assert.equal(chart.segments[0].secondsPerPercent, null);
  assert.equal(chart.segments[0].secondsPerUnit, 0.06);
});

test('a dense overlap is bounded and keeps cumulative endpoints', () => {
  const records = Array.from({ length: 80 }, (_, index) => ({ id: `overlap-${index}`,
    startedAt: start + index * 1000, completedAt: start + (160 + index) * 1000, amount: 1 }));
  const chart = buildSessionSegments(records);
  assert.ok(chart.segments.every(segment => segment.points.length <= 64));
  assert.equal(chart.partial, true);
  near(chart.segments.at(-1).points.at(-1).value, 80);
  for (const segment of chart.segments) for (let index = 1; index < segment.points.length; index++) {
    assert.ok(segment.points[index].at >= segment.points[index - 1].at);
    assert.ok(segment.points[index].value >= segment.points[index - 1].value);
  }
});

test('chart construction is pure and old malformed state yields finite JSON data', () => {
  const freeze = value => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) freeze(child);
    }
    return value;
  };
  const state = stateWith({
    knownThreads: { task: thread('task', [pricedTurn('valid', start, start + minute), null,
      { turnId: 'bad', startedAt: 'not-a-time', costCredits: Infinity }]) },
    history: [null, {}, { at: NaN, remainingPercent: 10 }, { at: start, remainingPercent: 101 },
      { at: start + minute, remainingPercent: 50 }, { at: now + 1, remainingPercent: 40 }],
    rollingQuotaEvents: [null, { percent: 2, attributedPercent: 2, unattributedPercent: 0 },
      official('valid', start + minute, 2)],
    rollingAllocations: [null, { id: 'task', at: now, percent: Infinity }],
  });
  const input = freeze({ state, now, sessions: [{ id: 'task', children: [null, {}] }], calibration: { percentPerCredit: 1 } });
  const before = structuredClone(input);
  const result = buildChartData(input);
  assert.deepEqual(input, before);
  assert.equal(result.sessionCharts.task.segments.length, 1);
  assert.equal(result.sessionCharts.task.partial, true);
  assert.equal(result.quotaTrend.points.length, 1);
  assert.equal(result.attributionScopes.history.observedPercent, 2);
  const checkNumbers = value => {
    if (typeof value === 'number') assert.ok(Number.isFinite(value));
    if (value && typeof value === 'object') for (const child of Object.values(value)) checkNumbers(child);
  };
  checkNumbers(result);
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.deepEqual(buildChartData({ state: { history: {}, rollingQuotaEvents: {}, rollingAllocations: {}, knownThreads: [] }, now }).sessionCharts, {});
});
