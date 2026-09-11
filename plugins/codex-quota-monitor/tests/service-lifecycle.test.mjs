import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireServiceLock,
  SERVICE_LOCK_STALE_MS,
  startService,
} from "../server/service.mjs";
import { acquireLaunchLock, releaseLaunchLock } from "../server/launcher.mjs";

function makeCollector({ init, snapshot, close } = {}) {
  return {
    init: init || (async () => {}),
    snapshot:
      snapshot ||
      (() => ({ version: "0.2.0", account: { windows: [] }, sessions: [] })),
    close: close || (async () => {}),
    update: async () => ({}),
    restoreDefaults: async () => ({}),
  };
}

async function missing(pathname) {
  await assert.rejects(stat(pathname), (error) => error?.code === "ENOENT");
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("runtime is published only after collector initialization completes", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "quota-service-ready-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let releaseInit;
  const initDone = new Promise((resolve) => {
    releaseInit = resolve;
  });
  const collector = makeCollector({ init: () => initDone });
  const starting = startService({ dataDir, collector });
  await new Promise((resolve) => setImmediate(resolve));
  await missing(path.join(dataDir, "runtime.json"));
  releaseInit();
  const service = await starting;
  t.after(() => service.close().catch(() => {}));

  const runtime = JSON.parse(
    await readFile(path.join(dataDir, "runtime.json"), "utf8"),
  );
  assert.equal(runtime.pid, process.pid);
  assert.equal(runtime.port, service.port);
  const health = await fetch(`http://127.0.0.1:${service.port}/api/health`, {
    headers: {
      host: `127.0.0.1:${service.port}`,
      "x-quota-token": service.token,
    },
  });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    app: "codex-quota-monitor",
    version: "0.2.0",
    mode: "live",
    dataSchema: 2,
    ready: true,
    pid: process.pid,
  });

  await service.close();
  await missing(path.join(dataDir, "runtime.json"));
  await missing(path.join(dataDir, "service.lock"));
});

test("collector initialization failure cleans its lock and closes the collector", async (t) => {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "quota-service-init-failure-"),
  );
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let closed = 0;
  const collector = makeCollector({
    init: async () => {
      throw new Error("synthetic init failure");
    },
    close: async () => {
      closed += 1;
    },
  });
  await assert.rejects(
    startService({ dataDir, collector }),
    /synthetic init failure/,
  );
  assert.equal(closed, 1);
  await missing(path.join(dataDir, "runtime.json"));
  await missing(path.join(dataDir, "service.lock"));
});

test("listener failure cleans its lock and closes the collector", async (t) => {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "quota-service-listen-failure-"),
  );
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const blocker = createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => closeServer(blocker).catch(() => {}));
  const blockedPort = blocker.address().port;
  let closed = 0;
  const collector = makeCollector({
    close: async () => {
      closed += 1;
    },
  });
  await assert.rejects(
    startService({ dataDir, collector, listenPort: blockedPort }),
    (error) => error?.code === "EADDRINUSE",
  );
  assert.equal(closed, 1);
  await missing(path.join(dataDir, "runtime.json"));
  await missing(path.join(dataDir, "service.lock"));
});

test("fresh corrupt service locks are preserved, while stale corrupt locks can be repaired", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "quota-service-lock-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const lockPath = path.join(dataDir, "service.lock");
  await (await import("node:fs/promises")).writeFile(lockPath, "");
  await assert.rejects(
    startService({ dataDir, collector: makeCollector() }),
    /startup lock held/,
  );
  assert.equal(await readFile(lockPath, "utf8"), "");

  const stale = (Date.now() - SERVICE_LOCK_STALE_MS - 1_000) / 1000;
  await utimes(lockPath, stale, stale);
  await (await import("node:fs/promises")).writeFile(lockPath, "not-a-pid");
  await utimes(lockPath, stale, stale);
  const service = await startService({ dataDir, collector: makeCollector() });
  await service.close();
  await missing(lockPath);
});

test("concurrent service starts share one singleton and loser does not initialize", async (t) => {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "quota-service-singleton-"),
  );
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let initCalls = 0;
  const collectorOne = makeCollector({
    init: async () => {
      initCalls += 1;
    },
  });
  const collectorTwo = makeCollector({
    init: async () => {
      initCalls += 1;
    },
  });
  const results = await Promise.allSettled([
    startService({ dataDir, collector: collectorOne }),
    startService({ dataDir, collector: collectorTwo }),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /already running|startup lock held/);
  assert.equal(initCalls, 1);
  const service = fulfilled[0].value;
  await service.close();
  await missing(path.join(dataDir, "runtime.json"));
  await missing(path.join(dataDir, "service.lock"));
});

test("close waits for and terminates open loopback connections", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "quota-service-close-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = await startService({ dataDir, collector: makeCollector() });
  const socket = net.createConnection({
    host: "127.0.0.1",
    port: service.port,
  });
  socket.on("error", () => {});
  await once(socket, "connect");
  const socketClosed = new Promise((resolve) => socket.once("close", resolve));
  await service.close();
  await Promise.race([
    socketClosed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("socket was not closed")), 1_000),
    ),
  ]);
  socket.destroy();
  await missing(path.join(dataDir, "runtime.json"));
  await missing(path.join(dataDir, "service.lock"));
});

test("concurrent launch locks allow one starter and preserve a fresh lock", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "quota-launch-lock-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const lockPath = path.join(dataDir, "launcher.lock");
  const first = await acquireLaunchLock(lockPath);
  assert.ok(first);
  const second = await acquireLaunchLock(lockPath);
  assert.equal(second, null);
  assert.equal((await readFile(lockPath, "utf8")).trim(), String(process.pid));
  await releaseLaunchLock(lockPath, first);
  await missing(lockPath);
});

test("acquireServiceLock can repair a stale dead-owner lock", async (t) => {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "quota-service-dead-lock-"),
  );
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const lockPath = path.join(dataDir, "service.lock");
  const fs = await import("node:fs/promises");
  await fs.writeFile(lockPath, "999999999\n");
  const stale = (Date.now() - SERVICE_LOCK_STALE_MS - 1_000) / 1000;
  await fs.utimes(lockPath, stale, stale);
  const handle = await acquireServiceLock(lockPath);
  assert.equal((await readFile(lockPath, "utf8")).trim(), String(process.pid));
  await handle.close();
  await fs.unlink(lockPath);
});

test('dashboard asset check rejects an API-only server returning a file error page',async(t)=>{
  const {verifyDashboard}=await import('../server/launcher.mjs');
  const server=createServer((req,res)=>{
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(req.url==='/api/health'?{app:'codex-quota-monitor',ready:true}:{error:'EPERM'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>closeServer(server));
  await assert.rejects(verifyDashboard({port:server.address().port}),/网页未通过检查/);
});

test('ready service delivers the full page and its JavaScript module dependency',async(t)=>{
  const {verifyDashboard}=await import('../server/launcher.mjs');
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'quota-assets-'));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const service=await startService({dataDir,collector:makeCollector()});
  t.after(()=>service.close());
  await verifyDashboard(service);
  const module=await fetch(`http://127.0.0.1:${service.port}/dashboard-utils.mjs`);
  assert.match(module.headers.get('content-type'),/javascript/);
  assert.match(await module.text(),/resetDeadline/);
});
