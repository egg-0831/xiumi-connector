#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""secret_scan.py — 提交前的轻量敏感信息检查。

只检查明文凭据与本机绝对路径，规则刻意保守：宁可多报，不可漏报。
退出码 0 = 无 BLOCK 项；1 = 发现必须处理的项。

用法：
    python scripts/workbuddy/secret_scan.py
    python scripts/workbuddy/secret_scan.py some/file.md
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

RULES: list[tuple[str, re.Pattern[str], str]] = [
    ("session_cookie", re.compile(r'\bsid\s*[=:]\s*["\']?(?![A-Z0-9_]{8,})[A-Za-z0-9%_\-\.]{16,}'), "BLOCK"),
    ("cookie_header", re.compile(r"(?i)\bcookie\s*:\s*[^$\s][^\s;]{12,};"), "BLOCK"),
    ("bearer_token", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9\-_\.]{20,}"), "BLOCK"),
    ("github_token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b"), "BLOCK"),
    ("password", re.compile(r'(?i)["\']?(?:password|passwd|pwd)["\']?\s*[:=]\s*["\'][^"\']{6,}["\']'), "BLOCK"),
    ("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "BLOCK"),
    ("cn_mobile", re.compile(r"\b1[3-9]\d{9}\b"), "BLOCK"),
    ("id_card", re.compile(r"\b\d{17}[\dXx]\b"), "BLOCK"),
    ("win_abs_path", re.compile(r"(?<![A-Za-z0-9])[A-Za-z]:[\\/](?:Users|Xiumi|DevEnv|ReverseLab)\b"), "WARN"),
    ("unix_home", re.compile(r"(?<![A-Za-z0-9_])/(?:Users|home)/(?!user/)[A-Za-z0-9._-]+/"), "WARN"),
    ("localhost_port", re.compile(r"127\.0\.0\.1:\d{4,5}"), "WARN"),
]

SKIP_DIRS = {".git", "node_modules", "out", "dist", "build", "__pycache__"}
SKIP_NAMES = {"session.json", "cookie.txt", "storage_state.json", "client-session.json"}
SKIP_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".zip", ".pdf", ".mp4"}


def collect(root: Path) -> list[Path]:
    if root.is_file():
        return [root]
    files: list[Path] = []
    for dirpath, dirnames, filenames in __import__("os").walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            if name in SKIP_NAMES or Path(name).suffix.lower() in SKIP_EXT:
                continue
            files.append(Path(dirpath) / name)
    return files


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="*", help="要扫描的文件或目录，默认当前目录")
    args = ap.parse_args()
    roots = [Path(p) for p in args.paths] or [Path(".")]

    block = 0
    warn = 0
    seen: set[Path] = set()
    for root in roots:
        for f in collect(root):
            rp = f.resolve()
            if rp in seen:
                continue
            seen.add(rp)
            try:
                text = f.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            for lineno, line in enumerate(text.splitlines(), 1):
                for name, pattern, level in RULES:
                    if pattern.search(line):
                        tag = "[BLOCK]" if level == "BLOCK" else "[WARN ]"
                        print(f"{tag} {name}: {f}:{lineno}")
                        if level == "BLOCK":
                            block += 1
                        else:
                            warn += 1

    print(f"\nBLOCK={block} WARN={warn}")
    return 1 if block else 0


if __name__ == "__main__":
    sys.exit(main())
