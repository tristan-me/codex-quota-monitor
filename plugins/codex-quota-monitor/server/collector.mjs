import { createHash } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { LocalReader } from "./local-reader.mjs";
import { CodexAppServerClient } from "./app-server-client.mjs";
import { Estimator, accountDisplay, mainWindow } from "./metrics.mjs";
import { recommend } from "./recommend.mjs";

export const DEFAULT_SETTINGS = {
  pollSeconds: 5,
  quotaPollSeconds: 30,
  paused: false,
  autoSwitch: false,
  hideDisclaimer: false,
  objective: "balanced",
};
const errorText = (error) => String(error?.message || error).slice(0, 250);
const editsFor = (model, effort) => [
  { keyPath: "model", value: model, mergeStrategy: "replace" },
  {
    keyPath: "model_reasoning_effort",
    value: effort,
    mergeStrategy: "replace",
  },
];

export function validateSettings(patch) {
  if (!patch || Array.isArray(patch) || typeof patch !== "object")
    throw new Error("Settings must be an object");
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key))
      throw new Error("Unknown setting: " + key);
    if (["pollSeconds", "quotaPollSeconds"].includes(key)) {
      const min = key === "pollSeconds" ? 2 : 5;
      const max = key === "pollSeconds" ? 300 : 3600;
      if (!Number.isFinite(value) || value < min || value > max)
        throw new Error("Polling frequency outside supported range");
    }
    if (
      ["paused", "autoSwitch", "hideDisclaimer"].includes(key) &&
      typeof value !== "boolean"
    )
      throw new Error("Expected boolean");
    if (
      key === "objective" &&
      !["economy", "balanced", "quality"].includes(value)
    )
      throw new Error("Unknown objective");
  }
  return patch;
}

export class Collector {
  constructor({ dataDir, codexHome, reader, client, demo = false }) {
    this.dataDir = dataDir;
    this.reader = reader || new LocalReader({ codexHome });
    this.client = client || new CodexAppServerClient();
    this.demo = demo;
    this.settings = { ...DEFAULT_SETTINGS };
    this.threads = [];
    this.diagnostics = [];
    this.messages = [];
    this.account = {
      windows: [],
      summary: null,
      plan: { type: null, multiplier: null },
      error: null,
      lastFetchedAt: null,
    };
    this.models = [];
    this.estimator = new Estimator();
    this.cost = {
      localReads: 0,
      remoteReads: 0,
      lastLocalMs: 0,
      llmCalls: 0,
      configReads: 0,
      configWrites: 0,
    };
    this.recommendation = {};
    this.nextQuota = 0;
    this.nextModel = 0;
    this.nextProbe = 0;
    this.probe = null;
    this.closed = false;
    this.mutationQueue = Promise.resolve();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const file = join(this.dataDir, "state.json");
    try {
      const saved = JSON.parse(await readFile(file, "utf8"));
      if (
        !this.demo &&
        (saved.mode === "demo" ||
          Object.keys(saved.estimator?.lastTokens || {}).some((id) =>
            id.startsWith("demo-"),
          ))
      )
        throw new Error("Synthetic state cannot be used in live mode");
      this.settings = {
        ...DEFAULT_SETTINGS,
        ...validateSettings(saved.settings || {}),
      };
      this.estimator = new Estimator(saved.estimator);
      this.originalDefaults = saved.originalDefaults;
      this.lastApplied = saved.lastApplied;
    } catch (error) {
      if (error.code !== "ENOENT") {
        // Preserve a damaged state rather than silently overwriting the evidence.
        await rename(file, file + ".invalid-" + Date.now());
        this.settings = { ...DEFAULT_SETTINGS };
        this.estimator = new Estimator();
        this.messages.push(
          "监控状态文件无法读取，已保留备份并重新开始统计；自动切换已关闭。",
        );
      }
    }
    Object.assign(this.estimator.state, {
      gap: true,
      pending: {},
      lastTokens: {},
    });
    await this.local();
    this.schedule();
    if (!this.settings.paused) this.remote();
  }

