/**
 * 秀米 · 内容加工模块（零依赖）
 *
 * 全部是纯函数（除快照落盘），作用对象是**可编辑内容树**（showData），
 * 也就是自己账号里的作品。市场模板抓下来的成品 HTML 不含组件树，
 * 请先「复制到自己账号」再做换肤/换图。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/* ============================================================
 *  一、颜色处理
 * ============================================================ */

/** #abc → #aabbcc；rgb(1,2,3) → #010203；非法值原样返回小写 */
export function normalizeColor(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return s;
  let m = s.match(/^#([0-9a-f]{3})$/);
  if (m) return "#" + m[1].split("").map((c) => c + c).join("");
  m = s.match(/^#([0-9a-f]{4})$/);
  if (m) return "#" + m[1].split("").map((c) => c + c).join("");
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (m) {
    const hex = (n) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, "0");
    return "#" + hex(m[1]) + hex(m[2]) + hex(m[3]);
  }
  return s;
}

/** 把用户给的 {旧色: 新色} 规范化成一张替换表（均转小写六位 hex） */
export function buildColorMap(mapping) {
  const map = new Map();
  for (const [from, to] of Object.entries(mapping ?? {})) {
    const f = normalizeColor(from);
    const t = String(to ?? "").trim();
    if (!f || !t) continue;
    map.set(f, t);
  }
  return map;
}

const COLOR_TOKEN = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{4}\b|#[0-9a-fA-F]{3}\b|rgba?\([^)]*\)/g;

/** 在一段 CSS 字符串里做颜色替换（保留未命中的原样） */
export function replaceColorsInString(str, colorMap) {
  if (!colorMap || !colorMap.size) return str;
  return String(str).replace(COLOR_TOKEN, (token) => {
    const key = normalizeColor(token);
    return colorMap.has(key) ? colorMap.get(key) : token;
  });
}

/* ============================================================
 *  二、遍历
 * ============================================================ */

/** 深度遍历内容树里的所有 style 对象（含 _comp.style、叶子 style、分栏 col.style） */
export function walkStyles(node, cb, path = "$") {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkStyles(v, cb, `${path}[${i}]`));
    return;
  }
  if (node.style && typeof node.style === "object") cb(node.style, path + ".style");
  for (const [k, v] of Object.entries(node)) {
    if (k === "style") continue;
    if (v && typeof v === "object") walkStyles(v, cb, `${path}.${k}`);
  }
}

/** 列出所有图片叶子（可编辑树里的 img 节点） */
export function listImages(showData) {
  const out = [];
  const layer = showData?.cubes?.[0]?.pages?.[0]?.layers?.[0];
  const walk = (items, base = "") => {
    (items ?? []).forEach((item, i) => {
      const p = base ? `${base}/${i}` : String(i);
      for (const [k, v] of Object.entries(item ?? {})) {
        if (k === "_comp" || !v || typeof v !== "object") continue;
        if (v.type === "image") out.push({ path: p, slot: k, src: v.src ?? "", index: out.length });
        if (Array.isArray(v.items)) walk(v.items, `${p}:${k}`);
      }
    });
  };
  walk(layer?.comps?.items);
  return out;
}

/* ============================================================
 *  三、一键换配色
 * ============================================================ */

/**
 * 递归替换内容树里的配色。
 * @param {object} showData 可编辑内容树（原地修改）
 * @param {object} mapping  { "#c8201a": "#27408B" }
 * @returns {{changedNodes:number, changedHtmlTokens:number, palette:string[][]}}
 */
export function retheme(showData, mapping) {
  const colorMap = buildColorMap(mapping);
  if (!colorMap.size) throw new Error("换配色需要 mapping，例如 { \"#c8201a\": \"#27408B\" }。");

  let changedNodes = 0;
  walkStyles(showData, (style) => {
    let touched = false;
    for (const [k, v] of Object.entries(style)) {
      if (typeof v !== "string") continue;
      const next = replaceColorsInString(v, colorMap);
      if (next !== v) { style[k] = next; touched = true; }
    }
    if (touched) changedNodes++;
  });

  // 渲染缓存里的颜色同样要跟着换，否则编辑器里会出现新旧色混杂
  let changedHtmlTokens = 0;
  const layer = showData?.cubes?.[0]?.pages?.[0]?.layers?.[0];
  if (layer?._comp && typeof layer._comp._$raHTML === "string") {
    const before = layer._comp._$raHTML;
    const after = replaceColorsInString(before, colorMap);
    if (after !== before) {
      changedHtmlTokens = (before.match(COLOR_TOKEN) || []).filter((t) => colorMap.has(normalizeColor(t))).length;
      layer._comp._$raHTML = after;
    }
  }
  return { changedNodes, changedHtmlTokens, palette: palette(showData) };
}

