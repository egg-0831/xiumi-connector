# 配方

常用组合，直接抄。

---

## 1. 把红色节日模板改成品牌蓝紫（最常用）

```bash
# 找
node xiumi.mjs market 重阳 --sort copy --limit 15
node xiumi.mjs inspect 731733080          # 看主色，假设是 #c8201a / #f6d478

# 搬
node xiumi.mjs steal 731733080 --title "重阳活动"
# → 新 ID，例如 740000001

# 备份 + 看真实色板
node xiumi.mjs snap 740000001
node xiumi.mjs retheme 740000001 --show
```

把 `--show` 列出的高频色逐条映射（**只映射真的想换的，别全换**）：

```bash
node xiumi.mjs retheme 740000001 --map "#c8201a=#27408B,#bf1f20=#27408B,#f6d478=#F5C453" --dry
node xiumi.mjs retheme 740000001 --map "#c8201a=#27408B,#bf1f20=#27408B,#f6d478=#F5C453"
```

**注意**

- 相近色（`#c8201a` / `#bf1f20`）要一起换，否则会出现"红一块蓝一块"。
- 深浅关系别破坏：深色换深色、浅色换浅色，否则文字会看不清。
- 背景浅色（`#fff5e7` 这类米黄）如果要保留质感就别动，只换主色和点缀色。

常用配色（公众号安全、不吃设计）：

| 风格 | 主色 | 辅色 | 点缀 |
|---|---|---|---|
| 深蓝紫 | `#27408B` | `#6C4BA6` | `#F5C453` |
| 墨绿 | `#1F4A3D` | `#8FA98F` | `#D9B36B` |
| 朱红 | `#A62B1F` | `#E8C9A0` | `#E0B84C` |
| 石墨 | `#2E3440` | `#6E7A8A` | `#C8A96A` |

---

## 2. 一次性换掉所有配图

```bash
node xiumi.mjs images 740000001          # 看序号和原图
node xiumi.mjs reimg 740000001 --index "0=https://cdn.example.com/cover.jpg,3=https://cdn.example.com/p1.jpg"
```

按原图特征换（不知道序号时更方便）：

```bash
node xiumi.mjs reimg 740000001 --src "3f2a1b=new.jpg"   # URL 里含 3f2a1b 的都换掉
```

**图片必须是外链**（https），工具不做上传。

---

## 3. 批量套用同一套文案结构

三步：

1. 先 `outline` 看清文本块顺序；
2. 写一个 `patch.json`（建议先用 `expect: 1` 卡住，防止同一个词在别处被误改）；
3. `patch` 执行。

```json
[
  { "from": "活动时间：10月20日", "to": "活动时间：10月25日", "expect": 1 },
  { "from": "点击上方蓝字关注我们", "to": "点击蓝字 · 关注我们", "expect": 1 },
  { "from": "扫码报名", "to": "长按识别 · 立即报名" }
]
```

第三条没写 `expect` → 不限次数，适合多处出现的口号式文案。

---

## 4. 建一套自己的模板库存

```bash
# 从市场热门里挑 10 个，批量搬到自己账号当素材
node xiumi.mjs hot --metric collect --limit 10

# 只留档不搬（不占账号额度）
node xiumi.mjs grab 731733080 --md --lib
node xiumi.mjs grab 727712966 --md --lib
```

`--lib` 会把 HTML 存进 `library/`，之后可以：

```bash
node xiumi.mjs list                       # 看自己账号里的作品
```

`out/exports/` 里的 md 可以直接喂给 AI 改文案——比给整页 HTML 省 token。

---

## 5. 改坏了怎么退

```bash
node xiumi.mjs snap <ID> list             # 看有哪些快照
node xiumi.mjs snap <ID> restore 0        # 回到最新
node xiumi.mjs snap <ID> restore 1        # 再往前一步
```

`restore` 会先把当前状态另存一份，所以"回滚"本身也可以回滚。

如果压根没存过快照，但刚 `steal` 过来，重新 `steal` 一次就是干净的。

---

## 6. 给 AI 用：一次只喂它需要的

Agent 场景下不要一上来给整页 HTML。按需喂：

| 目的 | 给什么 |
|---|---|
| 判断模板合不合用 | `inspect` 的输出（几百字） |
| 改写文案 | `export --md` 的结果（去掉样式，1/10 token） |
| 换配色 | `retheme --show` 的色板 + 用户的品牌色 |
| 换图 | `images` 的清单（序号 + URL） |
| 调结构 | `outline` 的组件路径树 |

`grab` 出来的内容树 JSON 动辄几百 KB，除非要写代码处理，否则别塞进上下文。

---

## 7. 定时巡检市场（可选）

想盯着某个主题有没有新模板，用自动化任务跑：

```
node xiumi.mjs market 国庆 --sort new --limit 10
```

`--sort new` 按 `updated_at` 倒序，配合上次结果做 diff 就知道有没有新的。
（这条属于 `hot --metric new` 的手动版。）
