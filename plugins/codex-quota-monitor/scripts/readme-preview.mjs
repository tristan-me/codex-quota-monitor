import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildModelOverview } from "../server/model-overview.mjs";
import { startService } from "../server/service.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const RESET_RADAR_URL = "https://codex-reset.com/zh/";
const DEMO_SOURCE = "synthetic-readme-preview";

const MODEL_CATALOG = Object.freeze([
  ["gpt-6-astra", ["ultra", "max", "xhigh", "high", "medium", "low"]],
  ["gpt-5.6-sol", ["ultra", "max", "xhigh", "high", "medium", "low"]],
  ["gpt-5.6-terra", ["ultra", "max", "xhigh", "high", "medium", "low"]],
  ["gpt-5.6-luna", ["max", "xhigh", "high", "medium", "low"]],
  ["gpt-5.5", ["xhigh", "high", "medium", "low"]],
  ["gpt-5.3-codex-spark", ["medium"]],
]);

function finiteNow(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : Date.now();
}

function modelMetadata() {
  return MODEL_CATALOG.map(([model, efforts]) => ({
    model,
    displayName: model.replace(/^gpt-/, "GPT-").replace(/astra|sol|terra|luna|codex|spark/g, value=>value[0].toUpperCase()+value.slice(1)),
    defaultReasoningEffort: efforts.includes("medium") ? "medium" : efforts[0],
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
    available: true,
    enabled: true,
    hidden: false,
  }));
}

function evidence(now, note) {
  return {
    source: DEMO_SOURCE,
    latestStatus: note,
    stale: false,
    note: `合成 README 演示：${note}`,
    observedAt: now,
  };
}

function child({
  id,
  title,
  parentThreadId = null,
  model,
  reasoningEffort,
  status,
  startedAt,
  completedAt = null,
  elapsedSeconds,
  tokens,
  tokenDelta,
  estimatedPercent,
  secondsPerPercent = null,
  averageSecondsPerPercent = null,
  observationSeconds,
}) {
  return {
    id,
    title,
    model,
    reasoningEffort,
    parentThreadId,
    status,
    startedAt,
    completedAt,
    updatedAt: completedAt || startedAt,
    elapsedSeconds,
    tokens,
    tokenDelta,
    estimatedPercent,
    secondsPerPercent,
    averageSecondsPerPercent,
    observationSeconds,
    estimateStatus: estimatedPercent === null ? "unavailable" : "allocated",
    rateStatus: status === "active"
      ? secondsPerPercent === null ? "no-recent-sample" : "recent-estimate"
      : averageSecondsPerPercent === null ? "no-timed-sample" : "observed-average",
    activityEvidence: evidence(startedAt, status),
  };
}

