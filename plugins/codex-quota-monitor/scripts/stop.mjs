import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const dir =
  process.env.CODEX_QUOTA_MONITOR_DATA_DIR ||
  join(homedir(), ".local", "share", "codex-quota-monitor-v2");
try {
  const runtime = JSON.parse(await readFile(join(dir, "runtime.json"), "utf8"));
  const health = await fetch(`http://127.0.0.1:${runtime.port}/api/health`, {
    headers: { "X-Quota-Token": runtime.token },
    signal: AbortSignal.timeout(1500),
  });
  const data = await health.json();
  if (
    !health.ok ||
    data.app !== "codex-quota-monitor" ||
    data.pid !== runtime.pid ||
    !Number.isInteger(runtime.pid) ||
    runtime.pid <= 0
  )
    throw new Error("Service identity could not be verified");
  process.kill(runtime.pid, "SIGTERM");
  console.log("Requested shutdown of the verified quota monitor.");
} catch (error) {
  console.error("No verified running monitor: " + error.message);
  process.exitCode = 1;
}
