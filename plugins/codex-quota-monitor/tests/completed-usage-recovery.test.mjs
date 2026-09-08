import test from "node:test";
import assert from "node:assert/strict";

import { Estimator } from "../server/metrics.mjs";

const base = 1_800_000_000_000; // Synthetic fixture epoch.
const accountIdentity = "account:codex:primary:weekly-reset";

const quota = (used) => ({
  id: "codex:primary",
  bucket: "codex",
  windowMinutes: 10080,
  resetsAt: base + 7 * 24 * 60 * 60 * 1000,
  usedPercent: used,
  remainingPercent: 100 - used,
});

function historyTurn({
  id = "turn-1",
  startedAt = base + 1_000,
  completedAt = null,
  status = "active",
} = {}) {
  return { turnId: id, startedAt, completedAt, durationMs: completedAt - startedAt, status };
}

function thread({
  id = "task",
  turn = historyTurn(),
  createdAt = base,
  tokens = 180_123,
  tokensKnown = true,
  parentThreadId = null,
  historyTurns = [turn],
  coverage = turn.status === "idle" ? "local-records" : "partial",
} = {}) {
  return {
    id,
    title: id,
    model: "gpt-6-astra",
    source: "user",
    parentThreadId,
    createdAt,
    status: turn.status,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    updatedAt: turn.completedAt ?? turn.startedAt,
    tokens,
    tokensKnown,
    activityEvidence: {
      source: "thread_history",
      turnId: turn.turnId,
      lastTurnDurationMs: turn.completedAt === null
        ? null : turn.completedAt - turn.startedAt,
    },
    executionHistory: {
      source: "thread_history",
      coverage,
      turns: historyTurns,
      intervals: historyTurns
        .filter((item) => item.status === "idle" && item.completedAt > item.startedAt)
        .map((item) => [item.startedAt, item.completedAt]),
    },
  };
}

function calibratedEstimator({ target, observed = true, trackingSince = base - 1_000 } = {}) {
  const key = `${target.id}:1:${target.activityEvidence.turnId}`;
  return new Estimator({
    legacyAggregateMigrated: true,
    sessionTrackingSince: trackingSince,
    rollingStartedAt: trackingSince,
    previous: {
      identity: accountIdentity,
      accountKey: "account",
      used: 20,
      at: base + 2_100_000,
    },
    rollingAllocations: [{
      at: base + 2_000_000,
      id: "calibration-task",
      percent: 10,
      tokens: 120_123_456,
      quotaIdentity: accountIdentity,
      coverage: "timestamped-quota-sample",
    }],
    latestTurns: {
      [target.id]: {
        turnId: target.activityEvidence.turnId,
        startedAt: target.startedAt,
        completedAt: target.completedAt,
        generation: 1,
        key,
        observedSince: target.startedAt + 4_000,
        lastAttachedAt: target.completedAt,
        terminal: true,
      },
    },
    rollingObservations: observed ? [{
      at: target.completedAt,
      threadId: target.id,
      turnKey: key,
      startAt: target.startedAt + 4_000,
      endAt: target.completedAt,
    }] : [],
  });
}

test("completed observed single-turn task gets a token-calibrated micro estimate", () => {
  const turn = historyTurn({
    id: "completed-turn",
    startedAt: base + 190_000,
    completedAt: base + 233_000,
    status: "idle",
  });
  const target = thread({
    id: "completed-task",
    turn,
    createdAt: base + 188_400,
  });
  const now = base + 2_260_000;
  const estimator = calibratedEstimator({ target, trackingSince: target.createdAt - 10_000 });

  // The periodic local collector qualifies and persists the record even when
  // no browser snapshot is requesting a session projection.
  estimator.local([target], now);
  assert.equal(estimator.state.rollingCompletionEstimates.length, 1);
  const row = estimator.sessions([target], now)[0];
  const expected = 180_123 * 10 / 120_123_456;
  assert.ok(Math.abs(row.totalEstimatedPercent - expected) < 1e-15);
  assert.equal(row.latestTurnEstimatedPercent, row.totalEstimatedPercent);
  assert.equal(row.estimateSource, "completed-single-turn-token-calibrated");
  assert.equal(row.latestTurnEstimateSource, "completed-single-turn-token-calibrated");
  assert.equal(row.estimateCoverage, "completed-single-turn-token-calibrated");
  assert.equal(row.estimateStatus, "provisional");
  assert.equal(row.estimateIncludesRecovery, true);
  assert.equal(row.ownEstimateIncludesRecovery, true);
  assert.equal(estimator.rollingAttribution(now).attributedPercent, 0);
});

