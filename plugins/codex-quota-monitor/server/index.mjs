// Fast MCP facade: starting/opening never waits for quota network requests.
import { createInterface } from "node:readline";
import { launch, localSnapshot } from "./launcher.mjs";
const tools = [
  {
    name: "open_quota_monitor",
    description:
      "Open the local Codex quota monitor. Per-session quota is explicitly estimated. Return its URL and use open_in_codex browser panel. Does not wait for upstream quota reads.",
    inputSchema: {
      type: "object",
      properties: { compact: { type: "boolean" } },
      additionalProperties: false,
    },
  },
  {
    name: "get_quota_snapshot",
    description:
      "Read cached quota and session estimates, with method, confidence and data freshness.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "diagnose_quota_monitor",
    description:
      "Read monitor health and feature limitations without modifying Codex.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];
function send(x) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...x }) + "\n");
}
async function handle(m) {
  if (m.id == null) return;
  try {
    let result;
    if (m.method === "initialize")
      result = {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "codex-quota-monitor", version: "0.2.0" },
        capabilities: { tools: {} },
      };
    else if (m.method === "ping") result = {};
    else if (m.method === "tools/list") result = { tools };
    else if (m.method === "resources/list") result = { resources: [] };
    else if (m.method === "prompts/list") result = { prompts: [] };
    else if (m.method === "tools/call") {
      const name = m.params?.name;
      let value;
      if (name === "open_quota_monitor")
        value = await launch({ compact: !!m.params.arguments?.compact });
      else if (name === "get_quota_snapshot") value = await localSnapshot();
      else if (name === "diagnose_quota_monitor") {
        const s = await localSnapshot();
        value = {
          version: s.version,
          capabilities: s.capabilities,
          diagnostics: s.diagnostics,
          accountError: s.account.error,
          cost: s.cost,
          settings: s.settings,
        };
      } else throw new Error("Unknown tool");
      result = { content: [{ type: "text", text: JSON.stringify(value) }] };
    } else
      return send({
        id: m.id,
        error: { code: -32601, message: "Method not found" },
      });
    send({ id: m.id, result });
  } catch (e) {
    if (m.method === "tools/call")
      send({
        id: m.id,
        result: {
          isError: true,
          content: [{ type: "text", text: String(e.message).slice(0, 500) }],
        },
      });
    else
      send({
        id: m.id,
        error: { code: -32603, message: "Monitor request failed" },
      });
  }
}
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line.length > 65536) return;
  try {
    void handle(JSON.parse(line));
  } catch {
    send({ id: null, error: { code: -32700, message: "Parse error" } });
  }
});
