#!/usr/bin/env node
/**
 * 秀米连接器 · 一键命令行工具
 *
 * 用法：xiumi <命令> [参数]  （Windows 直接点 xiumi.cmd）
 *
 *   status                      打开可视化状态窗口（推荐：看状态 / 一键登录）
 *   login --file cookie.txt     注入浏览器 Cookie 并校验（命令行方式，免转义）
 *   login --stdin               从标准输入读取 Cookie
 *   login "<Cookie>"            直接传字符串（%% & 需转义）
 *   whoami                      查看当前账号
 *   list [page] [count]         列出我的作品
 *   outline <showId>            查看作品内容大纲
 *   pull <showId> [文件]        拉取内容树 JSON
 *   new "<标题>" [文件]         新建草稿（文件为 blocks JSON，可选）
 *   push <showId> [文件]        写入/更新内容树（文件为完整 JSON；省略则重算渲染缓存）
 *   patch <showId> <补丁文件>   批量文本替换（[{from,to,expect}]）
 *   validate <showId | 文件>    校验内容树
 *   publish <showId>            发布：定稿回写 + 预览链接 + 本地快照
 *   copy <showId> ["新标题"]    复制作品到自己账号
 *   delete <showId> --yes       删除作品
 *   doctor                      环境自检（会话 / 网络 / 目录）
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import {
  OUT_DIR, LIB_DIR, BASE, loadSession, saveSession, refreshAccount, sessionSid,
  apiRequest, request, compressToBase64, buildUpdatePayload, copyToken,
  makeBlankShowData, makeText, makeImage, makeRow, mainLayer,
  fetchShowData, summarizeShowData, validateShowData, rebuildRaHtml,
  walkItems, replaceExact, NOT_LOGIN_HINT, isAuthFailure,
} from "./xiumi-core.mjs";
import {
  marketTags, marketSearch, marketHot, grabTemplate, inspectTemplate,
  parseShowTarget, htmlToMarkdown, htmlToText, wrapStandaloneHtml, MARKET_BOARD_SID,
} from "./xiumi-market.mjs";
import {
  retheme, replaceImages, listImages, palette,
  saveSnapshot, listSnapshots, loadSnapshot,
} from "./xiumi-transform.mjs";

/* ---------------- Windows 控制台编码修正 ----------------
 * 中文 Windows 控制台默认是 GBK(936)，而 Node 输出 UTF-8，
 * 不处理会导致中文变乱码。这里强制切到 UTF-8 并重设标准流编码。
 * 仅对真实终端生效；被重定向到文件/管道时跳过，避免污染输出。 */
if (process.platform === "win32" && process.stdout.isTTY) {
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("chcp.com", ["65001"], { stdio: "ignore" });
  } catch { /* 忽略：拿不到 chcp 也不影响功能 */ }
  try {
    process.stdout.setDefaultEncoding?.("utf8");
    process.stderr.setDefaultEncoding?.("utf8");
  } catch { /* 忽略 */ }
}

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};
const log = console.log;
class CliError extends Error {}
const die = (msg) => { throw new CliError(msg); };
const need = (cond, msg) => { if (!cond) die(msg); };
/** 顶层入口：捕获 CliError / AuthError 并友好退出 */
async function guard(fn) {
  try { return await fn(); }
  catch (e) {
    if (e instanceof CliError || e?.expected) { log(C.bad("✗ " + e.message)); process.exit(1); }
    log(C.bad("✗ 意外错误：" + (e?.stack || e?.message || e)));
    process.exit(1);
  }
}

/* ---------------- 参数辅助 ---------------- */

