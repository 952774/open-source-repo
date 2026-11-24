#!/usr/bin/env python3
"""
从各工具的 GitHub README 里提取真实界面截图，生成 src/data/shots.ts

为什么这么做：手写截图字段永远补不齐（289 个工具），而每个像样的开源项目
README 里都会放 1-N 张界面图。这里直接读 README 的原始 markdown，取前几张
图片，把相对路径解析成 raw.githubusercontent.com 的绝对地址。

用法：
    python scripts/fetch_shots.py            # 抓取并写入
    python scripts/fetch_shots.py --dry-run  # 只打印统计
"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS_TS = ROOT / "src" / "data" / "tools.ts"
OUT_TS = ROOT / "src" / "data" / "shots.ts"
TOKEN_FILE = ROOT / ".github-token"

API = "https://api.github.com"
MAX_SHOTS = 3

# README 里常见的非界面图，按关键词过滤掉
BAD_WORDS = (
    "badge",
    "shield",
    "shields.io",
    "travis",
    "appveyor",
    "codecov",
    "coverage",
    "license",
    "build-status",
    "actions/workflow",
    "star-history",
    "contributors",
    "awesome",
    "logo",
    "icon",
    "favicon",
    "banner",
    "sponsor",
    "donate",
    "paypal",
    "opencollective",
    "github-readme-stats",
    "wakatime",
    "visitor",
    "counter",
    "hits",
    # 社交/聊天平台自动生成的徽章与头像，不是界面图
    "discord.com/api",
    "discordapp.com/api",
    "discord.gg",
    "avatars.githubusercontent.com",
    "kiwiirc.com/buttons",
    "embed.png",
    "embed.svg",
    "opencollective.com",
    "liberapay",
    "buymeacoffee",
    "ko-fi",
    "patreon",
    "matrix.to",
    "gitter.im",
)


def read_token() -> str | None:
    if not TOKEN_FILE.exists():
        return None
    token = TOKEN_FILE.read_text(encoding="utf-8").strip()
    return token or None


def parse_repos() -> list[tuple[str, str, str]]:
    text = TOOLS_TS.read_text(encoding="utf-8")
    out: list[tuple[str, str, str]] = []
    current_id: str | None = None
    for line in text.splitlines():
        m_id = re.search(r"^\s*id:\s*'([^']+)'", line)
        if m_id:
            current_id = m_id.group(1)
        m_repo = re.search(r"repo:\s*'https://github\.com/([^/']+)/([^/']+)'", line)
        if m_repo and current_id:
            owner, repo = m_repo.group(1), m_repo.group(2)
            if repo.endswith(".git"):
                repo = repo[: -len(".git")]
            out.append((current_id, owner, repo))
            current_id = None
    return out


def get(url: str, token: str | None, raw: bool = False):
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "ToolArk-shots-fetcher")
    req.add_header("Accept", "application/vnd.github.raw" if raw else "application/vnd.github+json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            body = resp.read()
            return (body.decode("utf-8", "replace") if raw else json.loads(body.decode("utf-8"))), resp.status
    except urllib.error.HTTPError as e:
        return None, e.code
    except Exception:
        return None, 0


IMG_MD = re.compile(r"!\[[^\]]*\]\(\s*([^)\s]+)")
IMG_HTML = re.compile(r"<img[^>]+src=[\"']([^\"']+)[\"']", re.IGNORECASE)


def looks_bad(url: str) -> bool:
    low = url.lower()
    if any(w in low for w in BAD_WORDS):
        return True
    # 残缺 URL：README 里常有 markdown 转义残留（\(...\)），直接丢弃
    if any(ch in url for ch in "\\'\"<>`{}"):
        return True
    # 排除 SVG 徽章（README 里大量 SVG 都是徽章）
    if low.split("?")[0].endswith(".svg"):
        return True
    return False


def resolve(url: str, owner: str, repo: str, branch: str) -> str | None:
    """把 README 里的图片地址解析成可访问的绝对地址。"""
    url = url.strip()
    if url.startswith("//"):
        url = "https:" + url
    if url.startswith("http://"):
        url = "https://" + url[len("http://") :]
    if url.startswith("https://"):
        return url
    if url.startswith("data:"):
        return None
    # 相对路径
    url = url.lstrip("./")
    if not url:
        return None
    return f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{url}"


def pick_shots(markdown: str, owner: str, repo: str, branch: str) -> list[str]:
    candidates: list[str] = []
    for m in IMG_MD.finditer(markdown):
        candidates.append(m.group(1))
    for m in IMG_HTML.finditer(markdown):
        candidates.append(m.group(1))

    shots: list[str] = []
    for raw in candidates:
        if len(shots) >= MAX_SHOTS:
            break
        if looks_bad(raw):
            continue
        abs_url = resolve(raw, owner, repo, branch)
        if not abs_url:
            continue
        if abs_url in shots:
            continue
        shots.append(abs_url)
    return shots


def main() -> int:
    dry = "--dry-run" in sys.argv
    token = read_token()
    repos = parse_repos()
    print(f"共 {len(repos)} 个仓库，token={'有' if token else '无'}", flush=True)

    result: dict[str, list[str]] = {}
    failed: list[str] = []

    for i, (tool_id, owner, repo) in enumerate(repos, 1):
        meta, status = get(f"{API}/repos/{owner}/{repo}", token)
        if status != 200 or not isinstance(meta, dict):
            failed.append(f"{tool_id} ({owner}/{repo}) meta={status}")
            result[tool_id] = []
            continue
        branch = meta.get("default_branch") or "main"

        shots: list[str] = []
        # README 文件名各仓库不一，按可能性依次尝试
        for name in ("README.md", "readme.md", "README.MD", "Readme.md", "README.rst", "README"):
            text, st = get(
                f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{name}", token, raw=True
            )
            if st == 200 and isinstance(text, str):
                shots = pick_shots(text, owner, repo, branch)
                break
        if not shots:
            # 兜底：仓库社交预览图（GitHub 自动生成，至少是一张真实相关图）
            shots = [f"https://opengraph.githubassets.com/1/{owner}/{repo}"]

        result[tool_id] = shots
        if i % 25 == 0 or i == len(repos):
            have = sum(1 for v in result.values() if v)
            print(f"  进度 {i}/{len(repos)}  已有图 {have}", flush=True)
        time.sleep(0.05)

    with_shot = sum(1 for v in result.values() if v)
    print(f"\n完成：{with_shot}/{len(result)} 个工具有界面图", flush=True)
    if failed:
        print(f"仓库元信息失败 {len(failed)} 个：", flush=True)
        for f in failed[:10]:
            print("  -", f, flush=True)

    if dry:
        for tid, shots in list(result.items())[:10]:
            print(f"  {tid}: {shots[:1]}")
        return 0

    lines = [
        "/**",
        " * 各工具的界面预览图（自动生成，勿手改）。",
        " * 来源：优先取 README 里的真实界面截图；README 没图时退回仓库社交预览图。",
        " * 由 scripts/fetch_shots.py 生成。",
        " */",
        "",
        "export const SHOTS: Record<string, string[]> = {",
    ]
    for tool_id, _o, _r in repos:
        shots = result.get(tool_id) or []
        if not shots:
            continue
        safe = [s.replace("\\", "\\\\").replace("'", "\\'") for s in shots]
        joined = ", ".join(f"'{s}'" for s in safe)
        lines.append(f"  '{tool_id}': [{joined}],")
    lines.append("};")
    lines.append("")
    lines.append("export function shotsOf(toolId: string): string[] {")
    lines.append("  return SHOTS[toolId] ?? [];")
    lines.append("}")
    lines.append("")
    OUT_TS.write_text("\n".join(lines), encoding="utf-8")
    print(f"已写入 {OUT_TS.relative_to(ROOT)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
