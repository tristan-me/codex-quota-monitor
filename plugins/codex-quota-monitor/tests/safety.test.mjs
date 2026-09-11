import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexAppServerClient,
  parseAppServerLine,
  READ_METHODS,
} from "../server/app-server-client.mjs";
import { validateSettings, Collector } from "../server/collector.mjs";
import { authorized, startService } from "../server/service.mjs";
import { recommend } from "../server/recommend.mjs";
test("collector RPC cannot submit, resume, interrupt or spend resets", async () => {
  const c = new CodexAppServerClient();
  for (const method of [
    "turn/start",
    "turn/steer",
    "thread/resume",
    "account/rateLimitResetCredit/consume",
    "config/batchWrite",
  ])
    await assert.rejects(c.request(method), /Read-only/);
  await assert.rejects(
    c.writeDefaults([{ keyPath: "model", value: "x" }]),
    /opt-in/,
  );
  assert.equal(READ_METHODS.size, 4);
});
test("large usage credit integers are not rounded in parser", () => {
  assert.equal(
    parseAppServerLine('{"estimatedUsageCreditsMicros":9223372036854775807}')
      .estimatedUsageCreditsMicros,
    "9223372036854775807",
  );
});
test("malformed settings and out-of-range frequencies fail closed", () => {
  for (const patch of [
    { autoSwitch: "false" },
    { pollSeconds: 0 },
    { quotaPollSeconds: Infinity },
    { objective: "ultra" },
    { unsafe: true },
  ])
    assert.throws(() => validateSettings(patch));
  assert.deepEqual(validateSettings({ pollSeconds: 5, autoSwitch: false }), {
    pollSeconds: 5,
    quotaPollSeconds: 5,
    autoSwitch: false,
  });
});
test("cross-origin, wrong Host and missing token are denied", () => {
  const token = "a".repeat(64),
    port = 32100;
  const req = (h) => ({
    headers: { host: "127.0.0.1:" + port, "x-quota-token": token, ...h },
  });
  assert.equal(authorized(req({}), token, port), true);
  for (const h of [
    { origin: "https://attacker.invalid" },
    { host: "attacker.invalid:" + port },
    { "x-quota-token": "bad" },
    { "x-quota-token": undefined },
  ])
    assert.equal(authorized(req(h), token, port), false);
});
test("recommendations require account model availability", () => {
  assert.equal(recommend([], "economy").model, null);
  const r = recommend(
    [
      {
        model: "gpt-5.6-luna",
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [{ reasoningEffort: "low" }],
      },
    ],
    "economy",
  );
  assert.equal(r.reasoningEffort, "low");
});
test("HTTP snapshots respond while upstream never completes; safe settings do not invoke model writes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "quota-http-test-"));
  let writes = 0;
  const c = new Collector({resetFetcher: null,
    dataDir,
    reader: { read: () => ({ threads: [], diagnostics: {} }) },
    client: {
      request: () => new Promise(() => {}),
      close: async () => {},
      writeDefaults: async () => {
        writes++;
      },
    },
  });
  let s;
  try {
    s = await startService({ dataDir, collector: c });
    const base = "http://127.0.0.1:" + s.port;
    const headers = { "X-Quota-Token": s.token };
    const start = Date.now();
    const response = await fetch(base + "/api/snapshot", { headers });
    assert.equal(response.status, 200);
    assert.ok(Date.now() - start < 1000);
    assert.equal((await fetch(base + "/api/snapshot")).status, 403);
    assert.equal(
      (
        await fetch(base + "/api/settings", {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ pollSeconds: 10 }),
        })
      ).status,
      200,
    );
    assert.equal(writes, 0);
  } finally {
    await s?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
