/**
 * 秀米 · 模板市场与采集模块（零依赖）
 *
 * 两条独立通道：
 *   A. 市场通道 —— /api/show_goods/*，只读商品数据（搜索、分类、榜单）
 *      列表接口匿名可用；带 search 关键词时需登录。
 *   B. 公网快照通道 —— v.xiumius.cn 预览页 → injectedData.showInfo.show_data_url
 *      → CDN 上的已发布内容树（gzip JSON）。**全程免登录**。
 *
 * 「偷模板」的两种落地方式：
 *   1) 复制到自己的账号（可继续编辑）—— 走 /api/shows/v5/paper?from_show_id=，需登录，见 server.mjs
 *   2) 抓取成品 HTML（可直接粘进公众号）—— 走 B 通道，免登录，见 grabTemplate()
 *
 * 逆向与实测记录（2026-10）：市场列表 board 短码恒为 3FOLa，与卖家 user_sid 无关，
 * 因此任意市场作品都可用 https://v.xiumius.cn/board/v5/3FOLa/<show_id> 取到公网快照。
 */

import { gunzipSync } from "node:zlib";

export const MARKET_BASE = "https://xiumi.us";
export const PREVIEW_HOSTS = ["v.xiumius.cn", "a.xiumius.cn", "r.xiumius.cn"];
/** 市场作品公网预览的通用 board 短码（实测：与作者 user_sid 无关，恒定于此值） */
export const MARKET_BOARD_SID = "3FOLa";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/* ============================================================
 *  一、基础 HTTP（匿名 / 可指定 Cookie）
 * ============================================================ */

/**
 * 抓文本或 JSON：自动解 gzip、自动重试、可选携带 Cookie。
 * @returns {Promise<{status:number, url:string, text:string, json:any, bytes:number}>}
 */
export async function fetchLoose(url, { cookie = "", headers = {}, retries = 2, timeout = 30000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/json,application/xhtml+xml,*/*;q=0.8",
          "Accept-Encoding": "gzip, deflate",
          "Accept-Language": "zh-CN,zh;q=0.9",
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(timeout),
      });
      const buf = Buffer.from(await res.arrayBuffer());
      let raw = buf;
      if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        try { raw = gunzipSync(buf); } catch { /* 保留原样 */ }
      }
      const text = raw.toString("utf8");
      let json = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON */ }
      return { status: res.status, url: res.url, text, json, bytes: buf.length };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/* ============================================================
 *  二、标识解析
 * ============================================================ */

/**
 * 从各种形态的输入里解析出 show_id 与可选 sid。
 * 支持：纯数字 / 作品编辑链接 / 公网预览链接 / bang 链接
 * @returns {{showId:string, sid:string|null, kind:string}|null}
 */
export function parseShowTarget(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{5,}$/.test(s)) return { showId: s, sid: null, kind: "id" };

  // /board/v5/<sid>/<showId>
  let m = s.match(/\/board\/v\d+\/([A-Za-z0-9_-]+)\/(\d+)/);
  if (m) return { showId: m[2], sid: m[1], kind: "preview" };

  // /studio/v5#/paper/for/<showId>
  m = s.match(/paper\/for\/(\d+)/);
  if (m) return { showId: m[1], sid: null, kind: "studio" };

  // 兜底：URL 里最后一个长数字
  m = s.match(/(\d{6,})/);
  if (m) return { showId: m[1], sid: null, kind: "guess" };

  return null;
}

/** 由 show_id 构造公网预览地址（市场通用 board） */
export function previewUrl(showId, sid = MARKET_BOARD_SID) {
  return `https://v.xiumius.cn/board/v5/${sid || MARKET_BOARD_SID}/${showId}`;
}

/* ============================================================
 *  三、市场：分类 / 搜索 / 榜单
 * ============================================================ */

/** 拉取分类树（默认两级：根 + 用途/行业/节假/风格/色调） */
export async function marketTags({ showType = "paper" } = {}) {
  const url = `${MARKET_BASE}/api/show_goods/tags_tree?show_type=${encodeURIComponent(showType)}&tag_level_from=1&tag_level_to=2`;
  const r = await fetchLoose(url);
  if (r.json?.code !== 0) {
    throw new Error(`分类树读取失败（HTTP ${r.status}）：${r.text.slice(0, 200)}`);
  }
  return flattenTags(r.json.data ?? []);
}

