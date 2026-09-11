import test from "node:test";
import assert from "node:assert/strict";
import { Estimator } from "../server/metrics.mjs";
import { Collector, validateSettings } from "../server/collector.mjs";

const now = 1_800_000_000_000;
const hour = 60 * 60 * 1000;
const task = (id, tokens = 0, extra = {}) => ({
  id,
  title: id,
  model: "gpt-5.6-terra",
  status: "active",
  startedAt: now - 5_000,
  tokens,
  tokensKnown: true,
  activityEvidence: { turnId: `${id}-turn` },
  ...extra,
});

test("task allocations retain their full timestamped amount across account windows", () => {
  const e = new Estimator();
  e.setRetentionHours(24, now);
  e.state.rollingStartedAt = now - 30 * hour;
  e.state.rollingCoverage = "timestamped";
  e.state.rollingAllocations = [{
    at: now - hour,
    id: "a",
    startAt: now - 30 * hour,
    endAt: now - hour,
    percent: 20,
    tokens: null,
    turnKey: null,
    turnPercent: null,
  }];
  const row = e.sessions([task("a")], now)[0];
  // Account retention must not prorate a known task allocation.
  assert.equal(row.totalEstimatedPercent, 20);
  assert.equal(e.state.rollingAllocations.length, 1);
});

test("task observations retain their complete duration and storage", () => {
  const e = new Estimator();
  e.setRetentionHours(24, now);
  e.state.rollingStartedAt = now - 30 * hour;
  e.state.rollingCoverage = "timestamped";
  e.state.rollingObservations = [
    { at: now - hour, threadId: "root", startAt: now - 30 * hour, endAt: now - hour },
    { at: now - 1_000, threadId: "child", startAt: now - 5 * hour, endAt: now },
  ];
  const root = task("root", 0, { startedAt: null });
  const child = task("child", 0, { parentThreadId: "root", startedAt: null });
  const row = e.sessions([root, child], now)[0];
  assert.equal(row.totalElapsedSeconds, 30 * 3600);
  assert.equal(e.state.rollingObservations.length, 2);
  assert.equal(e.state.rollingObservations[0].threadId, "root");
  assert.equal(e.state.rollingObservations[0].startAt, now - 30 * hour);
});

test("completed latest-turn records remain beyond the account window", () => {
  const e = new Estimator();
  e.setRetentionHours(24, now);
  e.state.latestTurns.a = {
    turnId: "old",
    generation: 1,
    key: "a:1:old",
    terminal: true,
    completedAt: now - 25 * hour,
    observedSince: now - 26 * hour,
    allocatedPercent: 1,
    hasAllocation: true,
  };
  e.sessions([task("a")], now);
  assert.equal(Object.hasOwn(e.state.latestTurns, "a"), true);
});

test("legacy aggregate with an explicit monitoring interval is retained as marked uniform coverage", () => {
  const interval = [now - 6 * hour, now - hour];
  const e = new Estimator({
    sessionTrackingSince: interval[0],
    previous: { at: now - hour, identity: "account:window:1", used: 10 },
    totals: { a: 2 },
    sessionLedger: {
      a: { allocatedPercent: 2, timedPercent: 0, activeSeconds: 0, hasAllocation: true },
    },
  });
  const row = e.sessions([task("a", 0, {
    status: "idle",
    startedAt: interval[0],
    completedAt: interval[1],
    updatedAt: interval[1],
    activityEvidence: { turnId: "a-turn", lastTurnDurationMs: 5 * hour },
    executionHistory: { intervals: [interval], coverage: "local-records" },
  })], now)[0];
  assert.equal(row.totalEstimatedPercent, 2);
  assert.equal(e.state.rollingCoverage, "legacy-aggregate-uniform");
  e.appendObservation("a", [now - 30_000, now], null, now);
  assert.equal(e.state.rollingCoverage, "legacy-aggregate-uniform");
  e.setRetentionHours(2, now);
  assert.equal(e.sessions([task("a", 0, {
    status: "idle",
    startedAt: interval[0],
    completedAt: interval[1],
    updatedAt: interval[1],
    activityEvidence: { turnId: "a-turn", lastTurnDurationMs: 5 * hour },
    executionHistory: { intervals: [interval], coverage: "local-records" },
  })], now)[0].totalEstimatedPercent, 2);
});

