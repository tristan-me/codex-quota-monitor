import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Collector } from "../server/collector.mjs";
import {
  RESET_REFERENCE,
  RESET_REFRESH_INTERVAL_MS,
} from "../server/reset-radar.mjs";
async function setup(resetFetcher) {
  const dir = await mkdtemp(join(tmpdir(), "quota-reset-scheduler-"));
  const c = new Collector({
    dataDir: dir,
    resetFetcher,
    reader: { read: () => ({ threads: [], diagnostics: {} }) },
    client: { request: async () => ({}), close: async () => {} },
  });
  return {
    c,
    cleanup: async () => {
      await c.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("public reset refresh is shared and counted separately from account RPC", async () => {
  let calls = 0;
  const f = await setup(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return RESET_REFERENCE;
  });
  try {
    const before = Date.now();
    await Promise.all([f.c.refreshResetRadar(), f.c.refreshResetRadar()]);
    assert.equal(calls, 1);
    assert.equal(f.c.cost.resetRadarRequests, 2);
    assert.equal(f.c.cost.remoteReads, 0);
    assert.equal(f.c.snapshot().resetRadar.confirmed.length, 2);
    assert.ok(f.c.nextResetRadar >= before + RESET_REFRESH_INTERVAL_MS);
  } finally {
    await f.cleanup();
  }
});
test("public site failure does not turn a valid account sample into an account error", async () => {
  const f = await setup(async () => {
    throw new Error("public source unavailable");
  });
  try {
    await f.c.refreshResetRadar();
    assert.equal(f.c.account.error, null);
    assert.match(f.c.resetRadarError, /public source/);
    assert.equal(f.c.snapshot().resetRadar.confirmed.length, 2);
  } finally {
    await f.cleanup();
  }
});
test("pause and demo modes do not send public refresh requests", async () => {
  let calls = 0;
  const f = await setup(async () => {
    calls++;
    return RESET_REFERENCE;
  });
  try {
    f.c.settings.paused = true;
    await f.c.refreshResetRadar();
    f.c.settings.paused = false;
    f.c.demo = true;
    await f.c.refreshResetRadar();
    assert.equal(calls, 0);
  } finally {
    await f.cleanup();
  }
});
test("closing the monitor aborts only its own public request", async () => {
  let aborted = false;
  const f = await setup(
    ({ signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        ),
      ),
  );
  try {
    f.c.refreshResetRadar();
    await f.c.close();
    assert.equal(aborted, true);
  } finally {
    await f.cleanup();
  }
});
