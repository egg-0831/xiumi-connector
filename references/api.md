# 接口备忘

所有结论来自 2026-10 对 `edt.xiumius.cn` 前端包（`/scripts/app/studio/entries/total/12dbfe.main.min.js`）的逆向 + 线上实测。
**非官方接口，改版即失效。** 遇到异常先用 `xiumi_request` 透传试探。

---

## 域名分工

| 域名 | 用途 | 备注 |
|---|---|---|
| `xiumi.us` | 主站 + 全部 API | 读、写、市场都在这 |
| `xiumius.cn` | 内容 / CDN / 移动预览 | `sd.` 内容 JSON、`v.`/`a.`/`r.` 预览页、`img.` 图床 |
| `edt.xiumius.cn` | 编辑器前端包 | 逆向来源，不是 API |
| `api.xiumius.cn` | — | **本网络不可达，别用** |

---

## 一、市场（匿名可读）

### 分类树

```
GET /api/show_goods/tags_tree?show_type=paper&tag_level_from=1&tag_level_to=2
```

返回一条 L2 根节点 `paper_root`（`tag_id=1`），其 `childTags` 是 5 个 L1 分类：

| tag_id | 名称 |
|---|---|
| 12 | 用途 |
| 13 | 行业 |
| 14 | 节假 |
| 15 | 风格 |
| 248 | 色调 |

**没有三级分类**（`tag_level_to=3` 返回空）。市场筛选实际只到这一层。

### 商品列表

```
GET /api/show_goods/goodses
    ?show_type=paper&showgoods_type=paper
    &page=1&limit=50
    &price_scope=0&by_nearest=0&tpl_flag=0
    [&search=关键词]      ← 需登录
    [&tag_ids=12,13]      ← 逗号分隔
```

要点：

- `show_type` / `showgoods_type` 目前都只有 `paper` 有效（`comp` 会返回 -1）。
- `tag_id`（单数）**无效**，会返回 `count: 0`；必须用 `tag_ids`（复数）。
- `search` / `keyword` / `q`：只有 `search` 被后端识别，且**要求登录**（匿名返回 `code:-102 Auth:Failed_NotLogin`）。`keyword`/`q` 会被静默忽略（返回默认列表）。
- `price_scope`、`by_nearest`、`tpl_flag` 传什么值结果都一样，保留原样即可。
- **没有服务端排序参数**。要排行榜只能多拉几页在本地按 `copy_number` / `collected_number` 排。

### 条目字段（节选）

```jsonc
{
  "show_goods_id": 160319,
  "show_id": 733162400,
  "price": 10,
  "copy_number": 125,        // 使用量
  "collected_number": 77,    // 收藏量
  "show": {
    "title": "…",
    "cover": "//img.xiumi.us/…",
    "show_url": "https://v.xiumius.cn/board/v5/3FOLa/733162400",  // 公网预览
    "edit_url": "/studio/v5#/paper/for/733162400",
    "hit_count": 1840,
    "exif": { "viewport": { "WIDTH": 415, "STAGE_SIZE": "flow_scroll" } }
  },
  "seller": { "user_sid": "3QFRr", "nickname": "肥仔", "userpage_url": "https://v.xiumius.cn/u/3QFRr" }
}
```

### 🔑 市场 board 短码恒为 `3FOLa`

`show_url` 里的 `/board/v5/<sid>/<id>`，其中的 `<sid>` **不是卖家 user_sid**，而是市场统一的 board 码，所有市场作品都是 `3FOLa`。

所以任意市场作品都可以直接拼：

```
https://v.xiumius.cn/board/v5/3FOLa/<show_id>
```

这是免登录抓模板的关键——有 `show_id` 就够了。非市场作品（别人私人的）才是作者自己的 sid。

---

## 二、公网快照（免登录）

### 预览页

```
GET https://v.xiumius.cn/board/v5/3FOLa/<show_id>
  → 302 → https://a.xiumius.cn/... 或 https://r.xiumius.cn/...   （都是 CDN 边缘）
  → 200 text/html  ~12KB 外壳
```

页面本身不含正文，正文在 `<script id="__pre_data">` 里以转义形式注入：

```js
injectedData.showInfo = JSON.parse(decodeURIComponent("%7B%22show_id%22%3A…"));
injectedData.SYSTEM_SETTINGS = JSON.parse(decodeURIComponent("…"));
injectedData.wxSign / advertList / overseas
```

用正则一次性还原全部：

```js
/injectedData\.(\w+)\s*=\s*JSON\.parse\(decodeURIComponent\(\s*"([^"]+)"\s*\)\)/g
```

`showInfo` 关键字段：`show_id`、`title`、`cover`、`show_data_name`、`show_data_url`、`show_url`、`exif.viewport.WIDTH`（设计版心宽度）。

### 内容树

```
GET <show_data_url>     // 可能是 //sd.xiumius.cn/... 开头，补 https:
```

- 返回 **gzip 压缩**（魔数 `1f 8b`），需解压。同步接口偶尔不压缩，两个都要兼容。
- 解压后是完整 `showData`（本例 258KB），结构与编辑器一致。

