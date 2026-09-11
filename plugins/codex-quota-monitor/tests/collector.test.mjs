import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Collector } from "../server/collector.mjs";
const models = ["gpt-5.6-luna", "gpt-5.6-terra"].map((model) => ({
  model,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
}));
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "quota-collector-"));
  let defaults = { model: "original-model", model_reasoning_effort: "high" },
    writes = [],
    writing = 0,
    peak = 0;
  const client = {
    request: async (method) => {
      if (method === "config/read")
        return {
          layers: [
            {
              name: { type: "user" },
              config: { ...defaults },
              version: "current-version",
            },
          ],
        };
      if (method === "account/rateLimits/read")
        return {
          rateLimits: {
            primary: {
              usedPercent: 1,
              windowDurationMins: 10080,
              resetsAt: 1900000000,
            },
          },
        };
      if (method === "model/list") return { data: models };
      return {};
    },
    writeDefaults: async (edits, options) => {
      assert.equal(options.authorized, true);
      assert.equal(options.expectedVersion, "current-version");
      writing++;
      peak = Math.max(peak, writing);
      await new Promise((resolve) => setTimeout(resolve, 5));
      for (const edit of edits) defaults[edit.keyPath] = edit.value;
      writes.push(edits);
      writing--;
    },
    close: async () => {},
  };
  const c = new Collector({resetFetcher: null,
    dataDir: dir,
    reader: { read: () => ({ threads: [], diagnostics: {} }) },
    client,
  });
  c.models = models;
  c.refreshRecommendation();
  return {
    c,
    dir,
    writes,
    setDefaults: (d) => {
      defaults = d;
    },
    getDefaults: () => defaults,
    peak: () => peak,
    cleanup: async () => {
      await c.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("ordinary settings never write defaults; explicit opt-in can apply and restore exactly", async () => {
  const f = await fixture();
  try {
    await f.c.update({ pollSeconds: 10 });
    assert.equal(f.writes.length, 0);
    await f.c.update({ autoSwitch: true });
    assert.equal(f.getDefaults().model, "gpt-5.6-terra");
    await f.c.restoreDefaults();
    assert.equal(f.getDefaults().model, "original-model");
    assert.equal(f.getDefaults().model_reasoning_effort, "high");
    assert.equal(f.c.settings.autoSwitch, false);
  } finally {
    await f.cleanup();
  }
});
test("manual model changes stop automation when the target changes", async () => {
  const f = await fixture();
  try {
    await f.c.update({ autoSwitch: true });
    f.setDefaults({
      model: "manually-selected",
      model_reasoning_effort: "low",
    });
    await f.c.update({ objective: "economy" });
    assert.equal(f.writes.length, 1);
    assert.equal(f.getDefaults().model, "manually-selected");
    assert.equal(f.c.settings.autoSwitch, false);
    assert.match(f.c.recommendation.error, /停止接管/);
    await assert.rejects(f.c.restoreDefaults(), /不会覆盖/);
  } finally {
    await f.cleanup();
  }
});
test("concurrent model actions are serialized", async () => {
  const f = await fixture();
  try {
    await Promise.all([
      f.c.update({ autoSwitch: true }),
      f.c.update({ objective: "economy" }),
    ]);
    assert.equal(f.peak(), 1);
    assert.equal(f.getDefaults().model, "gpt-5.6-luna");
  } finally {
    await f.cleanup();
  }
});
test("malformed local responses preserve known tasks as unknown", async () => {
  const f = await fixture();
  try {
    f.c.threads = [{ id: "a", status: "active", tokens: 1 }];
    f.c.reader = { read: () => ({}) };
    await f.c.local();
    assert.equal(f.c.threads[0].status, "unknown");
    assert.match(f.c.diagnostics.join(" "), /读取失败/);
  } finally {
    await f.cleanup();
  }
});
test("broken state is preserved and automatic control disabled", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, "state.json"), "{broken");
    await f.c.init();
    assert.equal(f.c.settings.autoSwitch, false);
    const files = await readdir(f.dir);
    assert.ok(files.some((name) => name.startsWith("state.json.invalid-")));
  } finally {
    await f.cleanup();
  }
});
test("model write failure does not mislabel successful quota query as failed", async () => {
  const f = await fixture();
  try {
    f.c.settings.autoSwitch = true;
    f.c.client.writeDefaults = async () => {
      throw new Error("write conflict");
    };
    await f.c.remote();
    assert.equal(f.c.account.error, null);
    assert.equal(f.c.account.windows.length, 1);
    assert.match(f.c.recommendation.error, /write conflict/);
  } finally {
    await f.cleanup();
  }
});
test("do-not-remind preference is persisted independently of browser origin", async () => {
  const f = await fixture();
  try {
    await f.c.update({ hideDisclaimer: true });
    const saved = JSON.parse(await readFile(join(f.dir, "state.json"), "utf8"));
    assert.equal(saved.settings.hideDisclaimer, true);
    assert.equal(f.writes.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("local discovery includes all known tasks independently of account retention", async () => {
  const f = await fixture();
  const observed = [];
  f.c.reader = {
    read: (options) => {
      observed.push(options);
      return { threads: [], diagnostics: {} };
    },
  };
  try {
    await f.c.local();
    await f.c.update({ retentionHours: 48 });
    await f.c.local();
    assert.deepEqual(observed, [
      { retentionHours: 24, includeAllKnown: true },
      { retentionHours: 48, includeAllKnown: true },
    ]);
    assert.equal(f.c.estimator.state.retentionHours, 48);
  } finally {
    await f.cleanup();
  }
});

test("snapshot exposes numeric zero attribution while waiting for a quota change", async () => {
  const f = await fixture();
  try {
    f.c.probe = "unavailable";
    const snapshot = f.c.snapshot();
    assert.equal(snapshot.attribution.observedPercent, 0);
    assert.equal(snapshot.attribution.attributedPercent, 0);
    assert.equal(snapshot.attribution.estimatedPercent, 0);
    assert.equal(snapshot.attribution.unattributedPercent, 0);
    assert.equal(snapshot.attribution.estimatedPercentCoverage, "none");
    assert.equal(snapshot.attribution.sampleCount, 0);
    assert.equal(snapshot.attribution.excludedIncompleteHistory, false);
    assert.match(
      snapshot.diagnostics.join(" "),
      /账户接口暂未提供每个任务的独立用量；优先按记录中的模型、缓存输入和输出成本校准估算/,
    );
  } finally {
    await f.cleanup();
  }
});

test('one refresh setting migrates split legacy intervals without losing retained task data',async()=>{
  const f=await fixture();
  try {
    await writeFile(join(f.dir,'state.json'),JSON.stringify({mode:'live',
      settings:{pollSeconds:5,quotaPollSeconds:30,paused:true},
      estimator:{legacyAggregateMigrated:true,rollingAllocations:[{id:'saved-task',at:Date.now()-1000,percent:0.5}]}}));
    await f.c.init();
    assert.equal(f.c.settings.pollSeconds,5);
    assert.equal(f.c.settings.quotaPollSeconds,5);
    assert.equal(f.c.estimator.state.totals['saved-task'],0.5);
    await f.c.update({pollSeconds:12});
    assert.equal(f.c.settings.quotaPollSeconds,12);
    await f.c.update({quotaPollSeconds:8});
    assert.equal(f.c.settings.pollSeconds,8);
    assert.throws(()=>f.c.update({pollSeconds:5,quotaPollSeconds:10}),/shared/);
  } finally { await f.cleanup(); }
});
