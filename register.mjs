#!/usr/bin/env node
/**
 * 把本连接器注册进 WorkBuddy 的 MCP 配置。
 *
 * 关键点：**合并而非覆盖**。老版本 installer 直接重写 mcp.json，
 * 会把用户已经配好的其它 MCP 服务器全部清掉。
 *
 * 用法：
 *   node register.mjs                       # 用当前目录 + 当前 node
 *   node register.mjs --name xiumi-dev      # 换个服务器名
 *   node register.mjs --config <path>       # 指定 mcp.json 路径
 *   node register.mjs --dry                 # 只打印结果不写盘
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) out[k] = true;
    else { out[k] = v; i++; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const name = args.name || "xiumi";
const dir = resolve(args.dir || HERE);
const nodeExe = args.node || process.execPath;
const configPath = resolve(
  args.config || join(process.env.WORKBUDDY_HOME || join(homedir(), ".workbuddy"), "mcp.json")
);

if (!existsSync(join(dir, "server.mjs"))) {
  console.error(`✗ 目标目录里没有 server.mjs：${dir}`);
  process.exit(1);
}

let config = {};
if (existsSync(configPath)) {
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    console.error(`✗ 现有配置不是合法 JSON，已中止以免误删：${configPath}\n  ${e.message}`);
    process.exit(1);
  }
}
if (!config || typeof config !== "object" || Array.isArray(config)) config = {};
if (!config.mcpServers || typeof config.mcpServers !== "object") config.mcpServers = {};

const before = Object.keys(config.mcpServers);
const existed = Boolean(config.mcpServers[name]);
config.mcpServers[name] = { command: nodeExe, args: [join(dir, "server.mjs")] };

const text = JSON.stringify(config, null, 2) + "\n";
if (args.dry) {
  console.log(`[dry] ${configPath}\n${text}`);
  process.exit(0);
}

mkdirSync(dirname(configPath), { recursive: true });
if (existsSync(configPath)) copyFileSync(configPath, configPath + ".bak");
writeFileSync(configPath, text, "utf8");

console.log(`✓ 已${existed ? "更新" : "写入"} MCP 配置：${configPath}`);
console.log(`  服务器名  ${name}`);
console.log(`  启动命令  ${nodeExe} ${join(dir, "server.mjs")}`);
if (before.length) {
  const others = before.filter((n) => n !== name);
  if (others.length) console.log(`  已保留原有 ${others.length} 个服务器：${others.join(", ")}`);
}
console.log(`  原配置备份 → ${configPath}.bak`);
console.log(`\n下一步：在 WorkBuddy 的连接器页面找到「${name}」并点击 Trust 启用。`);
