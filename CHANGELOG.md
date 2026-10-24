# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [3.0.0] - 2026-10-25

从「能读写作品」升级到「能把别人的模板变成自己的」。

### 新增 · 模板采集

- `market` / `xiumi_market_search`：市场搜索，支持关键词、分类、排序（使用量/收藏/浏览/最新），可多页聚合成跨页榜。
- `hot` / `xiumi_market_hot`：热门榜。
- `xiumi_market_categories`：分类清单，支持按分类名过滤（`--tag 节假`）。
- `inspect` / `xiumi_template_inspect`：**免登录**模板体检——结构规模、图片数、SVG、字数、主色板、字号分布、正文预览。
- `grab` / `xiumi_template_grab`：**免登录**抓取任意模板的已发布快照，产出内容树 JSON + 本地预览 HTML + 图片清单 + Markdown/纯文本。
- `steal` / `xiumi_steal`：把模板复制到自己账号（可编辑），支持复制后立即批量改文案、`--dry` 演练。
- `steal-batch` / `xiumi_steal_batch`：批量搬运，带限速与逐条结果。
- `target` 参数统一支持三种写法：作品 ID、公网预览链接、市场关键词。

### 新增 · 内容加工

- `retheme` / `xiumi_retheme`：一键换配色，递归改样式树并同步渲染缓存，支持 `--show` 看色板、`--dry` 演练。
- `images` / `xiumi_replace_images`：图片清单 + 按序号/URL 片段/批量换图。
- `export` / `xiumi_export`：导出 HTML / Markdown / 纯文本。
- `snap` / `xiumi_snapshot` / `xiumi_restore`：版本快照与回滚（回滚前自动再备份，可撤销）。

### 修复

- 公网快照里的协议相对地址（`//img.xiumi.us/…`）未补全，导致本地打开时图片全裂；现在统一补成 `https://`，粘进公众号也不会掉图。
- 市场分类树把内部根节点 `paper_root` 混进了分类路径。

### 变更

- MCP 工具数 22 → **34**。
- CLI 命令 13 → **24**；帮助信息按功能分组。
- 版本号 2.2 → 3.0。

---

## [2.2.0] - 2026-10-09

- 新增可视化状态窗口（`status.cmd` / `status-server.mjs` / `status.html`），本地 `127.0.0.1:47820`。
- 修复「打开秀米首页」按钮失效：旧白名单正则要求域名后必须跟 `/`，导致 `https://xiumi.us` 被拒，且匹配不到 `xiumius.cn`。改为 `new URL()` + 后缀精确匹配。
- 示例与文档去掉特定主题内容，改为通用。
- 清理测试快照与无用文件。

## [2.1.0] - 2026-10-06

- 新增「新建草稿 / 追加组件 / 批量替换 / 结构校验 / 发布快照」等写入能力。
- 修复 `--file` 登录参数丢失、`doctor` 中途退出、`whoami` 抛原始堆栈等问题。
- Windows 控制台编码修正（`chcp 65001`）。

## [2.0.0] - 2026-10-05

- 首个可用版本：会话管理、作品读取、内容树读写、模板市场、本地素材库。

[3.0.0]: https://github.com/egg-0831/xiumi-connector/compare/v2.2.0...v3.0.0