test("a new authoritative first turn captures its first positive token sample", () => {
  const estimator = new Estimator();
  const anchor = {
    id: "anchor", title: "anchor", model: "gpt-6-astra", status: "active",
    startedAt: base - 60_000, tokens: 0, tokensKnown: true,
    activityEvidence: { turnId: "anchor-turn" },
  };
  estimator.local([anchor], base);
  estimator.quota(quota(10), base, "account");

  const active = thread({
    createdAt: base + 1_000,
    turn: historyTurn({ startedAt: base + 2_000 }),
  });
  estimator.local([anchor, active], base + 5_000);
  assert.equal(estimator.state.pending.task, 180_123);
  assert.equal(estimator.state.pendingTurns.task.tokens, 180_123);
  assert.deepEqual(estimator.state.pendingRanges.task, {
    startAt: base + 2_000,
    endAt: base + 5_000,
  });

  estimator.quota(quota(10.02), base + 5_000, "account");
  const completedTurn = { ...active.executionHistory.turns[0],
    status: "idle", completedAt: base + 8_000, durationMs: 6_000 };
  const completed = thread({
    createdAt: active.createdAt,
    turn: completedTurn,
    tokens: active.tokens,
  });
  estimator.local([anchor, completed], base + 10_000);
  const row = estimator.sessions([anchor, completed], base + 10_000)
    .find((item) => item.id === "task");
  assert.ok(Math.abs(row.totalEstimatedPercent - 0.02) < 1e-12);
  assert.equal(row.estimateSource, "confirmed-account-delta");
  assert.equal(row.estimateStatus, "allocated");
});

test("first-turn recovery accepts millisecond creation after a second-precise start", () => {
  const estimator = new Estimator();
  estimator.local([], base);
  estimator.quota(quota(10), base, "account");
  const active = thread({
    createdAt: base + 2_750,
    turn: historyTurn({ startedAt: base + 2_000 }),
  });
  estimator.local([active], base + 5_000);
  assert.equal(estimator.state.pending.task, 180_123);
  assert.deepEqual(estimator.state.pendingRanges.task, {
    startAt: base + 2_750,
    endAt: base + 5_000,
  });
});

test("first samples from inherited, older, multi-turn, or unknown-token tasks stay excluded", () => {
  const estimator = new Estimator();
  estimator.local([], base);
  estimator.quota(quota(10), base, "account");
  const current = historyTurn({ startedAt: base + 2_000 });
  const older = historyTurn({ id: "older", startedAt: base - 10_000,
    completedAt: base - 5_000, status: "idle" });
  const rows = [
    thread({ id: "child", parentThreadId: "parent", turn: current, createdAt: base + 1_000 }),
    thread({ id: "old", turn: current, createdAt: base - 1 }),
    thread({ id: "multi", turn: current, createdAt: base + 1_000,
      historyTurns: [older, current] }),
    thread({ id: "unknown", turn: current, createdAt: base + 1_000, tokensKnown: false }),
  ];
  estimator.local(rows, base + 5_000);
  assert.deepEqual(estimator.state.pending, { child: 0, old: 0, multi: 0, unknown: 0 });
  estimator.quota(quota(10.02), base + 5_000, "account");
  assert.ok(Math.abs(
    estimator.rollingAttribution(base + 5_000).unattributedPercent - 0.02,
  ) < 1e-12);
});

