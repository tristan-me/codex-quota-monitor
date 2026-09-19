import { COST_RATE_VERSION, tokenUsage, usageDifference, usageCredits, addUsage } from './usage-cost.mjs';
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_WINDOW_MS = DAY_MS;
const MIN_RETENTION_HOURS = 1;
const MAX_RETENTION_HOURS = 168;
const ACTIVE_STALE_WINDOW_MS = MAX_RETENTION_HOURS * 60 * 60 * 1000;
const RECENT_THREAD_LIMIT = 200;
const KNOWN_THREAD_LIMIT = 10000;
const MAX_ROLLOUT_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_ROLLOUT_BOOTSTRAP_BYTES = 64 * 1024 * 1024;
const PROJECTION_LAG_MS = 2_000;
const MAX_ROLLOUT_LINE_BYTES = 2 * 1024 * 1024;
const SQLITE_BIND_CHUNK = 500;
const MAX_TURN_HISTORY_PER_THREAD = 5_000;
const MAX_PROVIDER_CONFIG_BYTES = 1024 * 1024;

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
  "idle",
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
  "model_provider",
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
  "model_provider",
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

function providerId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(id) ? id : null;
}

function providerName(value, id) {
  if (typeof value !== "string") return id;
  const name = value.trim();
  // Names are labels, never a fallback for endpoint or authentication fields.
  return name && name.length <= 120 && !/[\u0000-\u001f\u007f]|[a-z][a-z0-9+.-]*:\/\//i.test(name)
    ? name : id;
}

function tomlString(value) {
  if (/^'[^']*'$/.test(value)) return value.slice(1, -1);
  if (!/^"(?:[^"\\]|\\.)*"$/.test(value)) return null;
  try {
    return JSON.parse(value.replace(/\\U([0-9a-fA-F]{8})/g, (_, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      if (codePoint > 0x10ffff) throw new Error("invalid code point");
      return JSON.stringify(String.fromCodePoint(codePoint)).slice(1, -1);
    }));
  } catch {
    return null;
  }
}

function tomlTablePath(value) {
  const parts = [];
  let remaining = value.trim();
  while (remaining) {
    const match = /^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*/.exec(remaining);
    if (!match) return null;
    parts.push(match[1][0] === '"' || match[1][0] === "'"
      ? tomlString(match[1]) : match[1]);
    remaining = remaining.slice(match[0].length);
    if (!remaining) break;
    if (remaining[0] !== ".") return null;
    remaining = remaining.slice(1).trimStart();
    if (!remaining) return null;
  }
  return parts;
}

