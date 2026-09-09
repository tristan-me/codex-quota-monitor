import test from "node:test";
import assert from "node:assert/strict";

import { Estimator } from "../server/metrics.mjs";

const base = 1_800_000_000_000;
const at = (seconds) => base + seconds * 1000;

const quota = (used, reset = at(10_000)) => ({
  id: "codex:primary",
  bucket: "codex",
  windowMinutes: 10080,
  resetsAt: reset,
  usedPercent: used,
  remainingPercent: 100 - used,
});

function turn({ id, startedAt, completedAt = null, status }) {
  return {
    turnId: id,
    startedAt,
    completedAt,
    durationMs: completedAt === null ? null : completedAt - startedAt,
    status,
  };
}

function task({ current, history = [current], tokens, status = current.status }) {
  return {
    id: "task",
    title: "Synthetic task",
    model: "gpt-5.6-terra",
    status,
    startedAt: current.startedAt,
    completedAt: current.completedAt,
    updatedAt: current.completedAt ?? current.startedAt,
    tokens,
    tokensKnown: true,
    activityEvidence: {
      source: "thread_history",
      turnId: current.turnId,
      lastTurnDurationMs: current.durationMs,
    },
    executionHistory: {
      source: "thread_history",
      coverage: "local-records",
      turns: history,
      intervals: history
        .filter((item) => item.status === "idle" && item.completedAt > item.startedAt)
        .map((item) => [item.startedAt, item.completedAt]),
    },
  };
}

function latestRow(estimator, row, now) {
  return estimator.sessions([row], now)[0];
}

test("a completed terminal turn does not absorb a later counter delta", () => {
  const completed = turn({ id: "turn-old", startedAt: at(0), completedAt: at(19), status: "idle" });
  const terminal = task({ current: completed, tokens: 100 });
  const estimator = new Estimator();
  estimator.local([terminal], at(19));
  estimator.quota(quota(10), at(19), "synthetic-account");

  const later = at(19) + 4 * 60 * 60 * 1000;
  estimator.local([task({ current: completed, tokens: 200 })], later, 5 * 60 * 60 * 1000);
  estimator.quota(quota(13.7), later, "synthetic-account");

  const row = latestRow(estimator, task({ current: completed, tokens: 200 }), later);
  assert.ok(Math.abs(row.totalEstimatedPercent - 3.7) < 1e-12);
  assert.equal(row.latestTurnEstimatedPercent, null);
  const allocation = estimator.state.rollingAllocations.find((event) => event.id === "task");
  assert.equal(allocation.turnKey, null);
  assert.equal(allocation.turnPercent, null);
});

test("a bad timestamped turn tag is detached while task usage and official attribution remain", () => {
  const completed = turn({ id: "turn-old", startedAt: at(0), completedAt: at(19), status: "idle" });
  const terminal = task({ current: completed, tokens: 100 });
  const estimator = new Estimator();
  estimator.local([terminal], at(19));
  estimator.quota(quota(10), at(19), "synthetic-account");
  const key = estimator.state.latestTurns.task.key;
  const observedAt = at(3600);
  const repairAt = at(3602);
  estimator.state.rollingAllocations.push({
    at: observedAt,
    id: "task",
    startAt: at(3600),
    endAt: at(3601),
    percent: 3,
    tokens: 300,
    turnKey: key,
    turnPercent: 3,
    quotaIdentity: "synthetic-account:weekly",
    attributionEventId: "quota:synthetic:bad-tag",
    coverage: "timestamped-token-interval",
  });
  estimator.state.rollingQuotaEvents.push({
    id: "quota:synthetic:bad-tag",
    at: observedAt,
    percent: 3,
    attributedPercent: 3,
    unattributedPercent: 0,
    quotaIdentity: "synthetic-account:weekly",
    coverage: "official-quota-sample",
  });

  estimator.local([terminal], repairAt);
  const allocation = estimator.state.rollingAllocations.find((event) => event.percent === 3);
  assert.equal(allocation.turnKey, null);
  assert.equal(allocation.turnPercent, null);
  assert.equal(allocation.tokens, 300);
  assert.equal(estimator.rollingAttribution(repairAt).attributedPercent, 3);
  assert.equal(latestRow(estimator, terminal, repairAt).totalEstimatedPercent, 3);
  assert.equal(latestRow(estimator, terminal, repairAt).latestTurnEstimatedPercent, null);
});

test("a no-range official tick is not invalidated by a later projection time", () => {
  const completed = turn({ id: "turn-old", startedAt: at(0), completedAt: at(19), status: "idle" });
  const terminal = task({ current: completed, tokens: 100 });
  const estimator = new Estimator();
  estimator.local([terminal], at(19));
  const key = estimator.state.latestTurns.task.key;
  const observedAt = at(3600);
  estimator.state.rollingAllocations.push({
    at: observedAt,
    id: "task",
    percent: 1,
    tokens: 100,
    turnKey: key,
    turnPercent: 1,
    coverage: "timestamped-quota-sample",
  });
  estimator.local([terminal], at(3601));
  assert.equal(estimator.state.rollingAllocations[0].turnKey, key);
  assert.equal(estimator.state.rollingAllocations[0].turnPercent, 1);
});

