import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseShowTarget, previewUrl, previewUrl as pv, flattenTags, absolutizeUrls,
  htmlToMarkdown, htmlToText, wrapStandaloneHtml, inspectTemplate, extractInjected,
  extractArticleHtml, MARKET_BOARD_SID,
} from "../xiumi-market.mjs";

import {
  normalizeColor, buildColorMap, replaceColorsInString, retheme, replaceImages,
  listImages, palette, saveSnapshot, listSnapshots, loadSnapshot, pruneSnapshots,
} from "../xiumi-transform.mjs";

import {
  makeBlankShowData, makeText, makeImage, mainLayer, rebuildRaHtml,
  validateShowData, balanceHtml, copyToken, compressToBase64, decompressFromBase64,
} from "../xiumi-core.mjs";

/* ---------- 标识解析 ---------- */

test("parseShowTarget：纯数字", () => {
  assert.deepEqual(parseShowTarget("733162400"), { showId: "733162400", sid: null, kind: "id" });
});

test("parseShowTarget：公网预览链接解析出 sid", () => {
  const r = parseShowTarget("https://v.xiumius.cn/board/v5/3FOLa/733162400");
  assert.equal(r.showId, "733162400");
  assert.equal(r.sid, "3FOLa");
  assert.equal(r.kind, "preview");
});

test("parseShowTarget：编辑器链接", () => {
  const r = parseShowTarget("https://xiumi.us/studio/v5#/paper/for/731345940");
  assert.equal(r.showId, "731345940");
});

test("parseShowTarget：非法输入返回 null", () => {
  assert.equal(parseShowTarget(""), null);
  assert.equal(parseShowTarget(null), null);
  assert.equal(parseShowTarget("abc"), null);
  assert.equal(parseShowTarget("重阳"), null);
});

test("previewUrl 默认用市场 board 短码", () => {
  assert.equal(previewUrl("123456789"), `https://v.xiumius.cn/board/v5/${MARKET_BOARD_SID}/123456789`);
  assert.equal(pv("123456789", "AbCdE"), "https://v.xiumius.cn/board/v5/AbCdE/123456789");
});

/* ---------- 分类树 ---------- */

test("flattenTags：跳过 L2 根节点，路径不带 paper_root", () => {
  const tree = [
    { tag_id: 1, tag_level: 2, tag_name: "paper_root", childTags: [
      { tag_id: 12, tag_level: 1, tag_name: "用途", childTags: [
        { tag_id: 99, tag_level: 0, tag_name: "通知" },
      ] },
    ] },
  ];
  const flat = flattenTags(tree);
  assert.deepEqual(flat.map((t) => t.path), ["用途", "用途 / 通知"]);
  assert.equal(flat[1].tag_id, 99);
});

/* ---------- HTML 处理 ---------- */

test("absolutizeUrls：协议相对地址补 https", () => {
  const html = '<img src="//img.xiumi.us/a.png"><section style="background:url(//img.xiumi.us/b.png)"></section>';
  const out = absolutizeUrls(html);
  assert.ok(out.includes('src="https://img.xiumi.us/a.png"'));
  assert.ok(out.includes("url(https://img.xiumi.us/b.png)"));
  assert.ok(!out.includes('"//'));
});

test("absolutizeUrls：已经是 https 的不动", () => {
  const html = '<img src="https://x/y.png">';
  assert.equal(absolutizeUrls(html), html);
});

test("htmlToMarkdown：图片与标题", () => {
  const md = htmlToMarkdown('<h2>标题</h2><img src="//a/b.png"><p>正文</p>');
  assert.ok(md.includes("## 标题"));
  assert.ok(md.includes("![](https://a/b.png)"));
  assert.ok(md.includes("正文"));
});

test("htmlToText：去标签保留换行", () => {
  const t = htmlToText("<section>第一段</section><section>第二段</section>");
  assert.equal(t, "第一段\n第二段");
});

test("wrapStandaloneHtml：产出完整文档", () => {
  const h = wrapStandaloneHtml({ title: "测试<>&", body: "<p>x</p>" });
  assert.ok(h.startsWith("<!DOCTYPE html>"));
  assert.ok(h.includes("测试&lt;&gt;&amp;"));
  assert.ok(h.includes("<p>x</p>"));
});

