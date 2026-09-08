import test from "node:test";
import assert from "node:assert/strict";

import { Estimator } from "../server/metrics.mjs";

const base = 1_800_000_000_000;
const at = (seconds) => base + seconds * 1000;
const quota = (used = 10, reset = at(1_000)) => ({
  id: "codex:primary",
  bucket: "codex",
  windowMinutes: 10080,
  planType: "pro",
  usedPercent: used,
  remainingPercent: 100 - used,
  resetsAt: reset,
});

function historyTurn(id, startedAt, completedAt, status = "idle") {
  return {
    turnId: id,
    startedAt: at(startedAt),
    completedAt: completedAt === null ? null : at(completedAt),
    durationMs: completedAt === null ? null : (completedAt - startedAt) * 1000,
    status,
  };
}

function thread({
  id,
  parentThreadId = null,
  turnId = `${id}-turn`,
  startedAt = 0,
  completedAt = null,
  status = "active",
  tokens = 0,
  history = [],
  updatedAt = null,
  durationMs = null,
}) {
  const executionHistory = history.length
    ? {
        turns: history,
        intervals: history
          .filter((turn) => turn.status === "idle" && turn.completedAt > turn.startedAt)
          .map((turn) => [turn.startedAt, turn.completedAt]),
        coverage: "local-records",
      }
    : undefined;
  return {
    id,
    title: id,
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    status,
    startedAt: startedAt === null ? null : at(startedAt),
    completedAt: completedAt === null ? null : at(completedAt),
    updatedAt: at(updatedAt ?? completedAt ?? startedAt ?? 0),
    tokens,
    parentThreadId,
    activityEvidence: {
      turnId,
      ...(durationMs === null ? {} : { lastTurnDurationMs: durationMs }),
    },
    ...(executionHistory ? { executionHistory } : {}),
  };
}

function seed(rows) {
  const e = new Estimator();
  e.local(rows, at(0));
  e.quota(quota(), at(0), "account");
  return e;
}

function session(e, rows, seconds) {
  return e.sessions(rows, at(seconds))[0];
}

test("one-turn root and child share latest family totals while own metrics stay separate", () => {
  const initial = [
    thread({ id: "root", startedAt: 0 }),
    thread({ id: "child", parentThreadId: "root", startedAt: 5 }),
  ];
  const e = seed(initial);
  const current = [
    thread({ id: "root", startedAt: 0, tokens: 100 }),
    thread({ id: "child", parentThreadId: "root", startedAt: 5, tokens: 100 }),
  ];
  e.local(current, at(30));
  e.quota(quota(11), at(30), "account");

  const root = session(e, current, 30);
  const child = root.children[0];
  assert.equal(root.totalEstimatedPercent, 1);
  assert.equal(root.latestTurnEstimatedPercent, root.totalEstimatedPercent);
  assert.equal(root.ownLatestTurnEstimatedPercent, 0.5);
  assert.equal(root.latestTurnChildCount, 1);
  assert.equal(root.latestTurnStartedAt, at(0));
  assert.equal(root.latestTurnStatus, "active");
  assert.equal(root.latestTurnElapsedSeconds, 30);
  assert.equal(child.latestTurnEstimatedPercent, 0.5);
  assert.equal(child.ownLatestTurnEstimatedPercent, 0.5);
});

test("a child turn that started before the parent's current turn is excluded even while it overlaps", () => {
  const e = seed([
    thread({ id: "root", turnId: "root-old", startedAt: 0 }),
    thread({ id: "child", parentThreadId: "root", turnId: "child-old", startedAt: 0 }),
  ]);
  e.local([
    thread({ id: "root", turnId: "root-old", startedAt: 0, tokens: 100 }),
    thread({ id: "child", parentThreadId: "root", turnId: "child-old", startedAt: 0, tokens: 100 }),
  ], at(10));
  e.quota(quota(11), at(10), "account");

  e.local([
    thread({ id: "root", turnId: "root-new", startedAt: 20, tokens: 100 }),
    thread({ id: "child", parentThreadId: "root", turnId: "child-old", startedAt: 0, tokens: 100 }),
  ], at(20));

  const current = [
    thread({ id: "root", turnId: "root-new", startedAt: 20, tokens: 200 }),
    thread({ id: "child", parentThreadId: "root", turnId: "child-old", startedAt: 0, tokens: 200 }),
  ];
  e.local(current, at(30));
  e.quota(quota(12), at(30), "account");

  const root = session(e, current, 30);
  assert.equal(root.latestTurnChildCount, 0);
  assert.equal(root.latestTurnEstimatedPercent, 0.5);
  assert.equal(root.ownLatestTurnEstimatedPercent, 0.5);
});

