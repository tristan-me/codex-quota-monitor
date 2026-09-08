import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const bundledReference = require("../assets/reset-radar-reference.json");

/**
 * Codex Reset is an independent public tracker. These URLs are deliberately
 * public JSON GET endpoints; no account credential or user data is involved.
 */
export const RESET_TIMELINE_URL = "https://codex-reset.com/api/timeline";
export const RESET_FORECAST_URL = "https://codex-reset.com/api/forecast";
export const RESET_SOURCE_URL = RESET_TIMELINE_URL;
export const RESET_METHODOLOGY_URL =
  "https://codex-reset.com/zh/forecast-method";
export const RESET_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
export const RESET_ENDPOINT_REQUEST_COUNT = 2;
export const RESET_REFERENCE = bundledReference;

const MAX_EVENTS = 50;
const MAX_EXCERPT_WORDS = 10;
const UTC_TIMEZONE_NAMES = new Set(["utc", "etc/utc", "gmt", "z"]);
const NOTES = [
  "Codex Reset 是独立的第三方公开追踪器，与 OpenAI 无关联。",
  "confirmed 只表示官方公开的全局重置公告；公告确认完成不等于逐账户遥测或已经到账。",
  "存储/银行重置、积分发放、个人窗口和操作员观察不会计入 confirmed。",
  "预测概率来自第三方实验性模型；不是官方时刻表，也不会因过去预告兑现而推断下一次。",
  "公开接口看不到你的 OpenAI 账户或真实用量；个人状态请以 Codex /status 或官方界面为准。",
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finite(value) {
  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    (typeof value === "string" && value.trim() === "")
  )
    return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function iso(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (
    typeof value === "number" ||
    (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()))
  ) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return null;
    const milliseconds = number < 100_000_000_000 ? number * 1000 : number;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function dateOnly(value) {
  const valueText = text(value);
  return valueText && /^\d{4}-\d{2}-\d{2}$/.test(valueText)
    ? `${valueText}T00:00:00.000Z`
    : null;
}

function safeUrl(value, fallback = null) {
  const candidate = text(value);
  if (!candidate) return fallback;
  try {
    const url = new URL(candidate, RESET_TIMELINE_URL);
    return /^https?:$/.test(url.protocol) ? url.href : fallback;
  } catch {
    return fallback;
  }
}

function lower(value) {
  return (text(value) || "").toLowerCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return [
    ...new Set(
      asArray(values)
        .map((value) => text(value))
        .filter(Boolean),
    ),
  ];
}

function normalizeProbability(value) {
  const number = finite(value);
  if (number === null || number < 0) return null;
  if (number <= 1) return number;
  if (number <= 100) return number / 100;
  return null;
}

function probabilityFrom(source, keys) {
  for (const key of keys) {
    const value = normalizeProbability(source?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function hasLyricText(value) {
  const source = lower(value);
  return [
    "never gonna give you up",
    "never gonna let you down",
    "never gonna run around",
    "never gonna make you cry",
    "never gonna say goodbye",
    "never gonna tell a lie",
    "desert you",
  ].some((pattern) => source.includes(pattern));
}

function summaryLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*L\d+\s*:\s*/, "").trim())
    .map((line) => line.replace(/https?:\/\/\S+/gi, "").trim())
    .filter(Boolean);
}

function excerptFor(summary) {
  const lines = summaryLines(summary);
  const nonLyrics = lines.filter((line) => !hasLyricText(line));
  const relevant = nonLyrics.find((line) =>
    /\b(reset|usage|limit|quota|codex|chatgpt|astra|paid|subscription)\b/i.test(
      line,
    ),
  );
  const candidate = relevant || nonLyrics[0];
  if (!candidate || hasLyricText(candidate)) return "官方重置动态";
  const words = candidate.split(/\s+/).filter(Boolean);
  return words.slice(0, MAX_EXCERPT_WORDS).join(" ") || "官方重置动态";
}

function reasonFor(event) {
  const tags = uniqueStrings(event.reason_tags || event.reasonTags).map(lower);
  const source = lower(event.summary);
  if (tags.includes("milestone") || /\b\d+\s*m\b/i.test(source))
    return "里程碑庆祝的全局重置公告";
  if (tags.includes("incident")) return "服务事件后的全局重置公告";
  if (/astra/i.test(source)) return "Astra 发布周期的全局重置公告";
  if (lower(event.reset_kind) === "hard") return "完整额度重置公告";
  return "官方全局额度重置公告";
}

function titleFor(event) {
  const explicit = text(event.title);
  if (explicit && !hasLyricText(explicit)) return explicit.slice(0, 120);
  const source = lower(event.summary);
  if (/\b25m\b/.test(source)) return "25M 活跃用户里程碑重置";
  if (/astra/.test(source)) return "Astra 周期全体重置";
  return "全体额度重置公告";
}

function isBankedEvent(event) {
  const type = lower(event.type || event.group || event.kind);
  const resetKind = lower(event.reset_kind || event.resetKind);
  const tags = uniqueStrings(event.reason_tags || event.reasonTags).map(lower);
  return (
    type === "credits" ||
    type.includes("credit") ||
    resetKind === "banked" ||
    tags.includes("banked")
  );
}

function isOfficialSource(event) {
  const source = lower(event.source || event.source_type || event.origin);
  if (!source) return false;
  if (/(operator|observed|community|user|third[- ]party)/.test(source))
    return false;
  return /(?:^|[-_ ])(?:archive|official|live)(?:$|[-_ ])/.test(` ${source} `);
}

function isResetAnnouncement(event) {
  const type = lower(event.type || event.group || event.kind);
  const announcementState = lower(
    event.announcement_state || event.announcementState,
  );
  const scope = lower(event.scope);
  if (!type.includes("reset") || isBankedEvent(event)) return false;
  if (event.is_reply === true || event.isReply === true) return false;
  if (!isOfficialSource(event)) return false;
  if (scope && scope !== "global") return false;
  if (announcementState === "none" && lower(event.source) !== "archive")
    return false;
  const summary = text(event.summary || event.text) || "";
  if (
    lower(event.source) !== "archive" &&
    /\b(will|tomorrow|planning|going to|later today)\b/i.test(summary) &&
    !/\b(all reset|have reset|has been reset|are reset|usage reset for)\b/i.test(
      summary,
    )
  )
    return false;
  return true;
}

function officialWindowOf(value) {
  if (!isRecord(value)) return null;
  const startAt = iso(value.start_at || value.startAt);
  const endAt = iso(value.end_at || value.endAt);
  const targetAt = iso(value.target_at || value.targetAt);
  const label = text(value.label);
  if (!startAt && !endAt && !targetAt && !label) return null;
  return {
    label,
    startAt,
    endAt,
    targetAt,
    timeZone: text(value.time_zone || value.timeZone) || null,
    targetKind: text(value.target_kind || value.targetKind) || null,
  };
}

function normalizeEvent(event) {
  const announcedAt = iso(
    event.announced_at ||
      event.announcedAt ||
      event.published_at ||
      event.publishedAt,
  );
  const dateFallback = announcedAt ? null : dateOnly(event.date);
  const announcementAt = announcedAt || dateFallback;
  if (!announcementAt) return null;
  const effectiveAt = iso(event.effective_at || event.effectiveAt);
  const observedAt = iso(event.observed_at || event.observedAt);
  const eventAt = effectiveAt || observedAt || null;
  const source = text(event.source || event.source_type || event.origin);
  const sourceLower = lower(source);
  const verificationStatus =
    text(event.reset_verification_status || event.resetVerificationStatus) ||
    (sourceLower === "archive" && lower(event.confidence) === "high"
      ? "archive-confirmed"
      : "pending");
  const observation =
    text(event.observation_result || event.observationResult) || "unknown";
  const audience = uniqueStrings(event.audience);
  const rawSummary = text(event.summary) || "";
  const excerpt = excerptFor(rawSummary);
  const url = safeUrl(event.url || event.href);
  const author =
    text(event.author || event.author_handle || event.authorHandle) ||
    "@thsottiaux";
  const confirmationType = eventAt
    ? "effective-event"
    : sourceLower === "archive"
      ? "verified-archive-announcement"
      : "official-completion-statement";
  return {
    id: text(event.id) || `reset-${announcementAt}`,
    announcementAt,
    eventAt,
    timePrecision: effectiveAt
      ? "effective"
      : eventAt
        ? "observed"
        : dateFallback
          ? "date-only"
          : "announcement-only",
    title: titleFor(event),
    reason: reasonFor(event),
    confirmationType,
    scope: text(event.scope) || "global",
    audience,
    confidence: text(event.confidence) || null,
    source,
    sourceLabel: text(event.source_label || event.sourceLabel) || null,
    verification: {
      announcementState:
        text(event.announcement_state || event.announcementState) || null,
      observationResult: observation,
      status: verificationStatus,
      isVerified:
        verificationStatus === "archive-confirmed" ||
        ["verified", "confirmed", "complete"].includes(
          lower(verificationStatus),
        ),
    },
    officialWindow: officialWindowOf(
      event.official_window || event.officialWindow,
    ),
    evidence: [
      {
        url,
        author,
        publishedAt: announcementAt,
        excerpt,
        summary:
          sourceLower === "archive"
            ? "官方档案记录的全局重置公告；公告时间不等于逐账户遥测。"
            : "官方公开动态宣布全局重置；公开时间线尚未确认逐账户到账。",
      },
    ],
  };
}

function sortNewest(left, right) {
  return (
    (Date.parse(right.announcementAt) || 0) -
    (Date.parse(left.announcementAt) || 0)
  );
}

function forecastEvidence(value) {
  return asArray(value)
    .filter(isRecord)
    .slice(0, 12)
    .map((item) => ({
      code: text(item.code),
      label: text(item.label),
      detail: text(item.detail),
      url: safeUrl(item.href || item.url, RESET_TIMELINE_URL),
    }));
}

function normalizeTimeWindow(source) {
  if (!isRecord(source)) return null;
  const startHour = finite(source.start_hour ?? source.startHour);
  const endHour = finite(source.end_hour ?? source.endHour);
  if (
    startHour === null ||
    endHour === null ||
    !Number.isInteger(startHour) ||
    !Number.isInteger(endHour) ||
    startHour < 0 ||
    startHour > 23 ||
    endHour < 0 ||
    endHour > 23
  )
    return null;
  return {
    startHour,
    endHour,
    label: text(source.label) || `${startHour}:00 - ${endHour}:00`,
    timezone: text(source.timezone || source.timeZone) || "UTC",
  };
}

function normalizeForecast(rawForecast, { forecastUrl, timelineUrl } = {}) {
  const source = isRecord(rawForecast) ? rawForecast : {};
  const probabilities = isRecord(source.probabilities)
    ? source.probabilities
    : source;
  const probability24h = probabilityFrom(probabilities, [
    "raw_24h",
    "probability24h",
    "probability_24h",
    "p24",
    "rounded_24h",
    "rounded24",
  ]);
  const probability48h = probabilityFrom(probabilities, [
    "raw_48h",
    "probability48h",
    "probability_48h",
    "p48",
    "rounded_48h",
    "rounded48",
  ]);
  const updatedAt = iso(source.updated_at || source.updatedAt);
  const timeWindow = normalizeTimeWindow(
    source.time_window || source.timeWindow,
  );
  const mode = text(source.mode);
  const confidence = text(source.confidence) || "unknown";
  const confidenceNote =
    text(source.confidence_note || source.confidenceNote) ||
    "第三方实验性模型；请勿视为官方时间表。";
  const officialWindow = officialWindowOf(
    source.teased_window || source.teasedWindow || source.official_window,
  );
  return {
    state: mode === "model" ? "experimental" : "no-official-window",
    mode: mode || null,
    probability24h,
    probability48h,
    probability24hPercent:
      (probabilityFrom(probabilities, ["rounded_24h", "rounded24"]) ??
        probability24h) === null
        ? null
        : Math.round(
            (probabilityFrom(probabilities, ["rounded_24h", "rounded24"]) ??
              probability24h) * 100,
          ),
    probability48hPercent:
      (probabilityFrom(probabilities, ["rounded_48h", "rounded48"]) ??
        probability48h) === null
        ? null
        : Math.round(
            (probabilityFrom(probabilities, ["rounded_48h", "rounded48"]) ??
              probability48h) * 100,
          ),
    confidence,
    confidenceNote,
    reason:
      "第三方实验性 rate-v3 只使用公开历史节奏与当前接口；过去预告是否兑现不用于推断下一次。",
    updatedAt,
    lastResetAt: iso(source.last_reset_at || source.lastResetAt),
    officialSignal: source.official_signal ?? source.officialSignal ?? null,
    officialWindow,
    timeWindow,
    cadence: isRecord(source.cadence)
      ? {
          recentMedianDays: finite(
            source.cadence.recent_median_days ??
              source.cadence.recentMedianDays,
          ),
          recentSample: finite(
            source.cadence.recent_sample ?? source.cadence.recentSample,
          ),
          weightedMeanDays: finite(
            source.cadence.weighted_mean_days ??
              source.cadence.weightedMeanDays,
          ),
          accelerating: source.cadence.accelerating === true,
        }
      : null,
    evidence: forecastEvidence(source.evidence),
    model: isRecord(source.model)
      ? {
          version: text(source.model.version),
          windowIntervals: finite(
            source.model.window_intervals ?? source.model.windowIntervals,
          ),
          halfLifeDays: finite(
            source.model.half_life_days ?? source.model.halfLifeDays,
          ),
          effectiveSampleSize: finite(
            source.model.effective_sample_size ??
              source.model.effectiveSampleSize,
          ),
        }
      : null,
    backtest: isRecord(source.backtest)
      ? {
          sampleSize: finite(
            source.backtest.sample_size ?? source.backtest.sampleSize,
          ),
          brier: finite(source.backtest.brier),
          baselineBrier: finite(
            source.backtest.baseline_brier ?? source.backtest.baselineBrier,
          ),
          rateV2Brier: finite(
            source.backtest.rate_v2_brier ?? source.backtest.rateV2Brier,
          ),
          betterThanNaive: source.backtest.better_than_naive === true,
          betterThanRateV2: source.backtest.better_than_rate_v2 === true,
          status: text(source.backtest.status) || "experimental",
        }
      : null,
    sourceUrl: safeUrl(forecastUrl, RESET_FORECAST_URL),
    timelineUrl: safeUrl(timelineUrl, RESET_TIMELINE_URL),
  };
}

function timelineFrom(input) {
  if (!isRecord(input)) return {};
  if (isRecord(input.timeline)) return input.timeline;
  if (isRecord(input.timelineData)) return input.timelineData;
  return input;
}

function forecastFrom(input) {
  if (!isRecord(input)) return {};
  if (isRecord(input.forecast)) return input.forecast;
  if (isRecord(input.forecastData)) return input.forecastData;
  return {};
}

function updatedAtOf(timeline, forecast) {
  const dates = [
    iso(timeline.updated_at || timeline.updatedAt),
    iso(forecast.updated_at || forecast.updatedAt),
  ].filter(Boolean);
  return dates.sort().at(-1) || null;
}

function cloneEvent(event) {
  return {
    ...event,
    audience: [...(event.audience || [])],
    evidence: (event.evidence || []).map((item) => ({ ...item })),
    verification: event.verification ? { ...event.verification } : null,
    officialWindow: event.officialWindow ? { ...event.officialWindow } : null,
  };
}

function isNormalizedReference(value) {
  return (
    isRecord(value) &&
    Array.isArray(value.confirmed) &&
    isRecord(value.forecast) &&
    typeof value.schema === "number"
  );
}

function normalizedReferenceCopy(value, now) {
  const fetchedAt = iso(value.fetchedAt) || iso(value.updatedAt) || now;
  const confirmed = value.confirmed.map(cloneEvent).slice(0, 2);
  const events = (Array.isArray(value.events) ? value.events : confirmed)
    .map(cloneEvent)
    .slice(0, MAX_EVENTS);
  return {
    schema: 2,
    sourceUrl: safeUrl(value.sourceUrl, RESET_TIMELINE_URL),
    forecastUrl: safeUrl(value.forecastUrl, RESET_FORECAST_URL),
    methodologyUrl: safeUrl(value.methodologyUrl, RESET_METHODOLOGY_URL),
    updatedAt: iso(value.updatedAt) || fetchedAt,
    timelineUpdatedAt: iso(value.timelineUpdatedAt),
    forecastUpdatedAt: iso(value.forecastUpdatedAt),
    fetchedAt,
    requestCount: Number.isInteger(value.requestCount)
      ? value.requestCount
      : RESET_ENDPOINT_REQUEST_COUNT,
    confirmed,
    last2: confirmed.map(cloneEvent),
    events,
    forecast: { ...value.forecast },
    notes: [...NOTES],
  };
}

/**
 * Convert the two public endpoint responses into a small, safe reference
 * object. This function performs no network I/O and never uses account data.
 */
export function normalizeReference(
  input,
  {
    now = Date.now(),
    timelineUrl = RESET_TIMELINE_URL,
    forecastUrl = RESET_FORECAST_URL,
    methodologyUrl = RESET_METHODOLOGY_URL,
  } = {},
) {
  const nowIso = iso(now) || new Date().toISOString();
  if (isNormalizedReference(input))
    return normalizedReferenceCopy(input, nowIso);

  const timeline = timelineFrom(input);
  const forecastRaw = forecastFrom(input);
  const events = asArray(timeline.events)
    .filter((event) => isRecord(event) && isResetAnnouncement(event))
    .map(normalizeEvent)
    .filter(Boolean)
    .sort(sortNewest)
    .slice(0, MAX_EVENTS);
  const confirmed = events.slice(0, 2).map(cloneEvent);
  const forecast = normalizeForecast(forecastRaw, {
    timelineUrl,
    forecastUrl,
  });
  return {
    schema: 2,
    sourceUrl: safeUrl(timelineUrl, RESET_TIMELINE_URL),
    forecastUrl: safeUrl(forecastUrl, RESET_FORECAST_URL),
    methodologyUrl: safeUrl(methodologyUrl, RESET_METHODOLOGY_URL),
    updatedAt: updatedAtOf(timeline, forecastRaw) || nowIso,
    timelineUpdatedAt: iso(timeline.updated_at || timeline.updatedAt),
    forecastUpdatedAt: iso(forecastRaw.updated_at || forecastRaw.updatedAt),
    fetchedAt: nowIso,
    requestCount: RESET_ENDPOINT_REQUEST_COUNT,
    confirmed,
    last2: confirmed.map(cloneEvent),
    events: events.map(cloneEvent),
    forecast,
    notes: [...NOTES],
  };
}

async function getJson(fetchImpl, url, signal) {
  const options = {
    method: "GET",
    headers: {
      accept: "application/json",
      "cache-control": "no-cache",
    },
  };
  if (signal) options.signal = signal;
  const response = await fetchImpl(url, options);
  if (!response || response.ok !== true) {
    const status = response?.status ? ` (${response.status})` : "";
    throw new Error(`Codex Reset public endpoint failed${status}: ${url}`);
  }
  const body = await response.json();
  if (!isRecord(body))
    throw new Error(
      `Codex Reset public endpoint returned invalid JSON: ${url}`,
    );
  return body;
}

/**
 * Fetch the public timeline and forecast once. The caller owns scheduling and
 * should call this at most once per its chosen refresh interval (15 minutes in
 * the monitor). Both requests are GET-only and can be injected in tests.
 */
export async function fetchResetReference({
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  signal,
  timelineUrl = RESET_TIMELINE_URL,
  forecastUrl = RESET_FORECAST_URL,
  methodologyUrl = RESET_METHODOLOGY_URL,
} = {}) {
  if (typeof fetchImpl !== "function")
    throw new TypeError("A fetch implementation is required");
  const [timeline, forecast] = await Promise.all([
    getJson(fetchImpl, timelineUrl, signal),
    getJson(fetchImpl, forecastUrl, signal),
  ]);
  return normalizeReference(
    { timeline, forecast },
    { now, timelineUrl, forecastUrl, methodologyUrl },
  );
}

function nextUtcWindow(timeWindow, now) {
  if (!timeWindow || !UTC_TIMEZONE_NAMES.has(lower(timeWindow.timezone)))
    return { start: null, end: null };
  const startHour = timeWindow.startHour;
  const endHour = timeWindow.endHour;
  const current = new Date(now);
  if (Number.isNaN(current.getTime())) return { start: null, end: null };
  let start = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate(),
    startHour,
  );
  let end = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate(),
    endHour,
  );
  if (end <= start) end += 24 * 60 * 60 * 1000;
  // For a window that crosses midnight (for example 23:00–02:00), a time
  // shortly after midnight belongs to the interval that began yesterday.
  const previousStart = start - 24 * 60 * 60 * 1000;
  const previousEnd = end - 24 * 60 * 60 * 1000;
  if (
    current.getTime() < start &&
    current.getTime() >= previousStart &&
    current.getTime() < previousEnd
  ) {
    start -= 24 * 60 * 60 * 1000;
    end -= 24 * 60 * 60 * 1000;
  }
  if (current.getTime() >= end) {
    start += 24 * 60 * 60 * 1000;
    end += 24 * 60 * 60 * 1000;
  }
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  };
}

