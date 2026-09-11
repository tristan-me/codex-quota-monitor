import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  unlink,
  open,
  stat,
  rename,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { Collector } from "./collector.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const SERVICE_LOCK_STALE_MS = 30_000;

export const defaultDataDir = () =>
  process.env.CODEX_QUOTA_MONITOR_DATA_DIR ||
  join(homedir(), ".local", "share", "codex-quota-monitor-v2");

export async function readEndpoint(dataDir, mode) {
  try {
    const saved = JSON.parse(
      await readFile(join(dataDir, "endpoint.json"), "utf8"),
    );
    if (
      saved.mode !== mode ||
      !Number.isInteger(saved.port) ||
      saved.port < 1 ||
      saved.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(saved.token)
    )
      return null;
    return saved;
  } catch {
    return null;
  }
}

export function authorized(req, token, port) {
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host))
    return false;
  if (
    req.headers.origin &&
    ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(
      req.headers.origin,
    )
  )
    return false;
  const received = req.headers["x-quota-token"];
  return (
    typeof received === "string" &&
    received.length === token.length &&
    timingSafeEqual(Buffer.from(received), Buffer.from(token))
  );
}

function lockError() {
  return new Error("Monitor already running or startup lock held");
}

function isFresh(
  statResult,
  now = Date.now(),
  staleAfterMs = SERVICE_LOCK_STALE_MS,
) {
  return now - statResult.mtimeMs < staleAfterMs;
}

async function readLockOwner(lockPath) {
  try {
    const raw = await readFile(lockPath, "utf8");
    const value = raw.trim();
    if (!/^\d+$/.test(value)) return null;
    const pid = Number(value);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission errors are conservatively treated as alive. Only ESRCH proves
    // that the owner is gone.
    return error?.code !== "ESRCH";
  }
}

export async function acquireServiceLock(
  lockPath,
  { staleAfterMs = SERVICE_LOCK_STALE_MS } = {},
) {
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
        throw error;
      }
      return handle;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let lockStat;
      try {
        lockStat = await stat(lockPath);
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw lockError();
      }

      // A just-created empty/invalid lock is a startup race. Keep it until it
      // ages out instead of deleting another process's lock while it is writing.
      const owner = await readLockOwner(lockPath);
      if (owner === undefined || isFresh(lockStat, Date.now(), staleAfterMs))
        throw lockError();
      if (owner !== null && (await pidIsAlive(owner))) throw lockError();

      // An invalid or dead lock that has remained stale can be repaired. The
      // subsequent wx open still decides which concurrent repair attempt wins.
      await unlink(lockPath).catch((unlinkError) => {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      });
    }
  }
}

async function removeOwnedLock(lockPath, handle, pid = process.pid) {
  await handle?.close().catch(() => {});
  try {
    const owner = await readLockOwner(lockPath);
    if (owner === pid) await unlink(lockPath);
  } catch {
    // Never remove a lock whose ownership cannot be established.
  }
}

