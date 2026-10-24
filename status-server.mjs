#!/usr/bin/env node
/**
 * 秀米 XIUMI 连接器 · 状态窗口（本地网页，零依赖）
 *
 * 启动一个只监听 127.0.0.1 的小服务，浏览器打开后可以：
 *   · 一眼看到连接状态：Node 版本 / 会话 / 账号 / 作品数 / 网络连通
 *   · 粘贴 Cookie 一键登录（不用记命令）
 *   · 一键打开秀米编辑器 / 作品列表
 *
 * 用法：node status-server.mjs [--port 47820] [--no-open]
 *       一般由 状态窗口.cmd 调用。
 */

import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE, ROOT, loadSession, saveSession, refreshAccount, sessionSid,
  apiRequest, request, AuthError,
} from "./xiumi-core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PORT = Number(argOf("--port", "47820"));
const NO_OPEN = argv.includes("--no-open");

const log = console.log;
const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
};

/* ---------------- 状态收集 ---------------- */

async function collectStatus() {
  const session = loadSession();
  const st = {
    node: process.version,
    platform: process.platform,
    loggedIn: false,
    account: null,
    showCount: null,
    checks: { session: false, account: false, shows: false, cdn: false },
    errors: {},
  };

  // 会话文件
  if (session?.cookie) {
    st.checks.session = true;
    st.savedAt = session.savedAt ?? null;
  } else {
    st.errors.session = "尚未登录（无 Cookie）";
  }

  // 账号连通
  try {
    const u = await refreshAccount();
    st.loggedIn = true;
    st.checks.account = true;
    st.account = {
      nickname: u.nickname ?? null,
      user_sid: u.user_sid ?? null,
      unique_uid: u.unique_uid ?? null,
    };
    st.editorUrl = `${BASE}/studio/v5#/paper`;
  } catch (e) {
    st.errors.account = e instanceof AuthError ? "会话已失效，请重新登录" : String(e.message ?? e);
  }

  // 作品数
  if (st.loggedIn) {
    try {
      const r = await apiRequest("/api/shows", { query: { page: 1, count: 1 } });
      st.checks.shows = r.status < 400;
      const list = r.json?.data ?? [];
      st.showCount = Array.isArray(list) ? list.length : 0;
      // 拉一页拿总数（接口通常返回 total）
      st.showTotal = r.json?.total ?? r.json?.count ?? null;
    } catch (e) {
      st.errors.shows = String(e.message ?? e);
    }
  }

  // CDN 连通（403 也说明网络可达）
  try {
    const r = await request("https://sd.xiumius.cn/");
    st.checks.cdn = r.status < 500;
  } catch (e) {
    st.errors.cdn = String(e.message ?? e);
  }

  return st;
}

/* ---------------- HTTP 处理 ---------------- */

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  try {
    // 静态页
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      const htmlPath = join(__dirname, "status.html");
      if (!existsSync(htmlPath)) { res.writeHead(500); res.end("status.html 缺失"); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(readFileSync(htmlPath));
      return;
    }

    // 状态
    if (req.method === "GET" && path === "/api/status") {
      const st = await collectStatus();
      return json(res, 200, st);
    }

    // 登录
    if (req.method === "POST" && path === "/api/login") {
      let raw;
      try {
        const body = JSON.parse(await readBody(req) || "{}");
        raw = body.cookie;
      } catch { return json(res, 400, { ok: false, error: "请求格式错误" }); }

      let cleaned = String(raw ?? "").replace(/^\s*cookie\s*:\s*/i, "").replace(/\s*\r?\n\s*/g, " ").trim();
      if (!cleaned) return json(res, 400, { ok: false, error: "请先粘贴 Cookie" });

      const prev = loadSession() ?? {};
      // 备份旧会话，登录失败可回滚
      const backup = prev.cookie ? { ...prev } : null;
      saveSession({ ...prev, cookie: cleaned, savedAt: new Date().toISOString() });

      try {
        const u = await refreshAccount();
        return json(res, 200, {
          ok: true,
          account: { nickname: u.nickname ?? null, user_sid: u.user_sid ?? null, unique_uid: u.unique_uid ?? null },
        });
      } catch (e) {
        // 回滚
        if (backup) saveSession(backup);
        else saveSession({ ...prev, cookie: undefined, savedAt: undefined });
        const msg = e instanceof AuthError ? "Cookie 无效或已过期，请重新复制" : String(e.message ?? e);
        return json(res, 200, { ok: false, error: msg });
      }
    }

    // 退出登录（清 Cookie）
    if (req.method === "POST" && path === "/api/logout") {
      const prev = loadSession() ?? {};
      saveSession({ ...prev, cookie: undefined, savedAt: undefined });
      return json(res, 200, { ok: true });
    }

    // 打开外部链接（仅放行秀米官方域）
    if (req.method === "POST" && path === "/api/open") {
      let target;
      try {
        const body = JSON.parse(await readBody(req) || "{}");
        target = String(body.url ?? "");
      } catch { return json(res, 400, { ok: false, error: "请求格式错误" }); }
      if (!isXiumiUrl(target)) {
        return json(res, 400, { ok: false, error: "只允许打开秀米官方链接" });
      }
      openBrowser(target);
      return json(res, 200, { ok: true });
    }

    json(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    json(res, 500, { ok: false, error: String(e.message ?? e) });
  }
});

/* ---------------- 链接白名单 ----------------
 * 只允许打开秀米官方域（含所有子域），放行 http/https。
 * 秀米实际用到两个域名：xiumi.us（主站）与 xiumius.cn（内容/CDN、移动预览）。
 * 用 URL 解析 + 精确后缀匹配，避免旧正则漏掉"无路径"的首页、误判 xiumius.cn。 */
const XIUMI_HOSTS = ["xiumi.us", "xiumius.cn"];
export function isXiumiUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase();
  return XIUMI_HOSTS.some((d) => host === d || host.endsWith("." + d));
}

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      // 用 cmd 的 start 打开默认浏览器；url 已被白名单约束
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch { /* 忽略 */ }
}

/* ---------------- 启动 ---------------- */

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    log(C.bad(`✗ 端口 ${PORT} 已被占用。换一个：node status-server.mjs --port 47821`));
  } else {
    log(C.bad("✗ 启动失败：" + e.message));
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}/`;
  log("");
  log(C.b("  秀米连接器 · 状态窗口已启动"));
  log(C.dim(`  地址  ${url}`));
  log(C.dim("  关闭本窗口即停止服务（或按 Ctrl+C）"));
  log("");
  if (!NO_OPEN) openBrowser(url);
});

// 窗口被关掉/收到中断时优雅退出
process.on("SIGINT", () => { log(C.dim("\n已停止。")); process.exit(0); });