function readmeSessions(now) {
  const rootInterface = child({
    id: "demo-interface-refactor",
    title: "接口重构",
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    status: "active",
    startedAt: now - 25 * MINUTE_MS,
    elapsedSeconds: 1500,
    tokens: 118400,
    tokenDelta: 14200,
    estimatedPercent: 1.850,
    secondsPerPercent: 64.200,
    averageSecondsPerPercent: 72.500,
    observationSeconds: 960,
  });
  rootInterface.children = [
    child({
      id: "demo-interface-tests",
      title: "接口单元测试",
      parentThreadId: rootInterface.id,
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      status: "active",
      startedAt: now - 11 * MINUTE_MS,
      elapsedSeconds: 660,
      tokens: 48200,
      tokenDelta: 6200,
      estimatedPercent: 0.650,
      secondsPerPercent: 58.400,
      averageSecondsPerPercent: 66.700,
      observationSeconds: 600,
    }),
    child({
      id: "demo-interface-docs",
      title: "接口文档补充",
      parentThreadId: rootInterface.id,
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      status: "idle",
      startedAt: now - 22 * MINUTE_MS,
      completedAt: now - 7 * MINUTE_MS,
      elapsedSeconds: 900,
      tokens: 31600,
      tokenDelta: 3400,
      estimatedPercent: 0.300,
      averageSecondsPerPercent: 101.400,
      observationSeconds: 660,
    }),
  ];

  const rootTests = child({
    id: "demo-test-suite",
    title: "单元测试补全",
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
    status: "active",
    startedAt: now - 18 * MINUTE_MS,
    elapsedSeconds: 1080,
    tokens: 76400,
    tokenDelta: 8800,
    estimatedPercent: 1.130,
    secondsPerPercent: 70.600,
    averageSecondsPerPercent: 79.300,
    observationSeconds: 840,
  });
  rootTests.children = [
    child({
      id: "demo-test-boundaries",
      title: "边界用例检查",
      parentThreadId: rootTests.id,
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      status: "active",
      startedAt: now - 9 * MINUTE_MS,
      elapsedSeconds: 540,
      tokens: 29400,
      tokenDelta: 3100,
      estimatedPercent: 0.370,
      secondsPerPercent: 62.800,
      averageSecondsPerPercent: 75.100,
      observationSeconds: 480,
    }),
  ];

  const rootDocs = child({
    id: "demo-docs-refresh",
    title: "文档完善",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    status: "idle",
    startedAt: now - 31 * MINUTE_MS,
    completedAt: now - 4 * MINUTE_MS,
    elapsedSeconds: 1620,
    tokens: 68400,
    tokenDelta: 7600,
    estimatedPercent: 0.921,
    averageSecondsPerPercent: 118.500,
    observationSeconds: 1380,
  });
  rootDocs.children = [];

  const rootRelease = child({
    id: "demo-release-check",
    title: "发布前检查",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    status: "idle",
    startedAt: now - 42 * MINUTE_MS,
    completedAt: now - 13 * MINUTE_MS,
    elapsedSeconds: 1740,
    tokens: 39100,
    tokenDelta: 4200,
    estimatedPercent: 0.420,
    averageSecondsPerPercent: 132.000,
    observationSeconds: 1020,
  });
  rootRelease.children = [];

  const referenceRows = buildModelOverview({models:modelMetadata(),sessions:[],now}).rows;
  const costs = new Map(referenceRows.map(row=>[`${row.model}|${row.effort}`,row.referenceCostPerHour]));
  // This is a synthetic scenario only, normalized for a readable UI example.
  // It is never used to calculate a real account's subscription quota.
  const maximum = Math.max(...referenceRows.map(row=>row.referenceCostPerHour||0),1);
  const syntheticFactor = 6 / maximum;
  const ownMetrics = item => {
    const hourlyRate = (costs.get(`${item.model}|${item.reasoningEffort}`)||0)*syntheticFactor;
    const amount = hourlyRate*item.observationSeconds/3600;
    return {...item, estimatedPercent:amount, averageSecondsPerPercent:hourlyRate>0?3600/hourlyRate:null,
      secondsPerPercent:item.status==='active'&&hourlyRate>0?3600/hourlyRate:null};
  };
  const historyInterval = [now - 75 * MINUTE_MS, now - 45 * MINUTE_MS];
  const latestInterval = item => [item.startedAt, item.completedAt || now];
  const observedIntervals = item => {
    // The sample's observed work is split 60% in the prior turn and 40%
    // in the latest turn, matching the quota split displayed below.
    const recentEnd = latestInterval(item)[1];
    return [
      [historyInterval[1] - item.observationSeconds * .6 * 1000, historyInterval[1]],
      [recentEnd - item.observationSeconds * .4 * 1000, recentEnd],
    ];
  };
  const unionSeconds = intervals => {
    const ordered = intervals.filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start).sort((a,b) => a[0] - b[0]);
    let total = 0;
    let end = -Infinity;
    for (const [start, finish] of ordered) {
      total += Math.max(0, finish - Math.max(start, end)) / 1000;
      end = Math.max(end, finish);
    }
    return total;
  };
  const enrichOwn = (item, latestEstimate) => ({...item,
    totalElapsedSeconds: unionSeconds([historyInterval, latestInterval(item)]),
    totalEstimatedPercent: item.estimatedPercent,
    averageSecondsPerPercent: item.estimatedPercent > 0 ? unionSeconds([historyInterval, latestInterval(item)]) / item.estimatedPercent : null,
    latestTurnElapsedSeconds: Math.max(0, (latestInterval(item)[1] - latestInterval(item)[0]) / 1000),
    latestTurnEstimatedPercent: latestEstimate,
    latestTurnStartedAt: item.startedAt,
    latestTurnChildCount: 0,
    latestTurnStatus: item.status,
    latestTurnSecondsPerPercent: item.secondsPerPercent || (latestEstimate > 0 ? Math.max(0, (latestInterval(item)[1] - latestInterval(item)[0]) / 1000) / latestEstimate : null),
  });
  const sortByActivityThenStart = (a, b) => {
    const aActive = a.status === "active";
    const bActive = b.status === "active";
    if (aActive !== bActive) return aActive ? -1 : 1;
    const aStart = Number.isFinite(a.latestTurnStartedAt) ? a.latestTurnStartedAt : -Infinity;
    const bStart = Number.isFinite(b.latestTurnStartedAt) ? b.latestTurnStartedAt : -Infinity;
    if (aStart === bStart) return 0;
    return bStart - aStart;
  };
  return [rootInterface, rootTests, rootDocs, rootRelease].map(root=>{
    const own=ownMetrics(root), children=root.children.map(ownMetrics);
    const total=own.estimatedPercent+children.reduce((sum,item)=>sum+item.estimatedPercent,0);
    const totalElapsedSeconds=unionSeconds([historyInterval, ...[root, ...root.children].map(latestInterval)]);
    const latestTurnElapsedSeconds=unionSeconds([root, ...root.children].map(latestInterval));
    const latestTurnEstimatedPercent=[own,...children].reduce((sum,item)=>sum+item.estimatedPercent*.4,0);
    const latestTurnStartedAt=root.startedAt;
    const observedGroupSeconds=unionSeconds([own,...children].flatMap(observedIntervals));
    const activeRate=[own,...children].reduce((sum,item)=>sum+(item.secondsPerPercent?1/item.secondsPerPercent:0),0);
    const ownWithTotals=enrichOwn(own, own.estimatedPercent === null ? null : own.estimatedPercent * 0.4);
    const childrenWithTotals=children.map(item=>enrichOwn(item, item.estimatedPercent === null ? null : item.estimatedPercent * 0.4)).sort(sortByActivityThenStart);
    return {...ownWithTotals,children:childrenWithTotals,childCount:childrenWithTotals.length,estimatedPercent:total,
      totalElapsedSeconds,totalEstimatedPercent:total,
      observationSeconds:observedGroupSeconds,
      secondsPerPercent:root.status==='active'&&activeRate>0?1/activeRate:null,
      latestTurnElapsedSeconds,
      latestTurnEstimatedPercent,
      latestTurnSecondsPerPercent:latestTurnEstimatedPercent>0?latestTurnElapsedSeconds/latestTurnEstimatedPercent:null,
      latestTurnChildCount:childrenWithTotals.length,
      latestTurnStartedAt:Number.isFinite(latestTurnStartedAt)?latestTurnStartedAt:null,
      averageSecondsPerPercent:total>0?totalElapsedSeconds/total:null,
      ownStatus:own.status,ownEstimatedPercent:own.estimatedPercent,
      ownSecondsPerPercent:own.secondsPerPercent,ownAverageSecondsPerPercent:own.averageSecondsPerPercent,
      ownObservationSeconds:own.observationSeconds,
      ownLatestTurnElapsedSeconds:ownWithTotals.latestTurnElapsedSeconds,
      ownLatestTurnEstimatedPercent:ownWithTotals.latestTurnEstimatedPercent,
      ownLatestTurnSecondsPerPercent:ownWithTotals.latestTurnSecondsPerPercent,
      observationSince:now-75*MINUTE_MS};
  }).sort(sortByActivityThenStart);
}

