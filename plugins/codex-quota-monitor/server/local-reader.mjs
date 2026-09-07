import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_WINDOW_MS = 7 * DAY_MS;
const RECENT_THREAD_LIMIT = 200;
const MAX_ROLLOUT_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_ROLLOUT_LINE_BYTES = 2 * 1024 * 1024;
const SQLITE_BIND_CHUNK = 500;

const ACTIVE_STATUSES = new Set([
  "active",
  "inprogress",
  "in_progress",
  "in-progress",
  "running",
  "started",
  "pending",
  "queued",
  "working",
]);

const TERMINAL_STATUSES = new Set([
  "completed",
  "complete",
  "succeeded",
  "success",
  "failed",
  "failure",
  "interrupted",
  "interrupted_by_user",
  "aborted",
  "cancelled",
  "canceled",
  "error",
  "rejected",
  "done",
]);

// Keep the selected columns explicit.  In particular, do not add prompt,
// content, auth, preview, first_user_message, or item_json to these lists.
const THREAD_COLUMNS = [
  "id",
  "title",
  "model",
  "reasoning_effort",
  "source",
  "thread_source",
  "name",
  "updated_at_ms",
  "updated_at",
  "created_at_ms",
  "created_at",
  "tokens_used",
  "rollout_path",
  "history_mode",
];

const TURN_COLUMNS = [
  "thread_id",
  "turn_id",
  "rollout_ordinal",
  "status",
  "started_at",
  "completed_at",
  "duration_ms",
];