  save() {
    const path = join(this.dataDir, "state.json");
    const value = JSON.stringify({
      mode: this.demo ? "demo" : "live",
      settings: this.settings,
      estimator: this.estimator.state,
      originalDefaults: this.originalDefaults,
      lastApplied: this.lastApplied,
    });
    this.saving = (this.saving || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await writeFile(path + ".tmp", value, { mode: 0o600 });
        await rename(path + ".tmp", path);
      });
    return this.saving;
  }

  async local() {
    const start = performance.now();
    try {
      const result = this.demo ? this.demoThreads() : await this.reader.read();
      if (!Array.isArray(result?.threads))
        throw new Error("Local reader returned no thread array");
      this.threads = result.threads;
      this.diagnostics = Object.values(result.diagnostics || {}).flatMap(
        (value) =>
          typeof value === "string"
            ? [value]
            : Array.isArray(value)
              ? value.filter((x) => typeof x === "string")
              : [],
      );
      if (result.diagnostics?.truncated)
        this.diagnostics.push(
          "历史发现达到上限；近期运行线程另外补入，旧任务可能未全部覆盖。",
        );
      this.estimator.local(this.threads, Date.now());
    } catch (error) {
      this.diagnostics = ["本地状态读取失败：" + errorText(error)];
      this.threads = this.threads.map((thread) => ({
        ...thread,
        status: "unknown",
      }));
      this.estimator.state.gap = true;
    }
    this.cost.localReads += 1;
    this.cost.lastLocalMs = performance.now() - start;
  }

  demoThreads() {
    const now = Date.now();
    this.demoStart ||= now - 93000;
    const elapsed = now - this.demoStart;
    const rows = [
      ["demo-build", "构建支付设置页面", "gpt-5.6-terra", 8, 0],
      ["demo-review", "检查解析器边界条件", "gpt-5.6-luna", 3, 10000],
    ];
    return {
      threads: rows.map(([id, title, model, weight, offset]) => ({
        id,
        title,
        model,
        reasoningEffort: "medium",
        status: "active",
        tokens: 100000 + Math.floor(elapsed * weight),
        startedAt: this.demoStart + offset,
        updatedAt: now,
        activityEvidence: "演示数据",
      })),
      diagnostics: { mode: "演示模式：全部数据为合成示例" },
    };
  }

  schedule() {
    clearTimeout(this.timer);
    if (this.closed) return;
    this.timer = setTimeout(async () => {
      try {
        if (!this.settings.paused) {
          await this.local();
          if (Date.now() >= this.nextQuota) this.remote();
        }
      } catch (error) {
        this.diagnostics = ["本地调度错误：" + errorText(error)];
      } finally {
        this.schedule();
      }
    }, this.settings.pollSeconds * 1000);
  }

  remote() {
    if (this.inFlight || this.closed || this.settings.paused)
      return this.background;
    this.inFlight = true;
    this.background = this.collectRemote()
      .catch((error) => {
        this.messages = ["监控后台错误：" + errorText(error)];
      })
      .finally(() => {
        this.inFlight = false;
      });
    return this.background;
  }

  async collectRemote() {
    const now = Date.now();
    this.nextQuota = now + this.settings.quotaPollSeconds * 1000;
    let result;
    try {
      if (this.demo) {
        result = {
          rateLimits: {
            limitId: "codex",
            primary: {
              usedPercent: 27 + Math.floor((now - this.demoStart) / 15000),
              windowDurationMins: 10080,
              resetsAt: Math.floor(this.demoStart / 1000) + 190000,
            },
          },
        };
      } else {
        this.cost.remoteReads += 1;
        result = await this.client.request("account/rateLimits/read", {});
      }
      if (this.closed) return;
      const sampledAt = Date.now();
      const account = accountDisplay(result, sampledAt);
      if (!account.windows.length)
        throw new Error("Quota response contained no valid windows");
      this.account = account;
      const accountKey = createHash("sha256")
        .update(result.accountId || "identity-unavailable")
        .digest("hex");
      this.estimator.quota(mainWindow(account.windows), sampledAt, accountKey);
      this.failures = 0;
    } catch (error) {
      if (this.closed) return;
      this.account.error = errorText(error);
      this.estimator.state.gap = true;
      this.failures = (this.failures || 0) + 1;
      this.nextQuota =
        now +
        Math.max(
          this.settings.quotaPollSeconds * 1000,
          Math.min(900000, 15000 * 2 ** this.failures),
        );
      await this.client.close();
      return;
    }
    if (this.demo) {
      this.models = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-6-astra"].map(
        (model) => ({
          model,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium" },
            { reasoningEffort: "high" },
          ],
        }),
      );
    } else if (now >= this.nextModel) {
      this.cost.remoteReads += 1;
      try {
        const models = (await this.client.request("model/list", { limit: 50 }))
          .data;
        if (!Array.isArray(models)) throw new Error("Invalid model list");
        this.models = models;
        this.nextModel = now + 3600000;
      } catch {
        this.nextModel = now + 60000;
        this.diagnostics.push("模型列表暂不可用，一分钟后重试。");
      }
    }
    if (this.closed) return;
    const active = this.threads.find((thread) => thread.status === "active");
    if (!this.demo && active && now >= this.nextProbe) {
      this.cost.remoteReads += 1;
      try {
        const usage = await this.client.request("account/usage/read", {
          threadId: active.id,
        });
        this.probe = usage.threadUsage ? "available" : "unavailable";
        this.nextProbe = now + 3600000;
      } catch {
        this.probe = "unavailable";
        this.nextProbe = now + 60000;
      }
    }
    if (this.closed) return;
    this.refreshRecommendation();
    if (this.settings.autoSwitch && !this.demo) {
      try {
        await this.mutate(() => this.applyRecommendation());
      } catch (error) {
        this.recommendation.error = errorText(error);
      }
    }
    if (!this.closed) await this.save();
  }

  refreshRecommendation() {
    this.recommendation = {
      ...recommend(this.models, this.settings.objective),
      appliedAt: this.lastApplied?.at,
      error: this.recommendation.error,
    };
  }

  mutate(action) {
    const operation = this.mutationQueue.catch(() => {}).then(action);
    this.mutationQueue = operation;
    return operation;
  }

  async readDefaults() {
    this.cost.configReads += 1;
    const response = await this.client.request("config/read", {
      includeLayers: true,
    });
    const layer = response.layers?.find(
      (item) => item.name?.type === "user" && !item.name.profile,
    );
    if (!layer || typeof layer.version !== "string")
      throw new Error(
        "Cannot verify writable user-config version; automatic changes are disabled",
      );
    return {
      model: layer.config?.model ?? null,
      effort: layer.config?.model_reasoning_effort ?? null,
      version: layer.version,
    };
  }

  async applyRecommendation() {
    const desired = recommend(this.models, this.settings.objective);
    if (
      this.closed ||
      !this.settings.autoSwitch ||
      !desired.model ||
      !desired.reasoningEffort
    )
      return;
    if (
      this.lastApplied?.model === desired.model &&
      this.lastApplied?.effort === desired.reasoningEffort
    )
      return;
    const current = await this.readDefaults();
    if (
      this.lastApplied &&
      (current.model !== this.lastApplied.model ||
        current.effort !== this.lastApplied.effort)
    ) {
      this.settings.autoSwitch = false;
      await this.save();
      throw new Error(
        "检测到你在监控器之外修改了默认模型，已停止接管；如需继续，请重新勾选。",
      );
    }
    if (!this.originalDefaults) {
      this.originalDefaults = { model: current.model, effort: current.effort };
      await this.save();
    }
    if (this.closed || !this.settings.autoSwitch) return;
    await this.client.writeDefaults(
      editsFor(desired.model, desired.reasoningEffort),
      {
        authorized: true,
        expectedVersion: current.version,
      },
    );
    this.cost.configWrites += 1;
    this.lastApplied = {
      model: desired.model,
      effort: desired.reasoningEffort,
      at: Date.now(),
    };
    this.recommendation.appliedAt = this.lastApplied.at;
    this.recommendation.error = null;
  }

  update(patch) {
    validateSettings(patch);
    return this.mutate(async () => {
      if (!this.settings.autoSwitch && patch.autoSwitch === true) {
        // Explicit re-enablement starts a new authorization from current defaults.
        this.originalDefaults = null;
        this.lastApplied = null;
      }
      this.settings = { ...this.settings, ...patch };
      this.refreshRecommendation();
      await this.save();
      this.nextQuota = 0;
      this.schedule();
      if (this.settings.autoSwitch && !this.demo) {
        try {
          await this.applyRecommendation();
        } catch (error) {
          this.recommendation.error = errorText(error);
        }
      }
      await this.save();
      return this.snapshot();
    });
  }

  restoreDefaults() {
    return this.mutate(async () => {
      if (!this.originalDefaults || !this.lastApplied)
        throw new Error("没有可恢复的模型修改记录。");
      const current = await this.readDefaults();
      if (
        current.model !== this.lastApplied.model ||
        current.effort !== this.lastApplied.effort
      )
        throw new Error("你已经另行修改默认模型；监控器不会覆盖这些修改。");
      await this.client.writeDefaults(
        editsFor(this.originalDefaults.model, this.originalDefaults.effort),
        {
          authorized: true,
          expectedVersion: current.version,
        },
      );
      this.cost.configWrites += 1;
      this.settings.autoSwitch = false;
      this.lastApplied = null;
      this.originalDefaults = null;
      this.recommendation.error = null;
      this.refreshRecommendation();
      await this.save();
      return this.snapshot();
    });
  }

  snapshot() {
    const now = Date.now();
    const state = this.estimator.state;
    const window = mainWindow(this.account.windows);
    const stale =
      this.account.error !== null ||
      !this.account.lastFetchedAt ||
      now - this.account.lastFetchedAt >
        Math.max(120000, this.settings.quotaPollSeconds * 3000);
    const sessions = this.estimator
      .sessions(this.threads, now)
      .map((session) => ({
        ...session,
        observationSince: state.since,
        ...(this.settings.paused || stale ? { secondsPerPercent: null } : {}),
      }));
    const rate = sessions.reduce(
      (sum, task) =>
        sum + (task.secondsPerPercent ? 1 / task.secondsPerPercent : 0),
      0,
    );
    return {
      version: "0.2.0",
      dataSchema: 2,
      mode: this.demo ? "demo" : "live",
      dataSource: this.demo ? "synthetic-demo" : "current-local-codex-account",
      now,
      settings: this.settings,
      account: { ...this.account, stale },
      sessions,
      attribution: {
        observedPercent: state.observedPercent,
        estimatedPercent:
          state.calibratedTokens > 0
            ? Object.values(state.totals).reduce((a, b) => a + b, 0)
            : null,
        calibrated: state.calibratedTokens > 0,
        unattributedPercent: state.unattributedPercent,
        windowLabel: window?.label || "等待账户窗口",
        since: state.since,
        assumption:
          "假设账户消耗来自所监控本机；跨设备使用和模型权重差异无法精确拆分",
      },
      cost: {
        ...this.cost,
        requestsPerHour: this.settings.paused
          ? 0
          : 3600 / this.settings.quotaPollSeconds,
        localReadsPerHour: this.settings.paused
          ? 0
          : 3600 / this.settings.pollSeconds,
        extraRemoteReads:
          "模型列表/逐任务能力探测各每小时一次；失败时最短一分钟重试。计数是 RPC 调用，不是底层 HTTP 包数。",
      },
      recommendation: this.recommendation,
      capabilities: {
        nativeInline: false,
        windowPopup: false,
        autoSwitchScope: "future-defaults",
        threadUsage: this.probe,
      },
      diagnostics: [
        ...this.messages,
        ...this.diagnostics,
        ...(this.probe === "unavailable"
          ? ["此账号逐任务 credits 暂未返回：使用低置信本机 token 占比分摊。"]
          : []),
        ...(this.probe === "available"
          ? [
              "已探测到逐任务 credits；本版本仍用本机 token 占比分摊，不宣称官方逐任务百分比。",
            ]
          : []),
      ],
      history: state.history,
      reset: {
        source: "account/rateLimits/read",
        timezone: "Asia/Shanghai",
        windowLabel: window?.label || null,
        stale,
        scheduledAt: !stale ? window?.resetsAt : null,
        lastKnownScheduledAt: window?.resetsAt,
        secondsUntil:
          !stale && window?.resetsAt
            ? Math.max(0, (window.resetsAt - now) / 1000)
            : null,
        exhaustionAt:
          !stale && window && rate > 0
            ? now + (window.remainingPercent / rate) * 1000
            : null,
        unexpected: "unknown",
      },
    };
  }

  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    await this.client.close();
    await Promise.race([
      Promise.allSettled([this.background, this.mutationQueue]),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    await this.save();
  }
}
