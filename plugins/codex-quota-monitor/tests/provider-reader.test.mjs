import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import syncFs, { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalReader, LOCAL_READER_CONSTANTS } from "../server/local-reader.mjs";

const NOW = 1_800_000_000_000;
const TASK = "synthetic-provider-task";
const MODEL = "gpt-5.6-luna";
const usage = (count = 1) => ({ input_tokens: 1000 * count, cached_input_tokens: 900 * count,
  output_tokens: 100 * count, total_tokens: 1100 * count });
const event = (at, type, payload) => JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload }) + "\n";
const session = (provider) => event(NOW - 30_000, "session_meta", { model_provider: provider });
const start = (id, at = NOW - 20_000) => event(at, "event_msg", { type: "task_started", turn_id: id });
const context = (id, provider, at = NOW - 19_000) => event(at, "turn_context", {
  turn_id: id, model: MODEL, ...(provider !== undefined ? { model_provider: provider } : {}),
});
const count = (total = 1, at = NOW - 18_000) => event(at, "event_msg", { type: "token_count",
  info: { total_token_usage: usage(total), last_token_usage: usage() } });
const complete = (id, at = NOW - 15_000) => event(at, "event_msg", { type: "task_complete", turn_id: id });

async function fixture(t, { provider = null, rollout = "", config, history = [], historyMode = "paginated" } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-provider-reader-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const file = path.join(home, "rollout.jsonl");
  await fs.writeFile(file, rollout);
  if (config !== undefined) await fs.writeFile(path.join(home, "config.toml"), config);
  const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, model TEXT,
    model_provider TEXT, tokens_used INTEGER, updated_at_ms INTEGER, created_at_ms INTEGER,
    rollout_path TEXT, history_mode TEXT)`);
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(TASK, "Synthetic provider task", MODEL, provider, 2200, NOW, NOW - 30_000, file, historyMode);
  db.close();
  const historyDb = new DatabaseSync(path.join(home, "thread_history_1.sqlite"));
  historyDb.exec(`CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER,
    status TEXT, started_at INTEGER, completed_at INTEGER, model_provider TEXT)`);
  const insert = historyDb.prepare("INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const [index, row] of history.entries()) {
    insert.run(TASK, row.id, index + 1, row.status || "completed", row.start || NOW - 20_000,
      row.end || NOW - 1000, row.provider ?? null);
  }
  historyDb.close();
  return {
    home, file, reader: new LocalReader({ codexHome: home, now: NOW }),
    setProvider(value) {
      const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
      db.prepare("UPDATE threads SET model_provider = ? WHERE id = ?").run(value, TASK);
      db.close();
    },
  };
}

function turn(result, id) {
  const found = result.threads[0].executionHistory.turns.find((item) => item.turnId === id);
  assert.ok(found, `expected turn ${id}`);
  return found;
}

test("provider catalog reads only bounded id/name fields and never opens auth.json", async (t) => {
  const f = await fixture(t, { provider: "muse", config: `