/** 把嵌套分类树拍平成 [{tag_id, name, level, path}]（跳过 L2 根节点，不进路径） */
export function flattenTags(nodes, path = []) {
  const out = [];
  for (const n of nodes ?? []) {
    const isRoot = n.tag_level === 2;
    const p = isRoot ? path : [...path, n.tag_name];
    if (!isRoot) out.push({ tag_id: n.tag_id, name: n.tag_name, level: n.tag_level, path: p.join(" / ") });
    const kids = n.childTags ?? [];
    if (kids.length) out.push(...flattenTags(kids, p));
  }
  return out;
}

/**
 * 市场搜索。
 * 注意：带 keyword 时秀米要求登录（匿名返回 -102），本函数会抛出可读错误。
 *
 * @param {object} o
 * @param {string} [o.keyword]
 * @param {number|number[]} [o.tagIds]
 * @param {string} [o.cookie]        传入则视为已登录
 * @param {number} [o.pages=1]       聚合页数（每页上限 50）
 * @param {string} [o.sort]          relevance | copy | collect | hit | new
 */
export async function marketSearch({
  keyword = "",
  tagIds = null,
  showType = "paper",
  showGoodsType = "paper",
  page = 1,
  limit = 20,
  pages = 1,
  sort = "relevance",
  cookie = "",
} = {}) {
  const collected = [];
  let total = null;
  const start = Math.max(1, Number(page) || 1);
  const nPages = Math.max(1, Math.min(10, Number(pages) || 1));
  const per = Math.max(1, Math.min(50, Number(limit) || 20));

  for (let i = 0; i < nPages; i++) {
    const qs = new URLSearchParams({
      show_type: showType,
      showgoods_type: showGoodsType,
      page: String(start + i),
      limit: String(per),
      price_scope: "0",
      by_nearest: "0",
      tpl_flag: "0",
    });
    if (keyword) qs.set("search", keyword);
    if (tagIds !== null && tagIds !== undefined && tagIds !== "") {
      const arr = Array.isArray(tagIds) ? tagIds : [tagIds];
      if (arr.length) qs.set("tag_ids", arr.join(","));
    }
    const r = await fetchLoose(`${MARKET_BASE}/api/show_goods/goodses?${qs}`, { cookie });
    if (r.json?.code === -102 || r.json?.code === -101 || r.status === 401) {
      const e = new Error(
        keyword
          ? `关键词搜索需要登录后使用（秀米对 /goodses?search= 做了登录校验）。\n请先执行：xiumi login --file cookie.txt 或点 status.cmd 登录。`
          : "访问模板市场被要求登录，请先登录秀米账号。"
      );
      e.expected = true;
      throw e;
    }
    if (r.json?.code !== 0) throw new Error(`市场搜索失败（HTTP ${r.status}）：${r.text.slice(0, 300)}`);
    const d = r.json.data ?? {};
    if (total === null) total = d.count ?? null;
    const list = d.goodses ?? [];
    collected.push(...list.map(normalizeGoods));
    if (list.length < per) break; // 已到末页
  }

  return { total, items: sortGoods(collected, sort) };
}

/** 归一化商品条目，只保留对使用者有用的字段 */
export function normalizeGoods(g) {
  const s = g.show ?? {};
  const seller = g.seller ?? {};
  return {
    show_goods_id: g.show_goods_id ?? null,
    show_id: String(g.show_id ?? s.show_id ?? ""),
    title: s.title ?? "(未命名)",
    desc: s.desc ?? "",
    cover: absUrl(s.cover),
    price: g.price ?? 0,
    copy_number: g.copy_number ?? 0,
    collected_number: g.collected_number ?? 0,
    hit_count: s.hit_count ?? 0,
    seller: seller.nickname ?? "",
    seller_sid: seller.user_sid ?? "",
    show_url: s.show_url || previewUrl(g.show_id ?? s.show_id),
    edit_url: s.edit_url ?? "",
    created_at: g.created_at ?? "",
    updated_at: g.updated_at ?? "",
  };
}

export function sortGoods(items, sort = "relevance") {
  const arr = [...items];
  const by = {
    copy: (a, b) => b.copy_number - a.copy_number,
    collect: (a, b) => b.collected_number - a.collected_number,
    hit: (a, b) => b.hit_count - a.hit_count,
    new: (a, b) => String(b.updated_at).localeCompare(String(a.updated_at)),
  };
  if (by[sort]) arr.sort(by[sort]);
  return arr;
}

/** 热门榜：多页聚合后按使用量/收藏量重排 */
export async function marketHot({ metric = "copy", pages = 3, limit = 20, cookie = "", tagIds = null } = {}) {
  const { total, items } = await marketSearch({ pages, limit: 50, cookie, tagIds, sort: metric });
  return { total, items: items.slice(0, limit), metric };
}

