import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const radarReference = require("../assets/model-radar-reference.json");

export const RADAR_SOURCE_URL = radarReference.sourceUrl;
export const RADAR_PAGE_URL = radarReference.pageUrl;

const EFFORT_ORDER = ["ultra", "max", "xhigh", "high", "medium", "low", "off"];
const EFFORT_INDEX = new Map(
  EFFORT_ORDER.map((effort, index) => [effort, index]),
);
const MODEL_ORDER = [
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
];
const MODEL_INDEX = new Map(MODEL_ORDER.map((model, index) => [model, index]));
const LOCAL_RATE_FIELDS = [
  "secondsPerPercent",
  "averageSecondsPerPercent",
  "ownSecondsPerPercent",
  "ownAverageSecondsPerPercent",
];

function finite(value) {
  const number =
    typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function effortOf(value) {
  const effort = text(value);
  return effort ? effort.toLowerCase() : null;
}

function baseModel(value) {
  const model = text(value);
  if (!model) return null;
  const suffix = EFFORT_ORDER.find((effort) =>
    model.toLowerCase().endsWith(`-${effort}`),
  );
  return suffix ? model.slice(0, -(suffix.length + 1)) : model;
}

function keyFor(model, effort) {
  const base = baseModel(model);
  return base ? `${base.toLowerCase()}|${effortOf(effort) || ""}` : null;
}

function referenceCostPerHour(point) {
  const price = finite(point?.averagePriceUsd);
  const minutes = finite(point?.averageMinutes);
  if (price === null || minutes === null || price < 0 || minutes <= 0)
    return null;
  return (price * 60) / minutes;
}

function normalizeRadarPoints() {
  const result = new Map();
  for (const point of Array.isArray(radarReference.points)
    ? radarReference.points
    : []) {
    const model = baseModel(point?.model);
    const effort = effortOf(point?.effort);
    if (!model || !effort || referenceCostPerHour(point) === null) continue;
    const key = keyFor(model, effort);
    const previous = result.get(key);
    const previousAt = Date.parse(previous?.sourceUpdatedAt || "") || 0;
    const currentAt =
      Date.parse(
        point.sourceUpdatedAt || radarReference.sourceUpdatedAt || "",
      ) || 0;
    if (!previous || currentAt >= previousAt)
      result.set(key, { ...point, model, effort });
  }
  return result;
}

function modelEfforts(model) {
  const advertised = Array.isArray(model?.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
        .map((item) =>
          typeof item === "string" ? item : item?.reasoningEffort,
        )
        .map(effortOf)
        .filter(Boolean)
    : [];
  const fallback = effortOf(model?.defaultReasoningEffort);
  return [
    ...new Set(advertised.length ? advertised : fallback ? [fallback] : []),
  ];
}

const EXECUTION_MODEL_FIELDS = [
  "executionModel",
  "effectiveModel",
  "latestTurnModel",
  "ownLatestTurnModel",
  "turnModel",
];
const EXECUTION_EFFORT_FIELDS = [
  "executionReasoningEffort",
  "effectiveReasoningEffort",
  "latestTurnReasoningEffort",
  "ownLatestTurnReasoningEffort",
  "turnReasoningEffort",
];
const MODEL_HISTORY_FIELDS = [
  "executionModels",
  "historicalModels",
  "modelHistory",
];
const EFFORT_HISTORY_FIELDS = [
  "executionReasoningEfforts",
  "historicalReasoningEfforts",
  "reasoningEffortHistory",
  "effortHistory",
];

function modelValue(value) {
  return text(typeof value === "string" ? value : value?.model);
}

function effortValue(value) {
  return effortOf(
    typeof value === "string" ? value : value?.reasoningEffort ?? value?.effort,
  );
}

function valuesForFields(entry, fields, normalize) {
  const values = [];
  for (const field of fields) {
    const value = entry?.[field];
    if (Array.isArray(value)) {
      for (const item of value) {
        const normalized = normalize(item);
        if (normalized) values.push(normalized);
      }
      continue;
    }
    const normalized = normalize(value);
    if (normalized) values.push(normalized);
  }
  return [...new Set(values)];
}

function firstPresentField(entry, fields, normalize) {
  for (const field of fields) {
    if (Object.hasOwn(entry || {}, field)) {
      return { present: true, value: normalize(entry[field]) };
    }
  }
  return { present: false, value: null };
}

function executionIdentity(entry, hasTurnScope) {
  const latestModel = firstPresentField(
    entry,
    hasTurnScope ? ["latestTurnModel", "ownLatestTurnModel"] : [],
    modelValue,
  );
  const latestEffort = firstPresentField(
    entry,
    hasTurnScope
      ? ["latestTurnReasoningEffort", "ownLatestTurnReasoningEffort"]
      : [],
    effortValue,
  );
  const genericModel = firstPresentField(
    entry,
    EXECUTION_MODEL_FIELDS.filter(
      (field) => !["latestTurnModel", "ownLatestTurnModel"].includes(field),
    ),
    modelValue,
  );
  const genericEffort = firstPresentField(
    entry,
    EXECUTION_EFFORT_FIELDS.filter(
      (field) =>
        ![
          "latestTurnReasoningEffort",
          "ownLatestTurnReasoningEffort",
        ].includes(field),
    ),
    effortValue,
  );
  const explicitModel = latestModel.present
    ? latestModel.value
    : genericModel.present
      ? genericModel.value
      : null;
  const explicitEffort = latestEffort.present
    ? latestEffort.value
    : genericEffort.present
      ? genericEffort.value
      : null;
  const explicitModelPresent = latestModel.present || genericModel.present;
  const explicitEffortPresent = latestEffort.present || genericEffort.present;
  const modelHistory = valuesForFields(entry, MODEL_HISTORY_FIELDS, modelValue);
  const effortHistory = valuesForFields(entry, EFFORT_HISTORY_FIELDS, effortValue);
  const hasEffortHistoryField = EFFORT_HISTORY_FIELDS.some((field) =>
    Object.hasOwn(entry || {}, field),
  );
  const model = explicitModelPresent
    ? explicitModel
    : modelHistory.length === 1
      ? modelHistory[0]
      : modelHistory.length
        ? null
        : text(entry?.model);
  const effort = explicitEffortPresent
    ? explicitEffort
    : effortHistory.length === 1
      ? effortHistory[0]
      : effortHistory.length
        ? null
        : effortOf(entry?.reasoningEffort ?? entry?.effort);
  return {
    model,
    effort,
    // A task lifetime rate cannot be assigned to the latest model/effort tag
    // when its retained execution history contains multiple identities. An
    // explicit execution identity is the only safe override for that case.
    ambiguousModel: explicitModelPresent
      ? !explicitModel
      : modelHistory.length > 1,
    ambiguousEffort: explicitEffortPresent
      ? !explicitEffort
      : effortHistory.length > 1 ||
        (modelHistory.length > 0 && !hasEffortHistoryField),
  };
}

function ownSessionView(session) {
  const hasOwnFields = [
    "ownEstimatedPercent",
    "ownSecondsPerPercent",
    "ownAverageSecondsPerPercent",
    "ownObservationSeconds",
    "ownLatestTurnModel",
  "ownLatestTurnReasoningEffort",
  "ownExecutionModel",
  "ownExecutionReasoningEffort",
  "ownHistoricalModels",
  "ownHistoricalReasoningEfforts",
  "ownExecutionModels",
  "ownExecutionReasoningEfforts",
  ].some((field) => Object.hasOwn(session, field));
  if (!hasOwnFields) return session;
  return {
    ...session,
    status: session.ownStatus ?? session.status,
    estimatedPercent: session.ownEstimatedPercent,
    secondsPerPercent: session.ownSecondsPerPercent,
    averageSecondsPerPercent: session.ownAverageSecondsPerPercent,
    observationSeconds: session.ownObservationSeconds,
    ...(Object.hasOwn(session, "ownLatestTurnElapsedSeconds") ? {
      latestTurnElapsedSeconds: session.ownLatestTurnElapsedSeconds,
      latestTurnEstimatedPercent: session.ownLatestTurnEstimatedPercent,
      latestTurnRateSource: session.ownLatestTurnRateSource,
    } : {}),
    ...(Object.hasOwn(session, "ownLatestTurnModel") ? {
      latestTurnModel: session.ownLatestTurnModel,
    } : {}),
    ...(Object.hasOwn(session, "ownLatestTurnReasoningEffort") ? {
      latestTurnReasoningEffort: session.ownLatestTurnReasoningEffort,
    } : {}),
    ...(Object.hasOwn(session, "ownExecutionModel") ? {
      executionModel: session.ownExecutionModel,
    } : {}),
    ...(Object.hasOwn(session, "ownExecutionReasoningEffort") ? {
      executionReasoningEffort: session.ownExecutionReasoningEffort,
    } : {}),
    ...(Object.hasOwn(session, "ownHistoricalModels") ? {
      historicalModels: session.ownHistoricalModels,
    } : {}),
    ...(Object.hasOwn(session, "ownHistoricalReasoningEfforts") ? {
      historicalReasoningEfforts: session.ownHistoricalReasoningEfforts,
    } : {}),
    ...(Object.hasOwn(session, "ownExecutionModels") ? {
      executionModels: session.ownExecutionModels,
    } : {}),
    ...(Object.hasOwn(session, "ownExecutionReasoningEfforts") ? {
      executionReasoningEfforts: session.ownExecutionReasoningEfforts,
    } : {}),
  };
}

function localEntries(sessions) {
  const entries = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session || typeof session !== "object") continue;
    const children = Array.isArray(session.children) ? session.children : [];
    if (children.length) {
      const root = ownSessionView(session);
      const hasRootRate = LOCAL_RATE_FIELDS.some(
        (field) => finite(root[field]) !== null,
      );
      if (hasRootRate || (finite(root.latestTurnElapsedSeconds) > 0 && finite(root.latestTurnEstimatedPercent) > 0)) entries.push(root);
      for (const child of children) {
        if (child && typeof child === "object") entries.push(ownSessionView(child));
      }
    } else {
      entries.push(ownSessionView(session));
    }
  }
  return entries;
}