function usableOfficialWindow(window, lastResetAt, now) {
  if (!isRecord(window)) return null;
  const start = Date.parse(window.startAt || window.targetAt || "");
  const end = Date.parse(window.endAt || window.targetAt || "");
  if (!Number.isFinite(start) && !Number.isFinite(end)) return null;
  // A target-only window is still usable until its target. An interval with
  // an explicit end is usable while it is future or currently in progress.
  const boundary = Number.isFinite(end) ? end : start;
  if (now >= boundary) return null;
  const reset = Date.parse(lastResetAt || "");
  if (Number.isFinite(reset) && reset >= start && reset <= now) return null;
  return window;
}

function buildForecast(forecast, reference, now) {
  const officialWindow = usableOfficialWindow(
    forecast.officialWindow,
    forecast.lastResetAt,
    now,
  );
  const nextWindow = officialWindow
    ? {
        start: officialWindow.startAt || officialWindow.targetAt || null,
        end: officialWindow.endAt || officialWindow.targetAt || null,
      }
    : nextUtcWindow(forecast.timeWindow, now);
  const fetchedAt = Date.parse(reference.fetchedAt || "") || 0;
  const expiresAt = new Date(
    (fetchedAt || now) + RESET_REFRESH_INTERVAL_MS,
  ).toISOString();
  const updatedAt = iso(forecast.updatedAt) || reference.updatedAt;
  const sourceUpdatedAt = Date.parse(updatedAt || "") || 0;
  const ageSeconds = sourceUpdatedAt
    ? Math.max(0, Math.floor((now - sourceUpdatedAt) / 1000))
    : null;
  return {
    ...forecast,
    state: officialWindow ? "official-window" : forecast.state,
    officialWindow,
    windowStart: nextWindow.start,
    windowEnd: nextWindow.end,
    timeBasis: officialWindow
      ? `官方预告/站点收录窗口${officialWindow.label ? `（${officialWindow.label}）` : ""}；优先于历史观察窗。这一窗口与24/48小时概率分开。`
      : forecast.timeWindow
        ? `每日 UTC ${String(forecast.timeWindow.startHour).padStart(2, "0")}:00–${String(forecast.timeWindow.endHour).padStart(2, "0")}:00；按北京时间（UTC+8）为次日 07:00–10:00，取下一次尚未结束窗口。这是3小时参考观察窗，不对应24/48小时概率。`
        : "没有公开的官方未来时间窗口，也没有可用的历史观察窗。",
    calculation: officialWindow
      ? "第三方实验性 rate-v3 的公开 API 输出；站点收录的官方预告窗口只表示公开声明，不等于账户到账，也不等于24/48小时概率；历史公告兑现情况不作为下一次预测信号。"
      : "第三方实验性 rate-v3 的公开 API 输出；3小时历史观察窗只描述时段聚集，不是官方窗口，也不等于24/48小时概率；历史公告兑现情况不作为下一次预测信号。",
    expiresAt,
    stale: now >= Date.parse(expiresAt),
    ageSeconds,
    sourceUpdatedAt: updatedAt,
  };
}

