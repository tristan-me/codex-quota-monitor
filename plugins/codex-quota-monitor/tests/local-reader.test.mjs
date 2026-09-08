import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LocalReader,
  LOCAL_READER_CONSTANTS,
} from "../server/local-reader.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

async function makeHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "codex-local-reader-"));
}

function makeStateDb(home, rows, { minimal = false } = {}) {
  const file = path.join(home, "state_5.sqlite");
  const db = new DatabaseSync(file);
  if (minimal) {
    db.exec("CREATE TABLE threads (legacy_column TEXT)");
    db.close();
    return file;
  }
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    title TEXT,
    model TEXT,
    reasoning_effort TEXT,
    source TEXT,
    thread_source TEXT,
    name TEXT,
    updated_at_ms INTEGER,
    updated_at INTEGER,
    created_at_ms INTEGER,
    created_at INTEGER,
    tokens_used INTEGER,
    rollout_path TEXT,
    history_mode TEXT,
    prompt TEXT,
    content TEXT,
    auth TEXT
  )`);
  const insert = db.prepare(`INSERT INTO threads
    (id,title,model,reasoning_effort,source,thread_source,name,updated_at_ms,updated_at,
     created_at_ms,created_at,tokens_used,rollout_path,history_mode,prompt,content,auth)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of rows) {
    insert.run(
      row.id,
      row.title ?? null,
      row.model ?? null,
      row.reasoning_effort ?? null,
      row.source ?? null,
      row.thread_source ?? null,
      row.name ?? null,
      row.updated_at_ms ?? null,
      row.updated_at ?? null,
      row.created_at_ms ?? row.updated_at_ms ?? null,
      row.created_at ?? null,
      row.tokens_used ?? null,
      row.rollout_path ?? null,
      row.history_mode ?? "paginated",
      row.prompt ?? "secret prompt",
      row.content ?? "secret content",
      row.auth ?? "secret auth",
    );
  }
  db.close();
  return file;
}