function finiteNumber(value) {
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function normalizeTimestamp(value) {
  const number = finiteNumber(value);
  if (number !== null) {
    // Codex currently stores rollout turn times in Unix seconds and thread
    // metadata times in Unix milliseconds.  Accept either representation.
    if (number <= 0) return null;
    const absolute = Math.abs(number);
    if (absolute > 0 && absolute < 100_000_000_000)
      return Math.round(number * 1000);
    return Math.round(number);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function nowValue(now) {
  const value = typeof now === "function" ? now() : now;
  const normalized = normalizeTimestamp(value);
  return normalized === null ? Date.now() : normalized;
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function normalizeStatus(value) {
  if (typeof value !== "string") return null;
  const status = value.trim().toLowerCase().replace(/\s+/g, "_");
  return status || null;
}

function statusClass(value) {
  const status = normalizeStatus(value);
  if (!status) return "unknown";
  if (ACTIVE_STATUSES.has(status)) return "active";
  if (TERMINAL_STATUSES.has(status)) return "idle";
  return "unknown";
}

function safeText(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return null;
  return String(value);
}

function safeTitle(name, title) {
  const preferred = typeof name === "string" && name.trim() ? name : title;
  if (preferred === null || preferred === undefined) return null;
  const firstLine = String(preferred).split(/\r?\n/, 1)[0].trim();
  return firstLine ? firstLine.slice(0, 120) : null;
}

function parseSource(rawSource) {
  let parsed = rawSource;
  if (typeof rawSource === "string") {
    const trimmed = rawSource.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = null;
      }
    }
  }

  const subagent =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed.subagent
      : null;
  const spawn =
    subagent && typeof subagent === "object" && !Array.isArray(subagent)
      ? subagent.thread_spawn
      : null;
  const parent =
    spawn && typeof spawn === "object" && !Array.isArray(spawn)
      ? (spawn.parent_thread_id ?? spawn.parentThreadId)
      : null;
  const other =
    subagent && typeof subagent === "object" && !Array.isArray(subagent)
      ? subagent.other
      : null;
  const isGuardian = String(other || "").toLowerCase() === "guardian";

  let kind = null;
  if (isGuardian) kind = "guardian";
  else if (spawn || (subagent && typeof subagent === "object"))
    kind = "subagent";
  else if (typeof rawSource === "string" && rawSource.trim())
    kind = rawSource.trim();
  else if (typeof rawSource === "object" && rawSource !== null)
    kind = "unknown";

  return {
    parentThreadId:
      typeof parent === "string" && parent.trim() ? parent.trim() : null,
    isGuardian,
    kind,
    parseError:
      typeof rawSource === "string" &&
      rawSource.trim().startsWith("{") &&
      parsed === null,
  };
}

function dbTableColumns(db, tableName) {
  const rows = db
    .prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
    .all();
  return new Set(rows.map((row) => String(row.name)));
}

function threadSelectExpressions(columns) {
  return THREAD_COLUMNS.filter((name) => columns.has(name)).map((name) => {
    // `title` can contain the initial user request.  Limit it in SQLite so
    // the full prompt is never materialized in the reader result; `name`
    // is the preferred UI label when present.
    if (name === "name" || name === "title") {
      return `substr(${quoteIdentifier(name)}, 1, 120) AS ${quoteIdentifier(name)}`;
    }
    return quoteIdentifier(name);
  });
}

function hasTable(db, tableName) {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .get(tableName);
  return Boolean(row);
}

function openReadOnlyDatabase(file, diagnostics, label) {
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch (error) {
    diagnostics.errors.push(
      `${label}: ${String(error?.message || error)}`.slice(0, 500),
    );
    return null;
  }
}

function rowTimestamp(row, preferred = "updated") {
  const names =
    preferred === "created"
      ? ["created_at_ms", "created_at"]
      : ["updated_at_ms", "updated_at", "created_at_ms", "created_at"];
  for (const name of names) {
    const timestamp = normalizeTimestamp(row?.[name]);
    if (timestamp !== null) return timestamp;
  }
  return null;
}

function rowTokens(value) {
  const number = finiteNumber(value);
  if (number === null || number < 0) return 0;
  // Token counts are integral in the Codex state database.  Rounding here
  // also prevents a floating point value from leaking into the public shape.
  return Math.max(0, Math.round(number));
}

function eventField(event, names) {
  for (const name of names) {
    if (event && Object.prototype.hasOwnProperty.call(event, name))
      return event[name];
  }
  return null;
}

function nestedTokenNumber(value) {
  const number = finiteNumber(value);
  return number === null || number < 0 ? null : Math.round(number);
}

function parseLegacyEventLine(line, state, sequence) {
  if (line.length > MAX_ROLLOUT_LINE_BYTES) return false;
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    state.malformedLines += 1;
    return false;
  }
  if (!row || typeof row !== "object") return false;

  const outerType = typeof row.type === "string" ? row.type : "";
  if (outerType !== "event_msg" && !row.payload && !row.event_msg) return false;
  const payload =
    row.payload && typeof row.payload === "object"
      ? row.payload
      : row.event_msg && typeof row.event_msg === "object"
        ? row.event_msg
        : null;
  if (!payload || typeof payload !== "object") return false;
  const type =
    typeof payload.type === "string"
      ? payload.type.trim().toLowerCase()
      : typeof payload.event === "string"
        ? payload.event.trim().toLowerCase()
        : "";
  if (!type) return false;

  // Do not walk the payload or inspect free-form fields.  These are the only
  // lifecycle/token fields consumed from legacy rollouts.
  const eventAt =
    normalizeTimestamp(row.timestamp) ??
    normalizeTimestamp(eventField(payload, ["timestamp", "at", "created_at"]));
  const turnIdValue = eventField(payload, ["turn_id", "turnId"]);
  const turnId =
    typeof turnIdValue === "string" && turnIdValue ? turnIdValue : null;
  const startedAt =
    normalizeTimestamp(eventField(payload, ["started_at", "startedAt"])) ??
    eventAt;
  const completedAt =
    normalizeTimestamp(eventField(payload, ["completed_at", "completedAt"])) ??
    eventAt;
  const current = turnId || "__rollout_latest__";

  if (type === "task_started") {
    const previous = state.turns.get(current);
    state.turns.set(current, {
      turnId,
      status: "inProgress",
      startedAt,
      completedAt: null,
      eventAt: eventAt ?? startedAt,
      sequence,
    });
    if (!previous || sequence >= previous.sequence) state.latestKey = current;
    state.eventCount += 1;
    return true;
  }

  if (type === "task_complete" || type === "turn_aborted") {
    const previous =
      state.turns.get(current) || state.turns.get("__rollout_latest__");
    const terminalStatus = type === "task_complete" ? "completed" : "aborted";
    state.turns.set(current, {
      turnId: turnId || previous?.turnId || null,
      status: terminalStatus,
      startedAt: previous?.startedAt ?? startedAt,
      completedAt:
        normalizeTimestamp(
          eventField(payload, ["completed_at", "completedAt"]),
        ) ??
        eventAt ??
        previous?.completedAt ??
        null,
      eventAt: eventAt ?? completedAt ?? previous?.eventAt ?? null,
      sequence,
    });
    state.latestKey = current;
    state.eventCount += 1;
    return true;
  }

  if (type === "token_count") {
    const info =
      payload.info && typeof payload.info === "object" ? payload.info : null;
    const totalUsage =
      info?.total_token_usage && typeof info.total_token_usage === "object"
        ? info.total_token_usage
        : null;
    const lastUsage =
      info?.last_token_usage && typeof info.last_token_usage === "object"
        ? info.last_token_usage
        : null;
    const total = nestedTokenNumber(
      totalUsage?.total_tokens ?? payload.total_tokens,
    );
    const delta = nestedTokenNumber(
      lastUsage?.total_tokens ?? payload.last_total_tokens,
    );
    if (total !== null) state.tokens = total;
    if (delta !== null) state.tokenDelta = delta;
    state.lastTokenAt = eventAt;
    state.eventCount += 1;
    return true;
  }
  return false;
}

function readLegacyRollout(file, diagnostics) {
  const state = {
    turns: new Map(),
    latestKey: null,
    tokens: null,
    tokenDelta: null,
    lastTokenAt: null,
    eventCount: 0,
    malformedLines: 0,
    bytesRead: 0,
  };
  let fd;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error("rollout path is not a regular file");
    const start = Math.max(0, stat.size - MAX_ROLLOUT_TAIL_BYTES);
    fd = fs.openSync(file, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = start;
    let carry = "";
    let discardFirstPartialLine = start > 0;
    let sequence = 0;
    while (offset < stat.size) {
      const readSize = fs.readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, stat.size - offset),
        offset,
      );
      if (!readSize) break;
      offset += readSize;
      state.bytesRead += readSize;
      let chunk = buffer.subarray(0, readSize).toString("utf8");
      if (discardFirstPartialLine) {
        const firstNewline = chunk.search(/\r?\n/);
        if (firstNewline < 0) continue;
        chunk = chunk.slice(
          firstNewline + (chunk[firstNewline] === "\r" ? 2 : 1),
        );
        discardFirstPartialLine = false;
      }
      carry += chunk;
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() || "";
      for (const line of lines) {
        sequence += 1;
        parseLegacyEventLine(line, state, sequence);
      }
    }
    if (carry && !discardFirstPartialLine) {
      sequence += 1;
      parseLegacyEventLine(carry, state, sequence);
    }
  } catch (error) {
    diagnostics.rolloutErrors += 1;
    diagnostics.errors.push(
      `rollout: ${String(error?.message || error)}`.slice(0, 500),
    );
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  diagnostics.legacyRolloutsRead += 1;
  diagnostics.rolloutBytesRead += state.bytesRead;
  diagnostics.malformedRolloutLines += state.malformedLines;

  let latest = null;
  for (const turn of state.turns.values()) {
    if (!latest || (turn.sequence ?? 0) > (latest.sequence ?? 0)) latest = turn;
  }
  const updatedAt =
    [latest?.eventAt, latest?.completedAt, latest?.startedAt, state.lastTokenAt]
      .filter((value) => value !== null && value !== undefined)
      .reduce((max, value) => Math.max(max, value), 0) || null;
  return {
    tokens: state.tokens,
    tokenDelta: state.tokenDelta,
    updatedAt,
    latestTurn: latest,
    eventCount: state.eventCount,
    source: "rollout_jsonl",
  };
}