test("legacy aggregate outside the requested window is not relabeled as current usage", () => {
  const e = new Estimator({
    sessionTrackingSince: now - 48 * hour,
    previous: { at: now - 30 * hour, identity: "account:window:1", used: 10 },
    totals: { a: 2 },
    sessionLedger: {
      a: { allocatedPercent: 2, timedPercent: 0, activeSeconds: 0, hasAllocation: true },
    },
  });
  const row = e.sessions([task("a")], now)[0];
  assert.equal(row.totalEstimatedPercent, null);
  assert.equal(row.estimateCoverage, "legacy-unbounded");
});

test("completed turn can provide an explicitly estimated fallback rate", () => {
  const e = new Estimator();
  e.setRetentionHours(24, now);
  e.state.rollingStartedAt = now - hour;
  e.state.rollingCoverage = "timestamped";
  e.state.rollingAllocations = [{
    at: now - 30_000,
    id: "a",
    percent: 2,
    tokens: 100,
    turnKey: "a:1:a-turn",
    turnPercent: 2,
  }];
  e.state.latestTurns.a = {
    turnId: "a-turn",
    startedAt: now - 20_000,
    generation: 1,
    key: "a:1:a-turn",
    allocatedPercent: 2,
    hasAllocation: true,
    observedSince: now - 20_000,
  };
  const row = e.sessions([
    task("a", 100, {
      status: "idle",
      completedAt: now - 10_000,
      activityEvidence: { turnId: "a-turn", lastTurnDurationMs: 10_000 },
    }),
  ], now)[0];
  assert.equal(row.latestTurnEstimatedPercent, 2);
  assert.equal(row.latestTurnSecondsPerPercent, 5);
  assert.equal(row.latestTurnRateSource, "turn-completed-fallback");
  assert.equal(row.latestTurnRateEstimated, true);
  assert.equal(row.latestTurnRateObserved, false);
});

test("active turn prefers a recent calibrated token increment and labels it estimated", () => {
  const e = new Estimator();
  const first = task("a", 0);
  e.local([first], now);
  e.quota({ id: "codex:primary", bucket: "codex", windowMinutes: 10080, resetsAt: now + hour, usedPercent: 10, remainingPercent: 90 }, now, "account");
  e.local([task("a", 100)], now + 5_000);
  e.quota({ id: "codex:primary", bucket: "codex", windowMinutes: 10080, resetsAt: now + hour, usedPercent: 11, remainingPercent: 89 }, now + 5_000, "account");
  e.local([task("a", 150)], now + 10_000);
  const row = e.sessions([task("a", 150)], now + 10_000)[0];
  assert.equal(row.latestTurnRateSource, "recent-token-calibrated");
  assert.equal(row.latestTurnRateEstimated, true);
  assert.equal(row.latestTurnRateObserved, false);
  assert.ok(Math.abs(row.latestTurnSecondsPerPercent - 10) < 1e-12);
});

test("retentionHours accepts integer hours from one through 168 only", () => {
  assert.deepEqual(validateSettings({ retentionHours: 1 }), { retentionHours: 1 });
  assert.deepEqual(validateSettings({ retentionHours: 168 }), { retentionHours: 168 });
  for (const value of [0, 169, 1.5, Infinity, NaN])
    assert.throws(() => validateSettings({ retentionHours: value }), /Retention window/);
});

