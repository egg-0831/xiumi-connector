---
name: xiumi
display_name: 秀米连接器
display_name_en: Xiumi Connector
description: "操作秀米（xiumi.us）公众号图文：搜模板、看模板、把别人的模板搬到自己账号（含批量）、抓取成品 HTML/Markdown、换配色、批量换图、改文案、新建草稿、发布预览。零依赖 Node 脚本，也可作为 MCP 服务器接入。触发词：秀米、xiumi、公众号排版、搬模板、偷模板、复刻排版、换配色、秀米草稿、公众号推文排版。"
description_en: "Work with Xiumi (xiumi.us) WeChat article editor: search templates, inspect a template, copy/clone templates into your own account (batch supported), grab finished HTML/Markdown, retheme colors, batch-replace images, rewrite copy, create drafts, publish previews. Zero-dependency Node scripts; also runs as an MCP server."
version: 3.0.0
---

# 秀米连接器

把秀米（xiumi.us）的公众号图文操作搬到命令行 / Agent 里：**找模板 → 体检 → 搬到自己账号 → 改内容 → 出预览**。

零依赖，只要 Node 18+（推荐 20/22/24）。

---

## 什么时候用

| 用户说法 | 走哪条路 |
|---|---|
| 「帮我找个 XX 主题的公众号模板」 | `market` 搜市场 |
| 「这个模板好看吗 / 什么配色」 | `inspect` 模板体检 |
| 「把别人的模板变成我的」 | `steal`（可编辑）或 `grab`（免登录拿成品） |
| 「把红色党建模板改成蓝紫」 | `retheme` |
| 「换掉里面的图」 | `images` 看清单 → `reimg` 换 |
| 「写一篇推文」 | `new` 建草稿 + blocks |
| 「看看我有哪些作品」 | `list` |

---

## 一、先确认环境

```bash
node -v            # 需要 18+
node xiumi.mjs doctor
```

`doctor` 会检查 Node 版本、会话文件、网络、目录。**首次使用必须先登录**，否则只有市场浏览与模板抓取能用（这两项免登录）。

## 二、登录（三选一）

```bash
# A. 图形化状态窗口（最省心，Windows 双击 status.cmd）
node status-server.mjs            # 浏览器打开 http://127.0.0.1:47820

# B. 从文件读 Cookie（推荐，免转义）
node xiumi.mjs login --file cookie.txt

# C. 直接传字符串（% 和 & 需转义，不推荐）
node xiumi.mjs login "sid=xxx; ..."
```

拿 Cookie：浏览器打开 <https://xiumi.us> 登录 → F12 → Network → 刷新 → 点任意 `xiumi.us` 请求 → Request Headers → 复制整串 `Cookie`。

登录成功后 `node xiumi.mjs whoami` 会打印昵称与 `user_sid`。

---

## 三、命令速查

### 找模板（免登录）

```bash
node xiumi.mjs market                       # 最新上架
node xiumi.mjs market 重阳 --sort copy      # 关键词（需登录）+ 按使用量
node xiumi.mjs market --tag 节假 --limit 30
node xiumi.mjs hot --metric collect         # 热门榜：copy / collect / hit / new
```

`--sort` 取值：`relevance`（默认）/ `copy` 使用量 / `collect` 收藏 / `hit` 浏览 / `new` 最新。
`--pages N` 会聚合 N 页后再排序，得到跨页排行榜。

### 体检模板（免登录）

```bash
node xiumi.mjs inspect 733162400
```

输出：结构是否可编辑、section / 图片 / SVG / 字数、主色板（hex）、字号分布、正文预览。用来判断"这个模板值不值得抄、抄来要改哪些颜色"。

### 抓成品（免登录）

```bash
node xiumi.mjs grab 733162400              # 内容树 JSON + 本地预览 HTML
node xiumi.mjs grab 733162400 --md         # 额外导出 Markdown
node xiumi.mjs grab 733162400 --txt --lib  # 纯文本 + 存本地素材库
```

> 抓的是秀米**已发布快照**，组件树被拍平成 HTML。本地预览与 md/txt 正常可用；但秀米的「钉位」元素（超大标题等）依赖其阅读器 JS 计算高度，静态打开可能错位。**要 1:1 效果或要能继续编辑，请走 `steal`。**

### 搬到自己的账号（需登录）

```bash
node xiumi.mjs steal 733162400                       # 复制一份到我的账号
node xiumi.mjs steal 733162400 --title "重阳节推送"
node xiumi.mjs steal 733162400 --patch 补丁.json     # 复制同时批量改文案
node xiumi.mjs steal 733162400 --dry                 # 先演练

node xiumi.mjs steal-batch --keyword 重阳 --limit 5  # 批量搬（带限速）
node xiumi.mjs steal-batch 733162400 731345940       # 显式指定
```

`target` 三种写法都行：作品 ID、`https://v.xiumius.cn/board/v5/3FOLa/733162400` 这类预览链接、或者直接给关键词（自动取市场首条）。

补丁文件格式（`examples/patch.sample.json`）：

```json
[{ "from": "旧文案", "to": "新文案", "expect": 1 }]
```