test("single-turn fallback requires current-account observation and yields to confirmation", () => {
  const completed = historyTurn({
    startedAt: base + 1_000,
    completedAt: base + 44_000,
    status: "idle",
  });
  const target = thread({ turn: completed, createdAt: base });
  const now = base + 2_200_000;
  const unobserved = calibratedEstimator({ target, observed: false });
  assert.equal(unobserved.sessions([target], now)[0].totalEstimatedPercent, null);
  const oldAccountEpoch = calibratedEstimator({ target, trackingSince: base + 500 });
  assert.equal(oldAccountEpoch.sessions([target], now)[0].totalEstimatedPercent, null);

  const estimator = calibratedEstimator({ target });
  assert.equal(estimator.sessions([target], now)[0].estimateStatus, "provisional");
  const key = estimator.state.latestTurns.task.key;
  estimator.state.rollingAllocations.push({
    at: now - 1_000,
    id: "task",
    percent: 0.02,
    tokens: 180_123,
    turnKey: key,
    turnPercent: 0.02,
    quotaIdentity: accountIdentity,
    coverage: "timestamped-quota-sample",
  });
  const reconciled = estimator.sessions([target], now)[0];
  assert.ok(Math.abs(reconciled.totalEstimatedPercent - 0.02) < 1e-12);
  assert.equal(reconciled.estimateSource, "confirmed-account-delta");
  assert.equal(reconciled.estimateStatus, "allocated");
  assert.equal(reconciled.estimateIncludesRecovery, false);
});

test("a qualified completion survives restart and later turns until its own turn is confirmed", () => {
  const first = historyTurn({
    id: "first",
    startedAt: base + 1_000,
    completedAt: base + 44_000,
    status: "idle",
  });
  const original = thread({ turn: first, createdAt: base });
  const qualificationAt = base + 2_200_000;
  const estimator = calibratedEstimator({ target: original });
  const recovered = estimator.sessions([original], qualificationAt)[0];
  const recoveredPercent = recovered.totalEstimatedPercent;
  const firstKey = estimator.state.rollingCompletionEstimates[0].turnKey;
  const expired = new Estimator(JSON.parse(JSON.stringify(estimator.state)));
  expired.setRetentionHours(24, first.startedAt + 24 * 60 * 60 * 1000 + 1);
  assert.deepEqual(expired.state.rollingCompletionEstimates, []);

  const restored = new Estimator(JSON.parse(JSON.stringify(estimator.state)));
  const second = historyTurn({
    id: "second",
    startedAt: base + 2_300_000,
    completedAt: base + 2_330_000,
    status: "idle",
  });
  const continued = thread({
    turn: second,
    createdAt: base,
    tokens: 300_000,
    historyTurns: [first, second],
    coverage: "local-records",
  });
  restored.local([continued], base + 2_340_000);
  const afterSecondTurn = restored.sessions([continued], base + 2_340_000)[0];
  assert.equal(afterSecondTurn.totalEstimatedPercent, recoveredPercent);
  assert.equal(afterSecondTurn.latestTurnEstimatedPercent, null);
  assert.equal(afterSecondTurn.estimateIncludesRecovery, true);

  const secondKey = restored.state.latestTurns.task.key;
  restored.state.rollingAllocations.push({
    at: base + 2_340_000,
    id: "task",
    percent: 0.03,
    tokens: 118_985,
    turnKey: secondKey,
    turnPercent: 0.03,
    quotaIdentity: accountIdentity,
    coverage: "timestamped-quota-sample",
  });
  const mixed = restored.sessions([continued], base + 2_340_000)[0];
  assert.ok(Math.abs(mixed.totalEstimatedPercent - recoveredPercent - 0.03) < 1e-12);
  assert.equal(mixed.estimateIncludesRecovery, true);
  assert.equal(mixed.estimateSource, "mixed-with-completed-single-turn-token-calibrated");

  restored.state.rollingAllocations.push({
    at: base + 44_000,
    id: "task",
    percent: 0.02,
    tokens: 180_123,
    turnKey: firstKey,
    turnPercent: 0.02,
    quotaIdentity: accountIdentity,
    coverage: "timestamped-quota-sample",
  });
  const reconciled = restored.sessions([continued], base + 2_340_000)[0];
  assert.ok(Math.abs(reconciled.totalEstimatedPercent - 0.05) < 1e-12);
  assert.equal(reconciled.estimateIncludesRecovery, false);

  restored.quota(quota(21), base + 2_350_000, "different-account");
  assert.deepEqual(restored.state.rollingCompletionEstimates, []);
});