function aggregateLocalRates(sessions) {
  const byKey = new Map();
  for (const entry of localEntries(sessions)) {
    const hasTurnScope = Object.hasOwn(entry, "latestTurnElapsedSeconds");
    const turnSeconds = finite(entry.latestTurnElapsedSeconds);
    const turnPercent = finite(entry.latestTurnEstimatedPercent);
    const turnAverage = turnSeconds > 0 && turnPercent > 0 ? turnSeconds / turnPercent : null;
    // Model comparisons use one matched execution scope, not a task lifetime
    // average labeled with its latest model setting. Prefer the stable turn
    // mean; a recent rate is only a fallback when that mean is unavailable.
    const current = hasTurnScope
      ? turnAverage === null && ["recent-token-calibrated", "recent-model-cost-calibrated"].includes(entry.latestTurnRateSource)
        ? finite(entry.secondsPerPercent) : null
      : finite(entry.secondsPerPercent);
    const average = hasTurnScope ? turnAverage : finite(entry.averageSecondsPerPercent);
    const identity = executionIdentity(entry, hasTurnScope);
    if (!identity.model || !identity.effort) continue;
    if (identity.ambiguousModel || identity.ambiguousEffort) continue;
    const key = keyFor(identity.model, identity.effort);
    if (!key) continue;
    const seconds =
      current !== null && current > 0
        ? current
        : average !== null && average > 0
          ? average
          : null;
    if (seconds === null) continue;
    const kind = current !== null && current > 0 ? "current" : "average";
    const observation = hasTurnScope
      ? kind === "average"
        ? turnSeconds
        : finite(entry.rateObservationSeconds) ??
          finite(entry.latestTurnObservationSeconds) ??
          turnSeconds
      : finite(entry.observationSeconds);
    const weight = observation !== null && observation > 0 ? observation : 1;
    const item = byKey.get(key) || {
      model: baseModel(identity.model),
      effort: effortOf(identity.effort),
      observedSeconds: 0,
      observedQuotaRate: 0,
      observationSeconds: 0,
      sampleCount: 0,
      currentSamples: 0,
    };
    const priority = hasTurnScope && kind === "average" ? 3 : kind === "current" ? 2 : 1;
    if (item.priority > priority) continue;
    if (priority > (item.priority || 0) && item.sampleCount > 0) {
      item.observedSeconds = 0;
      item.observedQuotaRate = 0;
      item.observationSeconds = 0;
      item.sampleCount = 0;
      item.currentSamples = 0;
    }
    item.priority = priority;
    // seconds/percent is a reciprocal rate. Arithmetic averaging would be
    // wrong when samples cover different durations: 100s at 1%/100s and
    // 200s at 1%/300s combine to 400s/(1+1.5)=160s/percent.
    item.observedSeconds += weight;
    item.observedQuotaRate += weight / seconds;
    item.observationSeconds +=
      observation !== null && observation > 0 ? observation : 0;
    item.sampleCount += 1;
    if (kind === "current") item.currentSamples += 1;
    byKey.set(key, item);
  }
  for (const item of byKey.values()) {
    item.secondsPerPercent =
      item.observedQuotaRate > 0
        ? item.observedSeconds / item.observedQuotaRate
        : null;
    item.quotaPercentPerHour =
      item.secondsPerPercent > 0 ? 3600 / item.secondsPerPercent : null;
  }
  return byKey;
}