test("a reused child contributes only the new turn inside the parent's latest turn", () => {
  const e = seed([
    thread({ id: "root", turnId: "root-old", startedAt: 0 }),
    thread({ id: "child", parentThreadId: "root", turnId: "child-old", startedAt: 0 }),
  ]);
  e.local([
    thread({ id: "root", turnId: "root-old", startedAt: 0, completedAt: 10, status: "idle", tokens: 100 }),
    thread({ id: "child", parentThreadId: "root", turnId: "child-old", startedAt: 0, completedAt: 10, status: "idle", tokens: 100 }),
  ], at(10));
  e.quota(quota(11), at(10), "account");
  e.local([
    thread({ id: "root", turnId: "root-new", startedAt: 20, tokens: 100 }),
    thread({ id: "child", parentThreadId: "root", turnId: "child-new", startedAt: 25, tokens: 100 }),
  ], at(20));

  const current = [
    thread({ id: "root", turnId: "root-new", startedAt: 20, tokens: 200 }),
    thread({
      id: "child",
      parentThreadId: "root",
      turnId: "child-new",
      startedAt: 25,
      tokens: 200,
      history: [historyTurn("child-old", 0, 10)],
    }),
  ];
  e.local(current, at(30));
  e.quota(quota(12), at(30), "account");

  const root = session(e, current, 30);
  const child = root.children[0];
  assert.equal(root.latestTurnChildCount, 1);
  assert.equal(root.latestTurnEstimatedPercent, 1);
  assert.equal(child.totalEstimatedPercent, 1);
  assert.equal(child.latestTurnEstimatedPercent, 0.5);
});

test("multiple child follow-ups inside one parent turn are all included once", () => {
  const e = seed([
    thread({ id: "root", startedAt: 0 }),
    thread({ id: "child", parentThreadId: "root", turnId: "child-1", startedAt: 10 }),
  ]);
  e.local([
    thread({ id: "root", startedAt: 0, tokens: 100 }),
    thread({ id: "child", parentThreadId: "root", turnId: "child-1", startedAt: 10, completedAt: 20, status: "idle", tokens: 100 }),
  ], at(20));
  e.quota(quota(11), at(20), "account");
  e.local([
    thread({ id: "root", startedAt: 0, tokens: 100 }),
    thread({
      id: "child",
      parentThreadId: "root",
      turnId: "child-2",
      startedAt: 30,
      history: [historyTurn("child-1", 10, 20)],
      tokens: 100,
    }),
  ], at(30));
  e.local([
    thread({ id: "root", startedAt: 0, tokens: 200 }),
    thread({
      id: "child",
      parentThreadId: "root",
      turnId: "child-2",
      startedAt: 30,
      completedAt: 40,
      status: "idle",
      history: [historyTurn("child-1", 10, 20)],
      tokens: 200,
    }),
  ], at(40));
  e.quota(quota(12), at(40), "account");
  e.local([
    thread({ id: "root", startedAt: 0, tokens: 200 }),
    thread({
      id: "child",
      parentThreadId: "root",
      turnId: "child-3",
      startedAt: 50,
      history: [historyTurn("child-1", 10, 20), historyTurn("child-2", 30, 40)],
      tokens: 200,
    }),
  ], at(50));
  const current = [
    thread({ id: "root", startedAt: 0, tokens: 300 }),
    thread({
      id: "child",
      parentThreadId: "root",
      turnId: "child-3",
      startedAt: 50,
      history: [historyTurn("child-1", 10, 20), historyTurn("child-2", 30, 40)],
      tokens: 300,
    }),
  ];
  e.local(current, at(100));
  e.quota(quota(13), at(100), "account");

  const root = session(e, current, 100);
  const child = root.children[0];
  assert.equal(root.latestTurnChildCount, 1);
  assert.equal(root.latestTurnEstimatedPercent, 3);
  assert.equal(root.ownLatestTurnEstimatedPercent, 1.5);
  assert.equal(child.totalEstimatedPercent, 1.5);
  assert.equal(child.latestTurnEstimatedPercent, 0.5);
});

