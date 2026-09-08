import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const indexPath = path.join(pluginRoot, "server", "index.mjs");

async function startFacade() {
  const child = spawn(process.execPath, [indexPath], {
    cwd: pluginRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const messages = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) messages.push(JSON.parse(line));
    }
  });
  const request = (id, method, params = {}) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`request ${id} timed out`)), 3000);
      const poll = () => {
        const index = messages.findIndex((message) => message.id === id);
        if (index >= 0) {
          clearTimeout(timer);
          resolve(messages.splice(index, 1)[0]);
        } else setImmediate(poll);
      };
      poll();
    });
  };
  return {
    request,
    async close() {
      child.stdin.end();
      await once(child, "exit");
    },
  };
}

test("open tool advertises exact-link and structured-output requirements without starting the service", async () => {
  const facade = await startFacade();
  try {
    const initialized = await facade.request(1, "initialize");
    assert.match(initialized.result.instructions, /result\.url/);
    assert.match(initialized.result.instructions, /Markdown/);
    assert.match(initialized.result.instructions, /bookmark/);

    const listed = await facade.request(2, "tools/list");
    const open = listed.result.tools.find((tool) => tool.name === "open_quota_monitor");
    assert.ok(open);
    assert.match(open.description, /exact local URL/);
    assert.match(open.description, /clickable Markdown link/);
    assert.equal(open.outputSchema.properties.url.type, "string");
    assert.deepEqual(open.outputSchema.required, ["url", "version", "mode", "dataSchema"]);
    assert.equal(open.annotations.readOnlyHint, false);
  } finally {
    await facade.close();
  }
});