async function writeRuntime(runtimePath, record) {
  const temporary = `${runtimePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  try {
    await rename(temporary, runtimePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function removeOwnedRuntime(runtimePath, record) {
  try {
    const current = JSON.parse(await readFile(runtimePath, "utf8"));
    if (
      current?.pid !== record.pid ||
      current?.port !== record.port ||
      current?.token !== record.token
    )
      return;
    await unlink(runtimePath);
  } catch (error) {
    if (error?.code !== "ENOENT") return;
  }
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error?.code === "ERR_SERVER_NOT_RUNNING") return resolve();
      return error ? reject(error) : resolve();
    });
    // Do not leave keep-alive browser connections preventing a clean service
    // shutdown. The close callback still confirms that the server is closed.
    server.closeAllConnections?.();
  });
}

async function closeCollector(collector) {
  if (typeof collector?.close !== "function") return;
  await collector.close();
}

export async function startService({
  dataDir,
  demo = false,
  collector,
  listenPort,
  listenHost = "127.0.0.1",
} = {}) {
  // Demo credentials, state and endpoint are always isolated from real data.
  dataDir = demo
    ? join(dataDir || defaultDataDir(), "demo")
    : dataDir || defaultDataDir();
  const mode = demo ? "demo" : "live";
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = join(dataDir, "service.lock");
  const runtimePath = join(dataDir, "runtime.json");
  const lockHandle = await acquireServiceLock(lockPath);
  let serviceCollector;
  try {
    serviceCollector =
      collector ||
      new Collector({
        dataDir,
        codexHome: process.env.CODEX_HOME || join(homedir(), ".codex"),
        demo,
      });
  } catch (error) {
    await removeOwnedLock(lockPath, lockHandle);
    throw error;
  }
  let server = null;
  let runtime = null;
  let closed = false;
  let closePromise = null;

  const cleanupFailedStart = async () => {
    await closeServer(server).catch(() => {});
    await closeCollector(serviceCollector).catch(() => {});
    if (runtime) await removeOwnedRuntime(runtimePath, runtime);
    await removeOwnedLock(lockPath, lockHandle);
  };

  try {
    // Complete the synchronous local scan before advertising a ready service.
    // The collector's remote quota request remains background work by design.
    const assets = new Map(await Promise.all(
      ["index.html", "app.js", "style.css", "dashboard-utils.mjs"].map(async (file) =>
        [file, await readFile(join(root, "web", file))]),
    ));
    await serviceCollector.init();
    const endpoint = await readEndpoint(dataDir, mode);
    const token = endpoint?.token || randomBytes(32).toString("hex");
    const preferredPort = listenPort ?? endpoint?.port ?? 0;
    let port;
    server = createServer(async (req, res) => {
      const security = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      };
      const json = (code, data) => {
        res.writeHead(code, {
          "Content-Type": "application/json; charset=utf-8",
          ...security,
        });
        res.end(JSON.stringify(data));
      };
      try {
        const url = new URL(req.url, "http://127.0.0.1");
        if (url.pathname.startsWith("/api/")) {
          if (!authorized(req, token, port))
            return json(403, {
              error:
                "Open the monitor using its local launcher to authenticate.",
            });
          if (req.method === "GET" && url.pathname === "/api/snapshot")
            return json(200, {
              ...serviceCollector.snapshot(),
              mode,
              dataSchema: 2,
            });
          if (req.method === "GET" && url.pathname === "/api/health")
            return json(200, {
              app: "codex-quota-monitor",
              version: "0.2.0",
              mode,
              dataSchema: 2,
              ready: true,
              pid: process.pid,
            });
          if (demo && req.method === "POST")
            return json(403, {
              error: "演示模式不能修改真实设置；请通过正式启动器打开你的账户。",
            });
          if (
            req.method === "POST" &&
            ["/api/settings", "/api/restore-defaults"].includes(url.pathname)
          ) {
            if (!req.headers["content-type"]?.startsWith("application/json"))
              return json(415, { error: "application/json required" });
            let body = "";
            for await (const chunk of req) {
              body += chunk;
              if (Buffer.byteLength(body) > 8192)
                return json(413, { error: "Request too large" });
            }
            return json(
              200,
              url.pathname === "/api/settings"
                ? await serviceCollector.update(JSON.parse(body))
                : await serviceCollector.restoreDefaults(),
            );
          }
          return json(404, { error: "Unknown endpoint" });
        }
        if (
          req.method !== "GET" ||
          ![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)
        )
          return json(403, { error: "Local GET only" });
        const file = {
          "/": "index.html",
          "/demo/": "index.html",
          "/app.js": "app.js",
          "/style.css": "style.css",
          "/dashboard-utils.mjs": "dashboard-utils.mjs",
        }[url.pathname];
        if (!file) return json(404, { error: "Not found" });
        const bytes = assets.get(file);
        res.writeHead(200, {
          "Content-Type": {
            "index.html": "text/html; charset=utf-8",
            "app.js": "text/javascript; charset=utf-8",
            "style.css": "text/css; charset=utf-8",
            "dashboard-utils.mjs": "text/javascript; charset=utf-8",
          }[file],
          ...security,
        });
        res.end(bytes);
      } catch (error) {
        if (!res.headersSent)
          json(400, { error: String(error.message).slice(0, 200) });
        else res.destroy();
      }
    });
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(preferredPort, listenHost, resolve);
    });
    const address = server.address();
    port = address && typeof address === "object" ? address.port : null;
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Monitor listener did not report a valid port");
    runtime = {
      pid: process.pid,
      port,
      token,
      version: "0.2.0",
      dataSchema: 2,
      mode,
      dataDir,
    };
    await writeFile(
      join(dataDir, "endpoint.json"),
      JSON.stringify({ port, token, mode }) + "\n",
      { mode: 0o600 },
    );
    await writeRuntime(runtimePath, runtime);

    const close = async () => {
      if (closed) return closePromise;
      closed = true;
      closePromise = (async () => {
        let firstError = null;
        try {
          await closeServer(server);
        } catch (error) {
          firstError ||= error;
        }
        try {
          await closeCollector(serviceCollector);
        } catch (error) {
          firstError ||= error;
        }
        if (runtime) await removeOwnedRuntime(runtimePath, runtime);
        await removeOwnedLock(lockPath, lockHandle);
        if (firstError) throw firstError;
      })();
      return closePromise;
    };
    return { port, token, collector: serviceCollector, server, close };
  } catch (error) {
    await cleanupFailedStart();
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const service = await startService({ demo: process.argv.includes("--demo") });
  console.error(
    `${process.argv.includes("--demo") ? "DEMO — SYNTHETIC DATA" : "LIVE ACCOUNT"}: Codex quota monitor ready on loopback port ${service.port}`,
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await service.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