function syntheticResetRadar(now, supplied) {
  if (supplied && typeof supplied === "object") return supplied;
  const scheduledAt = now + 4 * DAY_MS + 7 * HOUR_MS;
  return {
    source: RESET_RADAR_URL,
    sourceUrl: RESET_RADAR_URL,
    sourceKind: "public-reference",
    mode: "demo",
    title: "公开重置雷达参考",
    windowLabel: "Codex 周窗口（合成账户）",
    scheduledAt,
    secondsUntil: (scheduledAt - now) / 1000,
    note: "这是公开页面入口与合成演示时间，不代表任何账户的真实重置承诺。",
    observedAt: now,
  };
}

function syntheticState(now, sessions) {
  const sessionLedger = {};
  for (const root of sessions) {
    const all = [root, ...(root.children || [])];
    for (const item of all) {
      sessionLedger[item.id] = {
        allocatedPercent: item.estimatedPercent || 0,
        timedPercent: item.estimatedPercent || 0,
        activeSeconds: item.observationSeconds || 0,
        hasAllocation: item.estimatedPercent !== null,
      };
    }
  }
  return {
    gap: false,
    sessionTrackingSince: now - 75 * MINUTE_MS,
    sessionLedger,
    calibratedTokens: 31800,
    calibratedPercent: 4.321,
  };
}