test("a nested grandchild is counted once and descendants stay flat", () => {
  const current = [
    thread({ id: "root", startedAt: 0, tokens: 100 }),
    thread({ id: "child", parentThreadId: "root", startedAt: 5, tokens: 100 }),
    thread({ id: "grandchild", parentThreadId: "child", startedAt: 10, tokens: 100 }),
  ];
  const e = seed(current.map((row) => ({ ...row, tokens: 0 })));
  e.local(current, at(30));
  e.quota(quota(11), at(30), "account");

  const root = session(e, current, 30);
  const child = root.children.find((row) => row.id === "child");
  const grandchild = root.children.find((row) => row.id === "grandchild");
  assert.equal(root.childCount, 2);
  assert.deepEqual(new Set(root.children.map((row) => row.id)), new Set(["child", "grandchild"]));
  assert.equal(root.totalEstimatedPercent, 1);
  assert.equal(root.latestTurnEstimatedPercent, 1);
  assert.ok(Math.abs(child.totalEstimatedPercent - 2 / 3) < 1e-12);
  assert.ok(Math.abs(child.latestTurnEstimatedPercent - 2 / 3) < 1e-12);
  assert.equal(child.ownEstimatedPercent, 1 / 3);
  assert.equal(child.ownLatestTurnEstimatedPercent, 1 / 3);
  assert.equal(grandchild.totalEstimatedPercent, 1 / 3);
  assert.equal(grandchild.latestTurnEstimatedPercent, 1 / 3);
});

test("a child that outlives a completed parent keeps the latest family active", () => {
  const initial = [
    thread({ id: "root", startedAt: 0 }),
    thread({ id: "child", parentThreadId: "root", startedAt: 10 }),
  ];
  const e = seed(initial);
  const current = [
    thread({ id: "root", startedAt: 0, completedAt: 50, status: "idle", tokens: 100 }),
    thread({ id: "child", parentThreadId: "root", startedAt: 10, tokens: 100 }),
  ];
  e.local(current, at(100));
  e.quota(quota(11), at(100), "account");

  const root = session(e, current, 100);
  assert.equal(root.status, "active");
  assert.equal(root.latestTurnStatus, "active");
  assert.equal(root.latestTurnChildCount, 1);
  assert.equal(root.latestTurnElapsedSeconds, 100);
  assert.equal(root.latestTurnEstimatedPercent, 1);
});

test("completed latest family uses merged elapsed time divided by family quota", () => {
  const initial = [
    thread({ id: "root", startedAt: 0 }),
    thread({ id: "child", parentThreadId: "root", startedAt: 20 }),
  ];
  const e = seed(initial);
  const current = [
    thread({ id: "root", startedAt: 0, completedAt: 100, status: "idle", tokens: 100 }),
    thread({ id: "child", parentThreadId: "root", startedAt: 20, completedAt: 80, status: "idle", tokens: 100 }),
  ];
  e.local(current, at(100));
  e.quota(quota(11), at(100), "account");

  const root = session(e, current, 100);
  assert.equal(root.latestTurnStatus, "idle");
  assert.equal(root.latestTurnElapsedSeconds, 100);
  assert.equal(root.latestTurnEstimatedPercent, 1);
  assert.equal(root.latestTurnSecondsPerPercent, 100);
  assert.equal(root.latestTurnRateSource, "family-turn-completed-fallback");
});

test("running latest family prefers combined five-second calibration, then family elapsed fallback", () => {
  const initial = [
    thread({ id: "root", startedAt: 0 }),
    thread({ id: "child", parentThreadId: "root", startedAt: 0 }),
  ];
  const e = seed(initial);
  const atFive = [
    thread({ id: "root", startedAt: 0, tokens: 100 }),
    thread({ id: "child", parentThreadId: "root", startedAt: 0, tokens: 100 }),
  ];
  e.local(atFive, at(5));
  e.quota(quota(11), at(5), "account");
  const current = [
    thread({ id: "root", startedAt: 0, tokens: 200 }),
    thread({ id: "child", parentThreadId: "root", startedAt: 0, tokens: 200 }),
  ];
  e.local(current, at(10));
  const calibrated = session(e, current, 10);
  assert.equal(calibrated.latestTurnRateSource, "family-recent-token-calibrated");
  assert.equal(calibrated.latestTurnSecondsPerPercent, 5);

  const fallback = seed(initial);
  const longRun = [
    thread({ id: "root", startedAt: 0, tokens: 100 }),
    thread({ id: "child", parentThreadId: "root", startedAt: 0, tokens: 100 }),
  ];
  fallback.local(longRun, at(30));
  fallback.quota(quota(11), at(30), "account");
  const average = session(fallback, longRun, 30);
  assert.equal(average.latestTurnRateSource, "family-turn-average-fallback");
  assert.equal(average.latestTurnSecondsPerPercent, 30);
});