function absPath(p) {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

function readJsonFile(p, label) {
  const f = absPath(p);
  need(existsSync(f), `${label}文件不存在：${f}`);
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch (e) {
    die(`${label}文件 JSON 解析失败：${e.message}`);
  }
}

/** 把简化 blocks 描述转为组件（与 MCP 端一致） */
function buildBlock(b) {
  const type = String(b.type ?? "text").toLowerCase();
  if (type === "text" || type === "html") return makeText(b.html ?? b.text ?? "", b.style ?? {}, b.comp_style ?? {});
  if (type === "image" || type === "img") return makeImage(b.src ?? b.url, b.style ?? {}, { resize: b.resize ?? "h" });
  if (type === "row" || type === "cols") {
    const cols = (b.cols ?? []).map((c) => (Array.isArray(c) ? c.map(buildBlock) : [buildBlock(c)]));
    return makeRow(cols, { style: b.style ?? {} });
  }
  if (type === "raw") return b.value;
  die(`未知块类型：${type}（可用 text / image / row / raw）`);
}

/** 校验并提交内容树 */
async function putShowData(showId, showData, savedAt, label = "写入内容") {
  const problems = validateShowData(showData);
  if (problems.length) die(`${label}前校验未通过：\n  - ` + problems.join("\n  - "));
  const up = await apiRequest(`/api/shows/${showId}`, { method: "PUT", body: buildUpdatePayload(showData, savedAt) });
  if (isAuthFailure(up)) die("会话已失效。\n" + NOT_LOGIN_HINT);
  if (up.status >= 400) die(`${label}失败 [${up.status}] ${up.json?.message ?? up.text.slice(0, 200)}`);
  return up;
}

const editUrl = (id) => `${BASE}/studio/v5#/paper/for/${id}`;
const previewUrl = (id) => {
  const sid = sessionSid();
  return sid ? `https://v.xiumius.cn/board/v5/${sid}/${id}` : null;
};
function printLinks(id) {
  log(`  编辑地址  ${C.b(editUrl(id))}`);
  const p = previewUrl(id);
  if (p) log(`  手机预览  ${p}`);
}

/* ---------------- 命令实现 ---------------- */

const CMDS = {};

/** 按终端显示宽度补空格（中日韩字符占 2 列） */
function padEndW(s, width) {
  const str = String(s ?? "");
  let w = 0;
  for (const ch of str) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return str + " ".repeat(Math.max(0, width - w));
}

CMDS.help = {
  desc: "显示帮助",
  run() {
    log(C.b("\n秀米连接器 · 一键命令行\n"));
    log("用法： xiumi <命令> [参数]\n");
    const rows = [
      ["status", "★ 打开可视化状态窗口（推荐，一键登录/看状态）"],
      ["login --file cookie.txt", "注入 Cookie（命令行方式，免转义）"],
      ["whoami", "查看当前登录账号"],
      ["doctor", "环境自检（会话/网络/目录）"],
      ["", ""],
      ["market [关键词] --tag 节假", "★ 搜索模板市场（--sort copy/collect/hit/new）"],
      ["hot --metric copy", "★ 市场热门榜"],
      ["inspect <ID|链接>", "★ 模板体检（免登录：规模/主色/字数）"],
      ["grab <ID|链接> --md", "★ 抓成品（免登录：内容树+HTML+md）"],
      ["steal <ID|关键词>", "★ 一键搬到自己账号（可 --patch 改文案）"],
      ["steal-batch --keyword 国庆", "批量搬（--limit 5）"],
      ["", ""],
      ["retheme <ID> --map \"#旧=#新\"", "★ 一键换配色（--show 先看色板）"],
      ["images <ID>", "列出作品里的图片"],
      ["reimg <ID> --index \"2=URL\"", "批量换图（--src 按 URL 片段）"],
      ["export <ID|链接> --md", "导出 html / md / txt"],
      ["snap <ID> [list|restore 0]", "版本快照 / 回滚"],
      ["", ""],
      ["list [页] [每页数]", "列出我的作品"],
      ["outline <作品ID>", "查看作品内容大纲（组件路径 + 文本摘要）"],
      ["pull <作品ID> [文件]", "拉取完整内容树 JSON 到本地"],
      ["new \"<标题>\" [blocks文件]", "新建草稿（可选 blocks 内容）"],
      ["push <作品ID> [JSON文件]", "写入内容树（省略文件则仅重算渲染缓存）"],
      ["patch <作品ID> <补丁文件>", "批量文本替换 [{from,to,expect}]"],
      ["validate <作品ID|文件>", "校验内容树结构 + HTML 标签平衡"],
      ["publish <作品ID>", "发布：定稿回写 + 预览链接 + 本地快照"],
      ["copy <作品ID> [\"新标题\"]", "复制作品到自己账号（含市场模板）"],
      ["delete <作品ID> --yes", "删除作品（不可恢复）"],
    ];
    for (const [c, d] of rows) log(c ? `  ${padEndW(c, 36)} ${C.dim(d)}` : "");
    log(C.dim("\n示例：xiumi market 重阳 --sort copy   →   xiumi steal <ID>   →   xiumi retheme <新ID> --show\n"));
  },
};

const LOGIN_USAGE = [
  "用法（三选一）：",
  '  A) 推荐：xiumi login --file cookie.txt    从文件读取（免转义，最稳）',
  '  B)      xiumi login --stdin                从标准输入管道读取',
  '  C)      xiumi login "<Cookie>"             直接传字符串（注意 %% 与 & 需转义）',
  "",
  "Cookie 获取：浏览器打开 https://xiumi.us 登录 → F12 → Network → 刷新 →",
  "点任意 xiumi.us 请求 → Request Headers → 复制整串 Cookie 值。",
].join("\n");

CMDS.login = {
  desc: "注入 Cookie",
  async run(argv) {
    const args = (argv ?? []).filter((a) => a !== undefined && a !== "");
    let raw = null;

    if (args[0] === "--file" || args[0] === "-f") {
      const f = args[1];
      need(f, "用法：xiumi login --file <含 Cookie 的文本文件>");
      const p = absPath(f);
      need(existsSync(p), `文件不存在：${p}`);
      raw = readFileSync(p, "utf8");
    } else if (args[0] === "--stdin") {
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      raw = Buffer.concat(chunks).toString("utf8");
    } else {
      raw = args.join(" ");
    }

    let cleaned = String(raw ?? "").replace(/^\s*cookie\s*:\s*/i, "").trim();
    // 文件/管道里常带换行，压成单行
    cleaned = cleaned.replace(/\s*\r?\n\s*/g, " ").trim();

    need(cleaned, LOGIN_USAGE);

    const prev = loadSession() ?? {};
    saveSession({ ...prev, cookie: cleaned, savedAt: new Date().toISOString() });
    log(C.dim(`  已写入 Cookie（${cleaned.length} 字符），正在校验…`));

    let u;
    try {
      u = await refreshAccount();
    } catch (e) {
      log(C.bad("✗ 校验失败：" + e.message));
      log("");
      log(C.warn("Cookie 已写入会话文件，但账号校验未通过。常见原因："));
      log("  · Cookie 复制不完整（应含 sid=… 字段，通常 200+ 字符）");
      log("  · Cookie 已过期（重新登录后再复制）");
      log("  · 直接传字符串时被 CMD 吃掉了 % & $ 等字符 → 改用 --file");
      log("");
      log(LOGIN_USAGE);
      process.exit(1);
    }

    log(C.ok("✓ 连接成功"));
    log(`  昵称      ${u.nickname}`);
    log(`  user_sid  ${u.user_sid}`);
    log(`  uid       ${u.unique_uid}`);
  },
};

CMDS.whoami = {
  desc: "查看账号",
  async run() {
    const u = await refreshAccount();
    log(C.ok("✓ 会话有效"));
    log(JSON.stringify({ 昵称: u.nickname, user_sid: u.user_sid, unique_uid: u.unique_uid, 手机: u.phone, 等级: u.level }, null, 2));
  },
};

CMDS.status = {
  desc: "打开可视化状态窗口",
  async run(args) {
    const { spawn } = await import("node:child_process");
    const { dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const child = spawn(process.execPath, [join(here, "status-server.mjs"), ...(args ?? [])], {
      detached: true, stdio: "ignore",
    });
    child.unref();
    log(C.ok("✓ 状态窗口已启动"));
    log(C.dim("  浏览器会自动打开 http://127.0.0.1:47820/"));
    log(C.dim("  （若未弹出，请手动访问该地址；关掉服务窗口即停止）"));
  },
};

CMDS.doctor = {
  desc: "环境自检",
  async run() {
    let pass = 0, fail = 0;
    const check = async (name, fn) => {
      try { const r = await fn(); log(`  ${C.ok("✓")} ${name}${r ? C.dim(" — " + r) : ""}`); pass++; }
      catch (e) { log(`  ${C.bad("✗")} ${name} — ${e.message}`); fail++; }
    };
    log(C.b("\n环境自检\n"));
    await check("Node 运行时", () => process.version);
    await check("会话文件", () => { const s = loadSession(); need(s?.cookie, "session.json 无 Cookie，请先登录（见下方说明）"); return `Cookie ${s.cookie.length} 字符`; });
    await check("账号连通", async () => { const u = await refreshAccount(); return `${u.nickname} / ${u.user_sid}`; });
    await check("作品接口", async () => { const r = await apiRequest("/api/shows", { query: { page: 1, count: 1 } }); need(r.status < 400, `HTTP ${r.status}`); return `共 ${r.json?.data?.length ?? 0} 条返回`; });
    await check("内容 CDN", async () => { const r = await request("https://sd.xiumius.cn/"); need(r.status < 500, `HTTP ${r.status}`); return `HTTP ${r.status}（403 属正常，仅表示目录不可列）`; });
    await check("输出目录", async () => { const { mkdirSync } = await import("node:fs"); mkdirSync(OUT_DIR, { recursive: true }); return OUT_DIR; });
    log(fail === 0 ? C.ok(`\n✓ 全部通过（${pass} 项）`) : C.bad(`\n✗ ${fail} 项失败，${pass} 项通过`));
    if (fail > 0) {
      log(C.dim("\n————————————————————————————————"));
      log(C.b("登录（推荐用 --file，免去 CMD 转义问题）"));
      log("  1. 浏览器打开 https://xiumi.us 登录");
      log("  2. F12 → Network → 刷新页面");
      log("  3. 点任意 xiumi.us 请求 → Request Headers → 复制整串 Cookie");
      log("  4. 粘贴到一个 txt 文件（例如 cookie.txt）");
      log("  5. 执行：xiumi login --file cookie.txt");
      log(C.dim("  （也可直接传字符串：xiumi login \"<Cookie>\"，但需注意 %% & 转义）"));
    }
    process.exit(fail === 0 ? 0 : 1);
  },
};

CMDS.list = {
  desc: "作品列表",
  async run([page = 1, count = 20]) {
    const r = await apiRequest("/api/shows", { query: { page, count } });
    if (isAuthFailure(r)) die("会话已失效。\n" + NOT_LOGIN_HINT);
    const list = r.json?.data ?? [];
    log(C.b(`\n我的作品（第 ${page} 页，${list.length} 个）\n`));
    list.forEach((s, i) => {
      log(`  ${String(i + 1).padStart(2)}. ${C.b(String(s.show_id))}  ${s.title ?? "(无标题)"}`);
      log(C.dim(`      更新 ${(s.updated_at ?? s.saved_at ?? "?").slice(0, 19)}`));
    });
  },
};

CMDS.outline = {
  desc: "内容大纲",
  async run([id]) {
    need(id, "用法：xiumi outline <作品ID>");
    const { show, showData, dataUrl } = await fetchShowData(id);
    const s = summarizeShowData(showData);
    log(C.b(`\n${show.title}  (${id})\n`));
    log(C.dim(`内容数据 ${dataUrl}`));
    printLinks(id);
    log(C.b(`\n共 ${s.itemCount} 个顶层组件：\n`));
    s.outline.forEach((l) => log("  " + l));
  },
};

CMDS.pull = {
  desc: "拉取内容树",
  async run([id, file]) {
    need(id, "用法：xiumi pull <作品ID> [输出文件]");
    const { show, showData, dataUrl } = await fetchShowData(id);
    const target = file ? absPath(file) : join(OUT_DIR, `show_${id}.json`);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(target, "..").replace(/[\\/][^\\/]*$/, ""), { recursive: true });
    writeFileSync(target, JSON.stringify(showData, null, 1), "utf8");
    log(C.ok(`✓ 已拉取「${show.title}」`));
    log(`  组件数    ${mainLayer(showData).comps.items.length}`);
    log(`  字符数    ${JSON.stringify(showData).length}`);
    log(`  内容数据  ${dataUrl}`);
    log(`  已保存    ${C.b(target)}`);
  },
};

CMDS.new = {
  desc: "新建草稿",
  async run([title, blocksFile]) {
    need(title, '用法：xiumi new "<标题>" [blocks.json]');
    const cr = await apiRequest("/api/shows/v5/paper", {
      method: "POST",
      body: { format: "0320cc2e241eb9af530b84dbe0b1cc65", encodedData: compressToBase64(JSON.stringify({ title, raw_info_only: true })) },
    });
    if (isAuthFailure(cr)) die("会话已失效。\n" + NOT_LOGIN_HINT);
    const show = cr.json?.data;
    need(show?.show_id, `新建失败：${JSON.stringify(cr.json).slice(0, 200)}`);
    const id = show.show_id;

    if (blocksFile) {
      const blocks = readJsonFile(blocksFile, "blocks");
      const arr = Array.isArray(blocks) ? blocks : blocks.blocks ?? [];
      const me = loadSession() ?? {};
      const sd = makeBlankShowData({ title, authorUid: me.uid, authorSid: me.sid });
      const layer = mainLayer(sd);
      arr.forEach((b) => layer.comps.items.push(buildBlock(b)));
      rebuildRaHtml(sd);
      await putShowData(id, sd, show.saved_at);
      log(C.ok(`✓ 草稿已创建并写入 ${layer.comps.items.length} 个组件`));
    } else {
      log(C.ok("✓ 空草稿已创建"));
      log(C.dim("  提示：带内容请提供 blocks json：xiumi new \"标题\" blocks.json"));
    }
    log(`  作品ID    ${C.b(String(id))}  「${show.title}」`);
    printLinks(id);
  },
};

CMDS.push = {
  desc: "写入内容树",
  async run([id, file]) {
    need(id, "用法：xiumi push <作品ID> [内容树JSON]");
    const { show, showData } = await fetchShowData(id);
    const next = file ? readJsonFile(file, "内容树") : showData;
    if (!file) log(C.dim("（未提供文件，仅重建渲染缓存并回写）"));
    rebuildRaHtml(next);
    await putShowData(id, next, show.saved_at);
    log(C.ok(`✓ 已写入作品 ${id}`));
    log(`  组件数    ${mainLayer(next).comps.items.length}`);
    printLinks(id);
  },
};

CMDS.patch = {
  desc: "批量替换",
  async run([id, patchFile]) {
    need(id && patchFile, "用法：xiumi patch <作品ID> <补丁.json>  补丁格式 [{from,to,expect}]");
    const rules = readJsonFile(patchFile, "补丁");
    const arr = Array.isArray(rules) ? rules : rules.replacements ?? [];
    need(arr.length, "补丁文件为空");
    const { show, showData } = await fetchShowData(id);
    const layer = mainLayer(showData);
    let total = 0;
    for (const r of arr) {
      let hit = 0;
      walkItems(layer, (item) => {
        const tk = Object.keys(item).find((k) => k !== "_comp" && item[k]?.type === "text");
        if (!tk) return;
        if (String(item[tk].text).includes(r.from)) {
          item[tk].text = replaceExact(item[tk].text, r.from, r.to ?? "", r.expect ?? 1, `patch:${String(r.from).slice(0, 24)}`);
          hit++;
        }
      });
      log(`  ${hit > 0 ? C.ok("✓") : C.warn("·")} "${String(r.from).slice(0, 40)}" → ${hit} 处`);
      total += hit;
    }
    if (!total) die("没有匹配到任何文本，未提交。请先用 outline 确认原文。");
    rebuildRaHtml(showData);
    await putShowData(id, showData, show.saved_at);
    log(C.ok(`\n✓ 共 ${total} 处改动已提交`));
    printLinks(id);
  },
};

CMDS.validate = {
  desc: "校验内容树",
  async run([target]) {
    need(target, "用法：xiumi validate <作品ID | JSON文件>");
    let data, label;
    if (/^\d+$/.test(target)) {
      ({ showData: data } = await fetchShowData(target));
      label = `作品 ${target}`;
    } else {
      data = readJsonFile(target, "内容树");
      label = absPath(target);
    }
    const problems = validateShowData(data);
    const layer = data?.cubes?.[0]?.pages?.[0]?.layers?.[0];
    const bal = [];
    if (layer) {
      walkItems(layer, (item, _l, _i, path) => {
        const tk = Object.keys(item).find((k) => k !== "_comp" && item[k]?.type === "text");
        if (!tk) return;
        const s = String(item[tk].text);
        const c = (re) => (s.match(re) || []).length;
        const pairs = [["section", c(/<section[\s>]/g) - c(/<\/section>/g)], ["div", c(/<div[\s>]/g) - c(/<\/div>/g)], ["p", c(/<p[\s>]/g) - c(/<\/p>/g)]];
        pairs.forEach(([t, v]) => { if (v !== 0) bal.push(`[${path}] <${t}> ${v > 0 ? "少" : "多"}闭合 ${Math.abs(v)} 个`); });
      });
    }
    log(C.b(`\n校验：${label}\n`));
    if (problems.length) { log(C.bad(`✗ 结构问题 ${problems.length} 项`)); problems.forEach((p) => log("  - " + p)); }
    else log(C.ok("✓ 结构校验通过"));
    if (bal.length) { log(C.bad(`✗ HTML 标签问题 ${bal.length} 项`)); bal.forEach((p) => log("  - " + p)); }
    else log(C.ok("✓ HTML 标签平衡"));
    log(C.dim(`  顶层组件 ${layer?.comps?.items?.length ?? "?"} 个\n`));
  },
};

CMDS.publish = {
  desc: "发布",
  async run([id]) {
    need(id, "用法：xiumi publish <作品ID>");
    const { show, showData } = await fetchShowData(id);
    rebuildRaHtml(showData);
    await putShowData(id, showData, show.saved_at, "发布");
    const snap = join(OUT_DIR, `show_${id}_${Date.now()}.json`);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(snap, JSON.stringify(showData, null, 1), "utf8");
    log(C.ok(`✓ 已发布「${showData.title}」`));
    printLinks(id);
    log(`  本地快照  ${snap}`);
    log(C.dim("\n下一步：打开编辑地址 → 预览/导出 → 复制到公众号。"));
  },
};

CMDS.copy = {
  desc: "复制作品",
  async run([fromId, title]) {
    need(fromId, '用法：xiumi copy <源作品ID> ["新标题"]');
    const meta = await apiRequest(`/api/shows/${fromId}`);
    if (isAuthFailure(meta)) die("会话已失效。\n" + NOT_LOGIN_HINT);
    const src = meta.json?.data;
    need(src?.show_data_name, `源作品 ${fromId} 缺少 show_data_name`);
    const res = await apiRequest("/api/shows/v5/paper", {
      method: "POST",
      query: { from_show_id: fromId },
      body: {
        format: "0320cc2e241eb9af530b84dbe0b1cc65",
        encodedData: compressToBase64(JSON.stringify({ title: title || `${src.title ?? "未命名"} - 拷贝`, raw_info_only: true })),
        copyFromShowId: fromId,
        tn_show_action_token_2: copyToken(src.show_data_name),
      },
    });
    if (res.status >= 400) die(`复制失败 [${res.status}] ${res.json?.message ?? res.text.slice(0, 200)}`);
    const s = res.json?.data;
    log(C.ok(`✓ 已复制为「${s.title}」`));
    log(`  新作品ID  ${C.b(String(s.show_id))}`);
    printLinks(s.show_id);
  },
};

CMDS.delete = {
  desc: "删除作品",
  async run([id, flag]) {
    need(id, "用法：xiumi delete <作品ID> --yes");
    need(flag === "--yes" || flag === "-y", "删除不可恢复，请显式加 --yes 确认。");
    const r = await apiRequest(`/api/shows/${id}`, { method: "DELETE" });
    if (r.status >= 400) die(`删除失败 [${r.status}] ${r.json?.message ?? ""}`);
    log(C.ok(`✓ 已删除作品 ${id}`));
  },
};

/* ---------------- 模板市场 / 采集 / 加工 ---------------- */

/** 简易 flag 解析：--key value / --key */
function parseFlags(argv) {
  const pos = [];
  const flags = {};
  const a = [...(argv ?? [])].filter((x) => x !== undefined && x !== "");
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (typeof t === "string" && t === "--") { pos.push(...a.slice(i + 1)); break; }
    if (typeof t === "string" && t.startsWith("--")) {
      const key = t.slice(2);
      const next = a[i + 1];
      if (next === undefined || (typeof next === "string" && next.startsWith("--"))) flags[key] = true;
      else { flags[key] = next; i++; }
    } else pos.push(t);
  }
  return { pos, flags };
}

