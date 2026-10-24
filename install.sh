#!/usr/bin/env bash
# ============================================================
#  XIUMI Connector v3 · installer (macOS / Linux / Git Bash)
#
#  用法：
#    ./install.sh                 # 装到 ~/.workbuddy/skills/xiumi
#    ./install.sh /path/to/dir    # 自定义目录
#    ./install.sh --no-mcp        # 只拷文件，不改 MCP 配置
# ============================================================
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST=""
DO_MCP=1

for a in "$@"; do
  case "$a" in
    --no-mcp) DO_MCP=0 ;;
    -*) echo "未知参数：$a" >&2; exit 1 ;;
    *) DEST="$a" ;;
  esac
done
DEST="${DEST:-$HOME/.workbuddy/skills/xiumi}"

say() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }

say "1;36" ""
say "1;36" "  =========================================="
say "1;36" "    XIUMI Connector v3  -  Installer"
say "1;36" "  =========================================="

# ---- node ----
if ! command -v node >/dev/null 2>&1; then
  say "31" "  [X] 找不到 node，请先安装 Node.js 18+：https://nodejs.org"
  exit 1
fi
NODE_EXE="$(command -v node)"
say "2" "  [i] Node: $NODE_EXE ($("$NODE_EXE" -v))"

# ---- copy ----
if [ "$SRC" != "$DEST" ]; then
  say "1;36" ""
  say "1;36" "  [1/3] 拷贝到 $DEST"
  mkdir -p "$DEST"
  # 保留用户数据
  for keep in session.json; do
    [ -f "$DEST/$keep" ] && cp "$DEST/$keep" "/tmp/xiumi_$keep.bak" || true
  done
  for d in out library; do
    [ -d "$DEST/$d" ] && cp -R "$DEST/$d" "/tmp/xiumi_keep_$d" || true
  done

  # 只拷代码与文档，不覆盖会话/产物
  rsync -a --exclude='.git' --exclude='node_modules' --exclude='out' --exclude='library' \
        --exclude='session.json' "$SRC"/ "$DEST"/ 2>/dev/null || {
    ( cd "$SRC" && tar --exclude='.git' --exclude='node_modules' --exclude='out' \
        --exclude='library' --exclude='session.json' -cf - . ) | ( cd "$DEST" && tar -xf - )
  }

  [ -f "/tmp/xiumi_session.json.bak" ] && cp "/tmp/xiumi_session.json.bak" "$DEST/session.json" || true
  for d in out library; do
    [ -d "/tmp/xiumi_keep_$d" ] && cp -R "/tmp/xiumi_keep_$d/." "$DEST/$d/" 2>/dev/null || true
    rm -rf "/tmp/xiumi_keep_$d"
  done
  rm -f "/tmp/xiumi_session.json.bak"
  chmod +x "$DEST"/xiumi.mjs "$DEST"/server.mjs "$DEST"/register.mjs 2>/dev/null || true
else
  say "2" "  [i] 就地安装，跳过拷贝"
fi

# ---- register ----
if [ "$DO_MCP" = "1" ]; then
  say "1;36" ""
  say "1;36" "  [2/3] 注册 MCP（合并模式，不动其它服务器）"
  "$NODE_EXE" "$DEST/register.mjs" --dir "$DEST" --node "$NODE_EXE"
else
  say "2" "  [2/3] 跳过 MCP 注册（--no-mcp）"
fi

# ---- self check ----
say "1;36" ""
say "1;36" "  [3/3] 自检"
"$NODE_EXE" "$DEST/xiumi.mjs" doctor || true

say "1;32" ""
say "1;32" "  =========================================="
say "1;32" "    安装完成：$DEST"
say "1;32" "  =========================================="
cat <<EOF

  下一步
    1. WorkBuddy → 连接器 → 找到「xiumi」→ Trust
    2. 登录（最省事）：双击 / 执行 status.cmd，粘贴 Cookie 点登录
       或命令行：$NODE_EXE $DEST/xiumi.mjs login --file cookie.txt
    3. 拿 Cookie：登录 https://xiumi.us → F12 → Network → 刷新
       → 点任意 xiumi.us 请求 → Request Headers → 复制整串 Cookie

  试试
    $NODE_EXE $DEST/xiumi.mjs help
    $NODE_EXE $DEST/xiumi.mjs market --limit 10
    $NODE_EXE $DEST/xiumi.mjs inspect 733162400

EOF
