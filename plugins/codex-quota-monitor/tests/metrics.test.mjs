import test from "node:test";
import assert from "node:assert/strict";
import {
  Estimator,
  normalizeWindows,
  mainWindow,
  groupThreads,
} from "../server/metrics.mjs";
const now = 1_800_000_000_000;
const thread = (id, tokens, status = "active", extra = {}) => ({
  id,
  title: id,
  tokens,
  status,
  model: "gpt-5.6-terra",
  startedAt: now - 60000,
  ...extra,
});
const window = (used = 10, reset = now + 100000) => ({
  id: "codex:primary",
  bucket: "codex",
  label: "周",
  usedPercent: used,
  remainingPercent: 100 - used,
  resetsAt: reset,
  windowMinutes: 10080,
});
test("windows preserve multiple buckets, nulls and official durations", () => {
  const ws = normalizeWindows(
    {
      rateLimitsByLimitId: {
        codex: {
          primary: {
            usedPercent: 10,
            windowDurationMins: 10080,
            resetsAt: 1900000000,
          },
        },
        spark: {
          primary: {
            usedPercent: 0,
            windowDurationMins: 300,
            resetsAt: 1900000000,
          },
          secondary: { usedPercent: null },
        },
      },
    },
    now,
  );
  assert.equal(ws.length, 2);
  assert.equal(mainWindow(ws).windowMinutes, 10080);
  assert.equal(ws[0].resetsAt, 1900000000000);
  assert.equal(mainWindow(ws.filter((w) => w.bucket === "spark")), null);
});
test("startup is uncalibrated; zero-change samples accumulate until account ticks", () => {
  const e = new Estimator();
  e.local([thread("a", 100), thread("b", 100)], now);
  e.quota(window(), now, "account");
  assert.equal(e.sessions([thread("a", 100)], now)[0].estimatedPercent, null);
  e.local([thread("a", 200), thread("b", 150)], now + 30000);
  e.quota(window(), now + 30000, "account");
  e.local([thread("a", 300), thread("b", 200)], now + 60000);
  e.quota(window(11), now + 60000, "account");
  assert.equal(e.state.observedPercent, 1);
  assert.ok(Math.abs(e.state.totals.a - 2 / 3) < 1e-12);
  assert.ok(Math.abs(e.state.totals.b - 1 / 3) < 1e-12);
  e.local([thread("a", 400), thread("b", 250)], now + 90000);
  assert.ok(
    e.sessions([thread("a", 400)], now + 90000)[0].secondsPerPercent > 0,
  );
});
test("unobserved account usage stays in the retention ledger across a quota reset", () => {
  const e = new Estimator();
  e.quota(window(10), now, "one");
  e.quota(window(11), now + 1000, "one");
  assert.equal(e.state.unattributedPercent, 1);
  e.quota(window(1), now + 2000, "one");
  assert.equal(e.state.observedPercent, 1);
  assert.equal(e.state.unattributedPercent, 1);
  assert.deepEqual(e.state.totals, {});
  e.quota(window(20), now + 3000, "two");
  assert.equal(e.state.observedPercent, 0);
});
test("reset timestamp change invalidates calibration even when used percentage rises", () => {
  const e = new Estimator();
  e.local([thread("a", 0)], now);
  e.quota(window(), now, "one");
  e.local([thread("a", 100)], now + 30000);
  e.quota(window(11), now + 30000, "one");
  e.quota(window(20, now + 200000), now + 60000, "one");
  assert.equal(e.state.calibratedTokens, 0);
});
test("children fold into root without double counting; Spark stays outside main allocation", () => {
  const e = new Estimator();
  const rows = [
    thread("root", 0, "idle"),
    thread("child", 0, "active", { parentThreadId: "root" }),
    thread("spark", 0, "active", { model: "gpt-5.3-codex-spark" }),
  ];
  e.local(rows, now);
  e.quota(window(), now, "one");
  const next = rows.map((r) => ({ ...r, tokens: 100 }));
  e.local(next, now + 30000);
  e.quota(window(11), now + 30000, "one");
  const s = e.sessions(next, now + 30000);
  assert.equal(s.length, 2);
  assert.equal(s.find((x) => x.id === "root").estimatedPercent, 1);
  assert.equal(s.find((x) => x.id === "root").status, "active");
  assert.equal(s.find((x) => x.id === "spark").estimatedPercent, null);
  assert.equal(groupThreads(rows)[0].childCount, 1);
});
test("idle tasks have no future rate while silent active turns use their average", () => {
  const e = new Estimator();
  e.local([thread("a", 0)], now);
  e.quota(window(), now, "one");
  e.local([thread("a", 100)], now + 30000);
  e.quota(window(11), now + 30000, "one");
  assert.equal(
    e.sessions([thread("a", 100, "idle")], now + 30000)[0].secondsPerPercent,
    null,
  );
  e.local([thread("a", 100)], now + 200000);
  const active = e.sessions([thread("a", 100)], now + 200000)[0];
  assert.equal(active.secondsPerPercent, 260);
  assert.equal(active.rateSource, "aggregate-active-task-rates");
  assert.equal(active.latestTurnRateSource, "turn-average-fallback");
});
test("restart preserves totals but attributes offline account changes to unknown usage", () => {
  const e = new Estimator();
  e.local([thread("a", 0)], now);
  e.quota(window(), now, "one");
  e.local([thread("a", 100)], now + 30000);
  e.quota(window(11), now + 30000, "one");
  const next = new Estimator(JSON.parse(JSON.stringify(e.state)));
  next.state.gap = true;
  next.state.pending = { a: 100 };
  next.quota(window(13), now + 100000, "one");
  assert.equal(next.state.totals.a, 1);
  assert.equal(next.state.unattributedPercent, 2);
  assert.deepEqual(next.state.pending, {});
});
test("empty multi-bucket response falls back to the valid legacy quota window", () => {
  assert.equal(
    normalizeWindows({
      rateLimitsByLimitId: {},
      rateLimits: {
        primary: {
          usedPercent: 1,
          windowDurationMins: 10080,
          resetsAt: 1900000000,
        },
      },
    }).length,
    1,
  );
});