/**
 * Return a deterministic, local-only snapshot for README screenshots.
 * Every account, thread, token count, rate and reset value is synthetic.
 */
export function createReadmeSnapshot({ now = Date.now(), resetRadar = null } = {}) {
  const sampledAt = finiteNow(now);
  const sessions = readmeSessions(sampledAt);
  const models = modelMetadata();
  const state = syntheticState(sampledAt, sessions);
  const scheduledAt = sampledAt + 4 * DAY_MS + 7 * HOUR_MS;
  const historyValues = [72.980, 72.910, 72.840, 72.760, 72.680, 72.590, 72.470, 72.345];
  const history = historyValues.map((remainingPercent, index) => ({
    at: sampledAt - (historyValues.length - index - 1) * 15 * MINUTE_MS,
    remainingPercent,
  }));
  const radar = syntheticResetRadar(sampledAt, resetRadar);
  const modelOverview = buildModelOverview({
    models,
    sessions,
    state,
    now: sampledAt,
  });

  return {
    version: "0.2.0",
    dataSchema: 2,
    mode: "demo",
    dataSource: {
      mode: "demo",
      kind: "synthetic",
      type: DEMO_SOURCE,
      source: DEMO_SOURCE,
      label: "README 截图演示数据",
    },
    now: sampledAt,
    settings: {
      pollSeconds: 5,
      quotaPollSeconds: 30,
      retentionHours: 24,
      paused: false,
      autoSwitch: false,
      hideDisclaimer: false,
      objective: "balanced",
    },
    account: {
      summary: {
        usedPercent: 27.655,
        remainingPercent: 72.345,
        windowLabel: "Codex · 周额度（合成）",
        windowMinutes: 10080,
        resetsAt: scheduledAt,
        observedAt: sampledAt - 14_000,
        source: DEMO_SOURCE,
      },
      windows: [{
        id: "demo:codex:weekly",
        bucket: "codex",
        label: "Codex · 周额度（合成）",
        usedPercent: 27.655,
        remainingPercent: 72.345,
        windowMinutes: 10080,
        resetsAt: scheduledAt,
        planType: "pro",
        source: DEMO_SOURCE,
        observedAt: sampledAt - 14_000,
      }],
      plan: {
        type: "pro",
        multiplier: null,
        source: DEMO_SOURCE,
        detail: "合成演示账户；不是任何登录账户，也不代表 Pro 5x/20x。",
      },
      error: null,
      lastFetchedAt: sampledAt - 14_000,
      stale: false,
    },
    sessions,
    attribution: {
      observedPercent: 5.000,
      estimatedPercent: sessions.reduce((sum,item)=>sum+item.estimatedPercent,0),
      calibrated: true,
      unattributedPercent: 5-sessions.reduce((sum,item)=>sum+item.estimatedPercent,0),
      windowLabel: "Codex · 周额度（合成）",
      since: sampledAt - 75 * MINUTE_MS,
      assumption: "合成演示：会话归因数字不来自任何订阅账户或真实任务。",
    },
    cost: {
      localReads: 18,
      localRead: 18,
      remoteReads: 0,
      lastLocalMs: 2.4,
      llmCalls: 0,
      modelCalls: 0,
      configReads: 0,
      configWrites: 0,
      requestsPerHour: 0,
      localReadsPerHour: 720,
      extraRemoteReads: "演示模式：没有网络额度读取、模型调用或模型配置写入。",
    },
    recommendation: {
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
      reason: "合成演示推荐；实际账户需要重新读取可用模型后再判断。",
      source: DEMO_SOURCE,
      appliedAt: null,
      error: null,
    },
    models,
    modelOverview,
    capabilities: {
      nativeInline: false,
      windowPopup: false,
      autoSwitchScope: "disabled-in-demo",
      threadUsage: "synthetic",
    },
    diagnostics: [
      { level: "info", message: "演示模式：会话、额度、速率、趋势和模型数据均为合成示例。" },
      { level: "info", message: "账户剩余 72.35% 是合成示例，不代表任何真实账户。" },
    ],
    history,
    reset: {
      source: DEMO_SOURCE,
      timezone: "Asia/Shanghai",
      windowLabel: "Codex · 周额度（合成）",
      stale: false,
      scheduledAt,
      lastKnownScheduledAt: scheduledAt,
      secondsUntil: (scheduledAt - sampledAt) / 1000,
      exhaustionAt: sampledAt + 9 * HOUR_MS,
      unexpected: "unknown",
      radar,
    },
    resetRadar: radar,
    synthetic: true,
  };
}

