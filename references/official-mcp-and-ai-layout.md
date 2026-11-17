# 官方 MCP + AI 排版实战

本文记录把「官方云 MCP」和本仓库的本地连接器搭配使用，完成一篇公众号图文从文字稿到成品的完整做法。所有作品 ID、账号 SID、预览链接均为占位符，示例文本为通用占位文本。

---

## 1. 两套通道并存

| 通道 | 工具前缀 | 能做什么 | 不能做什么 | 授权 |
|---|---|---|---|---|
| 官方云 MCP `https://xiumi.us/mcp` | `mcp__秀米__*` | 账号/图库、一键排版、样刊规范、片段规范、检查排版计划 | 改行内样式、搬固定装饰、内容树级精细编辑 | OAuth：服务端 401 自动发现，用户在客户端「自定义连接器」点信任/授权 |
| 本仓库本地连接器 `server.mjs` | `mcp__xiumi__*` | 内容树读写 `get_showdata` / `update_showdata` / `validate_showdata`、市场采集、换色换图、快照 | 一键排版语义较弱 | `xiumi_set_cookie` 传入自己的 Cookie |

**结论**：官方 MCP 负责「搭骨架」，本地连接器负责「抠细节」。两者工具名不冲突，可以同时挂在一个 Agent 上。

WorkBuddy 用户级 `~/.workbuddy/mcp.json` 的 HTTP 型配置只需两项：

```json
{
  "mcpServers": {
    "秀米": { "type": "http", "url": "https://xiumi.us/mcp" },
    "xiumi": {
      "command": "node",
      "args": ["/absolute/path/to/xiumi-connector/server.mjs"]
    }
  }
}
```

不要把 token 写进配置：POST 初始化会返回 401 与 `WWW-Authenticate: Bearer resource_metadata=...`，由客户端走标准 OAuth 2.1 发现流程。新 MCP / Skill 挂载后可能需要重开会话；授权必须在 UI 里人工完成。

官方 Skill `xiumi-help`（v1.1 / 2026-11-15）随官方 zip 分发，含 19 篇 references（`01-basics.md` … `19-compliance.md`）。其中 `18-flow-layout.md` 解释流动布局，`03-efficiency.md` 讲样刊和一键排版，`19-compliance.md` 讲版权；遇到排版原理问题优先查它们。

---

## 2. 一键排版（JIANPU 2）

典型调用链：

```
get_show_edit_spec 或 get_show_fragment_spec  → 拿 spec_version 与槽位
create_show_from_plan(dry_run=true)          → 预检 plan/material
create_show_from_plan(dry_run=false)         → 正式建作品
update_show_from_plan                        → 后续按槽位改内容
```

plan 形如：

```
JIANPU 2
layout_1
  body_1 = 0
layout_6
  body_6 = 5
  body_7 = 6
layout_8
  body_8 = 7
  body_9 = 8+9+10
```

`material.content_items` 用 `index` 对应 plan 右侧的数字，`type: "text"` / `"image"`。可重复槽位写作 `layout_6[2]`、`layout_8[3]`。

### 坑 1：加号会吞掉换行

`body_9 = 8+9+10` 的官方语义是「多段合并为一整段」，原文换行会全部丢失。要保留段落节奏，应改成**一个 text 素材，段间用真实 `\n` 连接**：

```json
{ "index": 8, "type": "text", "text": "第一段\n第二段\n第三段" }
```

官方会把 `\n` 渲染成独立 `<p style="margin-bottom:15px">`。完整示例见 `examples/workbuddy/jianpu-plan.example.json`。

### 坑 2：展示层看不出换行

`get_show_edit_spec` 的 `ex` 展示层会把段落连成一行，**不能据此判断分行是否生效**。必须看真实渲染 DOM 或截图：`scripts/workbuddy/cdp-preview.mjs` 就是干这个的。

### 坑 3：固定装饰不会被带走

一键排版只搬可编辑槽位。样刊的固定版头图、版尾图、背景块不会自动过来，需事后从样刊内容树 deepcopy 补回（见第 4 节）。也不要把样刊版头误判成照片位换掉——判断依据是内容树里的图片尺寸/哈希，不是视觉猜测。

---

## 3. showdata 精细排版

官方 `update_show_from_plan` 只做槽级替换，改不了字号/颜色/加粗。要精细控制，走本地连接器：

1. `xiumi_set_cookie` 登录后 `xiumi_get_showdata` 落盘；
2. 用脚本只改 `<p>` 的 `style`，**不碰文字**；
3. 对每个文本节点做纯文本逐字断言；
4. `xiumi_validate_showdata` → `xiumi_update_showdata`。

