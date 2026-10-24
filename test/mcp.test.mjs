/**
 * MCP 协议层测试：不碰网络，只验证 JSON-RPC 会话、工具注册与错误处理。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 起一个 server.mjs 子进程，返回 {call, close} */
async function startServer() {
  const child = spawn(process.execPath, [join(ROOT, "server.mjs")], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  let seq = 0;
  const pending = new Map();

  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const resolver = pending.get(msg.id);
      if (resolver) { pending.delete(msg.id); resolver(msg); }
    }
  });

  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`超时：${method}`)); }, 10000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  return { call, close: () => child.kill() };
}

test("MCP：initialize 返回服务器信息与版本 3.x", async () => {
  const srv = await startServer();
  try {
    const r = await srv.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    assert.equal(r.result.serverInfo.name, "xiumi-connector");
    assert.match(r.result.serverInfo.version, /^3\./);
    assert.ok(r.result.capabilities.tools);
  } finally {
    srv.close();
  }
});

test("MCP：tools/list 注册 34 个工具且结构完整", async () => {
  const srv = await startServer();
  try {
    const r = await srv.call("tools/list", {});
    const tools = r.result.tools;
    assert.equal(tools.length, 34);

    for (const t of tools) {
      assert.ok(t.name.startsWith("xiumi_"), `工具名应以 xiumi_ 开头：${t.name}`);
      assert.ok(typeof t.description === "string" && t.description.length > 5, `${t.name} 缺描述`);
      assert.equal(t.inputSchema?.type, "object", `${t.name} inputSchema 应为 object`);
    }
    const names = tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, "工具名不能重复");
  } finally {
    srv.close();
  }
});

test("MCP：新增的采集/加工工具都在", async () => {
  const srv = await startServer();
  try {
    const r = await srv.call("tools/list", {});
    const names = new Set(r.result.tools.map((t) => t.name));
    for (const need of [
      "xiumi_market_categories", "xiumi_market_search", "xiumi_market_hot",
      "xiumi_template_inspect", "xiumi_template_grab",
      "xiumi_steal", "xiumi_steal_batch",
      "xiumi_retheme", "xiumi_replace_images", "xiumi_export",
      "xiumi_snapshot", "xiumi_restore",
    ]) {
      assert.ok(names.has(need), `缺少工具：${need}`);
    }
  } finally {
    srv.close();
  }
});

test("MCP：未知方法返回 -32601", async () => {
  const srv = await startServer();
  try {
    const r = await srv.call("no/such/method", {});
    assert.equal(r.error.code, -32601);
  } finally {
    srv.close();
  }
});

test("MCP：未知工具返回 -32602", async () => {
  const srv = await startServer();
  try {
    const r = await srv.call("tools/call", { name: "xiumi_not_exist", arguments: {} });
    assert.equal(r.error.code, -32602);
  } finally {
    srv.close();
  }
});

test("MCP：工具参数缺失时返回可读错误而不是崩溃", async () => {
  const srv = await startServer();
  try {
    const r = await srv.call("tools/call", { name: "xiumi_retheme", arguments: {} });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /show_id/);

    const r2 = await srv.call("tools/call", { name: "xiumi_template_grab", arguments: {} });
    assert.equal(r2.result.isError, true);
    assert.match(r2.result.content[0].text, /target/);
  } finally {
    srv.close();
  }
});