function absUrl(u) {
  const s = String(u ?? "");
  if (!s) return "";
  if (s.startsWith("//")) return "https:" + s;
  return s;
}

/* ============================================================
 *  四、公网快照：预览页 → 内容树
 * ============================================================ */

/**
 * 解析预览页里的 injectedData（showInfo / SYSTEM_SETTINGS / wxSign …）
 * 页面把每个对象编码成 JSON.parse(decodeURIComponent("..."))，这里一次性全部还原。
 */
export function extractInjected(html) {
  const out = {};
  const re = /injectedData\.([A-Za-z_$][\w$]*)\s*=\s*JSON\.parse\(decodeURIComponent\(\s*"([^"]+)"\s*\)\)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { out[m[1]] = JSON.parse(decodeURIComponent(m[2])); } catch { /* 跳过坏块 */ }
  }
  return out;
}

/** 打开公网预览页，返回 showInfo（含 show_data_url / show_url / title / cover） */
export async function fetchPreviewInfo(showId, { sid = MARKET_BOARD_SID, cookie = "" } = {}) {
  const tried = [];
  const candidates = sid ? [sid] : [MARKET_BOARD_SID];
  for (const c of candidates) {
    const url = previewUrl(showId, c);
    const r = await fetchLoose(url, { cookie });
    tried.push(`${url} → HTTP ${r.status}`);
    if (r.status !== 200) continue;
    const inj = extractInjected(r.text);
    if (inj.showInfo?.show_data_url || inj.showInfo?.show_data_name) {
      return { info: inj.showInfo, injected: inj, pageUrl: r.url, html: r.text };
    }
  }
  const e = new Error(
    `拿不到作品 ${showId} 的公网快照。\n尝试过：\n  ${tried.join("\n  ")}\n\n` +
      `可能原因：① 作品未发布；② 作品被作者设为私密；③ sid 不对（预览地址形如 /board/v5/<sid>/<show_id>）。`
  );
  e.expected = true;
  throw e;
}

/** 把内容树里所有图层的 _$raHTML 拼成一整篇文章 HTML */
export function extractArticleHtml(showData) {
  const parts = [];
  const pushLayer = (layer) => {
    const h = layer?._comp?._$raHTML;
    if (typeof h === "string" && h.trim()) parts.push(h);
  };
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.layers)) node.layers.forEach(pushLayer);
    for (const k of ["pages", "grounds", "overlaps"]) {
      if (Array.isArray(node[k])) node[k].forEach(walk);
    }
  };
  walk(showData?.cubes?.[0]);
  return absolutizeUrls(parts.join("\n"));
}

/**
 * 把协议相对地址（//img.xiumi.us/…）补成 https。
 * 这一步是必须的：本地用 file:// 打开时 `//host` 会被解析成 file://host 导致图片全裂；
 * 粘进公众号时也必须给绝对地址。
 */