`expect` 省略表示不限次数，给了就必须精确匹配这么多次，防误改。

### 改内容

```bash
node xiumi.mjs outline <ID>                  # 看结构
node xiumi.mjs retheme <ID> --show           # 先看当前色板
node xiumi.mjs retheme <ID> --map "#c8201a=#27408B,#f6d478=#F5C453" --dry
node xiumi.mjs images <ID>                   # 列出所有图片（带序号与路径）
node xiumi.mjs reimg <ID> --index "2=https://…/a.jpg,0=https://…/b.jpg"
node xiumi.mjs reimg <ID> --src "oldhash=new.jpg"
node xiumi.mjs patch <ID> 补丁.json
node xiumi.mjs export <ID> --md
```

### 版本与发布

```bash
node xiumi.mjs snap <ID>            # 存一份快照
node xiumi.mjs snap <ID> list       # 看历史
node xiumi.mjs snap <ID> restore 0  # 回滚到最新（回滚前自动再存一份，可撤销）
node xiumi.mjs publish <ID>         # 定稿回写 + 预览链接 + 快照
```

**改之前先 `snap`**，这是唯一能后悔的操作。

---

## 四、标准工作流：从别人的模板到自己的推文

```bash
# 1. 找
node xiumi.mjs market 重阳 --sort copy --limit 20
#    看到喜欢的 ID，例如 731733080

# 2. 体检（免登录，先看清楚）
node xiumi.mjs inspect 731733080
#    → 主色 #c8201a / #f6d478，111 section，1500 字

# 3. 搬到账号
node xiumi.mjs steal 731733080 --title "重阳节活动推送"
#    → 新作品 ID，记下来

# 4. 备份
node xiumi.mjs snap <新ID>

# 5. 换色（把节日的红金换成品牌蓝紫）
node xiumi.mjs retheme <新ID> --map "#c8201a=#27408B,#f6d478=#F5C453"

# 6. 换图
node xiumi.mjs images <新ID>
node xiumi.mjs reimg <新ID> --index "0=https://…/cover.jpg"

# 7. 改文案
node xiumi.mjs outline <新ID>          # 看有哪些文本块
node xiumi.mjs patch <新ID> 补丁.json

# 8. 出预览
node xiumi.mjs publish <新ID>
```

第 5–7 步每一步都可以先加 `--dry` 看会改什么，再真正写入。

---

## 五、输出目录

所有产物落在脚本同级目录：

| 路径 | 内容 |
|---|---|
| `out/` | 抓取的作品：`<标题>__<ID>.json`（内容树）、`.html`（本地预览）、`.images.json`（图片清单） |
| `out/exports/` | 导出的 md / txt / html |
| `out/snapshots/` | 版本快照 `<ID>__<时间>.json` |
| `library/` | 本地素材库（`--lib` 或 MCP 的 save_to_library） |
| `session.json` | 登录会话（**含 Cookie，别提交到仓库**） |

---

## 六、出错了怎么办

| 现象 | 原因 | 处理 |
|---|---|---|
| `会话已失效` | Cookie 过期（约几周到一个月） | 重新 `login --file` |
| `关键词搜索需要登录` | 秀米对 `search` 参数做了登录校验 | 先登录；或改用 `--tag` 分类浏览 |
| `复制失败` / 提示需购买 | 付费模板未购买或作者禁止复制 | 该模板只能 `grab` 拿成品，或去秀米买 |
| `拿不到作品的公网快照` | 作品未发布 / 设了私密 | 换一个作品；自己的作品先 `publish` |
| `没有可替换的图片组件` | 抓来的成品快照已拍平 | 用 `steal` 复制成可编辑作品再换图 |
| `换配色后没变化` | 颜色值不在 `--show` 的色板里 | 先 `--show` 看实际色值，再拼 `--map` |
| 写入被判 `Common:Failed_DataRejected` | 内容树结构不合法 | 先 `snap restore` 回滚，再 `validate` 定位 |

---

## 七、作为 MCP 服务器接入

`server.mjs` 是一个 stdio JSON-RPC MCP 服务器，共 **34 个工具**，覆盖上面所有 CLI 能力。

```json
{
  "mcpServers": {
    "xiumi": {
      "command": "node",
      "args": ["<仓库绝对路径>/server.mjs"]
    }
  }
}
```

Windows 下也可直接跑 `install.cmd` 自动写入 `%USERPROFILE%\.workbuddy\mcp.json`。

---

## 八、边界与合规

- **这是非官方接口**，靠逆向前端包 + 实测得到，秀米改版随时可能失效。核心写接口（复制、保存）失效时优先考虑降级到 `grab`。
- **付费模板仍需自己购买**。`steal` 走的是秀米官方的"复制作品"通道，未购买会被服务端拒绝——这不是绕过机制，也请不要尝试绕过。
- 抓取他人作品仅用于**个人学习参考与素材留档**；直接商用他人版式、图片、文案存在版权风险，自负其责。
- `steal-batch` 默认每个之间停 800ms，别把间隔调到 0，也别一次搬几十个——对服务端不友好，也容易触发风控。
- Cookie 等同于账号密码，`session.json` 不要进版本库（`.gitignore` 已排除）。