test("legacy migration conserves evidenced totals and keeps latest share on its own bounds", () => {
  const first = [now - 5 * hour, now - 4 * hour];
  const latestInterval = [now - 2 * hour, now - hour];
  const latestKey = "a:7:latest";
  const e = new Estimator({
    sessionTrackingSince: now - 6 * hour,
    previous: { at: now - hour, identity: "account:window:1", used: 20 },
    sessionLedger: {
      a: { allocatedPercent: 10, timedPercent: 10, activeSeconds: 2 * 3600, hasAllocation: true },
      stale: { allocatedPercent: 5, timedPercent: 5, activeSeconds: 10, hasAllocation: true },
    },
    latestTurns: {
      a: {
        turnId: "latest",
        startedAt: latestInterval[0],
        generation: 7,
        key: latestKey,
        allocatedPercent: 2,
        hasAllocation: true,
        observedSince: latestInterval[0],
        completedAt: latestInterval[1],
        terminal: true,
      },
    },
  });
  const row = task("a", 0, {
    status: "idle",
    startedAt: latestInterval[0],
    completedAt: latestInterval[1],
    updatedAt: latestInterval[1],
    activityEvidence: { turnId: "latest", lastTurnDurationMs: hour },
    executionHistory: { intervals: [first, latestInterval], coverage: "local-records" },
  });
  const initial = e.sessions([row], now)[0];
  assert.equal(initial.totalEstimatedPercent, 10);
  assert.equal(initial.latestTurnEstimatedPercent, 2);
  assert.equal(e.state.totals.stale, undefined);
  assert.equal(e.state.rollingCoverage, "legacy-partial");
  const attribution = e.rollingAttribution(now);
  assert.equal(attribution.observedPercent, 0);
  assert.equal(attribution.attributedPercent, 0);
  assert.equal(attribution.unattributedPercent, 0);
  assert.equal(attribution.excludedIncompleteHistory, true);

  e.setRetentionHours(2, now);
  const clipped = e.sessions([row], now)[0];
  assert.equal(clipped.totalEstimatedPercent, 10);
  assert.equal(clipped.latestTurnEstimatedPercent, 2);
  assert.equal(e.state.sessionLedger.a.allocatedPercent, 10);
});

test("legacy migration subtracts already timestamped allocations instead of double counting them", () => {
  const interval = [now - 6 * hour, now - hour];
  const e = new Estimator({
    sessionTrackingSince: interval[0],
    previous: { at: interval[1], identity: "account:window:1", used: 20 },
    sessionLedger: {
      a: { allocatedPercent: 10, timedPercent: 10, activeSeconds: 5 * 3600, hasAllocation: true },
    },
    rollingAllocations: [{
      at: now - 90 * 60_000,
      id: "a",
      percent: 2,
      tokens: 200,
      turnKey: null,
      turnPercent: null,
      coverage: "timestamped-quota-sample",
    }],
  });
  e.setRetentionHours(24, now);
  const row = e.sessions([task("a", 0, {
    status: "idle",
    startedAt: interval[0],
    completedAt: interval[1],
    updatedAt: interval[1],
    activityEvidence: { turnId: "a-turn", lastTurnDurationMs: 5 * hour },
    executionHistory: { intervals: [interval], coverage: "local-records" },
  })], now)[0];
  assert.equal(row.totalEstimatedPercent, 10);
  assert.equal(e.state.rollingAllocations.reduce((sum, event) => sum + event.percent, 0), 10);
});

test("a complete single-turn history can conservatively recover the whole legacy task total", () => {
  const interval = [now - 30_000, now - 10_000];
  const e = new Estimator({
    sessionTrackingSince: now - hour,
    previous: { at: now - 5_000, identity: "account:window:1", used: 5 },
    sessionLedger: {
      a: { allocatedPercent: 3, timedPercent: 3, activeSeconds: 20, hasAllocation: true },
    },
    latestTurns: {
      a: {
        turnId: "a-turn",
        generation: 1,
        key: "a:1:a-turn",
        allocatedPercent: 1,
        hasAllocation: true,
        observedSince: interval[0],
        completedAt: interval[1],
        terminal: true,
      },
    },
  });
  const row = e.sessions([task("a", 0, {
    status: "idle",
    startedAt: interval[0],
    completedAt: interval[1],
    updatedAt: interval[1],
    activityEvidence: { turnId: "a-turn", lastTurnDurationMs: 20_000 },
    executionHistory: { intervals: [interval], coverage: "local-records" },
  })], now)[0];
  assert.equal(row.totalEstimatedPercent, 3);
  assert.equal(row.latestTurnEstimatedPercent, 3);
  assert.equal(row.latestTurnSecondsPerPercent, 20 / 3);
  assert.equal(row.latestTurnEstimateSource, "legacy-uniform-estimate");
});

test("a turn-key event with no turn amount is unavailable rather than a false zero", () => {
  const e = new Estimator({ legacyAggregateMigrated: true });
  e.state.rollingStartedAt = now - hour;
  e.state.rollingAllocations = [{
    at: now - 1_000,
    id: "a",
    percent: 2,
    tokens: 100,
    turnKey: "a:1:a-turn",
    turnPercent: null,
    coverage: "timestamped-quota-sample",
  }];
  e.state.latestTurns.a = {
    turnId: "a-turn",
    startedAt: now - 10_000,
    generation: 1,
    key: "a:1:a-turn",
    observedSince: now - 10_000,
  };
  const row = e.sessions([task("a")], now)[0];
  assert.equal(row.totalEstimatedPercent, 2);
  assert.equal(row.latestTurnEstimatedPercent, null);
  assert.equal(row.latestTurnSecondsPerPercent, 2.5);
});