export function absolutizeUrls(html) {
  return String(html ?? "")
    .replace(/(<(?:img|source|video|audio|iframe)\b[^>]*?\s(?:src|data-src|poster)\s*=\s*")\/\//gi, "$1https://")
    .replace(/(\ssrcset\s*=\s*")\/\//gi, "$1https://")
    .replace(/url\(\s*(['"]?)\/\//gi, "url($1https://");
}

/** 拉取公网快照的完整内容树（免登录） */
export async function grabTemplate(target, { sid = null, cookie = "" } = {}) {
  if (target === undefined || target === null || String(target).trim() === "") {
    const e = new Error("缺少 target：请传作品 ID 或公网预览链接（形如 https://v.xiumius.cn/board/v5/<sid>/<show_id>）。");
    e.expected = true;
    throw e;
  }
  const t = parseShowTarget(target);
  if (!t) {
    const e = new Error(`无法识别的作品标识：${target}\n可传：作品 ID、/board/v5/<sid>/<id> 预览链接、/studio/#/paper/for/<id> 编辑链接。`);
    e.expected = true;
    throw e;
  }
  const useSid = sid || t.sid || MARKET_BOARD_SID;
  const { info, injected, pageUrl } = await fetchPreviewInfo(t.showId, { sid: useSid, cookie });

  let dataUrl = info.show_data_url;
  if (!dataUrl && info.show_data_name) dataUrl = `//sd.xiumius.cn/xmi/pd/${info.show_data_name}.json`;
  if (!dataUrl) {
    const e = new Error(`预览页里没有 show_data_url，无法定位内容树（show_id=${t.showId}）。`);
    e.expected = true;
    throw e;
  }
  if (dataUrl.startsWith("//")) dataUrl = "https:" + dataUrl;

  const d = await fetchLoose(dataUrl, { cookie });
  if (!d.json) {
    const e = new Error(`内容树 JSON 解析失败（HTTP ${d.status}，${d.bytes} 字节）：${d.text.slice(0, 200)}`);
    e.expected = true;
    throw e;
  }
  return {
    showId: t.showId,
    sid: useSid,
    info,
    injected,
    pageUrl,
    dataUrl,
    showData: d.json,
    articleHtml: extractArticleHtml(d.json),
    compressedBytes: d.bytes,
  };
}

/* ============================================================
 *  五、模板体检
 * ============================================================ */

const COLOR_RE = /(#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{4}\b|#[0-9a-fA-F]{3}\b)|(rgba?\([^)]*\))/g;

/** 统计内容树/HTML 的可读指标，用于「这个模板值不值得抄」的判断 */
export function inspectTemplate({ showData, articleHtml, info = {} }) {
  const html = articleHtml || extractArticleHtml(showData);
  const imgs = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => absUrl(m[1]));
  const svgs = (html.match(/<svg/gi) || []).length;
  const gradients = (html.match(/(linear|radial)-gradient/gi) || []).length;
  const plain = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

  const colors = {};
  for (const m of html.matchAll(COLOR_RE)) {
    const c = toHex(m[1] || m[2] || "");
    if (!c) continue;
    colors[c] = (colors[c] || 0) + 1;
  }
  const topColors = Object.entries(colors).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const fonts = {};
  for (const m of html.matchAll(/font-size\s*:\s*([\d.]+(?:px|pt|em|rem))/gi)) {
    const k = m[1].toLowerCase();
    fonts[k] = (fonts[k] || 0) + 1;
  }
  const topFonts = Object.entries(fonts).sort((a, b) => b[1] - a[1]).slice(0, 6);

  const items = showData?.cubes?.[0]?.pages?.[0]?.layers?.[0]?.comps?.items;
  return {
    title: info.title ?? showData?.title ?? "",
    show_id: info.show_id ?? null,
    scene: showData?.scene ?? "",
    editable: Array.isArray(items) && items.length > 0,
    components: Array.isArray(items) ? items.length : null,
    sections: (html.match(/<section/gi) || []).length,
    images: imgs.length,
    svgs,
    gradients,
    chars: plain.length,
    textPreview: plain.slice(0, 200),
    cover: absUrl(info.cover ?? showData?.cover),
    colors: topColors,
    fonts: topFonts,
    htmlBytes: Buffer.byteLength(html, "utf8"),
    sampleImages: imgs.slice(0, 6),
    dataUrl: info.show_data_url ?? null,
  };
}

/* ============================================================
 *  六、导出
 * ============================================================ */

/** 文章 HTML → Markdown（保留标题/图片/链接，丢样式） */
export function htmlToMarkdown(html) {
  let s = String(html ?? "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<img[^>]*src="([^"]+)"[^>]*>/gi, (_, src) => `\n\n![](${absUrl(src)})\n\n`);
  s = s.replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "_$2_");
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${"#".repeat(Number(n))} ${stripTags(t).trim()}\n\n`);
  s = s.replace(/<\/?(section|div|p|br|li|ul|ol|tr|td|table|span)[^>]*>/gi, (m) =>
    /^(<br|\/p|\/div|\/section|\/li|\/tr)/i.test(m) ? "\n" : ""
  );
  s = stripTags(s);
  s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

/** 文章 HTML → 纯文本 */
export function htmlToText(html) {
  const s = String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(section|div|p|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  return stripTags(s)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTags(s) {
  return String(s ?? "").replace(/<[^>]*>/g, "");
}

/** 颜色统一成 #rrggbb（与 xiumi-transform 的换肤入参保持一致） */
function toHex(v) {
  const s = String(v ?? "").trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3})$/);
  if (m) return "#" + m[1].split("").map((c) => c + c).join("");
  m = s.match(/^#([0-9a-f]{6})$/);
  if (m) return s;
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (m) {
    const h = (n) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, "0");
    return "#" + h(m[1]) + h(m[2]) + h(m[3]);
  }
  return "";
}

/** 生成可独立打开的预览 HTML（含微信常用重置样式） */
export function wrapStandaloneHtml({ title = "秀米作品", body = "", width = 677 }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  html,body{margin:0;padding:0;background:#f2f2f2;}
  body{font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;}
  .xiumi-wrap{max-width:${width}px;margin:0 auto;background:#fff;padding:0;}
  img{max-width:100%;height:auto;}
  section{box-sizing:border-box;}
</style>
</head>
<body>
<article class="xiumi-wrap">
${body}
</article>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
