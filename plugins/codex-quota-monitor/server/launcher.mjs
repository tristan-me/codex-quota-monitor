import { spawn } from "node:child_process";
import { readFile, mkdir, open, unlink, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { SERVICE_LOCK_STALE_MS } from "./service.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
export const STARTUP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;
const dataDir = () =>
  process.env.CODEX_QUOTA_MONITOR_DATA_DIR ||
  join(homedir(), ".local", "share", "codex-quota-monitor-v2");

async function existing() {
  try {
    const record = JSON.parse(
      await readFile(join(dataDir(), "runtime.json"), "utf8"),
    );
    if (
      !Number.isInteger(record.port) ||
      record.port < 1 ||
      record.port > 65535 ||
      typeof record.token !== "string"
    )
      return null;
    const response = await fetch(`http://127.0.0.1:${record.port}/api/health`, {
      headers: { "X-Quota-Token": record.token },
      signal: AbortSignal.timeout(500),
    });
    const body = await response.json();
    if (
      response.ok &&
      body.app === "codex-quota-monitor" &&
      body.version === "0.2.0" &&
      body.mode === "live" &&
      body.dataSchema === 2 &&
      body.ready !== false
    )
      return record;
  } catch {
    // A partially written or stale runtime record is retried below.
  }
  return null;
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return true;
  }
}

async function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

export async function acquireLaunchLock(lockPath) {
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
        return null;
      }
      let owner = null;
      try {
        const raw = (await readFile(lockPath, "utf8")).trim();
        if (/^\d+$/.test(raw)) {
          const parsed = Number(raw);
          if (Number.isInteger(parsed) && parsed > 0) owner = parsed;
        }
      } catch {
        return null;
      }
      // Keep fresh or live locks. This prevents concurrent launchers from
      // starting duplicate detached service children.
      if (
        Date.now() - lockStat.mtimeMs < STARTUP_TIMEOUT_MS ||
        (owner !== null && (await pidIsAlive(owner)))
      )
        return null;
      await unlink(lockPath).catch((unlinkError) => {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      });
    }
  }
}

export async function releaseLaunchLock(lockPath, handle) {
  await handle?.close().catch(() => {});
  try {
    const raw = (await readFile(lockPath, "utf8")).trim();
    if (raw === String(process.pid)) await unlink(lockPath);
  } catch {
    // Preserve a lock when ownership cannot be established.
  }
}

async function waitForService(deadline) {
  while (Date.now() < deadline) {
    const record = await existing();
    if (record) return record;
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())),
      ),
    );
  }
  throw new Error(
    "Monitor did not start within 10 seconds. Check Node >=22.13 and service.log in the monitor data directory.",
  );
}

async function serviceLockIsStale(lockPath) {
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    return error?.code === "ENOENT";
  }
  if (Date.now() - lockStat.mtimeMs < SERVICE_LOCK_STALE_MS) return false;
  try {
    const raw = (await readFile(lockPath, "utf8")).trim();
    if (!/^\d+$/.test(raw)) return true;
    const owner = Number(raw);
    return !Number.isInteger(owner) || owner <= 0 || !(await pidIsAlive(owner));
  } catch {
    return false;
  }
}

async function waitForServiceOrStaleLock(deadline, lockPath) {
  while (Date.now() < deadline) {
    const record = await existing();
    if (record) return record;
    if (!(await fileExists(lockPath)) || (await serviceLockIsStale(lockPath)))
      return null;
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())),
      ),
    );
  }
  throw new Error(
    "Monitor did not start within 10 seconds. Check Node >=22.13 and service.log in the monitor data directory.",
  );
}

async function ensureServiceInternal() {
  let record = await existing();
  if (record) return record;
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  const launchLockPath = join(dataDir(), "launcher.lock");
  const serviceLockPath = join(dataDir(), "service.lock");
  const launchHandle = await acquireLaunchLock(launchLockPath);
  if (!launchHandle) return waitForService(deadline);
  try {
    record = await existing();
    if (record) return record;
    // A direct service start or another launcher may have won the service
    // lock between the checks. Wait for it rather than spawning another child.
    if (await fileExists(serviceLockPath)) {
      const running = await waitForServiceOrStaleLock(
        deadline,
        serviceLockPath,
      );
      if (running) return running;
      // A stale lock is left for service.mjs to repair atomically when it
      // acquires the service lock; this launcher never removes it directly.
    }
    const log = await open(join(dataDir(), "service.log"), "a", 0o600);
    try {
      const child = spawn(process.execPath, [join(dir, "service.mjs")], {
        stdio: ["ignore", log.fd, log.fd],
        detached: true,
        env: process.env,
      });
      child.on("error", () => {});
      child.unref();
    } finally {
      await log.close();
    }
    return waitForService(deadline);
  } finally {
    await releaseLaunchLock(launchLockPath, launchHandle);
  }
}

let sharedEnsure = null;
export async function ensureService() {
  if (!sharedEnsure)
    sharedEnsure = ensureServiceInternal().finally(() => {
      sharedEnsure = null;
    });
  return sharedEnsure;
}

export async function localSnapshot() {
  const record = await ensureService();
  const response = await fetch(`http://127.0.0.1:${record.port}/api/snapshot`, {
    headers: { "X-Quota-Token": record.token },
    signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error("Local monitor unavailable");
  return response.json();
}

export async function launch({ openBrowser = false, compact = false } = {}) {
  const record = await ensureService();
  const url = `http://127.0.0.1:${record.port}/${compact ? "?compact=1" : ""}#${record.token}`;
  if (openBrowser) {
    const command =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "explorer.exe"
          : "xdg-open";
    spawn(command, [url], { stdio: "ignore" }).on("error", () => {});
  }
  return { url, version: "0.2.0", mode: "live", dataSchema: 2 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(
    JSON.stringify(
      await launch({
        openBrowser: !process.argv.includes("--no-open"),
        compact: process.argv.includes("--compact"),
      }),
    ),
  );
}