/** ID / 预览链接 / 关键词 → show_id */
async function resolveTarget(target) {
  const t = parseShowTarget(target);
  if (t) return { showId: t.showId, sid: t.sid };
  const r = await marketSearch({ keyword: String(target), limit: 1 });
  need(r.items.length, `市场里没有搜到「${target}」`);
  log(C.dim(`  按关键词匹配到：${r.items[0].title}（${r.items[0].show_id}）`));
  return { showId: r.items[0].show_id, sid: MARKET_BOARD_SID };
}

async function copyToAccount(fromId, title) {
  const meta = await apiRequest(`/api/shows/${fromId}`);
  if (isAuthFailure(meta)) die("会话已失效。\n" + NOT_LOGIN_HINT);
  const src = meta.json?.data;
  need(src?.show_data_name, `源作品 ${fromId} 缺少 show_data_name，无法计算复制令牌`);
  const res = await apiRequest("/api/shows/v5/paper", {
    method: "POST",
    query: { from_show_id: fromId },
    body: {
      format: "0320cc2e241eb9af530b84dbe0b1cc65",
      encodedData: compressToBase64(JSON.stringify({ title: title || `${src.title ?? "未命名"} - 拷贝`, raw_info_only: true })),
      copyFromShowId: fromId,
      tn_show_action_token_2: copyToken(src.show_data_name),
    },
  });
  if (isAuthFailure(res)) die("会话已失效。\n" + NOT_LOGIN_HINT);
  if (res.status >= 400 || !res.json?.data?.show_id) {
    die(
      `复制失败 [${res.status}]：${JSON.stringify(res.json ?? res.text).slice(0, 300)}\n` +
        `  可能是该模板需先购买/会员，或作者禁止复制。\n  可改用：xiumi grab ${fromId}    （免登录拿成品 HTML）`
    );
  }
  return { show: res.json.data, source: src };
}

