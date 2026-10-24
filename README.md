# 秀米连接器 · Xiumi Connector

把[秀米](https://xiumi.us)的公众号图文排版搬进命令行和 AI Agent。

**找模板 → 体检 → 搬到自己账号 → 换配色 → 换图 → 改文案 → 出预览**，全流程一条命令一步。

[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![deps](https://img.shields.io/badge/dependencies-0-blue)](package.json)
[![tools](https://img.shields.io/badge/MCP%20tools-34-orange)](server.mjs)
[![license](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

> ⚠️ 非官方接口。基于前端包逆向 + 实测，秀米改版可能失效。付费模板不能白嫖。

---

## 它解决什么

公众号排版最费时间的不是写字，是**找版式**。秀米市场里有 9 万多个模板，但：

- 想复用别人的版式，得在网页里点十几下；
- 想统一换成自己的品牌色，只能一个个组件手改；
- 想批量存几套参考版式，没有本地留档。

这个连接器把这些都变成命令：

| 能力 | 命令 |
|---|---|
| 搜索 / 排行 9 万+ 模板 | `market` `hot` |
| 免登录体检任意模板（配色/字号/规模） | `inspect` |
| 免登录抓成品（内容树 + HTML + Markdown） | `grab` |
| **把模板复制到自己账号**（可编辑，支持批量） | `steal` `steal-batch` |
| 一键换配色（含渐变/边框/阴影） | `retheme` |
| 按序号或 URL 批量换图 | `images` `reimg` |
| 批量替换文案（带次数断言防误改） | `patch` |
| 新建草稿 / 写入组件树 / 结构校验 | `new` `push` `validate` |
| 版本快照与回滚 | `snap` |
| 导出 HTML / Markdown / 纯文本 | `export` |

---

## 快速开始

```bash
git clone https://github.com/egg-0831/xiumi-connector.git
cd xiumi-connector

node --version            # 需要 >= 18
node xiumi.mjs doctor
```

### 登录（三选一）

```bash
# A. 图形化状态窗口 —— Windows 双击 status.cmd，或：
node status-server.mjs    # 浏览器打开 http://127.0.0.1:47820

# B. 从文件读 Cookie（推荐）
node xiumi.mjs login --file cookie.txt

# C. 直接传字符串
node xiumi.mjs login "sid=xxx; ..."
```

Cookie 获取：浏览器打开 <https://xiumi.us> 登录 → `F12` → Network → 刷新页面 → 点任意 `xiumi.us` 请求 → Request Headers → 复制整串 `Cookie`。

```bash
node xiumi.mjs whoami     # 验证
```

> 不想登录也能用 `market` / `inspect` / `grab` —— 这三项走公开接口。

---

## 三步拿到一个能用的模板

```bash
# 1. 找：按使用量排出重阳主题模板
node xiumi.mjs market 重阳 --sort copy --limit 10

# 2. 体检：看它是什么结构、什么配色
node xiumi.mjs inspect 731733080

# 3. 搬到自己账号
node xiumi.mjs steal 731733080 --title "重阳节活动推送"
```

拿到新作品 ID 后：

```bash
node xiumi.mjs snap <ID>                                    # 先备份
node xiumi.mjs retheme <ID> --show                          # 看色板
node xiumi.mjs retheme <ID> --map "#c8201a=#27408B" --dry   # 演练换色
node xiumi.mjs retheme <ID> --map "#c8201a=#27408B"         # 真改
node xiumi.mjs publish <ID>                                 # 出预览链接
```

完整工作流见 [SKILL.md](SKILL.md#四标准工作流从别人的模板到自己的推文)。

---

## 「搬模板」的两种模式

秀米把作品存成两套数据：**可编辑组件树**（自己账号里）和**已发布快照**（公网上、组件被拍平成 HTML）。连接器对应两条路：

| | `steal`（搬到账号） | `grab`（抓成品） |
|---|---|---|
| 需要登录 | ✅ | ❌ |
| 结果 | 自己账号里一份**可编辑**作品 | 本地 JSON + HTML + Markdown |
| 能继续换色/换图/改组件 | ✅ | ❌（已拍平） |
| 排版还原度 | 100%（秀米原生） | 高，但「钉位」元素静态打开可能错位 |
| 适用 | 要接着改、要发出去 | 存档、参考、提取文案与素材 |

两条路可以**并用**：先 `grab` 看值不值得抄，再 `steal` 搬过来改。

### 关于「钉位」错位

秀米的超大标题、叠加文字等元素用 `<svg><foreignObject>` + JS 计算高度来定位。静态 HTML 没有那套 JS，打开时这类元素会被压扁。这是快照本身的特性，不是抓取丢数据——`inspect` 里的图片数、字数、section 数都是对的。

要 1:1 效果：`steal` 到自己账号，再用秀米自带的「复制到公众号」。

---

## 命令全表

```
状态与环境
  status                     打开可视化状态窗口（登录/看状态）
  login --file cookie.txt    注入 Cookie
  whoami                     当前账号
  doctor                     环境自检

模板采集
  market [关键词]            搜索市场（--tag 分类 --sort copy|collect|hit|new --pages N）
  hot                        热门榜（--metric copy|collect|hit|new）
  inspect <ID|链接|关键词>    模板体检（免登录）
  grab <ID|链接>             抓成品（免登录，--md / --txt / --lib / --name）
  steal <ID|链接|关键词>      搬到我的账号（--title / --patch / --dry）
  steal-batch                批量搬（--keyword 重阳 --limit 5 --delay 800）

内容加工
  outline <ID>               内容大纲
  pull <ID> [文件]           拉取完整内容树
  retheme <ID> --map ...     换配色（--show 看色板 / --dry 演练）
  images <ID>                列出图片
  reimg <ID> --index ...     批量换图（--src 按 URL 片段 / --all）
  patch <ID> 补丁.json        批量替换文案
  new "<标题>" [blocks.json] 新建草稿
  push <ID> [JSON]           写入内容树
  validate <ID|文件>         结构校验

发布与版本
  publish <ID>               定稿 + 预览链接 + 快照
  export <ID|链接> --md      导出 html / md / txt
  snap <ID> [list|restore N] 快照 / 回滚
  copy <ID> ["新标题"]        复制作品
  delete <ID> --yes          删除
```

---

## 作为 MCP 服务器

`server.mjs` 提供 **34 个工具**，stdio JSON-RPC，无网络端口。

```json
{
  "mcpServers": {
    "xiumi": {
      "command": "node",
      "args": ["/absolute/path/to/xiumi-connector/server.mjs"]
    }
  }
}
```

Windows 也可以直接运行 `install.cmd`，自动写入 `%USERPROFILE%\.workbuddy\mcp.json`。

### 工具分组

- **认证** `xiumi_set_cookie` `xiumi_whoami`
- **读取** `xiumi_list_shows` `xiumi_get_show` `xiumi_get_showdata` `xiumi_get_show_html`
- **市场** `xiumi_market_categories` `xiumi_market_search` `xiumi_market_hot` `xiumi_goods_tags_tree` `xiumi_search_goods` `xiumi_list_favorites`
- **采集** `xiumi_template_inspect` `xiumi_template_grab` `xiumi_steal` `xiumi_steal_batch` `xiumi_copy_show` `xiumi_export`
- **写入** `xiumi_create_draft` `xiumi_append_blocks` `xiumi_replace_text` `xiumi_retheme` `xiumi_replace_images` `xiumi_update_showdata` `xiumi_validate_showdata` `xiumi_publish` `xiumi_delete_show`
- **版本** `xiumi_snapshot` `xiumi_restore`
- **素材库** `xiumi_save_to_library` `xiumi_list_library` `xiumi_get_library` `xiumi_delete_library`
- **透传** `xiumi_request`

---

## 目录

```
xiumi-connector/
├── xiumi.mjs            CLI 入口
├── server.mjs           MCP 服务器（34 工具）
├── xiumi-core.mjs       会话 / HTTP / LZString / 内容树 / 校验
├── xiumi-market.mjs     市场搜索 / 公网快照 / 体检 / 导出
├── xiumi-transform.mjs  换配色 / 换图 / 快照
├── status-server.mjs    本地状态面板后端
├── status.html          状态面板界面
├── install.cmd|sh       一键注册 MCP
├── references/          接口细节、配方
├── examples/            示例 blocks / 补丁
└── test/                单元测试 + 协议测试
```

---

## 已知限制

- 秀米是**非公开接口**，改版即失效。写接口（复制、保存）最脆弱。
- 付费模板需要自己购买；`steal` 走的是官方复制通道，未购买会被服务端拒绝。
- 关键词搜索需要登录（秀米自己加的校验）；不登录时只能用 `--tag` 分类浏览。
- `grab` 的静态 HTML 无法还原依赖 JS 测量的钉位元素。
- 换图只支持 http(s) URL，不支持本地文件直接上传（秀米图床需要 OSS 签名）。

---

## 许可

[MIT](LICENSE)

本项目不含秀米的任何代码或数据，仅通过公开 HTTP 接口与用户自己的账号交互。抓取他人作品请自行注意版权。