test("active turn falls back to its retained average when the latest sample has no token delta", () => {
  const e = new Estimator({ legacyAggregateMigrated: true });
  e.state.rollingStartedAt = now - hour;
  e.state.rollingAllocations = [{
    at: now - 1_000,
    id: "a",
    percent: 2,
    tokens: 100,
    turnKey: "a:1:a-turn",
    turnPercent: 2,
    coverage: "timestamped-quota-sample",
  }];
  e.state.latestTurns.a = {
    turnId: "a-turn",
    startedAt: now - 10_000,
    generation: 1,
    key: "a:1:a-turn",
    observedSince: now - 10_000,
  };
  e.state.activity.a = [
    { at: now - 5_000, delta: 0 },
    { at: now, delta: 0 },
  ];
  const row = e.sessions([task("a", 100, { startedAt: now - 10_000 })], now)[0];
  assert.equal(row.latestTurnSecondsPerPercent, 5);
  assert.equal(row.secondsPerPercent, 5);
  assert.equal(row.latestTurnRateSource, "turn-average-fallback");
  e.state.activity.a = [{ at: now, delta: 100 }];
  assert.equal(e.recentTokenRate("a", now), null);
});

test("provisional calibrated usage is replaced by the next confirmed quota allocation", () => {
  const e = new Estimator();
  e.local([task("a", 0)], now);
  e.quota({ id: "codex:primary", bucket: "codex", windowMinutes: 10080,
    resetsAt: now + hour, usedPercent: 10, remainingPercent: 90 }, now, "account");
  e.local([task("a", 100)], now + 5_000);
  e.quota({ id: "codex:primary", bucket: "codex", windowMinutes: 10080,
    resetsAt: now + hour, usedPercent: 11, remainingPercent: 89 }, now + 5_000, "account");
  e.local([task("a", 150)], now + 10_000);
  const provisional = e.sessions([task("a", 150)], now + 10_000)[0];
  assert.equal(provisional.totalEstimatedPercent, 1.5);
  assert.equal(provisional.latestTurnEstimatedPercent, 1.5);
  assert.equal(provisional.estimateStatus, "provisional");
  assert.equal(provisional.estimateSource, "confirmed-plus-token-calibrated-provisional");

  e.quota({ id: "codex:primary", bucket: "codex", windowMinutes: 10080,
    resetsAt: now + hour, usedPercent: 11.4, remainingPercent: 88.6 }, now + 10_000, "account");
  const reconciled = e.sessions([task("a", 150)], now + 10_000)[0];
  assert.ok(Math.abs(reconciled.totalEstimatedPercent - 1.4) < 1e-12);
  assert.ok(Math.abs(reconciled.latestTurnEstimatedPercent - 1.4) < 1e-12);
  assert.equal(reconciled.estimateStatus, "allocated");
  assert.ok(Math.abs(
    e.state.rollingAllocations.reduce((sum, event) => sum + event.percent, 0) - 1.4,
  ) < 1e-12);
  const attribution = e.rollingAttribution(now + 10_000);
  assert.ok(Math.abs(attribution.observedPercent - 1.4) < 1e-12);
  assert.ok(Math.abs(attribution.attributedPercent - 1.4) < 1e-12);
  assert.equal(attribution.unattributedPercent, 0);
});

test("window changes and restart retain all confirmed task data", () => {
  const e = new Estimator({ legacyAggregateMigrated: true, retentionHours: 24 });
  e.state.rollingStartedAt = now - 30 * hour;
  e.state.rollingAllocations = [
    { at: now - 25 * hour, id: "old", percent: 4, coverage: "timestamped-quota-sample" },
    { at: now - 30_000, id: "a", percent: 2, turnKey: "a:1:a-turn",
      turnPercent: 2, coverage: "timestamped-quota-sample" },
  ];
  e.state.pending = { a: 50 };
  e.state.pendingSince = now - 10_000;
  e.pruneRolling(now);
  assert.deepEqual(e.state.totals, { old: 4, a: 2 });
  const restored = new Estimator(JSON.parse(JSON.stringify(e.state)));
  restored.setRetentionHours(1, now);
  assert.deepEqual(restored.state.pending, {});
  assert.deepEqual(restored.state.totals, { old: 4, a: 2 });
  restored.pruneRolling(now + 2 * hour);
  assert.deepEqual(restored.state.totals, { old: 4, a: 2 });
  assert.equal(restored.state.sessionLedger.old.allocatedPercent, 4);
  assert.equal(restored.state.rollingQuotaEvents.length, 0);
});