const num = (v, d) => (v === undefined || v === null || Number.isNaN(Number(v)) ? d : Number(v));

CMDS.market = {
  desc: "搜索模板市场",
  async run(argv) {
    const { pos, flags } = parseFlags(argv);
    const keyword = pos.join(" ");
    let tagIds = flags.tag ?? null;
    if (typeof tagIds === "string" && !/^\d/.test(tagIds)) {
      const tags = await marketTags();
      const hit = tags.find((t) => t.name === tagIds || t.path.includes(tagIds));
      need(hit, `分类里没有「${tagIds}」。可用：${tags.map((t) => t.name).join(" / ")}`);
      tagIds = hit.tag_id;
    }
    const r = await marketSearch({
      keyword,
      tagIds,
      page: num(flags.page, 1),
      limit: num(flags.limit, 20),
      pages: num(flags.pages, 1),
      sort: flags.sort ?? "relevance",
    });
    log(C.dim(`\n市场共 ${r.total ?? "?"} 个${keyword ? `，关键词「${keyword}」` : ""}：\n`));
    r.items.forEach((x, i) => {
      log(`  ${String(i + 1).padStart(2)}. ${C.b(x.show_id)}  ${x.title}`);
      log(C.dim(`      价格 ${x.price}　使用 ${x.copy_number}　收藏 ${x.collected_number}　作者 ${x.seller || "?"}　${x.show_url}`));
    });
    log(C.dim(`\n下一步：xiumi steal <ID> 搬到自己账号 ｜ xiumi inspect <ID> 先体检\n`));
  },
};