test("a delayed quota tick includes two selected child executions once when the pending range spans both", () => {
  const e = seed([
    thread({ id: "root", startedAt: 0 }),
    thread({ id: "child", parentThreadId: "root", turnId: "child-1", startedAt: 0, status: "unknown" }),
  ]);
  e.local([
    thread({ id: "root", startedAt: 0 }),
    thread({ id: "child", parentThreadId: "root", turnId: "child-1", startedAt: 0, tokens: 100 }),
  ], at(10));
  const current = [
    thread({ id: "root", startedAt: 0 }),
    thread({
      id: "child",
      parentThreadId: "root",
      turnId: "child-2",
      startedAt: 10,
      tokens: 200,
      history: [historyTurn("child-1", 0, 10)],
    }),
  ];
  e.local(current, at(20));
  e.quota(quota(11), at(30), "account");

  const root = session(e, current, 30);
  assert.equal(root.latestTurnChildCount, 1);
  assert.equal(root.latestTurnEstimatedPercent, 1);
  assert.equal(root.children[0].latestTurnEstimatedPercent, null);
});

test("child usage from a selected earlier turn survives a future child turn after parent completion", () => {
  const e = seed([
    thread({ id: "root", startedAt: 0 }),
    thread({ id: "child", parentThreadId: "root", turnId: "child-old", startedAt: 10 }),
  ]);
  e.local([
    thread({ id: "root", startedAt: 0, tokens: 100 }),
    thread({ id: "child", parentThreadId: "root", turnId: "child-old", startedAt: 10, completedAt: 40, status: "idle", tokens: 100 }),
  ], at(40));
  e.quota(quota(11), at(40), "account");
  const current = [
    thread({ id: "root", startedAt: 0, completedAt: 50, status: "idle", tokens: 100 }),
    thread({
      id: "child",
      parentThreadId: "root",
      turnId: "child-future",
      startedAt: 60,
      history: [historyTurn("child-old", 10, 40)],
      tokens: 100,
    }),
  ];
  e.local(current, at(70));

  const root = session(e, current, 70);
  assert.equal(root.latestTurnChildCount, 1);
  assert.equal(root.latestTurnEstimatedPercent, 1);
  assert.equal(root.children[0].latestTurnEstimatedPercent, null);
});

test("completed parent upper bound is exclusive and unknown starts sort last with stable ties", () => {
  const boundary = session(new Estimator(), [
    thread({ id: "root", startedAt: 0, completedAt: 50, status: "idle" }),
    thread({ id: "child", parentThreadId: "root", startedAt: 50 }),
  ], 70);
  assert.equal(boundary.latestTurnChildCount, 0);

  const e = new Estimator();
  const oldActive = thread({ id: "old-active", startedAt: 0 });
  const newIdle = thread({ id: "new-idle", startedAt: 10, completedAt: 15, status: "idle" });
  const unknown = thread({ id: "unknown", startedAt: null, status: "unknown", updatedAt: 20 });
  const first = e.sessions([oldActive, newIdle, unknown], at(20));
  const tieA = thread({ id: "tie-a", startedAt: 20 });
  const tieB = thread({ id: "tie-b", startedAt: 20 });
  const firstWithTies = e.sessions([oldActive, newIdle, unknown, tieA, tieB], at(20));
  assert.deepEqual(first.map((row) => row.id), ["new-idle", "old-active", "unknown"]);
  assert.deepEqual(firstWithTies.map((row) => row.id), ["tie-a", "tie-b", "new-idle", "old-active", "unknown"]);
  const second = e.sessions([tieB, tieA, unknown, newIdle, oldActive], at(20));
  assert.deepEqual(second.map((row) => row.id), ["tie-a", "tie-b", "new-idle", "old-active", "unknown"]);
});