function latestTurnFromRow(row) {
  if (!row) return null;
  return {
    turnId: safeText(row.turn_id),
    status: safeText(row.status),
    startedAt: normalizeTimestamp(row.started_at),
    completedAt: normalizeTimestamp(row.completed_at),
    eventAt: null,
    sequence: finiteNumber(row.rollout_ordinal) ?? 0,
    durationMs: finiteNumber(row.duration_ms),
  };
}

function turnSortValue(row) {
  const ordinal = finiteNumber(row?.rollout_ordinal);
  if (ordinal !== null) return ordinal;
  return (
    normalizeTimestamp(row?.started_at) ??
    normalizeTimestamp(row?.completed_at) ??
    0
  );
}

function latestTurnRows(db, columns, ids) {
  if (!ids.length || !columns.has("thread_id")) return new Map();
  const selected = TURN_COLUMNS.filter((name) => columns.has(name));
  if (!selected.includes("status")) return new Map();
  const latest = new Map();
  const orderParts = [
    columns.has("rollout_ordinal") &&
      `COALESCE(${quoteIdentifier("rollout_ordinal")}, -9223372036854775808) DESC`,
    columns.has("started_at") &&
      `COALESCE(${quoteIdentifier("started_at")}, -9223372036854775808) DESC`,
    columns.has("completed_at") &&
      `COALESCE(${quoteIdentifier("completed_at")}, -9223372036854775808) DESC`,
  ].filter(Boolean);
  for (let offset = 0; offset < ids.length; offset += SQLITE_BIND_CHUNK) {
    const chunk = ids.slice(offset, offset + SQLITE_BIND_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const selectedSql = selected.map(quoteIdentifier).join(", ");
    const orderSql = orderParts.length ? orderParts.join(", ") : "rowid DESC";
    const sql = `SELECT ${selectedSql}
      FROM (
        SELECT ${selectedSql}, ROW_NUMBER() OVER (
          PARTITION BY ${quoteIdentifier("thread_id")} ORDER BY ${orderSql}
        ) AS "__local_reader_row_number"
        FROM ${quoteIdentifier("thread_turns")}
        WHERE ${quoteIdentifier("thread_id")} IN (${placeholders})
      )
      WHERE "__local_reader_row_number" = 1`;
    const rows = db.prepare(sql).all(...chunk);
    for (const row of rows) {
      const id = safeText(row.thread_id);
      if (id) latest.set(id, row);
    }
  }
  return latest;
}

function recentActiveTurnRows(db, columns, cutoffMs) {
  if (!columns.has("thread_id") || !columns.has("status")) return [];
  const selected = TURN_COLUMNS.filter((name) => columns.has(name));
  const statusPlaceholders = [...ACTIVE_STATUSES].map(() => "?").join(", ");
  const cutoffSeconds = Math.floor(cutoffMs / 1000);
  const startedCondition = columns.has("started_at")
    ? `(${quoteIdentifier("started_at")} IS NULL OR ${quoteIdentifier("started_at")} >= ?)`
    : "1 = 1";
  const params = [
    ...ACTIVE_STATUSES,
    ...(columns.has("started_at") ? [cutoffSeconds] : []),
  ];
  const sql = `SELECT ${selected.map(quoteIdentifier).join(", ")}
    FROM ${quoteIdentifier("thread_turns")}
    WHERE lower(replace(${quoteIdentifier("status")}, ' ', '_')) IN (${statusPlaceholders})
      AND ${startedCondition}`;
  return db.prepare(sql).all(...params);
}

function stateRowQuery(db, columns, cutoffMs) {
  if (!columns.has("id")) return { rows: [], compatible: false };
  const selected = THREAD_COLUMNS.filter((name) => columns.has(name));
  const updatedMs = columns.has("updated_at_ms")
    ? quoteIdentifier("updated_at_ms")
    : null;
  const updatedSec = columns.has("updated_at")
    ? quoteIdentifier("updated_at")
    : null;
  const createdMs = columns.has("created_at_ms")
    ? quoteIdentifier("created_at_ms")
    : null;
  const createdSec = columns.has("created_at")
    ? quoteIdentifier("created_at")
    : null;
  const dateParts = [
    updatedMs && `NULLIF(${updatedMs}, 0)`,
    updatedSec && `NULLIF(${updatedSec}, 0) * 1000`,
    createdMs && `NULLIF(${createdMs}, 0)`,
    createdSec && `NULLIF(${createdSec}, 0) * 1000`,
  ].filter(Boolean);
  const dateExpression = dateParts.length
    ? `COALESCE(${dateParts.join(", ")})`
    : null;
  const params = dateExpression ? [cutoffMs] : [];
  const where = dateExpression
    ? `(${dateExpression} >= ? OR ${dateExpression} IS NULL)`
    : "1 = 1";
  const orderParts = dateParts.map((part) => `${part} DESC`);
  const sql = `SELECT ${threadSelectExpressions(columns).join(", ")}
    FROM ${quoteIdentifier("threads")}
    WHERE ${where}
    ORDER BY ${orderParts.length ? orderParts.join(", ") : quoteIdentifier("id")}
    LIMIT ${RECENT_THREAD_LIMIT + 1}`;
  const rows = db.prepare(sql).all(...params);
  return {
    rows: rows.slice(0, RECENT_THREAD_LIMIT),
    compatible: true,
    truncated: rows.length > RECENT_THREAD_LIMIT,
  };
}

function metadataByIds(db, columns, ids) {
  if (!ids.length || !columns.has("id")) return [];
  const rows = [];
  for (let offset = 0; offset < ids.length; offset += SQLITE_BIND_CHUNK) {
    const chunk = ids.slice(offset, offset + SQLITE_BIND_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const sql = `SELECT ${threadSelectExpressions(columns).join(", ")}
      FROM ${quoteIdentifier("threads")}
      WHERE ${quoteIdentifier("id")} IN (${placeholders})`;
    rows.push(...db.prepare(sql).all(...chunk));
  }
  return rows;
}

function withinDirectory(file, directory) {
  const relative = path.relative(directory, file);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function resolveRolloutPath(rawPath, codexHome) {
  if (typeof rawPath !== "string" || !rawPath.trim()) return null;
  const home = path.resolve(codexHome);
  const candidate = path.resolve(home, rawPath);
  return withinDirectory(candidate, home) ? candidate : null;
}

function activityEvidence({ source, latestTurn, stale, eventCount = 0 }) {
  return {
    source,
    turnId: latestTurn?.turnId ?? null,
    latestStatus: normalizeStatus(latestTurn?.status),
    startedAt: latestTurn?.startedAt ?? null,
    completedAt: latestTurn?.completedAt ?? null,
    stale: Boolean(stale),
    eventCount: Number.isFinite(eventCount) ? eventCount : 0,
  };
}

function classifyActivity(latestTurn, now) {
  if (!latestTurn) return { status: "unknown", stale: false };
  const classified = statusClass(latestTurn.status);
  if (classified !== "active") return { status: classified, stale: false };
  const startedAt = latestTurn.startedAt;
  const stale = startedAt === null || now - startedAt > RECENT_WINDOW_MS;
  return stale
    ? { status: "unknown", stale: true }
    : { status: "active", stale: false };
}

export class LocalReader {
  constructor({ codexHome, now = Date.now } = {}) {
    this.codexHome = path.resolve(
      codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    );
    this.now = now;
  }

  read() {
    const now = nowValue(this.now);
    const cutoffMs = now - RECENT_WINDOW_MS;
    const diagnostics = {
      ok: true,
      readOnly: true,
      recentWindowMs: RECENT_WINDOW_MS,
      recentThreadLimit: RECENT_THREAD_LIMIT,
      stateDb: {
        path: path.join(this.codexHome, "state_5.sqlite"),
        available: false,
        compatible: false,
        selectedFields: [],
      },
      historyDb: {
        path: path.join(this.codexHome, "thread_history_1.sqlite"),
        available: false,
        compatible: false,
        selectedFields: [],
      },
      errors: [],
      incompatible: [],
      warnings: [],
      legacyRolloutsRead: 0,
      rolloutBytesRead: 0,
      rolloutErrors: 0,
      malformedRolloutLines: 0,
      guardiansExcluded: 0,
      truncated: false,
      returned: 0,
    };
    const statePath = diagnostics.stateDb.path;
    const historyPath = diagnostics.historyDb.path;
    const stateDb = fs.existsSync(statePath)
      ? openReadOnlyDatabase(statePath, diagnostics, "state database")
      : null;
    if (!stateDb) {
      if (!fs.existsSync(statePath))
        diagnostics.incompatible.push("state_5.sqlite is missing");
    } else {
      diagnostics.stateDb.available = true;
    }
    const historyDb = fs.existsSync(historyPath)
      ? openReadOnlyDatabase(
          historyPath,
          diagnostics,
          "thread history database",
        )
      : null;
    if (!historyDb) {
      if (!fs.existsSync(historyPath))
        diagnostics.incompatible.push("thread_history_1.sqlite is missing");
    } else {
      diagnostics.historyDb.available = true;
    }

    const threadsById = new Map();
    const recentRows = [];
    let stateColumns = new Set();
    let historyColumns = new Set();
    let activeTurnRows = [];

    try {
      if (stateDb && hasTable(stateDb, "threads")) {
        stateColumns = dbTableColumns(stateDb, "threads");
        diagnostics.stateDb.selectedFields = THREAD_COLUMNS.filter((name) =>
          stateColumns.has(name),
        );
        if (!stateColumns.has("id")) {
          diagnostics.incompatible.push("state threads table has no id column");
        } else if (
          (!stateColumns.has("title") && !stateColumns.has("name")) ||
          !stateColumns.has("tokens_used")
        ) {
          diagnostics.incompatible.push(
            "state threads table is missing name/title or tokens_used",
          );
        }
        const queried = stateRowQuery(stateDb, stateColumns, cutoffMs);
        recentRows.push(...queried.rows);
        diagnostics.truncated ||= Boolean(queried.truncated);
        if (!queried.compatible)
          diagnostics.incompatible.push("state threads table is incompatible");
      } else if (stateDb) {
        diagnostics.incompatible.push("state_5.sqlite has no threads table");
      }
      if (historyDb && hasTable(historyDb, "thread_turns")) {
        historyColumns = dbTableColumns(historyDb, "thread_turns");
        diagnostics.historyDb.selectedFields = TURN_COLUMNS.filter((name) =>
          historyColumns.has(name),
        );
        if (!historyColumns.has("thread_id") || !historyColumns.has("status")) {
          diagnostics.incompatible.push(
            "thread_turns table is missing thread_id or status",
          );
        } else {
          activeTurnRows = recentActiveTurnRows(
            historyDb,
            historyColumns,
            cutoffMs,
          );
        }
      } else if (historyDb) {
        diagnostics.incompatible.push(
          "thread_history_1.sqlite has no thread_turns table",
        );
      }

      // The first query is capped at 200 recent threads.  Active turns are
      // queried separately so a long-lived active thread outside that page is
      // still represented.
      for (const row of recentRows) {
        const id = safeText(row.id);
        if (id) threadsById.set(id, row);
      }
      const activeIds = [
        ...new Set(
          activeTurnRows.map((row) => safeText(row.thread_id)).filter(Boolean),
        ),
      ];
      if (stateDb && activeIds.length) {
        for (const row of metadataByIds(stateDb, stateColumns, activeIds)) {
          const id = safeText(row.id);
          if (id) threadsById.set(id, row);
        }
      }

      let latestTurns = new Map();
      if (historyDb && historyColumns.has("thread_id")) {
        latestTurns = latestTurnRows(historyDb, historyColumns, [
          ...threadsById.keys(),
        ]);
        // Active rows fetched for the complement are already useful if the
        // corresponding thread has no state row in the latest page.
        for (const row of activeTurnRows) {
          const id = safeText(row.thread_id);
          if (!id) continue;
          const current = latestTurns.get(id);
          if (!current || turnSortValue(row) >= turnSortValue(current))
            latestTurns.set(id, row);
        }
      }

      const output = [];
      for (const row of threadsById.values()) {
        const id = safeText(row.id);
        if (!id) continue;
        const sourceInfo = parseSource(row.source);
        const threadSource = safeText(row.thread_source);
        if (sourceInfo.parseError) {
          diagnostics.incompatible.push(
            "one or more thread source values are invalid JSON",
          );
        }
        if (
          sourceInfo.isGuardian ||
          threadSource?.toLowerCase() === "guardian_review"
        ) {
          diagnostics.guardiansExcluded += 1;
          continue;
        }

        let latestTurn = latestTurns.has(id)
          ? latestTurnFromRow(latestTurns.get(id))
          : null;
        let tokenDelta = null;
        let tokens = rowTokens(row.tokens_used);
        let updatedAt = rowTimestamp(row) ?? now;
        let activitySource = "thread_history";
        let eventCount = 0;
        const historyMode = safeText(row.history_mode);
        const rolloutPath = resolveRolloutPath(
          row.rollout_path,
          this.codexHome,
        );
        // A projected legacy turn already supplies lifecycle state.  Only
        // fall back to the JSONL tail when the projection is missing,
        // incomplete/stale, or the state database has no token count.  This
        // keeps a five-second refresh from rereading every legacy transcript.
        const projectedActivity = classifyActivity(latestTurn, now);
        const needsLegacy =
          !latestTurn ||
          finiteNumber(row.tokens_used) === null ||
          projectedActivity.status === "unknown";
        if (needsLegacy && rolloutPath) {
          const legacy = readLegacyRollout(rolloutPath, diagnostics);
          if (legacy) {
            activitySource = legacy.source;
            eventCount = legacy.eventCount;
            if (!latestTurn && legacy.latestTurn)
              latestTurn = legacy.latestTurn;
            if (
              finiteNumber(row.tokens_used) === null &&
              legacy.tokens !== null
            )
              tokens = rowTokens(legacy.tokens);
            if (legacy.tokenDelta !== null)
              tokenDelta = rowTokens(legacy.tokenDelta);
            if (legacy.updatedAt !== null)
              updatedAt = Math.max(updatedAt, legacy.updatedAt);
          }
        } else if (historyMode === "legacy" && row.rollout_path) {
          diagnostics.warnings.push(
            "legacy rollout path is outside CODEX_HOME and was skipped",
          );
        }

        const activity = classifyActivity(latestTurn, now);
        const thread = {
          id,
          title: safeTitle(row.name, row.title),
          model: safeText(row.model),
          reasoningEffort: safeText(row.reasoning_effort),
          parentThreadId: sourceInfo.parentThreadId,
          source: threadSource || sourceInfo.kind || null,
          status: activity.status,
          startedAt: latestTurn?.startedAt ?? null,
          completedAt: latestTurn?.completedAt ?? null,
          updatedAt,
          tokens,
          activityEvidence: activityEvidence({
            source: activitySource,
            latestTurn,
            stale: activity.stale,
            eventCount,
          }),
        };
        if (tokenDelta !== null) thread.tokenDelta = tokenDelta;
        output.push(thread);
      }

      output.sort(
        (left, right) =>
          right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
      );
      diagnostics.returned = output.length;
      diagnostics.ok =
        diagnostics.errors.length === 0 &&
        diagnostics.incompatible.length === 0;
      return { threads: output, diagnostics };
    } catch (error) {
      diagnostics.errors.push(
        `reader: ${String(error?.message || error)}`.slice(0, 500),
      );
      diagnostics.ok = false;
      return { threads: [], diagnostics };
    } finally {
      try {
        stateDb?.close();
      } catch {
        /* read-only cleanup */
      }
      try {
        historyDb?.close();
      } catch {
        /* read-only cleanup */
      }
    }
  }
}

export const LOCAL_READER_CONSTANTS = Object.freeze({
  RECENT_WINDOW_MS,
  RECENT_THREAD_LIMIT,
  MAX_ROLLOUT_TAIL_BYTES,
});