function displayNameFor(model, fallback) {
  return text(model?.displayName) || text(model?.name) || fallback;
}

function sourceLabelFor(kind, local, radar, available) {
  if (kind === "local-calibrated") {
    return `本机近况估算 · ${local.sampleCount}个样本`;
  }
  if (kind === "local-average") {
    return `本机轮次均值 · ${local.sampleCount}个样本`;
  }
  if (kind === "radar-reference") {
    return `Codex Radar DeepSWE参考 · n=${radar?.total ?? "?"}`;
  }
  if (kind === "local-only")
    return available
      ? "本机观测估算 · Radar暂无同档位"
      : "本机观测估算 · 当前账号未确认";
  return available ? "暂无该档位速率样本" : "当前账号模型目录未确认可用";
}

function rateBasisFor(kind, state) {
  const gap = state?.gap === true ? "；监控期间存在观测空档" : "";
  if (kind === "local-calibrated")
    return `本机近况：同模型、同档位的近期分摊估算${gap}`;
  if (kind === "local-average") return `本机轮次：本任务自身的轮次耗时 ÷ 同轮额度，按耗时合并样本${gap}`;
  if (kind === "radar-reference")
    return "仅外部参考：同基准 API费用/耗时；缺少订阅额度分母，不能直接换算每1%";
  if (kind === "local-only") return "本机观测估算：没有可比 Radar同基准参考";
  return "等待本机模型与推理档位样本";
}