export function createReadmePreviewCollector({ now = Date.now(), resetRadar = null } = {}) {
  const snapshot = createReadmeSnapshot({ now, resetRadar });
  return {
    async init() {},
    snapshot() {
      return structuredClone(snapshot);
    },
    async update() {
      throw new Error("演示预览不支持设置修改");
    },
    async restoreDefaults() {
      throw new Error("演示预览不支持恢复设置");
    },
    async close() {},
  };
}

async function loadOptionalResetRadar(now) {
  const modulePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "reset-radar.mjs");
  if (!existsSync(modulePath)) return null;
  try {
    const module = await import(pathToFileURL(modulePath).href);
    const builder = module.buildResetRadar || module.default;
    if (typeof builder !== "function") return null;
    const value = await builder({ now, mode: "demo" });
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export async function startReadmePreview({ dataDir, now = Date.now() } = {}) {
  const explicitDir = dataDir || process.env.CODEX_QUOTA_MONITOR_PREVIEW_DIR;
  const previewDir = explicitDir || await mkdtemp(path.join(os.tmpdir(), "codex-quota-readme-preview-"));
  const ownsDir = !explicitDir;
  const resetRadar = await loadOptionalResetRadar(finiteNow(now));
  const collector = createReadmePreviewCollector({ now, resetRadar });
  try {
    const service = await startService({
      dataDir: previewDir,
      demo: true,
      collector,
    });
    return {
      ...service,
      dataDir: previewDir,
      async cleanup() {
        await service.close();
        if (ownsDir) await rm(previewDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (ownsDir) await rm(previewDir, { recursive: true, force: true });
    throw error;
  }
}

function previewUrl(service) {
  return `http://127.0.0.1:${service.port}/demo/#${service.token}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const service = await startReadmePreview();
  const url = previewUrl(service);
  console.log(`DEMO ONLY — synthetic README preview (not account data): ${url}`);
  console.log("No browser was opened. Press Ctrl-C to stop the temporary preview service.");
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await service.cleanup().catch(() => {});
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