test("parent latest metrics include child work launched during the same turn", () => {
  const e = new Estimator({ legacyAggregateMigrated: true });
  e.state.rollingStartedAt = now - hour;
  e.state.rollingAllocations = [
    { at: now, id: "root", percent: 1, turnKey: "root:1:root-turn", turnPercent: 1,
      coverage: "timestamped-quota-sample" },
    { at: now, id: "child", percent: 2, turnKey: "child:1:child-turn", turnPercent: 2,
      coverage: "timestamped-quota-sample" },
  ];
  e.state.rollingObservations = [
    { at: now, threadId: "root", startAt: now - 30 * 60_000, endAt: now },
    { at: now, threadId: "child", startAt: now - 20 * 60_000, endAt: now },
  ];
  e.state.latestTurns = {
    root: { turnId: "root-turn", generation: 1, key: "root:1:root-turn",
      startedAt: now - 30 * 60_000, observedSince: now - 30 * 60_000 },
    child: { turnId: "child-turn", generation: 1, key: "child:1:child-turn",
      startedAt: now - 20 * 60_000, observedSince: now - 20 * 60_000 },
  };
  const root = task("root", 0, { startedAt: now - 30 * 60_000,
    activityEvidence: { turnId: "root-turn" } });
  const child = task("child", 0, { parentThreadId: "root", startedAt: now - 20 * 60_000,
    activityEvidence: { turnId: "child-turn" } });
  const row = e.sessions([root, child], now)[0];
  assert.equal(row.totalElapsedSeconds, 30 * 60);
  assert.equal(row.observationSeconds, 30 * 60);
  assert.equal(row.totalEstimatedPercent, 3);
  assert.equal(row.averageSecondsPerPercent, 600);
  assert.equal(row.latestTurnEstimatedPercent, 3);
  assert.equal(row.ownLatestTurnEstimatedPercent, 1);
  assert.equal(row.latestTurnChildCount, 1);
  assert.equal(row.latestTurnElapsedSeconds, 30 * 60);
  assert.equal(row.latestTurnSecondsPerPercent, 600);
  assert.equal(row.children[0].latestTurnEstimatedPercent, 2);
});

test("retired inactive groups remain in the known task view", () => {
  const e = new Estimator({ legacyAggregateMigrated: true });
  const old = task("old", 0, {
    status: "idle",
    startedAt: now - 26 * hour,
    completedAt: now - 25 * hour,
    updatedAt: now - 25 * hour,
    activityEvidence: { turnId: "old-turn", lastTurnDurationMs: hour },
  });
  const root = { ...old, id: "root", title: "root" };
  const child = task("child", 0, { parentThreadId: "root" });
  const rows = e.sessions([old, root, child], now);
  assert.deepEqual(rows.map((row) => row.id), ["root", "old"]);
  assert.equal(rows[0].children.length, 1);
  assert.equal(rows[0].status, "active");
});