function makeHistoryDb(home, rows, { includeTable = true } = {}) {
  const file = path.join(home, "thread_history_1.sqlite");
  const db = new DatabaseSync(file);
  if (includeTable) {
    db.exec(`CREATE TABLE thread_turns (
      thread_id TEXT,
      turn_id TEXT,
      rollout_ordinal INTEGER,
      status TEXT,
      error_json TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      duration_ms INTEGER,
      first_user_item_id TEXT,
      final_agent_item_id TEXT,
      rollout_byte_offset INTEGER,
      rollout_end_ordinal INTEGER,
      rollout_end_byte_offset INTEGER
    )`);
    const insert = db.prepare(`INSERT INTO thread_turns
      (thread_id,turn_id,rollout_ordinal,status,error_json,started_at,completed_at,duration_ms,
       first_user_item_id,final_agent_item_id,rollout_byte_offset,rollout_end_ordinal,rollout_end_byte_offset)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const row of rows) {
      insert.run(
        row.thread_id,
        row.turn_id ?? null,
        row.rollout_ordinal ?? null,
        row.status ?? null,
        row.error_json ?? "secret error",
        row.started_at ?? null,
        row.completed_at ?? null,
        row.duration_ms ?? null,
        row.first_user_item_id ?? null,
        row.final_agent_item_id ?? null,
        row.rollout_byte_offset ?? null,
        row.rollout_end_ordinal ?? null,
        row.rollout_end_byte_offset ?? null,
      );
    }
  }
  db.close();
  return file;
}

function findThread(result, id) {
  const thread = result.threads.find((item) => item.id === id);
  assert.ok(thread, `thread ${id} should be returned`);
  return thread;
}

test("joins selected SQLite metadata with latest turns, parses parent edges, filters guardians, and marks stale work unknown", async (t) => {
  const home = await makeHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const now = 1_800_000_000_000;
  const nowSeconds = Math.floor(now / 1000);
  const source = JSON.stringify({
    subagent: {
      thread_spawn: {
        parent_thread_id: "root-thread",
        agent_path: "/private/path",
      },
    },
  });
  makeStateDb(home, [
    {
      id: "root-thread",
      title: "Root prompt should not be shown",
      name: "Root display",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      source: "vscode",
      tokens_used: 100,
      updated_at_ms: now - 1_000,
    },
    {
      id: "child-thread",
      title: `${"Child prompt ".repeat(20)}\nsecond line should not be used`,
      model: "gpt-5.6-luna",
      reasoning_effort: "max",
      source,
      tokens_used: 50,
      updated_at_ms: now - 2_000,
    },
    {
      id: "stale-thread",
      title: "Stale title",
      model: "gpt-5.6-sol",
      reasoning_effort: "medium",
      source: "vscode",
      tokens_used: 75,
      updated_at_ms: now - 3_000,
    },
    {
      id: "done-thread",
      title: "Done title",
      model: "gpt-5.6-sol",
      reasoning_effort: "low",
      source: "cli",
      tokens_used: 200,
      updated_at_ms: now - 4_000,
    },
    {
      id: "guardian-thread",
      title: "Guardian title",
      model: "codex-auto-review",
      reasoning_effort: "low",
      source: JSON.stringify({ subagent: { other: "guardian" } }),
      tokens_used: 999,
      updated_at_ms: now - 5_000,
    },
  ]);
  makeHistoryDb(home, [
    {
      thread_id: "child-thread",
      turn_id: "child-turn",
      rollout_ordinal: 2,
      status: "inProgress",
      started_at: nowSeconds - 30,
    },
    {
      thread_id: "stale-thread",
      turn_id: "stale-turn",
      rollout_ordinal: 1,
      status: "inProgress",
      started_at: nowSeconds - 8 * 24 * 60 * 60,
    },
    {
      thread_id: "done-thread",
      turn_id: "old-turn",
      rollout_ordinal: 1,
      status: "inProgress",
      started_at: nowSeconds - 100,
    },
    {
      thread_id: "done-thread",
      turn_id: "done-turn",
      rollout_ordinal: 2,
      status: "completed",
      started_at: nowSeconds - 90,
      completed_at: nowSeconds - 80,
      duration_ms: 10_000,
    },
  ]);

  const stateMtime = (await fs.stat(path.join(home, "state_5.sqlite"))).mtimeMs;
  const historyMtime = (
    await fs.stat(path.join(home, "thread_history_1.sqlite"))
  ).mtimeMs;
  const result = new LocalReader({ codexHome: home, now }).read();
  assert.equal(result.diagnostics.readOnly, true);
  assert.equal(result.diagnostics.ok, true);
  assert.equal(result.threads.length, 4);
  assert.equal(findThread(result, "root-thread").title, "Root display");
  assert.equal(
    findThread(result, "child-thread").parentThreadId,
    "root-thread",
  );
  assert.equal(findThread(result, "child-thread").title.length, 120);
  assert.equal(
    findThread(result, "child-thread").title.includes("second line"),
    false,
  );
  assert.equal(findThread(result, "child-thread").source, "subagent");
  assert.equal(findThread(result, "child-thread").status, "active");
  assert.equal(
    findThread(result, "child-thread").startedAt,
    (nowSeconds - 30) * 1000,
  );
  assert.equal(findThread(result, "child-thread").completedAt, null);
  assert.equal(findThread(result, "stale-thread").status, "unknown");
  assert.equal(findThread(result, "stale-thread").activityEvidence.stale, true);
  assert.equal(findThread(result, "done-thread").status, "idle");
  assert.equal(
    findThread(result, "done-thread").startedAt,
    (nowSeconds - 90) * 1000,
  );
  assert.equal(
    findThread(result, "done-thread").completedAt,
    (nowSeconds - 80) * 1000,
  );
  assert.equal(
    result.threads.some((item) => item.id === "guardian-thread"),
    false,
  );
  assert.equal(result.diagnostics.guardiansExcluded, 1);
  assert.equal(
    (await fs.stat(path.join(home, "state_5.sqlite"))).mtimeMs,
    stateMtime,
  );
  assert.equal(
    (await fs.stat(path.join(home, "thread_history_1.sqlite"))).mtimeMs,
    historyMtime,
  );
});

test("preserves latest turn identity and bounded completed execution intervals", async (t) => {
  const home = await makeHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const now = 1_800_000_000_000;
  const seconds = Math.floor(now / 1000);
  makeStateDb(home, [
    {
      id: "multi-turn",
      title: "Multi turn",
      model: "gpt-5.6-sol",
      reasoning_effort: "medium",
      source: "vscode",
      tokens_used: 100,
      updated_at_ms: now - 1000,
    },
    {
      id: "completed-turn",
      title: "Completed turn",
      model: "gpt-5.6-sol",
      reasoning_effort: "low",
      source: "vscode",
      tokens_used: 200,
      updated_at_ms: now - 2000,
    },
  ]);
  makeHistoryDb(home, [
    {
      thread_id: "multi-turn",
      turn_id: "turn-one",
      rollout_ordinal: 1,
      status: "completed",
      started_at: seconds - 1000,
      completed_at: seconds - 900,
      duration_ms: 100_000,
    },
    {
      thread_id: "multi-turn",
      turn_id: "turn-two",
      rollout_ordinal: 2,
      status: "completed",
      started_at: seconds - 950,
      completed_at: seconds - 850,
    },
    {
      thread_id: "multi-turn",
      turn_id: "turn-three",
      rollout_ordinal: 3,
      status: "inProgress",
      started_at: seconds - 30,
    },
    {
      thread_id: "multi-turn",
      turn_id: "turn-missing",
      rollout_ordinal: 0,
      status: "completed",
    },
    {
      thread_id: "multi-turn",
      turn_id: "turn-unknown",
      rollout_ordinal: -1,
      status: "mystery",
      started_at: seconds - 500,
      completed_at: seconds - 490,
    },
    {
      thread_id: "multi-turn",
      turn_id: "turn-zero-duration",
      rollout_ordinal: -2,
      status: "completed",
      started_at: seconds - 400,
      completed_at: seconds - 390,
      duration_ms: 0,
    },
    {
      thread_id: "completed-turn",
      turn_id: "completed-only",
      rollout_ordinal: 1,
      status: "completed",
      completed_at: seconds - 40,
      duration_ms: 30_000,
    },
  ]);

  const result = new LocalReader({ codexHome: home, now }).read();
  const multi = findThread(result, "multi-turn");
  assert.equal(multi.activityEvidence.turnId, "turn-three");
  assert.equal(multi.activityEvidence.turnSequence, 3);
  assert.equal(multi.activityEvidence.lastTurnDurationMs, null);
  assert.equal(multi.executionHistory.source, "thread_history");
  assert.equal(multi.executionHistory.coverage, "partial");
  assert.deepEqual(multi.executionHistory.intervals, [
    [(seconds - 1000) * 1000, (seconds - 900) * 1000],
    [(seconds - 950) * 1000, (seconds - 850) * 1000],
    [(seconds - 400) * 1000, (seconds - 390) * 1000],
  ]);

  const completed = findThread(result, "completed-turn");
  assert.equal(completed.activityEvidence.turnId, "completed-only");
  assert.equal(completed.activityEvidence.turnSequence, 1);
  assert.equal(completed.activityEvidence.lastTurnDurationMs, 30_000);
  assert.deepEqual(completed.executionHistory.intervals, [
    [(seconds - 70) * 1000, (seconds - 40) * 1000],
  ]);
  assert.equal(completed.executionHistory.coverage, "partial");
});

test("same rollout ordinal prefers the newest row and does not let an older active row win", async (t) => {
  const home = await makeHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const now = 1_800_000_000_000;
  const seconds = Math.floor(now / 1000);
  makeStateDb(home, [{
    id: "same-ordinal",
    title: "Same ordinal",
    model: "gpt-5.6-sol",
    reasoning_effort: "medium",
    source: "vscode",
    tokens_used: 10,
    updated_at_ms: now - 1000,
  }]);
  makeHistoryDb(home, [
    {
      thread_id: "same-ordinal",
      turn_id: "older-active",
      rollout_ordinal: 7,
      status: "inProgress",
      started_at: seconds - 900,
    },
    {
      thread_id: "same-ordinal",
      turn_id: "newer-completed",
      rollout_ordinal: 7,
      status: "completed",
      started_at: seconds - 30,
      completed_at: seconds - 10,
      duration_ms: 20_000,
    },
  ]);

  const result = new LocalReader({ codexHome: home, now }).read();
  const thread = findThread(result, "same-ordinal");
  assert.equal(thread.status, "idle");
  assert.equal(thread.activityEvidence.turnId, "newer-completed");
  assert.equal(thread.activityEvidence.turnSequence, 7);
  assert.equal(thread.activityEvidence.lastTurnDurationMs, 20_000);
});

test("derives intervals when optional duration_ms is absent from the history schema", async (t) => {
  const home = await makeHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const now = 1_800_000_000_000;
  const seconds = Math.floor(now / 1000);
  makeStateDb(home, [{
    id: "old-schema",
    title: "Old schema",
    model: "gpt-5.6-sol",
    reasoning_effort: "medium",
    source: "cli",
    tokens_used: 10,
    updated_at_ms: now - 1000,
  }]);
  const historyPath = path.join(home, "thread_history_1.sqlite");
  const db = new DatabaseSync(historyPath);
  db.exec(`CREATE TABLE thread_turns (
    thread_id TEXT,
    turn_id TEXT,
    rollout_ordinal INTEGER,
    status TEXT,
    started_at INTEGER,
    completed_at INTEGER
  )`);
  db.prepare(`INSERT INTO thread_turns
    (thread_id,turn_id,rollout_ordinal,status,started_at,completed_at)
    VALUES (?,?,?,?,?,?)`).run(
    "old-schema",
    "old-turn",
    2,
    "completed",
    seconds - 20,
    seconds - 10,
  );
  db.close();

  const result = new LocalReader({ codexHome: home, now }).read();
  const thread = findThread(result, "old-schema");
  assert.equal(thread.activityEvidence.turnSequence, 2);
  assert.equal(thread.activityEvidence.lastTurnDurationMs, 10_000);
  assert.deepEqual(thread.executionHistory.intervals, [
    [(seconds - 20) * 1000, (seconds - 10) * 1000],
  ]);
  assert.equal(thread.executionHistory.coverage, "local-records");
});

test("uses bounded legacy rollout parsing for lifecycle and token_count evidence without exposing content", async (t) => {
  const home = await makeHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const now = 1_800_000_000_000;
  const nowSeconds = Math.floor(now / 1000);
  const rolloutDir = path.join(home, "sessions", "2026", "01", "01");
  await fs.mkdir(rolloutDir, { recursive: true });
  const completedPath = path.join(rolloutDir, "completed.jsonl");
  await fs.writeFile(
    completedPath,
    [
      JSON.stringify({
        type: "event_msg",
        timestamp: new Date(now - 20_000).toISOString(),
        payload: {
          type: "task_started",
          turn_id: "legacy-turn",
          started_at: nowSeconds - 20,
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: new Date(now - 10_000).toISOString(),
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { total_tokens: 321 },
            last_token_usage: { total_tokens: 44 },
          },
          content: "secret token payload",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: new Date(now - 1_000).toISOString(),
        payload: {
          type: "task_complete",
          turn_id: "legacy-turn",
          started_at: nowSeconds - 20,
          completed_at: nowSeconds - 1,
          duration_ms: 19_000,
          last_agent_message: "PRIVATE SHOULD NOT ESCAPE",
        },
      }),
      "malformed json line",
    ].join("\n"),
  );
  const activePath = path.join(rolloutDir, "active.jsonl");
  await fs.writeFile(
    activePath,
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "active-turn",
        started_at: nowSeconds - 5,
        content: "private",
      },
    }) + "\n",
  );
  const stalePath = path.join(rolloutDir, "stale.jsonl");
  await fs.writeFile(
    stalePath,
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "stale-turn",
        started_at: nowSeconds - 8 * 24 * 60 * 60,
      },
    }) + "\n",
  );
  const orphanPath = path.join(rolloutDir, "orphan.jsonl");
  await fs.writeFile(
    orphanPath,
    JSON.stringify({
      type: "event_msg",
      timestamp: new Date(now - 8_000).toISOString(),
      payload: {
        type: "task_complete",
        turn_id: "orphan-turn",
        completed_at: nowSeconds - 8,
        duration_ms: 7_000,
      },
    }) + "\n",
  );
  const orphanMissingPath = path.join(rolloutDir, "orphan-missing.jsonl");
  await fs.writeFile(
    orphanMissingPath,
    JSON.stringify({
      type: "event_msg",
      timestamp: new Date(now - 6_000).toISOString(),
      payload: { type: "task_complete", turn_id: "orphan-missing" },
    }) + "\n",
  );
  makeStateDb(home, [
    {
      id: "legacy-completed",
      title: "Legacy complete",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      source: "cli",
      tokens_used: null,
      updated_at_ms: now - 1_000,
      rollout_path: completedPath,
      history_mode: "legacy",
    },
    {
      id: "legacy-active",
      title: "Legacy active",
      model: "gpt-5.6-sol",
      reasoning_effort: "medium",
      source: "cli",
      tokens_used: 12,
      updated_at_ms: now - 2_000,
      rollout_path: activePath,
      history_mode: "legacy",
    },
    {
      id: "legacy-stale",
      title: "Legacy stale",
      model: "gpt-5.6-sol",
      reasoning_effort: "low",
      source: "cli",
      tokens_used: 13,
      updated_at_ms: now - 3_000,
      rollout_path: stalePath,
      history_mode: "legacy",
    },
    {
      id: "legacy-orphan",
      title: "Legacy orphan",
      model: "gpt-5.6-sol",
      reasoning_effort: "low",
      source: "cli",
      tokens_used: 14,
      updated_at_ms: now - 4_000,
      rollout_path: orphanPath,
      history_mode: "legacy",
    },
    {
      id: "legacy-orphan-missing",
      title: "Legacy orphan missing",
      model: "gpt-5.6-sol",
      reasoning_effort: "low",
      source: "cli",
      tokens_used: 15,
      updated_at_ms: now - 5_000,
      rollout_path: orphanMissingPath,
      history_mode: "legacy",
    },
  ]);
  makeHistoryDb(home, []);

  const result = new LocalReader({ codexHome: home, now }).read();
  const complete = findThread(result, "legacy-completed");
  assert.equal(complete.status, "idle");
  assert.equal(complete.tokens, 321);
  assert.equal(complete.tokenDelta, 44);
  assert.equal(complete.startedAt, (nowSeconds - 20) * 1000);
  assert.equal(complete.completedAt, (nowSeconds - 1) * 1000);
  assert.equal(complete.activityEvidence.lastTurnDurationMs, 19_000);
  assert.equal(complete.activityEvidence.turnSequence, null);
  assert.equal(complete.executionHistory.source, "legacy_tail");
  assert.equal(complete.executionHistory.coverage, "partial");
  assert.deepEqual(complete.executionHistory.intervals, [
    [(nowSeconds - 20) * 1000, (nowSeconds - 1) * 1000],
  ]);
  assert.equal(complete.activityEvidence.source, "rollout_jsonl");
  const orphan = findThread(result, "legacy-orphan");
  assert.equal(orphan.startedAt, (nowSeconds - 15) * 1000);
  assert.equal(orphan.completedAt, (nowSeconds - 8) * 1000);
  assert.equal(orphan.activityEvidence.lastTurnDurationMs, 7_000);
  assert.deepEqual(orphan.executionHistory.intervals, [
    [(nowSeconds - 15) * 1000, (nowSeconds - 8) * 1000],
  ]);
  const orphanMissing = findThread(result, "legacy-orphan-missing");
  assert.equal(orphanMissing.startedAt, null);
  assert.equal(orphanMissing.completedAt, (nowSeconds - 6) * 1000);
  assert.equal(orphanMissing.activityEvidence.lastTurnDurationMs, null);
  assert.deepEqual(orphanMissing.executionHistory.intervals, []);
  assert.equal(findThread(result, "legacy-active").status, "active");
  assert.equal(findThread(result, "legacy-stale").status, "unknown");
  assert.equal(result.diagnostics.legacyRolloutsRead, 5);
  assert.equal(result.diagnostics.malformedRolloutLines, 1);
  assert.equal(
    JSON.stringify(result).includes("PRIVATE SHOULD NOT ESCAPE"),
    false,
  );
  assert.equal(JSON.stringify(result).includes("secret token payload"), false);
  assert.equal(JSON.stringify(result).includes("secret content"), false);
});

test("uses the configured retention window for inactive discovery while retaining recent active complements", async (t) => {
  const home = await makeHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const now = 1_800_000_000_000;
  const seconds = Math.floor(now / 1000);
  makeStateDb(home, [
    {
      id: "recent-idle",
      title: "Recent idle",
      model: "gpt-5.6-sol",
      source: "vscode",
      tokens_used: 10,
      updated_at_ms: now - 2 * 60 * 60 * 1000,
    },
    {
      id: "retired-idle",
      title: "Retired idle",
      model: "gpt-5.6-sol",
      source: "vscode",
      tokens_used: 20,
      updated_at_ms: now - 25 * 60 * 60 * 1000,
    },
    {
      id: "active-complement",
      title: "Active complement",
      model: "gpt-5.6-sol",
      source: "vscode",
      tokens_used: 30,
      updated_at_ms: now - 25 * 60 * 60 * 1000,
    },
  ]);
  makeHistoryDb(home, [
    { thread_id: "recent-idle", turn_id: "recent", rollout_ordinal: 1,
      status: "completed", started_at: seconds - 7300, completed_at: seconds - 7200 },
    { thread_id: "retired-idle", turn_id: "retired", rollout_ordinal: 1,
      status: "completed", started_at: seconds - 25 * 3600 - 100,
      completed_at: seconds - 25 * 3600 },
    { thread_id: "active-complement", turn_id: "active", rollout_ordinal: 1,
      status: "inProgress", started_at: seconds - 10 },
  ]);

  const reader = new LocalReader({ codexHome: home, now });
  const daily = reader.read();
  assert.deepEqual(daily.threads.map((thread) => thread.id).sort(), [
    "active-complement",
    "recent-idle",
  ]);
  assert.equal(daily.diagnostics.retentionHours, 24);
  assert.equal(daily.diagnostics.recentWindowMs, DAY_MS);

  const twoDays = reader.read({ retentionHours: 48 });
  assert.deepEqual(twoDays.threads.map((thread) => thread.id).sort(), [
    "active-complement",
    "recent-idle",
    "retired-idle",
  ]);
  assert.equal(twoDays.diagnostics.recentWindowMs, 2 * DAY_MS);
});

test("caps the recent page at 200 while adding all recent active turns", async (t) => {
  const home = await makeHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const now = 1_800_000_000_000;
  const nowSeconds = Math.floor(now / 1000);
  const rows = Array.from({ length: 205 }, (_, index) => ({
    id: `thread-${String(index).padStart(3, "0")}`,
    title: `Thread ${index}`,
    model: "gpt-5.6-sol",
    reasoning_effort: "medium",
    source: "vscode",
    tokens_used: index,
    updated_at_ms: now - index * 1000,
  }));
  makeStateDb(home, rows);
  makeHistoryDb(home, [
    {
      thread_id: "thread-204",
      turn_id: "long-lived-turn",
      rollout_ordinal: 1,
      status: "inProgress",
      started_at: nowSeconds - 10,
    },
  ]);
  const result = new LocalReader({ codexHome: home, now }).read();
  assert.equal(result.threads.length, 201);
  assert.ok(result.threads.some((thread) => thread.id === "thread-000"));
  assert.ok(result.threads.some((thread) => thread.id === "thread-199"));
  assert.equal(
    result.threads.some((thread) => thread.id === "thread-200"),
    false,
  );
  assert.equal(findThread(result, "thread-204").status, "active");
  assert.equal(LOCAL_READER_CONSTANTS.RECENT_THREAD_LIMIT, 200);
});

test("caps per-thread execution history and reports partial coverage", async (t) => {
  const home = await makeHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const now = 1_800_000_000_000;
  const seconds = Math.floor(now / 1000);
  makeStateDb(home, [{
    id: "long-history",
    title: "Long history",
    model: "gpt-5.6-sol",
    reasoning_effort: "medium",
    source: "vscode",
    tokens_used: 10,
    updated_at_ms: now - 1000,
  }]);
  makeHistoryDb(home, Array.from({ length: 5001 }, (_, index) => ({
    thread_id: "long-history",
    turn_id: `turn-${index}`,
    rollout_ordinal: index + 1,
    status: "completed",
    started_at: seconds - index * 3 - 2,
    completed_at: seconds - index * 3,
    duration_ms: 2000,
  })));

  const result = new LocalReader({ codexHome: home, now }).read();
  const thread = findThread(result, "long-history");
  assert.equal(thread.executionHistory.intervals.length, 5000);
  assert.equal(thread.executionHistory.coverage, "partial");
  assert.equal(thread.activityEvidence.turnSequence, 5001);
  assert.equal(result.diagnostics.executionHistoryPartialThreads, 1);
  assert.equal(result.diagnostics.executionHistoryTurnCap, 5000);
});

test("reports missing and incompatible local databases explicitly", async (t) => {
  const home = await makeHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const missing = new LocalReader({
    codexHome: home,
    now: 1_800_000_000_000,
  }).read();
  assert.deepEqual(missing.threads, []);
  assert.equal(missing.diagnostics.ok, false);
  assert.ok(
    missing.diagnostics.incompatible.some((item) =>
      item.includes("state_5.sqlite"),
    ),
  );
  makeStateDb(home, [], { minimal: true });
  makeHistoryDb(home, [], { includeTable: false });
  const incompatible = new LocalReader({
    codexHome: home,
    now: 1_800_000_000_000,
  }).read();
  assert.equal(incompatible.diagnostics.ok, false);
  assert.ok(
    incompatible.diagnostics.incompatible.some((item) =>
      item.includes("no id column"),
    ),
  );
  assert.ok(
    incompatible.diagnostics.incompatible.some((item) =>
      item.includes("no thread_turns table"),
    ),
  );
});
