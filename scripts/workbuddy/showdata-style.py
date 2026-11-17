#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""showdata-style.py — 只改秀米内容树里 <p> 的 style，文字一字不动。

用法：
    python scripts/workbuddy/showdata-style.py \
        --in showdata.json --out showdata.styled.json \
        --rules examples/workbuddy/style-rules.example.json

规则文件结构见 examples/workbuddy/style-rules.example.json。
核心保证：改前/改后按剥标签后的纯文本逐字断言；任何文字变化都会 abort。

本文件同时提供两个内容树工具函数（组件搬迁时用）：
    clone_with_new_uuids(obj)  深拷贝组件并重新生成所有 _$uuid
    assert_texts_unchanged(before, after)  全量纯文本断言
"""

from __future__ import annotations

import argparse
import json
import re
import uuid
from copy import deepcopy
from pathlib import Path
from typing import Any

P_OPEN_RE = re.compile(r"<p([^>]*)>", re.I)
STYLE_RE = re.compile(r'\sstyle\s*=\s*"([^"]*)"', re.I)
TAG_RE = re.compile(r"<[^>]+>")


def plain(html: str) -> str:
    """剥掉所有标签，只留纯文本（用于逐字断言）。"""
    return TAG_RE.sub("", html or "")


def style_of_tag(tag: str) -> str:
    m = STYLE_RE.search(tag)
    return m.group(1) if m else ""


def set_tag_style(tag: str, style: str) -> str:
    """替换 <p ...> 开标签里的 style，其余属性保留。"""
    if STYLE_RE.search(tag):
        return STYLE_RE.sub(f' style="{style}"', tag, count=1)
    # tag 形如 '<p class="x">'；在 '>' 前插入
    return tag[:-1] + f' style="{style}">'


def build_style(spec: dict[str, Any]) -> str:
    """把规则里的样式字典拼成 CSS 字符串。"""
    parts: list[str] = []
    if "align" in spec:
        parts.append(f'text-align:{spec["align"]}')
    if "size" in spec:
        parts.append(f'font-size:{spec["size"]}')
    if spec.get("bold"):
        parts.append("font-weight:bold")
    elif spec.get("normal"):
        parts.append("font-weight:normal")
    if "color" in spec:
        parts.append(f'color:{spec["color"]}')
    if "ls" in spec:
        parts.append(f'letter-spacing:{spec["ls"]}')
    if "lh" in spec:
        parts.append(f'line-height:{spec["lh"]}')
    mb = spec.get("mb")
    if mb is not None:
        parts.append(f"margin:0 0 {mb}px" if mb else "margin:0")
    if "bg" in spec:
        parts.append(f'background-color:{spec["bg"]}')
    if "pad" in spec:
        parts.append(f'padding:{spec["pad"]}')
    if "extra" in spec:
        parts.append(str(spec["extra"]).rstrip(";"))
    return ";".join(parts) + ";" if parts else ""


def rule_for(text: str, rules: list[dict[str, Any]]) -> dict[str, Any] | None:
    for rule in rules:
        needles = rule.get("match_all") or ([rule["match"]] if rule.get("match") else [])
        if needles and all(n in text for n in needles):
            return rule
    return None


def apply_rules(html: str, rules: list[dict[str, Any]]) -> tuple[str, str | None]:
    """返回 (新 html, 命中的规则 id)；无命中则原样返回。"""
    text = plain(html)
    rule = rule_for(text, rules)
    if rule is None:
        return html, None

    styles = rule.get("styles") or []
    index_styles = rule.get("index_styles") or {}
    merge_base = bool(rule.get("merge_base", False))
    counter = [0]

    def repl(m: re.Match) -> str:
        i = counter[0]
        counter[0] += 1
        spec = index_styles.get(str(i))
        if spec is None and i < len(styles):
            spec = styles[i]
        if spec is None:
            return m.group(0)
        new_style = build_style(spec)
        if merge_base:
            old = style_of_tag(m.group(0))
            new_style = f"{new_style}{old}" if old else new_style
        return set_tag_style(m.group(0), new_style)

    return P_OPEN_RE.sub(repl, html), rule.get("id")


def walk_text_nodes(obj: Any) -> list[dict[str, Any]]:
    """收集所有含 <p 的 text 字段所在字典。"""
    out: list[dict[str, Any]] = []

    def rec(cur: Any) -> None:
        if isinstance(cur, dict):
            v = cur.get("text")
            if isinstance(v, str) and "<p" in v.lower():
                out.append(cur)
            for child in cur.values():
                rec(child)
        elif isinstance(cur, list):
            for child in cur:
                rec(child)

    rec(obj)
    return out


def assert_texts_unchanged(before: dict[int, str], after: dict[int, str]) -> None:
    if set(before) != set(after):
        raise AssertionError("文本节点集合发生变化")
    for key in before:
        if before[key] != after[key]:
            raise AssertionError(
                f"文字被改动！\nBEFORE: {before[key][:120]}\nAFTER : {after[key][:120]}"
            )


def clone_with_new_uuids(obj: Any) -> Any:
    """深拷贝组件并重新生成所有 _$uuid，避免跨作品 uuid 冲突。"""
    copied = deepcopy(obj)

    def rec(cur: Any) -> None:
        if isinstance(cur, dict):
            for key, val in list(cur.items()):
                if key == "_$uuid":
                    cur[key] = uuid.uuid4().hex
                else:
                    rec(val)
        elif isinstance(cur, list):
            for val in cur:
                rec(val)

    rec(copied)
    return copied


def main() -> None:
    ap = argparse.ArgumentParser(description="只改 showdata 的 <p> 样式，文字一字不动")
    ap.add_argument("--in", dest="src", required=True, help="输入 showdata JSON")
    ap.add_argument("--out", dest="dst", required=True, help="输出 showdata JSON")
    ap.add_argument("--rules", required=True, help="样式规则 JSON")
    args = ap.parse_args()

    data = json.loads(Path(args.src).read_text(encoding="utf-8"))
    rules = json.loads(Path(args.rules).read_text(encoding="utf-8"))
    if isinstance(rules, dict):
        rules = rules.get("rules", [])
    if not isinstance(rules, list):
        raise ValueError("规则文件必须是数组或含 rules 数组的对象")

    nodes = walk_text_nodes(data)
    before = {id(n): plain(n["text"]) for n in nodes}
    hits: dict[str, int] = {}
    for node in nodes:
        new_html, rule_id = apply_rules(node["text"], rules)
        node["text"] = new_html
        if rule_id:
            hits[rule_id] = hits.get(rule_id, 0) + 1

    after = {id(n): plain(n["text"]) for n in nodes}
    assert_texts_unchanged(before, after)

    Path(args.dst).write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"OK: {len(nodes)} 个文本节点，文字逐字未改")
    for rid, count in hits.items():
        print(f"  - {rid}: {count}")


if __name__ == "__main__":
    main()