// Read just the supported provider labels. This small TOML scanner skips
// comments and multiline strings, including instructions containing TOML-like
// text, and never materializes unrelated settings in the returned object.
function providerConfigFromText(text) {
  const providers = new Map();
  let activeProvider = null;
  let section = [];
  let multiline = null;
  for (const rawLine of text.split(/\r?\n/)) {
    let quote = null;
    let escaped = false;
    let ignored = Boolean(multiline);
    let end = rawLine.length;
    for (let index = 0; index < rawLine.length; index += 1) {
      const char = rawLine[index];
      if (escaped) { escaped = false; continue; }
      if ((multiline === '"' || quote === '"') && char === "\\") {
        escaped = true;
        continue;
      }
      if (multiline) {
        if (rawLine.slice(index, index + 3) === multiline.repeat(3)) {
          multiline = null;
          index += 2;
        }
        continue;
      }
      if (quote) {
        if (char === quote) quote = null;
        continue;
      }
      if (char === "#") { end = index; break; }
      if (char === '"' || char === "'") {
        if (rawLine.slice(index, index + 3) === char.repeat(3)) {
          multiline = char;
          ignored = true;
          index += 2;
        } else quote = char;
      }
    }
    if (ignored || quote) continue;
    const line = rawLine.slice(0, end).trim();
    if (line.startsWith("[")) {
      section = /^\[[^\[].*\]$/.test(line)
        ? tomlTablePath(line.slice(1, -1)) : null;
      if (section?.length === 2 && section[0] === "model_providers") {
        const id = providerId(section[1]);
        if (id && !providers.has(id)) providers.set(id, { id, name: id });
      }
      continue;
    }
    if (section?.length === 0) {
      const match = /^(?:model_provider|"model_provider"|'model_provider')\s*=\s*(.*)$/.exec(line);
      if (match) activeProvider = providerId(tomlString(match[1]));
    } else if (section?.length === 2 && section[0] === "model_providers") {
      const id = providerId(section[1]);
      const match = /^(?:name|"name"|'name')\s*=\s*(.*)$/.exec(line);
      if (id && match) providers.set(id, { id, name: providerName(tomlString(match[1]), id) });
    }
  }
  if (activeProvider && !providers.has(activeProvider)) {
    providers.set(activeProvider, { id: activeProvider, name: activeProvider });
  }
  return { activeProvider, providers: [...providers.values()] };
}

function readProviderConfig(codexHome, diagnostics) {
  const empty = { activeProvider: null, providers: [] };
  const file = path.join(codexHome, "config.toml");
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_PROVIDER_CONFIG_BYTES) {
      diagnostics.warnings.push("config.toml provider metadata exceeds the bounded reader");
      return empty;
    }
    const buffer = Buffer.alloc(stat.size);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return providerConfigFromText(buffer.subarray(0, bytes).toString("utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      diagnostics.warnings.push("config.toml provider metadata could not be read");
    }
    return empty;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
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

function providerContext(payload, state, previous = null) {
  if (Object.hasOwn(payload, "model_provider") || Object.hasOwn(payload, "modelProvider")) {
    return {
      modelProvider: providerId(payload.model_provider ?? payload.modelProvider),
      providerSource: "turn_context",
      providerObservedMatch: false,
    };
  }
  if (previous?.providerSource || previous?.providerAmbiguous) {
    return {
      modelProvider: previous.modelProvider,
      providerSource: previous.providerSource,
      providerObservedMatch: previous.providerObservedMatch,
      providerAmbiguous: previous.providerAmbiguous,
    };
  }
  const modelProvider = state.sessionMetadata?.modelProvider ?? null;
  return {
    modelProvider,
    providerSource: modelProvider ? "session_meta" : null,
    providerObservedMatch: Boolean(modelProvider && modelProvider === state.threadModelProvider),
  };
}

function resolvedTurnProvider(turn, threadModelProvider) {
  if (turn?.providerAmbiguous) {
    return { modelProvider: null, providerSource: turn.providerSource, providerAmbiguous: true };
  }
  const modelProvider = providerId(turn?.modelProvider);
  // The thread row describes its current provider. An initial session header
  // cannot establish when an unrecorded resume/provider switch occurred.
  if (modelProvider && turn.providerSource === "session_meta" &&
      threadModelProvider && modelProvider !== threadModelProvider &&
      !(turn.providerObservedMatch && statusClass(turn.status) === "idle")) {
    return { modelProvider: null, providerSource: "conflicting-thread-metadata", providerAmbiguous: true };
  }
  return { modelProvider, providerSource: turn?.providerSource ?? null, providerAmbiguous: false };
}

function markProviderAmbiguous(turn, state, source) {
  // A single turn may be resumed on another provider. Without request-level
  // attribution its combined token counter must not become subscription cost.
  state.usageCredits -= turn.costCredits || 0;
  state.costTokens -= turn.costTokens || 0;
  state.sessionUsageCredits -= turn.sessionCostCredits || 0;
  state.sessionCostTokens -= turn.sessionCostTokens || 0;
  state.observedSessionUsageCredits -= turn.observedSessionCostCredits || 0;
  state.observedSessionCostTokens -= turn.observedSessionCostTokens || 0;
  Object.assign(turn, {
    modelProvider: null, providerSource: source, providerAmbiguous: true,
    costCredits: 0, costTokens: 0, costPartial: true,
    sessionCostCredits: 0, sessionCostTokens: 0,
    observedSessionCostCredits: 0, observedSessionCostTokens: 0,
  });
}

function confirmExplicitProviderCost(turn, state) {
  // A later explicit provider on the same turn confirms prior matching
  // session-level samples. They no longer depend on current thread metadata.
  state.sessionUsageCredits -= turn.sessionCostCredits || 0;
  state.sessionCostTokens -= turn.sessionCostTokens || 0;
  state.observedSessionUsageCredits -= turn.observedSessionCostCredits || 0;
  state.observedSessionCostTokens -= turn.observedSessionCostTokens || 0;
  turn.sessionCostCredits = turn.sessionCostTokens = 0;
  turn.observedSessionCostCredits = turn.observedSessionCostTokens = 0;
}

function parseLegacyEventLine(line, state, sequence) {
  if (sequence === 0) state.sessionHeaderInspected = true;
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
  if (outerType === "session_meta") {
    const metadata = {
      modelProvider: providerId(payload.model_provider ?? payload.modelProvider),
      timestamp: normalizeTimestamp(row.timestamp),
    };
    state.firstSessionMetadata ??= metadata;
    state.sessionMetadata = metadata;
    return true;
  }
  if (outerType === "turn_context") {
    const explicitTurnId = safeText(payload.turn_id ?? payload.turnId);
    const turn = state.turns.get(explicitTurnId || state.latestKey);
    const turnId = explicitTurnId || turn?.turnId || null;
    const previous = turn || (state.currentContext?.turnId === turnId ? state.currentContext : null);
    state.currentContext = {
      turnId, model: safeText(payload.model),
      reasoningEffort: safeText(payload.effort ?? payload.reasoning_effort),
      serviceTier: safeText(payload.service_tier),
      ...providerContext(payload, state, previous),
    };
    if (turn) {
      const previousProvider = turn.modelProvider;
      const wasAmbiguous = turn.providerAmbiguous;
      Object.assign(turn, state.currentContext);
      if (wasAmbiguous || (turn.tokenUsage?.totalTokens > 0 &&
          previousProvider !== turn.modelProvider)) {
        markProviderAmbiguous(turn, state, "mixed-turn-providers");
      } else if (turn.providerSource === "turn_context") {
        confirmExplicitProviderCost(turn, state);
      }
    }
    return true;
  }
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
  const explicitStartedAt = normalizeTimestamp(
    eventField(payload, ["started_at", "startedAt"]),
  );
  const explicitCompletedAt = normalizeTimestamp(
    eventField(payload, ["completed_at", "completedAt"]),
  );
  const startedAt = explicitStartedAt ?? eventAt;
  const completedAt = explicitCompletedAt ?? eventAt;
  let current = turnId || "__rollout_latest__";
  if ((type === "task_complete" || type === "turn_aborted") && !turnId) {
    current = state.latestKey || current;
  }

  if (type === "task_started") {
    const previous = state.turns.get(current);
    const context = state.currentContext?.turnId === turnId ? state.currentContext : null;
    state.turns.set(current, newerLifecycle(previous, {
      ...(context || providerContext(payload, state)),
      ...(previous?.startedAt === startedAt ? previous : {}),
      turnId,
      usageStartSeen: true,
      status: "inProgress",
      startedAt,
      completedAt: null,
      eventAt: eventAt ?? startedAt,
      source: "legacy_tail",
      sequence,
    }));
    state.latestKey = current;
    if (state.currentContext?.turnId !== turnId) state.currentContext = null;
    state.eventCount += 1;
    return true;
  }

  if (type === "task_complete" || type === "turn_aborted") {
    const previous =
      state.turns.get(current) || state.turns.get("__rollout_latest__");
    const terminalStatus = type === "task_complete" ? "completed" : "aborted";
    const durationMs = finiteNumber(
      eventField(payload, ["duration_ms", "durationMs"]),
    );
    const completed = explicitCompletedAt ?? eventAt ?? previous?.completedAt ?? null;
    const started =
      previous?.startedAt ??
      explicitStartedAt ??
      (durationMs !== null && durationMs > 0 && completed !== null
        ? completed - durationMs
        : null);
    if (current !== "__rollout_latest__" && previous && !previous.turnId) {
      state.turns.delete("__rollout_latest__");
    }
    state.turns.set(current, newerLifecycle(previous, {
      ...previous,
      turnId: turnId || previous?.turnId || null,
      status: terminalStatus,
      startedAt: started,
      completedAt: completed,
      eventAt: eventAt ?? completedAt ?? previous?.eventAt ?? null,
      durationMs,
      source: "legacy_tail",
      sequence,
    }));
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
    const cumulative = tokenUsage(totalUsage);
    const last = tokenUsage(lastUsage);
    let increment = usageDifference(cumulative, state.lastTokenUsage);
    if (!increment && cumulative && last && cumulative.totalTokens === last.totalTokens)
      increment = last;
    // A reset or a truncated beginning establishes a new baseline. Never count
    // the prior turn's last request again just because a snapshot repeats it.
    if (cumulative) state.lastTokenUsage = cumulative;
    const owner = turnId || state.currentContext?.turnId || state.latestKey;
    const turn = state.turns.get(owner);
    const hasReportedUsage = totalUsage || lastUsage || total !== null || delta !== null;
    if (turn && hasReportedUsage && (!cumulative || !increment)) {
      turn.usagePartial = true;
      turn.costPartial = true;
    }
    if (increment?.totalTokens > 0 && turn && Number.isFinite(eventAt) &&
        (!Number.isFinite(turn.startedAt) || eventAt >= turn.startedAt) &&
        (!Number.isFinite(turn.completedAt) || eventAt <= turn.completedAt + 5000)) {
      const context = state.currentContext?.turnId === turn.turnId ? state.currentContext : turn;
      let provider = resolvedTurnProvider(turn, state.threadModelProvider);
      if (provider.providerAmbiguous && turn.tokenUsage?.totalTokens > 0 && !turn.providerAmbiguous) {
        markProviderAmbiguous(turn, state, provider.providerSource);
        provider = resolvedTurnProvider(turn, state.threadModelProvider);
      }
      const credits = provider.modelProvider === "openai"
        ? usageCredits(increment, context.model, context.serviceTier) : null;
      turn.tokenUsage = addUsage(turn.tokenUsage, increment);
      turn.costCredits = (turn.costCredits || 0) + (credits || 0);
      turn.costTokens = (turn.costTokens || 0) + (credits === null ? 0 : increment.totalTokens);
      turn.costPartial ||= credits === null;
      if (credits !== null) turn.costRateVersion = COST_RATE_VERSION;
      turn.usageFirstAt ??= eventAt;
      turn.usageLastAt = eventAt;
      turn.usageSamples = (turn.usageSamples || 0) + 1;
      if (credits !== null) {
        state.usageCredits += credits;
        state.costTokens += increment.totalTokens;
        if (turn.providerSource === "session_meta") {
          state.sessionUsageCredits += credits;
          state.sessionCostTokens += increment.totalTokens;
          turn.sessionCostCredits = (turn.sessionCostCredits || 0) + credits;
          turn.sessionCostTokens = (turn.sessionCostTokens || 0) + increment.totalTokens;
          if (turn.providerObservedMatch) {
            state.observedSessionUsageCredits += credits;
            state.observedSessionCostTokens += increment.totalTokens;
            turn.observedSessionCostCredits = (turn.observedSessionCostCredits || 0) + credits;
            turn.observedSessionCostTokens = (turn.observedSessionCostTokens || 0) + increment.totalTokens;
          }
        }
      }
    }
    if (total !== null) state.tokens = total;
    if (delta !== null) state.tokenDelta = delta;
    state.lastTokenAt = eventAt;
    state.eventCount += 1;
    return true;
  }
  return false;
}

function newerLifecycle(current, candidate) {
  if (!current) return candidate;
  if (!candidate) return current;
  const sameTurn = current.turnId && current.turnId === candidate.turnId;
  if (sameTurn) {
    candidate = { ...candidate, startedAt: candidate.startedAt ?? current.startedAt };
    const currentStart = current.startedAt ?? 0;
    const candidateStart = candidate.startedAt ?? 0;
    if (candidateStart !== currentStart) return candidateStart > currentStart ? candidate : current;
    if (statusClass(current.status) === "idle" && statusClass(candidate.status) !== "idle") return current;
    if (statusClass(candidate.status) === "idle" && statusClass(current.status) !== "idle") return candidate;
    return (candidate.completedAt ?? candidate.eventAt ?? 0) >
      (current.completedAt ?? current.eventAt ?? 0) ? candidate : current;
  }
  // A late completion for an older turn must not replace a newer live turn.
  const currentStart = current.startedAt ?? 0;
  const candidateStart = candidate.startedAt ?? 0;
  if (candidateStart !== currentStart) return candidateStart > currentStart ? candidate : current;
  if (candidate.source === "legacy_tail" && current.source === "legacy_tail" &&
      candidate.sequence !== current.sequence) {
    return candidate.sequence > current.sequence ? candidate : current;
  }
  return (candidate.completedAt ?? candidate.eventAt ?? 0) >
    (current.completedAt ?? current.eventAt ?? 0) ? candidate : current;
}

function readInitialSessionMetadata(fd, stat, state) {
  const chunks = [];
  let bytesRead = 0;
  while (bytesRead < Math.min(stat.size, MAX_ROLLOUT_LINE_BYTES)) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, stat.size - bytesRead,
      MAX_ROLLOUT_LINE_BYTES - bytesRead));
    const count = fs.readSync(fd, buffer, 0, buffer.length, bytesRead);
    if (!count) break;
    bytesRead += count;
    const chunk = buffer.subarray(0, count);
    const newline = chunk.indexOf(10);
    chunks.push(newline < 0 ? chunk : chunk.subarray(0, newline));
    if (newline < 0) continue;
    try {
      const row = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (row?.type === "session_meta") {
        const metadata = {
          modelProvider: providerId(row.payload?.model_provider ?? row.payload?.modelProvider),
          timestamp: normalizeTimestamp(row.timestamp),
        };
        state.firstSessionMetadata = metadata;
        state.sessionMetadata = metadata;
      }
    } catch {
      // An unreadable header is missing evidence, never a default provider.
    }
    break;
  }
  return bytesRead;
}