CMDS.hot = {
  desc: "市场热门榜",
  async run(argv) {
    const { flags } = parseFlags(argv);
    const metric = flags.metric ?? "copy";
    const r = await marketHot({ metric, pages: num(flags.pages, 3), limit: num(flags.limit, 15), tagIds: flags.tag ?? null });
    const label = { copy: "使用量", collect: "收藏量", hit: "浏览量", new: "最新" }[metric] ?? metric;
    log(C.dim(`\n热门榜（按${label}）：\n`));
    r.items.forEach((x, i) => log(`  ${String(i + 1).padStart(2)}. ${C.b(x.show_id)}  使用 ${String(x.copy_number).padStart(4)}　收藏 ${String(x.collected_number).padStart(4)}　${x.title}`));
    log("");
  },
};

CMDS.inspect = {
  desc: "模板体检",
  async run(argv) {
    const { pos } = parseFlags(argv);
    need(pos[0], "用法：xiumi inspect <作品ID|预览链接|关键词>");
    const { showId, sid } = await resolveTarget(pos[0]);
    const g = await grabTemplate(showId, { sid });
    const ins = inspectTemplate(g);
    log(C.b(`\n【体检】${ins.title}\n`));
    log(`  作品 ID   ${showId}`);
    log(`  公网快照  ${g.pageUrl}`);
    log(`  结构      ${ins.editable ? `可编辑组件 ${ins.components} 个` : "已发布快照（组件已拍平）"}`);
    log(`  规模      ${ins.sections} section / ${ins.images} 张图 / ${ins.svgs} SVG / ${ins.chars} 字`);
    log(`  主色      ${ins.colors.map(([c, n]) => `${c}×${n}`).join("  ") || "-"}`);
    log(`  字号      ${ins.fonts.map(([f, n]) => `${f}×${n}`).join("  ") || "-"}`);
    log(C.dim(`\n  正文  ${ins.textPreview}\n`));
  },
};