可复用脚本：`scripts/workbuddy/showdata-style.py`，规则示例：`examples/workbuddy/style-rules.example.json`。

```bash
python scripts/workbuddy/showdata-style.py \
  --in showdata.json --out showdata.styled.json \
  --rules examples/workbuddy/style-rules.example.json
```

脚本内部的核心断言：

```python
plain = lambda html: ''.join(
    m.group(2) for m in re.finditer(r'<p[^>]*>(.*?)</p>', html, re.S)
)
# 改样式前后：assert plain(before) == plain(after)
```

样式设计建议（来自实战）：

- 卷首语：副标题居中加粗，引言居中，诗句居中加粗、主色/强调色交替、段距拉开；
- 章节首句：强调色加粗当领句；获奖名单：小标题强调色，名单项浅灰底 + padding；
- 尾声：祝福语居中放大；
- 正文保持 14–16px、行距约 1.8–2.0、字间距 0–1px，别为了「设计感」牺牲可读性。

配色从模板本身取（例如深蓝 + 橙），不要另起一套高饱和撞色。

---

## 4. 跨作品搬组件与顺序

把某篇作品的「往期回顾」「版尾图」搬到另一篇：

```python
from copy import deepcopy

def reuuid(node):
    if isinstance(node, dict):
        for k, v in list(node.items()):
            if k == '_$uuid':
                node[k] = new_uuid()
            else:
                reuuid(v)
    elif isinstance(node, list):
        for v in node:
            reuuid(v)
```

流程：`get_showdata` 源作品 → 定位目标组件 → `deepcopy + reuuid` → append 到目标 `comps.items` → `validate` → `update`。

注意：

- 从样刊 deepcopy 的组件如果原本没有 `_comp["_$uuid"]`，必须手动补，否则校验报「缺少 _comp._$uuid」；
- 若版尾图 append 后盖住了往期回顾，用 `items.pop(i)` 再 `insert(j, ...)` 调整顺序，让往期回顾收尾；
- 每次改完都跑全量文本断言，特别是同时搬组件和改样式时。

---

## 5. 照片位与占位图

- 上传图片到秀米图库：`create_image_upload_ticket` 拿签名后 curl `-F file=@...`，**必须带 `Referer: https://xiumi.us/`**，否则被 Referer ACL 拒绝（403）。
- 区分真照片位和装饰图：按内容树里的图片尺寸/哈希归类。大横幅/正文图是真照片位；小尺寸 SVG（例如 104×62、128×85）多为装饰，不要替换。
- 小相框里放带字占位图会糊，用无文字极简占位图（虚线框 + 相机线条）即可。
- 占位 SVG 见 `examples/workbuddy/photo-placeholder-min.svg`。

---

## 6. 预览验证

`scripts/workbuddy/cdp-preview.mjs` 用 Edge/Chrome 的 DevTools Protocol 抓真实渲染：

```bash
# 先起一个带调试端口的浏览器
msedge --headless=new --remote-debugging-port=9333 --user-data-dir="$TEMP/xiumi-cdp"

node scripts/workbuddy/cdp-preview.mjs \
  --url "<预览链接>" --ready "<正文标志词>" --out ./preview
```

产出 `geometry.json`（图片/文本的尺寸与位置）、`full.png`、`screen-00.png` …。用它来确认：

- `\n` 是否真的变成多个 `<p>`；
- 小相框占位图是否糊；
- 版头/版尾是否回归、往期回顾是否真的在最底部；
- 标题断行是否匀称（对仗标题上下等大，别用主次字号破坏对称）。

---

## 7. 设计准则（踩过的坑）

- 对仗/并列式标题 = 上下等大 + 字距统一 + 居中对称；只有真·主副标题才用大小层次。
- 用户说「可以适当加入」某元素，意思是允许使用、不要刻意避开，不是把它提为主视觉。
- 忌「裸贴」元素：徽章/标识要有艺术地融入（手账拼贴、和纸胶带、手绘虚线框、微倾斜），颜色从原图取。
- 忌 AI 海报特效：径向渐变、光芒线、外框细线、照片底图压字；首图文字必须当主体（占画面 50%+）。
- 标题好不好看，先在本地渲染多方案对比图再选，别凭空猜。

---

## 8. 安全清单

- 不把 Cookie、`session.json`、预览链接里的 `stage_ticket` 写进仓库或示例；
- 示例里的账号 SID、作品 ID、unique_uid 一律用占位符；
- 提交前跑 `python scripts/workbuddy/secret_scan.py`，BLOCK 项必须清零；
- 仓库 `.gitignore` 已排除 `session.json` / `cookie.txt` / `out/`，不要 `git add -f` 它们。