function readLegacyRollout(file, diagnostics, { stat, previous, modelProvider,
  maxBytes = MAX_ROLLOUT_TAIL_BYTES } = {}) {
  const state = {
    turns: new Map((previous?.lifecycleTurns || []).map((turn) => [turn.turnId || "__rollout_latest__", turn])),
    latestKey: previous?.latestTurn?.turnId || null,
    tokens: previous?.tokens ?? null,
    lastTokenUsage: previous?.lastTokenUsage ?? null,
    currentContext: previous?.currentContext ?? null,
    threadModelProvider: providerId(modelProvider),
    firstSessionMetadata: previous?.firstSessionMetadata ?? null,
    sessionMetadata: previous?.sessionMetadata ?? null,
    sessionHeaderInspected: previous?.sessionHeaderInspected ?? false,
    usageCredits: previous?.usageCredits ?? 0,
    sessionUsageCredits: previous?.sessionUsageCredits ?? 0,
    sessionCostTokens: previous?.sessionCostTokens ?? 0,
    observedSessionUsageCredits: previous?.observedSessionUsageCredits ?? 0,
    observedSessionCostTokens: previous?.observedSessionCostTokens ?? 0,
    usageEpoch: previous?.usageEpoch ?? randomUUID(),
    costTokens: previous?.costTokens ?? 0,
    tokenDelta: previous?.tokenDelta ?? null,
    lastTokenAt: previous?.tokenUpdatedAt ?? null,
    eventCount: 0,
    malformedLines: 0,
    bytesRead: 0,
  };
  let fd;
  try {
    stat ||= fs.statSync(file);
    if (!stat.isFile()) throw new Error("rollout path is not a regular file");
    const savedOffset = previous?.readOffset ?? 0;
    let start = Math.max(savedOffset, stat.size - maxBytes, 0);
    fd = fs.openSync(file, "r");
    if (start > 0 && !state.sessionHeaderInspected) {
      // Keep a session header available when the lifecycle reader starts at a
      // tail offset. Both reads share the same total byte budget.
      state.bytesRead += readInitialSessionMetadata(fd, stat, state);
      state.sessionHeaderInspected = true;
      start = Math.max(savedOffset, stat.size - (maxBytes - state.bytesRead), 0);
    }
    state.readOffset = start;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = start;
    let carry = Buffer.alloc(0);
    let discardFirstPartialLine = start > 0 && start !== savedOffset;
    let sequence = 0;
    let droppingOversizedLine = false;
    while (offset < stat.size) {
      const readSize = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (!readSize) break;
      offset += readSize;
      state.bytesRead += readSize;
      let chunk = buffer.subarray(0, readSize);
      if (discardFirstPartialLine || droppingOversizedLine) {
        const newline = chunk.indexOf(10);
        if (newline < 0) continue;
        chunk = chunk.subarray(newline + 1);
        discardFirstPartialLine = false;
        droppingOversizedLine = false;
      }
      const pending = Buffer.concat([carry, chunk]);
      let lineStart = 0;
      let newline;
      while ((newline = pending.indexOf(10, lineStart)) >= 0) {
        sequence = offset - pending.length + lineStart;
        if (newline - lineStart <= MAX_ROLLOUT_LINE_BYTES) {
          parseLegacyEventLine(pending.subarray(lineStart, newline).toString("utf8"), state, sequence);
        }
        lineStart = newline + 1;
      }
      carry = Buffer.from(pending.subarray(lineStart));
      state.readOffset = offset - carry.length;
      if (carry.length > MAX_ROLLOUT_LINE_BYTES) {
        carry = Buffer.alloc(0);
        droppingOversizedLine = true;
      }
    }
    // Retain only a byte offset, never raw partial content. A complete JSON
    // event without its trailing newline remains readable and will be retried.
    if (carry.length && !discardFirstPartialLine && !droppingOversizedLine) {
      parseLegacyEventLine(carry.toString("utf8"), state, offset - carry.length);
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

  const lifecycleTurns = [...state.turns.values()]
    .sort((a, b) => (b.startedAt ?? b.completedAt ?? 0) - (a.startedAt ?? a.completedAt ?? 0))
    .slice(0, MAX_TURN_HISTORY_PER_THREAD);
  let latest = null;
  for (const turn of lifecycleTurns) latest = newerLifecycle(latest, turn);
  const updatedAt =
    [latest?.eventAt, latest?.completedAt, latest?.startedAt, state.lastTokenAt]
      .filter((value) => value !== null && value !== undefined)
      .reduce((max, value) => Math.max(max, value), 0) || null;
  return {
    tokens: state.tokens,
    lastTokenUsage: state.lastTokenUsage,
    currentContext: state.currentContext,
    firstSessionMetadata: state.firstSessionMetadata,
    sessionMetadata: state.sessionMetadata,
    sessionHeaderInspected: state.sessionHeaderInspected,
    usageCredits: state.usageCredits,
    sessionUsageCredits: state.sessionUsageCredits,
    sessionCostTokens: state.sessionCostTokens,
    observedSessionUsageCredits: state.observedSessionUsageCredits,
    observedSessionCostTokens: state.observedSessionCostTokens,
    usageEpoch: state.usageEpoch,
    costTokens: state.costTokens,
    tokenDelta: state.tokenDelta,
    tokenUpdatedAt: state.lastTokenAt,
    readOffset: state.readOffset,
    lifecycleTurns,
    updatedAt,
    latestTurn: latest,
    executionHistory: {
      turns: lifecycleTurns.map((turn) => executionTurnMetadata(turn, state.threadModelProvider)),
      intervals: lifecycleTurns
        .filter((turn) => statusClass(turn.status) === "idle")
        .map(intervalFromTurn)
        .filter(Boolean),
      coverage: "partial",
      source: "legacy_tail",
    },
    eventCount: state.eventCount,
    source: "rollout_jsonl",
  };
}

function executionTurnMetadata(turn, threadModelProvider) {
  const provider = resolvedTurnProvider(turn, threadModelProvider);
  const hasCost = provider.modelProvider === "openai" && turn.costTokens > 0;
  return {
    turnId: turn.turnId,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs ?? null,
    status: statusClass(turn.status),
    model: turn.model || null,
    ...provider,
    reasoningEffort: turn.reasoningEffort || null,
    serviceTier: turn.serviceTier || null,
    tokenUsage: turn.tokenUsage || null,
    usageCoverage: turn.tokenUsage && turn.usageStartSeen && !turn.usagePartial
      ? "recorded-turn" : "partial-turn",
    costCredits: hasCost ? turn.costCredits : null,
    costTokens: hasCost ? turn.costTokens : 0,
    costRateVersion: hasCost ? turn.costRateVersion || null : null,
    costCoverage: hasCost && turn.usageStartSeen && !turn.costPartial ? "recorded-turn" : "partial-turn",
  };
}

function providerAdjustedRollout(rollout, threadModelProvider) {
  // Remember evidence seen before a later provider switch. Only completed
  // turns keep that historical match when the current thread provider changes.
  for (const turn of rollout.lifecycleTurns) {
    if (threadModelProvider && turn.modelProvider === threadModelProvider &&
        turn.providerSource === "session_meta" && !turn.providerAmbiguous && !turn.providerObservedMatch) {
      turn.providerObservedMatch = true;
      rollout.observedSessionUsageCredits += (turn.sessionCostCredits || 0) - (turn.observedSessionCostCredits || 0);
      rollout.observedSessionCostTokens += (turn.sessionCostTokens || 0) - (turn.observedSessionCostTokens || 0);
      turn.observedSessionCostCredits = turn.sessionCostCredits || 0;
      turn.observedSessionCostTokens = turn.sessionCostTokens || 0;
    }
  }
  let usageCredits = rollout.usageCredits;
  let costTokens = rollout.costTokens;
  if (threadModelProvider && threadModelProvider !== "openai") {
    usageCredits -= rollout.sessionUsageCredits - rollout.observedSessionUsageCredits;
    costTokens -= rollout.sessionCostTokens - rollout.observedSessionCostTokens;
    for (const turn of rollout.lifecycleTurns) {
      if (resolvedTurnProvider(turn, threadModelProvider).providerAmbiguous) {
        usageCredits -= turn.observedSessionCostCredits || 0;
        costTokens -= turn.observedSessionCostTokens || 0;
      }
    }
  }
  return {
    ...rollout,
    usageCredits: costTokens > 0 ? Math.max(0, usageCredits) : null,
    costTokens: Math.max(0, costTokens),
    latestTurn: rollout.latestTurn ? {
      ...rollout.latestTurn, ...resolvedTurnProvider(rollout.latestTurn, threadModelProvider),
    } : null,
    executionHistory: {
      ...rollout.executionHistory,
      turns: rollout.lifecycleTurns.map((turn) => executionTurnMetadata(turn, threadModelProvider)),
    },
  };
}

// A larger file with the same inode can be a rewrite, not an append. Keep
// only a small digest of the previously observed boundaries to verify it.
function rolloutFingerprint(file, stat) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const current = fs.fstatSync(fd);
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.size < stat.size) return null;
    const hash = createHash("sha256");
    for (const offset of new Set([0, Math.max(0, stat.size - 2048)])) {
      const length = Math.min(2048, stat.size - offset);
      const bytes = Buffer.alloc(length);
      if (length && fs.readSync(fd, bytes, 0, length, offset) !== length) return null;
      hash.update(bytes);
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function latestTurnFromRow(row) {
  if (!row) return null;
  return {
    turnId: safeText(row.turn_id),
    modelProvider: providerId(row.model_provider),
    providerSource: providerId(row.model_provider) ? "thread_history" : null,
    status: safeText(row.status),
    startedAt: normalizeTimestamp(row.started_at),
    completedAt: normalizeTimestamp(row.completed_at),
    eventAt: null,
    sequence: finiteNumber(row.rollout_ordinal),
    durationMs: finiteNumber(row.duration_ms),
    source: "thread_history",
  };
}

function intervalFromTurn(turn) {
  return intervalInfoFromTurn(turn)?.interval || null;
}

function intervalInfoFromTurn(turn) {
  if (!turn || statusClass(turn.status) !== "idle") {
    return { interval: null, inferred: false };
  }
  const startedAt = normalizeTimestamp(turn.startedAt ?? turn.started_at);
  const completedAt = normalizeTimestamp(turn.completedAt ?? turn.completed_at);
  const durationMs = finiteNumber(turn.durationMs ?? turn.duration_ms);
  if (startedAt !== null && completedAt !== null && completedAt > startedAt) {
    return { interval: [startedAt, completedAt], inferred: false };
  }
  if (durationMs !== null && durationMs > 0) {
    if (startedAt !== null) {
      return { interval: [startedAt, startedAt + durationMs], inferred: true };
    }
    if (completedAt !== null) {
      return { interval: [completedAt - durationMs, completedAt], inferred: true };
    }
  }
  return { interval: null, inferred: true };
}

function executionHistoryFromRows(rows, partial = false) {
  const intervals = [];
  let incompleteEvidence = false;
  for (const row of rows || []) {
    const normalized = {
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      durationMs: row.duration_ms,
    };
    if (statusClass(normalized.status) === "active") continue;
    const evidence = intervalInfoFromTurn(normalized);
    if (evidence.interval) intervals.push(evidence.interval);
    if (evidence.inferred || (!evidence.interval && normalizeStatus(normalized.status))) {
      incompleteEvidence = true;
    }
  }
  return {
    turns: (rows || []).map(latestTurnFromRow).filter(Boolean).map((turn) => ({
      turnId: turn.turnId,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
      status: statusClass(turn.status),
      modelProvider: turn.modelProvider,
      providerSource: turn.providerSource,
    })),
    intervals: intervals.sort((left, right) => left[0] - right[0] || left[1] - right[1]),
    coverage: partial || incompleteEvidence || !intervals.length ? "partial" : "local-records",
    source: "thread_history",
  };
}

function mergeExecutionHistory(projected, rollout) {
  const turns = new Map((projected.turns || []).map((turn) => [turn.turnId || `at:${turn.startedAt}`, turn]));
  let changed = false;
  for (const candidate of rollout.turns || []) {
    const key = candidate.turnId || `at:${candidate.startedAt}`;
    const current = turns.get(key);
    const lifecycle = newerLifecycle(current, candidate);
    const provider = candidate.providerSource === "turn_context" ||
      candidate.providerSource === "mixed-turn-providers" || !current?.modelProvider
      ? { modelProvider: candidate.modelProvider, providerSource: candidate.providerSource,
          providerAmbiguous: candidate.providerAmbiguous }
      : { modelProvider: current.modelProvider, providerSource: current.providerSource,
          providerAmbiguous: current.providerAmbiguous };
    const selected = candidate.tokenUsage || candidate.providerSource ? { ...lifecycle,
      model: candidate.model, reasoningEffort: candidate.reasoningEffort,
      ...provider,
      serviceTier: candidate.serviceTier, tokenUsage: candidate.tokenUsage,
      usageCoverage: candidate.usageCoverage,
      costCredits: candidate.costCredits, costTokens: candidate.costTokens,
      costRateVersion: candidate.costRateVersion, costCoverage: candidate.costCoverage,
    } : lifecycle;
    if (selected !== current) {
      turns.set(key, selected);
      changed = true;
    }
  }
  if (!changed) return projected;
  const merged = [...turns.values()]
    .sort((a, b) => (b.startedAt ?? b.completedAt ?? 0) - (a.startedAt ?? a.completedAt ?? 0))
    .slice(0, MAX_TURN_HISTORY_PER_THREAD);
  return {
    turns: merged,
    intervals: merged.map(intervalFromTurn).filter(Boolean),
    coverage: "partial",
    source: "thread_history+rollout_jsonl",
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

function isNewerTurnRow(candidate, current) {
  if (!current) return true;
  const candidateRow = finiteNumber(candidate?.__local_reader_row_number);
  const currentRow = finiteNumber(current?.__local_reader_row_number);
  if (candidateRow !== null || currentRow !== null) {
    if (candidateRow === null) return false;
    if (currentRow === null) return true;
    return candidateRow < currentRow;
  }
  const candidateValue = turnSortValue(candidate);
  const currentValue = turnSortValue(current);
  if (candidateValue !== currentValue) return candidateValue > currentValue;
  const candidateCompleted = normalizeTimestamp(candidate?.completed_at) ?? 0;
  const currentCompleted = normalizeTimestamp(current?.completed_at) ?? 0;
  if (candidateCompleted !== currentCompleted) return candidateCompleted > currentCompleted;
  const candidateStarted = normalizeTimestamp(candidate?.started_at) ?? 0;
  const currentStarted = normalizeTimestamp(current?.started_at) ?? 0;
  return candidateStarted > currentStarted;
}

function turnHistoryRows(db, columns, ids) {
  if (!ids.length || !columns.has("thread_id")) {
    return { rowsByThread: new Map(), partialThreads: new Set() };
  }
  const selected = TURN_COLUMNS.filter((name) => columns.has(name));
  if (!selected.includes("status")) {
    return { rowsByThread: new Map(), partialThreads: new Set(ids) };
  }
  const rowsByThread = new Map();
  const partialThreads = new Set();
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
    const sql = `SELECT ${selectedSql}, "__local_reader_row_number"
      FROM (
        SELECT ${selectedSql}, ROW_NUMBER() OVER (
          PARTITION BY ${quoteIdentifier("thread_id")} ORDER BY ${orderSql}
        ) AS "__local_reader_row_number"
        FROM ${quoteIdentifier("thread_turns")}
        WHERE ${quoteIdentifier("thread_id")} IN (${placeholders})
      )
      WHERE "__local_reader_row_number" <= ${MAX_TURN_HISTORY_PER_THREAD}`;
    const rows = db.prepare(sql).all(...chunk);
    for (const row of rows) {
      const id = safeText(row.thread_id);
      if (!id) continue;
      const list = rowsByThread.get(id) || [];
      list.push(row);
      rowsByThread.set(id, list);
      if (finiteNumber(row.__local_reader_row_number) >= MAX_TURN_HISTORY_PER_THREAD) {
        partialThreads.add(id);
      }
    }
  }
  return { rowsByThread, partialThreads };
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

function stateRowQuery(db, columns, cutoffMs, includeAllKnown = false) {
  const limit = includeAllKnown ? KNOWN_THREAD_LIMIT : RECENT_THREAD_LIMIT;
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
  const params = dateExpression && !includeAllKnown ? [cutoffMs] : [];
  const where = dateExpression && !includeAllKnown
    ? `(${dateExpression} >= ? OR ${dateExpression} IS NULL)`
    : "1 = 1";
  const orderParts = dateParts.map((part) => `${part} DESC`);
  const sql = `SELECT ${threadSelectExpressions(columns).join(", ")}
    FROM ${quoteIdentifier("threads")}
    WHERE ${where}
    ORDER BY ${orderParts.length ? orderParts.join(", ") : quoteIdentifier("id")}
    LIMIT ${limit + 1}`;
  const rows = db.prepare(sql).all(...params);
  return {
    rows: rows.slice(0, limit),
    compatible: true,
    truncated: rows.length > limit,
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
  const lastTurnDurationMs = intervalFromTurn(latestTurn)?.[1] !== undefined
    ? intervalFromTurn(latestTurn)[1] - intervalFromTurn(latestTurn)[0]
    : null;
  return {
    source,
    turnId: latestTurn?.turnId ?? null,
    turnSequence:
      source === "thread_history" && Number.isFinite(latestTurn?.sequence)
        ? latestTurn.sequence
        : null,
    latestStatus: normalizeStatus(latestTurn?.status),
    startedAt: latestTurn?.startedAt ?? null,
    completedAt: latestTurn?.completedAt ?? null,
    lastTurnDurationMs:
      statusClass(latestTurn?.status) === "idle" &&
      Number.isFinite(latestTurn?.durationMs) && latestTurn.durationMs > 0
        ? latestTurn.durationMs
        : lastTurnDurationMs,
    stale: Boolean(stale),
    eventCount: Number.isFinite(eventCount) ? eventCount : 0,
  };
}

function classifyActivity(latestTurn, now, staleWindowMs = ACTIVE_STALE_WINDOW_MS) {
  if (!latestTurn) return { status: "unknown", stale: false };
  const classified = statusClass(latestTurn.status);
  if (classified !== "active") return { status: classified, stale: false };
  const startedAt = latestTurn.startedAt;
  const stale = startedAt === null || now - startedAt > staleWindowMs;
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
    this.rolloutCache = new Map();
  }

  readRollout(file, diagnostics, { bootstrap = false, modelProvider = null } = {}) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return readLegacyRollout(file, diagnostics, { modelProvider });
    }
    const cached = this.rolloutCache.get(file);
    if (cached && cached.dev === stat.dev && cached.ino === stat.ino && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return cached.result;
    }
    const sameIdentity = cached && cached.dev === stat.dev && cached.ino === stat.ino;
    const sameFileAppend = sameIdentity && stat.size > cached.size && stat.mtimeMs >= cached.mtimeMs &&
      cached.fingerprint && rolloutFingerprint(file, cached) === cached.fingerprint;
    // Catch up across a burst using the bounded bootstrap budget. If even that
    // leaves a gap, discard cached live state: an unseen turn may have ended.
    const maxBytes = (bootstrap && !sameFileAppend) || (sameFileAppend && stat.size - cached.result.readOffset > MAX_ROLLOUT_TAIL_BYTES)
      ? MAX_ROLLOUT_BOOTSTRAP_BYTES : MAX_ROLLOUT_TAIL_BYTES;
    const previous = sameFileAppend && stat.size - cached.result.readOffset <= maxBytes
      ? cached.result : null;
    const result = readLegacyRollout(file, diagnostics, {
      stat, previous, modelProvider,
      maxBytes,
    });
    if (result) {
      const fingerprint = rolloutFingerprint(file, stat);
      if (fingerprint) this.rolloutCache.set(file, { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, fingerprint, result });
      else this.rolloutCache.delete(file);
    }
    return result;
  }

  read({ retentionHours = 24, includeAllKnown = false } = {}) {
    const now = nowValue(this.now);
    const normalizedRetentionHours = Number.isInteger(retentionHours) &&
      retentionHours >= MIN_RETENTION_HOURS && retentionHours <= MAX_RETENTION_HOURS
      ? retentionHours : 24;
    const recentWindowMs = normalizedRetentionHours * 60 * 60 * 1000;
    const cutoffMs = now - recentWindowMs;
    const diagnostics = {
      ok: true,
      readOnly: true,
      recentWindowMs,
      retentionHours: normalizedRetentionHours,
      activeStaleWindowMs: ACTIVE_STALE_WINDOW_MS,
      recentThreadLimit: includeAllKnown ? KNOWN_THREAD_LIMIT : RECENT_THREAD_LIMIT,
      taskScope: includeAllKnown ? "all-known" : "recent",
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
      executionHistoryPartialThreads: 0,
      executionHistoryTurnCap: MAX_TURN_HISTORY_PER_THREAD,
      truncated: false,
      returned: 0,
    };
    const providerConfig = readProviderConfig(this.codexHome, diagnostics);
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
    let historyTableCompatible = false;

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
        const queried = stateRowQuery(stateDb, stateColumns, cutoffMs, includeAllKnown);
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
          historyTableCompatible = true;
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
      let turnHistoryById = new Map();
      let partialHistoryThreads = new Set();
      if (historyDb && historyColumns.has("thread_id")) {
        const history = turnHistoryRows(historyDb, historyColumns, [
          ...threadsById.keys(),
        ]);
        turnHistoryById = history.rowsByThread;
        partialHistoryThreads = history.partialThreads;
        for (const [id, rows] of turnHistoryById.entries()) {
          const latest = rows.reduce(
            (current, row) => (isNewerTurnRow(row, current) ? row : current),
            null,
          );
          if (latest) latestTurns.set(id, latest);
        }
        // Active rows fetched for the complement are already useful if the
        // corresponding thread has no state row in the latest page.
        for (const row of activeTurnRows) {
          const id = safeText(row.thread_id);
          if (!id) continue;
          const current = latestTurns.get(id);
          if (isNewerTurnRow(row, current))
            latestTurns.set(id, row);
          if (!turnHistoryById.has(id)) turnHistoryById.set(id, [row]);
        }
      }

      const validRollouts = new Set([...threadsById.values()].map((row) => resolveRolloutPath(row.rollout_path, this.codexHome)));
      for (const file of this.rolloutCache.keys()) if (!validRollouts.has(file)) this.rolloutCache.delete(file);
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
        let creditUsage = null;
        let costEpoch = null;
        let costTokens = null;
        let sessionProviderMetadata = null;
        const threadModelProvider = providerId(row.model_provider);
        let tokens = rowTokens(row.tokens_used);
        let tokensKnown = finiteNumber(row.tokens_used) !== null && finiteNumber(row.tokens_used) >= 0;
        let updatedAt = rowTimestamp(row) ?? now;
        let activitySource = "thread_history";
        let eventCount = 0;
        let executionHistory = historyTableCompatible
          ? executionHistoryFromRows(
              turnHistoryById.get(id) || [],
              partialHistoryThreads.has(id),
            )
          : {
              intervals: [],
              coverage: "partial",
              source: "thread_history",
            };
        const historyMode = safeText(row.history_mode);
        const rolloutPath = resolveRolloutPath(
          row.rollout_path,
          this.codexHome,
        );
        const projectedActivity = classifyActivity(latestTurn, now);
        const lifecycleAt = latestTurn?.completedAt ?? latestTurn?.startedAt ?? 0;
        const projectionLags = updatedAt > lifecycleAt + PROJECTION_LAG_MS;
        const customProvider = threadModelProvider && threadModelProvider !== "openai";
        const needsRollout = customProvider || historyMode === "paginated" || !latestTurn || !tokensKnown ||
          projectedActivity.status === "unknown" || projectionLags || this.rolloutCache.has(rolloutPath);
        if (needsRollout && rolloutPath) {
          const recordedRollout = this.readRollout(rolloutPath, diagnostics, {
            modelProvider: threadModelProvider,
            bootstrap: projectedActivity.status === "idle" && updatedAt > lifecycleAt + 60_000,
          });
          if (recordedRollout) {
            const legacy = providerAdjustedRollout(recordedRollout, threadModelProvider);
            creditUsage = legacy.usageCredits;
            costEpoch = legacy.usageEpoch;
            costTokens = legacy.costTokens;
            sessionProviderMetadata = {
              first: legacy.firstSessionMetadata,
              latest: legacy.sessionMetadata,
            };
            const selectedTurn = newerLifecycle(latestTurn, legacy.latestTurn);
            if (selectedTurn !== latestTurn) {
              latestTurn = selectedTurn;
              activitySource = legacy.source;
            }
            eventCount = legacy.eventCount;
            if (!tokensKnown && legacy.tokens !== null) {
              tokens = rowTokens(legacy.tokens);
              tokensKnown = Number.isFinite(legacy.tokens) && legacy.tokens >= 0;
              if (legacy.tokenDelta !== null) tokenDelta = rowTokens(legacy.tokenDelta);
            }
            if (legacy.updatedAt !== null) updatedAt = Math.max(updatedAt, legacy.updatedAt);
            if (!turnHistoryById.has(id)) executionHistory = legacy.executionHistory;
            else executionHistory = mergeExecutionHistory(executionHistory, legacy.executionHistory);
            // Fresh token evidence cannot belong to a much older completed turn.
            // Without a newer start event, show unknown instead of reusing its timer.
            if (statusClass(latestTurn?.status) === "idle" &&
                legacy.tokenUpdatedAt > (latestTurn.completedAt ?? 0) + 60_000) {
              latestTurn = null;
              activitySource = legacy.source;
            }
          }
        } else if (!rolloutPath && historyMode === "legacy" && row.rollout_path) {
          diagnostics.warnings.push("legacy rollout path is outside CODEX_HOME and was skipped");
        }

        const activity = classifyActivity(latestTurn, now);
        const thread = {
          id,
          title: safeTitle(row.name, row.title),
          model: safeText(row.model),
          modelProvider: threadModelProvider,
          reasoningEffort: safeText(row.reasoning_effort),
          parentThreadId: sourceInfo.parentThreadId,
          createdAt: normalizeTimestamp(row.created_at_ms) ?? normalizeTimestamp(row.created_at),
          source: threadSource || sourceInfo.kind || null,
          status: activity.status,
          startedAt: latestTurn?.startedAt ?? null,
          completedAt: latestTurn?.completedAt ?? null,
          updatedAt,
          tokens,
          tokensKnown,
          usageCredits: creditUsage,
          costEpoch,
          costTokens,
          costRateVersion: creditUsage !== null ? COST_RATE_VERSION : null,
          activityEvidence: activityEvidence({
            source: activitySource,
            latestTurn,
            stale: activity.stale,
            eventCount,
          }),
          executionHistory,
          sessionProviderMetadata,
        };
        if (executionHistory.coverage === "partial") {
          diagnostics.executionHistoryPartialThreads += 1;
        }
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
      return { threads: output, providerConfig, diagnostics };
    } catch (error) {
      diagnostics.errors.push(
        `reader: ${String(error?.message || error)}`.slice(0, 500),
      );
      diagnostics.ok = false;
      return { threads: [], providerConfig, diagnostics };
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
  MAX_ROLLOUT_BOOTSTRAP_BYTES,
});