test("collector attribution separates confirmed observed usage from provisional task projection", () => {
  const sampledAt = Date.now();
  const identity = `account:codex:primary:${sampledAt + hour}`;
  const e = new Estimator({ legacyAggregateMigrated: true });
  e.state.rollingStartedAt = sampledAt - 10_000;
  e.state.previous = { identity, accountKey: "account", used: 11, at: sampledAt - 5_000 };
  e.state.rollingAllocations = [{
    at: sampledAt - 5_000,
    id: "a",
    percent: 1,
    tokens: 100,
    turnKey: "a:1:a-turn",
    turnPercent: 1,
    quotaIdentity: identity,
    attributionEventId: "confirmed",
    coverage: "timestamped-quota-sample",
  }];
  e.state.rollingQuotaEvents = [{
    id: "confirmed",
    at: sampledAt - 5_000,
    percent: 1,
    attributedPercent: 1,
    unattributedPercent: 0,
    coverage: "official-quota-sample",
  }];
  e.state.latestTurns.a = {
    turnId: "a-turn",
    startedAt: sampledAt - 10_000,
    generation: 1,
    key: "a:1:a-turn",
    observedSince: sampledAt - 10_000,
  };
  e.state.pending = { a: 50 };
  e.state.pendingTurns = { a: { key: "a:1:a-turn", tokens: 50 } };
  e.state.pendingSince = sampledAt - 5_000;
  const row = task("a", 150, { startedAt: sampledAt - 10_000 });
  const collector = new Collector({
    dataDir: ".",
    reader: { read: () => ({ threads: [], diagnostics: {} }) },
    client: {},
    resetFetcher: null,
  });
  collector.estimator = e;
  collector.threads = [row];
  collector.account.lastFetchedAt = sampledAt;
  const attribution = collector.snapshot().attribution;
  assert.equal(attribution.observedPercent, 1);
  assert.equal(attribution.attributedPercent, 1);
  assert.equal(attribution.estimatedPercent, 1);
  assert.equal(attribution.unattributedPercent, 0);
  assert.equal(attribution.sampleCount, 1);
  assert.ok(Math.abs(attribution.projectedTaskPercent - 1.5) < 0.01);
  assert.ok(attribution.estimatedPercent <= attribution.observedPercent);
});

const officialEvent = (id, at, percent, attributedPercent, unattributedPercent) => ({
  id,
  at,
  percent,
  attributedPercent,
  unattributedPercent,
  coverage: "official-quota-sample",
});

test("attribution restarts after recovered history and uses the valid official suffix", () => {
  const validAt = now - 2 * hour;
  const e = new Estimator({
    rollingStartedAt: now - 4 * hour,
    rollingQuotaEvents: [
      {
        id: "recovered",
        at: now - 3 * hour,
        percent: 123,
        attributedPercent: 123,
        unattributedPercent: 0,
        coverage: "recovered-attributed-lower-bound",
      },
      officialEvent("valid", validAt, 2, 2, 0),
    ],
    rollingAllocations: [{ at: validAt, id: "a", percent: 99 }],
  });
  const attribution = e.rollingAttribution(now);
  assert.deepEqual(
    {
      observedPercent: attribution.observedPercent,
      attributedPercent: attribution.attributedPercent,
      unattributedPercent: attribution.unattributedPercent,
    },
    { observedPercent: 2, attributedPercent: 2, unattributedPercent: 0 },
  );
  assert.equal(attribution.since, validAt);
  assert.equal(attribution.coverage, "rolling");
  assert.equal(attribution.excludedIncompleteHistory, true);
  assert.equal(attribution.sampleCount, 1);
});

test("a valid official unattributed event is retained despite larger task allocations", () => {
  const firstAt = now - 90 * 60 * 1000;
  const secondAt = now - 30 * 60 * 1000;
  const e = new Estimator({
    rollingQuotaEvents: [
      officialEvent("first", firstAt, 2, 2, 0),
      officialEvent("unattributed", secondAt, 1, 0, 1),
    ],
    rollingAllocations: [{ at: secondAt, id: "a", percent: 99 }],
  });
  const attribution = e.rollingAttribution(now);
  assert.equal(attribution.observedPercent, 3);
  assert.equal(attribution.attributedPercent, 2);
  assert.equal(attribution.unattributedPercent, 1);
  assert.equal(attribution.sampleCount, 2);
});

test("an invalid middle quota event restarts the attribution suffix", () => {
  const firstAt = now - 3 * 60 * 60 * 1000;
  const invalidAt = now - 2 * 60 * 60 * 1000;
  const lastAt = now - 60 * 60 * 1000;
  const e = new Estimator({
    rollingQuotaEvents: [
      officialEvent("first", firstAt, 1, 1, 0),
      officialEvent("invalid", invalidAt, 1, 1, 1),
      officialEvent("last", lastAt, 3, 1, 2),
    ],
  });
  const attribution = e.rollingAttribution(now);
  assert.equal(attribution.observedPercent, 3);
  assert.equal(attribution.attributedPercent, 1);
  assert.equal(attribution.unattributedPercent, 2);
  assert.equal(attribution.since, lastAt);
  assert.equal(attribution.sampleCount, 1);
  assert.equal(attribution.excludedIncompleteHistory, true);
});