CMDS.grab = {
  desc: "抓取模板成品（免登录）",
  async run(argv) {
    const { pos, flags } = parseFlags(argv);
    need(pos[0], "用法：xiumi grab <作品ID|预览链接> [--md|--txt] [--lib] [--name 文件名]");
    const { showId, sid } = await resolveTarget(pos[0]);
    const g = await grabTemplate(showId, { sid });
    const name = flags.name || g.info?.title || String(showId);
    const base = name.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 80) || String(showId);

    const OUT = join(OUT_DIR);
    const EX = join(OUT_DIR, "exports");
    for (const d of [OUT, EX]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

    const jsonFile = join(OUT, `${base}__${showId}.json`);
    const htmlFile = join(OUT, `${base}__${showId}.html`);
    writeFileSync(jsonFile, JSON.stringify({ show_id: showId, sid: g.sid, dataUrl: g.dataUrl, info: g.info, showData: g.showData }, null, 2), "utf8");
    writeFileSync(htmlFile, wrapStandaloneHtml({ title: g.info?.title ?? "秀米作品", body: g.articleHtml, width: g.injected?.showInfo?.exif?.viewport?.WIDTH || 677 }), "utf8");

    const fmt = flags.md ? "md" : flags.txt ? "txt" : flags.format ?? "";
    let outFile = null;
    if (fmt) {
      const content = fmt === "md" || fmt === "markdown" ? htmlToMarkdown(g.articleHtml) : htmlToText(g.articleHtml);
      const ext = fmt === "md" || fmt === "markdown" ? "md" : "txt";
      outFile = join(EX, `${base}__${showId}.${ext}`);
      writeFileSync(outFile, content, "utf8");
    }
    if (flags.lib) {
      const LIB = join(LIB_DIR);
      if (!existsSync(LIB)) mkdirSync(LIB, { recursive: true });
      writeFileSync(join(LIB, `${base}.json`), JSON.stringify({ name, source: g.pageUrl, note: `作品 ${showId}`, savedAt: new Date().toISOString(), html: g.articleHtml }, null, 2), "utf8");
    }

    const ins = inspectTemplate(g);
    log(C.ok(`\n✓ 已抓取「${g.info?.title ?? showId}」`));
    log(`  内容树    ${jsonFile}`);
    log(`  本地预览  ${htmlFile}`);
    if (outFile) log(`  导出      ${outFile}`);
    log(`  规模      ${ins.sections} section / ${ins.images} 图 / ${ins.chars} 字　主色 ${ins.colors.slice(0, 3).map(([c]) => c).join(" ")}`);
    log(C.dim(`\n  提示：钉位元素（超大标题）依赖秀米阅读器 JS，静态打开可能错位；要 1:1 请用 xiumi steal 后走秀米「复制到公众号」。\n`));
  },
};

