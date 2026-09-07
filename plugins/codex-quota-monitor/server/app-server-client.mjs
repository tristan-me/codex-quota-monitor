import { spawn } from "node:child_process";
import readline from "node:readline";
import { existsSync } from "node:fs";

const LARGE_INTEGER_FIELDS = [
  "estimatedUsageCreditsMicros",
  "estimatedUsageUsdMicros",
  "netNewInputTokens",
  "cachedInputTokens",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "lifetimeTokens",
  "peakDailyTokens",
];

export function parseAppServerLine(line) {
  let protectedLine = line;
  for (const field of LARGE_INTEGER_FIELDS) {
    const expression = new RegExp(
      `("${field}"\\s*:\\s*)(-?\\d{16,})(?=\\s*[,}])`,
      "g",
    );
    protectedLine = protectedLine.replace(expression, '$1"$2"');
  }
  return JSON.parse(protectedLine);
}

export function commandConfiguration() {
  const desktop = [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ];
  const command =
    process.env.CODEX_QUOTA_MONITOR_CODEX_BIN ||
    desktop.find(existsSync) ||
    "codex";
  return { command, args: ["-c", "features.plugins=false", "app-server"] };
}
export const READ_METHODS = new Set([
  "account/rateLimits/read",
  "account/usage/read",
  "model/list",
  "config/read",
]);

export class CodexAppServerClient {
  constructor(options = {}) {
    const configured = commandConfiguration();
    this.command = options.command || configured.command;
    this.env = options.env || process.env;
    this.args = options.args || configured.args;
    this.process = null;
    this.reader = null;
    this.pending = new Map();
    this.nextId = 1;
    this.readyPromise = null;
    this.stderrTail = "";
    this.lastError = null;
    this.notificationListeners = new Set();
  }

  onNotification(listener) {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  async ensureStarted() {
    if (this.process && !this.process.killed && this.readyPromise)
      return this.readyPromise;
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.#start();
    try {
      await this.readyPromise;
    } catch (error) {
      this.readyPromise = null;
      throw error;
    }
  }

  async #start() {
    this.stderrTail = "";
    this.lastError = null;
    const child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: this.env,
    });
    this.process = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-8192);
    });
    child.once("error", (error) => this.#failAll(error));
    child.once("exit", (code, signal) => {
      // Never copy raw stderr into tool output; it may contain private paths.
      const detail = this.stderrTail.includes("failed to load configuration")
        ? "; incompatible configuration or CLI version"
        : "";
      const error = new Error(
        `codex app-server exited (${code ?? signal ?? "unknown"})${detail}; check CLI version and login locally`,
      );
      this.#failAll(error);
      this.process = null;
      this.readyPromise = null;
    });
    this.reader = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    this.reader.on("line", (line) => this.#handleLine(line));

    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await this.#rawRequest(
      "initialize",
      {
        clientInfo: {
          name: "codex_quota_monitor",
          title: "Codex Quota Monitor",
          version: "0.2.0",
        },
        capabilities: { experimentalApi: true },
      },
      15_000,
    );
    this.#send({ method: "initialized", params: {} });
  }

  #send(message) {
    if (!this.process?.stdin?.writable)
      throw new Error("codex app-server is not writable");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    let message;
    try {
      message = parseAppServerLine(line);
    } catch {
      this.lastError = new Error("Non-JSON response from Codex App Server");
      return;
    }
    if (message && message.id !== undefined && !message.method) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(
          message.error.message || "codex app-server request failed",
        );
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message && message.method && message.id !== undefined) {
      this.#send({
        id: message.id,
        error: { code: -32601, message: "Client request not supported" },
      });
      return;
    }
    if (message?.method) {
      for (const listener of this.notificationListeners) {
        try {
          listener(message);
        } catch {
          /* Listener errors are isolated. */
        }
      }
    }
  }

  #failAll(error) {
    this.lastError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  #rawRequest(method, params, timeoutMs) {
    const id = `quota-monitor-${process.pid}-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        const message = { method, id };
        if (params !== undefined) message.params = params;
        this.#send(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async request(method, params, timeoutMs = 12_000) {
    if (!READ_METHODS.has(method))
      throw new Error("Read-only client rejected method: " + method);
    await this.ensureStarted();
    return this.#rawRequest(method, params, timeoutMs);
  }

  async writeDefaults(edits, { authorized = false, expectedVersion } = {}) {
    if (
      !authorized ||
      !Array.isArray(edits) ||
      edits.length !== 2 ||
      new Set(edits.map((e) => e.keyPath)).size !== 2 ||
      !edits.every(
        (e) =>
          ["model", "model_reasoning_effort"].includes(e.keyPath) &&
          (e.value === null ||
            (typeof e.value === "string" && /^[A-Za-z0-9._-]+$/.test(e.value))),
      )
    )
      throw new Error("Explicit dashboard opt-in required");
    await this.ensureStarted();
    return this.#rawRequest(
      "config/batchWrite",
      {
        edits,
        reloadUserConfig: false,
        ...(expectedVersion ? { expectedVersion } : {}),
      },
      12000,
    );
  }

  async close() {
    this.#failAll(new Error("Monitor client closed"));
    this.reader?.close();
    if (this.process && !this.process.killed) this.process.kill();
    this.process = null;
    this.readyPromise = null;
  }
}