### ⚠️ 已发布快照的组件树是「拍平」的

```jsonc
cubes[0].pages[0].layers[0].comps.items   // []  空数组
cubes[0].pages[0].layers[0]._comp._$raHTML // 109KB 完整 HTML
```

也就是说：**公网快照里没有可编辑的组件，只有渲染好的 HTML**。这是秀米对已发布内容的处理方式，不是抓取丢了数据。

推论：

- 想换配色 / 换图 / 改组件 → 必须 `steal` 复制到自己账号（自己的作品在 `/api/shows/{id}` 里拿到的才是完整组件树）。
- 想拿成品 HTML / 文案 / 图片素材 → 公网快照够用。

### ⚠️ 协议相对地址

`_$raHTML` 里图片是 `src="//img.xiumi.us/…"`。本地用 `file://` 打开会变成 `file://img.xiumi.us` → 全部裂图。导出时必须补 `https:`。

### ⚠️ 钉位元素静态打开会错位

超大标题之类用 `<svg viewBox><foreignObject>` 定位，高度由阅读器 JS 计算。静态 HTML 没有那套 JS，`height:100%` 解析不到，元素会被压扁。试过加 `aspect-ratio`、给 svg 显式宽高、`height:auto`，都无效——因为高度是 JS 量出来的。**这个问题无解，除非自己实现布局引擎。** 已经在 `grab` 的输出里如实标注。

---

## 三、需要登录的接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/auth/me` | 当前账号：`nickname` / `user_sid` / `unique_uid` |
| GET | `/api/shows/{id}` | 作品元数据 + `show_data_name` / `show_data_url`。**匿名 401** |
| GET | `/apis/shows?page=&count=` | 我的作品列表 |
| PUT | `/api/shows/{id}` | 保存内容树（body 见下） |
| POST | `/api/shows/v5/paper` | 新建草稿 / 复制作品 |
| DELETE | `/api/shows/{id}` | 删除 |
| GET | `/api/show_goods_favorites` | 我的收藏 |

### 复制作品（偷模板的正规通道）

```http
POST /api/shows/v5/paper?from_show_id=<源ID>
Content-Type: application/json

{
  "format": "0320cc2e241eb9af530b84dbe0b1cc65",
  "encodedData": "<LZString 压缩的 {title, raw_info_only:true}>",
  "copyFromShowId": "<源ID>",
  "tn_show_action_token_2": "<copyToken>"
}
```

`copyToken(show_data_name)` 的算法：

```js
const p = show_data_name.split("/").slice(0, 2).join("/");  // 去掉最后的时间戳段
return p.slice(16) + p.slice(0, 16);                        // 前后 16 位互换
```

实算一遍：

```
show_data_name = "19KxR/8514f341b0d6291f52580d310388667f/1792569788454"
p              = "19KxR/8514f341b0d6291f52580d310388667f"     (38 位)
p.slice(16)    = "d6291f52580d310388667f"                     (后 22 位)
p.slice(0,16)  = "19KxR/8514f341b0"                           (前 16 位)
token          = "d6291f52580d310388667f19KxR/8514f341b0"
```

**未购买会被服务端拒绝**，这是秀米自己的付费校验，不尝试绕过。

### 保存内容树

```json
{
  "format": "c444c492de13eb854a687b3361bef8c4",
  "encodedData": "<LZString 压缩的 showData（含签名 appendix）>",
  "signature": "<md5>",
  "lastSavedAt": "<作品的 saved_at>",
  "savingToken": "<md5(uuid+uuid+时间)>"
}
```

签名细节见 `xiumi-core.mjs` 的 `wrapData()`：

- `desc_appendix_1 = ts[0:8] + i[8:]`
- `desc_appendix_2 = i[0:8] + ts[8:]`
- `desc_appendix_3 = r`
- `i = md5(r $$ uid $$ ts)`，`sig = md5(ts $$ uid $$ r)`

`lastSavedAt` 必须与作品当前 `saved_at` 一致，否则乐观锁会拒绝。

---

## 四、错误码

| code | 含义 | 处理 |
|---|---|---|
| `0` | 成功 | — |
| `-101` | 鉴权失败 | 重新登录 |
| `-102` | `Auth:Failed_NotLogin` 未登录 | 重新登录；或该接口要求登录 |
| `-10` | `Common:Failed_DataRejected` 数据被拒 | 内容树结构不合法，先 `validate` |
| `-1` | 参数错误 | 检查 `show_type` 之类枚举 |

HTTP 401/403 与 `-101/-102` 视为同一种情况：`isAuthFailure()` 统一判断。

---

## 五、还没搞清的

- 市场没有服务端排序/价格筛选，`price_scope` 等参数无效——可能需要特定 header 或只有登录后才生效，未验证。
- 没有三级分类标签，`tag_level_to=3` 返空。
- 单个商品详情接口（`/api/show_goods/{id}`）是 HTML 错误页，不存在。
- 图片上传到秀米图床需要 OSS 签名，未实现，因此换图只支持外链。