CMDS.steal = {
  desc: "把模板搬到自己账号",
  async run(argv) {
    const { pos, flags } = parseFlags(argv);
    need(pos[0], '用法：xiumi steal <作品ID|链接|关键词> [--title "新标题"] [--patch 补丁.json] [--dry]');
    const { showId } = await resolveTarget(pos[0]);
    if (flags.dry) {
      log(C.dim(`\n[演练] 将把作品 ${showId} 复制到你账号，标题 ${flags.title || "（原标题 - 拷贝）"}\n`));
      return;
    }
    const { show } = await copyToAccount(showId, flags.title);
    log(C.ok(`\n✓ 已搬到自己账号：「${show.title}」`));
    log(`  新作品ID  ${C.b(String(show.show_id))}`);
    printLinks(show.show_id);

    if (flags.patch) {
      const patches = readJsonFile(flags.patch, "补丁");
      const { show: cur, showData } = await fetchShowData(show.show_id);
      const layer = mainLayer(showData);
      let hits = 0;
      for (const p of patches) {
        if (!p?.from) continue;
        walkItems(layer, (item) => {
          const k = Object.keys(item).find((x) => x !== "_comp" && item[x]?.type === "text");
          if (!k) return;
          const before = String(item[k].text ?? "");
          if (before.includes(p.from)) {
            item[k].text = p.expect ? replaceExact(before, p.from, p.to ?? "", p.expect, "steal") : before.split(p.from).join(p.to ?? "");
            hits++;
          }
        });
      }
      rebuildRaHtml(showData);
      await putShowData(show.show_id, showData, cur.saved_at, "回写文案");
      log(C.ok(`✓ 文案替换 ${hits} 处已回写`));
    }
    log("");
  },
};

CMDS["steal-batch"] = {
  desc: "批量搬模板",
  async run(argv) {
    const { pos, flags } = parseFlags(argv);
    let list = pos.slice();
    if (!list.length) {
      need(flags.keyword || flags.tag, "用法：xiumi steal-batch <ID...> 或 --keyword 国庆 --limit 5");
      const r = await marketSearch({ keyword: flags.keyword ?? "", tagIds: flags.tag ?? null, limit: num(flags.limit, 5), sort: flags.sort ?? "copy" });
      list = r.items.map((x) => x.show_id);
    }
    list = list.slice(0, Math.min(20, num(flags.limit, list.length)));
    log(C.dim(`\n准备搬运 ${list.length} 个…\n`));
    let okCount = 0;
    for (const t of list) {
      try {
        const { show } = await copyToAccount(t, flags["title-prefix"] ? `${flags["title-prefix"]}${t}` : "");
        log(`  ${C.ok("✓")} ${t} → ${C.b(String(show.show_id))}  ${show.title ?? ""}`);
        okCount++;
      } catch (e) {
        log(`  ${C.bad("✗")} ${t}  ${String(e.message).split("\n")[0]}`);
      }
      await new Promise((r) => setTimeout(r, num(flags.delay, 800)));
    }
    log(C.ok(`\n完成：成功 ${okCount} / ${list.length}\n`));
  },
};

CMDS.retheme = {
  desc: "一键换配色",
  async run(argv) {
    const { pos, flags } = parseFlags(argv);
    need(pos[0], '用法：xiumi retheme <作品ID> --map "#c8201a=#27408B,#f6d478=#F5C453" [--dry] ｜ --show 查看当前色板');
    const id = pos[0];
    const { show, showData } = await fetchShowData(id);

    if (flags.show) {
      log(C.b(`\n当前色板（作品 ${id}）：\n`));
      palette(showData, 20).forEach(([c, n]) => log(`  ${c}  ×${n}`));
      log("");
      return;
    }
    need(flags.map, '需要 --map "#旧色=#新色,#旧色2=#新色2"');
    const mapping = {};
    for (const pair of String(flags.map).split(",")) {
      const [a, b] = pair.split("=");
      need(a && b, `映射格式错误：${pair}（应为 #旧=#新）`);
      mapping[a.trim()] = b.trim();
    }
    const before = palette(showData);
    const r = retheme(showData, mapping);
    log(C.b(`\n【换配色】作品 ${id}`));
    log(`  规则    ${Object.entries(mapping).map(([a, b]) => `${a} → ${b}`).join("，")}`);
    log(`  改动    ${r.changedNodes} 个样式节点 / ${r.changedHtmlTokens} 处渲染缓存`);
    log(`  换前    ${before.slice(0, 5).map(([c, n]) => `${c}×${n}`).join("  ")}`);
    log(`  换后    ${r.palette.slice(0, 5).map(([c, n]) => `${c}×${n}`).join("  ")}`);
    if (flags.dry) return log(C.dim("\n（演练模式，未写入）\n"));
    await putShowData(id, showData, show.saved_at, "换配色写入");
    log(C.ok(`\n✓ 已写入`));
    printLinks(id);
    log("");
  },
};

