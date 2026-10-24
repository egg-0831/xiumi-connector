/**
 * 秀米 XIUMI 连接器 · 共用核心库（零依赖）
 *
 * 提供：会话管理、HTTP 客户端、写入负载算法（wrapData / token）、
 *      内容树（showData）读写与组装修饰、本地素材库。
 *
 * 被 server.mjs（MCP 服务）与 xiumi.mjs（CLI）共同引用。
 *
 * 逆向来源：edt.xiumius.cn 主包 /scripts/app/studio/entries/total/12dbfe.main.min.js
 * 非官方接口，秀米改版可能失效。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ROOT = __dirname;
export const SESSION_FILE = join(__dirname, "session.json");
export const LIB_DIR = join(__dirname, "library");
export const OUT_DIR = join(__dirname, "out");
export const BASE = "https://xiumi.us";
/** 写入接口与读取接口同在 xiumi.us 域；api.xiumius.cn 在本网络不可达（DNS 无解析），勿使用 */
export const API_BASE = "https://xiumi.us";
export const CDN_BASE = "https://sd.xiumius.cn";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** 秀米默认 uid（写入负载签名需要；非本机账号时可由 session 覆盖） */
const DEFAULT_UID = "b423b52e739bf0a45028124751e00115";

export const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");

/* ============================================================
 *  一、会话
 * ============================================================ */