test("an interval crossing the damaged boundary is excluded from the suffix", () => {
  const invalidAt = now - 2 * 60 * 60 * 1000;
  const crossingStart = invalidAt - 30 * 60 * 1000;
  const crossingEnd = now - 30 * 60 * 1000;
  const validAt = now - 10 * 60 * 1000;
  const e = new Estimator({
    rollingQuotaEvents: [
      officialEvent("invalid", invalidAt, 1, 1, 1),
      {
        id: "crossing",
        startAt: crossingStart,
        endAt: crossingEnd,
        percent: 4,
        attributedPercent: 4,
        unattributedPercent: 0,
        coverage: "official-quota-sample",
      },
      officialEvent("valid", validAt, 2, 1, 1),
    ],
  });
  const attribution = e.rollingAttribution(now);
  assert.equal(attribution.observedPercent, 2);
  assert.equal(attribution.attributedPercent, 1);
  assert.equal(attribution.unattributedPercent, 1);
  assert.equal(attribution.since, validAt);
  assert.equal(attribution.sampleCount, 1);
});

test("an unlocatable damaged event does not suppress later timestamped samples", () => {
  const validAt = now - 30 * 60 * 1000;
  const e = new Estimator({
    rollingStartedAt: now - hour,
    rollingQuotaEvents: [
      {
        id: "unlocatable-damaged",
        percent: 2,
        attributedPercent: 2,
        unattributedPercent: 0,
        coverage: "official-quota-sample",
      },
      officialEvent("valid", validAt, 2, 2, 0),
    ],
  });
  const attribution = e.rollingAttribution(now);
  assert.equal(attribution.observedPercent, 2);
  assert.equal(attribution.attributedPercent, 2);
  assert.equal(attribution.unattributedPercent, 0);
  assert.equal(attribution.since, validAt);
  assert.equal(attribution.excludedIncompleteHistory, true);
  assert.equal(attribution.sampleCount, 1);
});

test("expired quota samples are excluded while the retained suffix remains complete", () => {
  const retainedAt = now - 30 * 60 * 1000;
  const e = new Estimator({
    retentionHours: 1,
    rollingQuotaEvents: [
      officialEvent("expired", now - 2 * hour, 4, 4, 0),
      officialEvent("retained", retainedAt, 2, 1, 1),
    ],
  });
  const attribution = e.rollingAttribution(now);
  assert.equal(attribution.observedPercent, 2);
  assert.equal(attribution.attributedPercent, 1);
  assert.equal(attribution.unattributedPercent, 1);
  assert.equal(attribution.since, retainedAt);
  assert.equal(attribution.excludedIncompleteHistory, false);
  assert.equal(attribution.sampleCount, 1);
});

test("attribution waits with numeric zeros when there are no quota samples", () => {
  const e = new Estimator({
    rollingAllocations: [{ at: now - 1_000, id: "a", percent: 99 }],
  });
  const attribution = e.rollingAttribution(now);
  assert.equal(attribution.observedPercent, 0);
  assert.equal(attribution.attributedPercent, 0);
  assert.equal(attribution.unattributedPercent, 0);
  assert.equal(attribution.coverage, "none");
  assert.equal(attribution.sampleCount, 0);
  assert.equal(attribution.excludedIncompleteHistory, false);
});

test("pruning cannot repair corrupt official split amounts into valid history", () => {
  const firstAt = now - 3 * hour;
  const badAt = now - 2 * hour;
  const lastAt = now - hour;
  for (const [attributed, unattributed] of [[-1, 2], [2, -1], [0, 2]]) {
    const e = new Estimator({
      rollingQuotaEvents: [
        officialEvent("before", firstAt, 1, 1, 0),
        officialEvent("bad", badAt, 1, attributed, unattributed),
        officialEvent("after", lastAt, 2, 1, 1),
      ],
    });
    e.pruneRolling(now);
    const summary = e.rollingAttribution(now);
    assert.equal(summary.observedPercent, 2);
    assert.equal(summary.attributedPercent, 1);
    assert.equal(summary.unattributedPercent, 1);
    assert.equal(summary.since, lastAt);
    assert.equal(summary.sampleCount, 1);
    assert.equal(summary.excludedIncompleteHistory, true);
  }
});