test("extractInjected：还原 decodeURIComponent 包裹的 JSON", () => {
  const payload = encodeURIComponent(JSON.stringify({ show_id: 1, title: "甲" }));
  const html = `<script>injectedData.showInfo = JSON.parse(decodeURIComponent("${payload}"));</script>`;
  assert.deepEqual(extractInjected(html).showInfo, { show_id: 1, title: "甲" });
});

test("extractInjected：坏块不影响其它块", () => {
  const good = encodeURIComponent(JSON.stringify({ a: 1 }));
  const html = `injectedData.x = JSON.parse(decodeURIComponent("%E0%A4%A"));injectedData.y = JSON.parse(decodeURIComponent("${good}"));`;
  const r = extractInjected(html);
  assert.equal(r.y.a, 1);
  assert.equal(r.x, undefined);
});

/* ---------- 颜色 ---------- */

test("normalizeColor：三位十六进制展开", () => {
  assert.equal(normalizeColor("#abc"), "#aabbcc");
  assert.equal(normalizeColor("#AABBCC"), "#aabbcc");
});

test("normalizeColor：rgb/rgba 转 hex", () => {
  assert.equal(normalizeColor("rgb(200, 32, 26)"), "#c8201a");
  assert.equal(normalizeColor("rgba(255,255,255,0.5)"), "#ffffff");
});

test("buildColorMap + replaceColorsInString：等价色值都能命中", () => {
  const map = buildColorMap({ "rgb(200,32,26)": "#27408B" });
  const out = replaceColorsInString("color:#c8201a;background:#C8201A", map);
  assert.equal(out, "color:#27408B;background:#27408B");
});

test("replaceColorsInString：未命中保持原样", () => {
  const map = buildColorMap({ "#000000": "#ffffff" });
  assert.equal(replaceColorsInString("color:#123456", map), "color:#123456");
});

/* ---------- 内容树 ---------- */

function sampleTree() {
  const sd = makeBlankShowData({ title: "样例" });
  const layer = mainLayer(sd);
  layer.comps.items.push(makeText('<p style="color:#c8201a">红色</p>', { color: "#c8201a", backgroundColor: "rgb(255, 245, 231)" }));
  layer.comps.items.push(makeImage("https://example.com/a.jpg", {}));
  layer.comps.items.push(makeImage("https://example.com/b.jpg", {}));
  rebuildRaHtml(sd);
  return { sd, layer };
}

test("makeBlankShowData 通过结构校验", () => {
  const sd = makeBlankShowData({ title: "空" });
  assert.deepEqual(validateShowData(sd), []);
});

test("retheme：样式树与渲染缓存同步", () => {
  const { sd, layer } = sampleTree();
  const r = retheme(sd, { "#c8201a": "#27408B", "rgb(255,245,231)": "#EEE9F8" });
  assert.ok(r.changedNodes >= 1);
  assert.equal(layer.comps.items[0].txt1.style.color, "#27408B");
  assert.equal(layer.comps.items[0].txt1.style.backgroundColor, "#EEE9F8");
  const html = layer._comp._$raHTML;
  assert.ok(!html.includes("#c8201a"), "渲染缓存里不应再有旧色");
  assert.ok(html.includes("#27408B"));
});

test("retheme：空映射报错", () => {
  const { sd } = sampleTree();
  assert.throws(() => retheme(sd, {}), /需要 mapping/);
});

test("palette：统计出现次数最多的颜色", () => {
  const { sd } = sampleTree();
  const p = palette(sd);
  assert.equal(p[0][0], "#c8201a");
  assert.ok(p[0][1] >= 2);
});

test("listImages：给出路径与序号", () => {
  const { sd } = sampleTree();
  const imgs = listImages(sd);
  assert.equal(imgs.length, 2);
  assert.equal(imgs[0].index, 0);
  assert.equal(imgs[1].src, "https://example.com/b.jpg");
});

