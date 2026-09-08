import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountDisplay,
  Estimator,
  mainWindow,
  normalizeWindows,
} from "../server/metrics.mjs";
import { Collector } from "../server/collector.mjs";
import { startService } from "../server/service.mjs";

const quota = {
  rateLimits: {
    limitId: "codex",
    planType: "pro",
    primary: {
      usedPercent: 16,
      windowDurationMins: 10080,
      resetsAt: 1789353023,
    },
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      planType: "pro",
      primary: {
        usedPercent: 16,
        windowDurationMins: 10080,
        resetsAt: 1789353023,
      },
    },
    codex_bengalfox: {
      limitId: "codex_bengalfox",
      primary: {
        usedPercent: 0,
        windowDurationMins: 300,
        resetsAt: 1788804008,
      },
    },
  },
};
const stub = () => ({
  init: async () => {},
  close: async () => {},
  snapshot: () => ({ settings: {}, account: {}, sessions: [] }),
});

test("Pro account balance is read directly, without a plan multiplier or local token denominator", () => {
  const a = accountDisplay(quota, 1000);
  assert.equal(a.summary.usedPercent, 16);
  assert.equal(a.summary.remainingPercent, 84);
  assert.equal(a.plan.type, "pro");
  assert.equal(a.plan.multiplier, null);
  assert.equal(a.summary.windowMinutes, 10080);
  assert.equal(a.summary.resetsAt, 1789353023000);
  const china = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(a.summary.resetsAt));
  assert.match(china, /2026-09-14/);
  assert.match(china, /10:30:23/);
});
test("a partial multi-bucket window does not erase the legacy weekly account window", () => {
  const r = {
    rateLimits: quota.rateLimits,
    rateLimitsByLimitId: {
      codex: {
        primary: {
          usedPercent: 2,
          windowDurationMins: 300,
          resetsAt: 1788804008,
        },
      },
    },
  };
  const windows = normalizeWindows(r);
  assert.equal(windows.length, 2);
  assert.equal(mainWindow(windows).remainingPercent, 84);
});
test("group elapsed time follows active children when parent is idle", () => {
  const now = Date.now();
  const e = new Estimator();
  const s = e.sessions(
    [
      {
        id: "root",
        status: "idle",
        startedAt: now - 600000,
        completedAt: now - 100000,
        tokens: 1,
      },
      {
        id: "child",
        parentThreadId: "root",
        status: "active",
        startedAt: now - 30000,
        tokens: 1,
      },
    ],
    now,
  );
  assert.equal(s[0].elapsedSeconds, 30);
});
test("failed quota reads mark a gap and stop stale reset predictions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-gap-test-"));
  let failing = false;
  const client = {
    request: async (method) => {
      if (method === "account/rateLimits/read") {
        if (failing) throw new Error("offline");
        return quota;
      }
      return { data: [] };
    },
    close: async () => {},
  };
  const c = new Collector({resetFetcher: null,
    dataDir: dir,
    reader: { read: () => ({ threads: [], diagnostics: {} }) },
    client,
  });
  try {
    await c.remote();
    assert.equal(c.snapshot().account.summary.remainingPercent, 84);
    assert.equal(c.snapshot().attribution.estimatedPercent, 0);
    failing = true;
    await c.remote();
    assert.equal(c.estimator.state.gap, true);
    assert.equal(c.snapshot().account.stale, true);
    assert.equal(c.snapshot().reset.scheduledAt, null);
    assert.equal(c.snapshot().reset.exhaustionAt, null);
  } finally {
    await c.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("real service endpoint and token survive a clean restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-endpoint-test-"));
  let a, b;
  try {
    a = await startService({ dataDir: dir, collector: stub() });
    const first = { port: a.port, token: a.token };
    await a.close();
    b = await startService({ dataDir: dir, collector: stub() });
    assert.equal(b.port, first.port);
    assert.equal(b.token, first.token);
    const h = await (
      await fetch(`http://127.0.0.1:${b.port}/api/health`, {
        headers: { "X-Quota-Token": b.token },
      })
    ).json();
    assert.equal(h.mode, "live");
    assert.equal(h.dataSchema, 2);
  } finally {
    await a?.close();
    await b?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("demo uses separate state and credentials and cannot change settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-demo-isolation-"));
  let real, demo;
  try {
    real = await startService({ dataDir: dir, collector: stub() });
    demo = await startService({ dataDir: dir, demo: true, collector: stub() });
    assert.notEqual(real.port, demo.port);
    assert.notEqual(real.token, demo.token);
    const record = JSON.parse(
      await readFile(join(dir, "demo", "runtime.json"), "utf8"),
    );
    assert.equal(record.mode, "demo");
    const base = `http://127.0.0.1:${demo.port}`;
    const headers = { "X-Quota-Token": demo.token };
    const s = await (await fetch(base + "/api/snapshot", { headers })).json();
    assert.equal(s.mode, "demo");
    const post = await fetch(base + "/api/settings", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: '{"autoSwitch":true}',
    });
    assert.equal(post.status, 403);
    assert.equal(
      (await fetch(`http://127.0.0.1:${real.port}/api/snapshot`, { headers }))
        .status,
      403,
    );
  } finally {
    await real?.close();
    await demo?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