function sortRows(left, right) {
  if (left.available !== right.available) return left.available ? -1 : 1;
  const leftIndex = MODEL_INDEX.get(left.model.toLowerCase()) ?? 99;
  const rightIndex = MODEL_INDEX.get(right.model.toLowerCase()) ?? 99;
  const modelOrder =
    leftIndex - rightIndex || left.model.localeCompare(right.model);
  if (modelOrder) return modelOrder;
  return (
    (EFFORT_INDEX.get(left.effort) ?? 99) -
    (EFFORT_INDEX.get(right.effort) ?? 99)
  );
}

/**
 * Build a model/effort overview without I/O. Radar data is an external
 * reference only; a subscription rate requires a matching local execution
 * sample. `now` is accepted so callers can keep this function pure and
 * deterministic while choosing their own snapshot timestamp.
 */
export function buildModelOverview({
  models = [],
  sessions = [],
  state = {},
  now = Date.now(),
} = {}) {
  const radar = normalizeRadarPoints();
  const local = aggregateLocalRates(sessions);
  const availableRows = new Map();
  const modelList = Array.isArray(models) ? models : [];

  for (const metadata of modelList) {
    const modelValue = text(metadata?.model) || text(metadata?.id);
    const base = baseModel(modelValue);
    if (!base) continue;
    const available =
      metadata?.available !== false &&
      metadata?.enabled !== false &&
      metadata?.hidden !== true;
    const efforts = modelEfforts(metadata);
    for (const effort of efforts.length ? efforts : [null]) {
      const key = keyFor(base, effort);
      availableRows.set(key, {
        model: base,
        displayName: displayNameFor(metadata, base),
        effort,
        available,
        metadata,
      });
    }
  }

  for (const point of radar.values()) {
    const key = keyFor(point.model, point.effort);
    if (!availableRows.has(key)) {
      availableRows.set(key, {
        model: point.model,
        displayName: point.label || point.model,
        effort: point.effort,
        available: false,
        metadata: null,
      });
    }
  }

  for (const item of local.values()) {
    const key = keyFor(item.model, item.effort);
    if (!availableRows.has(key)) {
      availableRows.set(key, {
        model: item.model,
        displayName: item.model,
        effort: item.effort,
        available: false,
        metadata: null,
      });
    }
  }

  const rows = [];

  for (const item of availableRows.values()) {
    const key = keyFor(item.model, item.effort);
    const point = radar.get(key);
    const referenceCost = referenceCostPerHour(point);
    const localRate = local.get(key);
    let sourceKind = "unavailable";
    let secondsPerPercent = null;
    let quotaPercentPerHour = null;

    if (localRate) {
      secondsPerPercent = localRate.secondsPerPercent;
      quotaPercentPerHour = localRate.quotaPercentPerHour;
      sourceKind = point
        ? localRate.currentSamples > 0
          ? "local-calibrated"
          : "local-average"
        : "local-only";
    } else if (point) {
      sourceKind = "radar-reference";
    } else if (localRate) {
      sourceKind = "local-only";
    }

    if (localRate && sourceKind === "unavailable") sourceKind = "local-only";
    rows.push({
      model: item.model,
      displayName: item.displayName,
      effort: item.effort,
      secondsPerPercent,
      quotaPercentPerHour,
      sourceKind,
      sourceLabel: sourceLabelFor(sourceKind, localRate, point, item.available),
      referenceCostPerHour: referenceCost,
      rateBasis: rateBasisFor(sourceKind, state),
      calculationKind: localRate
        ? localRate.currentSamples > 0 ? "recent-local" : "turn-average"
        : "reference-only",
      sampleCount: localRate?.sampleCount ?? 0,
      observationSeconds: localRate?.observationSeconds ?? 0,
      referenceAnchor: null,
      available: item.available,
    });
  }

  rows.sort(sortRows);
  const updatedAt =
    text(radarReference.sourceUpdatedAt) || new Date(now).toISOString();
  return {
    rows,
    sourceUrl: RADAR_SOURCE_URL,
    updatedAt: new Date(now).toISOString(),
    referenceUpdatedAt: updatedAt,
    note: "优先显示同一执行模型、同一推理档位的本机轮次均值或近况；任务历史包含多个执行身份且没有明确轮次身份时不归入任何档位。没有可比本机样本的档位只显示外部参考，不把 Radar API费用/耗时换算为订阅额度百分比。不同模型之间不借用额度基准；本机额度速率仍为估算。",
  };
}
