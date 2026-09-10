import test from "node:test";
import assert from "node:assert/strict";
import { Estimator } from "../server/metrics.mjs";
const now = 1800000000000;
const row = (id, tokens, status = "active", extra = {}) => ({
  id,
  title: id,
  model: "gpt-5.6-terra",
  reasoningEffort: "medium",
  status,
  tokens,
  startedAt: now,
  ...extra,
});
const quota = (used = 10, reset = now + 100000) => ({
  id: "codex:primary",
  bucket: "codex",
  windowMinutes: 10080,
  planType: "pro",
  usedPercent: used,
  remainingPercent: 100 - used,
  resetsAt: reset,
});
function sampled() {
  const e = new Estimator();
  e.local(
    [
      row("root", 0),
      row("child", 0, "active", { parentThreadId: "root" }),
      row("old", 500, "idle", {
        startedAt: now - 100000,
        completedAt: now - 50000,
      }),
    ],
    now,
  );
  e.quota(quota(), now, "account");
  e.local(
    [
      row("root", 100),
      row("child", 100, "active", { parentThreadId: "root" }),
      row("old", 500, "idle", {
        startedAt: now - 100000,
        completedAt: now - 50000,
      }),
    ],
    now + 60000,
  );
  e.quota(quota(11), now + 60000, "account");
  return e;
}
test("root and child metrics do not double-count concurrent processing time", () => {
  const e = sampled();
  const s = e.sessions(
    [
      row("root", 100),
      row("child", 100, "active", { parentThreadId: "root" }),
      row("old", 500, "idle"),
    ],
    now + 60000,
  );
  const root = s.find((r) => r.id === "root");
  assert.equal(root.estimatedPercent, 1);
  assert.equal(root.ownEstimatedPercent, 0.5);
  assert.equal(root.children[0].estimatedPercent, 0.5);
  assert.equal(root.observationSeconds, 60);
  assert.equal(root.averageSecondsPerPercent, 60);
  assert.equal(root.children[0].averageSecondsPerPercent, 120);
  assert.equal(s.find((r) => r.id === "old").estimatedPercent, null);
});
test("completed threads keep measured averages and do not show future rates", () => {
  const e = sampled();
  const finished = [
    row("root", 100, "idle", { completedAt: now + 60000 }),
    row("child", 100, "idle", {
      parentThreadId: "root",
      completedAt: now + 60000,
    }),
  ];
  e.local(finished, now + 65000);
  const root = e.sessions(finished, now + 65000)[0];
  assert.equal(root.secondsPerPercent, null);
  assert.equal(root.averageSecondsPerPercent, 60);
  assert.equal(root.children[0].secondsPerPercent, null);
  assert.equal(root.children[0].averageSecondsPerPercent, 120);
});
test("account reset clears calibration but keeps retained observation and session allocations", () => {
  const e = sampled();
  e.quota(quota(0, now + 900000), now + 70000, "account");
  assert.equal(e.state.observedPercent, 1);
  assert.equal(e.state.calibratedTokens, 0);
  const root = e.sessions(
    [row("root", 100), row("child", 100, "active", { parentThreadId: "root" })],
    now + 70000,
  )[0];
  assert.equal(root.estimatedPercent, 1);
  assert.ok(root.secondsPerPercent > 0);
  assert.equal(root.averageSecondsPerPercent, 60);
});
test("switching account never reuses the previous account session ledger", () => {
  const e = sampled();
  e.quota(quota(11), now + 70000, "another-account");
  assert.equal(
    e.sessions([row("root", 100)], now + 70000)[0].estimatedPercent,
    null,
  );
});
test("legacy allocations without time evidence remain unavailable", () => {
  const e = new Estimator({ totals: { a: 0.125, old: 0 } });
  const s = e.sessions([row("a", 20, "idle"), row("old", 100, "idle")], now);
  assert.equal(s.find((t) => t.id === "a").estimatedPercent, null);
  assert.equal(s.find((t) => t.id === "a").averageSecondsPerPercent, null);
  assert.equal(s.find((t) => t.id === "old").estimatedPercent, null);
});
test("an offline gap is not counted as observed processing time", () => {
  const e = sampled();
  e.local(
    [
      row("root", 1000),
      row("child", 1000, "active", { parentThreadId: "root" }),
    ],
    now + 3600000,
    10000,
  );
  assert.equal(e.state.sessionLedger.root.activeSeconds, 60);
  assert.equal(e.state.groupObservationSeconds.root, 60);
  assert.equal(e.state.gap, true);
});
test("an idle root with an active child retains its own idle model rate status", () => {
  const e = sampled();
  const root = e.sessions(
    [
      row("root", 100, "idle", { completedAt: now + 60000 }),
      row("child", 100, "active", { parentThreadId: "root" }),
    ],
    now + 60000,
  )[0];
  assert.equal(root.status, "active");
  assert.equal(root.ownStatus, "idle");
  assert.equal(root.ownSecondsPerPercent, null);
});

test("temporarily missing plan metadata does not erase the same account history", () => {
  const e = sampled();
  e.quota({ ...quota(11), planType: null }, now + 70000, "account");
  assert.equal(
    e.sessions([row("root", 100)], now + 70000)[0].estimatedPercent,
    1,
  );
});

test("session order stays stable through input shuffles, status changes, gaps, new roots, and children", () => {
  const e = new Estimator();
  const rootA = row("root-a", 0, "active");
  const childA1 = row("child-a1", 0, "active", { parentThreadId: "root-a" });
  const rootB = row("root-b", 0, "active");
  const first = e.sessions([rootA, childA1, rootB], now);
  assert.deepEqual(first.map((session) => session.id), ["root-a", "root-b"]);
  assert.deepEqual(first[0].children.map((child) => child.id), ["child-a1"]);

  const childA2 = row("child-a2", 0, "idle", { parentThreadId: "root-a" });
  const rootAIdle = row("root-a", 0, "idle");
  const rootBIdle = row("root-b", 0, "idle");
  const rootC = row("root-c", 0, "active");
  const shuffled = e.sessions([rootC, rootBIdle, childA2, rootAIdle, childA1], now + 1000);
  assert.deepEqual(shuffled.map((session) => session.id), ["root-a", "root-c", "root-b"]);
  assert.deepEqual(shuffled[0].children.map((child) => child.id), ["child-a1", "child-a2"]);

  const missing = e.sessions([rootC, rootAIdle, childA2, childA1], now + 2000);
  assert.deepEqual(missing.map((session) => session.id), ["root-a", "root-c", "root-b"]);
  const restored = e.sessions([rootC, rootBIdle, rootAIdle, childA2, childA1], now + 3000);
  assert.deepEqual(restored.map((session) => session.id), ["root-a", "root-c", "root-b"]);
  assert.deepEqual(restored[0].children.map((child) => child.id), ["child-a1", "child-a2"]);
  assert.deepEqual(e.state.sessionOrder, ["root-a", "child-a1", "root-b", "root-c", "child-a2"]);

  const restarted = new Estimator(JSON.parse(JSON.stringify(e.state)));
  const afterRestart = restarted.sessions(
    [rootC, childA2, rootB, childA1, rootA],
    now + 4000,
  );
  assert.deepEqual(afterRestart.map((session) => session.id), ["root-a", "root-b", "root-c"]);
  assert.deepEqual(afterRestart[0].children.map((child) => child.id), ["child-a1", "child-a2"]);
});