test("replaceImages：按序号替换并同步缓存", () => {
  const { sd, layer } = sampleTree();
  const r = replaceImages(sd, { byIndex: [{ index: 1, src: "https://example.com/new.jpg" }] });
  assert.equal(r.applied.length, 1);
  assert.equal(layer.comps.items[2].img1.src, "https://example.com/new.jpg");
  assert.ok(layer._comp._$raHTML.includes("new.jpg"));
  assert.ok(!layer._comp._$raHTML.includes("b.jpg"));
});

test("replaceImages：按 URL 片段替换", () => {
  const { sd } = sampleTree();
  const r = replaceImages(sd, { bySrc: [{ match: "a.jpg", src: "https://example.com/z.jpg" }] });
  assert.equal(r.applied.length, 1);
  assert.ok(listImages(sd).some((i) => i.src.endsWith("z.jpg")));
});

test("replaceImages：无命中时 applied 为空", () => {
  const { sd } = sampleTree();
  const r = replaceImages(sd, { bySrc: [{ match: "不存在", src: "x" }] });
  assert.equal(r.applied.length, 0);
  assert.equal(r.total, 2);
});

/* ---------- 快照 ---------- */

test("快照：保存 / 列表 / 读取 / 裁剪", () => {
  const dir = mkdtempSync(join(tmpdir(), "xiumi-snap-"));
  try {
    const { sd } = sampleTree();
    for (let i = 0; i < 3; i++) {
      sd.title = `版本${i}`;
      saveSnapshot(dir, "123", sd, { title: sd.title });
      // 保证时间戳不同
      const t = Date.now() + i * 10;
      while (Date.now() < t) { /* busy wait 极短 */ }
    }
    const list = listSnapshots(dir, "123");
    assert.equal(list.length, 3);

    const latest = loadSnapshot(dir, "123", 0);
    assert.ok(latest.showData.title.startsWith("版本"));

    const dropped = pruneSnapshots(dir, "123", 2);
    assert.equal(dropped, 1);
    assert.equal(readdirSync(dir).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("快照：不存在的作品报错", () => {
  const dir = mkdtempSync(join(tmpdir(), "xiumi-snap2-"));
  try {
    assert.throws(() => loadSnapshot(dir, "999", 0), /没有历史快照/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- 核心库回归 ---------- */

test("copyToken：前 16 与后 16 互换", () => {
  const name = "19KxR/8514f341b0d6291f52580d310388667f/1792569788454";
  const prefix = name.split("/").slice(0, 2).join("/");
  assert.equal(copyToken(name), prefix.slice(16) + prefix.slice(0, 16));
});

test("copyToken：格式异常抛错", () => {
  assert.throws(() => copyToken("短/xx"), /格式异常/);
});

test("LZString Base64 往返", () => {
  const s = "秀米 xiumi connector 123 —— 测试字符串";
  assert.equal(decompressFromBase64(compressToBase64(s)), s);
});

test("balanceHtml：能发现标签不平衡", () => {
  assert.equal(balanceHtml("<section><p>x</p>").section, 1);
  assert.equal(balanceHtml("<section><p>x</p></section>").section, 0);
});

/* ---------- 体检 ---------- */

test("inspectTemplate：统计图片、section、字数", () => {
  const html =
    '<section>甲</section><section><img src="//i/a.png"></section><section><img src="https://i/b.png"></section>';
  const ins = inspectTemplate({ articleHtml: html, showData: { title: "t", cubes: [] }, info: { title: "T" } });
  assert.equal(ins.images, 2);
  assert.equal(ins.sections, 3);
  assert.equal(ins.chars, 1);
  assert.equal(ins.editable, false);
});

test("extractArticleHtml：拼接多图层并补全协议", () => {
  const sd = {
    cubes: [{ pages: [{ layers: [{ _comp: { _$raHTML: '<section><img src="//i/x.png"></section>' } }, { _comp: { _$raHTML: "<section>二</section>" } }] }] }],
  };
  const html = extractArticleHtml(sd);
  assert.ok(html.includes("https://i/x.png"));
  assert.ok(html.includes("二"));
});