test("a late final token confirmation stays on the completed turn within the grace window", () => {
  const active = turn({ id: "turn-late", startedAt: at(0), status: "active" });
  const completed = turn({ id: "turn-late", startedAt: at(0), completedAt: at(19), status: "idle" });
  const estimator = new Estimator();
  estimator.local([task({ current: active, tokens: 100 })], at(0));
  estimator.quota(quota(10), at(0), "synthetic-account");
  estimator.local([task({ current: active, tokens: 100 })], at(14));
  estimator.local([task({ current: completed, tokens: 200 })], at(21));
  estimator.quota(quota(11), at(21), "synthetic-account");

  const row = latestRow(estimator, task({ current: completed, tokens: 200 }), at(21));
  assert.equal(row.latestTurnEstimatedPercent, 1);
  const allocation = estimator.state.rollingAllocations.find((event) => event.id === "task");
  assert.equal(allocation.turnKey, estimator.state.latestTurns.task.key);
  assert.deepEqual([allocation.startAt, allocation.endAt], [at(14), at(19)]);
});

test("a wholly post-completion range inside the grace window stays task-scoped", () => {
  const completed = turn({ id: "turn-old", startedAt: at(0), completedAt: at(19), status: "idle" });
  const terminal = task({ current: completed, tokens: 100 });
  const estimator = new Estimator();
  estimator.local([terminal], at(19));
  estimator.quota(quota(10), at(19), "synthetic-account");
  estimator.local([task({ current: completed, tokens: 100 })], at(20));
  const later = task({ current: completed, tokens: 200 });
  estimator.local([later], at(28));
  estimator.quota(quota(11), at(28), "synthetic-account");

  assert.equal(latestRow(estimator, later, at(28)).latestTurnEstimatedPercent, null);
  assert.equal(estimator.state.rollingAllocations.at(-1).turnKey, null);
});

test("an old tag is reassociated to a uniquely contained current turn without losing its amount", () => {
  const oldTurn = turn({ id: "turn-old", startedAt: at(0), completedAt: at(19), status: "idle" });
  const oldTask = task({ current: oldTurn, tokens: 100 });
  const estimator = new Estimator();
  estimator.local([oldTask], at(19));
  estimator.quota(quota(10), at(19), "synthetic-account");
  const oldKey = estimator.state.latestTurns.task.key;
  estimator.state.rollingAllocations.push({
    at: at(25),
    id: "task",
    startAt: at(20),
    endAt: at(25),
    percent: 3,
    tokens: 300,
    turnKey: oldKey,
    turnPercent: 3,
    quotaIdentity: "synthetic-account:weekly",
    coverage: "timestamped-token-interval",
  });

  const current = turn({ id: "turn-new", startedAt: at(20), status: "active" });
  const currentTask = task({ current, history: [oldTurn, current], tokens: 100 });
  estimator.local([currentTask], at(25));
  const allocation = estimator.state.rollingAllocations.find((event) => event.percent === 3);
  assert.equal(allocation.turnKey, estimator.state.latestTurns.task.key);
  assert.equal(allocation.turnPercent, 3);
  assert.equal(allocation.tokens, 300);
  const row = latestRow(estimator, currentTask, at(25));
  assert.equal(row.totalEstimatedPercent, 3);
  assert.equal(row.latestTurnEstimatedPercent, 3);
});

test("a token range crossing turns remains task-scoped, then future current-turn samples can attach", () => {
  const oldTurn = turn({ id: "turn-old", startedAt: at(0), completedAt: at(10), status: "idle" });
  const oldProjection = turn({ id: "turn-old", startedAt: at(0), status: "active" });
  const newTurn = turn({ id: "turn-new", startedAt: at(20), status: "active" });
  const estimator = new Estimator();
  estimator.local([task({ current: oldProjection, tokens: 0 })], at(5));
  estimator.quota(quota(10), at(5), "synthetic-account");

  const crossed = task({ current: newTurn, history: [oldTurn, newTurn], tokens: 100 });
  estimator.local([crossed], at(25));
  estimator.quota(quota(11), at(25), "synthetic-account");
  let row = latestRow(estimator, crossed, at(25));
  assert.equal(row.totalEstimatedPercent, 1);
  assert.equal(row.latestTurnEstimatedPercent, null);
  assert.equal(estimator.state.rollingAllocations.at(-1).turnKey, null);

  const future = task({ current: newTurn, history: [oldTurn, newTurn], tokens: 150 });
  estimator.local([future], at(30));
  estimator.quota(quota(12), at(30), "synthetic-account");
  row = latestRow(estimator, future, at(30));
  assert.equal(row.totalEstimatedPercent, 2);
  assert.equal(row.latestTurnEstimatedPercent, 1);
  assert.equal(estimator.state.rollingAllocations.at(-1).turnKey, estimator.state.latestTurns.task.key);
});
