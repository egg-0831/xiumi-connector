#!/usr/bin/env node
/**
 * 秀米 XIUMI 连接器 v3（零依赖，stdio JSON-RPC）
 *
 * 能力：
 *   读取 —— 账号 / 我的作品 / 作品内容树 / 模板市场 / 收藏 / 素材库
 *   采集 —— 市场搜索 / 分类 / 榜单 / 模板体检 / 免登录抓成品 / 一键搬到账号（含批量）
 *   写入 —— 新建草稿 / 复制作品 / 追加组件 / 替换文本 / 换配色 / 换图 / 更新内容 / 删除 / 发布
 *   运维 —— 版本快照与回滚 / 导出 html·md·txt
 *
 * 认证：浏览器 Cookie 注入（xiumi_set_cookie）。
 * 接口：2026-10 对 edt.xiumius.cn 前端包逆向 + 实测验证，非官方接口，秀米改版可能失效。
 */

import { writeFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import {
  SESSION_FILE, LIB_DIR, OUT_DIR, BASE, CDN_BASE,
  loadSession, saveSession, refreshAccount, sessionUid, sessionSid,
  request, apiRequest, isAuthFailure, NOT_LOGIN_HINT,
  copyToken, wrapData, buildUpdatePayload, compressToBase64,
  makeBlankShowData, makeText, makeImage, makeRow, mainLayer, TPL,
  fetchShowData, summarizeShowData, validateShowData, balanceHtml,
  rebuildRaHtml, walkItems, replaceExact,
} from "./xiumi-core.mjs";

import {
  marketTags, marketSearch, marketHot, grabTemplate, inspectTemplate,
  parseShowTarget, htmlToMarkdown, htmlToText, wrapStandaloneHtml, MARKET_BOARD_SID,
} from "./xiumi-market.mjs";

import {
  retheme, replaceImages, listImages, palette,
  saveSnapshot, listSnapshots, loadSnapshot, pruneSnapshots,
} from "./xiumi-transform.mjs";

const VERSION = "3.0.0";

/* ---------------- 返回包装 ---------------- */

const ok = (text) => ({ content: [{ type: "text", text }], isError: false });
const err = (text) => ({ content: [{ type: "text", text }], isError: true });
const asText = (v) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

function slug(name) {
  return String(name).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 80) || "untitled";
}

function ensureDir(d) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

/** 统一处理鉴权失败 */
function guard(res, label) {
  if (isAuthFailure(res)) return `[${res.status}] 未登录或会话已失效（${label}）。\n\n${NOT_LOGIN_HINT}`;
  if (res.status >= 400) {
    const detail = res.json ? JSON.stringify(res.json) : res.text.slice(0, 600);
    let hint = "";
    if (res.json?.code === -10) {
      hint = "\n\n提示：Common:Failed_DataRejected 通常表示内容树结构不合法。可先跑 xiumi_validate_showdata 定位问题。";
    }
    return `[${res.status}] ${label} 失败：\n${detail}${hint}`;
  }
  return null;
}

/* ============================================================
 *  认证类
 * ============================================================ */

async function toolSetCookie({ cookie }) {
  if (!cookie || typeof cookie !== "string" || cookie.length < 20) {
    return err('请传入从浏览器复制的完整 Cookie 字符串（例如 "sid=...; ..."）。');
  }
  const cleaned = cookie.replace(/^\s*cookie\s*:\s*/i, "").trim();
  const prev = loadSession() ?? {};
  saveSession({ ...prev, cookie: cleaned, savedAt: new Date().toISOString() });
  try {
    const u = await refreshAccount();
    return ok(
      "Cookie 已保存并通过校验，连接成功！\n" +
        asText({ 昵称: u.nickname, user_sid: u.user_sid, unique_uid: u.unique_uid, 手机: u.phone }) +
        "\n\n已解锁：读取（作品/内容树/市场/收藏）+ 写入（新建草稿/更新/发布/删除）+ 本地素材库。"
    );
  } catch (e) {
    return err(`Cookie 已保存但校验失败：${e.message}`);
  }
}

async function toolWhoami() {
  try {
    const u = await refreshAccount();
    return ok(asText({ 昵称: u.nickname, user_sid: u.user_sid, unique_uid: u.unique_uid, 手机: u.phone, 会员等级: u.level }));
  } catch (e) {
    return err(e.message);
  }
}

/* ============================================================
 *  读取类
 * ============================================================ */

async function toolListShows({ page = 1, count = 20 } = {}) {
  const res = await apiRequest("/api/shows", { query: { page, count } });
  const g = guard(res, "读取作品列表");
  if (g) return err(g);
  const list = res.json?.data ?? [];
  return ok(
    `我的作品（第 ${page} 页，本页 ${list.length} 个）：\n` +
      list
        .map((s, i) => `${i + 1}. [${s.show_id}] ${s.title ?? "(无标题)"}　更新:${(s.updated_at ?? s.saved_at ?? "?").slice(0, 19)}　编辑:${BASE}/studio/v5#/paper/for/${s.show_id}`)
        .join("\n")
  );
}

async function toolGetShow({ id, include_outline = true }) {
  if (!id) return err("缺少参数 id。");
  try {
    const { show, showData, dataUrl } = await fetchShowData(id);
    let out = asText({
      show_id: show.show_id,
      title: show.title,
      saved_at: show.saved_at,
      show_data_name: show.show_data_name,
      show_data_url: dataUrl,
      编辑地址: `${BASE}/studio/v5#/paper/for/${show.show_id}`,
      type: show.type_text ?? show.type,
    });
    if (include_outline) {
      const s = summarizeShowData(showData);
      out += `\n\n— 内容大纲（共 ${s.itemCount} 个顶层组件）—\n` + s.outline.join("\n");
    }
    return ok(out);
  } catch (e) {
    return err(e.message);
  }
}

async function toolGetShowData({ id, save_as, path }) {
  if (!id) return err("缺少参数 id。");
  try {
    const { showData, dataUrl } = await fetchShowData(id);
    let file = "";
    if (save_as || path) {
      const target = path || join(OUT_DIR, `${slug(save_as)}.json`);
      ensureDir(target.slice(0, target.lastIndexOf("\\")) || OUT_DIR);
      writeFileSync(target, JSON.stringify(showData, null, 1), "utf8");
      file = `\n已保存：${target}`;
    }
    const s = summarizeShowData(showData);
    return ok(
      `作品 ${id} 内容树（${dataUrl}）${file}\n\n— 大纲 —\n${s.outline.join("\n")}\n\n（完整 JSON ${
        JSON.stringify(showData).length
      } 字符；用 save_as/path 可落盘后再精细处理）`
    );
  } catch (e) {
    return err(e.message);
  }
}