CMDS.images = {
  desc: "列出作品里的图片",
  async run(argv) {
    const { pos } = parseFlags(argv);
    need(pos[0], "用法：xiumi images <作品ID>");
    const { showData } = await fetchShowData(pos[0]);
    const imgs = listImages(showData);
    log(C.b(`\n作品 ${pos[0]} 共 ${imgs.length} 张图：\n`));
    imgs.forEach((i) => log(`  #${String(i.index).padStart(2)}  路径 ${i.path.padEnd(8)} ${i.src}`));
    log("");
  },
};

CMDS.reimg = {
  desc: "批量换图",
  async run(argv) {
    const { pos, flags } = parseFlags(argv);
    need(pos[0], '用法：xiumi reimg <作品ID> --index "2=https://…,0=https://…" 或 --src "旧URL片段=新URL" [--dry]');
    const id = pos[0];
    const { show, showData } = await fetchShowData(id);
    const byIndex = [];
    if (flags.index) {
      for (const pair of String(flags.index).split(",")) {
        const i = pair.indexOf("=");
        need(i > 0, `--index 格式错误：${pair}（应为 序号=URL）`);
        byIndex.push({ index: Number(pair.slice(0, i)), src: pair.slice(i + 1) });
      }
    }
    const bySrc = [];
    if (flags.src) {
      for (const pair of String(flags.src).split(",")) {
        const i = pair.indexOf("=");
        need(i > 0, `--src 格式错误：${pair}（应为 旧片段=新URL）`);
        bySrc.push({ match: pair.slice(0, i), src: pair.slice(i + 1) });
      }
    }
    const r = replaceImages(showData, { byIndex, bySrc, fillAll: typeof flags.all === "string" ? flags.all : "" });
    if (!r.applied.length) die(`没有命中。当前共 ${r.total} 张图，用 xiumi images ${id} 查看。`);
    log(C.b(`\n【换图】命中 ${r.applied.length} / ${r.total}`));
    r.applied.forEach((a) => log(`  #${a.path}  ${String(a.from).slice(0, 60)} → ${String(a.to).slice(0, 60)}`));
    if (flags.dry) return log(C.dim("\n（演练模式，未写入）\n"));
    await putShowData(id, showData, show.saved_at, "换图写入");
    log(C.ok("\n✓ 已写入\n"));
  },
};

CMDS.export = {
  desc: "导出 HTML/Markdown/纯文本",
  async run(argv) {
    const { pos, flags } = parseFlags(argv);
    need(pos[0], "用法：xiumi export <作品ID|预览链接> [--md|--txt] [--name 文件名]");
    const { showId, sid } = await resolveTarget(pos[0]);
    const g = await grabTemplate(showId, { sid: flags.sid ?? sid });
    const want = flags.md ? "md" : flags.txt ? "txt" : flags.format ?? "html";
    const content = want === "md" ? htmlToMarkdown(g.articleHtml) : want === "txt" ? htmlToText(g.articleHtml) : wrapStandaloneHtml({ title: g.info?.title ?? "", body: g.articleHtml });
    const ext = want === "md" ? "md" : want === "txt" ? "txt" : "html";
    const EX = join(OUT_DIR, "exports");
    if (!existsSync(EX)) mkdirSync(EX, { recursive: true });
    const base = (flags.name || g.info?.title || String(showId)).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 80);
    const file = join(EX, `${base}.${ext}`);
    writeFileSync(file, content, "utf8");
    log(C.ok(`\n✓ 已导出 ${ext.toUpperCase()}`));
    log(`  文件  ${file}`);
    log(`  大小  ${content.length} 字符\n`);
  },
};

CMDS.snap = {
  desc: "版本快照",
  async run(argv) {
    const { pos } = parseFlags(argv);
    need(pos[0], "用法：xiumi snap <作品ID> [list | restore [序号]]");
    const id = pos[0];
    const SNAP = join(OUT_DIR, "snapshots");
    const sub = pos[1] ?? "create";

    if (sub === "list") {
      const list = listSnapshots(SNAP, id);
      if (!list.length) return log(C.dim(`\n作品 ${id} 还没有快照。\n`));
      log(C.b(`\n作品 ${id} 共 ${list.length} 个快照（新的在前）：\n`));
      list.forEach((s, i) => log(`  #${i}  ${s.name}`));
      log("");
      return;
    }
    if (sub === "restore") {
      const which = num(pos[2], 0);
      const snap = loadSnapshot(SNAP, id, which);
      const { show, showData: cur } = await fetchShowData(id);
      saveSnapshot(SNAP, id, cur, { title: cur.title, reason: "restore 前自动备份" });
      await putShowData(id, snap.showData, show.saved_at, "快照回滚");
      log(C.ok(`\n✓ 已回滚到 ${snap.name}（回滚前状态已另存，可再回滚撤销）\n`));
      return;
    }
    const { showData } = await fetchShowData(id);
    const file = saveSnapshot(SNAP, id, showData, { title: showData.title });
    log(C.ok(`\n✓ 已保存快照：${file}\n`));
  },
};

/* ---------------- 入口 ---------------- */

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") return CMDS.help.run();
  const target = CMDS[cmd];
  if (!target) {
    log(C.bad(`未知命令：${cmd}\n`));
    return CMDS.help.run();
  }
  await guard(() => target.run(args));
})();