model_provider = "muse" # active provider
api_key = "PRIVATE_CONFIG_SECRET"
developer_instructions = """
[model_providers.fake]
name = "PRIVATE_MULTILINE_CONTENT"
"""
[model_providers.muse]
name = 'Muse Proxy'
base_url = "http://user:PRIVATE_ENDPOINT_SECRET@127.0.0.1:12345/private"
experimental_bearer_token = "PRIVATE_BEARER_SECRET"
[model_providers.muse.http_headers]
Authorization = "Bearer PRIVATE_HEADER_SECRET"
name = "PRIVATE_HEADER_NAME"
[model_providers.'custom-company']
name = "自定义 Provider # 1"
env_key = "PRIVATE_ENV_KEY_NAME"
[model_providers."corp.east"]
name = "https://PRIVATE_LABEL_ENDPOINT.invalid/path"
[profiles.alternate]
model_provider = "PRIVATE_PROFILE_PROVIDER"
` });
  const authPath = path.join(f.home, "auth.json");
  await fs.writeFile(authPath, "PRIVATE_AUTH_CONTENT");
  const openSync = syncFs.openSync;
  t.mock.method(syncFs, "openSync", function (file, ...args) {
    assert.notEqual(file, authPath, "auth.json must never be read");
    return openSync.call(this, file, ...args);
  });
  const result = f.reader.read();
  assert.deepEqual(result.providerConfig, { activeProvider: "muse", providers: [
    { id: "muse", name: "Muse Proxy" },
    { id: "custom-company", name: "自定义 Provider # 1" },
    { id: "corp.east", name: "corp.east" },
  ] });
  assert.equal(result.threads[0].modelProvider, "muse");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|Authorization|base_url|bearer_token/);
  assert.doesNotMatch(JSON.stringify([...f.reader.rolloutCache.values()]), /PRIVATE_/);
});

test("provider config refresh does not relabel recorded task metadata", async (t) => {
  const f = await fixture(t, { provider: "muse", config: 'model_provider = "muse"\n' });
  assert.equal(f.reader.read().providerConfig.activeProvider, "muse");
  await fs.writeFile(path.join(f.home, "config.toml"), 'model_provider = "openai"\n');
  const updated = f.reader.read();
  assert.equal(updated.providerConfig.activeProvider, "openai");
  assert.equal(updated.threads[0].modelProvider, "muse");
});

test("missing and oversized configs return no guessed provider or private parse errors", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.reader.read().providerConfig, { activeProvider: null, providers: [] });
  await fs.writeFile(path.join(f.home, "config.toml"), 'model_provider = "muse"\n#' + "PRIVATE_CONFIG".repeat(100_000));
  const result = f.reader.read();
  assert.deepEqual(result.providerConfig, { activeProvider: null, providers: [] });
  assert.match(result.diagnostics.warnings.join(" "), /bounded reader/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CONFIG/);
});

for (const provider of ["muse", "custom-company", "unknown"]) {
  test(`${provider} token usage survives a newer projected completion without Codex pricing`, async (t) => {
    const f = await fixture(t, { provider, history: [{ id: "custom-turn" }],
      rollout: session("openai") + start("custom-turn") + context("custom-turn", provider) + count() });
    const result = f.reader.read();
    const found = turn(result, "custom-turn");
    assert.equal(found.status, "idle");
    assert.equal(found.modelProvider, provider);
    assert.equal(found.providerSource, "turn_context");
    assert.equal(found.tokenUsage.totalTokens, 1100);
    assert.equal(found.usageCoverage, "recorded-turn");
    assert.equal(found.costCoverage, "partial-turn");
    assert.equal(found.costCredits, null);
    assert.equal(found.costRateVersion, null);
    assert.equal(result.threads[0].usageCredits, null);
    assert.equal(result.threads[0].costTokens, 0);
    assert.equal(f.reader.read().diagnostics.rolloutBytesRead, 0);
  });
}

test("custom providers read token evidence even when completed nonpaginated history is current", async (t) => {
  const f = await fixture(t, { provider: "muse", historyMode: "legacy", history: [{ id: "custom" }],
    rollout: session("muse") + start("custom") + context("custom") + count() });
  const result = f.reader.read();
  assert.equal(turn(result, "custom").tokenUsage.totalTokens, 1100);
  assert.equal(turn(result, "custom").usageCoverage, "recorded-turn");
  assert.equal(turn(result, "custom").costCredits, null);
  assert.equal(f.reader.read().diagnostics.rolloutBytesRead, 0);
});

test("token coverage marks missing initial cumulative evidence independently from provider pricing", async (t) => {
  const f = await fixture(t, { provider: "muse", rollout:
    session("muse") + start("partial") + context("partial") + count(10) + count(11, NOW - 17_000) });
  const result = f.reader.read();
  assert.equal(turn(result, "partial").tokenUsage.totalTokens, 1100);
  assert.equal(turn(result, "partial").usageCoverage, "partial-turn");
  assert.equal(turn(result, "partial").costCredits, null);
});

test("malformed token components make later valid usage partial without leaking raw payloads", async (t) => {
  const malformed = event(NOW - 18_500, "event_msg", { type: "token_count", info: {
    total_token_usage: { total_tokens: 5000, private_field: "PRIVATE_USAGE_PAYLOAD" },
  } });
  const f = await fixture(t, { provider: "muse", rollout:
    session("muse") + start("partial") + context("partial") + malformed + count() });
  const result = f.reader.read();
  assert.equal(turn(result, "partial").usageCoverage, "partial-turn");
  assert.equal(turn(result, "partial").tokenUsage.totalTokens, 1100);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_USAGE_PAYLOAD/);
});

test("absent and invalid per-turn providers remain unknown even with an active custom config", async (t) => {
  const f = await fixture(t, { config: 'model_provider = "muse"\n', rollout:
    start("absent") + context("absent") + count() + complete("absent") +
    start("invalid", NOW - 10_000) + context("invalid", "https://PRIVATE_PROVIDER.invalid", NOW - 9000) +
    count(2, NOW - 8000) });
  const result = f.reader.read();
  assert.equal(result.threads[0].modelProvider, null);
  for (const id of ["absent", "invalid"]) {
    const found = turn(result, id);
    assert.equal(found.modelProvider, null);
    assert.equal(found.tokenUsage.totalTokens, 1100);
    assert.equal(found.costCredits, null);
  }
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER/);
});

test("explicit provider switches within a task preserve both turns across context repeats and appends", async (t) => {
  const f = await fixture(t, { provider: "muse", rollout:
    session("openai") + start("official") + context("official", "openai") + count() + complete("official") +
    start("muse-turn", NOW - 10_000) + context("muse-turn", "muse", NOW - 9000) +
    context("muse-turn", undefined, NOW - 8500) + count(2, NOW - 8000) });
  const first = f.reader.read();
  assert.equal(turn(first, "official").modelProvider, "openai");
  assert.ok(turn(first, "official").costCredits > 0);
  assert.equal(turn(first, "muse-turn").modelProvider, "muse");
  assert.equal(turn(first, "muse-turn").costCredits, null);
  assert.equal(first.threads[0].usageCredits, turn(first, "official").costCredits);
  await fs.appendFile(f.file, count(3, NOW - 1000));
  const next = f.reader.read();
  assert.equal(turn(next, "official").modelProvider, "openai");
  assert.equal(turn(next, "official").costCredits, turn(first, "official").costCredits);
  assert.equal(turn(next, "muse-turn").modelProvider, "muse");
  assert.equal(turn(next, "muse-turn").tokenUsage.totalTokens, 2200);
  assert.equal(next.threads[0].usageCredits, first.threads[0].usageCredits);
});

test("a conflicting initial session header cannot assign resumed usage to OpenAI", async (t) => {
  const f = await fixture(t, { provider: "muse", rollout:
    session("openai") + start("unproven") + context("unproven") + count() + complete("unproven") });
  const result = f.reader.read();
  const found = turn(result, "unproven");
  assert.equal(result.threads[0].modelProvider, "muse");
  assert.equal(found.modelProvider, null);
  assert.equal(found.providerSource, "conflicting-thread-metadata");
  assert.equal(found.providerAmbiguous, true);
  assert.equal(found.tokenUsage.totalTokens, 1100);
  assert.equal(found.costCredits, null);
  assert.deepEqual(result.threads[0].sessionProviderMetadata, {
    first: { modelProvider: "openai", timestamp: NOW - 30_000 },
    latest: { modelProvider: "openai", timestamp: NOW - 30_000 },
  });
});

test("consistent session metadata supplies only turns that lack an explicit provider", async (t) => {
  const f = await fixture(t, { provider: "muse", rollout:
    session("muse") + context("fallback") + start("fallback") + count() + complete("fallback") +
    start("explicit", NOW - 10_000) + context("explicit", "openai", NOW - 9000) + count(2, NOW - 8000) });
  const result = f.reader.read();
  assert.equal(turn(result, "fallback").modelProvider, "muse");
  assert.equal(turn(result, "fallback").providerSource, "session_meta");
  assert.equal(turn(result, "fallback").costCredits, null);
  assert.equal(turn(result, "explicit").modelProvider, "openai");
  assert.ok(turn(result, "explicit").costCredits > 0);
});

test("completed turns observed before a provider switch keep their original attribution", async (t) => {
  const f = await fixture(t, { provider: "openai", rollout:
    session("openai") + start("earlier") + context("earlier") + count() + complete("earlier") });
  const first = f.reader.read();
  assert.equal(turn(first, "earlier").modelProvider, "openai");
  const cost = turn(first, "earlier").costCredits;
  f.setProvider("muse");
  await fs.appendFile(f.file, start("later", NOW - 10_000) + context("later", "muse", NOW - 9000) + count(2, NOW - 8000));
  const switched = f.reader.read();
  assert.equal(turn(switched, "earlier").modelProvider, "openai");
  assert.equal(turn(switched, "earlier").costCredits, cost);
  assert.equal(turn(switched, "later").modelProvider, "muse");
  assert.equal(switched.threads[0].usageCredits, cost);
  // A fresh process has no observation proving the old header's switch time.
  const fresh = new LocalReader({ codexHome: f.home, now: NOW }).read();
  assert.equal(turn(fresh, "earlier").modelProvider, null);
  assert.equal(turn(fresh, "later").modelProvider, "muse");
});

test("a provider change during a cached live turn never reprices the combined tokens", async (t) => {
  const f = await fixture(t, { provider: "openai", rollout:
    session("openai") + start("live") + context("live") + count() });
  assert.ok(turn(f.reader.read(), "live").costCredits > 0);
  f.setProvider("muse");
  const conflict = f.reader.read();
  assert.equal(turn(conflict, "live").modelProvider, null);
  assert.equal(turn(conflict, "live").costCredits, null);
  assert.equal(conflict.threads[0].usageCredits, null);
  await fs.appendFile(f.file, count(2, NOW - 1000) + complete("live", NOW));
  const appended = f.reader.read();
  assert.equal(turn(appended, "live").modelProvider, null);
  assert.equal(turn(appended, "live").tokenUsage.totalTokens, 2200);
  assert.equal(turn(appended, "live").costCredits, null);
  assert.equal(appended.threads[0].usageCredits, null);
  assert.equal(appended.threads[0].costTokens, 0);
});

test("explicit different providers inside one turn mark its combined usage ambiguous", async (t) => {
  const f = await fixture(t, { provider: "muse", history: [{ id: "mixed", provider: "openai" }], rollout:
    start("mixed") + context("mixed", "openai") + count() +
    context("mixed", "muse", NOW - 5000) + count(2, NOW - 1000) });
  const result = f.reader.read();
  assert.equal(turn(result, "mixed").modelProvider, null);
  assert.equal(turn(result, "mixed").providerSource, "mixed-turn-providers");
  assert.equal(turn(result, "mixed").tokenUsage.totalTokens, 2200);
  assert.equal(turn(result, "mixed").costCredits, null);
  assert.equal(result.threads[0].usageCredits, null);
});

test("explicit matching provider evidence preserves earlier session-level cost on the same turn", async (t) => {
  const f = await fixture(t, { rollout:
    session("openai") + start("confirmed") + context("confirmed") + count() });
  const first = f.reader.read();
  const initialCost = turn(first, "confirmed").costCredits;
  assert.ok(initialCost > 0);
  f.setProvider("muse");
  await fs.appendFile(f.file, context("confirmed", "openai", NOW - 5000) + count(2, NOW - 1000));
  const confirmed = f.reader.read();
  assert.equal(turn(confirmed, "confirmed").modelProvider, "openai");
  assert.equal(turn(confirmed, "confirmed").costCredits, initialCost * 2);
  assert.equal(confirmed.threads[0].usageCredits, initialCost * 2);
});

test("recorded projected per-turn provider metadata is independent of the current thread", async (t) => {
  const f = await fixture(t, { provider: "muse", history: [{ id: "projected", provider: "openai" }] });
  const result = f.reader.read();
  assert.equal(result.threads[0].modelProvider, "muse");
  assert.equal(turn(result, "projected").modelProvider, "openai");
  assert.equal(turn(result, "projected").providerSource, "thread_history");
});

test("bounded tail reads retain only the initial session provider metadata", async (t) => {
  const padding = ('{"type":"response_item","payload":{"content":"' + 'x'.repeat(1000) + '"}}\n').repeat(9000);
  const f = await fixture(t, { provider: "muse", rollout: session("muse") + padding +
    start("tail") + context("tail") + count() });
  const result = f.reader.read();
  assert.equal(turn(result, "tail").modelProvider, "muse");
  assert.equal(turn(result, "tail").tokenUsage.totalTokens, 1100);
  assert.ok(result.diagnostics.rolloutBytesRead <= LOCAL_READER_CONSTANTS.MAX_ROLLOUT_TAIL_BYTES);
  assert.ok(JSON.stringify([...f.reader.rolloutCache.values()]).length < 30_000);
});