/**
 * Build the UI-facing reset radar from a normalized reference. `now` is
 * injectable so the recurring-window calculation and freshness state remain
 * deterministic in tests.
 */
export function buildResetRadar({
  now = Date.now(),
  reference = RESET_REFERENCE,
} = {}) {
  const normalized = isNormalizedReference(reference)
    ? normalizedReferenceCopy(reference, iso(now) || new Date().toISOString())
    : normalizeReference(reference, { now });
  const current = new Date(now).getTime();
  const safeNow = Number.isFinite(current) ? current : Date.now();
  const confirmed = normalized.confirmed.map(cloneEvent).slice(0, 2);
  const forecast = buildForecast(normalized.forecast, normalized, safeNow);
  forecast.evidence = (forecast.evidence || []).map((item) => {
    const match = confirmed
      .flatMap((event) => event.evidence || [])
      .find((e) => e.url === item.url);
    if (match)
      return {
        ...item,
        ...match,
        summary: "已完成重置的历史依据，不是下一次重置预告。",
      };
    const labels = {
      recent_cadence: "近期重置节奏",
      last_reset: "上次已完成重置",
      common_window: "历史常见公告时段",
    };
    return { ...item, label: labels[item.code] || item.label };
  });
  return {
    schema: 2,
    sourceUrl: normalized.sourceUrl,
    forecastUrl: normalized.forecastUrl,
    methodologyUrl: normalized.methodologyUrl,
    updatedAt: normalized.updatedAt,
    fetchedAt: normalized.fetchedAt,
    requestCount: normalized.requestCount,
    confirmed,
    last2: confirmed.map(cloneEvent),
    forecast,
    notes: [...NOTES],
  };
}