/** 统计内容树里出现最多的颜色（用于给用户挑「主色」） */
export function palette(showData, limit = 12) {
  const counts = new Map();
  const bump = (token) => {
    const k = normalizeColor(token);
    if (!/^#[0-9a-f]{6}$/.test(k)) return;
    counts.set(k, (counts.get(k) || 0) + 1);
  };
  walkStyles(showData, (style) => {
    for (const v of Object.values(style)) {
      if (typeof v !== "string") continue;
      for (const t of v.match(COLOR_TOKEN) || []) bump(t);
    }
  });
  const layer = showData?.cubes?.[0]?.pages?.[0]?.layers?.[0];
  if (typeof layer?._comp?._$raHTML === "string") {
    for (const t of layer._comp._$raHTML.match(COLOR_TOKEN) || []) bump(t);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([c, n]) => [c, n]);
}

/* ============================================================
 *  四、批量换图
 * ============================================================ */

/**
 * 批量替换图片。
 * 规则优先级：by_path > by_src > by_index > fill_all
 * @param {object} showData
 * @param {object} o
 * @param {Array<{path:string, src:string}>} [o.byPath]
 * @param {Array<{match:string, src:string}>} [o.bySrc]    match 为原图 URL 的子串
 * @param {Array<{index:number, src:string}>} [o.byIndex] 0 起
 * @param {string} [o.fillAll]                             统一切成同一张（慎用）
 * @param {number} [o.limit]                               只替换前 N 张
 */
export function replaceImages(showData, { byPath = [], bySrc = [], byIndex = [], fillAll = "", limit = 0 } = {}) {
  const imgs = listImages(showData);
  const applied = [];

  // 建立 path → 节点引用
  const nodeByPath = new Map();
  const layer = showData?.cubes?.[0]?.pages?.[0]?.layers?.[0];
  const walk = (items, base = "") => {
    (items ?? []).forEach((item, i) => {
      const p = base ? `${base}/${i}` : String(i);
      for (const [k, v] of Object.entries(item ?? {})) {
        if (k === "_comp" || !v || typeof v !== "object") continue;
        if (v.type === "image") nodeByPath.set(p, v);
        if (Array.isArray(v.items)) walk(v.items, `${p}:${k}`);
      }
    });
  };
  walk(layer?.comps?.items);

  const setSrc = (p, src, how) => {
    const node = nodeByPath.get(p);
    if (!node || !src) return false;
    applied.push({ path: p, from: node.src, to: src, how });
    node.src = src;
    return true;
  };

  const seen = new Set();
  for (const r of byPath) {
    if (setSrc(r.path, r.src, "path")) seen.add(r.path);
  }
  for (const r of bySrc) {
    if (!r.match) continue;
    for (const im of imgs) {
      if (seen.has(im.path)) continue;
      if (String(im.src).includes(r.match)) {
        if (setSrc(im.path, r.src, "src")) seen.add(im.path);
      }
    }
  }
  for (const r of byIndex) {
    const im = imgs[Number(r.index)];
    if (im && !seen.has(im.path) && setSrc(im.path, r.src, "index")) seen.add(im.path);
  }
  if (fillAll) {
    const max = limit > 0 ? limit : imgs.length;
    for (const im of imgs.slice(0, max)) {
      if (seen.has(im.path)) continue;
      if (setSrc(im.path, fillAll, "fillAll")) seen.add(im.path);
    }
  }

  // 同步渲染缓存：直接把旧 src 字符串换掉，比整体重算更安全（不丢模板细节）
  if (applied.length && typeof layer?._comp?._$raHTML === "string") {
    let html = layer._comp._$raHTML;
    for (const a of applied) {
      if (!a.from || !a.to || a.from === a.to) continue;
      const variants = new Set([a.from, a.from.replace(/^https?:/, "")]);
      for (const v of variants) {
        if (v && html.includes(v)) html = html.split(v).join(a.to);
      }
    }
    layer._comp._$raHTML = html;
  }

  return { applied, total: imgs.length };
}

/* ============================================================
 *  五、快照
 * ============================================================ */

function ensureDir(d) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

/**
 * 保存快照到磁盘。
 * @returns {string} 快照文件路径
 */
export function saveSnapshot(dir, showId, showData, meta = {}) {
  ensureDir(dir);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `${showId}__${ts}.json`);
  writeFileSync(
    file,
    JSON.stringify({ show_id: String(showId), savedAt: new Date().toISOString(), meta, showData }, null, 2),
    "utf8"
  );
  return file;
}

/** 列出某作品的快照（新的在前） */
export function listSnapshots(dir, showId) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(`${showId}__`) && f.endsWith(".json"))
    .sort()
    .reverse()
    .map((f) => {
      const p = join(dir, f);
      let meta = {};
      try {
        const j = JSON.parse(readFileSync(p, "utf8"));
        meta = { savedAt: j.savedAt, ...j.meta };
      } catch { /* 忽略坏文件 */ }
      return { file: p, name: f, ...meta };
    });
}

/** 读取快照；which 为序号（0 = 最新）或文件名 */
export function loadSnapshot(dir, showId, which = 0) {
  const list = listSnapshots(dir, showId);
  if (!list.length) throw new Error(`作品 ${showId} 没有历史快照。`);
  const hit = typeof which === "number" ? list[which] : list.find((s) => s.name === which || s.file === which);
  if (!hit) throw new Error(`找不到快照 ${which}（共 ${list.length} 个）。`);
  const j = JSON.parse(readFileSync(hit.file, "utf8"));
  return { ...hit, showData: j.showData };
}

/** 删除旧快照，只保留最新 keep 个 */
export function pruneSnapshots(dir, showId, keep = 20) {
  const list = listSnapshots(dir, showId);
  const drop = list.slice(keep);
  for (const s of drop) {
    try { unlinkSync(s.file); } catch { /* 忽略 */ }
  }
  return drop.length;
}