async function toolGetShowHtml({ id, url, save_name }) {
  let dataUrl;
  if (!url) {
    if (!id) return err("缺少参数：id 或 url 至少提供一个。");
    const meta = await apiRequest(`/api/shows/${id}`);
    const g = guard(meta, "读取作品信息");
    if (g) return err(g);
    const show = meta.json?.data ?? meta.json;
    if (!show?.show_data_name) return err(`作品缺少 show_data_name。`);
    dataUrl = `${CDN_BASE}/xmi/pd/${show.show_data_name}.json`;
  } else {
    const pageUrl = url.startsWith("//") ? "https:" + url : url;
    const page = await request(pageUrl);
    if (page.status >= 400) return err(`[${page.status}] 打不开渲染页 ${pageUrl}`);
    const m = (page.text ?? "").match(/injectedData\.showInfo\s*=\s*JSON\.parse\(decodeURIComponent\("([^"]+)"\)\)/);
    if (!m) return err(`渲染页中未找到内嵌数据（可能接口变更）：${(page.text ?? "").slice(0, 300)}`);
    let info;
    try { info = JSON.parse(decodeURIComponent(m[1])); } catch (e) { return err("解析内嵌 showInfo 失败：" + e.message); }
    dataUrl = info?.show_data_url;
    if (!dataUrl) return err(`showInfo 缺少 show_data_url。`);
  }
  if (dataUrl.startsWith("//")) dataUrl = "https:" + dataUrl;
  const res = await request(dataUrl);
  if (res.status >= 400 || !res.json) return err(`[${res.status}] 拉取内容 JSON 失败。`);

  const raw = [];
  (function collect(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(collect);
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string" && (k === "_$raHTML" || k === "rendererAccelerate") && v.includes("<")) raw.push(v);
      else if (v && typeof v === "object") collect(v);
    }
  })(res.json);
  if (!raw.length) return err(`内容 JSON 中未找到预渲染 HTML 字段。顶层键：${Object.keys(res.json).join(",")}`);

  raw.sort((a, b) => b.length - a.length);
  const kept = [];
  for (const frag of raw) if (!kept.some((k) => k.includes(frag))) kept.push(frag);
  const cleaned = kept.map((k) =>
    k.replace(/\s(?:tn|opera|ng)-[a-zA-Z0-9_-]+(?:="[^"]*")?/g, "").replace(/\{\{[^{}]*\}\}/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/\s{2,}/g, " ").trim()
  );
  let note = "";
  if (save_name) {
    ensureDir(LIB_DIR);
    const file = join(LIB_DIR, `${slug(save_name)}.json`);
    writeFileSync(file, JSON.stringify({ name: save_name, source: url ?? `show:${id}`, note: `渲染HTML ${dataUrl}`, savedAt: new Date().toISOString(), html: cleaned.join("\n") }, null, 2), "utf8");
    note = `\n已保存到本地素材库：${file}`;
  }
  return ok(`渲染地址：${url ?? "(作品 " + id + ")"}\n内容数据：${dataUrl}\n片段 ${cleaned.length} 个，共 ${cleaned.join("").length} 字符${note}\n\n` + cleaned.join("\n<!-- fragment -->\n"));
}

async function toolGoodsTagsTree({ show_type = "paper", tag_level_from = "1", tag_level_to = "2" } = {}) {
  const res = await apiRequest("/api/show_goods/tags_tree", { query: { show_type, tag_level_from, tag_level_to } });
  const g = guard(res, "读取分类树");
  return g ? err(g) : ok(asText(res.json));
}

async function toolSearchGoods({ search, keyword, tag_id, tag_name, show_type = "paper", showgoods_type = "paper", page = 1, limit = 20 } = {}) {
  const query = { show_type, showgoods_type, page, limit, price_scope: 0, by_nearest: 0, tpl_flag: 0 };
  const kw = search ?? keyword;
  if (kw) query.search = kw;
  if (tag_id) query.tag_id = tag_id;
  if (tag_name) query.tag_name = tag_name;
  const res = await apiRequest("/api/show_goods/goodses", { query });
  const g = guard(res, "搜索模板市场");
  if (g) return err(g);
  const d = res.json?.data ?? res.json;
  const list = d?.goodses ?? (Array.isArray(d) ? d : []);
  return ok(
    `模板市场${d?.count != null ? `共 ${d.count} 个` : ""}（第 ${page} 页，本页 ${list.length} 个）：\n` +
      list
        .map((g2, i) => {
          const s = g2.show ?? {};
          const showUrl = s.show_url ? `　预览:${s.show_url}` : "";
          const seller = g2.seller?.nickname ? `　作者:${g2.seller.nickname}` : "";
          return `${i + 1}. [商品${g2.show_goods_id} / 作品${g2.show_id}] ${s.title ?? "(未命名)"}　价格:${g2.price ?? 0} 使用:${g2.copy_number ?? 0} 收藏:${g2.collected_number ?? 0}${seller}${showUrl}`;
        })
        .join("\n") +
      `\n\n提示：把 show_url 传给 xiumi_get_show_html 取模板 HTML；把 show_id 传给 xiumi_copy_show 直接复制到自己账号。`
  );
}

async function toolListFavorites({ page = 1, count = 20 } = {}) {
  const res = await apiRequest("/api/show_goods_favorites", { query: { page, count } });
  const g = guard(res, "读取收藏");
  if (g) return err(g);
  const d = res.json?.data ?? res.json;
  const list = d?.goodses ?? (Array.isArray(d) ? d : []);
  return ok(`收藏 ${d?.count ?? list.length} 个：\n` + list.map((g2, i) => `${i + 1}. [作品${g2.show_id ?? "?"}] ${(g2.show ?? g2).title ?? "(未命名)"}`).join("\n"));
}

/* ============================================================
 *  写入类
 * ============================================================ */

/** 新建空草稿壳 */
async function createEmptyShow(title) {
  const res = await apiRequest("/api/shows/v5/paper", {
    method: "POST",
    body: {
      format: "0320cc2e241eb9af530b84dbe0b1cc65",
      encodedData: compressToBase64(JSON.stringify({ title, raw_info_only: true })),
    },
  });
  const g = guard(res, "新建草稿");
  if (g) throw new Error(g);
  const show = res.json?.data;
  if (!show?.show_id) throw new Error(`新建草稿返回异常：${asText(res.json).slice(0, 300)}`);
  return show;
}

/** 新建草稿（可带内容） */
async function toolCreateDraft({ title, blocks, cover, return_content = false }) {
  if (!title || typeof title !== "string" || !title.trim()) {
    return err('缺少参数 title（草稿标题）。');
  }
  try {
    const show = await createEmptyShow(title);
    let result = {
      show_id: show.show_id,
      title: show.title,
      saved_at: show.saved_at,
      编辑地址: `${BASE}/studio/v5#/paper/for/${show.show_id}`,
    };

    if (Array.isArray(blocks) && blocks.length) {
      const me = loadSession() ?? {};
      const sd = makeBlankShowData({ title, cover: cover ?? "", authorUid: me.uid, authorSid: me.sid });
      const layer = mainLayer(sd);
      for (const b of blocks) layer.comps.items.push(buildBlock(b));
      rebuildRaHtml(sd);

      const problems = validateShowData(sd);
      if (problems.length) return err(`新建草稿 ${show.show_id} 已创建，但内容树校验未通过，未写入：\n- ${problems.join("\n- ")}`);

      const up = await apiRequest(`/api/shows/${show.show_id}`, { method: "PUT", body: buildUpdatePayload(sd, show.saved_at) });
      const g = guard(up, "写入内容");
      if (g) return err(`草稿 ${show.show_id} 已创建，但内容写入失败：\n${g}`);
      result.已写入组件 = layer.comps.items.length;
    } else {
      result.说明 = "空草稿壳已创建。可用 xiumi_append_blocks / xiumi_update_showdata 写入内容。";
    }
    if (return_content) result.content = null;
    return ok(asText(result));
  } catch (e) {
    return err(e.message);
  }
}

/** 把简化块描述转为组件 */
function buildBlock(b) {
  const type = (b.type ?? "text").toLowerCase();
  if (type === "text" || type === "html") {
    return makeText(b.html ?? b.text ?? "", b.style ?? {}, b.comp_style ?? {});
  }
  if (type === "image" || type === "img") {
    return makeImage(b.src ?? b.url, b.style ?? {}, { resize: b.resize ?? "h" });
  }
  if (type === "row" || type === "cols") {
    const cols = (b.cols ?? []).map((c) => (Array.isArray(c) ? c.map(buildBlock) : [buildBlock(c)]));
    return makeRow(cols, { style: b.style ?? {} });
  }
  if (type === "raw") return b.value;
  throw new Error(`未知块类型：${type}（可用 text / image / row / raw）`);
}

/** 复制作品到自己账号（含市场模板） */
async function toolCopyShow({ from_show_id, title }) {
  if (!from_show_id) return err("缺少参数 from_show_id。");
  const meta = await apiRequest(`/api/shows/${from_show_id}`);
  const g = guard(meta, "读取源作品");
  if (g) return err(g);
  const src = meta.json?.data ?? meta.json;
  if (!src?.show_data_name) return err(`源作品 ${from_show_id} 缺少 show_data_name，无法计算复制令牌。`);
  const token = copyToken(src.show_data_name);
  const res = await apiRequest("/api/shows/v5/paper", {
    method: "POST",
    query: { from_show_id },
    body: {
      format: "0320cc2e241eb9af530b84dbe0b1cc65",
      encodedData: compressToBase64(JSON.stringify({ title: title || `${src.title ?? "未命名"} - 拷贝`, raw_info_only: true })),
      copyFromShowId: from_show_id,
      tn_show_action_token_2: token,
    },
  });
  const g2 = guard(res, "复制作品");
  if (g2) return err(g2);
  const s = res.json?.data;
  if (!s?.show_id) return err(`复制返回异常：${asText(res.json).slice(0, 300)}`);
  return ok(asText({ 新作品ID: s.show_id, 标题: s.title, 来源: from_show_id, 编辑地址: `${BASE}/studio/v5#/paper/for/${s.show_id}` }));
}

/** 向已有作品的末尾追加组件 */
async function toolAppendBlocks({ show_id, blocks, position = "end" }) {
  if (!show_id) return err("缺少参数 show_id。");
  if (!Array.isArray(blocks) || !blocks.length) return err("缺少参数 blocks（组件数组）。");
  try {
    const { show, showData } = await fetchShowData(show_id);
    const layer = mainLayer(showData);
    const built = blocks.map(buildBlock);
    if (position === "start") layer.comps.items.unshift(...built);
    else if (Number.isInteger(position)) layer.comps.items.splice(position, 0, ...built);
    else layer.comps.items.push(...built);
    rebuildRaHtml(showData);

    const problems = validateShowData(showData);
    if (problems.length) return err(`追加后校验未通过，已中止：\n- ${problems.join("\n- ")}`);

    const up = await apiRequest(`/api/shows/${show_id}`, { method: "PUT", body: buildUpdatePayload(showData, show.saved_at) });
    const g = guard(up, "写入内容");
    if (g) return err(g);
    return ok(
      `已向作品 ${show_id} 追加 ${built.length} 个组件（当前共 ${layer.comps.items.length} 个）。\n编辑地址：${BASE}/studio/v5#/paper/for/${show_id}\n\n**注意**：秀米编辑器的预览缓存会在下次打开并保存时重算，建议打开确认一次。`
    );
  } catch (e) {
    return err(e.message);
  }
}

/** 文本批量替换（含 RA 缓存同步） */
async function toolReplaceText({ show_id, replacements, expect_each = 1 }) {
  if (!show_id) return err("缺少参数 show_id。");
  if (!Array.isArray(replacements) || !replacements.length) return err("缺少参数 replacements（[{from,to,expect?}] 数组）。");
  try {
    const { show, showData } = await fetchShowData(show_id);
    const layer = mainLayer(showData);
    const report = [];
    let touched = 0;

    for (const r of replacements) {
      if (!r || typeof r.from !== "string") return err("replacements 每项需含 from / to 字符串。");
      const expect = r.expect ?? expect_each;
      let hit = 0;
      for (const items of [layer.comps.items]) {
        walkItems(layer, (item) => {
          const txtKey = Object.keys(item).find((k) => k !== "_comp" && item[k]?.type === "text");
          if (!txtKey) return;
          const before = item[txtKey].text;
          if (before.includes(r.from)) {
            item[txtKey].text = replaceExact(before, r.from, r.to ?? "", expect, `replace:${r.from.slice(0, 24)}`);
            hit++;
          }
        });
      }
      report.push(`"${r.from.slice(0, 30)}" → ${hit} 处改动（期望每处 ${expect} 次）`);
      touched += hit;
    }
    if (touched === 0) return err(`没有匹配到任何文本：\n${report.join("\n")}\n\n请先用 xiumi_get_show 查看内容大纲确认原文。`);

    rebuildRaHtml(showData);
    const problems = validateShowData(showData);
    if (problems.length) return err(`替换后校验未通过，已中止：\n- ${problems.join("\n- ")}`);

    const up = await apiRequest(`/api/shows/${show_id}`, { method: "PUT", body: buildUpdatePayload(showData, show.saved_at) });
    const g = guard(up, "写入内容");
    if (g) return err(g);
    return ok(`已更新作品 ${show_id}：\n${report.join("\n")}\n\n编辑地址：${BASE}/studio/v5#/paper/for/${show_id}`);
  } catch (e) {
    return err(e.message);
  }
}

/** 整体覆盖内容树（高级） */
async function toolUpdateShowData({ show_id, content, content_file, title }) {
  if (!show_id) return err("缺少参数 show_id。");
  let data;
  try {
    if (content_file) {
      if (!existsSync(content_file)) return err(`文件不存在：${content_file}`);
      data = JSON.parse(readFileSync(content_file, "utf8"));
    } else if (typeof content === "string") {
      data = JSON.parse(content);
    } else if (content && typeof content === "object") {
      data = content;
    } else {
      return err("需要 content（JSON 字符串/对象）或 content_file。");
    }
  } catch (e) {
    return err(`内容 JSON 解析失败：${e.message}`);
  }
  if (title) data.title = title;

  const problems = validateShowData(data);
  if (problems.length) return err(`内容树校验未通过，未提交：\n- ${problems.join("\n- ")}`);

  const meta = await apiRequest(`/api/shows/${show_id}`);
  const g0 = guard(meta, "读取作品");
  if (g0) return err(g0);
  const show = meta.json?.data;
  const up = await apiRequest(`/api/shows/${show_id}`, { method: "PUT", body: buildUpdatePayload(data, show.saved_at) });
  const g = guard(up, "写入内容");
  if (g) return err(g);
  return ok(`已覆盖作品 ${show_id} 的内容树（${JSON.stringify(data).length} 字符）。\n编辑地址：${BASE}/studio/v5#/paper/for/${show_id}`);
}

/** 校验内容树（离线体检） */
async function toolValidate({ show_id, content, content_file }) {
  let data;
  if (show_id) {
    try {
      ({ showData: data } = await fetchShowData(show_id));
    } catch (e) {
      return err(e.message);
    }
  } else if (content_file) {
    if (!existsSync(content_file)) return err(`文件不存在：${content_file}`);
    data = JSON.parse(readFileSync(content_file, "utf8"));
  } else if (typeof content === "string") {
    data = JSON.parse(content);
  } else if (content && typeof content === "object") {
    data = content;
  } else {
    return err("需要 show_id / content / content_file 之一。");
  }

  const problems = validateShowData(data);
  const layer = data?.cubes?.[0]?.pages?.[0]?.layers?.[0];
  const bal = [];
  if (layer) {
    walkItems(layer, (item, _l, _i, path) => {
      const tk = Object.keys(item).find((k) => k !== "_comp" && item[k]?.type === "text");
      if (!tk) return;
      const b = balanceHtml(item[tk].text);
      Object.entries(b).forEach(([tag, v]) => { if (v !== 0) bal.push(`[${path}] <${tag}> 不平衡（${v > 0 ? "少" : "多"}闭合 ${Math.abs(v)} 个）`); });
    });
  }
  return ok(
    (problems.length ? `❌ 结构问题 ${problems.length} 项：\n- ${problems.join("\n- ")}` : "✅ 结构校验通过（version/scene/targetContext/cube/page/layer/组件齐全）") +
      `\n\n${bal.length ? `❌ HTML 标签问题 ${bal.length} 项：\n- ${bal.join("\n- ")}` : "✅ 所有文本 HTML 标签平衡"}` +
      `\n\n顶层组件：${layer?.comps?.items?.length ?? "?"} 个`
  );
}

/** 发布快照（把内容定稿并生成可打开版本） */
async function toolPublish({ show_id, title }) {
  if (!show_id) return err("缺少参数 show_id。");
  try {
    const { show, showData } = await fetchShowData(show_id);
    if (title) showData.title = title;
    rebuildRaHtml(showData);
    const problems = validateShowData(showData);
    if (problems.length) return err(`发布前校验未通过：\n- ${problems.join("\n- ")}`);

    const up = await apiRequest(`/api/shows/${show_id}`, { method: "PUT", body: buildUpdatePayload(showData, show.saved_at) });
    const g = guard(up, "发布");
    if (g) return err(g);

    const meta = await apiRequest(`/api/shows/${show_id}`);
    const m = meta.json?.data ?? {};
    const sid = m.author?.user_sid || sessionSid() || (loadSession() ?? {}).sid;
    let preview = null;
    if (sid) preview = `https://v.xiumius.cn/board/v5/${sid}/${show_id}`;

    ensureDir(OUT_DIR);
    const snapshot = join(OUT_DIR, `show_${show_id}_${Date.now()}.json`);
    writeFileSync(snapshot, JSON.stringify(showData, null, 1), "utf8");

    return ok(
      asText({
        状态: "已发布（内容已定稿并回写秀米）",
        作品ID: show_id,
        标题: showData.title,
        手机预览: preview,
        编辑地址: `${BASE}/studio/v5#/paper/for/${show_id}`,
        本地快照: snapshot,
      }) + `\n\n下一步：打开编辑地址 → 点"预览/导出" → 复制到公众号。`
    );
  } catch (e) {
    return err(e.message);
  }
}

/** 删除作品（危险操作，需 confirm） */
async function toolDeleteShow({ show_id, confirm }) {
  if (!show_id) return err("缺少参数 show_id。");
  if (confirm !== true) return err(`删除是不可恢复操作。确认要删除作品 ${show_id} 请传入 confirm: true。`);
  const res = await apiRequest(`/api/shows/${show_id}`, { method: "DELETE" });
  const g = guard(res, "删除作品");
  if (g) return err(g);
  return ok(`已删除作品 ${show_id}。`);
}

/** 通用透传 */
async function toolRequest({ method = "GET", path, query, body }) {
  if (!path) return err("缺少参数 path。");
  if (!/^https?:\/\//.test(path) && !path.startsWith("/")) path = "/" + path;
  const res = /^https?:\/\//.test(path) ? await request(path, { method, query, body }) : await apiRequest(path, { method, query, body });
  const g = guard(res, `${method} ${path}`);
  if (g) return err(g);
  return ok(asText(res.json ?? res.text.slice(0, 2000)));
}

/* ============================================================
 *  本地素材库
 * ============================================================ */

async function toolSaveToLibrary({ name, html, source, note }) {
  if (!name || !html) return err("缺少参数：name 与 html。");
  ensureDir(LIB_DIR);
  const file = join(LIB_DIR, `${slug(name)}.json`);
  writeFileSync(file, JSON.stringify({ name, source: source ?? "manual", note: note ?? "", savedAt: new Date().toISOString(), html: String(html) }, null, 2), "utf8");
  return ok(`已保存到本地素材库：${file}（${String(html).length} 字符）`);
}

async function toolListLibrary() {
  if (!existsSync(LIB_DIR)) return ok("本地素材库为空。");
  const files = readdirSync(LIB_DIR).filter((f) => f.endsWith(".json"));
  if (!files.length) return ok("本地素材库为空。");
  return ok(
    `本地素材库 ${files.length} 个：\n` +
      files.map((f, i) => {
        try {
          const e = JSON.parse(readFileSync(join(LIB_DIR, f), "utf8"));
          return `${i + 1}. ${e.name}（${e.html.length} 字符，${e.savedAt.slice(0, 19)}${e.note ? `，备注:${e.note}` : ""}）`;
        } catch {
          return `${i + 1}. ${f}（文件损坏）`;
        }
      }).join("\n")
  );
}

async function toolGetLibrary({ name }) {
  if (!name) return err("缺少参数 name。");
  const file = join(LIB_DIR, `${slug(name)}.json`);
  if (!existsSync(file)) return err(`素材不存在：${file}`);
  const e = JSON.parse(readFileSync(file, "utf8"));
  return ok(`【${e.name}】${e.note ? `（${e.note}）` : ""}\n来源:${e.source} 保存于:${e.savedAt}\n\n${e.html}`);
}

async function toolDeleteLibrary({ name }) {
  if (!name) return err("缺少参数 name。");
  const file = join(LIB_DIR, `${slug(name)}.json`);
  if (!existsSync(file)) return err(`素材不存在：${file}`);
  unlinkSync(file);
  return ok(`已删除：${file}`);
}

/* ============================================================
 *  模板市场 / 采集 / 加工
 * ============================================================ */

const SNAP_DIR = join(OUT_DIR, "snapshots");
const EXPORT_DIR = join(OUT_DIR, "exports");

const curCookie = () => loadSession()?.cookie || "";

/** 统一把「ID / 预览链接 / 关键词」解析成 show_id */
async function resolveTarget(target, { cookie } = {}) {
  if (!target || typeof target !== "string") {
    const e = new Error("缺少 target（作品 ID、公网预览链接，或市场关键词）。");
    e.expected = true;
    throw e;
  }
  const t = parseShowTarget(target);
  if (t) return { showId: t.showId, sid: t.sid, via: t.kind };
  // 当作关键词去市场里找
  const r = await marketSearch({ keyword: target, limit: 1, cookie: cookie ?? curCookie() });
  const top = r.items[0];
  if (!top) {
    const e = new Error(`市场里没有搜到「${target}」。`);
    e.expected = true;
    throw e;
  }
  return { showId: top.show_id, sid: MARKET_BOARD_SID, via: "keyword", matched: top };
}

/** 复制作品到自己账号（市场模板同样适用） */
async function copyShowToAccount(fromShowId, title) {
  const meta = await apiRequest(`/api/shows/${fromShowId}`);
  if (isAuthFailure(meta)) {
    const e = new Error(`复制需要登录。\n\n${NOT_LOGIN_HINT}`);
    e.expected = true;
    throw e;
  }
  if (meta.status >= 400) {
    const e = new Error(`读取源作品 ${fromShowId} 失败（HTTP ${meta.status}）：${asText(meta.json ?? meta.text).slice(0, 400)}`);
    e.expected = true;
    throw e;
  }
  const src = meta.json?.data ?? meta.json;
  if (!src?.show_data_name) {
    const e = new Error(`源作品 ${fromShowId} 缺少 show_data_name，无法计算复制令牌。`);
    e.expected = true;
    throw e;
  }
  const res = await apiRequest("/api/shows/v5/paper", {
    method: "POST",
    query: { from_show_id: fromShowId },
    body: {
      format: "0320cc2e241eb9af530b84dbe0b1cc65",
      encodedData: compressToBase64(
        JSON.stringify({ title: title || `${src.title ?? "未命名"} - 拷贝`, raw_info_only: true })
      ),
      copyFromShowId: fromShowId,
      tn_show_action_token_2: copyToken(src.show_data_name),
    },
  });
  if (isAuthFailure(res)) {
    const e = new Error(`复制需要登录。\n\n${NOT_LOGIN_HINT}`);
    e.expected = true;
    throw e;
  }
  if (res.status >= 400 || !res.json?.data?.show_id) {
    const e = new Error(
      `复制失败（HTTP ${res.status}）：${asText(res.json ?? res.text).slice(0, 500)}\n\n` +
        `常见原因：该模板需要先购买/开通会员，或作者限制了复制。\n` +
        `可改用 xiumi_template_grab 抓取成品 HTML（免登录、可直接粘贴到公众号）。`
    );
    e.expected = true;
    throw e;
  }
  return { show: res.json.data, source: src };
}

/** 把 grabbed 结果落成文件：内容树 JSON + 本地预览 HTML + 图片清单 */
function persistGrab(g, nameHint) {
  ensureDir(OUT_DIR);
  const base = `${slug(nameHint || g.info?.title || g.showId)}__${g.showId}`;
  const jsonFile = join(OUT_DIR, `${base}.json`);
  const htmlFile = join(OUT_DIR, `${base}.html`);
  const imgFile = join(OUT_DIR, `${base}.images.json`);
  writeFileSync(jsonFile, JSON.stringify({ show_id: g.showId, sid: g.sid, dataUrl: g.dataUrl, info: g.info, showData: g.showData }, null, 2), "utf8");
  writeFileSync(htmlFile, wrapStandaloneHtml({ title: g.info?.title ?? "秀米作品", body: g.articleHtml, width: g.injected?.showInfo?.exif?.viewport?.WIDTH || 677 }), "utf8");
  const imgs = [...String(g.articleHtml).matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => (m[1].startsWith("//") ? "https:" + m[1] : m[1]));
  writeFileSync(imgFile, JSON.stringify({ show_id: g.showId, count: imgs.length, images: [...new Set(imgs)] }, null, 2), "utf8");
  return { jsonFile, htmlFile, imgFile, imageCount: imgs.length };
}

/* ---------- 市场 ---------- */

async function toolMarketCategories({ show_type = "paper" } = {}) {
  try {
    const tags = await marketTags({ showType: show_type });
    return ok(
      `模板市场分类（${tags.length} 个）：\n` +
        tags.map((t) => `  ${String(t.tag_id).padStart(4)}  ${t.path}`).join("\n") +
        `\n\n用法：xiumi_market_search 传 tag_ids:"节假" 或 tag_ids:[14]。`
    );
  } catch (e) {
    return err(e.message);
  }
}

async function toolMarketSearch({
  keyword = "",
  tag_ids = null,
  page = 1,
  limit = 20,
  pages = 1,
  sort = "relevance",
  show_type = "paper",
  as_json = false,
} = {}) {
  try {
    let tagIds = tag_ids;
    if (typeof tagIds === "string" && !/^\d/.test(tagIds)) {
      const tags = await marketTags({ showType: show_type });
      const hit = tags.find((t) => t.name === tagIds || t.path.endsWith(tagIds) || t.path.includes(tagIds));
      if (!hit) return err(`分类里没有「${tagIds}」。先跑 xiumi_market_categories 看有哪些。`);
      tagIds = hit.tag_id;
    }
    const r = await marketSearch({ keyword, tagIds, page, limit, pages, sort, showType: show_type, cookie: curCookie() });
    if (as_json) return ok(JSON.stringify(r, null, 2));
    if (!r.items.length) return ok("没有搜到结果。换关键词，或用 xiumi_market_categories 看看分类名。");
    const lines = r.items.map(
      (x, i) =>
        `${i + 1}. [${x.show_id}] ${x.title}\n   价格 ${x.price}　使用 ${x.copy_number}　收藏 ${x.collected_number}　作者 ${x.seller || "?"}` +
        `\n   预览 ${x.show_url}`
    );
    return ok(
      `市场共 ${r.total ?? "?"} 个，本页 ${r.items.length} 个${keyword ? `（关键词：${keyword}）` : ""}：\n\n` +
        lines.join("\n") +
        `\n\n下一步：xiumi_steal 传 target=<show_id 或预览链接> 一键搬到自己账号；xiumi_template_grab 可免登录直接拿成品 HTML。`
    );
  } catch (e) {
    return err(e.message);
  }
}

async function toolMarketHot({ metric = "copy", pages = 3, limit = 20, tag_ids = null } = {}) {
  try {
    const r = await marketHot({ metric, pages, limit, tagIds: tag_ids, cookie: curCookie() });
    const label = { copy: "使用量", collect: "收藏量", hit: "浏览量", new: "最新更新" }[metric] ?? metric;
    return ok(
      `市场热门榜（按${label}，采样 ${pages} 页 / ${r.items.length} 个）：\n\n` +
        r.items.map((x, i) => `${i + 1}. [${x.show_id}] ${x.title}\n   使用 ${x.copy_number}　收藏 ${x.collected_number}　${x.show_url}`).join("\n")
    );
  } catch (e) {
    return err(e.message);
  }
}

/* ---------- 采集 ---------- */

async function toolTemplateInspect({ target, sid = null } = {}) {
  try {
    const g = await grabTemplate(target, { sid, cookie: curCookie() });
    const ins = inspectTemplate(g);
    const paletteStr = ins.colors.map(([c, n]) => `${c}×${n}`).join("  ");
    return ok(
      `【模板体检】${ins.title}\n` +
        `  作品 ID   ${g.showId}\n` +
        `  公网快照  ${g.pageUrl}\n` +
        `  内容树    ${g.dataUrl}\n\n` +
        `  结构      ${ins.editable ? `可编辑组件 ${ins.components} 个` : "已发布快照（组件已拍平，只能拿 HTML）"}\n` +
        `  规模      ${ins.sections} 个 section / ${ins.images} 张图 / ${ins.svgs} 个 SVG / ${ins.chars} 字\n` +
        `  渐变      ${ins.gradients} 处\n` +
        `  主色      ${paletteStr || "（未识别）"}\n` +
        `  字号      ${ins.fonts.map(([f, n]) => `${f}×${n}`).join("  ") || "（未识别）"}\n\n` +
        `  正文预览  ${ins.textPreview}\n\n` +
        `下一步：xiumi_steal 搬到账号（可编辑）；xiumi_template_grab 直接导出 HTML。`
    );
  } catch (e) {
    return err(e.message);
  }
}

async function toolTemplateGrab({ target, sid = null, format = "html", save_as = "", save_to_library = false } = {}) {
  try {
    const g = await grabTemplate(target, { sid, cookie: curCookie() });
    const name = save_as || g.info?.title || g.showId;
    const files = persistGrab(g, name);

    const wantMd = format === "md" || format === "markdown";
    const wantTxt = format === "txt" || format === "text";
    let content = g.articleHtml;
    let ext = "html";
    if (wantMd) { content = htmlToMarkdown(g.articleHtml); ext = "md"; }
    if (wantTxt) { content = htmlToText(g.articleHtml); ext = "txt"; }

    ensureDir(EXPORT_DIR);
    const outFile = join(EXPORT_DIR, `${slug(name)}__${g.showId}.${ext}`);
    writeFileSync(outFile, content, "utf8");

    let libNote = "";
    if (save_to_library) {
      ensureDir(LIB_DIR);
      const lf = join(LIB_DIR, `${slug(name)}.json`);
      writeFileSync(
        lf,
        JSON.stringify({ name, source: g.pageUrl, note: `作品 ${g.showId} 公网快照`, savedAt: new Date().toISOString(), html: g.articleHtml }, null, 2),
        "utf8"
      );
      libNote = `\n  已入库    ${lf}`;
    }

    const ins = inspectTemplate(g);
    return ok(
      `【已抓取】${g.info?.title ?? ""}\n` +
        `  作品 ID   ${g.showId}\n` +
        `  内容树    ${files.jsonFile}\n` +
        `  图片清单  ${files.imgFile}（${files.imageCount} 张，去重后可直接做换图素材）\n` +
        `  本地预览  ${files.htmlFile}\n` +
        `  导出文件  ${outFile}（${ext}，${content.length} 字符）${libNote}\n\n` +
        `设计规格：版心 ${g.injected?.showInfo?.exif?.viewport?.WIDTH ?? "?"}px　` +
        `主色 ${ins.colors.slice(0, 4).map(([c, n]) => `${c}×${n}`).join("  ") || "-"}\n` +
        `　　　　　${ins.sections} 个 section / ${ins.images} 张图 / ${ins.chars} 字\n\n` +
        `说明：抓的是秀米的**已发布快照**，组件树已被拍平成 HTML。\n` +
        `· 本地预览与 md/txt 正常可用，适合存档、参考、改文案素材；\n` +
        `· 秀米的「钉位」元素（超大标题等）依赖阅读器 JS 计算高度，静态打开可能错位——这是快照本身的特性；\n` +
        `· 要 1:1 效果或要能继续编辑，请用 xiumi_steal 复制到自己账号，再用秀米自带「复制到公众号」。`
    );
  } catch (e) {
    return err(e.message);
  }
}

async function toolSteal({ target, title = "", replacements = null, save_copy = true, dry_run = false } = {}) {
  try {
    const r = await resolveTarget(target, { cookie: curCookie() });
    const shownId = r.showId;

    if (dry_run) {
      return ok(
        `【演练模式】将把作品 ${shownId} 复制到你账号。\n` +
          `  标题    ${title || "（原标题 - 拷贝）"}\n` +
          `  替换    ${replacements ? `${replacements.length} 条` : "无"}\n\n` +
          `去掉 dry_run 即执行。`
      );
    }

    const { show, source } = await copyShowToAccount(shownId, title);
    const newId = show.show_id;
    const out = {
      新作品ID: newId,
      标题: show.title,
      来源: shownId,
      编辑地址: `${BASE}/studio/v5#/paper/for/${newId}`,
    };

    // 可选：复制完立刻改文案
    let patchNote = "";
    if (Array.isArray(replacements) && replacements.length) {
      const { show: cur, showData } = await fetchShowData(newId);
      const layer = mainLayer(showData);
      let hits = 0;
      for (const rep of replacements) {
        if (!rep?.from) continue;
        const expect = rep.expect ?? null;
        walkItems(layer, (item) => {
          const k = Object.keys(item).find((x) => x !== "_comp" && item[x]?.type === "text");
          if (!k) return;
          const before = String(item[k].text ?? "");
          if (!before.includes(rep.from)) return;
          if (expect !== null) {
            item[k].text = replaceExact(before, rep.from, rep.to ?? "", expect, `steal:${rep.from.slice(0, 20)}`);
          } else {
            item[k].text = before.split(rep.from).join(rep.to ?? "");
          }
          hits++;
        });
      }
      rebuildRaHtml(showData);
      const problems = validateShowData(showData);
      if (problems.length) {
        patchNote = `\n⚠ 文案替换后校验未通过，未回写：\n- ${problems.join("\n- ")}`;
      } else {
        const up = await apiRequest(`/api/shows/${newId}`, { method: "PUT", body: buildUpdatePayload(showData, cur.saved_at) });
        const g = guard(up, "回写文案");
        patchNote = g ? `\n⚠ 文案替换已改 ${hits} 处，但回写失败：${g}` : `\n文案替换 ${hits} 处已回写。`;
      }
    }

    if (!save_copy) out.提示 = "未保存原始快照。";
    return ok(
      `【已搬到自己账号】\n` +
        Object.entries(out).map(([k, v]) => `  ${k}  ${v}`).join("\n") +
        patchNote +
        `\n\n下一步：xiumi_retheme 换配色、xiumi_replace_images 换图、xiumi_publish 出预览链接。`
    );
  } catch (e) {
    return err(e.message);
  }
}

async function toolStealBatch({ targets, title_prefix = "", tag_ids = null, keyword = "", limit = 5, sort = "copy", delay_ms = 800 } = {}) {
  try {
    let list = Array.isArray(targets) ? targets : [];
    if (!list.length) {
      if (!keyword && tag_ids === null) return err("需要 targets 数组，或 keyword / tag_ids 之一来挑选批量目标。");
      const r = await marketSearch({ keyword, tagIds: tag_ids, limit, sort, pages: 1, cookie: curCookie() });
      list = r.items.map((x) => x.show_id);
    }
    list = list.slice(0, Math.max(1, Math.min(20, Number(limit) || 5)));

    const results = [];
    for (const t of list) {
      try {
        const r = await resolveTarget(String(t), { cookie: curCookie() });
        const { show } = await copyShowToAccount(r.showId, title_prefix ? `${title_prefix}${showTitleOf(r, t)}` : "");
        results.push(`✓ ${r.showId} → ${show.show_id}　${show.title ?? ""}`);
      } catch (e) {
        results.push(`✗ ${t}　${String(e.message).split("\n")[0]}`);
      }
      if (delay_ms > 0) await new Promise((res) => setTimeout(res, delay_ms));
    }
    return ok(`批量搬运结果（${results.length} 个）：\n` + results.join("\n"));
  } catch (e) {
    return err(e.message);
  }
}

function showTitleOf(r, fallback) {
  return r?.matched?.title ? ` - ${r.matched.title.slice(0, 20)}` : ` - ${fallback}`;
}

/* ---------- 加工 ---------- */

async function loadOwnShow(show_id) {
  const { show, showData } = await fetchShowData(show_id);
  return { show, showData, layer: mainLayer(showData) };
}

async function commitShow(show, showData, label) {
  rebuildRaHtml(showData);
  const problems = validateShowData(showData);
  if (problems.length) {
    const e = new Error(`${label}后校验未通过，已中止（未写入）：\n- ${problems.join("\n- ")}`);
    e.expected = true;
    throw e;
  }
  const up = await apiRequest(`/api/shows/${show.show_id}`, { method: "PUT", body: buildUpdatePayload(showData, show.saved_at) });
  const g = guard(up, label);
  if (g) {
    const e = new Error(g);
    e.expected = true;
    throw e;
  }
}

async function toolRetheme({ show_id, mapping = null, from = null, to = null, dry_run = false } = {}) {
  try {
    if (!show_id) return err("缺少参数 show_id。");
    const map = mapping ?? (from && to ? { [from]: to } : null);
    if (!map) return err('需要 mapping，例如 {"#c8201a":"#27408B"}；或用 from/to 单色替换。');

    const { show, showData } = await loadOwnShow(show_id);
    const before = palette(showData);
    const r = retheme(showData, map);
    const after = palette(showData);

    const body =
      `【换配色】作品 ${show_id}\n` +
      `  规则      ${Object.entries(map).map(([a, b]) => `${a} → ${b}`).join("，")}\n` +
      `  改动      ${r.changedNodes} 个样式节点 / ${r.changedHtmlTokens} 处渲染缓存\n` +
      `  换前主色  ${before.slice(0, 6).map(([c, n]) => `${c}×${n}`).join("  ")}\n` +
      `  换后主色  ${after.slice(0, 6).map(([c, n]) => `${c}×${n}`).join("  ")}`;

    if (dry_run) return ok(body + `\n\n（演练模式，未写入）`);

    await commitShow(show, showData, "换配色写入");
    return ok(body + `\n\n已写入。打开确认：${BASE}/studio/v5#/paper/for/${show_id}`);
  } catch (e) {
    return err(e.message);
  }
}

async function toolReplaceImages({ show_id, by_index = null, by_src = null, fill_all = "", dry_run = false } = {}) {
  try {
    if (!show_id) return err("缺少参数 show_id。");
    const { show, showData } = await loadOwnShow(show_id);
    const imgs = listImages(showData);
    if (!imgs.length) {
      return err(
        `作品 ${show_id} 里没有可替换的图片组件。\n（如果这是从市场抓来的成品快照，组件树已拍平，无法换图；请先 xiumi_steal 复制成可编辑作品。）`
      );
    }
    const r = replaceImages(showData, { byIndex: by_index ?? [], bySrc: by_src ?? [], fillAll: fill_all });
    if (!r.applied.length) {
      return err(
        `没有命中任何图片。当前共 ${r.total} 张：\n` + imgs.slice(0, 20).map((i) => `  #${i.index}  ${i.src}`).join("\n")
      );
    }
    const lines = r.applied.map((a) => `  #${a.path}  ${String(a.from).slice(0, 70)} → ${String(a.to).slice(0, 70)}`);
    const body = `【换图】作品 ${show_id}：命中 ${r.applied.length} / ${r.total} 张\n` + lines.join("\n");
    if (dry_run) return ok(body + `\n\n（演练模式，未写入）`);
    await commitShow(show, showData, "换图写入");
    return ok(body + `\n\n已写入。`);
  } catch (e) {
    return err(e.message);
  }
}

async function toolExport({ show_id = "", target = "", sid = null, format = "html", save_as = "" } = {}) {
  try {
    let articleHtml = "";
    let title = "";
    let srcInfo = "";
    if (show_id) {
      const { show } = await loadOwnShow(show_id);
      const g = await grabTemplate(String(show_id), { sid: sid || loadSession()?.sid || MARKET_BOARD_SID, cookie: curCookie() });
      articleHtml = g.articleHtml;
      title = g.info?.title ?? show?.title ?? "";
      srcInfo = `作品 ${show_id}（公网快照）`;
    } else if (target) {
      const g = await grabTemplate(target, { sid, cookie: curCookie() });
      articleHtml = g.articleHtml;
      title = g.info?.title ?? "";
      srcInfo = g.pageUrl;
    } else {
      return err("需要 show_id 或 target。");
    }
    if (!articleHtml) return err("没取到文章 HTML。");

    let content = articleHtml;
    let ext = "html";
    if (format === "md" || format === "markdown") { content = htmlToMarkdown(articleHtml); ext = "md"; }
    else if (format === "txt" || format === "text") { content = htmlToText(articleHtml); ext = "txt"; }

    ensureDir(EXPORT_DIR);
    const file = join(EXPORT_DIR, `${slug(save_as || title || show_id || "xiumi")}.${ext}`);
    writeFileSync(file, content, "utf8");
    return ok(`【已导出 ${ext.toUpperCase()}】${title}\n  来源  ${srcInfo}\n  文件  ${file}\n  大小  ${content.length} 字符\n\n` + (ext === "html" ? "" : content.slice(0, 600)));
  } catch (e) {
    return err(e.message);
  }
}

/* ---------- 快照 ---------- */

async function toolSnapshot({ show_id, action = "create", keep = 20 } = {}) {
  try {
    if (!show_id) return err("缺少参数 show_id。");
    if (action === "list") {
      const list = listSnapshots(SNAP_DIR, show_id);
      if (!list.length) return ok(`作品 ${show_id} 还没有快照。`);
      return ok(
        `作品 ${show_id} 共 ${list.length} 个快照（新的在前）：\n` +
          list.map((s, i) => `  #${i}  ${s.name}`).join("\n")
      );
    }
    const { showData } = await loadOwnShow(show_id);
    const file = saveSnapshot(SNAP_DIR, show_id, showData, { title: showData.title });
    const pruned = pruneSnapshots(SNAP_DIR, show_id, keep);
    return ok(`已保存快照：${file}` + (pruned ? `\n（已清理 ${pruned} 个旧快照，保留最新 ${keep} 个）` : ""));
  } catch (e) {
    return err(e.message);
  }
}

async function toolRestore({ show_id, which = 0, dry_run = false } = {}) {
  try {
    if (!show_id) return err("缺少参数 show_id。");
    const snap = loadSnapshot(SNAP_DIR, show_id, which);
    const { show } = await loadOwnShow(show_id);
    const problems = validateShowData(snap.showData);
    if (problems.length) return err(`快照本身校验不通过，已中止：\n- ${problems.join("\n- ")}`);
    if (dry_run) return ok(`【演练】将用快照 ${snap.name} 覆盖作品 ${show_id}（校验通过）。`);
    // 覆盖前先存一份当前状态，方便撤销
    const { showData: cur } = await loadOwnShow(show_id);
    saveSnapshot(SNAP_DIR, show_id, cur, { title: cur.title, reason: "restore 前自动备份" });
    await commitShow(show, snap.showData, "快照回滚");
    return ok(`已回滚到快照：${snap.name}\n当前状态已自动另存，可再次回滚撤销。`);
  } catch (e) {
    return err(e.message);
  }
}


/* ============================================================
 *  工具注册
 * ============================================================ */

const TOOLS = [
  {
    name: "xiumi_set_cookie",
    description: "配置秀米会话：传入浏览器复制的完整 Cookie 字符串，校验成功后保存。首次使用或会话过期时调用。",
    inputSchema: { type: "object", properties: { cookie: { type: "string", description: "xiumi.us 请求的整串 Cookie 值（含 sid）" } }, required: ["cookie"] },
  },
  { name: "xiumi_whoami", description: "查看当前登录的秀米账号（昵称/user_sid/uid），同时用于测试会话是否有效。", inputSchema: { type: "object", properties: {} } },
  {
    name: "xiumi_list_shows",
    description: "列出我账号下的秀米作品（图文草稿），返回 ID、标题、更新时间与编辑地址。",
    inputSchema: { type: "object", properties: { page: { type: "number", description: "页码，默认 1" }, count: { type: "number", description: "每页数量，默认 20" } } },
  },
  {
    name: "xiumi_get_show",
    description: "获取作品元数据 + 内容大纲（每个组件的路径/类型/文本摘要），用于了解结构后再精准修改。",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "作品 ID" }, include_outline: { type: "boolean", description: "是否返回内容大纲，默认 true" } }, required: ["id"] },
  },
  {
    name: "xiumi_get_showdata",
    description: "获取作品的完整内容树 JSON（showData），可选保存到本地文件做精细处理。",
    inputSchema: { type: "object", properties: { id: { type: "string" }, save_as: { type: "string", description: "保存名（不含扩展名，落到 out/ 目录）" }, path: { type: "string", description: "绝对路径（优先于 save_as）" } }, required: ["id"] },
  },
  {
    name: "xiumi_get_show_html",
    description: "获取模板/作品的干净内联样式 HTML（剥离渲染属性）。市场模板传 url（商品 show_url），自己的作品传 id。save_name 可同时入库。",
    inputSchema: { type: "object", properties: { id: { type: "string" }, url: { type: "string" }, save_name: { type: "string" } } },
  },
  {
    name: "xiumi_create_draft",
    description:
      "【新建草稿】在秀米账号下新建一篇图文。可直接传 blocks 写入内容。blocks 元素支持：{type:'text',html:'<p>…</p>'}、{type:'image',src:'//…'}、{type:'row',cols:[[块],[块]]}、{type:'raw',value:{…组件…}}。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "草稿标题" },
        cover: { type: "string", description: "封面图 URL（可选）" },
        blocks: { type: "array", description: "内容组件数组，见描述", items: { type: "object" } },
        return_content: { type: "boolean", description: "是否在返回中附带完整内容树" },
      },
      required: ["title"],
    },
  },
  {
    name: "xiumi_append_blocks",
    description: "向已有作品的指定位置插入组件（blocks 格式同 xiumi_create_draft）。position 可为 'end'（默认）/'start'/数字下标。",
    inputSchema: {
      type: "object",
      properties: {
        show_id: { type: "string" },
        blocks: { type: "array", items: { type: "object" } },
        position: { description: "'end' | 'start' | 数字下标", type: ["string", "number"] },
      },
      required: ["show_id", "blocks"],
    },
  },
  {
    name: "xiumi_replace_text",
    description: "在作品内批量做精确文本/HTML 替换（带出现次数断言，防误改），并同步渲染缓存后提交。适合改标题、换文案、调样式。",
    inputSchema: {
      type: "object",
      properties: {
        show_id: { type: "string" },
        replacements: {
          type: "array",
          description: "替换列表；expect 为该串在单个文本块内应出现的次数（默认 1）",
          items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, expect: { type: "number" } }, required: ["from", "to"] },
        },
        expect_each: { type: "number", description: "默认期望次数，默认 1" },
      },
      required: ["show_id", "replacements"],
    },
  },
  {
    name: "xiumi_update_showdata",
    description: "用完整内容树覆盖作品（高级用法）。提交前会做结构校验，不通过则拒绝写入。",
    inputSchema: {
      type: "object",
      properties: { show_id: { type: "string" }, content: { description: "内容树 JSON 字符串或对象" }, content_file: { type: "string", description: "内容树 JSON 文件路径" }, title: { type: "string" } },
      required: ["show_id"],
    },
  },
  {
    name: "xiumi_validate_showdata",
    description: "校验内容树是否合法（结构 + HTML 标签平衡），可在写入前离线体检，或直接体检线上作品。",
    inputSchema: { type: "object", properties: { show_id: { type: "string" }, content: {}, content_file: { type: "string" } } },
  },
  {
    name: "xiumi_publish",
    description: "【发布】把作品内容定稿回写、生成手机预览链接与本地快照，用于复制到公众号前的最终确认。",
    inputSchema: { type: "object", properties: { show_id: { type: "string" }, title: { type: "string", description: "可选，同时改标题" } }, required: ["show_id"] },
  },
  {
    name: "xiumi_copy_show",
    description: "复制作品/市场模板到自己账号（含秀米官方模板，自动计算动作令牌）。市场模板先用 xiumi_search_goods 拿到 show_id。",
    inputSchema: { type: "object", properties: { from_show_id: { type: "string" }, title: { type: "string", description: "新标题，默认「原标题 - 拷贝」" } }, required: ["from_show_id"] },
  },
  {
    name: "xiumi_delete_show",
    description: "删除作品（不可恢复）。必须显式传 confirm: true。",
    inputSchema: { type: "object", properties: { show_id: { type: "string" }, confirm: { type: "boolean" } }, required: ["show_id", "confirm"] },
  },
  { name: "xiumi_goods_tags_tree", description: "模板市场分类标签树（供 xiumi_search_goods 的 tag_id 使用）。", inputSchema: { type: "object", properties: {} } },
  {
    name: "xiumi_search_goods",
    description: "搜索模板市场。支持 search 关键词与 tag_id/tag_name 分类过滤。",
    inputSchema: { type: "object", properties: { search: { type: "string" }, keyword: { type: "string", description: "search 的别名" }, tag_id: { type: "string" }, tag_name: { type: "string" }, page: { type: "number" }, limit: { type: "number" } } },
  },
  { name: "xiumi_list_favorites", description: "列出我收藏的模板素材。", inputSchema: { type: "object", properties: { page: { type: "number" }, count: { type: "number" } } } },
  {
    name: "xiumi_request",
    description: "通用透传：向秀米发起带会话的任意请求，用于探索/适配未封装接口。",
    inputSchema: { type: "object", properties: { method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"] }, path: { type: "string" }, query: { type: "object" }, body: { type: "object" } }, required: ["path"] },
  },
  {
    name: "xiumi_save_to_library",
    description: "把卡片模板 HTML 保存到本地素材库（不依赖会话）。",
    inputSchema: { type: "object", properties: { name: { type: "string" }, html: { type: "string" }, source: { type: "string" }, note: { type: "string" } }, required: ["name", "html"] },
  },
  { name: "xiumi_list_library", description: "列出本地素材库。", inputSchema: { type: "object", properties: {} } },
  { name: "xiumi_get_library", description: "读取本地素材库中某个模板的 HTML。", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "xiumi_delete_library", description: "删除本地素材库中的模板。", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },

  /* ---- 模板市场与采集 ---- */
  {
    name: "xiumi_market_categories",
    description: "模板市场分类清单（用途/行业/节假/风格/色调），返回 tag_id 与分类名，供 xiumi_market_search 过滤。",
    inputSchema: { type: "object", properties: { show_type: { type: "string", description: "默认 paper（图文）" } } },
  },
  {
    name: "xiumi_market_search",
    description:
      "【找模板】搜索秀米模板市场。keyword 关键词（需登录）、tag_ids 分类（数字 id 或分类名，如「节假」）、sort 排序（relevance/copy/collect/hit/new）。返回 show_id 与公网预览链接。",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string" },
        tag_ids: { description: "分类：数字 id、id 数组，或分类名" },
        page: { type: "number" },
        limit: { type: "number", description: "每页条数，默认 20（上限 50）" },
        pages: { type: "number", description: "聚合页数，默认 1；聚合后再排序可得到跨页排行榜" },
        sort: { type: "string", enum: ["relevance", "copy", "collect", "hit", "new"] },
        as_json: { type: "boolean", description: "返回原始 JSON" },
      },
    },
  },
  {
    name: "xiumi_market_hot",
    description: "模板市场热门榜：多页采样后按 使用量/收藏量/浏览量/更新时间 重排。",
    inputSchema: {
      type: "object",
      properties: { metric: { type: "string", enum: ["copy", "collect", "hit", "new"] }, pages: { type: "number" }, limit: { type: "number" }, tag_ids: {} },
    },
  },
  {
    name: "xiumi_template_inspect",
    description:
      "【模板体检·免登录】给作品 ID 或公网预览链接，返回结构规模（组件数/图片数/SVG/字数）、主色板、字号分布与正文预览，用于判断值不值得抄。",
    inputSchema: { type: "object", properties: { target: { type: "string", description: "作品 ID 或 preview 链接" }, sid: { type: "string", description: "可选，预览地址里的 board 短码" } }, required: ["target"] },
  },
  {
    name: "xiumi_template_grab",
    description:
      "【抓模板·免登录】把任意模板/作品的已发布成品抓成本地文件：内容树 JSON + 可直接打开的预览 HTML + 可选 md/txt。免登录，抓到的是成品 HTML（组件已拍平），适合直接粘公众号或做参考。",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "作品 ID 或公网预览链接" },
        sid: { type: "string" },
        format: { type: "string", enum: ["html", "md", "txt"] },
        save_as: { type: "string", description: "保存名（不含扩展名）" },
        save_to_library: { type: "boolean", description: "同时存入本地素材库" },
      },
      required: ["target"],
    },
  },
  {
    name: "xiumi_steal",
    description:
      "【一键搬模板·需登录】把市场模板/任意作品复制到自己账号（可继续编辑）。target 支持 show_id、预览链接或关键词；可同时批量替换文案。dry_run 可先演练。",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string" },
        title: { type: "string", description: "新作品标题" },
        replacements: { type: "array", items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, expect: { type: "number" } } } },
        dry_run: { type: "boolean" },
      },
      required: ["target"],
    },
  },
  {
    name: "xiumi_steal_batch",
    description: "【批量搬模板·需登录】按 keyword/tag_ids 或显式 targets 列表批量复制到自己账号，带限速与逐条结果报告。",
    inputSchema: {
      type: "object",
      properties: {
        targets: { type: "array", items: { type: "string" } },
        keyword: { type: "string" },
        tag_ids: {},
        title_prefix: { type: "string" },
        limit: { type: "number", description: "最多搬几个，默认 5（上限 20）" },
        sort: { type: "string", enum: ["relevance", "copy", "collect", "hit", "new"] },
        delay_ms: { type: "number", description: "每个之间停顿，默认 800ms" },
      },
    },
  },

  /* ---- 内容加工 ---- */
  {
    name: "xiumi_retheme",
    description: "【一键换配色】递归替换作品里的配色（样式树 + 渲染缓存同步），适合把红色党建模板改成蓝紫风。mapping 形如 {\"#c8201a\":\"#27408B\"}。",
    inputSchema: {
      type: "object",
      properties: {
        show_id: { type: "string" },
        mapping: { type: "object", description: "颜色映射 {旧:新}" },
        from: { type: "string", description: "单色替换的旧色" },
        to: { type: "string", description: "单色替换的新色" },
        dry_run: { type: "boolean" },
      },
      required: ["show_id"],
    },
  },
  {
    name: "xiumi_replace_images",
    description: "【批量换图】按索引或原图 URL 子串替换作品中的图片。先只看不动可用 dry_run。",
    inputSchema: {
      type: "object",
      properties: {
        show_id: { type: "string" },
        by_index: { type: "array", items: { type: "object", properties: { index: { type: "number" }, src: { type: "string" } } } },
        by_src: { type: "array", items: { type: "object", properties: { match: { type: "string" }, src: { type: "string" } } } },
        fill_all: { type: "string", description: "把所有图统一换成这一张" },
        dry_run: { type: "boolean" },
      },
      required: ["show_id"],
    },
  },
  {
    name: "xiumi_export",
    description: "导出作品为 html/md/txt。html 为可直接粘进公众号的内联样式版本。",
    inputSchema: {
      type: "object",
      properties: { show_id: { type: "string" }, target: { type: "string" }, sid: { type: "string" }, format: { type: "string", enum: ["html", "md", "txt"] }, save_as: { type: "string" } },
    },
  },
  {
    name: "xiumi_snapshot",
    description: "版本快照：action=create 存一份当前内容树；action=list 查看历史。写坏之前先存，可随时回滚。",
    inputSchema: {
      type: "object",
      properties: { show_id: { type: "string" }, action: { type: "string", enum: ["create", "list"] }, keep: { type: "number", description: "最多保留几份，默认 20" } },
      required: ["show_id"],
    },
  },
  {
    name: "xiumi_restore",
    description: "把作品回滚到某个快照（which=0 为最新）。回滚前会自动备份当前状态，可撤销。",
    inputSchema: { type: "object", properties: { show_id: { type: "string" }, which: { description: "序号或快照文件名，默认 0" }, dry_run: { type: "boolean" } }, required: ["show_id"] },
  },
];