export function loadSession() {
  try {
    if (!existsSync(SESSION_FILE)) return null;
    return JSON.parse(readFileSync(SESSION_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function saveSession(session) {
  const tmp = SESSION_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(session, null, 2), "utf8");
  renameSync(tmp, SESSION_FILE);
}

export function sessionCookie() {
  const s = loadSession();
  if (!s?.cookie) throw new AuthError("未配置会话 Cookie。\n" + NOT_LOGIN_HINT);
  return s.cookie;
}

export function sessionUid() {
  const s = loadSession();
  return s?.uid || DEFAULT_UID;
}

/** 当前账号 user_sid（board 短码，用于拼公网渲染/编辑链接；未缓存则实时查） */
export function sessionSid() {
  return loadSession()?.sid || null;
}

/** 拉取账号信息并回写 session（sid / uid / 昵称） */
export async function refreshAccount() {
  const res = await request("/auth/me");
  if (isAuthFailure(res)) throw new AuthError("会话已失效。\n" + NOT_LOGIN_HINT);
  const u = res.json?.data?.user ?? res.json?.user ?? {};
  const s = loadSession() ?? {};
  saveSession({
    ...s,
    uid: u.unique_uid || s.uid || DEFAULT_UID,
    sid: u.user_sid || s.sid || null,
    nickname: u.nickname ?? s.nickname ?? null,
    verifiedAt: new Date().toISOString(),
  });
  return u;
}

export const NOT_LOGIN_HINT = [
  "秀米会话无效或未配置。获取 Cookie 步骤：",
  "1. 浏览器打开 https://xiumi.us 并登录；",
  "2. 按 F12 打开开发者工具 → Network（网络）标签 → 刷新页面；",
  "3. 点击第一个对 xiumi.us 的请求 → Headers（标头）→ Request Headers（请求标头）→ 复制整串 Cookie 值；",
  "4. 把整串 Cookie 存成一个 txt 文件，然后执行：xiumi login --file cookie.txt",
  "   （或在本连接器的 MCP 工具里调用 xiumi_set_cookie 传入整串 Cookie）。",
].join("\n");

/** 认证/配置类错误：可预期，CLI 应打印友好提示而非堆栈 */
export class AuthError extends Error {
  constructor(msg) { super(msg); this.name = "AuthError"; this.expected = true; }
}

/* ============================================================
 *  二、HTTP 客户端
 * ============================================================ */

/**
 * 底层请求：自动带 Cookie / UA / Referer，自动解 gzip，返回 {status, text, json}
 * @param {string} path 绝对 URL 或以 / 开头的路径（相对 BASE）
 */
export async function request(path, opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await requestOnce(path, opts);
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function requestOnce(path, { method = "GET", query = {}, body = null, headers = {}, cookie = null, timeout = 30000 } = {}) {
  const url = /^https?:\/\//.test(path) ? new URL(path) : new URL(path, BASE);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(String(k), String(v));
  }
  const ck = cookie ?? (loadSession()?.cookie || "");
  const res = await fetch(url, {
    method,
    headers: {
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      "Accept-Encoding": "gzip, deflate",
      Referer: BASE + "/",
      "X-Requested-With": "XMLHttpRequest",
      ...(ck ? { Cookie: ck } : {}),
      ...(body !== null && body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== null && body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let raw = buf;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    try { raw = gunzipSync(buf); } catch { /* 保持原样 */ }
  }
  const text = raw.toString("utf8");
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, text, json, url: url.toString() };
}

/** 请求 API 域（api.xiumius.cn），用于创建/更新等写入接口 */
export async function apiRequest(path, opts = {}) {
  return request(API_BASE + path, opts);
}

export function isAuthFailure(res) {
  return res.status === 401 || res.status === 403 || (res.json && (res.json.code === -102 || res.json.code === -101));
}

/* ============================================================
 *  三、写入负载算法（逆向）
 * ============================================================ */

/** 计算"复制作品"所需的 tn_show_action_token_2 令牌 */
export function copyToken(showDataName) {
  if (!showDataName) throw new Error("缺少 show_data_name，无法计算复制令牌。");
  const p = String(showDataName).split("/").slice(0, 2).join("/");
  if (p.length < 32) throw new Error(`show_data_name 格式异常（长度 ${p.length} < 32）：${showDataName}`);
  return p.slice(16) + p.slice(0, 16);
}

/** 包装 showData 为可提交负载（含签名） */
export function wrapData(data, uid = sessionUid()) {
  const ts = Date.now().toString();
  const r = Math.round(1e6 * Math.random()).toString();
  const i = md5([r, uid, ts].join("$$"));
  const sig = md5([ts, uid, r].join("$$"));
  const t = JSON.parse(JSON.stringify(data));
  t.desc_appendix_1 = ts.slice(0, 8) + i.slice(8);
  t.desc_appendix_2 = i.slice(0, 8) + ts.slice(8);
  t.desc_appendix_3 = r;
  return {
    format: "c444c492de13eb854a687b3361bef8c4",
    encodedData: compressToBase64(JSON.stringify(t)),
    signature: sig,
  };
}

/** 生成 savingToken（编辑器保存时同款） */
export function savingToken() {
  return md5([randomUUID() + randomUUID(), Date.now()].join("."));
}

/** 在 wrapData 结果上补齐 PUT 所需的 lastSavedAt / savingToken */
export function buildUpdatePayload(data, savedAt, uid = sessionUid()) {
  const payload = wrapData(data, uid);
  payload.lastSavedAt = savedAt;
  payload.savingToken = savingToken();
  return payload;
}

/** 生成 saver 标识（编辑器保存负载里的 saver 字段） */
export function buildSaver(uid = sessionUid()) {
  return {
    ...wrapData({}, uid),
    lastSavedAt: Date.now(),
    savingToken: savingToken(),
    saver: uid,
  };
}

/* ============================================================
 *  四、LZString 压缩（lz-string 兼容实现，零依赖）
 *  仅实现 compressToBase64 / decompressFromBase64
 * ============================================================ */

const LZ_KEY_STR_URI = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
const LZ_KEY_URI = (() => {
  const d = {};
  for (let i = 0; i < LZ_KEY_STR_URI.length; i++) d[LZ_KEY_STR_URI[i]] = i;
  return d;
})();

function lzGetBaseValue(alphabet, character) {
  if (alphabet === LZ_KEY_STR_URI) return LZ_KEY_URI[character] ?? 0;
  return alphabet.indexOf(character);
}

export function compressToBase64(input) {
  if (input == null) return "";
  const out = _compress(input, 6, (a) => LZ_KEY_STR_URI[a]);
  switch (out.length % 4) {
    case 0: return out;
    case 1: return out + "===";
    case 2: return out + "==";
    default: return out + "=";
  }
}

export function decompressFromBase64(input) {
  if (input == null) return "";
  if (input === "") return null;
  return _decompress(input.length, 32, (index) => lzGetBaseValue(LZ_KEY_STR_URI, input.charAt(index)));
}

function _compress(uncompressed, bitsPerChar, getCharFromInt) {
  if (uncompressed == null) return "";
  let i;
  const context_dictionary = {};
  const context_dictionaryToCreate = {};
  let context_c = "";
  let context_wc = "";
  let context_w = "";
  let context_enlargeIn = 2;
  let context_dictSize = 3;
  let context_numBits = 2;
  const context_data = [];
  let context_data_val = 0;
  let context_data_position = 0;

  for (let ii = 0; ii < uncompressed.length; ii += 1) {
    const context_c_tmp = uncompressed.charAt(ii);
    context_c = context_c_tmp;
    if (!Object.prototype.hasOwnProperty.call(context_dictionary, context_c)) {
      context_dictionary[context_c] = context_dictSize++;
      context_dictionaryToCreate[context_c] = true;
    }
    context_wc = context_w + context_c;
    if (Object.prototype.hasOwnProperty.call(context_dictionary, context_wc)) {
      context_w = context_wc;
    } else {
      if (Object.prototype.hasOwnProperty.call(context_dictionaryToCreate, context_w)) {
        if (context_w.charCodeAt(0) < 256) {
          for (i = 0; i < context_numBits; i++) {
            context_data_val = context_data_val << 1;
            if (context_data_position === bitsPerChar - 1) {
              context_data_position = 0;
              context_data.push(getCharFromInt(context_data_val));
              context_data_val = 0;
            } else {
              context_data_position++;
            }
          }
          let value = context_w.charCodeAt(0);
          for (i = 0; i < 8; i++) {
            context_data_val = (context_data_val << 1) | (value & 1);
            if (context_data_position === bitsPerChar - 1) {
              context_data_position = 0;
              context_data.push(getCharFromInt(context_data_val));
              context_data_val = 0;
            } else {
              context_data_position++;
            }
            value = value >> 1;
          }
        } else {
          let value = 1;
          for (i = 0; i < context_numBits; i++) {
            context_data_val = (context_data_val << 1) | value;
            if (context_data_position === bitsPerChar - 1) {
              context_data_position = 0;
              context_data.push(getCharFromInt(context_data_val));
              context_data_val = 0;
            } else {
              context_data_position++;
            }
            value = 0;
          }
          value = context_w.charCodeAt(0);
          for (i = 0; i < 16; i++) {
            context_data_val = (context_data_val << 1) | (value & 1);
            if (context_data_position === bitsPerChar - 1) {
              context_data_position = 0;
              context_data.push(getCharFromInt(context_data_val));
              context_data_val = 0;
            } else {
              context_data_position++;
            }
            value = value >> 1;
          }
        }
        context_enlargeIn--;
        if (context_enlargeIn === 0) {
          context_enlargeIn = Math.pow(2, context_numBits);
          context_numBits++;
        }
        delete context_dictionaryToCreate[context_w];
      } else {
        let value = context_dictionary[context_w];
        for (i = 0; i < context_numBits; i++) {
          context_data_val = (context_data_val << 1) | (value & 1);
          if (context_data_position === bitsPerChar - 1) {
            context_data_position = 0;
            context_data.push(getCharFromInt(context_data_val));
            context_data_val = 0;
          } else {
            context_data_position++;
          }
          value = value >> 1;
        }
      }
      context_enlargeIn--;
      if (context_enlargeIn === 0) {
        context_enlargeIn = Math.pow(2, context_numBits);
        context_numBits++;
      }
      context_dictionary[context_wc] = context_dictSize++;
      context_w = String(context_c);
    }
  }

  if (context_w !== "") {
    if (Object.prototype.hasOwnProperty.call(context_dictionaryToCreate, context_w)) {
      if (context_w.charCodeAt(0) < 256) {
        for (i = 0; i < context_numBits; i++) {
          context_data_val = context_data_val << 1;
          if (context_data_position === bitsPerChar - 1) {
            context_data_position = 0;
            context_data.push(getCharFromInt(context_data_val));
            context_data_val = 0;
          } else {
            context_data_position++;
          }
        }
        let value = context_w.charCodeAt(0);
        for (i = 0; i < 8; i++) {
          context_data_val = (context_data_val << 1) | (value & 1);
          if (context_data_position === bitsPerChar - 1) {
            context_data_position = 0;
            context_data.push(getCharFromInt(context_data_val));
            context_data_val = 0;
          } else {
            context_data_position++;
          }
          value = value >> 1;
        }
      } else {
        let value = 1;
        for (i = 0; i < context_numBits; i++) {
          context_data_val = (context_data_val << 1) | value;
          if (context_data_position === bitsPerChar - 1) {
            context_data_position = 0;
            context_data.push(getCharFromInt(context_data_val));
            context_data_val = 0;
          } else {
            context_data_position++;
          }
          value = 0;
        }
        value = context_w.charCodeAt(0);
        for (i = 0; i < 16; i++) {
          context_data_val = (context_data_val << 1) | (value & 1);
          if (context_data_position === bitsPerChar - 1) {
            context_data_position = 0;
            context_data.push(getCharFromInt(context_data_val));
            context_data_val = 0;
          } else {
            context_data_position++;
          }
          value = value >> 1;
        }
      }
      context_enlargeIn--;
      if (context_enlargeIn === 0) {
        context_enlargeIn = Math.pow(2, context_numBits);
        context_numBits++;
      }
      delete context_dictionaryToCreate[context_w];
    } else {
      let value = context_dictionary[context_w];
      for (i = 0; i < context_numBits; i++) {
        context_data_val = (context_data_val << 1) | (value & 1);
        if (context_data_position === bitsPerChar - 1) {
          context_data_position = 0;
          context_data.push(getCharFromInt(context_data_val));
          context_data_val = 0;
        } else {
          context_data_position++;
        }
        value = value >> 1;
      }
    }
    context_enlargeIn--;
    if (context_enlargeIn === 0) {
      context_enlargeIn = Math.pow(2, context_numBits);
      context_numBits++;
    }
  }

  let value = 2;
  for (i = 0; i < context_numBits; i++) {
    context_data_val = (context_data_val << 1) | (value & 1);
    if (context_data_position === bitsPerChar - 1) {
      context_data_position = 0;
      context_data.push(getCharFromInt(context_data_val));
      context_data_val = 0;
    } else {
      context_data_position++;
    }
    value = value >> 1;
  }
  while (true) {
    context_data_val = context_data_val << 1;
    if (context_data_position === bitsPerChar - 1) {
      context_data.push(getCharFromInt(context_data_val));
      break;
    } else context_data_position++;
  }
  return context_data.join("");
}

function _decompress(length, resetValue, getNextValue) {
  const dictionary = [];
  let enlargeIn = 4;
  let dictSize = 4;
  let numBits = 3;
  let entry = "";
  const result = [];
  let i;
  let w;
  let bits;
  let resb;
  let maxpower;
  let power;
  let c;
  const data = { val: getNextValue(0), position: resetValue, index: 1 };

  for (i = 0; i < 3; i += 1) dictionary[i] = i;

  bits = 0;
  maxpower = Math.pow(2, 2);
  power = 1;
  while (power !== maxpower) {
    resb = data.val & data.position;
    data.position >>= 1;
    if (data.position === 0) {
      data.position = resetValue;
      data.val = getNextValue(data.index++);
    }
    bits |= (resb > 0 ? 1 : 0) * power;
    power <<= 1;
  }

  switch (bits) {
    case 0: {
      bits = 0;
      maxpower = Math.pow(2, 8);
      power = 1;
      while (power !== maxpower) {
        resb = data.val & data.position;
        data.position >>= 1;
        if (data.position === 0) {
          data.position = resetValue;
          data.val = getNextValue(data.index++);
        }
        bits |= (resb > 0 ? 1 : 0) * power;
        power <<= 1;
      }
      c = String.fromCharCode(bits);
      break;
    }
    case 1: {
      bits = 0;
      maxpower = Math.pow(2, 16);
      power = 1;
      while (power !== maxpower) {
        resb = data.val & data.position;
        data.position >>= 1;
        if (data.position === 0) {
          data.position = resetValue;
          data.val = getNextValue(data.index++);
        }
        bits |= (resb > 0 ? 1 : 0) * power;
        power <<= 1;
      }
      c = String.fromCharCode(bits);
      break;
    }
    case 2:
      return "";
    default:
      return null;
  }
  dictionary[3] = c;
  w = c;
  result.push(c);
  while (true) {
    if (data.index > length) return "";
    bits = 0;
    maxpower = Math.pow(2, numBits);
    power = 1;
    while (power !== maxpower) {
      resb = data.val & data.position;
      data.position >>= 1;
      if (data.position === 0) {
        data.position = resetValue;
        data.val = getNextValue(data.index++);
      }
      bits |= (resb > 0 ? 1 : 0) * power;
      power <<= 1;
    }

    switch ((c = bits)) {
      case 0: {
        bits = 0;
        maxpower = Math.pow(2, 8);
        power = 1;
        while (power !== maxpower) {
          resb = data.val & data.position;
          data.position >>= 1;
          if (data.position === 0) {
            data.position = resetValue;
            data.val = getNextValue(data.index++);
          }
          bits |= (resb > 0 ? 1 : 0) * power;
          power <<= 1;
        }
        dictionary[dictSize++] = String.fromCharCode(bits);
        c = dictSize - 1;
        enlargeIn--;
        break;
      }
      case 1: {
        bits = 0;
        maxpower = Math.pow(2, 16);
        power = 1;
        while (power !== maxpower) {
          resb = data.val & data.position;
          data.position >>= 1;
          if (data.position === 0) {
            data.position = resetValue;
            data.val = getNextValue(data.index++);
          }
          bits |= (resb > 0 ? 1 : 0) * power;
          power <<= 1;
        }
        dictionary[dictSize++] = String.fromCharCode(bits);
        c = dictSize - 1;
        enlargeIn--;
        break;
      }
      case 2:
        return result.join("");
      default:
        break;
    }

    if (enlargeIn === 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits++;
    }

    if (dictionary[c]) {
      entry = dictionary[c];
    } else if (c === dictSize) {
      entry = w + w.charAt(0);
    } else {
      return null;
    }
    result.push(entry);

    dictionary[dictSize++] = w + entry.charAt(0);
    enlargeIn--;

    w = entry;

    if (enlargeIn === 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits++;
    }
  }
}

/* ============================================================
 *  五、组件模板库（新建草稿用）
 *  依据 2026-10 抓取的真实内容树逆向：
 *    组件 = { _comp:{tplId,constraint,pose,style,_$uuid}, <槽位名>: {...} }
 *    文本槽 txt1 = { type:"text", text:"<HTML>", style:{...} }
 *    图片槽 img1 = { type:"image", src:"...", style:{...}, constraint:{} }
 *    分栏组件 col1/col2/... = { type:"group", style:{...}, items:[子组件] }
 * ============================================================ */

const uuid = () => "comp-" + randomUUID().replace(/-/g, "").slice(0, 16);
const pid = (n) => "part-" + randomUUID().replace(/-/g, "").slice(0, 12);

export const TPL = {
  /// 单栏容器
  ONE_COL: { tplId: "paper-cp:layout/row1-r1c1", slots: ["col1"] },
  /// 两栏容器
  TWO_COL: { tplId: "paper-cp:layout/row1-r1c2", slots: ["col1", "col2"] },
  /// 三栏容器
  THREE_COL: { tplId: "paper-cp:layout/row1-r1c3", slots: ["col1", "col2", "col3"] },
  /// 纯文本
  TEXT: { tplId: "paper-cp:header/1-txt-normal", slots: ["txt1"] },
  /// 图片（宽自适应）
  IMAGE: { tplId: "paper-cp:image/img-autowidth", slots: ["img1"] },
  /// 图片（高自适应）
  IMAGE_H: { tplId: "paper-cp:image/img-autoheight", slots: ["img1"] },
};

/** 通用：构造一个文本组件 */
export function makeText(html, style = {}, compStyle = {}) {
  return {
    _comp: {
      tplId: TPL.TEXT.tplId,
      constraint: { opMenu: { "text-merged": true }, pose: { resize: "h" } },
      pose: { position: "static", width: null, height: null },
      style: { marginTop: "0", marginRight: "0", marginBottom: "0", marginLeft: "0", ...compStyle },
      _$uuid: uuid(),
    },
    txt1: {
      type: "text",
      text: String(html ?? ""),
      style: { textAlign: "justify", paragraphMargin: 12, ...style },
      constraint: {},
    },
  };
}

/** 通用：构造一个图片组件 */
export function makeImage(src, style = {}, { resize = "h", maxWidth = null } = {}) {
  return {
    _comp: {
      tplId: TPL.IMAGE.tplId,
      constraint: { opMenu: { "crop-image-merged": true }, pose: { resize } },
      style: { textAlign: "center", marginTop: "10px", marginBottom: "10px", lineHeight: "0" },
      pose: { position: "static", width: null, height: null },
      _$uuid: uuid(),
    },
    img1: {
      type: "image",
      src,
      style: {
        width: maxWidth ? maxWidth : "100%",
        ...style,
      },
      constraint: {},
    },
  };
}

/** 构造分栏容器（把若干子组件放进 col1…） */
export function makeRow(cols, { tplId = null, style = {}, colStyle = {} } = {}) {
  const n = cols.length;
  const id = tplId || (n === 1 ? TPL.ONE_COL.tplId : n === 2 ? TPL.TWO_COL.tplId : n === 3 ? TPL.THREE_COL.tplId : `paper-cp:layout/row1-r1c${n}`);
  const item = {
    _comp: {
      tplId: id,
      constraint: {},
      pose: { tnWorkaroundIOSPerspectiveFlat: null, position: "static", width: null, height: "auto" },
      style: {
        textAlign: "left",
        justifyContent: "flex-start",
        display: "flex",
        flexDirection: "row",
        flexWrap: "nowrap",
        marginTop: "10px",
        marginRight: "0",
        marginBottom: "10px",
        marginLeft: "0",
        ...style,
      },
      _$uuid: uuid(),
    },
  };
  cols.forEach((children, i) => {
    const key = `col${i + 1}`;
    item[key] = {
      type: "group",
      constraint: { childLayout: "static" },
      style: {
        width: "auto",
        minWidth: "5%",
        maxWidth: "100%",
        flex: n === 1 ? "1 1 auto" : "1 1 0%",
        height: "auto",
        ...colStyle,
      },
      items: Array.isArray(children) ? children : [children],
    };
  });
  return item;
}

/** 构造最小可用 showData 骨架（新建图文草稿）
 *  字段依据 2026-10 抓取的真实 v5 内容树逐项对齐：
 *    version:"2.0" / scene:"flw.vertical.one-page" / targetContext:"wechat"
 *    组件槽位为 l0/l1/... 分组，组内是 txt1 / txt0 文本叶子
 */
export function makeBlankShowData({ title = "新建图文", desc = "", cover = "", authorUid = "", authorSid = "" } = {}) {
  const layer = {
    _comp: {
      tplId: "paper-cp:sys/ly-flw",
      constraint: { role: "layer" },
      pose: {},
      style: {},
      _$uuid: "layer-" + randomUUID().replace(/-/g, "").slice(0, 16),
      _$raHTML: "",
    },
    comps: { type: "group", constraint: { childLayout: "static" }, items: [] },
    _qiBlock: { type: "group", constraint: { childLayout: "static", frozen: true }, items: [makeText("<p><br></p>")] },
  };
  const now = Date.now();
  return {
    version: "2.0",
    title,
    desc: desc || null,
    cover: cover || null,
    backgroundMusic: null,
    displaySystemTitle: true,
    displaySystemPageMargins: true,
    displaySystemCatalogue: true,
    scene: "flw.vertical.one-page",
    viewport: { STAGE_SIZE: "flow_scroll", WIDTH: 415, FONT_SIZE: 16 },
    targetContext: "wechat",
    cubes: [
      {
        _comp: {
          tplId: "paper-cp:sys/cube-fs",
          constraint: { role: "cube", flippingEffect: "cube.fs.h.sliding" },
          style: { backgroundColor: "tn-default-color" },
          pose: {},
          _$uuid: "cube-" + randomUUID().replace(/-/g, "").slice(0, 16),
        },
        pages: [
          {
            _comp: {
              tplId: "paper-cp:sys/pg-flw",
              constraint: {
                role: "page",
                mode: "flow",
                scene: null,
                viewport: { STAGE_SIZE: "flow_scroll", WIDTH: 415, FONT_SIZE: 16 },
                flippingEffect: "page.fs.v.sliding",
              },
              style: { backgroundColor: "rgb(229, 255, 254)" },
              pose: {},
              _$uuid: "page-" + randomUUID().replace(/-/g, "").slice(0, 16),
              topLevelEntranceAnim: "default",
              autoTurningInterval: 0,
            },
            layers: [layer],
          },
        ],
        grounds: [],
        overlaps: [],
      },
    ],
    actingType: "paper",
    popups: [],
    autoSlideInterval: 0,
    authorAppendix: {
      originUserUniqueUID: "",
      originUserSID: "",
      sourceUserUniqueUID: authorUid || "",
      sourceUserSID: authorSid || "",
      creationTarget: null,
      actions: null,
    },
    wx_link: "",
    wx_author: "",
    wxcover_1_1: null,
    wxcover_235_1: null,
    wxcrop_cover_235_1: null,
    wxcrop_cover_1_1: null,
    $appendix: { yzkFontFaces: {}, formulas: {}, htmlForPreview: "" },
    _createdAt: now,
  };
}

/** 从 showData 中定位默认内容层（cubes[0].pages[0].layers[0]） */
export function mainLayer(json) {
  const layer = json?.cubes?.[0]?.pages?.[0]?.layers?.[0];
  if (!layer) throw new Error("showData 结构异常：找不到 cubes[0].pages[0].layers[0]");
  if (!layer.comps) layer.comps = { type: "group", constraint: { childLayout: "flow" }, items: [] };
  if (!Array.isArray(layer.comps.items)) layer.comps.items = [];
  return layer;
}

/* ============================================================
 *  六、内容树操作层（读取 / 校验 / 编辑 / RA 重算）
 * ============================================================ */

/** 抓取作品的完整内容树（showData） */
export async function fetchShowData(showId) {
  const meta = await apiRequest(`/api/shows/${showId}`);
  if (isAuthFailure(meta)) throw new AuthError("会话已失效。\n" + NOT_LOGIN_HINT);
  const show = meta.json?.data ?? meta.json;
  if (!show?.show_data_name) throw new Error(`作品 ${showId} 缺少 show_data_name：${JSON.stringify(show).slice(0, 200)}`);
  let url = show.show_data_url || `${CDN_BASE}/xmi/pd/${show.show_data_name}.json`;
  if (url.startsWith("//")) url = "https:" + url;
  const res = await request(url);
  if (!res.json) throw new Error(`内容 JSON 拉取失败（${res.status}）：${res.text.slice(0, 200)}`);
  return { show, showData: res.json, dataUrl: url };
}

/** 遍历所有组件（含分栏子项），回调 (item, parentItems, index, path) */
export function walkItems(layer, cb, items = null, path = "") {
  const list = items ?? layer.comps.items;
  list.forEach((item, i) => {
    const p = path ? `${path}/${i}` : String(i);
    cb(item, list, i, p);
    for (const [k, v] of Object.entries(item)) {
      if (k === "_comp") continue;
      if (v && typeof v === "object" && Array.isArray(v.items)) walkItems(layer, cb, v.items, `${p}:${k}`);
    }
  });
}

/** 汇总内容树里的全部文本，便于让模型理解结构 */
export function summarizeShowData(showData, { textLimit = 120 } = {}) {
  const layer = mainLayer(showData);
  const lines = [];
  walkItems(layer, (item, _list, _i, path) => {
    const tpl = item._comp?.tplId ?? "?";
    const txtKey = Object.keys(item).find((k) => k !== "_comp" && item[k]?.type === "text");
    const imgKey = Object.keys(item).find((k) => k !== "_comp" && item[k]?.type === "image");
    if (txtKey) {
      const t = String(item[txtKey].text ?? "");
      const plain = t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      lines.push(`[${path}] ${tpl} TEXT(${t.length}字符): ${plain.slice(0, textLimit)}${plain.length > textLimit ? "…" : ""}`);
    } else if (imgKey) {
      lines.push(`[${path}] ${tpl} IMAGE: ${String(item[imgKey].src ?? "").slice(0, 100)}`);
    } else {
      lines.push(`[${path}] ${tpl} GROUP`);
    }
  });
  return {
    title: showData.title,
    version: showData.version,
    scene: showData.scene,
    targetContext: showData.targetContext,
    itemCount: layer.comps.items.length,
    outline: lines,
  };
}

/** 结构校验：返回问题列表（空数组 = 通过） */
export function validateShowData(showData) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };
  need(showData && typeof showData === "object", "showData 不是对象");
  need(showData?.version === "2.0", `version 应为 "2.0"，当前 ${JSON.stringify(showData?.version)}`);
  need(typeof showData?.title === "string" && showData.title.length > 0, "title 缺失");
  need(showData?.scene === "flw.vertical.one-page", `scene 应为 "flw.vertical.one-page"，当前 ${JSON.stringify(showData?.scene)}`);
  need(showData?.targetContext === "wechat", `targetContext 应为 "wechat"，当前 ${JSON.stringify(showData?.targetContext)}`);
  const cube = showData?.cubes?.[0];
  need(Array.isArray(showData?.cubes) && showData.cubes.length > 0, "cubes 为空");
  need(cube?._comp?.tplId === "paper-cp:sys/cube-fs", `cubes[0]._comp.tplId 异常：${cube?._comp?.tplId}`);
  const page = cube?.pages?.[0];
  need(Array.isArray(cube?.pages) && cube.pages.length > 0, "pages 为空");
  need(page?._comp?.tplId === "paper-cp:sys/pg-flw", `page._comp.tplId 异常：${page?._comp?.tplId}`);
  const layer = page?.layers?.[0];
  need(Array.isArray(page?.layers) && page.layers.length > 0, "layers 为空");
  need(layer?._comp?.tplId === "paper-cp:sys/ly-flw", `layer._comp.tplId 异常：${layer?._comp?.tplId}`);
  need(layer?.comps?.type === "group", "layer.comps.type 应为 group");
  need(Array.isArray(layer?.comps?.items), "layer.comps.items 不是数组");
  // 逐项校验
  if (Array.isArray(layer?.comps?.items)) {
    layer.comps.items.forEach((it, i) => {
      need(it?._comp?.tplId, `items[${i}] 缺少 _comp.tplId`);
      need(it?._comp?._$uuid, `items[${i}] 缺少 _comp._$uuid`);
    });
  }
  return problems;
}

/** HTML 标签平衡自查 */
export function balanceHtml(html) {
  const s = String(html ?? "");
  const cnt = (re) => (s.match(re) || []).length;
  return {
    section: cnt(/<section[\s>]/g) - cnt(/<\/section>/g),
    div: cnt(/<div[\s>]/g) - cnt(/<\/div>/g),
    p: cnt(/<p[\s>]/g) - cnt(/<\/p>/g),
    span: cnt(/<span[\s>]/g) - cnt(/<\/span>/g),
  };
}

/** 由组件树重建 layer 的 _$raHTML 渲染缓存（保持与编辑器一致的最小规则） */
export function rebuildRaHtml(showData) {
  const layer = mainLayer(showData);
  const parts = [];
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const styleStr = (o) => Object.entries(o || {}).map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}: ${v};`).join(" ");

  const renderItem = (item, depth = 0) => {
    const tpl = item._comp?.tplId ?? "";
    const compStyle = styleStr({ ...(item._comp?.style || {}), boxSizing: "border-box" });
    if (tpl.includes("layout/row")) {
      const cols = Object.keys(item).filter((k) => k.startsWith("col") && item[k]?.items);
      const inner = cols
        .map((k) => {
          const col = item[k];
          return `<section style="display: inline-block; vertical-align: top; ${styleStr(col.style)} box-sizing: border-box;">${col.items.map((c) => renderItem(c, depth + 1)).join("")}</section>`;
        })
        .join("");
      return `<section style="${compStyle} display: flex; flex-flow: row; position: static;">${inner}</section>`;
    }
    const txtKey = Object.keys(item).find((k) => k !== "_comp" && item[k]?.type === "text");
    if (txtKey) {
      const leaf = item[txtKey];
      const leafStyle = styleStr(leaf.style);
      return `<section style="${compStyle} position: static;">${leafStyle ? `<section style="${leafStyle} box-sizing: border-box;">` : ""}${leaf.text}${leafStyle ? "</section>" : ""}</section>`;
    }
    const imgKey = Object.keys(item).find((k) => k !== "_comp" && item[k]?.type === "image");
    if (imgKey) {
      const leaf = item[imgKey];
      const src = /^\/\//.test(leaf.src) ? "https:" + leaf.src : leaf.src;
      return `<section style="${compStyle} position: static;"><section style="${styleStr(leaf.style)} box-sizing: border-box;"><img src="${esc(src)}" style="${styleStr(leaf.style)}"></section></section>`;
    }
    return "";
  };

  for (const item of layer.comps.items) parts.push(renderItem(item));
  layer._comp._$raHTML = parts.join("");
  return layer._comp._$raHTML;
}

/** 统一样式补丁：对文本叶子与 RA 缓存双写 */
export function patchTextEverywhere(showData, replace) {
  const layer = mainLayer(showData);
  let hits = 0;
  walkItems(layer, (item) => {
    const txtKey = Object.keys(item).find((k) => k !== "_comp" && item[k]?.type === "text");
    if (!txtKey) return;
    const before = item[txtKey].text;
    const after = replace(before);
    if (after !== before) { item[txtKey].text = after; hits++; }
  });
  rebuildRaHtml(showData);
  return hits;
}

/** 安全替换：要求 needle 恰好出现 expect 次，否则抛错（避免误改） */
export function replaceExact(s, needle, repl, expect = 1, tag = "") {
  const n = String(s).split(needle).length - 1;
  if (n !== expect) throw new Error(`${tag || "replaceExact"}: 期望 ${expect} 处，实际 ${n} 处 —— ${String(needle).slice(0, 60)}`);
  return String(s).split(needle).join(repl);
}