const HANDLERS = {
  xiumi_set_cookie: toolSetCookie,
  xiumi_whoami: toolWhoami,
  xiumi_list_shows: toolListShows,
  xiumi_get_show: toolGetShow,
  xiumi_get_showdata: toolGetShowData,
  xiumi_get_show_html: toolGetShowHtml,
  xiumi_create_draft: toolCreateDraft,
  xiumi_append_blocks: toolAppendBlocks,
  xiumi_replace_text: toolReplaceText,
  xiumi_update_showdata: toolUpdateShowData,
  xiumi_validate_showdata: toolValidate,
  xiumi_publish: toolPublish,
  xiumi_copy_show: toolCopyShow,
  xiumi_delete_show: toolDeleteShow,
  xiumi_goods_tags_tree: toolGoodsTagsTree,
  xiumi_search_goods: toolSearchGoods,
  xiumi_list_favorites: toolListFavorites,
  xiumi_request: toolRequest,
  xiumi_save_to_library: toolSaveToLibrary,
  xiumi_list_library: toolListLibrary,
  xiumi_get_library: toolGetLibrary,
  xiumi_delete_library: toolDeleteLibrary,
  xiumi_market_categories: toolMarketCategories,
  xiumi_market_search: toolMarketSearch,
  xiumi_market_hot: toolMarketHot,
  xiumi_template_inspect: toolTemplateInspect,
  xiumi_template_grab: toolTemplateGrab,
  xiumi_steal: toolSteal,
  xiumi_steal_batch: toolStealBatch,
  xiumi_retheme: toolRetheme,
  xiumi_replace_images: toolReplaceImages,
  xiumi_export: toolExport,
  xiumi_snapshot: toolSnapshot,
  xiumi_restore: toolRestore,
};

/* ============================================================
 *  JSON-RPC (stdio)
 * ============================================================ */

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

async function dispatch(method, params, id) {
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "xiumi-connector", version: VERSION },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params?.name;
      const handler = HANDLERS[name];
      if (!handler) return replyError(id, -32602, `未知工具：${name}`);
      try {
        reply(id, await handler(params?.arguments ?? {}));
      } catch (e) {
        reply(id, err(`工具执行异常：${e?.stack || e?.message || String(e)}`));
      }
      return;
    }
    default:
      if (id !== undefined && id !== null) replyError(id, -32601, `未知方法：${method}`);
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    return;
  }
  dispatch(msg.method, msg.params, msg.id).catch((e) => {
    if (msg.id !== undefined && msg.id !== null) replyError(msg.id, -32603, String(e?.message || e));
  });
});
rl.on("close", () => process.exit(0));
setInterval(() => {}, 1 << 30);
